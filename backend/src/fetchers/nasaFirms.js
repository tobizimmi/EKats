// NASA FIRMS - satellitengestuetzte Branderkennung (VIIRS). Benoetigt einen kostenlosen MAP_KEY
// (Registrierung: https://firms.modaps.eosdis.nasa.gov/api/map_key/). V1-Vereinfachung: EIN
// globaler MAP_KEY (config.nasaFirmsMapKey), nicht pro Nutzer wie im aelteren FKatInfo-Prototyp -
// V1 hat genau eine Wehr mit einem Zustaendigkeitsgebiet, ein Nutzer-Key pro Nutzer waere hier
// unnoetige Komplexitaet.
//
// CSV-Format identisch zum produktiven FKatInfo-Connector (includes/connectors/NasaFirmsConnector.php):
// latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight
// (VIIRS) bzw. brightness/bright_t31 statt bright_ti4/bright_ti5 bei der aelteren MODIS-Variante.
// Rate-Limit: 5000 Transaktionen/10 Minuten pro Key - fuer V1 mit stuendlichem/45-min-Abruf unkritisch.

const { fetchText } = require('./httpClient');
const { upsertDatapoints, expireStaleItems } = require('./normalize');
const { bboxForRadius } = require('../utils/geo');
const { query } = require('../db');
const config = require('../config');

const SENSOR = 'VIIRS_SNPP_NRT';
const URL_TEMPLATE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/%s/%s/%s,%s,%s,%s/1';

function parseCsv(text) {
  const lines = text
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const values = line.split(',');
    const row = {};
    header.forEach((key, i) => {
      row[key] = values[i];
    });
    return row;
  });
}

function confidenceToSeverity(confidence) {
  if (confidence === undefined || confidence === null || confidence === '') return null;
  if (!Number.isNaN(Number(confidence))) {
    const c = Number(confidence);
    if (c >= 80) return 'hoch';
    if (c >= 50) return 'mittel';
    return 'niedrig';
  }
  const map = { h: 'hoch', high: 'hoch', n: 'mittel', nominal: 'mittel', l: 'niedrig', low: 'niedrig' };
  return map[String(confidence).toLowerCase()] ?? String(confidence);
}

async function fetchNasaFirms() {
  if (!config.nasaFirmsMapKey) {
    return { source: 'firms', fetched: 0, written: 0, skipped: 'kein NASA_FIRMS_MAP_KEY gesetzt' };
  }

  const { rows: wehren } = await query(
    'SELECT id, center_lat, center_lon FROM wehr WHERE center_lat IS NOT NULL AND center_lon IS NOT NULL'
  );
  if (wehren.length === 0) {
    return { source: 'firms', fetched: 0, written: 0, skipped: 'keine Wehr mit Kartenmittelpunkt konfiguriert' };
  }

  const items = [];
  for (const wehr of wehren) {
    const bbox = bboxForRadius(wehr.center_lat, wehr.center_lon, config.firmsRadiusKm);
    const url = URL_TEMPLATE.replace('%s', encodeURIComponent(config.nasaFirmsMapKey))
      .replace('%s', SENSOR)
      .replace('%s', bbox.lonMin)
      .replace('%s', bbox.latMin)
      .replace('%s', bbox.lonMax)
      .replace('%s', bbox.latMax);

    const csv = await fetchText(url);
    const trimmed = csv.trim();
    if (trimmed === '' || /^invalid|^error/i.test(trimmed)) {
      throw new Error(`NASA FIRMS: API-Fehler oder ungueltiger Key: ${trimmed.slice(0, 200)}`);
    }

    for (const row of parseCsv(trimmed)) {
      const lat = row.latitude ? Number(row.latitude) : null;
      const lon = row.longitude ? Number(row.longitude) : null;
      const acqDate = row.acq_date || '';
      const acqTime = String(row.acq_time || '0000').padStart(4, '0');
      const satellite = row.satellite || 'unbekannt';
      const frp = row.frp ? Number(row.frp) : null;

      let timestamp = null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(acqDate)) {
        timestamp = new Date(
          `${acqDate}T${acqTime.slice(0, 2)}:${acqTime.slice(2, 4)}:00Z`
        ).toISOString();
      }

      items.push({
        source: 'firms',
        // Natural Key ohne Nutzerbezug: ueberlappende Gebiete konvergieren auf dieselbe Zeile.
        external_id: `${lat ?? 'na'}_${lon ?? 'na'}_${acqDate}_${acqTime}_${satellite}`,
        title: `Feuer erkannt (${satellite})`,
        lat,
        lon,
        value_numeric: frp,
        unit: frp !== null ? 'MW (FRP)' : null,
        severity: confidenceToSeverity(row.confidence),
        item_timestamp: timestamp,
        valid_until: null,
        payload: { satellite, confidence: row.confidence ?? null, daynight: row.daynight ?? null },
      });
    }
  }

  const rows = await upsertDatapoints(items);
  await expireStaleItems('firms', items.map((i) => i.external_id));
  return { source: 'firms', fetched: items.length, written: rows.length, rows };
}

module.exports = { fetchNasaFirms };
