const jwt = require('jsonwebtoken');
const config = require('../config');
const { query } = require('../db');

const COOKIE_NAME = 'ekats_token';

// Parst einfache Dauer-Strings ('12h', '30m', '7d', '45s') oder eine reine Sekundenzahl
// (wie JWT_EXPIRES_IN sie akzeptiert) in Millisekunden - fuer die Cookie-maxAge, die sonst nicht
// synchron mit der tatsaechlichen JWT-Gueltigkeit waere (siehe config.jwtExpiresIn).
function parseDurationMs(value, fallbackMs) {
  if (typeof value === 'number') return value * 1000;
  const match = /^(\d+)\s*(s|m|h|d)?$/i.exec(String(value).trim());
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  const unitMs = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }[match[2]?.toLowerCase() || 's'];
  return amount * unitMs;
}

const COOKIE_MAX_AGE_MS = parseDurationMs(config.jwtExpiresIn, 12 * 60 * 60 * 1000);

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, wehrId: user.wehr_id, tv: user.token_version ?? 0 },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    maxAge: COOKIE_MAX_AGE_MS,
    path: config.cookiePath,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: config.cookiePath });
}

function extractToken(req) {
  if (req.cookies && req.cookies[COOKIE_NAME]) {
    return req.cookies[COOKIE_NAME];
  }
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length);
  }
  return null;
}

async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Nicht angemeldet.' });
  }
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'Sitzung abgelaufen oder ungueltig.' });
  }

  // Rolle/Wehr-Zugehoerigkeit und token_version werden bewusst NICHT aus dem (bis zu
  // JWT_EXPIRES_IN alten) Token-Payload uebernommen, sondern bei jedem Request frisch aus der DB
  // gelesen: sonst wuerden eine Rollenaenderung/-degradierung oder ein Passwortwechsel (der
  // token_version hochzaehlt, siehe routes/users.js) erst nach Ablauf des alten Tokens wirken -
  // bis zu 12h lang haette ein degradierter oder ausgesperrter Nutzer weiter vollen Zugriff.
  try {
    const { rows } = await query('SELECT id, email, role, wehr_id, token_version FROM app_user WHERE id = $1', [
      payload.sub,
    ]);
    const user = rows[0];
    if (!user || user.token_version !== payload.tv) {
      return res.status(401).json({ ok: false, error: 'Sitzung abgelaufen oder ungueltig.' });
    }
    req.user = { id: user.id, email: user.email, role: user.role, wehrId: user.wehr_id };
    return next();
  } catch (err) {
    return next(err);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ ok: false, error: 'Keine Berechtigung.' });
    }
    return next();
  };
}

module.exports = {
  COOKIE_NAME,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
  requireRole,
};
