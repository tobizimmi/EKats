// PDF-Vorlagen-Editor (Konzept Teil 3, Migration 010). Admin-only: normale Nutzer bekommen die
// gerenderten PDFs weiterhin ueber die bestehenden Export-Routen in routes/objects.js, die diese
// Vorlagen automatisch nutzen, wenn eine existiert (sonst Fallback auf den bisherigen pdfkit-Code
// bei 'task_sheet' bzw. HTTP 404 bei 'object_datasheet', das komplett neu ist).
const express = require('express');
const { z } = require('zod');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../audit');
const { renderHtmlToPdf } = require('../pdf/renderHtml');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const DOCUMENT_TYPES = ['task_sheet', 'object_datasheet'];

// Beispieldaten fuer die Live-Vorschau im Editor - dieselbe Feldstruktur wie die echten
// Export-Routen in objects.js liefern (siehe dortige buildTaskSheetData()/buildObjectDatasheetData()).
const SAMPLE_DATA = {
  task_sheet: {
    objekt: { name: 'Grundschule Musterstadt', adresse: 'Schulstraße 5, 12345 Musterstadt' },
    ziel: { typ: 'Fahrzeug', name: 'LF 20/1' },
    aufgaben: [
      { nr: 1, titel: 'Riegelstellung Nordseite', beschreibung: 'Zugang ueber Haupttor, Schluessel im Depot' },
      { nr: 2, titel: 'Rettungswege sichern', beschreibung: '' },
    ],
    erstellt: new Date().toLocaleString('de-DE'),
  },
  object_datasheet: {
    objekt: {
      name: 'Grundschule Musterstadt',
      adresse: 'Schulstraße 5, 12345 Musterstadt',
      strasse: 'Schulstraße',
      hausnummer: '5',
      plz: '12345',
      ort: 'Musterstadt',
      ortsteil: 'Mitte',
      kategorie: 'Schule/Kita',
      hazards: 'Chemikalienlager im Keller (Reinigungsmittel)',
      accessInfo: 'Schluesseldepot am Haupteingang',
      specialFeatures: 'Sprinkleranlage, Aufzug',
      contactName: 'Max Mustermann (Hausmeister)',
      contactPhone: '0123 456789',
      contactEmail: 'hausmeister@musterschule.de',
      emergencyPhone: '0800 000000',
      hasOfficialPlan: 'ja',
      hasFwPlan: 'nein',
      planDate: '01.03.2024',
      planCreator: 'Musterstadt',
      floors: '3 (EG + 2 OG)',
      area: 'ca. 2.500 qm',
      fireWaterSupplyType: 'Hydrant (Unterflur)',
      fireWaterSupplyCapacityLpm: 800,
      fireWaterSupplyLocation: 'Einfahrt Nord',
      fireAlarmSystem: 'ja',
      fireAlarmMonitoringStation: 'Leitstelle Musterkreis',
      occupantCountMax: 250,
      elevators: 'nein',
      smokeHeatExhaustSystem: 'ja',
      pvBatterySystem: 'ja',
      pvBatteryDisconnectLocation: 'Technikraum EG',
      assemblyPoint: 'Sportplatz',
      builtYear: 1998,
    },
    erstellt: new Date().toLocaleString('de-DE'),
  },
};

function assertKnownType(type, res) {
  if (!DOCUMENT_TYPES.includes(type)) {
    res.status(400).json({ ok: false, error: `Unbekannter Dokumenttyp: ${type}` });
    return false;
  }
  return true;
}

router.get('/:documentType', async (req, res, next) => {
  try {
    if (!assertKnownType(req.params.documentType, res)) return;
    const { rows } = await query(
      'SELECT html_template, updated_at FROM pdf_template WHERE wehr_id = $1 AND document_type = $2',
      [req.user.wehrId, req.params.documentType]
    );
    return res.json({ ok: true, data: rows[0] || null });
  } catch (err) {
    return next(err);
  }
});

const templateSchema = z.object({ htmlTemplate: z.string().min(1).max(200000) });

router.put('/:documentType', async (req, res, next) => {
  try {
    if (!assertKnownType(req.params.documentType, res)) return;
    const parsed = templateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }

    const { rows } = await query(
      `INSERT INTO pdf_template (wehr_id, document_type, html_template, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (wehr_id, document_type) DO UPDATE SET
         html_template = EXCLUDED.html_template, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING html_template, updated_at`,
      [req.user.wehrId, req.params.documentType, parsed.data.htmlTemplate, req.user.id]
    );

    await logAudit({
      wehrId: req.user.wehrId,
      actorUserId: req.user.id,
      actorEmail: req.user.email,
      action: 'pdf_template.save',
      targetType: 'pdf_template',
      targetId: req.params.documentType,
      details: {},
      ip: req.ip,
    });
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:documentType', async (req, res, next) => {
  try {
    if (!assertKnownType(req.params.documentType, res)) return;
    await query('DELETE FROM pdf_template WHERE wehr_id = $1 AND document_type = $2', [
      req.user.wehrId,
      req.params.documentType,
    ]);
    await logAudit({
      wehrId: req.user.wehrId,
      actorUserId: req.user.id,
      actorEmail: req.user.email,
      action: 'pdf_template.delete',
      targetType: 'pdf_template',
      targetId: req.params.documentType,
      details: {},
      ip: req.ip,
    });
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

// Rendert die im Request-Body mitgeschickte (ggf. noch ungespeicherte) Vorlage mit Beispieldaten -
// fuer die Live-Vorschau waehrend des Bearbeitens im Admin-Editor, bevor gespeichert wird.
router.post('/:documentType/preview', async (req, res, next) => {
  try {
    if (!assertKnownType(req.params.documentType, res)) return;
    const parsed = templateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }

    const pdf = await renderHtmlToPdf(parsed.data.htmlTemplate, SAMPLE_DATA[req.params.documentType]);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="vorschau.pdf"');
    return res.send(pdf);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
