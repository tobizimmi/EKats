const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Liste aller 402 Kreise/kreisfreien Staedte fuer die Zustaendigkeitsgebiet-Auswahl im
// Admin-Bereich (siehe routes/wehr.js) - ohne Geometrie, die braucht nur die Nachbar-Berechnung
// serverseitig. Alle Rollen duerfen lesen (rein informativ, keine Schreibrechte hier).
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT ags, name, district_type, state FROM landkreis ORDER BY name');
    return res.json({ ok: true, data: rows });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
