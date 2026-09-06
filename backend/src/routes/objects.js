const express = require('express');
const { z } = require('zod');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const CATEGORIES = ['schule_kita', 'krankenhaus_pflege', 'industrie_gefahrstoff', 'versammlungsstaette', 'sonstiges'];

const SELECT_COLUMNS = `
  id, name, category, address, hazards, access_info, contact_name, contact_phone, notes,
  created_by, created_at, updated_at, ST_Y(geom) AS lat, ST_X(geom) AS lon
`;

// Alle Rollen (auch "mitglied") duerfen kritische Objekte der eigenen Wehr sehen - das Wissen
// darum ist im Einsatz fuer jeden relevant, nur das Anlegen/Aendern ist stab/admin vorbehalten.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ${SELECT_COLUMNS} FROM critical_object WHERE wehr_id = $1 ORDER BY name`,
      [req.user.wehrId]
    );
    return res.json({ ok: true, data: rows });
  } catch (err) {
    return next(err);
  }
});

const objectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.enum(CATEGORIES).optional().default('sonstiges'),
  address: z.string().trim().max(300).nullable().optional(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  hazards: z.string().trim().max(2000).nullable().optional(),
  accessInfo: z.string().trim().max(2000).nullable().optional(),
  contactName: z.string().trim().max(200).nullable().optional(),
  contactPhone: z.string().trim().max(50).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

router.post('/', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const parsed = objectSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const d = parsed.data;
    const { rows } = await query(
      `INSERT INTO critical_object
         (wehr_id, name, category, address, geom, hazards, access_info, contact_name, contact_phone, notes, created_by)
       VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326), $7, $8, $9, $10, $11, $12)
       RETURNING ${SELECT_COLUMNS}`,
      [
        req.user.wehrId,
        d.name,
        d.category,
        d.address || null,
        d.lon,
        d.lat,
        d.hazards || null,
        d.accessInfo || null,
        d.contactName || null,
        d.contactPhone || null,
        d.notes || null,
        req.user.id,
      ]
    );
    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

const updateSchema = objectSchema.partial();

router.patch('/:id', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const d = parsed.data;
    const setClauses = [];
    const params = [];

    const simpleColumns = {
      name: 'name',
      category: 'category',
      address: 'address',
      hazards: 'hazards',
      accessInfo: 'access_info',
      contactName: 'contact_name',
      contactPhone: 'contact_phone',
      notes: 'notes',
    };
    for (const [key, column] of Object.entries(simpleColumns)) {
      if (d[key] !== undefined) {
        params.push(d[key] || null);
        setClauses.push(`${column} = $${params.length}`);
      }
    }
    if (d.lat !== undefined && d.lon !== undefined) {
      params.push(d.lon, d.lat);
      setClauses.push(`geom = ST_SetSRID(ST_MakePoint($${params.length - 1}, $${params.length}), 4326)`);
    }
    if (setClauses.length === 0) {
      return res.status(400).json({ ok: false, error: 'Keine Aenderungen angegeben.' });
    }
    setClauses.push('updated_at = now()');

    params.push(req.params.id, req.user.wehrId);
    const { rows } = await query(
      `UPDATE critical_object SET ${setClauses.join(', ')}
       WHERE id = $${params.length - 1} AND wehr_id = $${params.length}
       RETURNING ${SELECT_COLUMNS}`,
      params
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Objekt nicht gefunden.' });
    }
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const { rowCount } = await query('DELETE FROM critical_object WHERE id = $1 AND wehr_id = $2', [
      req.params.id,
      req.user.wehrId,
    ]);
    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Objekt nicht gefunden.' });
    }
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
