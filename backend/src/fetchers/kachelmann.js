// Kachelmannwetter / Meteologix "Public API" (api.kachelmannwetter.com/v02). Optionale,
// kostenpflichtige Quelle - wird nur abgerufen, wenn (a) ein globaler API-Key konfiguriert ist
// (config.kachelmannApiKey, gleiches V1-Muster wie NASA_FIRMS_MAP_KEY: EIN Key fuer die gesamte
// Instanz, kein Multi-Tenant-Schluesselbund) UND (b) mindestens eine Wehr das Feature 'kachelmann'
// fuer mindestens eine Rolle/einen Nutzer freigeschaltet hat (siehe utils/featureAccess.js,
// Migration 009, Admin-Bereich) - so werden keine kostenpflichtigen Requests fuer eine Wehr
// verbraucht, in der niemand Zugriff hat.
//
// **VERIFIKATIONSSTAND (ehrlich, siehe README):** api.kachelmannwetter.com war aus dieser
// Entwicklungsumgebung nicht erreichbar (Egress-Firewall), aber der Nutzer hat die interaktive
// Swagger-Doku (api.kachelmannwetter.com/v02/_doc.html) als HTML-/PDF-Export bereitgestellt - daraus
// sind BASE_URL und das Auth-Schema (Header "X-API-Key") VERIFIZIERT. Diese "Public API" umfasst
// ausschliesslich Stationsdaten, aktuelles Wetter, Vorhersagen und Astronomie - KEINE Warnungen/kein
// Regenradar (in der kompletten Doku kommt weder "warning" noch "radar" vor). Ein separates Produkt
// des Nutzers ("Unwetteralarm Pro", pro.meteologix.com) koennte davon losgeloest eine eigene API
// haben - dazu liegt noch keine Doku vor, daher bleibt Regenradar/Warnungen weiterhin ueber den
// bestehenden DWD-WMS-Layer abgedeckt (siehe js/bundesland.js), nicht ueber Kachelmann.
//
// Der Endpunktpfad fuer "Current Weather" selbst (operationId get_current_weather) ist NICHT
// verifiziert - der Doku-Export des Nutzers deckte nur "Astronomical Information" und "Weather
// Symbol" im Detail ab (dort: lat/lon als Pfad-Parameter, z.B. GET .../tools/astronomy/{lat}/{lon}).
// Der Pfad unten (.../weather/current/{lat}/{lon}) ist davon abgeleitet, aber eine begruendete
// Annahme, KEINE verifizierte Tatsache. Jeder unerwartete Response-Shape wird als Fehler gemeldet
// (nicht stillschweigend falsch geparst); bei Fehlschlag bitte gegen einen echten Account
// gegenpruefen (z.B. `npm run fetch -- kachelmann` bzw. der curl-Befehl aus dem Fehlertext) und
// diese Datei entsprechend korrigieren.
const { fetchJson } = require('./httpClient');
const { upsertDatapoints } = require('./normalize');
const { query } = require('../db');
const config = require('../config');

const BASE_URL = 'https://api.kachelmannwetter.com/v02'; // Base-URL verifiziert, siehe Dateikopf

async function anyWehrHasKachelmannAccess() {
  const { rows } = await query(
    `SELECT 1 FROM wehr_feature_role_access WHERE feature_key = 'kachelmann'
     UNION
     SELECT 1 FROM user_feature_access WHERE feature_key = 'kachelmann' AND enabled = true
     LIMIT 1`
  );
  return rows.length > 0;
}

async function fetchKachelmannCurrentWeather() {
  if (!config.kachelmannApiKey) {
    return { source: 'kachelmann', fetched: 0, written: 0, skipped: 'kein KACHELMANN_API_KEY gesetzt' };
  }
  if (!(await anyWehrHasKachelmannAccess())) {
    return { source: 'kachelmann', fetched: 0, written: 0, skipped: 'kein Nutzer/keine Rolle hat Kachelmann-Zugriff freigeschaltet' };
  }

  const { rows: wehren } = await query(
    'SELECT id, center_lat, center_lon FROM wehr WHERE center_lat IS NOT NULL AND center_lon IS NOT NULL'
  );
  if (wehren.length === 0) {
    return { source: 'kachelmann', fetched: 0, written: 0, skipped: 'keine Wehr mit Kartenmittelpunkt konfiguriert' };
  }

  const items = [];
  for (const wehr of wehren) {
    const url = `${BASE_URL}/weather/current/${wehr.center_lat}/${wehr.center_lon}`;
    let data;
    try {
      data = await fetchJson(url, { headers: { 'X-API-Key': config.kachelmannApiKey } });
    } catch (err) {
      throw new Error(
        `Kachelmann-API-Request fehlgeschlagen (Endpunktpfad unverifiziert, siehe Dateikopf kachelmann.js) - ` +
          `zum Gegenpruefen: curl --header 'X-API-Key: <key>' --url '${url}' : ${err.message}`
      );
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(
        'Kachelmann-API: unerwartetes Antwortformat (kein Objekt) - Response-Schema muss gegen einen echten Account verifiziert werden.'
      );
    }

    items.push({
      source: 'kachelmann',
      external_id: `${wehr.id}:${data.time || Date.now()}`,
      title: data.condition ? `Aktuelles Wetter: ${data.condition}` : 'Aktuelles Wetter (Kachelmann)',
      lat: wehr.center_lat,
      lon: wehr.center_lon,
      value_numeric: data.temperature ?? null,
      unit: '°C',
      severity: data.condition ?? null,
      item_timestamp: data.time || new Date().toISOString(),
      valid_until: null,
      payload: {
        precipitation: data.precipitation ?? null,
        windSpeedKmh: data.windSpeed ?? null,
        windDirectionDeg: data.windDirection ?? null,
        windGustKmh: data.windGust ?? null,
        humidity: data.humidity ?? null,
        pressure: data.pressure ?? null,
        raw: data,
      },
    });
  }

  const rows = await upsertDatapoints(items);
  return { source: 'kachelmann', fetched: items.length, written: rows.length, rows };
}

module.exports = { fetchKachelmannCurrentWeather };
