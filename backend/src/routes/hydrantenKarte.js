// Wehr-weite Hydrantenkarte (Migration 021): dieselbe GeoJSON-Struktur wie die objektgebundene
// Kartenskizze (routes/objects.js :id/sketch), aber genau eine Zeile je Wehr statt je Objekt. Lesen
// fuer alle Rollen, Schreiben/Loeschen nur stab/admin (identisches Muster).
const express = require('express');
const { z } = require('zod');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const EMPTY_GEOJSON = { type: 'FeatureCollection', features: [] };

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT geojson, updated_at FROM wehr_hydranten_karte WHERE wehr_id = $1',
      [req.user.wehrId]
    );
    return res.json({
      ok: true,
      data: rows.length > 0 ? rows[0] : { geojson: EMPTY_GEOJSON, updated_at: null },
    });
  } catch (err) {
    return next(err);
  }
});

// Grosszuegig, aber begrenzt (500 KB) - eine wehrweite Karte kann deutlich mehr Punkte enthalten als
// eine einzelne Objektskizze, daher grosszuegiger als dort (300 KB).
const geojsonSchema = z.object({
  geojson: z
    .object({ type: z.literal('FeatureCollection'), features: z.array(z.any()) })
    .refine((g) => JSON.stringify(g).length <= 500_000, 'Kartenskizze zu groß (max. 500 KB).'),
});

router.put('/', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const parsed = geojsonSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }

    const { rows } = await query(
      `INSERT INTO wehr_hydranten_karte (wehr_id, geojson, updated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (wehr_id) DO UPDATE SET
         geojson = EXCLUDED.geojson, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING geojson, updated_at`,
      [req.user.wehrId, parsed.data.geojson, req.user.id]
    );
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.delete('/', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    await query('DELETE FROM wehr_hydranten_karte WHERE wehr_id = $1', [req.user.wehrId]);
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
