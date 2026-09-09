// Verschluesselung fuer Betriebsgeheimnisse, die in der DB liegen (aktuell: SMTP-Passwort in
// wehr.smtp_pass_encrypted, siehe Migration 014) - dasselbe Prinzip wie im Schwesterprojekt
// FKatInfo (dort AES-256-GCM, Schluessel aus einem eigenen APP_KEY abgeleitet). EKats hat kein
// eigenes APP_KEY-Secret - der Schluessel wird stattdessen deterministisch per scrypt aus
// JWT_SECRET abgeleitet (ein Secret weniger zu verwalten). JWT_SECRET muss ohnehin >=32 Zeichen
// haben (siehe config.js assertSafeToStart), reicht als Eingabe fuer scrypt.
const crypto = require('crypto');
const config = require('../config');

const KEY = crypto.scryptSync(config.jwtSecret, 'ekats-secret-crypto-salt-v1', 32);

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decrypt(ciphertextB64) {
  if (!ciphertextB64) return null;
  const raw = Buffer.from(ciphertextB64, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
