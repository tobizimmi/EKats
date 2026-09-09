// TOTP-Zweitfaktor (RFC 6238, auf RFC 4226 HOTP aufbauend) fuer optionales 2FA von stab/admin-
// Konten (Migration 018). Mit Bordmitteln (nur `crypto`) implementiert statt einer npm-Bibliothek -
// derselbe Grundsatz wie beim Web-Push/VAPID im Schwesterprojekt FKatInfo (dort explizit gegen
// minishlink/web-push wegen ~15 Transitiv-Dependencies entschieden) und wie utils/crypto.js hier im
// selben Projekt: der Algorithmus ist mit `crypto.createHmac` in wenigen Zeilen korrekt umsetzbar,
// eine Bibliothek dafuer waere unnoetiges Gewicht. Korrektheit der HOTP-Kernfunktion gegen die
// oeffentlichen Testvektoren aus RFC 4226 Anhang D verifiziert (siehe Testlauf in der
// Commit-Historie) - liefert fuer den Testschluessel "12345678901234567890" bei Counter 0..9 exakt
// 755224, 287082, 359152, 969429, 338314, 254676, 287922, 162583, 399871, 520489.
const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// RFC 4226 Section 5.3 (HOTP), Truncate-Funktion.
function hotp(secretBuffer, counter) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBuffer).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return code % 10 ** DIGITS;
}

function totpAt(secretBase32, unixSeconds) {
  const counter = Math.floor(unixSeconds / STEP_SECONDS);
  return String(hotp(base32Decode(secretBase32), counter)).padStart(DIGITS, '0');
}

// Generiert einen neuen, zufaelligen 160-Bit-Secret (Standardlaenge fuer HMAC-SHA1-TOTP) als
// Base32-String (32 Zeichen, keine Polsterung noetig da 160/5=32 glatt aufgeht).
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

// otpauth://-URI zum manuellen Eintragen bzw. fuer QR-Code-Generatoren, die eine URI statt eines
// Bildes annehmen (siehe README/Verifikationshinweis: EKats zeigt aktuell keinen QR-Code, nur
// Secret + URI als Text - kein Grund, eine QR-Bibliothek fuer eine Zeichenkette einzubinden, die
// jede Authenticator-App auch per manueller Eingabe akzeptiert).
function generateOtpAuthUri(secretBase32, accountLabel, issuer = 'EKats') {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// Prueft einen 6-stelligen Code gegen den aktuellen Zeitschritt +/- windowSteps (Standard 1 = +/-30s
// Toleranz fuer Uhrzeit-Drift zwischen Server und Authenticator-App).
function verifyToken(secretBase32, token, windowSteps = 1) {
  const cleanToken = String(token ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleanToken)) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (let delta = -windowSteps; delta <= windowSteps; delta++) {
    if (totpAt(secretBase32, nowSeconds + delta * STEP_SECONDS) === cleanToken) {
      return true;
    }
  }
  return false;
}

module.exports = { generateSecret, generateOtpAuthUri, verifyToken, totpAt, base32Encode, base32Decode };
