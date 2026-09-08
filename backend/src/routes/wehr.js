const express = require('express');
const { z } = require('zod');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Nachbarlandkreise werden nicht gespeichert, sondern per ST_Touches() aus den Grenzpolygonen
// berechnet (siehe Migration 006) - bleibt dadurch automatisch korrekt.
async function loadNeighborLandkreise(homeAgs) {
  if (!homeAgs) return [];
  const { rows } = await query(
    `SELECT n.ags, n.name, n.state
     FROM landkreis h, landkreis n
     WHERE h.ags = $1 AND n.ags != h.ags AND ST_Touches(h.geom, n.geom)
     ORDER BY n.name`,
    [homeAgs]
  );
  return rows;
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT w.id, w.name, w.center_lat, w.center_lon, w.home_landkreis_ags, l.name AS home_landkreis_name
       FROM wehr w LEFT JOIN landkreis l ON l.ags = w.home_landkreis_ags
       WHERE w.id = $1`,
      [req.user.wehrId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Wehr nicht gefunden.' });
    }
    const wehr = rows[0];
    const neighborLandkreise = await loadNeighborLandkreise(wehr.home_landkreis_ags);
    return res.json({ ok: true, data: { ...wehr, neighborLandkreise } });
  } catch (err) {
    return next(err);
  }
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  centerLat: z.number().min(-90).max(90).nullable().optional(),
  centerLon: z.number().min(-180).max(180).nullable().optional(),
  homeLandkreisAgs: z
    .string()
    .regex(/^\d{5}$/, 'Ungueltiger AGS (5 Ziffern erwartet).')
    .nullable()
    .optional(),
});

router.patch('/', requireRole('admin'), async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const { name, centerLat, centerLon, homeLandkreisAgs } = parsed.data;
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
    if (homeLandkreisAgs !== undefined) {
      if (homeLandkreisAgs !== null) {
        const { rows: exists } = await query('SELECT 1 FROM landkreis WHERE ags = $1', [homeLandkreisAgs]);
        if (exists.length === 0) {
          return res.status(400).json({ ok: false, error: 'Unbekannter Landkreis (AGS).' });
        }
      }
      params.push(homeLandkreisAgs);
      setClauses.push(`home_landkreis_ags = $${params.length}`);
    }
    if (setClauses.length === 0) {
      return res.status(400).json({ ok: false, error: 'Keine Aenderungen angegeben.' });
    }

    params.push(req.user.wehrId);
    await query(`UPDATE wehr SET ${setClauses.join(', ')} WHERE id = $${params.length}`, params);

    const { rows } = await query(
      `SELECT w.id, w.name, w.center_lat, w.center_lon, w.home_landkreis_ags, l.name AS home_landkreis_name
       FROM wehr w LEFT JOIN landkreis l ON l.ags = w.home_landkreis_ags
       WHERE w.id = $1`,
      [req.user.wehrId]
    );
    const neighborLandkreise = await loadNeighborLandkreise(rows[0].home_landkreis_ags);
    return res.json({ ok: true, data: { ...rows[0], neighborLandkreise } });
  } catch (err) {
    return next(err);
  }
});

// Grenzumriss von Heimat-Landkreis + Nachbarn als GeoJSON, fuer die Darstellung als Referenz-Layer
// auf der Dashboard-Karte (siehe frontend/public/js/map.js). Enthaelt bewusst nur die Geometrie +
// minimale Beschriftung, keine Nachbar-Berechnung noetig - die Liste kommt aus loadNeighborLandkreise.
router.get('/gebiet-geojson', async (req, res, next) => {
  try {
    const { rows: wehrRows } = await query('SELECT home_landkreis_ags FROM wehr WHERE id = $1', [
      req.user.wehrId,
    ]);
    const homeAgs = wehrRows[0]?.home_landkreis_ags;
    if (!homeAgs) {
      return res.json({ ok: true, data: { type: 'FeatureCollection', features: [] } });
    }

    const { rows } = await query(
      `SELECT ags, name, (ags = $1) AS is_home, ST_AsGeoJSON(geom)::json AS geometry
       FROM landkreis
       WHERE ags = $1 OR ags IN (
         SELECT n.ags FROM landkreis h, landkreis n
         WHERE h.ags = $1 AND n.ags != h.ags AND ST_Touches(h.geom, n.geom)
       )`,
      [homeAgs]
    );

    const features = rows.map((row) => ({
      type: 'Feature',
      geometry: row.geometry,
      properties: { ags: row.ags, name: row.name, isHome: row.is_home },
    }));
    return res.json({ ok: true, data: { type: 'FeatureCollection', features } });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
