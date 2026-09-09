-- Objektverwaltung: Felder ergaenzt, die im vom Nutzer bereitgestellten, urspruenglichen lokalen
-- Feuerwehr-Objektverwaltungstool vorhanden waren, in EKats aber fehlten (siehe README
-- "Objektverwaltung" fuer den Feld-Abgleich). "address" bleibt als freie Anzeige-/Fallback-Zeile
-- erhalten (wird von Liste/Suche/PDF-Vorlage weiter genutzt) - die neuen Felder ergaenzen sie um
-- eine strukturierte Variante, die das Formular jetzt primaer verwendet.

ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS street TEXT;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS house_number TEXT;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS postal_code TEXT;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS district TEXT;

ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS emergency_phone TEXT;

-- Planstatus: getrennt vom review_interval_months/last_reviewed_at-Ueberpruefungs-Turnus (Migration
-- 004) - dort geht es um WANN ein Objekt zuletzt begangen wurde, hier um OB und WANN ein offizieller
-- bzw. eigener Feuerwehrplan fuer das Objekt existiert.
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS has_official_plan BOOLEAN;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS has_fw_plan BOOLEAN;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS plan_date DATE;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS plan_creator TEXT;

-- floors/area bewusst TEXT statt Zahl: in der Praxis oft mit Zusatzangabe erfasst
-- ("3 (EG + 2 OG)", "ca. 2.500 qm") statt als reine Zahl.
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS floors TEXT;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS area TEXT;
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS special_features TEXT;
