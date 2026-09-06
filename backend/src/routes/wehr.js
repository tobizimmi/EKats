const express = require('express');
const { z } = require('zod');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, name, center_lat, center_lon FROM wehr WHERE id = $1', [
      req.user.wehrId,
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Wehr nicht gefunden.' });
    }
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  centerLat: z.number().min(-90).max(90).nullable().optional(),
  centerLon: z.number().min(-180).max(180).nullable().optional(),
});

router.patch('/', requireRole('admin'), async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const { name, centerLat, centerLon } = parsed.data;
    const setClauses = [];
    const params = [];

    if (name !== undefined) {
      params.push(name);
      setClauses.push(`name = $${params.length}`);
    }
    if (centerLat !== undefined) {
      params.push(centerLat);
      setClauses.push(`center_lat = $${params.length}`);
    }
    if (centerLon !== undefined) {
      params.push(centerLon);
      setClauses.push(`center_lon = $${params.length}`);
    }
    if (setClauses.length === 0) {
      return res.status(400).json({ ok: false, error: 'Keine Aenderungen angegeben.' });
    }

    params.push(req.user.wehrId);
    const { rows } = await query(
      `UPDATE wehr SET ${setClauses.join(', ')} WHERE id = $${params.length}
       RETURNING id, name, center_lat, center_lon`,
      params
    );
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
