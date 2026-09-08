-- Objektverwaltung 2.0 (Konzept Teil 2, "Offene Entscheidungen" Punkt 3): recherchierte
-- DIN-14095-Standardfelder ("Allgemeine Objektinformationen" eines Feuerwehrplans fuer bauliche
-- Anlagen) statt der vier ungeprueft vorgeschlagenen Felder aus dem Konzeptpapier, plus freie
-- Zusatzfelder je Wehr (object_field_definition + critical_object.custom_fields).
--
-- Recherchequellen (WebSearch, direkte PDF-Abrufe der Kommunal-Musterdokumente waren aus dieser
-- Entwicklungsumgebung nicht erreichbar - siehe README Verifikationsstand): DGWZ/Feuertrutz-
-- Uebersichtsartikel zu DIN 14095, Suchtreffer-Auszuege aus kommunalen Feuerwehrplan-Vorlagen
-- (Monheim, Potsdam-Mittelmark, u.a.), Fachartikel zu Loeschwasserversorgung (Ergiebigkeit je
-- Quellentyp) und zu PV-/Batteriespeicheranlagen in Feuerwehrplaenen (zunehmend sicherheitsrelevant,
-- eigener Passus in aktuellen Feuerwehrplan-Merkblaettern).
--
-- Baujahr ist NICHT DIN-14095-Kernbestandteil (in den Recherchetreffern nicht explizit als
-- Pflichtfeld genannt), aber gaengige Praxis bei Objektbegehungen und daher als Feld belassen.

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

-- Freie Zusatzfelder je Wehr, admin-verwaltet (Konzept Teil 2). Loeschen einer Definition entfernt
-- das Feld nur aus kuenftigen Formularen - historische Werte in critical_object.custom_fields
-- bleiben unangetastet (kein ON DELETE CASCADE-Bereinigungsjob noetig/gewollt).
CREATE TABLE IF NOT EXISTS object_field_definition (
    id SERIAL PRIMARY KEY,
    wehr_id INTEGER NOT NULL REFERENCES wehr(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    field_type TEXT NOT NULL DEFAULT 'text' CHECK (
        field_type IN ('text', 'textarea', 'number', 'boolean', 'date', 'select')
    ),
    options JSONB, -- nur bei field_type = 'select': Array von {value, label}
    required BOOLEAN NOT NULL DEFAULT false,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(wehr_id, key)
);

CREATE INDEX IF NOT EXISTS idx_object_field_definition_wehr ON object_field_definition(wehr_id);
