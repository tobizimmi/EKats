// Baut die SQL-Bedingung + haengt die noetigen Parameter an, um live_datapoint-Zeilen auf ein
// Zustaendigkeitsgebiet (siehe loadZustaendigkeitsgebiet() in utils/zustaendigkeit.js) einzuschraenken.
// Von routes/datapoints.js genutzt (Karte, Lage-Liste und der Dashboard-Tab "Wetter" - siehe
// frontend/public/js/weather-overview.js - teilen sich alle denselben Endpunkt).
//
// Fuenf Filterarten, je nachdem wie genau eine Quelle ihre eigene Lage kennt:
// 1. LANDKREIS_SCOPED_SOURCES: die Quelle wurde beim Abruf bereits PRO KREIS erfragt (siehe
//    fetchers/bbkWarnungen.js) und traegt den exakten Kreis in payload.landkreisAgs - einfacher
//    Gleichheitsvergleich gegen das Gebiet, die praezisteste Filterart.
// 2. BUNDESLAND_SCOPED_SOURCES: die Quelle liefert wirklich KEINE Geokoordinate, nur einen
//    Bundesland-Code (dwd_unwetter, siehe fetchers/dwdUnwetter.js) - gefiltert gegen die im Gebiet
//    vertretenen Bundeslaender, die einzig moegliche Genauigkeit fuer diese Quelle.
// 3. RADIUS_SCOPED_SOURCES: Pegelmessstellen liegen nur an (Bundes-)Wasserstrassen - viele Kreise
//    haben ueberhaupt keine eigene Station, auch nicht in ihren direkt angrenzenden Nachbarkreisen
//    (zustaendigkeit.js bildet nur einen Nachbarschafts-Ring). Reine Kreis-Zugehoerigkeit blendet
//    dann die naechstgelegene, fuer die Lage trotzdem relevante Station komplett aus - deshalb
//    zaehlt hier zusaetzlich ein Luftlinien-Umkreis um den Wehr-Kartenmittelpunkt
//    (wehr.center_lat/center_lon), als ODER-Ergaenzung zur normalen Kreis-Pruefung aus #5, nicht als
//    deren Ersatz. Ohne konfigurierten Kartenmittelpunkt greift fuer diese Quellen weiterhin nur #5.
// 4. UNSCOPED_SOURCES: wetter_vorhersage traegt IMMER die Koordinate des Wehr-Kartenmittelpunkts
//    selbst (siehe fetchers/brightsky.js - jede Vorhersage-Stunde nutzt wehr.center_lat/center_lon),
//    nie eine unabhaengige Ereignis-Koordinate. Eine ST_Contains-Pruefung "liegt der eigene
//    Kartenmittelpunkt im eigenen Zustaendigkeitsgebiet" ist damit keine echte Ortsfilterung, sondern
//    prueft nur, ob die Admin-Konfiguration (Heimat-Landkreis-Auswahl vs. Kartenmittelpunkt-Klick)
//    exakt zusammenpasst - liegt der Mittelpunkt nur knapp ausserhalb der eigenen Kreisgrenze (z.B.
//    nahe der Grenze gesetzt), blieb die eigene Vorhersage bislang dauerhaft leer, ohne dass das mit
//    "Lage ausserhalb des Zustaendigkeitsgebiets" zu tun hatte. Deshalb ungefiltert durchgereicht.
// 5. Alle anderen Quellen (und zusaetzlich #3) haben eine echte, unabhaengige Geokoordinate je
//    Meldung und werden per ST_Contains gegen die Kreis-Polygone im Gebiet gefiltert (auch
//    waldbrandindex - siehe Kommentar in der Fetcher-Datei, eine fruehere Version hatte das
//    faelschlich wie #2 behandelt).
const LANDKREIS_SCOPED_SOURCES = ['bbk_warnung'];
const BUNDESLAND_SCOPED_SOURCES = ['dwd_unwetter'];
const RADIUS_SCOPED_SOURCES = ['pegelonline', 'hochwasserzentralen'];
const RADIUS_SCOPED_METERS = 60000; // 60km, deckt sich mit dem Standard von HOCHWASSERZENTRALEN_RADIUS_KM (config.js)
const UNSCOPED_SOURCES = ['wetter_vorhersage'];

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
  params.push(UNSCOPED_SOURCES);
  const unscopedIdx = params.length;

  // Radius-Klausel nur bauen, wenn die Wehr ueberhaupt einen Kartenmittelpunkt hat - sonst bleibt es
  // bei der reinen Kreis-Pruefung fuer diese Quellen (kein Fehler, nur keine Zusatz-Erweiterung).
  let radiusClause = 'false';
  if (gebiet.centerLat !== null && gebiet.centerLat !== undefined && gebiet.centerLon !== null && gebiet.centerLon !== undefined) {
    params.push(RADIUS_SCOPED_SOURCES);
    const radiusScopedIdx = params.length;
    params.push(gebiet.centerLon);
    const centerLonIdx = params.length;
    params.push(gebiet.centerLat);
    const centerLatIdx = params.length;
    params.push(RADIUS_SCOPED_METERS);
    const radiusMetersIdx = params.length;
    radiusClause = `(live_datapoint.source = ANY($${radiusScopedIdx}) AND live_datapoint.geom IS NOT NULL
      AND ST_DWithin(live_datapoint.geom::geography, ST_SetSRID(ST_MakePoint($${centerLonIdx}, $${centerLatIdx}), 4326)::geography, $${radiusMetersIdx}))`;
  }

  // Wichtig: live_datapoint.geom explizit qualifiziert, sonst wird die Spalte im EXISTS-Subquery
  // durch landkreis.geom verdeckt (beide Tabellen haben eine Spalte "geom") und ST_Contains prueft
  // versehentlich l.geom gegen sich selbst - das war ein echter Bug hier (immer true).
  return `(
    (live_datapoint.source = ANY($${lkScopedIdx}) AND live_datapoint.payload->>'landkreisAgs' = ANY($${agsIdx}))
    OR
    (live_datapoint.source = ANY($${blScopedIdx}) AND live_datapoint.payload->>'bundeslandCode' = ANY($${codesIdx}))
    OR
    live_datapoint.source = ANY($${unscopedIdx})
    OR
    ${radiusClause}
    OR
    (live_datapoint.source != ALL($${lkScopedIdx}) AND live_datapoint.source != ALL($${blScopedIdx})
     AND live_datapoint.source != ALL($${unscopedIdx})
     AND live_datapoint.geom IS NOT NULL AND EXISTS (
      SELECT 1 FROM landkreis l WHERE l.ags = ANY($${agsIdx}) AND ST_Contains(l.geom, live_datapoint.geom)
    ))
  )`;
}

module.exports = {
  buildGebietCondition,
  BUNDESLAND_SCOPED_SOURCES,
  LANDKREIS_SCOPED_SOURCES,
  RADIUS_SCOPED_SOURCES,
  RADIUS_SCOPED_METERS,
  UNSCOPED_SOURCES,
};
