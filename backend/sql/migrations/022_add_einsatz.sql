-- Einsatz-Konzept fuer das Einsatztagebuch (Nutzer-Feedback + mitgebrachtes Referenztool
-- "Lagemeldung2"): Migration 017 hatte sich bewusst GEGEN ein eigenes Einsatz-Konzept entschieden
-- ("ein durchlaufendes Logbuch je Wehr statt Einsatz-Datensaetze mit Beginn/Ende"). Das Referenztool
-- des Nutzers zeigt aber konkret, dass genau das im echten Arbeitsalltag gebraucht wird: eine
-- Lagemeldung gehoert zu einem konkreten Einsatz (Stichwort/Adresse/Nummer), nicht nur lose in ein
-- gemeinsames Logbuch. Diese Migration korrigiert die fruehere Entscheidung, statt sie zu wiederholen.
--
-- Bewusst ADDITIV statt als Ersatz: einsatztagebuch_eintrag bleibt bestehen (Rueckwaertskompatibilitaet
-- fuer bereits vorhandene freie Eintraege ohne Einsatzbezug), bekommt aber optionale einsatz_id/von/an
-- Spalten. Ein Eintrag OHNE einsatz_id bleibt ein freier Logbucheintrag wie bisher (z.B. fuer
-- Meldungen ausserhalb eines konkreten Einsatzes); ein Eintrag MIT einsatz_id + von/an ist eine
-- strukturierte Lagemeldung/Funkmeldung im Sinne des Referenztools.
CREATE TABLE IF NOT EXISTS einsatz (
    id SERIAL PRIMARY KEY,
    wehr_id INTEGER NOT NULL REFERENCES wehr(id) ON DELETE CASCADE,
    stichwort TEXT NOT NULL,
    adresse TEXT,
    nummer TEXT,
    status TEXT NOT NULL DEFAULT 'laufend' CHECK (status IN ('laufend', 'beendet')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    created_by INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
    created_by_email TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_einsatz_wehr_status ON einsatz(wehr_id, status, started_at DESC);

ALTER TABLE einsatztagebuch_eintrag ADD COLUMN IF NOT EXISTS einsatz_id INTEGER REFERENCES einsatz(id) ON DELETE SET NULL;
ALTER TABLE einsatztagebuch_eintrag ADD COLUMN IF NOT EXISTS von TEXT;
ALTER TABLE einsatztagebuch_eintrag ADD COLUMN IF NOT EXISTS an TEXT;

CREATE INDEX IF NOT EXISTS idx_einsatztagebuch_einsatz ON einsatztagebuch_eintrag(einsatz_id, entry_time);
