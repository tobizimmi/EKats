// Health-Dashboard je Datenquelle im Admin-Bereich (Migration 016, siehe backend/src/fetcherHealth.js
// fuer die Schreibseite). Rein lesend, admin-only - dieselbe Sichtbarkeitsschwelle wie das Audit-Log.
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT source_key, last_run_at, last_success_at, last_duration_ms, last_written_count,
              last_error_at, last_error_message
       FROM fetcher_health ORDER BY source_key`
    );
    return res.json({ ok: true, data: rows });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
