// Zustaendigkeitsgebiet einer Wehr (Heimat-Landkreis + automatisch berechnete Nachbarn, siehe
// routes/wehr.js) als wiederverwendbare Grundlage fuer die Gebiets-Filterung in routes/datapoints.js
// (siehe utils/gebietFilter.js). Nachbarn werden bewusst nicht gespeichert, sondern bei jedem Aufruf
// per ST_Touches() aus den echten Kreisgrenzen berechnet (siehe Migration 006) - bleibt dadurch immer
// korrekt, auch wenn sich die Landkreis-Geometrien durch einen erneuten Import aendern.

const { query } = require('../db');
const { codeForName } = require('./bundeslaender');

// Liefert null, wenn die Wehr (noch) keinen Heimat-Landkreis konfiguriert hat - Aufrufer muessen
// diesen Fall als "keine Gebietsfilterung moeglich, zeige alles" behandeln, nicht als leeres Gebiet.
async function loadZustaendigkeitsgebiet(wehrId) {
  const { rows: wehrRows } = await query('SELECT home_landkreis_ags FROM wehr WHERE id = $1', [wehrId]);
  const homeAgs = wehrRows[0]?.home_landkreis_ags;
  if (!homeAgs) return null;

  const { rows } = await query(
    `SELECT ags, name, state, (ags = $1) AS is_home
     FROM landkreis
     WHERE ags = $1 OR ags IN (
       SELECT n.ags FROM landkreis h, landkreis n
       WHERE h.ags = $1 AND n.ags != h.ags AND ST_Touches(h.geom, n.geom)
     )
     ORDER BY is_home DESC, name`,
    [homeAgs]
  );

  const agsList = rows.map((r) => r.ags);
  const bundeslandCodes = [...new Set(rows.map((r) => codeForName(r.state)).filter(Boolean))];
  const landkreise = rows.map((r) => ({ ags: r.ags, name: r.name, isHome: r.is_home }));

  return { homeAgs, agsList, bundeslandCodes, landkreise };
}

module.exports = { loadZustaendigkeitsgebiet };
