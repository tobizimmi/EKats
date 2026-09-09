-- Kartenskizzen direkt am Objekt (Konzept Teil 2, Baustein B): mit Stift und Symbolen auf einem
-- Kartenausschnitt einzeichnen (Zufahrt, Gefahrenbereich, Sammelplatz, ...), sichtbar im Objekt.
-- Bewusst als Vektordaten (GeoJSON FeatureCollection: LineString-Striche mit Stil, Point-Symbole mit
-- symbol-Eigenschaft) statt als starres Bild gespeichert - die Skizze bleibt dadurch spaeter
-- bearbeitbar (einzelne Striche/Symbole verschieben/loeschen), nicht nur als Ganzes ersetzbar. Eine
-- Zeile pro Objekt (kein Verlauf/keine Versionen noetig fuer V1) - PUT ersetzt den Inhalt komplett.
CREATE TABLE IF NOT EXISTS critical_object_map_sketch (
    critical_object_id INTEGER PRIMARY KEY REFERENCES critical_object(id) ON DELETE CASCADE,
    geojson JSONB NOT NULL DEFAULT '{"type":"FeatureCollection","features":[]}'::jsonb,
    updated_by INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
