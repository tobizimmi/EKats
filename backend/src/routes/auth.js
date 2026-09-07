const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { query } = require('../db');
const { signToken, setAuthCookie, clearAuthCookie, requireAuth } = require('../middleware/auth');
const { logAudit } = require('../audit');

const router = express.Router();

// Zusaetzlich zum IP-basierten Rate-Limit unten (schuetzt vor einem einzelnen Angreifer) sperrt
// dieses Konto-Lockout ein einzelnes Konto voruebergehend, unabhaengig davon von wie vielen
// verschiedenen IPs die Fehlversuche kommen (z.B. verteilter Credential-Stuffing-Versuch).
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

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
      `SELECT u.id, u.email, u.password_hash, u.role, u.wehr_id, u.token_version,
              u.failed_login_count, u.locked_until, w.name AS wehr_name
       FROM app_user u JOIN wehr w ON w.id = u.wehr_id
       WHERE u.email = $1`,
      [email]
    );
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ ok: false, error: 'E-Mail oder Passwort falsch.' });
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({
        ok: false,
        error: 'Konto wegen zu vieler Fehlversuche vorübergehend gesperrt. Bitte in einigen Minuten erneut versuchen.',
      });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const failedCount = user.failed_login_count + 1;
      const lockingNow = failedCount >= LOCKOUT_THRESHOLD;
      await query(
        `UPDATE app_user SET failed_login_count = $1, locked_until = $2 WHERE id = $3`,
        [lockingNow ? 0 : failedCount, lockingNow ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null, user.id]
      );
      if (lockingNow) {
        await logAudit({
          wehrId: user.wehr_id,
          actorUserId: user.id,
          actorEmail: user.email,
          action: 'auth.account_locked',
          targetType: 'app_user',
          targetId: user.id,
          details: { failedAttempts: LOCKOUT_THRESHOLD },
          ip: req.ip,
        });
      }
      return res.status(401).json({ ok: false, error: 'E-Mail oder Passwort falsch.' });
    }

    if (user.failed_login_count > 0 || user.locked_until) {
      await query('UPDATE app_user SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [
        user.id,
      ]);
    } else {
      await query('UPDATE app_user SET last_login_at = now() WHERE id = $1', [user.id]);
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
