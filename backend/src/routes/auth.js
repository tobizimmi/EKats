const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const config = require('../config');
const { query } = require('../db');
const { signToken, setAuthCookie, clearAuthCookie, requireAuth } = require('../middleware/auth');
const { logAudit } = require('../audit');
const { sendMail } = require('../notifications/mailer');

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

// Passwort-vergessen-Selbstbedienung (Feature-Paritaet mit dem Schwesterprojekt FKatInfo, dort
// password_reset.php): bisher konnte ein ausgesperrter Nutzer nur einen Admin um einen Reset
// bitten (POST /api/users/:id/reset-password). Antwort ist bewusst IMMER identisch, egal ob die
// E-Mail existiert - sonst liesse sich per Rueckmeldung erraten, welche E-Mail-Adressen als Konto
// registriert sind (User-Enumeration-Oracle), dieselbe Begruendung wie in FKatInfo.
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Zu viele Anfragen. Bitte spaeter erneut versuchen.' },
});

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 Stunde
// Immer identische Antwort, unabhaengig davon ob die E-Mail existiert (siehe Kommentar oben) - der
// eigentliche Hinweistext dazu steht bewusst nur im Frontend (js/forgot-password.js), nicht hier,
// damit die API-Antwortform mit allen anderen Endpunkten ({ok, data}) konsistent bleibt.
const GENERIC_FORGOT_PASSWORD_RESPONSE = { ok: true, data: null };

const forgotPasswordSchema = z.object({ email: z.string().email() });

router.post('/forgot-password', forgotPasswordLimiter, async (req, res, next) => {
  try {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      // Auch bei ungueltigem Format die generische Antwort - ein 400 wuerde verraten, dass genau
      // diese Eingabe kein gueltiges E-Mail-Format hatte, aendert aber nichts an der eigentlichen
      // Enumeration-Frage und ist reine Formvalidierung, kein Sicherheitsrisiko fuer sich.
      return res.json(GENERIC_FORGOT_PASSWORD_RESPONSE);
    }
    const { email } = parsed.data;

    const { rows } = await query('SELECT id, email, wehr_id FROM app_user WHERE email = $1', [email]);
    const user = rows[0];
    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

      // Vorherige, noch nicht eingeloeste Tokens dieses Nutzers entwerten - immer nur der neueste
      // Link soll funktionieren.
      await query('DELETE FROM password_reset_token WHERE user_id = $1 AND used_at IS NULL', [user.id]);
      await query(
        'INSERT INTO password_reset_token (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [user.id, tokenHash, expiresAt]
      );

      const resetUrl = `${config.baseUrl}/reset-password.html?token=${rawToken}`;
      try {
        await sendMail({
          to: user.email,
          subject: 'EKats: Passwort zuruecksetzen',
          text:
            `Zum Zuruecksetzen deines EKats-Passworts folge diesem Link (gueltig 1 Stunde):\n\n${resetUrl}\n\n` +
            'Falls du das nicht angefordert hast, ignoriere diese E-Mail einfach.',
          wehrId: user.wehr_id,
        });
      } catch (err) {
        console.error('[auth] Reset-E-Mail-Versand fehlgeschlagen:', err.message);
      }
    }

    return res.json(GENERIC_FORGOT_PASSWORD_RESPONSE);
  } catch (err) {
    return next(err);
  }
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8, 'Passwort muss mindestens 8 Zeichen haben.'),
});

router.post('/reset-password', forgotPasswordLimiter, async (req, res, next) => {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const { token, newPassword } = parsed.data;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const { rows } = await query(
      `SELECT prt.id, prt.user_id, u.email, u.wehr_id
       FROM password_reset_token prt
       JOIN app_user u ON u.id = prt.user_id
       WHERE prt.token_hash = $1 AND prt.used_at IS NULL AND prt.expires_at > now()`,
      [tokenHash]
    );
    const tokenRow = rows[0];
    if (!tokenRow) {
      return res.status(400).json({ ok: false, error: 'Link ungueltig oder abgelaufen. Bitte erneut anfordern.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await query(
      'UPDATE app_user SET password_hash = $1, token_version = token_version + 1, failed_login_count = 0, locked_until = NULL WHERE id = $2',
      [passwordHash, tokenRow.user_id]
    );
    await query('UPDATE password_reset_token SET used_at = now() WHERE id = $1', [tokenRow.id]);

    await logAudit({
      wehrId: tokenRow.wehr_id,
      actorUserId: tokenRow.user_id,
      actorEmail: tokenRow.email,
      action: 'auth.password_reset_via_email',
      targetType: 'app_user',
      targetId: tokenRow.user_id,
      details: {},
      ip: req.ip,
    });

    return res.json({ ok: true, data: null });
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
