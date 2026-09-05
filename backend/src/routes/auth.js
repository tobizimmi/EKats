const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { query } = require('../db');
const { signToken, setAuthCookie, clearAuthCookie, requireAuth } = require('../middleware/auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Zu viele Login-Versuche. Bitte spaeter erneut versuchen.' },
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'E-Mail und Passwort erforderlich.' });
    }
    const { email, password } = parsed.data;

    const { rows } = await query(
      `SELECT u.id, u.email, u.password_hash, u.role, u.wehr_id, w.name AS wehr_name
       FROM app_user u JOIN wehr w ON w.id = u.wehr_id
       WHERE u.email = $1`,
      [email]
    );
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ ok: false, error: 'E-Mail oder Passwort falsch.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ ok: false, error: 'E-Mail oder Passwort falsch.' });
    }

    const token = signToken(user);
    setAuthCookie(res, token);

    return res.json({
      ok: true,
      data: {
        id: user.id,
        email: user.email,
        role: user.role,
        wehrId: user.wehr_id,
        wehrName: user.wehr_name,
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true, data: null });
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.email, u.role, u.wehr_id, w.name AS wehr_name, w.center_lat, w.center_lon
       FROM app_user u JOIN wehr w ON w.id = u.wehr_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    const user = rows[0];
    if (!user) {
      return res.status(404).json({ ok: false, error: 'Nutzer nicht gefunden.' });
    }
    return res.json({
      ok: true,
      data: {
        id: user.id,
        email: user.email,
        role: user.role,
        wehrId: user.wehr_id,
        wehrName: user.wehr_name,
        wehrCenter:
          user.center_lat !== null && user.center_lon !== null
            ? { lat: user.center_lat, lon: user.center_lon }
            : null,
      },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
