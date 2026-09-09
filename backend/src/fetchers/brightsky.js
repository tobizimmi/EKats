// Wetter-Vorhersage (Konzept Teil 2, Baustein D): echte Wetterdaten statt nur Warnungen - Antwort
// auf die Nutzerfrage "Gibt es eine kostenlose API fuer das Wetter?". Bright Sky (brightsky.dev)
// bereitet DWD-Stationsmessungen und MOSMIX-Vorhersagen als kostenlose, unauthentifizierte JSON-API
// auf - passt damit zur bisherigen EKats-Linie "amtliche, kostenlose Quellen bevorzugen" besser als
// die Alternative Open-Meteo (nur fuer nicht-kommerzielle Nutzung lizenziert). Anders als Kachelmann
// braucht diese Quelle deshalb KEINEN API-Key und KEINE Feature-Zugriffssteuerung - sie verhaelt
// sich wie die uebrigen sechs kostenlosen Quellen (immer aktiv, siehe README "Datenquellen").
//
// **VERIFIKATIONSSTAND (ehrlich, siehe README):** brightsky.dev/api.brightsky.dev war aus dieser
// Entwicklungsumgebung nicht erreichbar (Egress-Firewall) - weder die interaktive Dokumentation noch
// ein Test-Request waren moeglich. Oeffentlich recherchierbar war nur die grobe Projektbeschreibung
// (github.com/jdemaeyer/brightsky): kostenlos ohne Key, liefert "weather observations from the DWD
// station network and weather forecasts from the MOSMIX model" ueber einen /weather-Endpunkt mit
// lat/lon/date-Parametern, stuendliche Datensaetze. Der genaue Response-Aufbau unten (Feldnamen wie
// "temperature", "precipitation", "wind_speed", "condition") ist aus der oeffentlich dokumentierten,
// stabilen Bright-Sky-API-Konvention abgeleitet, aber NICHT live gegen eine echte Antwort geprueft -
// begruendete Annahme, keine verifizierte Tatsache (gleiches Vorgehen wie bei kachelmann.js). Jeder
// unerwartete Response-Shape wird als Fehler gemeldet statt stillschweigend falsch geparst; vor
// Produktivbetrieb bitte einmal `npm run fetch -- wetter_vorhersage` gegen die echte API pruefen.
const { fetchJson } = require('./httpClient');
const { upsertDatapoints } = require('./normalize');
const { query } = require('../db');

const BASE_URL = 'https://api.brightsky.dev'; // UNVERIFIZIERT, siehe Dateikopf

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

async function fetchBrightskyForecast() {
  const { rows: wehren } = await query(
    'SELECT id, center_lat, center_lon FROM wehr WHERE center_lat IS NOT NULL AND center_lon IS NOT NULL'
  );
  if (wehren.length === 0) {
    return { source: 'wetter_vorhersage', fetched: 0, written: 0, skipped: 'keine Wehr mit Kartenmittelpunkt konfiguriert' };
  }

  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

  const items = [];
  for (const wehr of wehren) {
    for (const date of [today, tomorrow]) {
      const url = `${BASE_URL}/weather?lat=${wehr.center_lat}&lon=${wehr.center_lon}&date=${isoDate(date)}`;
      let data;
      try {
        data = await fetchJson(url);
      } catch (err) {
        throw new Error(
          `Bright-Sky-API-Request fehlgeschlagen (Response-Format unverifiziert, siehe Dateikopf brightsky.js): ${err.message}`
        );
      }

      const hours = Array.isArray(data?.weather) ? data.weather : null;
      if (hours === null) {
        throw new Error(
          'Bright-Sky-API: unerwartetes Antwortformat (kein "weather"-Array) - Response-Schema muss gegen die echte API verifiziert werden.'
        );
      }

      for (const h of hours) {
        if (!h || !h.timestamp) continue;
        // Nur Stunden ab jetzt uebernehmen - vergangene Stunden desselben Tages sind fuer eine
        // Vorhersage nicht relevant (Bright Sky liefert sie fuer "heute" trotzdem mit).
        if (new Date(h.timestamp).getTime() < Date.now() - 60 * 60 * 1000) continue;

        items.push({
          source: 'wetter_vorhersage',
          external_id: `${wehr.id}:${h.timestamp}`,
          title: h.condition ? `Wetter-Vorhersage: ${h.condition}` : 'Wetter-Vorhersage',
          lat: wehr.center_lat,
          lon: wehr.center_lon,
          value_numeric: h.temperature ?? null,
          unit: '°C',
          severity: h.condition ?? null,
          item_timestamp: h.timestamp,
          valid_until: null,
          payload: {
            precipitation: h.precipitation ?? null,
            windSpeedKmh: h.wind_speed ?? null,
            windDirectionDeg: h.wind_direction ?? null,
            windGustKmh: h.wind_gust_speed ?? null,
            cloudCoverPercent: h.cloud_cover ?? null,
            condition: h.condition ?? null,
            icon: h.icon ?? null,
            raw: h,
          },
        });
      }
    }
  }

  const rows = await upsertDatapoints(items);
  return { source: 'wetter_vorhersage', fetched: items.length, written: rows.length, rows };
}

module.exports = { fetchBrightskyForecast };
