-- Wehr-weite Hydrantenkarte (Produkt-Review "Spaeter"-Paket): dieselbe Grundidee wie die
-- objektgebundene Kartenskizze (critical_object_map_sketch, Migration 012), aber EINE Zeile je
-- WEHR statt je Objekt - fuer Loeschwasserversorgung, die nicht an ein einzelnes Objekt gebunden ist
-- (Hydranten an Straßen, Löschteiche, Saugstellen im gesamten Zuständigkeitsgebiet). Bewusst
-- dieselbe GeoJSON-FeatureCollection-Struktur wie bei der Objekt-Kartenskizze (Vektordaten, kein
-- Bild) - der Frontend-Editor (js/object-sketch.js) wird fuer beide Faelle wiederverwendet, nur die
-- Speicher-URL unterscheidet sich.
CREATE TABLE IF NOT EXISTS wehr_hydranten_karte (
    wehr_id INTEGER PRIMARY KEY REFERENCES wehr(id) ON DELETE CASCADE,
    geojson JSONB NOT NULL DEFAULT '{"type":"FeatureCollection","features":[]}'::jsonb,
    updated_by INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
