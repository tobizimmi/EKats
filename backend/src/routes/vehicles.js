const express = require('express');
const { z } = require('zod');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT v.id, v.name, v.station_id, s.name AS station_name, v.created_at
       FROM vehicle v LEFT JOIN station s ON s.id = v.station_id
       WHERE v.wehr_id = $1 ORDER BY v.name`,
      [req.user.wehrId]
    );
    return res.json({ ok: true, data: rows });
  } catch (err) {
    return next(err);
  }
});

const vehicleSchema = z.object({
  name: z.string().trim().min(1).max(200),
  stationId: z.number().int().nullable().optional(),
});

// Prueft, dass eine angegebene Wache existiert UND der eigenen Wehr gehoert - ohne diese Prüfung
// würde eine falsche ID entweder in einem rohen FK-Fehler (500) enden oder, schlimmer, klaglos ein
// Fahrzeug mit der Wache einer fremden Wehr verknüpfen.
async function assertOwnedStation(stationId, wehrId) {
  if (!stationId) return true;
  const { rows } = await query('SELECT id FROM station WHERE id = $1 AND wehr_id = $2', [stationId, wehrId]);
  return rows.length > 0;
}

router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const parsed = vehicleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const { name, stationId } = parsed.data;
    if (!(await assertOwnedStation(stationId, req.user.wehrId))) {
      return res.status(400).json({ ok: false, error: 'Wache nicht gefunden.' });
    }
    const { rows } = await query(
      `INSERT INTO vehicle (wehr_id, station_id, name) VALUES ($1, $2, $3)
       RETURNING id, name, station_id, created_at`,
      [req.user.wehrId, stationId || null, name]
    );
    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const parsed = vehicleSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const { name, stationId } = parsed.data;
    if (stationId !== undefined && !(await assertOwnedStation(stationId, req.user.wehrId))) {
      return res.status(400).json({ ok: false, error: 'Wache nicht gefunden.' });
    }
    const setClauses = [];
    const params = [];
    if (name !== undefined) {
      params.push(name);
      setClauses.push(`name = $${params.length}`);
    }
    if (stationId !== undefined) {
      params.push(stationId || null);
      setClauses.push(`station_id = $${params.length}`);
    }
    if (setClauses.length === 0) {
      return res.status(400).json({ ok: false, error: 'Keine Aenderungen angegeben.' });
    }
    params.push(req.params.id, req.user.wehrId);
    const { rows } = await query(
      `UPDATE vehicle SET ${setClauses.join(', ')} WHERE id = $${params.length - 1} AND wehr_id = $${params.length}
       RETURNING id, name, station_id, created_at`,
      params
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Fahrzeug nicht gefunden.' });
    }
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { rowCount } = await query('DELETE FROM vehicle WHERE id = $1 AND wehr_id = $2', [
      req.params.id,
      req.user.wehrId,
    ]);
    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Fahrzeug nicht gefunden.' });
    }
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
