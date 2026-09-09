-- Optionales TOTP-Zweitfaktor (2FA) fuer stab/admin-Konten (Nutzerwunsch). Bewusst opt-in je Nutzer,
-- nicht erzwungen - vermeidet, sich selbst (oder den Seed-Admin-Account) versehentlich auszusperren.
-- Nur fuer die Rollen stab/admin anbietbar (siehe Frontend settings.html), 'mitglied' hat ohnehin nur
-- Lesezugriff. totp_secret_encrypted ist AES-256-GCM-verschluesselt (backend/src/utils/crypto.js,
-- derselbe Mechanismus wie das SMTP-Passwort) - im Klartext nach der Einrichtung nie wieder
-- ausgelesen/angezeigt, nur zur Code-Pruefung serverseitig entschluesselt.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS totp_secret_encrypted TEXT;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
