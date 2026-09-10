// Erdbeben - EMSC/SeismicPortal FDSN-Event-Webservice (European-Mediterranean Seismological
// Centre). Relevant fuer KatS-Vollstaendigkeit (Kavernen-/Bergbaugebiete, Grenzregionen) auch wenn
// Deutschland seismisch wenig aktiv ist.
//
// **VERIFIKATIONSSTAND:** Endpunkt/Parameter/JSON-Format sind ueber die oeffentliche
// EMSC-CSEM/webservices101-Dokumentation (GitHub) verifiziert. Ein echter Abruf aus dieser
// Entwicklungsumgebung liefert "HTTP 403 Forbidden" zurueck - `curl` gegen denselben Host wird von
// der Egress-Firewall dieser Umgebung sogar komplett verweigert (connect_rejected), das 403 kommt
// also mit hoher Wahrscheinlichkeit von der hiesigen Netz-Policy, nicht von seismicportal.eu selbst,
// laesst sich von hier aber nicht abschliessend unterscheiden. Wie bei kachelmann.js/bbkWarnungen.js
// daher NICHT LIVE VERIFIZIERT. Vor Produktivbetrieb `npm run fetch -- erdbeben` von einem Server
// mit normalem Internetzugang pruefen. Der Dienst ist FDSN-konform (derselbe Standard wie
// USGS earthquake.usgs.gov), format=json liefert laut Doku eine GeoJSON-FeatureCollection: je
// Feature properties.{mag, time, lastupdate, magtype, flynn_region, auth, depth} und
// geometry.coordinates=[lon, lat, depth_km] - defensiv mit Fallback-Feldnamen geparst, falls das
// tatsaechliche Schema in Details abweicht (kein Abbruch des gesamten Laufs bei einzelnen
// unerwarteten Feldern, nur bei komplett fehlendem features-Array).
//
// Kein API-Key noetig (oeffentlicher Dienst wie DWD/PEGELONLINE).

const { fetchJson } = require('./httpClient');
const { upsertDatapoints, expireStaleItems } = require('./normalize');
const { bboxForRadius } = require('../utils/geo');
const { query } = require('../db');
const config = require('../config');

const BASE_URL = 'https://www.seismicportal.eu/fdsnws/event/1/query';

function magnitudeToSeverity(mag) {
  if (mag === null || mag === undefined) return null;
  if (mag >= 6) return 'extrem';
  if (mag >= 4.5) return 'hoch';
  if (mag >= 3) return 'mittel';
  return 'gering';
}

async function fetchErdbeben() {
  const { rows: wehren } = await query(
    'SELECT id, center_lat, center_lon FROM wehr WHERE center_lat IS NOT NULL AND center_lon IS NOT NULL'
  );
  if (wehren.length === 0) {
    return { source: 'erdbeben', fetched: 0, written: 0, skipped: 'keine Wehr mit Kartenmittelpunkt konfiguriert' };
  }

  const start = new Date(Date.now() - config.erdbebenLookbackDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const itemsById = new Map();
  for (const wehr of wehren) {
    const bbox = bboxForRadius(wehr.center_lat, wehr.center_lon, config.erdbebenRadiusKm);
    const url =
      `${BASE_URL}?format=json&limit=200&start=${start}` +
      `&minmag=${encodeURIComponent(config.erdbebenMinMagnitude)}` +
      `&minlatitude=${bbox.latMin}&maxlatitude=${bbox.latMax}` +
      `&minlongitude=${bbox.lonMin}&maxlongitude=${bbox.lonMax}`;

    const data = await fetchJson(url);
    const features = Array.isArray(data?.features) ? data.features : Array.isArray(data) ? data : [];

    for (const feature of features) {
      const props = feature.properties || {};
      const coords = Array.isArray(feature.geometry?.coordinates) ? feature.geometry.coordinates : [];
      const lon = coords[0] ?? props.lon ?? null;
      const lat = coords[1] ?? props.lat ?? null;
      const depth = coords[2] ?? props.depth ?? null;
      const mag = typeof props.mag === 'number' ? props.mag : props.mag ? Number(props.mag) : null;
      const id = feature.id || props.unid || props.eventid;
      if (!id || lat === null || lon === null) continue;

      const time = props.time ? new Date(props.time) : null;

      itemsById.set(id, {
        source: 'erdbeben',
        external_id: String(id),
        title: props.flynn_region ? `Erdbeben ${props.flynn_region}` : 'Erdbeben',
        lat: Number(lat),
        lon: Number(lon),
        value_numeric: mag,
        unit: 'Magnitude',
        severity: magnitudeToSeverity(mag),
        item_timestamp: time && !Number.isNaN(time.getTime()) ? time.toISOString() : null,
        valid_until: null,
        payload: {
          magType: props.magtype ?? props.magType ?? null,
          depthKm: depth !== null && depth !== undefined ? Number(depth) : null,
          region: props.flynn_region ?? null,
          auth: props.auth ?? null,
        },
      });
    }
  }

  const items = [...itemsById.values()];
  const rows = await upsertDatapoints(items);
  // Rollierendes Zeitfenster (ERDBEBEN_LOOKBACK_DAYS): Ereignisse, die aus dem Fenster
  // herausgealtert sind, verschwinden aus der "aktuellen Lage" - dieselbe Logik wie bei firms
  // (siehe fetchers/nasaFirms.js), nicht loeschen, nur ausblenden (valid_until = now()).
  await expireStaleItems('erdbeben', items.map((i) => i.external_id));
  return { source: 'erdbeben', fetched: items.length, written: rows.length, rows };
}

module.exports = { fetchErdbeben };
