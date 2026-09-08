// Hochwasserzentralen-API (Laenderuebergreifendes Hochwasserportal, LHP) - buendelt die Landes-
// Pegelnetze aller deutschen Bundeslaender (nicht nur die Bundeswasserstrassen, die PEGELONLINE
// abdeckt) an einer Stelle. Deckt damit auch die von den Laendern selbst betriebenen "weiteren
// Pegel" ab (siehe README "Datenquellen").
//
// KORREKTUR EINER FRUEHEREN FEHLANNAHME: Dieser Connector zielte urspruenglich auf einen erfundenen
// Endpunkt "webservices/pegel_alle.json" mit geratenen Feldnamen (lat/latitude/breite/...). Diese
// Annahme war falsch - es gibt keinen solchen Endpunkt. Ersetzt durch die tatsaechlich vom Anbieter
// betriebenen Endpunkte, dokumentiert im inoffiziellen, aber vom bundesAPI-Projekt gepflegten
// OpenAPI-Spec https://github.com/bundesAPI/hochwasserzentralen-api (openapi.yaml, mit echten
// Beispiel-Antworten). Damit steht dieser Connector jetzt auf einer deutlich solideren Basis als
// zuvor, ist aber WEITERHIN NICHT LIVE GETESTET (hochwasserzentralen.de ist aus dieser
// Entwicklungsumgebung nicht erreichbar, siehe README "Verifikationsstand der Fetcher") - vor
// Produktivbetrieb unbedingt einmal `npm run fetch -- hochwasserzentralen` pruefen.
//
// Zwei Endpunkte:
// 1. GET get_lagepegel.php (keine Parameter) - liefert ALLE Pegelstationen bundesweit (+ einzelne
//    Nachbarland-Stationen, z.B. Schweiz) als parallele Arrays {PGNR[], LAT[], LON[], HW[]}
//    (Stationsnummer, Koordinaten, grober Warnstatus-Code). KEIN Wasserstand-Messwert enthalten.
// 2. POST get_infospegel.php (Formular-Parameter "pgnr") - liefert Detaildaten EINER Station:
//    {PN, GW, W, HW, HW_TXT, ZEIT, ID_LAND, ...}. W ist Text mit eingebetteter Einheit (z.B.
//    "12 cm"), ZEIT ein deutschsprachiger Relativ-Text ("Heute, 11:30 Uhr", keine Zeitzone) - wird
//    deshalb NICHT in ein Datum umgerechnet (ein Rateversuch waere bei einer sicherheitsrelevanten
//    Zeitangabe riskanter als sie wegzulassen), item_timestamp bleibt leer, das Frontend faellt in
//    dem Fall auf fetched_at zurueck.
//
// Weil (2) nur einzelne Stationen liefert, waere ein bundesweiter Abruf tausende Einzelanfragen -
// stattdessen wird (1) einmal geladen, auf Stationen im Umkreis (config.hochwasserzentralenRadiusKm)
// um mindestens eine Wehr eingegrenzt, und nur fuer diese Teilmenge wird (2) einzeln nachgeladen -
// analog zum Umkreis-Muster in nasaFirms.js.

const { fetchJson, postForm } = require('./httpClient');
const { upsertDatapoints } = require('./normalize');
const { haversineKm } = require('../utils/geo');
const { query } = require('../db');
const config = require('../config');

const LAGEPEGEL_URL = 'https://www.hochwasserzentralen.de/webservices/get_lagepegel.php';
const INFOSPEGEL_URL = 'https://www.hochwasserzentralen.de/webservices/get_infospegel.php';

// Obergrenze fuer Einzelabrufe je Lauf, damit hochwasserzentralen.de nicht mit zu vielen Anfragen
// belastet wird, falls mehrere Wehren mit weit auseinanderliegenden Gebieten konfiguriert sind.
const MAX_STATIONS_PER_RUN = 80;

function parseWasserstand(text) {
  if (!text) return { value: null, unit: null };
  const match = String(text).trim().match(/^(-?[\d.,]+)\s*(\S+)?/);
  if (!match) return { value: null, unit: null };
  const value = Number(match[1].replace(',', '.'));
  return { value: Number.isNaN(value) ? null : value, unit: match[2] || null };
}

