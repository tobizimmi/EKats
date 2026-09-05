const nodemailer = require('nodemailer');
const config = require('../config');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!config.smtp.host) return null;
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return transporter;
}

async function sendMail({ to, subject, text }) {
  const t = getTransporter();
  if (!t) {
    console.warn('[mailer] SMTP nicht konfiguriert (.env) - E-Mail-Versand uebersprungen.');
    return { sent: false };
  }
  await t.sendMail({ from: config.smtp.from, to, subject, text });
  return { sent: true };
}

module.exports = { sendMail };
