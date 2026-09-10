-- Checklisten/SOPs (Produkt-Review "Spaeter"-Paket): hinterlegbare Standard-Einsatz-Regeln je
-- Objekttyp oder Szenario, abhakbar. Bewusst ZWEI schlanke Tabellen (Vorlage + Punkte mit direktem
-- Abhak-Status) statt eines vollen "Einsatz-Lauf"-Konzepts mit eigener Instanz je Benutzung
-- (Migration 021 aehnlich einfach wie Einsatztagebuch/Uebergabeprotokoll gehalten) - eine Checkliste
-- ist damit ein gemeinsam sichtbarer, gemeinsam abhakbarer Arbeitsstand je Wehr, kein Journal
-- vergangener Durchlaeufe. "Zuruecksetzen" (siehe routes/checklists.js) setzt alle Haken einer
-- Vorlage wieder auf false, fuer den naechsten Einsatz/die naechste Uebung.
CREATE TABLE IF NOT EXISTS checklist_template (
    id SERIAL PRIMARY KEY,
    wehr_id INTEGER NOT NULL REFERENCES wehr(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT, -- freier Objekttyp-/Szenario-Bezeichner, z.B. "Gefahrgut", "Schule" - kein Enum,
                    -- da Wehren eigene Szenario-Namen nutzen (gleiche Freiheit wie bei Objekt-Kategorien)
    created_by INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS checklist_item (
    id SERIAL PRIMARY KEY,
    template_id INTEGER NOT NULL REFERENCES checklist_template(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    checked BOOLEAN NOT NULL DEFAULT false,
    checked_by INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
    checked_by_email TEXT,
    checked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_checklist_template_wehr ON checklist_template(wehr_id);
CREATE INDEX IF NOT EXISTS idx_checklist_item_template ON checklist_item(template_id, position);
