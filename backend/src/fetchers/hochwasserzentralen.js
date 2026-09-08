// Hochwasserzentralen-API (Laenderuebergreifendes Hochwasserportal, LHP) - Hochwasser-Klassifizierung
// an Pegel-Stationen aller deutschen Bundeslaender. Deckt damit auch die von den Laendern selbst
// betriebenen "weiteren Pegel" ab, die ueber PEGELONLINEs Bundeswasserstrassen hinausgehen (siehe
// README "Datenquellen").
//
// ZWEITE KORREKTUR: Die erste Korrektur dieses Connectors (basierend auf der inoffiziellen Community-
// OpenAPI-Spec bundesAPI/hochwasserzentralen-api, Endpunkte unter www.hochwasserzentralen.de/webservices/
// *.php) war ebenfalls falsch - dieses HTTP 200 mit Content-Length 0 quittiert live (per curl auf dem
// Produktivserver geprueft), die Endpunkte existieren nicht mehr. Grund: der Anbieter ist auf eine neue
// REST-API unter einer ANDEREN Subdomain umgestiegen. Diese Version basiert auf der tatsaechlichen,
// vom Anbieter selbst veroeffentlichten OpenAPI-3.0-Spec ("LHP-PublicAPI", Version 1.0_beta_2025_01-23),
// die der Nutzer direkt von https://www.hochwasserzentralen.de/developers/api-docs heruntergeladen und
// bereitgestellt hat - damit steht dieser Connector jetzt auf der bestmoeglichen verfuegbaren Basis
// (offizielle Erstanbieter-Doku statt Reverse-Engineering), ist aber WEITERHIN NICHT LIVE GETESTET
// (die Domain ist aus dieser Entwicklungsumgebung nicht erreichbar) - nach dem Deploy unbedingt einmal
// `npm run fetch -- hochwasserzentralen` pruefen (siehe README "Verifikationsstand der Fetcher").
//
// Endpunkt: GET https://api.hochwasserzentralen.de/public/v1/data/stations
// Liefert IN EINEM Aufruf alle Pegel-Stationen bundesweit als GeoJSON-FeatureCollection (kein
// Umkreis-Parameter noetig wie bei den fruehen Entwuerfen mit Einzelabrufen je Station). Je Feature:
//   properties.name, properties.water (Gewaessername), properties.timestamp
//   ("JJJJ-MM-TT HH:MM:SS", keine Zeitzone im Beispiel - als Europe/Berlin angenommen, siehe
//   parseLhpTimestamp), properties.lhpClass (Zahl -1 bis 4, siehe LHP_CLASS_TO_SEVERITY),
//   properties.stateClassName (Klartext), properties.stateId ("DE-XX", ISO-3166-2),
//   geometry.coordinates [lon, lat].
// WICHTIG laut Spec-Beschreibung des Endpunkts: "No measured data like water levels or discharge is
// provided" - es gibt KEINEN numerischen Wasserstand-Messwert, nur die Hochwasser-Klassifizierung.
// value_numeric/unit bleiben deshalb bewusst leer statt etwas zu erfinden (anders als beim ersten,
// falschen Korrekturversuch, der faelschlich einen "12 cm"-Text erwartet hatte, den es hier nicht gibt).
//
// Die Spec verlangt in "security" ein BasicAuth-Schema, definiert aber kein tatsaechliches
// Auth-Schema (securitySchemes: {} ist leer) und nennt sich selbst "LHP-PublicAPI" mit offener
// CC-BY-4.0-Lizenz - vermutlich ein Doku-Artefakt der Beta-Version, kein echtes Login noetig. Falls
// der Live-Abruf mit 401 scheitert, waeren hier Zugangsdaten zu ergaenzen.
//
// Nach dem Abruf wird wie bei den anderen Connectors auf Stationen im Umkreis
// (config.hochwasserzentralenRadiusKm) um mindestens eine Wehr eingegrenzt (analog zu nasaFirms.js),
// um nicht alle ~1200 bundesweiten Stationen zu importieren.

const { fetchJson } = require('./httpClient');
const { upsertDatapoints } = require('./normalize');
const { haversineKm } = require('../utils/geo');
const { query } = require('../db');
const config = require('../config');

