const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Alle 16 Bundesland-Flaechen als GeoJSON FeatureCollection - fuer die Kartendarstellung von
// DWD-Unwetterwarnungen (die nur Bundesland-Ebene liefern, siehe js/bundesland.js im Frontend).
// Kleine, stabile Antwort (16 Features) - vom Frontend einmalig pro Sitzung geladen und gecacht.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT code, name, ST_AsGeoJSON(geom)::json AS geometry FROM bundesland ORDER BY code'
    );
    const features = rows.map((row) => ({
      type: 'Feature',
      geometry: row.geometry,
      properties: { code: row.code, name: row.name },
    }));
    return res.json({ ok: true, data: { type: 'FeatureCollection', features } });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
