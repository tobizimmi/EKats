-- Fuehrt die dritte Rollenstufe "admin" ein (Admin-Bereich: Nutzerverwaltung, Wehr-Einstellungen).
-- Vorher gab es nur 'stab' (voller Zugriff) und 'mitglied' (nur Lesen) - 'stab' deckte implizit
-- auch die Nutzerverwaltung mit ab. Bestehende 'stab'-Accounts werden daher einmalig zu 'admin'
-- hochgestuft, damit z.B. der bereits produktiv angelegte erste Account seinen Funktionsumfang
-- (inkl. Nutzerverwaltung) nicht verliert. 'stab' existiert danach als mittlere Stufe weiter
-- (Schwellenwerte konfigurieren, aber keine Nutzerverwaltung) fuer neu angelegte Accounts.

ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_role_check;
ALTER TABLE app_user ADD CONSTRAINT app_user_role_check CHECK (role IN ('admin', 'stab', 'mitglied'));

UPDATE app_user SET role = 'admin' WHERE role = 'stab';
