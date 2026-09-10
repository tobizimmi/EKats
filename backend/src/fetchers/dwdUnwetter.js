// DWD Unwetterwarnungen (amtliche Warnungen, Gemeindeebene). Kein API-Key noetig.
//
// Endpunkt und JSONP-Huelle sind identisch zum bereits produktiv laufenden FKatInfo-Connector
// (includes/connectors/DwdUnwetterConnector.php), dort zuletzt live gegen
// https://www.dwd.de/DWD/warnungen/warnapp/json/warnings.json verifiziert.
// Antwort ist JSONP-verpackt: "warnWetter.loadWarnings({...});" – muss vor JSON.parse() entpackt werden.
// `warnings` ist ein Objekt, Schluessel = Warncell-ID, Wert = Array von Warnungsobjekten mit u.a.
// state, stateShort (2-stelliger Bundesland-Code), level (1-4), headline, description, instruction,
// start/end (Unix-Millisekunden). Es gibt in dieser Feed-Variante kein eigenes "id"-Feld je Warnung.
//
// V1-Vereinfachung: DWD liefert hier keine Geokoordinate je Warnzelle (nur Bundesland-Code), das
// Widget zeigt Unwetterwarnungen daher als Liste ohne Kartenmarker (kein Polygon-Lookup fuer
// Warnzellen-IDs in V1) – identisch zur Vereinfachung, die FKatInfo bereits dokumentiert.

const { fetchText } = require('./httpClient');
const { upsertDatapoints, expireStaleItems } = require('./normalize');

const URL = 'https://www.dwd.de/DWD/warnungen/warnapp/json/warnings.json';

function levelToSeverity(level) {
  return { 1: 'gering', 2: 'mittel', 3: 'hoch', 4: 'extrem' }[level] ?? null;
}

async function fetchDwdUnwetter() {
  const body = await fetchText(URL);
  const trimmed = body.trim();
  const jsonpMatch = trimmed.match(/^\w+\.loadWarnings\((.*)\);?\s*$/s);
  const jsonText = jsonpMatch ? jsonpMatch[1] : trimmed;

  const decoded = JSON.parse(jsonText);
  if (!decoded || typeof decoded.warnings !== 'object') {
    throw new Error('DWD Unwetterwarnungen: unerwartetes Antwortformat.');
  }

  const items = [];
  for (const [warncellId, warningsForCell] of Object.entries(decoded.warnings)) {
    if (!Array.isArray(warningsForCell)) continue;
    for (const warning of warningsForCell) {
      const start = typeof warning.start === 'number' ? Math.floor(warning.start / 1000) : null;
      const end = typeof warning.end === 'number' ? Math.floor(warning.end / 1000) : null;
      const level = typeof warning.level === 'number' ? warning.level : null;

      items.push({
        source: 'dwd_unwetter',
        external_id: `${warncellId}_${warning.id ?? start ?? '0'}`,
        title: warning.headline || warning.event || 'Unwetterwarnung',
        lat: null,
        lon: null,
        value_numeric: level,
        unit: 'Warnstufe',
        severity: levelToSeverity(level),
        item_timestamp: start ? new Date(start * 1000).toISOString() : null,
        valid_until: end ? new Date(end * 1000).toISOString() : null,
        payload: {
          warncellId: String(warncellId),
          bundeslandCode: warning.stateShort ?? null,
          state: warning.state ?? null,
          description: warning.description ?? null,
          instruction: warning.instruction ?? null,
          event: warning.event ?? null,
        },
      });
    }
  }

  const rows = await upsertDatapoints(items);
  await expireStaleItems('dwd_unwetter', items.map((i) => i.external_id));
  return { source: 'dwd_unwetter', fetched: items.length, written: rows.length, rows };
}

module.exports = { fetchDwdUnwetter };
