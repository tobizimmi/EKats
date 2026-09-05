const express = require('express');
const bcrypt = require('bcrypt');
const { z } = require('zod');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// Nur Rolle "stab" sieht/verwaltet die Mitgliederliste der eigenen Wehr.
router.get('/', requireRole('stab'), async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id, email, role, created_at FROM app_user WHERE wehr_id = $1 ORDER BY created_at',
      [req.user.wehrId]
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Passwort muss mindestens 8 Zeichen haben.'),
  role: z.enum(['stab', 'mitglied']),
});

router.post('/', requireRole('stab'), async (req, res, next) => {
  try {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const { email, password, role } = parsed.data;
    const passwordHash = await bcrypt.hash(password, 12);

    const { rows } = await query(
      `INSERT INTO app_user (wehr_id, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, role, created_at`,
      [req.user.wehrId, email, passwordHash, role]
    );
    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ ok: false, error: 'E-Mail ist bereits vergeben.' });
    }
    return next(err);
  }
});

// DSGVO: jeder Nutzer kann sein eigenes Konto vollstaendig loeschen (kaskadiert auf
// push_subscription/alert_rule/alert_log ueber ON DELETE CASCADE).
router.delete('/me', async (req, res, next) => {
  try {
    await query('DELETE FROM app_user WHERE id = $1', [req.user.id]);
    res.json({ ok: true, data: null });
  } catch (err) {
    next(err);
  }
});

// "stab" kann Mitgliedskonten der eigenen Wehr loeschen (z.B. beim Austritt aus der Wehr).
router.delete('/:id', requireRole('stab'), async (req, res, next) => {
  try {
    const { rowCount } = await query('DELETE FROM app_user WHERE id = $1 AND wehr_id = $2', [
      req.params.id,
      req.user.wehrId,
    ]);
    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Nutzer nicht gefunden.' });
    }
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