const STATIONS_URL = 'https://api.hochwasserzentralen.de/public/v1/data/stations';

// Aus der offiziellen Spec ("legend" der stations-json-Antwort).
const LHP_CLASS_TO_SEVERITY = {
  '-1': null, // "Derzeit keine Daten"
  0: 'kein_hochwasser',
  1: 'meldestufe_1',
  2: 'meldestufe_2',
  3: 'meldestufe_3',
  4: 'meldestufe_4_plus',
};

// Beispielwert aus der Spec: "2024-07-16 15:45:00" - vollstaendiges Datum, aber ohne Zeitzone. Als
// Europe/Berlin-Lokalzeit angenommen (der Anbieter ist ein deutsches Laenderportal); diese Annahme
// ist deutlich sicherer als beim vorherigen Versuch mit dem unvollstaendigen "Heute, HH:MM Uhr"-Text,
// da hier zumindest ein vollstaendiges Kalenderdatum vorliegt.
function parseLhpTimestamp(text) {
  if (!text) return null;
  const match = String(text).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}+01:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function fetchHochwasserzentralen() {
  const { rows: wehren } = await query(
    'SELECT id, center_lat, center_lon FROM wehr WHERE center_lat IS NOT NULL AND center_lon IS NOT NULL'
  );
  if (wehren.length === 0) {
    return { source: 'hochwasserzentralen', fetched: 0, written: 0, skipped: 'keine Wehr mit Kartenmittelpunkt konfiguriert' };
  }

  let geojson;
  try {
    geojson = await fetchJson(STATIONS_URL);
  } catch (err) {
    console.warn(
      '[hochwasserzentralen] GET data/stations fehlgeschlagen - Endpunkt ist gegen die offizielle ' +
        'OpenAPI-Spec des Anbieters implementiert, aber nicht live getestet, siehe Kommentar am ' +
        'Dateianfang. Original-Fehler:',
      err.message
    );
    return { source: 'hochwasserzentralen', fetched: 0, written: 0, skipped: 'Abruf fehlgeschlagen (data/stations)' };
  }

  const features = Array.isArray(geojson?.features) ? geojson.features : null;
  if (!features) {
    console.warn('[hochwasserzentralen] Unerwartetes Antwortformat von data/stations - ueberspringe diesen Lauf.');
    return { source: 'hochwasserzentralen', fetched: 0, written: 0, skipped: 'unerwartetes Antwortformat (data/stations)' };
  }

  const items = [];
  for (const feature of features) {
    if (!feature?.id) continue;
    const coords = feature.geometry?.coordinates;
    const lon = Array.isArray(coords) ? Number(coords[0]) : NaN;
    const lat = Array.isArray(coords) ? Number(coords[1]) : NaN;
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;

    const isNearAnyWehr = wehren.some(
      (wehr) => haversineKm(wehr.center_lat, wehr.center_lon, lat, lon) <= config.hochwasserzentralenRadiusKm
    );
    if (!isNearAnyWehr) continue;

    const props = feature.properties || {};
    const classKey = props.lhpClass !== undefined && props.lhpClass !== null ? String(props.lhpClass) : null;

    items.push({
      source: 'hochwasserzentralen',
      external_id: String(feature.id),
      title: [props.name, props.water].filter(Boolean).join(' / ') || `Pegel ${feature.id}`,
      lat,
      lon,
      value_numeric: null,
      unit: null,
      severity: classKey !== null ? LHP_CLASS_TO_SEVERITY[classKey] ?? null : null,
      item_timestamp: parseLhpTimestamp(props.timestamp),
      valid_until: null,
      payload: {
        gewaesser: props.water ?? null,
        land: props.stateId ?? null,
        lhpClass: props.lhpClass ?? null,
        statusText: props.stateClassName ?? null,
        stationLink: props.stationLink ?? null,
      },
    });
  }

  const rows = await upsertDatapoints(items);
  return { source: 'hochwasserzentralen', fetched: items.length, written: rows.length, rows };
}

module.exports = { fetchHochwasserzentralen };
