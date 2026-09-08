-- Zustaendigkeitsgebiet: Landkreise (mit amtlichem Gemeindeschluessel/AGS + Grenzpolygon) als
-- Referenztabelle, plus ein wehrweites "Heimat-Landkreis"-Feld. Nachbarlandkreise werden NICHT
-- gespeichert, sondern bei Bedarf per ST_Touches() aus den Polygonen berechnet (siehe
-- backend/src/routes/wehr.js) - das bleibt automatisch korrekt, auch wenn sich einzelne
-- Kreisgrenzen irgendwann aendern, ohne Pflegeaufwand.

CREATE TABLE IF NOT EXISTS landkreis (
    ags CHAR(5) PRIMARY KEY,
    name TEXT NOT NULL,
    district_type TEXT,
    state TEXT,
    kfz TEXT,
    geom GEOMETRY(MultiPolygon, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_landkreis_geom ON landkreis USING GIST(geom);

ALTER TABLE wehr ADD COLUMN IF NOT EXISTS home_landkreis_ags CHAR(5) REFERENCES landkreis(ags);
