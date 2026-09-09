-- Pegel-Liniendiagramm-Widget (Konzept Teil 2, Baustein D): live_datapoint speichert je Station nur
-- den jeweils aktuellsten Wert (UNIQUE(source, external_id), siehe schema.sql) - fuer einen
-- Zeitreihen-Chart wird eine anhaengende Historie gebraucht. Bewusst nicht fuer jede Quelle
-- mitgeschrieben (siehe HISTORY_SOURCES in fetchers/normalize.js), sondern nur fuer Quellen mit
-- einem sinnvollen Zeitreihen-Chart (aktuell: pegelonline) - ein Unwetterereignis oder ein
-- FIRMS-Hotspot hat keinen "Verlauf" im selben Sinn. Retention identisch zu live_datapoint
-- (DATA_RETENTION_DAYS, siehe scheduler.js cleanupOldDatapoints) - keine zweite Aufbewahrungsregel.
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
