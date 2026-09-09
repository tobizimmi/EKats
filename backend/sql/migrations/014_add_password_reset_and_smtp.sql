-- Feature-Paritaet mit dem Schwesterprojekt FKatInfo (siehe README): Passwort-vergessen-
-- Selbstbedienung per E-Mail-Link, damit ein ausgesperrter Nutzer nicht zwingend einen Admin
-- braucht (bisher nur PATCH /api/users/me/password mit bekanntem aktuellem Passwort oder
-- Admin-Reset, siehe routes/users.js). Der Token wird NIE im Klartext gespeichert (nur
-- SHA-256-Hash), ist einmalig verwendbar (used_at) und laeuft nach kurzer Zeit ab - siehe
-- routes/auth.js fuer die anonymisierte Antwort (kein User-Enumeration-Oracle).
CREATE TABLE IF NOT EXISTS password_reset_token (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_token_user ON password_reset_token(user_id);

-- SMTP-Konfiguration je Wehr im Admin-Bereich statt ausschliesslich ueber .env (Feature-Paritaet
-- mit FKatInfo admin/settings.php). Passwort AES-256-GCM-verschluesselt (utils/crypto.js,
-- Schluessel aus JWT_SECRET abgeleitet) statt im Klartext. NULL-Felder fallen weiterhin auf die
-- .env-Werte zurueck (siehe mailer.js) - Deployments, die .env bereits nutzen, sind unveraendert
-- funktionsfaehig.
ALTER TABLE wehr ADD COLUMN IF NOT EXISTS smtp_host TEXT;
ALTER TABLE wehr ADD COLUMN IF NOT EXISTS smtp_port INTEGER;
ALTER TABLE wehr ADD COLUMN IF NOT EXISTS smtp_user TEXT;
ALTER TABLE wehr ADD COLUMN IF NOT EXISTS smtp_pass_encrypted TEXT;
ALTER TABLE wehr ADD COLUMN IF NOT EXISTS smtp_from TEXT;
