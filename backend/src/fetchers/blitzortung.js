// Blitzortung.org - kostenloses Community-Blitzortungsnetz (~1.800 Stationen weltweit, siehe
// Konzeptpapier "Einsatzleiter-Portal 2.0"). Anders als die neun uebrigen Quellen liefert es keine
// periodisch abrufbare HTTP-API, sondern einen dauerhaft offenen WebSocket-Livestream einzelner
// Blitzeinschlaege - deshalb kein cron-Job in scheduler.js, sondern eine eigene, lang laufende
// Verbindung mit automatischem Reconnect, gestartet einmal beim Server-Start (siehe index.js).
//
// Protokoll verifiziert gegen die aktiv gepflegte, quelloffene Referenzimplementierung
// github.com/SimonSchick/BlitzortungAPI (TypeScript, npm-Paket @simonschick/blitzortungapi):
// vier gleichwertige Server wss://ws{1,5,6,7}.blitzortung.org:3000/ (zufaellige Auswahl zur
// Lastverteilung), nach Verbindungsaufbau wird {"time":0} gesendet, eingehende Nachrichten sind
// laut dieser Referenzimplementierung reines JSON (kein zusaetzlicher Kompressionsschritt) mit u.a.
// lat/lon (Grad), time (Unix-ZEIT IN NANOSEKUNDEN), pol (Polaritaet), mds (Ortungsgenauigkeit in m).
// NICHT live gegen den echten Server verifiziert, da blitzortung.org wie alle Drittanbieter-Hosts in
// dieser Sandbox nicht erreichbar ist - vor Produktivbetrieb pruefen, ob echte Nachrichten wirklich
// exakt diesem Schema entsprechen (siehe handleMessage(), meldet unerwartete Formen laut statt sie
// stillschweigend falsch zu verarbeiten).
//
// Präzisions-Vorbehalt: "time" ist eine Nanosekunden-Epoche (~1.8e18 im Jahr 2026) - das sprengt den
// fuer JS-Number verlustfrei darstellbaren Bereich (Number.MAX_SAFE_INTEGER ~9e15). Ob der Server
// diesen Wert als JSON-Zahl (dann von JSON.parse() selbst schon verlustbehaftet gerundet, nicht mehr
// reparierbar) oder als String sendet, war ebenfalls nicht live verifizierbar - die Umrechnung
// unten nutzt BigInt, was den Stringfall exakt handhabt und den Zahlenfall nicht schlimmer macht.
//
// Nutzungsbedingungen (blitzortung.org): Weitergabe an Dritte nur ueber einen selbst betriebenen
// Server, keine Weiterverbreitung ueber einen eigenen oeffentlichen Endpunkt. EKats zeigt die Daten
// ausschliesslich innerhalb der eigenen, per Login geschuetzten Wehr-Installation an - keine
// oeffentliche Weiterverbreitung, damit unkritisch fuer den internen Gebrauch einer einzelnen Wehr.
//
// Gebietsfilterung bereits bei der Aufnahme (nicht erst bei der Abfrage wie bei den uebrigen
// Quellen): das globale Blitzortung-Netz liefert potenziell tausende Einschlaege pro Minute
// weltweit waehrend aktiver Gewitterlagen - ungefiltert wuerde live_datapoint explodieren. Nur
// Einschlaege innerhalb BLITZORTUNG_RADIUS_KM um mindestens einen Wehr-Kartenmittelpunkt werden
// gespeichert (dieselbe Grundidee wie FIRMS_RADIUS_KM, nur am Empfang statt an der Abfrage-URL).

const WebSocket = require('ws');
const { query } = require('../db');
const { haversineKm } = require('../utils/geo');
const { upsertDatapoints } = require('./normalize');
const config = require('../config');

const SERVERS = [1, 5, 6, 7].map((n) => `wss://ws${n}.blitzortung.org:3000/`);
const RECONNECT_DELAY_MS = 15000;
// Ohne expliziten Timeout haengt ein Verbindungsversuch bei einem stillen Netzwerkproblem (z.B.
// eine Firewall, die Pakete verwirft statt die Verbindung aktiv abzulehnen) unbegrenzt - weder
// 'open' noch 'error'/'close' feuern dann jemals, der automatische Reconnect wuerde nie greifen.
const CONNECT_TIMEOUT_MS = 20000;
const BATCH_INTERVAL_MS = 30000;
// Ein einzelner Blitzeinschlag ist fuer die Gewitterzug-Anzeige nur kurz relevant - laeuft von
// selbst aus der ungefilterten Lage-Uebersicht (WHERE valid_until IS NULL OR valid_until >= now(),
// siehe routes/datapoints.js), ohne auf den naechtlichen Cleanup-Job warten zu muessen.
const STRIKE_VALID_MINUTES = 30;

let ws = null;
let reconnectTimer = null;
let batchTimer = null;
let pendingStrikes = [];
let currentWehren = [];

function pickServer() {
  return SERVERS[Math.floor(Math.random() * SERVERS.length)];
}

