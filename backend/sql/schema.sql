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
    -- SMTP-Konfiguration im Admin-Bereich statt nur .env (Migration 014). smtp_pass_encrypted ist
    -- AES-256-GCM-verschluesselt (utils/crypto.js) - siehe dort. NULL-Felder fallen auf .env zurueck.
    smtp_host TEXT,
    smtp_port INTEGER,
    smtp_user TEXT,
    smtp_pass_encrypted TEXT,
    smtp_from TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Landkreise mit amtlichem Gemeindeschluessel (AGS) + Grenzpolygon. Nachbarlandkreise werden NICHT
-- gespeichert, sondern per ST_Touches() aus den Polygonen berechnet (siehe routes/wehr.js).
-- Befuellung: node src/importLandkreise.js (einmalig, laedt die Daten live, siehe dort).
CREATE TABLE IF NOT EXISTS landkreis (
    ags CHAR(5) PRIMARY KEY,
    name TEXT NOT NULL,
    district_type TEXT,
    state TEXT,
    kfz TEXT,
    geom GEOMETRY(MultiPolygon, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_landkreis_geom ON landkreis USING GIST(geom);

-- Bundesland-Flaechen fuer die Kartendarstellung von DWD-Unwetterwarnungen (nur Bundesland-Ebene
-- verfuegbar). Materialisiert (aus landkreis aggregiert) statt live berechnet - siehe Migration 007.
CREATE TABLE IF NOT EXISTS bundesland (
    code CHAR(2) PRIMARY KEY,
    name TEXT NOT NULL,
    geom GEOMETRY(MultiPolygon, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bundesland_geom ON bundesland USING GIST(geom);

ALTER TABLE wehr ADD COLUMN IF NOT EXISTS home_landkreis_ags CHAR(5) REFERENCES landkreis(ags);

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
    -- token_version: bei Passwortaenderung/-reset hochgezaehlt, macht alle zuvor ausgestellten
    -- JWTs sofort ungueltig (siehe backend/src/middleware/auth.js).
    token_version INTEGER NOT NULL DEFAULT 0,
    -- Login-Lockout zusaetzlich zum IP-basierten Rate-Limit (siehe routes/auth.js).
    failed_login_count INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit-Log fuer sicherheitsrelevante Aktionen (DSGVO-Rechenschaftspflicht + Vorfall-Forensik).
CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    wehr_id INTEGER REFERENCES wehr(id) ON DELETE CASCADE,
    actor_user_id INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
    actor_email TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_wehr ON audit_log(wehr_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);

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

-- Objektverwaltung: kritische Objekte (Schulen, Pflegeeinrichtungen, Gefahrstoffbetriebe, ...),
-- die Wehrfuehrung/Stab direkt auf der Karte anlegen/pflegen koennen. Ergaenzt um Aufgaben je
-- Fahrzeug/Wache und Datei-Anhaenge (Lageplaene) - siehe vehicle/station/critical_object_task/
-- critical_object_attachment weiter unten.
CREATE TABLE IF NOT EXISTS critical_object (
    id SERIAL PRIMARY KEY,
    wehr_id INTEGER NOT NULL REFERENCES wehr(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'sonstiges' CHECK (
        category IN ('schule_kita', 'krankenhaus_pflege', 'industrie_gefahrstoff', 'versammlungsstaette', 'sonstiges')
    ),
    address TEXT,
    geom GEOMETRY(POINT, 4326) NOT NULL,
    hazards TEXT,        -- Besondere Gefahren (Freitext, z.B. "Gasflaschenlager im Keller")
    access_info TEXT,    -- Zufahrt/Schluesseldepot-Hinweise
    contact_name TEXT,
    contact_phone TEXT,
    notes TEXT,
    -- Ueberpruefungs-Turnus: faellig = COALESCE(last_reviewed_at, created_at) + review_interval_months.
    -- review_interval_months = NULL heisst "kein Turnus definiert" (keine Faelligkeit in der Liste).
    review_interval_months INTEGER CHECK (review_interval_months IS NULL OR review_interval_months > 0),
    last_reviewed_at TIMESTAMPTZ,
    created_by INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_critical_object_wehr ON critical_object(wehr_id);
CREATE INDEX IF NOT EXISTS idx_critical_object_geom ON critical_object USING GIST(geom);

-- Wachen (Geraetehaeuser/Stationen) einer Wehr - Stammdaten, von "admin" gepflegt.
CREATE TABLE IF NOT EXISTS station (
    id SERIAL PRIMARY KEY,
    wehr_id INTEGER NOT NULL REFERENCES wehr(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_station_wehr ON station(wehr_id);

-- Fahrzeuge einer Wehr, optional einer Wache zugeordnet - Stammdaten, von "admin" gepflegt.
CREATE TABLE IF NOT EXISTS vehicle (
    id SERIAL PRIMARY KEY,
    wehr_id INTEGER NOT NULL REFERENCES wehr(id) ON DELETE CASCADE,
    station_id INTEGER REFERENCES station(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vehicle_wehr ON vehicle(wehr_id);

-- Aufgaben/Anweisungen je kritischem Objekt, jeweils einem Fahrzeug ODER einer Wache zugeordnet
-- (Einsatzplan-Baustein: "Fahrzeug X macht bei Einsatz an Objekt Y konkret Z"). Als PDF je
-- Fahrzeug/Wache exportierbar, siehe routes/objects.js.
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

-- Datei-Anhaenge je kritischem Objekt (Lageplaene/Grundrisse als Bild oder PDF). Die Datei selbst
-- liegt ausserhalb von frontend/public auf der Platte (backend/storage/objects/, siehe config.js);
-- storage_key ist der Dateiname dort. Ausgeliefert wird sie ausschliesslich ueber einen
-- authentifizierten Download-Endpunkt, nie als statische Datei.
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

-- Objektverwaltung 2.0 (Migration 008): recherchierte DIN-14095-Standardfelder + freie
-- Zusatzfelder je Wehr. Siehe Migration 008 fuer die Recherchequellen im Kommentar.
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS fire_water_supply_type TEXT CHECK (
    fire_water_supply_type IS NULL OR fire_water_supply_type IN (
        'hydrant_unterflur', 'hydrant_ueberflur', 'loeschwasserbrunnen',
        'zisterne', 'loeschteich', 'offenes_gewaesser', 'keine_angabe'
    )
);
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS fire_water_supply_capacity_lpm INTEGER CHECK (
    fire_water_supply_capacity_lpm IS NULL OR fire_water_supply_capacity_lpm >= 0
);
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS fire_water_supply_location TEXT;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS fire_alarm_system BOOLEAN;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS fire_alarm_monitoring_station TEXT;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS occupant_count_max INTEGER CHECK (
    occupant_count_max IS NULL OR occupant_count_max >= 0
);
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS elevators BOOLEAN;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS smoke_heat_exhaust_system BOOLEAN;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS pv_battery_system BOOLEAN;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS pv_battery_disconnect_location TEXT;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS assembly_point TEXT;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS built_year INTEGER CHECK (
    built_year IS NULL OR (built_year >= 1000 AND built_year <= 2100)
);
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Migration 015: Adresse strukturiert, Kontakt-Email/Notfalltelefon, Planstatus, Gebaeudedaten.
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS street TEXT;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS house_number TEXT;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS postal_code TEXT;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS district TEXT;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS emergency_phone TEXT;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS has_official_plan BOOLEAN;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS has_fw_plan BOOLEAN;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS plan_date DATE;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS plan_creator TEXT;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS floors TEXT;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS area TEXT;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS special_features TEXT;

CREATE TABLE IF NOT EXISTS object_field_definition (
    id SERIAL PRIMARY KEY,
    wehr_id INTEGER NOT NULL REFERENCES wehr(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    field_type TEXT NOT NULL DEFAULT 'text' CHECK (
        field_type IN ('text', 'textarea', 'number', 'boolean', 'date', 'select')
    ),
    options JSONB,
    required BOOLEAN NOT NULL DEFAULT false,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(wehr_id, key)
);

CREATE INDEX IF NOT EXISTS idx_object_field_definition_wehr ON object_field_definition(wehr_id);

-- Feature-Zugriffssteuerung (Migration 009): optionale/kostenpflichtige Quellen (Kachelmann) je
-- Rolle und je Einzelnutzer freischaltbar. Siehe Migration 009 fuer die Zugriffslogik im Kommentar.
CREATE TABLE IF NOT EXISTS wehr_feature_role_access (
    id SERIAL PRIMARY KEY,
    wehr_id INTEGER NOT NULL REFERENCES wehr(id) ON DELETE CASCADE,
    feature_key TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'stab', 'mitglied')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(wehr_id, feature_key, role)
);

CREATE TABLE IF NOT EXISTS user_feature_access (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    feature_key TEXT NOT NULL,
    enabled BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, feature_key)
);

CREATE INDEX IF NOT EXISTS idx_user_feature_access_user ON user_feature_access(user_id);

-- PDF-Vorlagen-Editor (Migration 010): siehe Migration 010 fuer Details im Kommentar.
CREATE TABLE IF NOT EXISTS pdf_template (
    id SERIAL PRIMARY KEY,
    wehr_id INTEGER NOT NULL REFERENCES wehr(id) ON DELETE CASCADE,
    document_type TEXT NOT NULL CHECK (document_type IN ('task_sheet', 'object_datasheet')),
    html_template TEXT NOT NULL,
    updated_by INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(wehr_id, document_type)
);

-- Selbst verwaltbare Nutzer-Einstellungen (Migration 011): Spalten-Sichtbarkeit je Themenseite,
-- spaeter das persoenliche Dashboard-Layout. Siehe Migration 011 fuer Details im Kommentar.
CREATE TABLE IF NOT EXISTS user_preference (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    pref_key TEXT NOT NULL,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, pref_key)
);

-- Kartenskizzen direkt am Objekt (Migration 012): siehe Migration 012 fuer Details im Kommentar.
CREATE TABLE IF NOT EXISTS critical_object_map_sketch (
    critical_object_id INTEGER PRIMARY KEY REFERENCES critical_object(id) ON DELETE CASCADE,
    geojson JSONB NOT NULL DEFAULT '{"type":"FeatureCollection","features":[]}'::jsonb,
    updated_by INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pegel-Liniendiagramm-Widget (Migration 013): siehe Migration 013 fuer Details im Kommentar.
CREATE TABLE IF NOT EXISTS datapoint_history (
    id BIGSERIAL PRIMARY KEY,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    value_numeric DOUBLE PRECISION,
    unit TEXT,
    item_timestamp TIMESTAMPTZ,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_datapoint_history_lookup
    ON datapoint_history(source, external_id, fetched_at);

-- Passwort-vergessen-Selbstbedienung (Migration 014): siehe Migration 014 fuer Details im Kommentar.
CREATE TABLE IF NOT EXISTS password_reset_token (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_token_user ON password_reset_token(user_id);
