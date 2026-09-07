-- Ueberpruefungs-Turnus je kritischem Objekt: faellig = COALESCE(last_reviewed_at, created_at) +
-- review_interval_months. NULL-Intervall heisst "kein Turnus definiert".

ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS review_interval_months INTEGER
  CHECK (review_interval_months IS NULL OR review_interval_months > 0);
ALTER TABLE critical_object ADD COLUMN IF NOT EXISTS last_reviewed_at TIMESTAMPTZ;
