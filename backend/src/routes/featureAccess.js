// Admin-Verwaltung der Feature-Zugriffssteuerung (Migration 009, ab Phase 5 auf alle Addons
// generalisiert statt nur Kachelmann - siehe Konzept Teil 2, Baustein C). GET je Feature liefert
// den kompletten Zugriffsstatus (Rollenfreigaben + Einzelnutzer-Overrides + alle Nutzer der Wehr
// zur Auswahl im Admin-UI) in einer Antwort, da beides zusammen im selben Formular verwaltet wird.
// GET / liefert alle Features auf einmal (nur Rollenfreigaben) fuer die Matrix-Uebersicht im
// Admin-Bereich, ohne acht Einzelabfragen vom Frontend aus.
const express = require('express');
const { z } = require('zod');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../audit');
const { DEFAULT_CLOSED_FEATURES } = require('../utils/featureAccess');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const ROLES = ['admin', 'stab', 'mitglied'];
// Deckungsgleich mit VALID_SOURCES in routes/datapoints.js - jede Datenquelle ist ab Phase 5
// einzeln je Rolle/Nutzer rechtbar, nicht mehr nur Kachelmann.
const FEATURE_KEYS = [
  'dwd_unwetter',
  'pegelonline',
  'hochwasserzentralen',
  'waldbrandindex',
  'firms',
  'bbk_warnung',
  'kachelmann',
  'wetter_vorhersage',
];

function assertKnownFeature(key, res) {
  if (!FEATURE_KEYS.includes(key)) {
    res.status(400).json({ ok: false, error: `Unbekanntes Feature: ${key}` });
    return false;
  }
  return true;
}

// Uebersicht aller Features auf einmal - nur die Rollenfreigaben (fuer die Matrix-Ansicht), keine
// Einzelnutzer-Overrides (die bleiben Detailansicht je Feature ueber GET /:featureKey).
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT feature_key, role FROM wehr_feature_role_access WHERE wehr_id = $1', [
      req.user.wehrId,
    ]);
    const rolesByFeature = Object.fromEntries(FEATURE_KEYS.map((key) => [key, []]));
    rows.forEach((r) => {
      if (rolesByFeature[r.feature_key]) rolesByFeature[r.feature_key].push(r.role);
    });
    return res.json({
      ok: true,
      data: FEATURE_KEYS.map((key) => ({
        featureKey: key,
        roles: rolesByFeature[key],
        defaultOpen: !DEFAULT_CLOSED_FEATURES.has(key),
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/:featureKey', async (req, res, next) => {
  try {
    if (!assertKnownFeature(req.params.featureKey, res)) return;

    const { rows: roleAccess } = await query(
      'SELECT role FROM wehr_feature_role_access WHERE wehr_id = $1 AND feature_key = $2',
      [req.user.wehrId, req.params.featureKey]
    );
    const { rows: userAccess } = await query(
      `SELECT ufa.user_id, ufa.enabled, u.email
       FROM user_feature_access ufa
       JOIN app_user u ON u.id = ufa.user_id
       WHERE ufa.feature_key = $1 AND u.wehr_id = $2`,
      [req.params.featureKey, req.user.wehrId]
    );
    const { rows: allUsers } = await query(
      'SELECT id, email, role FROM app_user WHERE wehr_id = $1 ORDER BY email',
      [req.user.wehrId]
    );

    return res.json({
      ok: true,
      data: {
        roles: roleAccess.map((r) => r.role),
        userOverrides: userAccess,
        users: allUsers,
      },
    });
  } catch (err) {
    return next(err);
  }
});

const roleAccessSchema = z.object({ roles: z.array(z.enum(ROLES)) });

router.put('/:featureKey/roles', async (req, res, next) => {
  try {
    if (!assertKnownFeature(req.params.featureKey, res)) return;
    const parsed = roleAccessSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }

    await query('DELETE FROM wehr_feature_role_access WHERE wehr_id = $1 AND feature_key = $2', [
      req.user.wehrId,
      req.params.featureKey,
    ]);
    for (const role of parsed.data.roles) {
      await query(
        'INSERT INTO wehr_feature_role_access (wehr_id, feature_key, role) VALUES ($1, $2, $3)',
        [req.user.wehrId, req.params.featureKey, role]
      );
    }

    await logAudit({
      wehrId: req.user.wehrId,
      actorUserId: req.user.id,
      actorEmail: req.user.email,
      action: 'feature_access.set_roles',
      targetType: 'feature',
      targetId: req.params.featureKey,
      details: { roles: parsed.data.roles },
      ip: req.ip,
    });
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

const userOverrideSchema = z.object({ userId: z.number().int(), enabled: z.boolean().nullable() });

// enabled: true = individuell erlauben, false = individuell sperren, null = Override entfernen
// (Zugriff richtet sich dann wieder nur nach der Rollenfreigabe).
router.put('/:featureKey/user-override', async (req, res, next) => {
  try {
    if (!assertKnownFeature(req.params.featureKey, res)) return;
    const parsed = userOverrideSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const { userId, enabled } = parsed.data;

    const { rows: targetUserRows } = await query('SELECT id FROM app_user WHERE id = $1 AND wehr_id = $2', [
      userId,
      req.user.wehrId,
    ]);
    if (targetUserRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Nutzer nicht gefunden.' });
    }

    if (enabled === null) {
      await query('DELETE FROM user_feature_access WHERE user_id = $1 AND feature_key = $2', [
        userId,
        req.params.featureKey,
      ]);
    } else {
      await query(
        `INSERT INTO user_feature_access (user_id, feature_key, enabled) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, feature_key) DO UPDATE SET enabled = EXCLUDED.enabled`,
        [userId, req.params.featureKey, enabled]
      );
    }

    await logAudit({
      wehrId: req.user.wehrId,
      actorUserId: req.user.id,
      actorEmail: req.user.email,
      action: 'feature_access.set_user_override',
      targetType: 'app_user',
      targetId: userId,
      details: { featureKey: req.params.featureKey, enabled },
      ip: req.ip,
    });
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
