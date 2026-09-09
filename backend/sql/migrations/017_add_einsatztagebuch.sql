-- Einsatztagebuch (Nutzerwunsch, groesste inhaltliche Luecke laut Produkt-Review: EKats buendelt
-- externe Lage-Informationen sehr gut, bot aber keine Moeglichkeit, waehrend eines Einsatzes selbst
-- etwas zu protokollieren). Bewusst EIN durchlaufendes, chronologisches Logbuch je Wehr statt eines
-- Konzepts mit eigenen "Einsatz"-Datensaetzen (Beginn/Ende, Zuordnung) - das waere ein deutlich
-- groesserer Baustein (Lebenszyklus, Zustaendigkeit je Einsatz); ein Eintrag "Einsatz X begonnen" traegt
-- sich als normaler Tagebucheintrag genauso ein. entry_time ist bewusst vom Nutzer setzbar (Default
-- jetzt) und getrennt von created_at: ein Eintrag wird oft erst nachtraeglich getippt, soll aber den
-- tatsaechlichen Ereigniszeitpunkt zeigen.
CREATE TABLE IF NOT EXISTS einsatztagebuch_eintrag (
    id SERIAL PRIMARY KEY,
    wehr_id INTEGER NOT NULL REFERENCES wehr(id) ON DELETE CASCADE,
    entry_time TIMESTAMPTZ NOT NULL DEFAULT now(),
    category TEXT CHECK (category IS NULL OR category IN ('meldung', 'massnahme', 'lage', 'sonstiges')),
    message TEXT NOT NULL,
    created_by INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
    created_by_email TEXT, -- Schnappschuss zum Anzeigezeitpunkt der Erstellung, ueberlebt Nutzerloeschung
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_einsatztagebuch_wehr_time ON einsatztagebuch_eintrag(wehr_id, entry_time DESC);
