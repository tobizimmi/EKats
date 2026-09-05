// PEGELONLINE (WSV) - Wasserstaende der Bundeswasserstrassen. Kein API-Key noetig.
// Quellenangabe ist laut Anbieter Pflicht bei Nutzung -> siehe Frontend-Attribution.
//
// Endpunkt/Feldnamen identisch zum produktiven FKatInfo-Connector
// (includes/connectors/PegelOnlineConnector.php), live verifiziert am 2026-08-17 gegen:
// https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json?includeTimeseries=true&includeCurrentMeasurement=true
// Stationsobjekte tragen `latitude`/`longitude` direkt auf oberster Ebene, `water.longname` ist der
// Flussname, `timeseries[].shortname === 'W'` ist die Wasserstands-Zeitreihe mit verschachteltem
// `currentMeasurement.{timestamp,value,stateNswHsw,stateMnwMhw}` und `unit` auf der Zeitreihe.
//
// PEGELONLINE liefert selbst keine Meldestufen-Klassifizierung - `stateNswHsw`/`stateMnwMhw` sind
// grobe Einordnungen relativ zu langjaehrigen Mittelwerten, kein amtlicher Meldestufen-Code. Fuer
// eine echte Meldestufe muesste zusaetzlich die Hochwasserzentralen-API herangezogen werden.

const { fetchJson } = require('./httpClient');
const { upsertDatapoints } = require('./normalize');

const URL =
  'https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json?includeTimeseries=true&includeCurrentMeasurement=true';

async function fetchPegelonline() {
  const stations = await fetchJson(URL);
  if (!Array.isArray(stations)) {
    throw new Error('PEGELONLINE: unerwartetes Antwortformat.');
  }

  const items = [];
  for (const station of stations) {
    const waterSeries = (station.timeseries || []).find((ts) => ts.shortname === 'W' && ts.currentMeasurement);
    if (!waterSeries) continue;
    const cm = waterSeries.currentMeasurement || {};

    const riverName = station.water?.longname ?? null;
    const title = `${station.longname || station.shortname || 'Pegel'}${riverName ? ` (${riverName})` : ''}`;

    items.push({
      source: 'pegelonline',
      external_id: String(station.uuid),
      title,
      lat: typeof station.latitude === 'number' ? station.latitude : null,
      lon: typeof station.longitude === 'number' ? station.longitude : null,
      value_numeric: typeof cm.value === 'number' ? cm.value : null,
      unit: waterSeries.unit ?? null,
      severity: cm.stateNswHsw ?? cm.stateMnwMhw ?? null,
      item_timestamp: cm.timestamp ? new Date(cm.timestamp).toISOString() : null,
      valid_until: null,
      payload: {
        riverName,
        stationShortname: station.shortname ?? null,
        km: station.km ?? null,
        agency: station.agency ?? null,
      },
    });
  }

  const rows = await upsertDatapoints(items);
  return { source: 'pegelonline', fetched: items.length, written: rows.length, rows };
}

module.exports = { fetchPegelonline };
