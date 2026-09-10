// Einsatz-Verwaltung (Migration 022): Start/Ende eines konkreten Einsatzes (Stichwort/Adresse/
// Nummer), zu dem Lagemeldungen (einsatztagebuch_eintrag mit einsatz_id) gehoeren. Lesen fuer alle
// Rollen, Starten/Aendern/Beenden nur stab/admin (gleiches Muster wie Einsatztagebuch/
// Uebergabeprotokoll).
const express = require('express');
const { z } = require('zod');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { renderHtmlToPdf } = require('../pdf/renderHtml');

const router = express.Router();
router.use(requireAuth);

const SELECT_COLUMNS = `
  id, wehr_id, stichwort, adresse, nummer, status, started_at, ended_at,
  created_by, created_by_email, created_at, updated_at
`;

// GET /?status=laufend|beendet&search=... - "laufend" ist praktisch immer hoechstens eine Zeile
// (ein aktiver Einsatz je Wehr zur Zeit, technisch aber nicht erzwungen - mehrere Einsaetze
// parallel sind an groesseren Schadenslagen realistisch), "beendet" ist das durchsuchbare Archiv.
router.get('/', async (req, res, next) => {
  try {
    const conditions = ['wehr_id = $1'];
    const params = [req.user.wehrId];

    if (req.query.status) {
      if (!['laufend', 'beendet'].includes(req.query.status)) {
        return res.status(400).json({ ok: false, error: 'Ungueltiger Status-Filter.' });
      }
      params.push(req.query.status);
      conditions.push(`status = $${params.length}`);
    }
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      conditions.push(`(stichwort ILIKE $${params.length} OR nummer ILIKE $${params.length} OR adresse ILIKE $${params.length})`);
    }

    const { rows } = await query(
      `SELECT ${SELECT_COLUMNS} FROM einsatz WHERE ${conditions.join(' AND ')}
       ORDER BY started_at DESC LIMIT 500`,
      params
    );
    return res.json({ ok: true, data: rows });
  } catch (err) {
    return next(err);
  }
});

const startSchema = z.object({
  stichwort: z.string().trim().min(1).max(200),
  adresse: z.string().trim().max(300).nullable().optional(),
  nummer: z.string().trim().max(100).nullable().optional(),
});

