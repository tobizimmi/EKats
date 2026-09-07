-- Sicherheits-Haertung: Session-Revocation, Login-Lockout, Audit-Log.

-- token_version: wird bei Passwortaenderung/-reset hochgezaehlt und im JWT mitgefuehrt (siehe
-- middleware/auth.js). So werden alle zuvor ausgestellten Tokens sofort ungueltig, sobald das
-- Passwort geaendert wird - vorher blieb ein gestohlenes Token bis zu 12h gueltig, auch nach
-- Passwortwechsel (JWT ist zustandslos).
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- Login-Lockout: zusaetzlich zum bestehenden IP-basierten Rate-Limit (siehe routes/auth.js) auch
-- pro Konto sperren, damit ein verteilter/langsamer Angriff auf ein einzelnes Konto nicht durch
-- das IP-Limit alleine abgefangen werden muss.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- Audit-Log fuer sicherheitsrelevante Aktionen (DSGVO-Rechenschaftspflicht + Vorfall-Forensik).
-- actor_user_id ist SET NULL (nicht CASCADE), damit ein Log-Eintrag nach Loeschung des handelnden
-- Kontos erhalten bleibt - actor_email haelt dafuer einen Schnappschuss der E-Mail zum
-- Handlungszeitpunkt.
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
