const express = require('express');
const bcrypt = require('bcrypt');
const { z } = require('zod');
const { query } = require('../db');
const { requireAuth, requireRole, signToken, setAuthCookie } = require('../middleware/auth');
const { logAudit } = require('../audit');
const { encrypt } = require('../utils/crypto');
const totp = require('../utils/totp');

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
      'SELECT id, email, role, totp_enabled, created_at FROM app_user WHERE wehr_id = $1 ORDER BY created_at',
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
    await logAudit({
      wehrId: req.user.wehrId,
      actorUserId: req.user.id,
      actorEmail: req.user.email,
      action: 'user.create',
      targetType: 'app_user',
      targetId: rows[0].id,
      details: { email, role },
      ip: req.ip,
    });
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
    await logAudit({
      wehrId: req.user.wehrId,
      actorUserId: req.user.id,
      actorEmail: req.user.email,
      action: 'user.role_change',
      targetType: 'app_user',
      targetId,
      details: { newRole: role, email: rows[0].email },
      ip: req.ip,
    });
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

const changeOwnPasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Neues Passwort muss mindestens 8 Zeichen haben.'),
});

// Self-Service Passwortaenderung: erfordert das aktuelle Passwort. Zaehlt token_version hoch
// (macht alle ANDEREN, evtl. gestohlenen Sitzungen sofort ungueltig), stellt aber sofort ein neues
// Token fuer die eigene, gerade genutzte Sitzung aus - sonst waere man nach dem Aendern des
// eigenen Passworts durch den eigenen token_version-Bump direkt selbst ausgeloggt.
router.patch('/me/password', async (req, res, next) => {
  try {
    const parsed = changeOwnPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const { currentPassword, newPassword } = parsed.data;

    const { rows } = await query('SELECT id, email, role, wehr_id, password_hash FROM app_user WHERE id = $1', [
      req.user.id,
    ]);
    const user = rows[0];
    if (!user) return res.status(404).json({ ok: false, error: 'Nutzer nicht gefunden.' });

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) {
      return res.status(401).json({ ok: false, error: 'Aktuelles Passwort ist falsch.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    const { rows: updated } = await query(
      `UPDATE app_user SET password_hash = $1, token_version = token_version + 1
       WHERE id = $2 RETURNING token_version`,
      [passwordHash, user.id]
    );

    await logAudit({
      wehrId: user.wehr_id,
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'user.password_change',
      targetType: 'app_user',
      targetId: user.id,
      ip: req.ip,
    });

    const token = signToken({ ...user, token_version: updated[0].token_version });
    setAuthCookie(res, token);
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

// --- TOTP-Zweitfaktor (Migration 018, siehe backend/src/utils/totp.js) ------------------------
// Opt-in, nur fuer stab/admin anbietbar (siehe Kommentar in der Migration). Zweistufiger Setup-Ablauf
// ohne serverseitigen Zwischenspeicher: /setup generiert ein Secret und gibt es im Klartext an den
// Client zurueck (zusammen mit der otpauth-URI zum Scannen/manuellen Eintragen); der Client haelt es
// nur kurz im Speicher, bis der Nutzer den ersten Code eingibt - /enable bekommt Secret + Code erneut
// und persistiert (verschluesselt) nur, wenn der Code dagegen passt. Kein "pending secret" in der DB
// noetig, ein abgebrochener Setup-Versuch hinterlaesst also nichts.
router.post('/me/totp/setup', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const secret = totp.generateSecret();
    const otpauthUri = totp.generateOtpAuthUri(secret, req.user.email);
    return res.json({ ok: true, data: { secret, otpauthUri } });
  } catch (err) {
    return next(err);
  }
});

const totpEnableSchema = z.object({
  secret: z.string().min(1),
  code: z.string().min(1),
});

router.post('/me/totp/enable', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const parsed = totpEnableSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'Secret und Code erforderlich.' });
    }
    const { secret, code } = parsed.data;
    if (!totp.verifyToken(secret, code)) {
      return res.status(400).json({ ok: false, error: 'Code stimmt nicht. Bitte erneut versuchen.' });
    }

    await query('UPDATE app_user SET totp_secret_encrypted = $1, totp_enabled = true WHERE id = $2', [
      encrypt(secret),
      req.user.id,
    ]);
    await logAudit({
      wehrId: req.user.wehrId,
      actorUserId: req.user.id,
      actorEmail: req.user.email,
      action: 'user.totp_enable',
      targetType: 'app_user',
      targetId: req.user.id,
      ip: req.ip,
    });
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

const totpDisableSchema = z.object({ password: z.string().min(1) });

router.post('/me/totp/disable', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const parsed = totpDisableSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'Passwort erforderlich.' });
    }

    const { rows } = await query('SELECT password_hash FROM app_user WHERE id = $1', [req.user.id]);
    const valid = rows[0] && (await bcrypt.compare(parsed.data.password, rows[0].password_hash));
    if (!valid) {
      return res.status(401).json({ ok: false, error: 'Passwort ist falsch.' });
    }

    await query('UPDATE app_user SET totp_secret_encrypted = NULL, totp_enabled = false WHERE id = $1', [
      req.user.id,
    ]);
    await logAudit({
      wehrId: req.user.wehrId,
      actorUserId: req.user.id,
      actorEmail: req.user.email,
      action: 'user.totp_disable',
      targetType: 'app_user',
      targetId: req.user.id,
      ip: req.ip,
    });
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

