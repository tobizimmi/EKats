// SMTP-Konfiguration im Admin-Bereich (Migration 014, Feature-Paritaet mit dem Schwesterprojekt
// FKatInfo, admin/settings.php dort) - Alternative zur bisher ausschliesslichen .env-Konfiguration
// (siehe notifications/mailer.js fuer den Fallback). Das Passwort wird nie im Klartext
// zurueckgegeben, nur ob eines gesetzt ist (hasPassword) - dieselbe Zurueckhaltung wie bei anderen
// Secrets in diesem Projekt (z.B. Kachelmann-API-Key wird auch nicht im Klartext angezeigt).
const express = require('express');
const { z } = require('zod');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../audit');
const { encrypt } = require('../utils/crypto');
const { sendMail } = require('../notifications/mailer');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT smtp_host, smtp_port, smtp_user, smtp_from, (smtp_pass_encrypted IS NOT NULL) AS has_password FROM wehr WHERE id = $1',
      [req.user.wehrId]
    );
    const w = rows[0] || {};
    return res.json({
      ok: true,
      data: {
        host: w.smtp_host || null,
        port: w.smtp_port || null,
        user: w.smtp_user || null,
        from: w.smtp_from || null,
        hasPassword: !!w.has_password,
      },
    });
  } catch (err) {
    return next(err);
  }
});

const updateSchema = z.object({
  host: z.string().trim().max(255).nullable().optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  user: z.string().trim().max(255).nullable().optional(),
  // Leer/undefined = Passwort unveraendert lassen; explizit null = Passwort loeschen (auf .env
  // zurueckfallen); ein nicht-leerer String verschluesselt und ersetzt es.
  pass: z.string().max(500).nullable().optional(),
  from: z.string().trim().max(255).nullable().optional(),
});

router.put('/', async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const { host, port, user, pass, from } = parsed.data;
    const setClauses = ['smtp_host = $1', 'smtp_port = $2', 'smtp_user = $3', 'smtp_from = $4'];
    const params = [host ?? null, port ?? null, user ?? null, from ?? null];

    if (pass !== undefined) {
      params.push(pass === null ? null : encrypt(pass));
      setClauses.push(`smtp_pass_encrypted = $${params.length}`);
    }

    params.push(req.user.wehrId);
    await query(`UPDATE wehr SET ${setClauses.join(', ')} WHERE id = $${params.length}`, params);

    await logAudit({
      wehrId: req.user.wehrId,
      actorUserId: req.user.id,
      actorEmail: req.user.email,
      action: 'smtp_settings.update',
      targetType: 'wehr',
      targetId: req.user.wehrId,
      details: { host, port, user, from, passwordChanged: pass !== undefined },
      ip: req.ip,
    });

    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

// Verschickt eine Test-E-Mail an den anfordernden Admin selbst - schnellster Weg, eine gespeicherte
// SMTP-Konfiguration ohne Umweg ueber eine echte Warnung zu pruefen.
router.post('/test', async (req, res, next) => {
  try {
    const result = await sendMail({
      to: req.user.email,
      subject: 'EKats: Test-E-Mail',
      text: 'Diese Test-E-Mail bestaetigt, dass die SMTP-Konfiguration von EKats funktioniert.',
      wehrId: req.user.wehrId,
    });
    if (!result.sent) {
      return res.status(400).json({ ok: false, error: 'Kein SMTP-Host konfiguriert.' });
    }
    return res.json({ ok: true, data: null });
  } catch (err) {
    return res.status(502).json({ ok: false, error: `Versand fehlgeschlagen: ${err.message}` });
  }
});

module.exports = router;
