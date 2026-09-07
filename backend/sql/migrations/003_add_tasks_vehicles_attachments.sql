-- Erweitert die Objektverwaltung um Fahrzeuge/Wachen-Stammdaten, Aufgaben je Objekt+Fahrzeug/Wache
-- und Datei-Anhaenge (Lageplaene).

CREATE TABLE IF NOT EXISTS station (
    id SERIAL PRIMARY KEY,
    wehr_id INTEGER NOT NULL REFERENCES wehr(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_station_wehr ON station(wehr_id);

CREATE TABLE IF NOT EXISTS vehicle (
    id SERIAL PRIMARY KEY,
    wehr_id INTEGER NOT NULL REFERENCES wehr(id) ON DELETE CASCADE,
    station_id INTEGER REFERENCES station(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vehicle_wehr ON vehicle(wehr_id);

CREATE TABLE IF NOT EXISTS critical_object_task (
    id SERIAL PRIMARY KEY,
    critical_object_id INTEGER NOT NULL REFERENCES critical_object(id) ON DELETE CASCADE,
    vehicle_id INTEGER REFERENCES vehicle(id) ON DELETE CASCADE,
    station_id INTEGER REFERENCES station(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT critical_object_task_target CHECK (
        (vehicle_id IS NOT NULL AND station_id IS NULL) OR
        (vehicle_id IS NULL AND station_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_object_task_object ON critical_object_task(critical_object_id);
CREATE INDEX IF NOT EXISTS idx_object_task_vehicle ON critical_object_task(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_object_task_station ON critical_object_task(station_id);

CREATE TABLE IF NOT EXISTS critical_object_attachment (
    id SERIAL PRIMARY KEY,
    critical_object_id INTEGER NOT NULL REFERENCES critical_object(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    uploaded_by INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_object_attachment_object ON critical_object_attachment(critical_object_id);
