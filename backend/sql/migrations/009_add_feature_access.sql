-- Feature-Zugriffssteuerung ("Offene Entscheidungen" Punkt 1): kostenpflichtige/optionale Quellen
-- (zunaechst Kachelmann) sollen vom Admin sowohl rollenweit als auch je Einzelnutzer freigeschaltet
-- werden koennen. "Nutzergruppen" = die bestehenden drei Rollen (admin/stab/mitglied) - EKats hat
-- kein eigenes Gruppen-Subsystem und soll dafuer keins bekommen, das waere fuer eine V1 mit einer
-- Wehr unnoetige Komplexitaet (vgl. Kommentar in wehr-Tabelle).
--
-- Zugriffslogik (siehe backend/src/utils/featureAccess.js): ein Nutzer hat Zugriff auf ein Feature,
-- wenn entweder seine Rolle freigeschaltet ist (wehr_feature_role_access) ODER er individuell
-- freigeschaltet ist (user_feature_access mit enabled=true) - UND es keinen individuellen
-- Sperr-Override gibt (enabled=false schlaegt eine Rollenfreigabe). Enabled=false ist damit ein
-- "trotz Rolle sperren"-Override, enabled=true ein "obwohl Rolle nicht freigeschaltet, trotzdem
-- erlauben"-Override.
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
