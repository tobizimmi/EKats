// Baut die SQL-Bedingung + haengt die noetigen Parameter an, um live_datapoint-Zeilen auf ein
// Zustaendigkeitsgebiet (siehe loadZustaendigkeitsgebiet() in utils/zustaendigkeit.js) einzuschraenken.
// Von routes/datapoints.js genutzt (Karte, Lage-Liste und der Dashboard-Tab "Wetter" - siehe
// frontend/public/js/weather-overview.js - teilen sich alle denselben Endpunkt).
//
// Quellen ohne Geokoordinate je Meldung (nur Bundesland-Code im Payload, siehe fetchers/*.js)
// werden ueber den Bundesland-Code gefiltert, alle anderen ueber die Geokoordinate gegen die
// Kreis-Polygone im Gebiet (ST_Contains).
const BUNDESLAND_SCOPED_SOURCES = ['dwd_unwetter', 'waldbrandindex'];

// Mutiert `params` (haengt an) und gibt den SQL-Bedingungs-String zurueck, oder null wenn `gebiet`
// null ist (kein Heimat-Landkreis konfiguriert -> keine Gebietsfilterung moeglich).
function buildGebietCondition(gebiet, params) {
  if (!gebiet) return null;

  params.push(BUNDESLAND_SCOPED_SOURCES);
  const scopedIdx = params.length;
  params.push(gebiet.bundeslandCodes.length ? gebiet.bundeslandCodes : ['__keine__']);
  const codesIdx = params.length;
  params.push(gebiet.agsList);
  const agsIdx = params.length;

  // Wichtig: live_datapoint.geom explizit qualifiziert, sonst wird die Spalte im EXISTS-Subquery
  // durch landkreis.geom verdeckt (beide Tabellen haben eine Spalte "geom") und ST_Contains prueft
  // versehentlich l.geom gegen sich selbst - das war ein echter Bug hier (immer true).
  return `(
    (live_datapoint.source = ANY($${scopedIdx}) AND live_datapoint.payload->>'bundeslandCode' = ANY($${codesIdx}))
    OR
    (live_datapoint.source != ALL($${scopedIdx}) AND live_datapoint.geom IS NOT NULL AND EXISTS (
      SELECT 1 FROM landkreis l WHERE l.ags = ANY($${agsIdx}) AND ST_Contains(l.geom, live_datapoint.geom)
    ))
  )`;
}

module.exports = { buildGebietCondition, BUNDESLAND_SCOPED_SOURCES };
