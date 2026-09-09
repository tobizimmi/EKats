const nodemailer = require('nodemailer');
const config = require('../config');
const { query } = require('../db');
const { decrypt } = require('../utils/crypto');

// Seit Migration 014 ist SMTP je Wehr im Admin-Bereich konfigurierbar (Feature-Paritaet mit dem
// Schwesterprojekt FKatInfo, admin/settings.php dort) statt ausschliesslich ueber .env. Ein
// gespeichertes Feld je Wehr ueberschreibt den .env-Wert nur, wenn es gesetzt ist - Deployments,
// die bislang nur .env nutzen, bleiben unveraendert funktionsfaehig. Kein Transporter-Caching mehr
// (E-Mail-Versand ist ein seltener, nicht performancekritischer Pfad, siehe evaluate.js), damit
// eine Admin-Aenderung sofort wirkt statt erst nach einem Prozess-Neustart.
async function resolveSmtpConfig(wehrId) {
  let dbConfig = {};
  if (wehrId) {
    const { rows } = await query(
      'SELECT smtp_host, smtp_port, smtp_user, smtp_pass_encrypted, smtp_from FROM wehr WHERE id = $1',
      [wehrId]
    );
    if (rows[0]) dbConfig = rows[0];
  }
  return {
    host: dbConfig.smtp_host || config.smtp.host,
    port: dbConfig.smtp_port || config.smtp.port,
    user: dbConfig.smtp_user || config.smtp.user,
    pass: dbConfig.smtp_pass_encrypted ? decrypt(dbConfig.smtp_pass_encrypted) : config.smtp.pass,
    from: dbConfig.smtp_from || config.smtp.from,
  };
}

async function sendMail({ to, subject, text, wehrId }) {
  const smtp = await resolveSmtpConfig(wehrId);
  if (!smtp.host) {
    console.warn('[mailer] SMTP nicht konfiguriert (.env oder Admin-Bereich) - E-Mail-Versand uebersprungen.');
    return { sent: false };
  }
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
  await transporter.sendMail({ from: smtp.from, to, subject, text });
  return { sent: true };
}

module.exports = { sendMail, resolveSmtpConfig };
