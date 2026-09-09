-- Selbst verwaltbare Nutzer-Einstellungen (Konzept Teil 2, Baustein D): Spalten-Sichtbarkeit je
-- Themenseite und spaeter das persoenliche Dashboard-Layout sollen geraeteuebergreifend gespeichert
-- werden (Nutzerwunsch: "für Testzwecke"), nicht nur lokal im Browser. Statt einer eigenen Tabelle
-- je Anwendungsfall ein generischer Key-Value-Speicher je Nutzer: pref_key ist ein freier String
-- (Konvention siehe Route), value haelt die eigentlichen Daten als JSON. "Zuruecksetzen" ist damit
-- schlicht das Loeschen der Zeile - die aufrufende Seite faellt dann auf ihre eingebauten Standards
-- zurueck, es muss serverseitig kein Default gepflegt werden.
CREATE TABLE IF NOT EXISTS user_preference (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    pref_key TEXT NOT NULL,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, pref_key)
);
