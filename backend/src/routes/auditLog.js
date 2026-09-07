const express = require('express');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Nur "admin" sieht das Audit-Log der eigenen Wehr (sicherheits-/rechenschaftsrelevant, siehe
// backend/sql/migrations/005_add_security_hardening.sql).
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, actor_user_id, actor_email, action, target_type, target_id, details, ip_address, created_at
       FROM audit_log WHERE wehr_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [req.user.wehrId]
    );
    return res.json({ ok: true, data: rows });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
