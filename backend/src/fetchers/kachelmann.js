// Kachelmannwetter / Meteologix Business-API ("Offene Entscheidungen" Punkt 1: Nutzer hat
// zugestimmt, jetzt zu integrieren, Freischaltung spaeter ueber ein "Pro"-Angebot). Optionale,
// kostenpflichtige Quelle - wird nur abgerufen, wenn (a) ein globaler API-Key konfiguriert ist
// (config.kachelmannApiKey, gleiches V1-Muster wie NASA_FIRMS_MAP_KEY: EIN Key fuer die gesamte
// Instanz, kein Multi-Tenant-Schluesselbund) UND (b) mindestens eine Wehr das Feature 'kachelmann'
// fuer mindestens eine Rolle/einen Nutzer freigeschaltet hat (siehe utils/featureAccess.js,
// Migration 009, Admin-Bereich) - so werden keine kostenpflichtigen Requests fuer eine Wehr
// verbraucht, in der niemand Zugriff hat.
//
// **VERIFIKATIONSSTAND (ehrlich, siehe README):** business.meteologix.com war aus dieser
// Entwicklungsumgebung nicht erreichbar (Egress-Firewall) - weder die offizielle API-Dokumentation
// noch ein Test-Request waren moeglich. Oeffentlich recherchierbar war nur: Registrierung + Paketwahl
// liefert einen API-Key, die Doku ist unter https://www.business.meteologix.com/api interaktiv
// (Testbare Requests), das Produktportfolio umfasst u.a. "storm tracking", "radar totals" und
// "live warnings". Der tatsaechliche Endpunktpfad, das Auth-Schema (Header vs. Query-Param) und
// die JSON-Struktur sind NICHT verifiziert. fetchKachelmannWarnings() unten macht einen best-effort
// Request gegen eine plausible REST-Konvention (Bearer-Token, /v1/warnings/live) - das ist eine
// begruendete Annahme, KEINE verifizierte Tatsache. Jeder unerwartete Response-Shape wird als Fehler
// gemeldet (nicht stillschweigend falsch geparst); bei Fehlschlag bitte mit einem echten
// Kachelmann-Business-Account gegenpruefen und diese Datei entsprechend korrigieren (genau das
// Vorgehen, das bei hochwasserzentralen.js schon zweimal noetig war - siehe dessen Kommentarkopf).
const { fetchJson } = require('./httpClient');
const { upsertDatapoints } = require('./normalize');
const { query } = require('../db');
const config = require('../config');

const BASE_URL = 'https://api.business.meteologix.com/v1'; // UNVERIFIZIERT, siehe Dateikopf

async function anyWehrHasKachelmannAccess() {
  const { rows } = await query(
    `SELECT 1 FROM wehr_feature_role_access WHERE feature_key = 'kachelmann'
     UNION
     SELECT 1 FROM user_feature_access WHERE feature_key = 'kachelmann' AND enabled = true
     LIMIT 1`
  );
  return rows.length > 0;
}

// Auf dieselbe 1-4-Aufloesung wie dwd_unwetter/bbk_warnung gemappt (value_numeric = Stufe,
// severity = Textlabel), damit severityScore() im Frontend (severity.js) alle drei gleich
// behandeln kann - Annahme zum Quellformat unverifiziert, siehe Dateikopf.
const LEVEL_TO_SEVERITY = { 1: 'gering', 2: 'mittel', 3: 'hoch', 4: 'extrem' };

function levelFromKachelmannSeverity(level) {
  if (level === undefined || level === null) return null;
  if (typeof level === 'number') return Math.max(0, Math.min(4, Math.round(level))) || null;
  const map = { minor: 1, moderate: 2, severe: 3, extreme: 4 };
  return map[String(level).toLowerCase()] ?? null;
}

async function fetchKachelmannWarnings() {
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
    const url = `${BASE_URL}/warnings/live?lat=${wehr.center_lat}&lon=${wehr.center_lon}&radius=${config.kachelmannRadiusKm}`;
    let data;
    try {
      data = await fetchJson(url, { headers: { Authorization: `Bearer ${config.kachelmannApiKey}` } });
    } catch (err) {
      throw new Error(
        `Kachelmann-API-Request fehlgeschlagen (Endpunkt/Auth-Schema unverifiziert, siehe Dateikopf kachelmann.js): ${err.message}`
      );
    }

    const warnings = Array.isArray(data) ? data : Array.isArray(data?.warnings) ? data.warnings : null;
    if (warnings === null) {
      throw new Error(
        'Kachelmann-API: unerwartetes Antwortformat (kein Array/keine "warnings"-Liste) - Endpunkt/Response-Schema muss gegen einen echten Account verifiziert werden.'
      );
    }

    for (const w of warnings) {
      if (!w || !w.id) continue;
      const level = levelFromKachelmannSeverity(w.severity ?? w.level);
      items.push({
        source: 'kachelmann',
        external_id: String(w.id),
        title: w.headline || w.type || 'Kachelmann-Warnung',
        lat: w.lat ?? wehr.center_lat,
        lon: w.lon ?? wehr.center_lon,
        value_numeric: level,
        unit: null,
        severity: level !== null ? LEVEL_TO_SEVERITY[level] : null,
        item_timestamp: w.issued_at || w.timestamp || null,
        valid_until: w.expires_at || null,
        payload: { raw: w },
      });
    }
  }

  const rows = await upsertDatapoints(items);
  return { source: 'kachelmann', fetched: items.length, written: rows.length, rows };
}

module.exports = { fetchKachelmannWarnings };
