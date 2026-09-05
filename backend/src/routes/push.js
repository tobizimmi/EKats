const express = require('express');
const { z } = require('zod');
const config = require('../config');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/vapid-public-key', (req, res) => {
  res.json({ ok: true, data: { publicKey: config.vapidPublicKey || null } });
});

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});

router.post('/subscribe', requireAuth, async (req, res, next) => {
  try {
    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'Ungueltige Push-Subscription.' });
    }
    const { endpoint, keys } = parsed.data;
    await query(
      `INSERT INTO push_subscription (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.user.id, endpoint, keys.p256dh, keys.auth]
    );
    return res.status(201).json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

router.delete('/subscribe', requireAuth, async (req, res, next) => {
  try {
    const endpoint = req.body?.endpoint;
    if (!endpoint) {
      return res.status(400).json({ ok: false, error: 'endpoint erforderlich.' });
    }
    await query('DELETE FROM push_subscription WHERE endpoint = $1 AND user_id = $2', [
      endpoint,
      req.user.id,
    ]);
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
