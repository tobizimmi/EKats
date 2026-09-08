-- Bundesland-Flaechen fuer die Kartendarstellung von DWD-Unwetterwarnungen (die nur eine
-- Bundesland-Ebene liefern, siehe fetchers/dwdUnwetter.js). Materialisiert statt live per
-- ST_Union() berechnet, damit jede Kartenansicht nicht 16x eine teure Aggregation ueber alle
-- Kreis-Polygone ausloest - Befuellung als Nebenschritt von src/importLandkreise.js (aus den
-- bereits importierten Kreisen aggregiert, kein zusaetzlicher Download).
CREATE TABLE IF NOT EXISTS bundesland (
    code CHAR(2) PRIMARY KEY,
    name TEXT NOT NULL,
    geom GEOMETRY(MultiPolygon, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bundesland_geom ON bundesland USING GIST(geom);
