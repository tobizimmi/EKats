-- Objektverwaltung: kritische Objekte (Schulen, Pflegeeinrichtungen, Gefahrstoffbetriebe, ...),
-- die Wehrfuehrung/Stab direkt auf der Karte anlegen/pflegen koennen.

CREATE TABLE IF NOT EXISTS critical_object (
    id SERIAL PRIMARY KEY,
    wehr_id INTEGER NOT NULL REFERENCES wehr(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'sonstiges' CHECK (
        category IN ('schule_kita', 'krankenhaus_pflege', 'industrie_gefahrstoff', 'versammlungsstaette', 'sonstiges')
    ),
    address TEXT,
    geom GEOMETRY(POINT, 4326) NOT NULL,
    hazards TEXT,
    access_info TEXT,
    contact_name TEXT,
    contact_phone TEXT,
    notes TEXT,
    created_by INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_critical_object_wehr ON critical_object(wehr_id);
CREATE INDEX IF NOT EXISTS idx_critical_object_geom ON critical_object USING GIST(geom);
