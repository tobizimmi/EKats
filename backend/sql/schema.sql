-- Lage-/Fruehwarn-Dashboard: Datenbank-Schema V1
-- Benoetigt PostGIS Extension

CREATE EXTENSION IF NOT EXISTS postgis;

-- Wehren/Mandanten (V1: meist nur eine Zeile, aber von Anfang an vorbereitet)
CREATE TABLE IF NOT EXISTS wehr (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    bounding_box GEOMETRY(POLYGON, 4326), -- eigenes Zustaendigkeitsgebiet
    center_lat DOUBLE PRECISION,          -- Kartenmittelpunkt beim ersten Laden (Vereinfachung V1)
    center_lon DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Benutzer, drei Rollenstufen:
--   'admin'    - voller Zugriff + Nutzerverwaltung/Wehr-Einstellungen (Admin-Bereich)
--   'stab'     - voller Lage-Zugriff + Schwellenwerte konfigurieren, aber keine Nutzerverwaltung
--   'mitglied' - nur Lesezugriff auf Karte/Liste
CREATE TABLE IF NOT EXISTS app_user (
    id SERIAL PRIMARY KEY,
    wehr_id INTEGER NOT NULL REFERENCES wehr(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'stab', 'mitglied')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Web-Push Subscriptions (fuer Benachrichtigungen)
CREATE TABLE IF NOT EXISTS push_subscription (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(endpoint)
);

-- Live-Datenpunkte: rollierend, alte Werte werden per Job geloescht (siehe cleanup in scheduler.js)
CREATE TABLE IF NOT EXISTS live_datapoint (
    id BIGSERIAL PRIMARY KEY,
    source TEXT NOT NULL,          -- 'dwd_unwetter' | 'pegelonline' | 'hochwasserzentralen' | 'firms' | 'waldbrandindex'
    external_id TEXT NOT NULL,     -- z.B. Pegelname, Warnzellen-ID, Hotspot-Hash
    title TEXT,
    geom GEOMETRY(POINT, 4326),
    value_numeric DOUBLE PRECISION,
    unit TEXT,
    severity TEXT,                 -- Quelle-spezifische Stufe (Text, siehe fetchers/normalize.js)
    item_timestamp TIMESTAMPTZ,    -- Zeitstempel des Rohdatums (z.B. Warnungsbeginn, Messzeitpunkt)
    payload JSONB NOT NULL DEFAULT '{}'::jsonb, -- Rohdaten/normalisierte Zusatzfelder je nach Quelle
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_until TIMESTAMPTZ,       -- z.B. Gueltigkeit einer DWD-Warnung
    UNIQUE(source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_live_datapoint_source ON live_datapoint(source);
CREATE INDEX IF NOT EXISTS idx_live_datapoint_geom ON live_datapoint USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_live_datapoint_fetched_at ON live_datapoint(fetched_at);

-- Lookup-Tabelle DWD-Stationen (liefert lat/lon/Bundesland fuer den Waldbrandgefahrenindex-Feed,
-- der selbst keine Koordinaten mitliefert). Befuellt/aktualisiert durch
-- src/fetchers/dwdStationsImport.js.
CREATE TABLE IF NOT EXISTS dwd_station (
    station_id TEXT PRIMARY KEY,
    station_name TEXT NOT NULL,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    bundesland_code TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Schwellenwert-Konfiguration pro Nutzer fuer Benachrichtigungen
CREATE TABLE IF NOT EXISTS alert_rule (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    source TEXT NOT NULL,          -- welche Datenquelle
    target_ref TEXT,               -- z.B. konkreter Pegelname; NULL = alle im Gebiet
    threshold_key TEXT NOT NULL,   -- z.B. 'meldestufe', 'warnstufe', 'radius_km'
    threshold_value TEXT NOT NULL,
    channel_push BOOLEAN NOT NULL DEFAULT true,
    channel_email BOOLEAN NOT NULL DEFAULT false,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_rule_user ON alert_rule(user_id);
CREATE INDEX IF NOT EXISTS idx_alert_rule_source_active ON alert_rule(source) WHERE active;

-- Protokoll ausgeloester Benachrichtigungen (verhindert Spam durch wiederholtes Ausloesen)
CREATE TABLE IF NOT EXISTS alert_log (
    id BIGSERIAL PRIMARY KEY,
    alert_rule_id INTEGER NOT NULL REFERENCES alert_rule(id) ON DELETE CASCADE,
    live_datapoint_id BIGINT REFERENCES live_datapoint(id) ON DELETE SET NULL,
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    channel TEXT NOT NULL,         -- 'push' | 'email'
    UNIQUE(alert_rule_id, live_datapoint_id, channel)
);
