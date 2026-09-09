// Selbst verwaltbare Nutzer-Einstellungen (Konzept Teil 2, Baustein D/Migration 011): geraete-
// uebergreifend gespeicherte Anzeige-Praeferenzen - aktuell Spalten-Sichtbarkeit je Themenseite,
// spaeter das persoenliche Dashboard-Layout. Rein self-service (jeder Nutzer verwaltet nur seine
// eigenen Werte, kein Rollen-Check noetig) und bewusst ohne Audit-Log: das sind Anzeige-Vorlieben,
// keine sicherheits- oder wehrrelevanten Aenderungen wie z.B. ein Passwortwechsel.
const express = require('express');
const { z } = require('zod');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// pref_key ist frei vom Frontend vergeben (Konvention: 'dashboard_layout', 'columns:pegelonline',
// ...) - hier nur als Bezeichner validiert, nicht gegen eine feste Liste, damit neue Seiten/Widgets
// keine Backend-Aenderung fuer einen neuen Schluessel brauchen.
const KEY_PATTERN = /^[a-z0-9_:-]{1,100}$/;

function assertValidKey(key, res) {
  if (!KEY_PATTERN.test(key)) {
    res.status(400).json({ ok: false, error: 'Ungueltiger Einstellungs-Schluessel.' });
    return false;
  }
  return true;
}

router.get('/:key', async (req, res, next) => {
  try {
    if (!assertValidKey(req.params.key, res)) return;
    const { rows } = await query('SELECT value, updated_at FROM user_preference WHERE user_id = $1 AND pref_key = $2', [
      req.user.id,
      req.params.key,
    ]);
    return res.json({ ok: true, data: rows[0] || null });
  } catch (err) {
    return next(err);
  }
});

// Grosszuegig, aber begrenzt (50 KB je Einstellung) - genug fuer eine Spaltenliste oder ein
// Dashboard-Layout mit vielen Widgets, verhindert aber Missbrauch als beliebiger Datenspeicher.
const valueSchema = z.object({
  value: z.any().refine((v) => JSON.stringify(v).length <= 50000, {
    message: 'Einstellung ist zu groß (max. 50 KB).',
  }),
});

router.put('/:key', async (req, res, next) => {
  try {
    if (!assertValidKey(req.params.key, res)) return;
    const parsed = valueSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }

    const { rows } = await query(
      `INSERT INTO user_preference (user_id, pref_key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, pref_key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       RETURNING value, updated_at`,
      [req.user.id, req.params.key, JSON.stringify(parsed.data.value)]
    );
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

// "Zuruecksetzen": Zeile loeschen, die aufrufende Seite faellt auf ihre eingebauten Standardwerte
// zurueck - kein serverseitiger Default noetig.
router.delete('/:key', async (req, res, next) => {
  try {
    if (!assertValidKey(req.params.key, res)) return;
    await query('DELETE FROM user_preference WHERE user_id = $1 AND pref_key = $2', [req.user.id, req.params.key]);
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
