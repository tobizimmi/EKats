const express = require('express');
const bcrypt = require('bcrypt');
const { z } = require('zod');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

async function countAdmins(wehrId) {
  const { rows } = await query(
    "SELECT count(*)::int AS n FROM app_user WHERE wehr_id = $1 AND role = 'admin'",
    [wehrId]
  );
  return rows[0].n;
}

// Nur Rolle "admin" sieht/verwaltet die Mitgliederliste der eigenen Wehr (Admin-Bereich).
router.get('/', requireRole('admin'), async (req, res, next) => {
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
  role: z.enum(['admin', 'stab', 'mitglied']),
});

router.post('/', requireRole('admin'), async (req, res, next) => {
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

const updateRoleSchema = z.object({ role: z.enum(['admin', 'stab', 'mitglied']) });

// Rolle eines bestehenden Nutzers aendern. Schutz gegen Aussperren: die letzte "admin"-Rolle
// einer Wehr kann sich nicht selbst degradieren (sonst haette niemand mehr Zugriff auf den
// Admin-Bereich, um das rueckgaengig zu machen).
router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const parsed = updateRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const { role } = parsed.data;
    const targetId = Number(req.params.id);

    if (targetId === req.user.id && role !== 'admin' && (await countAdmins(req.user.wehrId)) <= 1) {
      return res.status(409).json({
        ok: false,
        error: 'Du bist der letzte Admin dieser Wehr - degradiere zuerst einen weiteren Account zu Admin.',
      });
    }

    const { rows } = await query(
      `UPDATE app_user SET role = $1 WHERE id = $2 AND wehr_id = $3
       RETURNING id, email, role, created_at`,
      [role, targetId, req.user.wehrId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Nutzer nicht gefunden.' });
    }
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

// DSGVO: jeder Nutzer kann sein eigenes Konto vollstaendig loeschen (kaskadiert auf
// push_subscription/alert_rule/alert_log ueber ON DELETE CASCADE) - ausser als letzter Admin
// der Wehr, sonst haette niemand mehr Zugriff auf den Admin-Bereich.
router.delete('/me', async (req, res, next) => {
  try {
    if (req.user.role === 'admin' && (await countAdmins(req.user.wehrId)) <= 1) {
      return res.status(409).json({
        ok: false,
        error: 'Du bist der letzte Admin dieser Wehr - ernenne zuerst einen weiteren Account zum Admin.',
      });
    }
    await query('DELETE FROM app_user WHERE id = $1', [req.user.id]);
    res.json({ ok: true, data: null });
  } catch (err) {
    next(err);
  }
});

// "admin" kann Mitgliedskonten der eigenen Wehr loeschen (z.B. beim Austritt aus der Wehr).
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const targetId = Number(req.params.id);
    if (targetId === req.user.id && (await countAdmins(req.user.wehrId)) <= 1) {
      return res.status(409).json({
        ok: false,
        error: 'Du bist der letzte Admin dieser Wehr - ernenne zuerst einen weiteren Account zum Admin.',
      });
    }

    const { rowCount } = await query('DELETE FROM app_user WHERE id = $1 AND wehr_id = $2', [
      targetId,
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
