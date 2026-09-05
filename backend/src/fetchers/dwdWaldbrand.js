// DWD Waldbrandgefahrenindex (WBI) - gzip-CSV je Station. Kein API-Key noetig.
//
// Endpunkt/Format identisch zum produktiven FKatInfo-Connector
// (includes/connectors/DwdWaldbrandConnector.php), live geprueft am 2026-08-17:
// Verzeichnis: https://opendata.dwd.de/climate_environment/CDC/derived_germany/fire_danger_index/woodland/recomputed/recent/
//   enthaelt Dateien wie "derived_germany_fire_danger_index_woodland_recomputed_recent_1001_v2-3--0.csv.gz"
// CSV-Inhalt je Station (Semikolon-getrennt): "Stationsindex;Datum;WBI", letzte Zeile = aktuellster Wert.
//
// Der Feed liefert selbst weder Koordinaten noch Bundesland - dafuer wird `dwd_station` (befuellt via
// dwdStationsImport.js) per Lookup genutzt. Ist eine Station dort (noch) nicht vorhanden, wird das
// Item trotzdem angelegt, nur ohne lat/lon (kein Kartenmarker, aber in der Liste sichtbar).

const zlib = require('zlib');
const { fetchText, fetchBuffer } = require('./httpClient');
const { upsertDatapoints } = require('./normalize');
const { query } = require('../db');

const DIR_URL =
  'https://opendata.dwd.de/climate_environment/CDC/derived_germany/fire_danger_index/woodland/recomputed/recent/';

const FILE_REGEX =
  /href="(derived_germany_fire_danger_index_woodland_recomputed_recent_(\d+)_v[\d.-]+\.csv\.gz)"/gi;

function wbiToSeverity(wbi) {
  if (wbi === null) return null;
  if (wbi <= 1) return 'sehr_gering';
  if (wbi === 2) return 'gering';
  if (wbi === 3) return 'mittel';
  if (wbi === 4) return 'hoch';
  return 'sehr_hoch';
}

async function loadStationLookup() {
  try {
    const { rows } = await query('SELECT station_id, station_name, lat, lon, bundesland_code FROM dwd_station');
    const lookup = new Map();
    for (const row of rows) {
      const key = row.station_id.replace(/^0+/, '') || '0';
      lookup.set(key, row);
    }
    return lookup;
  } catch (err) {
    console.warn('[dwd_waldbrand] dwd_station-Lookup nicht verfuegbar:', err.message);
    return new Map();
  }
}

async function fetchDwdWaldbrand() {
  const html = await fetchText(DIR_URL);
  const matches = [...html.matchAll(FILE_REGEX)];
  if (matches.length === 0) {
    throw new Error('DWD Waldbrandindex: keine Stationsdateien im Verzeichnis-Listing gefunden.');
  }

  const stationLookup = await loadStationLookup();
  const items = [];

  for (const match of matches) {
    const [, filename, stationId] = match;
    try {
      const gz = await fetchBuffer(DIR_URL + filename);
      const csv = zlib.gunzipSync(gz).toString('utf8');
      const lines = csv
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '');
      if (lines.length < 2) continue;

      const lastLine = lines[lines.length - 1];
      const fields = lastLine.split(';');
      if (fields.length < 3) continue;

      const [idField, datum, wbiRaw] = fields.map((f) => f.trim());
      if (!idField || !datum) continue;

      const wbi = Number.isNaN(Number(wbiRaw)) ? null : Math.round(Number(wbiRaw));
      const meta = stationLookup.get(idField.replace(/^0+/, '') || '0');

      let timestamp = null;
      const dateMatch = datum.match(/^(\d{4})(\d{2})(\d{2})$/);
      if (dateMatch) {
        timestamp = new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T00:00:00Z`).toISOString();
      }

      items.push({
        source: 'waldbrandindex',
        external_id: `${idField}_${datum}`,
        title: `Waldbrandgefahrenindex ${meta?.station_name ?? `Station ${idField}`}`,
        lat: meta?.lat ?? null,
        lon: meta?.lon ?? null,
        value_numeric: wbi,
        unit: 'WBI',
        severity: wbiToSeverity(wbi),
        item_timestamp: timestamp,
        valid_until: null,
        payload: {
          stationId: idField,
          bundeslandCode: meta?.bundesland_code ?? null,
          stationName: meta?.station_name ?? null,
        },
      });
    } catch (err) {
      console.warn(`[dwd_waldbrand] Station ${stationId} uebersprungen:`, err.message);
    }
  }

  const rows = await upsertDatapoints(items);
  return { source: 'waldbrandindex', fetched: items.length, written: rows.length, rows };
}

module.exports = { fetchDwdWaldbrand };
