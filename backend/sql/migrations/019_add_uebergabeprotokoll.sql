-- Uebergabeprotokoll (Produkt-Review "Spaeter"-Paket): strukturierte Schichtuebergabe - anders als
-- das chronologische Einsatztagebuch (Migration 017) ein Arbeitsstand mit genau zwei Zustaenden je
-- Eintrag ("offen"/"erledigt"), damit eine uebernehmende Schicht auf einen Blick sieht, was noch
-- aussteht. Bewusst EIN durchlaufender Bestand je Wehr statt eigener "Schicht"-Datensaetze (Beginn/
-- Ende) - dieselbe Modellentscheidung wie beim Einsatztagebuch: ein Eintrag "Uebergabe an B-Dienst"
-- traegt sich als normaler Eintrag ein, ein voller Schicht-Lebenszyklus waere ein deutlich groesserer
-- Baustein ohne klaren Zusatznutzen fuer eine einzelne Wehr.
CREATE TABLE IF NOT EXISTS uebergabe_eintrag (
    id SERIAL PRIMARY KEY,
    wehr_id INTEGER NOT NULL REFERENCES wehr(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'offen' CHECK (status IN ('offen', 'erledigt')),
    created_by INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
    created_by_email TEXT, -- Schnappschuss, ueberlebt Nutzerloeschung (gleiches Muster wie Tagebuch)
    resolved_by INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
    resolved_by_email TEXT,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_uebergabe_wehr_status ON uebergabe_eintrag(wehr_id, status, created_at DESC);
