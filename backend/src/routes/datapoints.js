const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const VALID_SOURCES = [
  'dwd_unwetter',
  'pegelonline',
  'hochwasserzentralen',
  'firms',
  'waldbrandindex',
];

// GET /api/datapoints?source=pegelonline&since=2026-01-01T00:00:00Z
// Liefert den aktuellen Stand je Quelle fuer Karte + Uebersichtsliste. Kein bbox-Filter in V1
// (eine Wehr hat ein ueberschaubares Gebiet, siehe Plan) - das Frontend filtert client-seitig
// zusaetzlich, falls gewuenscht.
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

    return res.json({ ok: true, data: rows });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
