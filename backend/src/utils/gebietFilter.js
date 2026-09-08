// Baut die SQL-Bedingung + haengt die noetigen Parameter an, um live_datapoint-Zeilen auf ein
// Zustaendigkeitsgebiet (siehe loadZustaendigkeitsgebiet() in utils/zustaendigkeit.js) einzuschraenken.
// Von routes/datapoints.js genutzt (Karte, Lage-Liste und der Dashboard-Tab "Wetter" - siehe
// frontend/public/js/weather-overview.js - teilen sich alle denselben Endpunkt).
//
// Drei Filterarten, je nachdem wie genau eine Quelle ihre eigene Lage kennt:
// 1. LANDKREIS_SCOPED_SOURCES: die Quelle wurde beim Abruf bereits PRO KREIS erfragt (siehe
//    fetchers/bbkWarnungen.js) und traegt den exakten Kreis in payload.landkreisAgs - einfacher
//    Gleichheitsvergleich gegen das Gebiet, die praezisteste Filterart.
// 2. BUNDESLAND_SCOPED_SOURCES: die Quelle liefert wirklich KEINE Geokoordinate, nur einen
//    Bundesland-Code (dwd_unwetter, siehe fetchers/dwdUnwetter.js) - gefiltert gegen die im Gebiet
//    vertretenen Bundeslaender, die einzig moegliche Genauigkeit fuer diese Quelle.
// 3. Alle anderen Quellen haben eine echte Geokoordinate je Meldung und werden per ST_Contains
//    gegen die Kreis-Polygone im Gebiet gefiltert (auch waldbrandindex - siehe Kommentar in der
//    Fetcher-Datei, eine fruehere Version hatte das faelschlich wie #2 behandelt).
const LANDKREIS_SCOPED_SOURCES = ['bbk_warnung'];
const BUNDESLAND_SCOPED_SOURCES = ['dwd_unwetter'];

// Mutiert `params` (haengt an) und gibt den SQL-Bedingungs-String zurueck, oder null wenn `gebiet`
// null ist (kein Heimat-Landkreis konfiguriert -> keine Gebietsfilterung moeglich).
function buildGebietCondition(gebiet, params) {
  if (!gebiet) return null;

  params.push(LANDKREIS_SCOPED_SOURCES);
  const lkScopedIdx = params.length;
  params.push(gebiet.agsList);
  const agsIdx = params.length;
  params.push(BUNDESLAND_SCOPED_SOURCES);
  const blScopedIdx = params.length;
  params.push(gebiet.bundeslandCodes.length ? gebiet.bundeslandCodes : ['__keine__']);
  const codesIdx = params.length;

  // Wichtig: live_datapoint.geom explizit qualifiziert, sonst wird die Spalte im EXISTS-Subquery
  // durch landkreis.geom verdeckt (beide Tabellen haben eine Spalte "geom") und ST_Contains prueft
  // versehentlich l.geom gegen sich selbst - das war ein echter Bug hier (immer true).
  return `(
    (live_datapoint.source = ANY($${lkScopedIdx}) AND live_datapoint.payload->>'landkreisAgs' = ANY($${agsIdx}))
    OR
    (live_datapoint.source = ANY($${blScopedIdx}) AND live_datapoint.payload->>'bundeslandCode' = ANY($${codesIdx}))
    OR
    (live_datapoint.source != ALL($${lkScopedIdx}) AND live_datapoint.source != ALL($${blScopedIdx})
     AND live_datapoint.geom IS NOT NULL AND EXISTS (
      SELECT 1 FROM landkreis l WHERE l.ags = ANY($${agsIdx}) AND ST_Contains(l.geom, live_datapoint.geom)
    ))
  )`;
}

module.exports = { buildGebietCondition, BUNDESLAND_SCOPED_SOURCES, LANDKREIS_SCOPED_SOURCES };
