// Einmaliger Import-Job: befuellt die landkreis-Tabelle (402 Kreise/kreisfreie Staedte, amtlicher
// Gemeindeschluessel (AGS), Polygon-/MultiPolygon-Grenzen). Anders als die 5 Live-Datenquellen ist
// das KEIN wiederkehrender Cron-Job - Kreisgrenzen aendern sich praktisch nie, ein erneuter Lauf
// (idempotent per ON CONFLICT) reicht bei Bedarf manuell (z.B. "npm run import-landkreise").
//
// Quelle: https://github.com/m-ad/geofeatures-ags-germany (geojson/counties.json), dort als
// "id: five digit Community Identification Number (AGS)" dokumentiert, Geometrie urspruenglich aus
// der GADM-Datenbank. GADM untersagt Weiterverbreitung ohne Erlaubnis - die Datei wird deshalb
// BEWUSST NICHT im eigenen Repo vorgehalten, sondern bei jedem Lauf direkt von GitHub geladen
// (dieselbe Zwischenspeicherungs-Logik wie bei den DWD-Quellen: kein Redistributions-Risiko im
// eigenen Git-Repo). Siehe README-Abschnitt "Zustaendigkeitsgebiet" fuer weitere Lizenzhinweise.

const { fetchJson } = require('./fetchers/httpClient');
const { pool, query } = require('./db');
const { codeForName } = require('./utils/bundeslaender');

const SOURCE_URL = 'https://raw.githubusercontent.com/m-ad/geofeatures-ags-germany/master/geojson/counties.json';

async function importLandkreise() {
  const geojson = await fetchJson(SOURCE_URL, { timeoutMs: 30000 });
  if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
    throw new Error('Landkreis-Quelle: unerwartetes Format (keine FeatureCollection).');
  }

  let imported = 0;
  for (const feature of geojson.features) {
    const ags = String(feature.id || '').padStart(5, '0');
    const props = feature.properties || {};
    if (!/^\d{5}$/.test(ags) || !feature.geometry) continue;

    await query(
      `INSERT INTO landkreis (ags, name, district_type, state, kfz, geom)
       VALUES ($1, $2, $3, $4, $5, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($6), 4326)))
       ON CONFLICT (ags) DO UPDATE SET
         name = EXCLUDED.name,
         district_type = EXCLUDED.district_type,
         state = EXCLUDED.state,
         kfz = EXCLUDED.kfz,
         geom = EXCLUDED.geom`,
      [ags, props.name, props.districtType || null, props.state || null, props.kfz || null, JSON.stringify(feature.geometry)]
    );
    imported += 1;
  }

  if (imported === 0) {
    throw new Error('Keine einzige Landkreis-Zeile importiert - Quellformat evtl. geaendert.');
  }

  const bundeslaenderCount = await importBundeslaenderFromLandkreise();

  return { imported, total: geojson.features.length, bundeslaenderCount };
}

// Aggregiert die gerade importierten Kreis-Polygone je Bundesland-Namen zu einer Flaeche (kein
// zusaetzlicher Download noetig) - fuer die Kartendarstellung von DWD-Unwetterwarnungen, die nur
// Bundesland-Ebene liefern (siehe fetchers/dwdUnwetter.js). codeForName() nutzt dieselbe
// verifizierte Namens-Tabelle wie dwdStationsImport.js, damit z.B. Brandenburg garantiert als "BB"
// (nicht "BR", ein Fehler im Quelldatensatz eines Alternativkandidaten) gespeichert wird.
async function importBundeslaenderFromLandkreise() {
  // ST_MakeValid() vor dem Union: die Quellgeometrie (GADM-Herkunft, siehe oben) enthaelt an
  // manchen Bundeslandgrenzen minimal ungueltige Ringe, an denen ST_Union() sonst mit einer
  // GEOS-TopologyException abbricht. ST_MakeValid() kann dabei vereinzelt entartete Punkt-/Linien-
  // Reste als GeometryCollection zurueckgeben - ST_CollectionExtract(..., 3) behaelt nur die
  // Flaechenanteile, bevor in die MultiPolygon-Spalte geschrieben wird.
  const { rows } = await query(
    `SELECT state, ST_AsGeoJSON(ST_Multi(ST_Union(ST_CollectionExtract(ST_MakeValid(geom), 3)))) AS geometry
     FROM landkreis WHERE state IS NOT NULL GROUP BY state`
  );

  let count = 0;
  for (const row of rows) {
    const code = codeForName(row.state);
    if (!code) {
      console.warn(`[importLandkreise] Kein Bundesland-Code fuer "${row.state}" gefunden - uebersprungen.`);
      continue;
    }
    await query(
      `INSERT INTO bundesland (code, name, geom)
       VALUES ($1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326))
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, geom = EXCLUDED.geom`,
      [code, row.state, row.geometry]
    );
    count += 1;
  }
  return count;
}

if (require.main === module) {
  importLandkreise()
    .then(({ imported, total, bundeslaenderCount }) => {
      console.log(`landkreis: ${imported}/${total} Kreise importiert/aktualisiert.`);
      console.log(`bundesland: ${bundeslaenderCount}/16 Flaechen aggregiert/aktualisiert.`);
      return pool.end();
    })
    .catch((err) => {
      console.error('FEHLER beim Import der Landkreise:', err);
      process.exitCode = 1;
      return pool.end();
    });
}

module.exports = { importLandkreise };
