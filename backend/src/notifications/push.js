const webpush = require('web-push');
const config = require('../config');
const { query } = require('../db');

let configured = false;

function ensureConfigured() {
  if (configured) return true;
  if (!config.vapidPublicKey || !config.vapidPrivateKey) {
    return false;
  }
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
  configured = true;
  return true;
}

async function sendPushToUser(userId, payload) {
  if (!ensureConfigured()) {
    console.warn('[push] VAPID-Schluessel fehlen (.env) - Push-Versand uebersprungen.');
    return { sent: 0 };
  }

  const { rows: subscriptions } = await query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscription WHERE user_id = $1',
    [userId]
  );

  let sent = 0;
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        JSON.stringify(payload)
      );
      sent += 1;
    } catch (err) {
      // 404/410 = Subscription ist beim Browser/Betriebssystem abgelaufen -> aufraeumen.
      if (err.statusCode === 404 || err.statusCode === 410) {
        await query('DELETE FROM push_subscription WHERE id = $1', [sub.id]);
      } else {
        console.error('[push] Versand fehlgeschlagen:', err.message);
      }
    }
  }
  return { sent };
}

module.exports = { sendPushToUser };
