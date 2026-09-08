const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { loadZustaendigkeitsgebiet } = require('../utils/zustaendigkeit');
const { buildGebietCondition } = require('../utils/gebietFilter');

const router = express.Router();

const VALID_SOURCES = [
  'dwd_unwetter',
  'pegelonline',
  'hochwasserzentralen',
  'firms',
  'waldbrandindex',
];

// GET /api/datapoints?source=pegelonline&since=2026-01-01T00:00:00Z
// Liefert den aktuellen Stand je Quelle fuer Karte + Uebersichtsliste, gefiltert auf das
// Zustaendigkeitsgebiet der Wehr (Heimat-Landkreis + Nachbarlandkreise, siehe
// utils/zustaendigkeit.js): Quellen mit Geokoordinate (pegelonline/hochwasserzentralen/firms)
// muessen innerhalb der Gebiets-Polygone liegen, die beiden Bundesland-Quellen
// (dwd_unwetter/waldbrandindex) muessen eines der im Gebiet vertretenen Bundeslaender treffen.
// Ist noch kein Heimat-Landkreis konfiguriert, kann keine Gebietsgrenze bestimmt werden - dann
// bewusst wie bisher ungefiltert (bundesweit) anzeigen, statt versehentlich alles auszublenden.
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { source, since } = req.query;
    if (source && !VALID_SOURCES.includes(source)) {
      return res.status(400).json({ ok: false, error: `Unbekannte Quelle "${source}".` });
    }

    const conditions = [];
    const params = [];

    if (source) {
      params.push(source);
      conditions.push(`source = $${params.length}`);
    }
    if (since) {
      params.push(since);
      conditions.push(`fetched_at >= $${params.length}`);
    }
    // Nur nicht abgelaufene Warnungen bzw. Werte ohne Gueltigkeitsende anzeigen.
    conditions.push('(valid_until IS NULL OR valid_until >= now())');

    const gebiet = await loadZustaendigkeitsgebiet(req.user.wehrId);
    const gebietCondition = buildGebietCondition(gebiet, params);
    if (gebietCondition) {
      conditions.push(gebietCondition);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await query(
      `SELECT id, source, external_id, title, value_numeric, unit, severity,
              item_timestamp, fetched_at, valid_until, payload,
              ST_Y(geom) AS lat, ST_X(geom) AS lon
       FROM live_datapoint
       ${where}
       ORDER BY fetched_at DESC
       LIMIT 2000`,
      params
    );

    return res.json({ ok: true, data: rows, meta: { gebietGefiltert: gebiet !== null } });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
