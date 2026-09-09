-- Health-Dashboard je Datenquelle im Admin-Bereich (Nutzerwunsch): bisher war der einzige Weg zu
-- sehen, ob ein Fetcher zuverlaessig laeuft, das Server-Log (console.log/console.error in
-- scheduler.js) - kein Admin-UI. Eine Zeile je Quelle, per UPSERT nach jedem Lauf aktualisiert
-- (siehe backend/src/fetcherHealth.js), statt eines vollen Log-Verlaufs - fuer "laeuft es gerade
-- zuverlaessig" reicht der letzte Erfolg/Fehler, eine wachsende Log-Tabelle waere hier unnoetig.
CREATE TABLE IF NOT EXISTS fetcher_health (
    source_key TEXT PRIMARY KEY,
    last_run_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_duration_ms INTEGER,
    last_written_count INTEGER,
    last_error_at TIMESTAMPTZ,
    last_error_message TEXT
);
