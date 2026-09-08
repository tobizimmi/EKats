-- PDF-Vorlagen-Editor (Konzept Teil 3, "Offene Entscheidungen" Punkt 2: Chromium-Rendering
-- akzeptiert). Templates je Wehr + Dokumenttyp; 'task_sheet' ersetzt/ergaenzt den bestehenden
-- pdfkit-Aufgabenzettel (routes/objects.js renderTasksPdf), 'object_datasheet' ist neu: ein
-- druckbares Objekt-Datenblatt mit allen Standard-/Zusatzfeldern (siehe Migration 008) - ohne
-- Vorlage faellt der Export weiterhin auf den bestehenden pdfkit-Code zurueck (task_sheet) bzw.
-- ist ohne Vorlage nicht verfuegbar (object_datasheet, komplett neu).
CREATE TABLE IF NOT EXISTS pdf_template (
    id SERIAL PRIMARY KEY,
    wehr_id INTEGER NOT NULL REFERENCES wehr(id) ON DELETE CASCADE,
    document_type TEXT NOT NULL CHECK (document_type IN ('task_sheet', 'object_datasheet')),
    html_template TEXT NOT NULL,
    updated_by INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(wehr_id, document_type)
);