// Admin setzt das 2FA eines anderen Kontos der eigenen Wehr zurueck (Lockout-Recovery, z.B. wenn das
// Authenticator-Geraet verloren geht) - dasselbe Muster wie /:id/reset-password.
router.post('/:id/totp/reset', requireRole('admin'), async (req, res, next) => {
  try {
    const targetId = Number(req.params.id);
    const { rows } = await query(
      `UPDATE app_user SET totp_secret_encrypted = NULL, totp_enabled = false
       WHERE id = $1 AND wehr_id = $2 RETURNING id, email`,
      [targetId, req.user.wehrId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Nutzer nicht gefunden.' });
    }
    await logAudit({
      wehrId: req.user.wehrId,
      actorUserId: req.user.id,
      actorEmail: req.user.email,
      action: 'user.totp_reset_by_admin',
      targetType: 'app_user',
      targetId,
      details: { email: rows[0].email },
      ip: req.ip,
    });
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

const adminResetPasswordSchema = z.object({
  newPassword: z.string().min(8, 'Neues Passwort muss mindestens 8 Zeichen haben.'),
});

// Admin setzt das Passwort eines anderen Kontos der eigenen Wehr direkt neu (z.B. wenn ein
// Mitglied sein Passwort vergessen hat und es keinen E-Mail-Versand fuer einen Self-Service-Reset
// gibt). token_version wird hochgezaehlt: alle bestehenden Sitzungen dieses Kontos werden dadurch
// sofort ungueltig.
router.post('/:id/reset-password', requireRole('admin'), async (req, res, next) => {
  try {
    const parsed = adminResetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const targetId = Number(req.params.id);
    const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);

    const { rows } = await query(
      `UPDATE app_user SET password_hash = $1, token_version = token_version + 1
       WHERE id = $2 AND wehr_id = $3 RETURNING id, email`,
      [passwordHash, targetId, req.user.wehrId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Nutzer nicht gefunden.' });
    }

    await logAudit({
      wehrId: req.user.wehrId,
      actorUserId: req.user.id,
      actorEmail: req.user.email,
      action: 'user.password_reset_by_admin',
      targetType: 'app_user',
      targetId,
      details: { email: rows[0].email },
      ip: req.ip,
    });

    return res.json({ ok: true, data: null });
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
    const { rows } = await query('SELECT email FROM app_user WHERE id = $1', [req.user.id]);
    await query('DELETE FROM app_user WHERE id = $1', [req.user.id]);
    await logAudit({
      wehrId: req.user.wehrId,
      actorUserId: null,
      actorEmail: rows[0]?.email,
      action: 'user.self_delete',
      targetType: 'app_user',
      targetId: req.user.id,
      ip: req.ip,
    });
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

    const { rows: targetRows } = await query('SELECT email FROM app_user WHERE id = $1 AND wehr_id = $2', [
      targetId,
      req.user.wehrId,
    ]);
    const { rowCount } = await query('DELETE FROM app_user WHERE id = $1 AND wehr_id = $2', [
      targetId,
      req.user.wehrId,
    ]);
    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Nutzer nicht gefunden.' });
    }
    await logAudit({
      wehrId: req.user.wehrId,
      actorUserId: req.user.id,
      actorEmail: req.user.email,
      action: 'user.delete',
      targetType: 'app_user',
      targetId,
      details: { email: targetRows[0]?.email },
      ip: req.ip,
    });
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

// DSGVO Art. 15/20: eigene gespeicherte Daten als JSON-Datei herunterladen (Recht auf Auskunft/
// Datenuebertragbarkeit). Umfasst Profil, eigene Alarmregeln und Push-Subscription-Metadaten
// (ohne die kryptografischen Push-Schluessel selbst - technische Geheimnisse, kein Mehrwert fuer
// den Nutzer beim Einsehen der eigenen Daten).
router.get('/me/export', async (req, res, next) => {
  try {
    const { rows: userRows } = await query(
      `SELECT u.id, u.email, u.role, u.created_at, u.last_login_at, w.name AS wehr_name
       FROM app_user u JOIN wehr w ON w.id = u.wehr_id WHERE u.id = $1`,
      [req.user.id]
    );
    if (userRows.length === 0) return res.status(404).json({ ok: false, error: 'Nutzer nicht gefunden.' });

    const { rows: alertRules } = await query(
      `SELECT source, target_ref, threshold_key, threshold_value, channel_push, channel_email, active, created_at
       FROM alert_rule WHERE user_id = $1 ORDER BY created_at`,
      [req.user.id]
    );
    const { rows: pushSubscriptions } = await query(
      'SELECT endpoint, created_at FROM push_subscription WHERE user_id = $1 ORDER BY created_at',
      [req.user.id]
    );

    const exportData = {
      exportedAt: new Date().toISOString(),
      profile: userRows[0],
      alertRules,
      pushSubscriptions,
    };

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ekats-meine-daten-${Date.now()}.json"`);
    return res.send(JSON.stringify(exportData, null, 2));
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
