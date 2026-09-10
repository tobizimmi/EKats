// Uebergabeprotokoll (Migration 019): strukturierte Schichtuebergabe mit Status 'offen'/'erledigt' je
// Eintrag - anders als das rein chronologische Einsatztagebuch (routes/einsatztagebuch.js, dasselbe
// Grundmuster). Lesen fuer alle Rollen, Anlegen/Aendern/Status-Umschalten/Loeschen nur stab/admin.
const express = require('express');
const { z } = require('zod');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const SELECT_COLUMNS = `
  id, wehr_id, message, status, created_by, created_by_email,
  resolved_by, resolved_by_email, resolved_at, created_at, updated_at
`;

// GET /?status=offen - ohne Filter alle Eintraege, offene zuerst (fuer die eigentliche Uebergabe
// relevant), innerhalb einer Statusgruppe neueste zuerst.
router.get('/', async (req, res, next) => {
  try {
    const conditions = ['wehr_id = $1'];
    const params = [req.user.wehrId];

    if (req.query.status) {
      if (!['offen', 'erledigt'].includes(req.query.status)) {
        return res.status(400).json({ ok: false, error: 'Ungueltiger Status-Filter.' });
      }
      params.push(req.query.status);
      conditions.push(`status = $${params.length}`);
    }

    const { rows } = await query(
      `SELECT ${SELECT_COLUMNS} FROM uebergabe_eintrag WHERE ${conditions.join(' AND ')}
       ORDER BY (status = 'offen') DESC, created_at DESC LIMIT 500`,
      params
    );
    return res.json({ ok: true, data: rows });
  } catch (err) {
    return next(err);
  }
});

const entrySchema = z.object({
  message: z.string().trim().min(1).max(4000),
});

router.post('/', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const parsed = entrySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }

    const { rows } = await query(
      `INSERT INTO uebergabe_eintrag (wehr_id, message, created_by, created_by_email)
       VALUES ($1, $2, $3, $4)
       RETURNING ${SELECT_COLUMNS}`,
      [req.user.wehrId, parsed.data.message, req.user.id, req.user.email]
    );
    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

const updateSchema = z.object({
  message: z.string().trim().min(1).max(4000).optional(),
  status: z.enum(['offen', 'erledigt']).optional(),
});

// PATCH deckt sowohl "Text bearbeiten" als auch "Status umschalten" ab - dieselbe Route, damit das
// Frontend nicht zwei verschiedene Endpunkte fuer dieselbe Zeile ansprechen muss. Ein Wechsel auf
// 'erledigt' setzt resolved_at/resolved_by automatisch; ein Zurueckwechseln auf 'offen' (Uebergabe
// war doch noch nicht vollstaendig) loescht diese Felder wieder, statt einen veralteten Stand stehen
// zu lassen.
router.patch('/:id', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const d = parsed.data;
    const setClauses = [];
    const params = [];

    if (d.message !== undefined) {
      params.push(d.message);
      setClauses.push(`message = $${params.length}`);
    }
    if (d.status !== undefined) {
      params.push(d.status);
      setClauses.push(`status = $${params.length}`);
      if (d.status === 'erledigt') {
        params.push(req.user.id, req.user.email);
        setClauses.push(`resolved_by = $${params.length - 1}`, `resolved_by_email = $${params.length}`, `resolved_at = now()`);
      } else {
        setClauses.push('resolved_by = NULL', 'resolved_by_email = NULL', 'resolved_at = NULL');
      }
    }
    if (setClauses.length === 0) {
      return res.status(400).json({ ok: false, error: 'Keine Aenderungen angegeben.' });
    }
    setClauses.push('updated_at = now()');

    params.push(req.params.id, req.user.wehrId);
    const { rows } = await query(
      `UPDATE uebergabe_eintrag SET ${setClauses.join(', ')}
       WHERE id = $${params.length - 1} AND wehr_id = $${params.length}
       RETURNING ${SELECT_COLUMNS}`,
      params
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Eintrag nicht gefunden.' });
    }
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const { rowCount } = await query('DELETE FROM uebergabe_eintrag WHERE id = $1 AND wehr_id = $2', [
      req.params.id,
      req.user.wehrId,
    ]);
    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Eintrag nicht gefunden.' });
    }
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