router.post('/', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const d = parsed.data;
    const { rows } = await query(
      `INSERT INTO einsatz (wehr_id, stichwort, adresse, nummer, created_by, created_by_email)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${SELECT_COLUMNS}`,
      [req.user.wehrId, d.stichwort, d.adresse || null, d.nummer || null, req.user.id, req.user.email]
    );
    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

const updateSchema = z.object({
  stichwort: z.string().trim().min(1).max(200).optional(),
  adresse: z.string().trim().max(300).nullable().optional(),
  nummer: z.string().trim().max(100).nullable().optional(),
  status: z.enum(['laufend', 'beendet']).optional(),
});

// PATCH deckt Stammdaten-Korrektur UND Beenden/Wiedereroeffnen ab (status). Ein Wechsel auf
// 'beendet' setzt ended_at, ein Zurueckwechseln auf 'laufend' (Wiedereroeffnen, siehe Referenztool
// "wiederoeffneEinsatz") loescht ended_at wieder - derselbe Ansatz wie beim Uebergabeprotokoll-Status.
router.patch('/:id', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const d = parsed.data;
    const setClauses = [];
    const params = [];

    if (d.stichwort !== undefined) {
      params.push(d.stichwort);
      setClauses.push(`stichwort = $${params.length}`);
    }
    if (d.adresse !== undefined) {
      params.push(d.adresse || null);
      setClauses.push(`adresse = $${params.length}`);
    }
    if (d.nummer !== undefined) {
      params.push(d.nummer || null);
      setClauses.push(`nummer = $${params.length}`);
    }
    if (d.status !== undefined) {
      params.push(d.status);
      setClauses.push(`status = $${params.length}`);
      setClauses.push(d.status === 'beendet' ? 'ended_at = now()' : 'ended_at = NULL');
    }
    if (setClauses.length === 0) {
      return res.status(400).json({ ok: false, error: 'Keine Aenderungen angegeben.' });
    }
    setClauses.push('updated_at = now()');

    params.push(req.params.id, req.user.wehrId);
    const { rows } = await query(
      `UPDATE einsatz SET ${setClauses.join(', ')}
       WHERE id = $${params.length - 1} AND wehr_id = $${params.length}
       RETURNING ${SELECT_COLUMNS}`,
      params
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Einsatz nicht gefunden.' });
    }
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const { rowCount } = await query('DELETE FROM einsatz WHERE id = $1 AND wehr_id = $2', [
      req.params.id,
      req.user.wehrId,
    ]);
    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Einsatz nicht gefunden.' });
    }
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

// Eingebauter Standard-Report, falls die Wehr keine eigene 'einsatzbericht'-Vorlage hinterlegt hat
// (siehe pdf_template/routes/pdfTemplates.js) - anders als beim Objekt-Datenblatt bewusst MIT
// Fallback, damit der Export sofort nutzbar ist, ohne dass zuerst jemand eine HTML-Vorlage anlegen
// muss (der eigentliche Zweck dieses Features im Referenztool des Nutzers). Nutzt dieselbe
// {{platzhalter}}/{{#each}}-Renderer-Engine wie eine echte Vorlage - kein zweiter PDF-Pfad noetig.
const DEFAULT_EINSATZBERICHT_TEMPLATE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font-family: Arial, sans-serif; margin: 0; color: #1a1a1a; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .meta { font-size: 12px; color: #444; margin-bottom: 18px; }
  .meta div { margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { border: 1px solid #ccc; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; }
</style></head>
<body>
  <h1>Einsatzbericht</h1>
  <div class="meta">
    <div><strong>Stichwort:</strong> {{einsatz.stichwort}}</div>
    <div><strong>Adresse:</strong> {{einsatz.adresse}}</div>
    <div><strong>Einsatznummer:</strong> {{einsatz.nummer}}</div>
    <div><strong>Beginn:</strong> {{einsatz.started}}</div>
    <div><strong>Ende:</strong> {{einsatz.ended}}</div>
  </div>
  <table>
    <thead><tr><th>Datum</th><th>Uhrzeit</th><th>Von</th><th>An</th><th>Meldung</th></tr></thead>
    <tbody>
      {{#each lagemeldungen}}
      <tr><td>{{datum}}</td><td>{{uhrzeit}}</td><td>{{von}}</td><td>{{an}}</td><td>{{meldung}}</td></tr>
      {{/each}}
    </tbody>
  </table>
</body></html>`;

router.get('/:id/pdf', async (req, res, next) => {
  try {
    const { rows: einsatzRows } = await query(`SELECT ${SELECT_COLUMNS} FROM einsatz WHERE id = $1 AND wehr_id = $2`, [
      req.params.id,
      req.user.wehrId,
    ]);
    if (einsatzRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Einsatz nicht gefunden.' });
    }
    const einsatz = einsatzRows[0];

    const { rows: entries } = await query(
      `SELECT entry_time, von, an, message FROM einsatztagebuch_eintrag
       WHERE einsatz_id = $1 ORDER BY entry_time ASC, id ASC`,
      [req.params.id]
    );

    const { rows: templateRows } = await query(
      'SELECT html_template FROM pdf_template WHERE wehr_id = $1 AND document_type = $2',
      [req.user.wehrId, 'einsatzbericht']
    );
    const template = templateRows[0]?.html_template || DEFAULT_EINSATZBERICHT_TEMPLATE;

    const data = {
      einsatz: {
        stichwort: einsatz.stichwort,
        adresse: einsatz.adresse || '-',
        nummer: einsatz.nummer || '-',
        started: new Date(einsatz.started_at).toLocaleString('de-DE'),
        ended: einsatz.ended_at ? new Date(einsatz.ended_at).toLocaleString('de-DE') : '-',
      },
      lagemeldungen: entries.map((e) => ({
        datum: new Date(e.entry_time).toLocaleDateString('de-DE'),
        uhrzeit: new Date(e.entry_time).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
        von: e.von || '-',
        an: e.an || '-',
        meldung: e.message,
      })),
    };

    const pdf = await renderHtmlToPdf(template, data);
    const filenameSafe = `einsatzbericht-${(einsatz.nummer || einsatz.stichwort).replace(/[^a-z0-9]+/gi, '_')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameSafe}"`);
    return res.send(pdf);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
