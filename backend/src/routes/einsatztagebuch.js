// Einsatztagebuch (Migration 017, siehe Kommentar dort): chronologisches Logbuch je Wehr. Lesen fuer
// alle Rollen (auch 'mitglied', wie bei objects.js/vehicles.js), Schreiben/Aendern/Loeschen nur
// stab/admin - dasselbe Muster wie bei critical_object.
const express = require('express');
const { z } = require('zod');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const CATEGORIES = ['meldung', 'massnahme', 'lage', 'sonstiges'];

const SELECT_COLUMNS = `
  id, wehr_id, entry_time, category, message, created_by, created_by_email, created_at, updated_at
`;

// GET /?since=&until=&limit= - neueste zuerst. since/until filtern auf entry_time (der fachliche
// Zeitpunkt, nicht created_at), damit ein nachtraeglich getippter Eintrag trotzdem am richtigen Tag
// erscheint.
router.get('/', async (req, res, next) => {
  try {
    const conditions = ['wehr_id = $1'];
    const params = [req.user.wehrId];

    if (req.query.since) {
      params.push(req.query.since);
      conditions.push(`entry_time >= $${params.length}`);
    }
    if (req.query.until) {
      params.push(req.query.until);
      conditions.push(`entry_time <= $${params.length}`);
    }
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 200, 1), 500);

    const { rows } = await query(
      `SELECT ${SELECT_COLUMNS} FROM einsatztagebuch_eintrag WHERE ${conditions.join(' AND ')}
       ORDER BY entry_time DESC, id DESC LIMIT ${limit}`,
      params
    );
    return res.json({ ok: true, data: rows });
  } catch (err) {
    return next(err);
  }
});

const entrySchema = z.object({
  entryTime: z.string().datetime({ offset: true }).optional(),
  category: z.enum(CATEGORIES).nullable().optional(),
  message: z.string().trim().min(1).max(4000),
});

router.post('/', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const parsed = entrySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const d = parsed.data;

    const { rows } = await query(
      `INSERT INTO einsatztagebuch_eintrag (wehr_id, entry_time, category, message, created_by, created_by_email)
       VALUES ($1, COALESCE($2::timestamptz, now()), $3, $4, $5, $6)
       RETURNING ${SELECT_COLUMNS}`,
      [req.user.wehrId, d.entryTime ?? null, d.category ?? null, d.message, req.user.id, req.user.email]
    );
    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

const updateSchema = entrySchema.partial();

router.patch('/:id', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const d = parsed.data;
    const setClauses = [];
    const params = [];

    if (d.entryTime !== undefined) {
      params.push(d.entryTime);
      setClauses.push(`entry_time = $${params.length}`);
    }
    if (d.category !== undefined) {
      params.push(d.category);
      setClauses.push(`category = $${params.length}`);
    }
    if (d.message !== undefined) {
      params.push(d.message);
      setClauses.push(`message = $${params.length}`);
    }
    if (setClauses.length === 0) {
      return res.status(400).json({ ok: false, error: 'Keine Aenderungen angegeben.' });
    }
    setClauses.push('updated_at = now()');

    params.push(req.params.id, req.user.wehrId);
    const { rows } = await query(
      `UPDATE einsatztagebuch_eintrag SET ${setClauses.join(', ')}
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
    const { rowCount } = await query('DELETE FROM einsatztagebuch_eintrag WHERE id = $1 AND wehr_id = $2', [
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
