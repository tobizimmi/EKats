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
// BUGFIX 1 (Nutzer-Report "Kachelmann funktioniert immer noch nicht"): der urspruenglich geratene
// Endpunktpfad ".../weather/current/{lat}/{lon}" war falsch (kein "weather/"-Segment) - lieferte auf
// dem echten Server vermutlich ein HTTP 404. Korrigiert anhand des Quellcodes von
// github.com/maxboettinger/kachelmann-api (aktiv genutzter, quelloffener inoffizieller
// TypeScript-Wrapper um dieselbe API): dort steht der Endpunkt woertlich als
// "https://api.kachelmannwetter.com/v02/current/" + lat + "/" + lon + "?units=" + units, mit den
// Headern "X-API-Key" (Auth) und "Accept: application/json". Endpunktpfad, Query-Parameter "units"
// und Header-Namen gelten damit als verifiziert (echter, benutzter Fremdcode statt Vermutung).
//
// BUGFIX 2 (nach Bugfix 1 weiterhin fehlgeschlagen, HTTP 403 statt 404): vom Nutzer per echtem curl
// gegen den echten Account reproduziert - {"status":403,"detail":"you are not allowed to request
// forecasts for [lat: 48.6226, lon: 10.0196]"}. Zunaechst als dauerhafte Plan-/Geo-Einschraenkung
// eingestuft - falsch: derselbe curl-Aufruf mit denselben Koordinaten/demselben Key hat direkt danach
// mit HTTP 200 und echten Daten geantwortet. Der 403 ist also TRANSIENT (vermutlich eine kurzzeitige
// serverseitige Drossel/ein Cache-Warmup bei erstmaliger Anfrage fuer eine noch nicht abgerechnete
// Koordinate, keine dauerhafte Sperre) - daher unten ein einmaliger Retry mit kurzer Wartezeit
// speziell fuer HTTP 403, statt den ganzen Lauf sofort als Fehler zu melden.
//
// BUGFIX 3 (echter, bisher unentdeckter Parsing-Fehler): die erste erfolgreiche 200-Antwort hat die
// bis hierhin komplett unverifizierte Feldannahme widerlegt. Tatsaechliche Struktur (verifiziert am
// echten Account, Koordinaten 48.6226/10.0196):
//   { "lat":..,"lon":..,"alt":..,"systemOfUnits":"metric",
//     "data": { "temp": {"value":11.6,"dateTime":"...","type":"float",...},
//               "weatherSymbol": {"value":"partlycloudy",...}, "windSpeed": {"value":0.6,...},
//               "windDirection": {...}, "windGust": {...}, "humidityRelative": {...},
//               "pressureMsl": {...}, "prec1h": {...}, "dewpoint": {...}, "cloudCoverage": {...},
//               "isDay": {...}, "sunHours": {...}, "snowAmount": {...}, "snowHeight": {...},
//               "wmoCode": {...} } }
// Jedes Feld ist ein VERSCHACHTELTES Objekt ({value, dateTime, type, name, source}) unter "data",
// nicht wie urspruenglich angenommen ein flacher Wert auf oberster Ebene (kein "data.temperature",
// kein "data.condition", kein "data.time"). Die bisherige Implementierung haette daher auch bei
// einer erfolgreichen 200-Antwort durchgehend nur `null`/undefined-Werte geschrieben (der explizite
// "kein Objekt"-Fehlerfall traf nie zu, da `data` ja ein Objekt ist - der Fehler war rein inhaltlich,
// nicht strukturell, und waere ohne einen echten 200er nie aufgefallen). Unten entsprechend auf
// `data.data.<feld>.value` umgestellt. Windgeschwindigkeit/-boen: Einheit trotz "systemOfUnits":
// "metric" nicht explizit dokumentiert (Wert 0.6 bei "kaum Wind" passt eher zu m/s als zu km/h,
// professionelle Meteorologie-APIs nutzen ueblicherweise m/s) - als `windSpeedMs`/`windGustMs`
// benannt statt der bisherigen (falschen) "Kmh"-Annahme; bei Bedarf spaeter gegen eine Referenzmessung
// gegenpruefen.
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ein einmaliger, kurzer Retry NUR bei HTTP 403 - siehe BUGFIX 2 im Dateikopf (beobachtet transient,
// derselbe Request hat direkt danach funktioniert). Andere Fehler (Netzwerk, 4xx/5xx sonst) werden
// weiterhin sofort durchgereicht, um echte Dauerfehler nicht zu verschleiern.
async function fetchCurrentWeatherWithRetry(url, headers) {
  try {
    return await fetchJson(url, { headers });
  } catch (err) {
    if (!err.message.includes('HTTP 403')) {
      throw err;
    }
    await wait(2000);
    return await fetchJson(url, { headers });
  }
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
    const url = `${BASE_URL}/current/${wehr.center_lat}/${wehr.center_lon}?units=metric`;
    let response;
    try {
      response = await fetchCurrentWeatherWithRetry(url, {
        'X-API-Key': config.kachelmannApiKey,
        Accept: 'application/json',
      });
    } catch (err) {
      throw new Error(
        `Kachelmann-API-Request fehlgeschlagen (auch nach Retry bei HTTP 403, siehe Dateikopf kachelmann.js) - ` +
          `zum Gegenpruefen: curl --header 'X-API-Key: <key>' --header 'Accept: application/json' --url '${url}' : ${err.message}`
      );
    }
    const data = response?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(
        'Kachelmann-API: unerwartetes Antwortformat (kein "data"-Objekt in der Antwort) - Response-Schema hat sich vermutlich geaendert, siehe Dateikopf kachelmann.js.'
      );
    }

    const temp = data.temp?.value ?? null;
    const condition = data.weatherSymbol?.value ?? null;
    const itemTimestamp = data.temp?.dateTime || new Date().toISOString();

    items.push({
      source: 'kachelmann',
      external_id: `${wehr.id}:${itemTimestamp}`,
      title: condition ? `Aktuelles Wetter: ${condition}` : 'Aktuelles Wetter (Kachelmann)',
      lat: wehr.center_lat,
      lon: wehr.center_lon,
      value_numeric: temp,
      unit: '°C',
      severity: condition,
      item_timestamp: itemTimestamp,
      valid_until: null,
      payload: {
        precipitationMm: data.prec1h?.value ?? null,
        windSpeedMs: data.windSpeed?.value ?? null,
        windDirectionDeg: data.windDirection?.value ?? null,
        windGustMs: data.windGust?.value ?? null,
        humidityPercent: data.humidityRelative?.value ?? null,
        pressureMslHpa: data.pressureMsl?.value ?? null,
        cloudCoveragePercent: data.cloudCoverage?.value ?? null,
        raw: response,
      },
    });
  }

  const rows = await upsertDatapoints(items);
  return { source: 'kachelmann', fetched: items.length, written: rows.length, rows };
}

module.exports = { fetchKachelmannCurrentWeather };
