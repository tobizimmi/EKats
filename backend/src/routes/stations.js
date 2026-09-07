const express = require('express');
const { z } = require('zod');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Stammdaten: alle Rollen duerfen Wachen sehen (z.B. um sie bei Aufgaben zuzuordnen), nur "admin"
// darf sie anlegen/aendern/loeschen.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id, name, address, created_at FROM station WHERE wehr_id = $1 ORDER BY name',
      [req.user.wehrId]
    );
    return res.json({ ok: true, data: rows });
  } catch (err) {
    return next(err);
  }
});

const stationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().max(300).nullable().optional(),
});

router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const parsed = stationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const { name, address } = parsed.data;
    const { rows } = await query(
      'INSERT INTO station (wehr_id, name, address) VALUES ($1, $2, $3) RETURNING id, name, address, created_at',
      [req.user.wehrId, name, address || null]
    );
    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const parsed = stationSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const { name, address } = parsed.data;
    const setClauses = [];
    const params = [];
    if (name !== undefined) {
      params.push(name);
      setClauses.push(`name = $${params.length}`);
    }
    if (address !== undefined) {
      params.push(address || null);
      setClauses.push(`address = $${params.length}`);
    }
    if (setClauses.length === 0) {
      return res.status(400).json({ ok: false, error: 'Keine Aenderungen angegeben.' });
    }
    params.push(req.params.id, req.user.wehrId);
    const { rows } = await query(
      `UPDATE station SET ${setClauses.join(', ')} WHERE id = $${params.length - 1} AND wehr_id = $${params.length}
       RETURNING id, name, address, created_at`,
      params
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Wache nicht gefunden.' });
    }
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { rowCount } = await query('DELETE FROM station WHERE id = $1 AND wehr_id = $2', [
      req.params.id,
      req.user.wehrId,
    ]);
    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Wache nicht gefunden.' });
    }
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
