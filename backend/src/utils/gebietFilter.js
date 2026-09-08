// Baut die SQL-Bedingung + haengt die noetigen Parameter an, um live_datapoint-Zeilen auf ein
// Zustaendigkeitsgebiet (siehe loadZustaendigkeitsgebiet() in utils/zustaendigkeit.js) einzuschraenken.
// Von routes/datapoints.js genutzt (Karte, Lage-Liste und der Dashboard-Tab "Wetter" - siehe
// frontend/public/js/weather-overview.js - teilen sich alle denselben Endpunkt).
//
// Nur dwd_unwetter hat wirklich KEINE Geokoordinate je Meldung (DWD liefert nur den Bundesland-Code,
// siehe fetchers/dwdUnwetter.js) und wird deshalb ueber den Bundesland-Code gefiltert. Alle anderen
// Quellen - AUCH waldbrandindex, das ueber dwd_station eine echte Stations-Koordinate hat - werden
// ueber die Geokoordinate gegen die Kreis-Polygone im Gebiet gefiltert (ST_Contains). Fruehere
// Version hatte waldbrandindex faelschlich hier mit aufgefuehrt: eine WBI-Station irgendwo im selben,
// oft großen Bundesland (z.B. Baden-Wuerttemberg) wurde dadurch angezeigt und faelschlich einem
// "Nachbarlandkreis" zugeordnet, obwohl sie geografisch weit vom Zustaendigkeitsgebiet entfernt lag.
const BUNDESLAND_SCOPED_SOURCES = ['dwd_unwetter'];

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