async function loadWehren() {
  const { rows } = await query(
    'SELECT id, center_lat, center_lon FROM wehr WHERE center_lat IS NOT NULL AND center_lon IS NOT NULL'
  );
  return rows;
}

function isNearAnyWehr(lat, lon) {
  return currentWehren.some(
    (w) => haversineKm(lat, lon, w.center_lat, w.center_lon) <= config.blitzortungRadiusKm
  );
}

async function flushPendingStrikes() {
  if (pendingStrikes.length === 0) return;
  const items = pendingStrikes;
  pendingStrikes = [];
  try {
    const rows = await upsertDatapoints(items);
    console.log(`[blitzortung] ${rows.length} Blitzeinschlaege im Gebiet gespeichert.`);
  } catch (err) {
    console.error('[blitzortung] Speichern fehlgeschlagen:', err.message);
  }
}

function handleMessage(raw) {
  let strike;
  try {
    strike = JSON.parse(raw);
  } catch (err) {
    console.error('[blitzortung] Unerwartetes Nachrichtenformat (kein gueltiges JSON):', err.message);
    return;
  }

  if (typeof strike.lat !== 'number' || typeof strike.lon !== 'number' || strike.time === undefined) {
    console.error(
      '[blitzortung] Unerwartete Nachrichtenform (lat/lon/time fehlen) - Protokoll hat sich vermutlich geaendert:',
      JSON.stringify(strike).slice(0, 200)
    );
    return;
  }

  if (!isNearAnyWehr(strike.lat, strike.lon)) return;

  let timeNs;
  try {
    timeNs = BigInt(strike.time);
  } catch (err) {
    console.error('[blitzortung] Unerwarteter time-Wert (weder Ganzzahl noch numerischer String):', strike.time);
    return;
  }
  const timestampMs = Number(timeNs / 1000000n);
  if (!Number.isFinite(timestampMs)) {
    console.error('[blitzortung] time-Wert nach Umrechnung ungueltig:', strike.time);
    return;
  }
  const itemTimestamp = new Date(timestampMs).toISOString();

  pendingStrikes.push({
    source: 'blitzortung',
    // Natural Key ohne Nutzerbezug (wie bei firms) - ueberlappende Wehr-Radien konvergieren auf
    // dieselbe Zeile statt Duplikate anzulegen.
    external_id: `${strike.lat.toFixed(5)}_${strike.lon.toFixed(5)}_${strike.time}`,
    title: 'Blitzeinschlag',
    lat: strike.lat,
    lon: strike.lon,
    value_numeric: typeof strike.mds === 'number' ? strike.mds : null,
    unit: typeof strike.mds === 'number' ? 'm (Ortungsgenauigkeit)' : null,
    severity: null,
    item_timestamp: itemTimestamp,
    valid_until: new Date(timestampMs + STRIKE_VALID_MINUTES * 60 * 1000).toISOString(),
    payload: { polarity: strike.pol ?? null, altitude: strike.alt ?? null },
  });
}

async function connect() {
  currentWehren = await loadWehren();
  if (currentWehren.length === 0) {
    console.warn('[blitzortung] Keine Wehr mit Kartenmittelpunkt konfiguriert - Verbindung wird nicht aufgebaut.');
    scheduleReconnect();
    return;
  }

  const url = pickServer();
  console.log(`[blitzortung] Verbinde zu ${url} ...`);

  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error('[blitzortung] Verbindungsaufbau fehlgeschlagen:', err.message);
    scheduleReconnect();
    return;
  }

  const connectTimeout = setTimeout(() => {
    console.warn(`[blitzortung] Verbindungsversuch nach ${CONNECT_TIMEOUT_MS / 1000}s ohne Reaktion abgebrochen.`);
    ws.terminate();
  }, CONNECT_TIMEOUT_MS);

  ws.on('open', () => {
    clearTimeout(connectTimeout);
    console.log('[blitzortung] Verbunden, sende Subscribe-Nachricht.');
    ws.send(JSON.stringify({ time: 0 }));
  });

  ws.on('message', (data) => handleMessage(data.toString()));

  ws.on('close', () => {
    clearTimeout(connectTimeout);
    console.warn(`[blitzortung] Verbindung getrennt, Reconnect in ${RECONNECT_DELAY_MS / 1000}s.`);
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[blitzortung] Verbindungsfehler:', err.message);
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect().catch((err) => console.error('[blitzortung] Reconnect fehlgeschlagen:', err.message)), RECONNECT_DELAY_MS);
}

function startBlitzortungStream() {
  if (!config.blitzortungEnabled) {
    console.log('[blitzortung] Deaktiviert (BLITZORTUNG_ENABLED=false).');
    return;
  }
  batchTimer = setInterval(() => {
    flushPendingStrikes().catch((err) => console.error('[blitzortung] Flush fehlgeschlagen:', err.message));
  }, BATCH_INTERVAL_MS);
  connect().catch((err) => console.error('[blitzortung] Start fehlgeschlagen:', err.message));
}

function stopBlitzortungStream() {
  clearInterval(batchTimer);
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.removeAllListeners();
    ws.close();
    ws = null;
  }
}

module.exports = { startBlitzortungStream, stopBlitzortungStream };