// HW ist laut Dokumentation nur ein grober, nicht naeher spezifizierter Warnstatus-Code - severity
// wird deshalb ausschliesslich aus dem einzigen dokumentierten Klartext-Beispiel "Kein Hochwasser"
// abgeleitet. Andere HW_TXT-Werte (z.B. konkrete Meldestufen-Texte) sind nicht verifiziert und
// werden bewusst NICHT in eine geratene Kategorie gezwungen - der Rohtext bleibt in
// payload.statusText erhalten und ist in der Detail-Ansicht sichtbar.
function hwTextToSeverity(hwText) {
  if (!hwText) return null;
  if (hwText.trim().toLowerCase().includes('kein hochwasser')) return 'kein_hochwasser';
  return null;
}

async function fetchHochwasserzentralen() {
  const { rows: wehren } = await query(
    'SELECT id, center_lat, center_lon FROM wehr WHERE center_lat IS NOT NULL AND center_lon IS NOT NULL'
  );
  if (wehren.length === 0) {
    return { source: 'hochwasserzentralen', fetched: 0, written: 0, skipped: 'keine Wehr mit Kartenmittelpunkt konfiguriert' };
  }

  let lagepegel;
  try {
    lagepegel = await fetchJson(LAGEPEGEL_URL);
  } catch (err) {
    console.warn(
      '[hochwasserzentralen] get_lagepegel.php nicht erreichbar - Endpunkt/Feldnamen sind nach ' +
        'bestem Wissen aus einer Community-OpenAPI-Spec rekonstruiert, siehe Kommentar am Dateianfang. ' +
        'Original-Fehler:',
      err.message
    );
    return { source: 'hochwasserzentralen', fetched: 0, written: 0, skipped: 'Abruf fehlgeschlagen (get_lagepegel.php)' };
  }

  const { PGNR, LAT, LON } = lagepegel || {};
  if (!Array.isArray(PGNR) || !Array.isArray(LAT) || !Array.isArray(LON)) {
    console.warn('[hochwasserzentralen] Unerwartetes Antwortformat von get_lagepegel.php - ueberspringe diesen Lauf.');
    return { source: 'hochwasserzentralen', fetched: 0, written: 0, skipped: 'unerwartetes Antwortformat (get_lagepegel.php)' };
  }

  const nearbyStations = [];
  for (let i = 0; i < PGNR.length; i += 1) {
    const lat = Number(LAT[i]);
    const lon = Number(LON[i]);
    if (Number.isNaN(lat) || Number.isNaN(lon) || !PGNR[i]) continue;
    const isNearAnyWehr = wehren.some(
      (wehr) => haversineKm(wehr.center_lat, wehr.center_lon, lat, lon) <= config.hochwasserzentralenRadiusKm
    );
    if (isNearAnyWehr) nearbyStations.push({ pgnr: PGNR[i], lat, lon });
  }

  const stationsToFetch = nearbyStations.slice(0, MAX_STATIONS_PER_RUN);
  if (nearbyStations.length > MAX_STATIONS_PER_RUN) {
    console.warn(
      `[hochwasserzentralen] ${nearbyStations.length} Stationen im Umkreis gefunden, nur die ersten ${MAX_STATIONS_PER_RUN} werden abgerufen.`
    );
  }

  const items = [];
  for (const station of stationsToFetch) {
    try {
      const info = await postForm(INFOSPEGEL_URL, { pgnr: station.pgnr });
      const { value, unit } = parseWasserstand(info.W);

      items.push({
        source: 'hochwasserzentralen',
        external_id: station.pgnr,
        title: [info.PN, info.GW].filter(Boolean).join(' / ') || `Pegel ${station.pgnr}`,
        lat: station.lat,
        lon: station.lon,
        value_numeric: value,
        unit,
        severity: hwTextToSeverity(info.HW_TXT),
        item_timestamp: null,
        valid_until: null,
        payload: {
          gewaesser: info.GW ?? null,
          land: info.ID_LAND ?? null,
          meldestufeRoh: info.HW ?? null,
          statusText: info.HW_TXT ?? null,
          zeitRoh: info.ZEIT ?? null,
        },
      });
    } catch (err) {
      console.warn(`[hochwasserzentralen] Station ${station.pgnr} uebersprungen:`, err.message);
    }
  }

  const rows = await upsertDatapoints(items);
  return { source: 'hochwasserzentralen', fetched: items.length, written: rows.length, rows };
}

module.exports = { fetchHochwasserzentralen };
