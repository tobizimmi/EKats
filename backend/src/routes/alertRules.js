const express = require('express');
const { z } = require('zod');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Mitglieder duerfen ihre eigenen Regeln sehen, aber nur "stab" darf Schwellenwerte konfigurieren
// (siehe CLAUDE.md Abschnitt 2.2 "Rollen").
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, source, target_ref, threshold_key, threshold_value, channel_push, channel_email, active, created_at
       FROM alert_rule WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

const ruleSchema = z.object({
  source: z.enum(['dwd_unwetter', 'pegelonline', 'hochwasserzentralen', 'firms', 'waldbrandindex']),
  targetRef: z.string().trim().min(1).max(200).nullable().optional(),
  thresholdKey: z.enum(['warnstufe', 'wasserstand_cm', 'meldestufe', 'gefahrenstufe', 'radius_km']),
  thresholdValue: z.union([z.string(), z.number()]).transform((v) => String(v)),
  channelPush: z.boolean().optional().default(true),
  channelEmail: z.boolean().optional().default(false),
});

router.post('/', requireRole('stab'), async (req, res, next) => {
  try {
    const parsed = ruleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const { source, targetRef, thresholdKey, thresholdValue, channelPush, channelEmail } = parsed.data;

    const { rows } = await query(
      `INSERT INTO alert_rule (user_id, source, target_ref, threshold_key, threshold_value, channel_push, channel_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, source, target_ref, threshold_key, threshold_value, channel_push, channel_email, active, created_at`,
      [req.user.id, source, targetRef || null, thresholdKey, thresholdValue, channelPush, channelEmail]
    );
    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

const updateSchema = ruleSchema.partial().extend({ active: z.boolean().optional() });

router.patch('/:id', requireRole('stab'), async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const fields = parsed.data;
    const setClauses = [];
    const params = [];

    const columnMap = {
      source: 'source',
      targetRef: 'target_ref',
      thresholdKey: 'threshold_key',
      thresholdValue: 'threshold_value',
      channelPush: 'channel_push',
      channelEmail: 'channel_email',
      active: 'active',
    };
    for (const [key, column] of Object.entries(columnMap)) {
      if (fields[key] !== undefined) {
        params.push(fields[key]);
        setClauses.push(`${column} = $${params.length}`);
      }
    }
    if (setClauses.length === 0) {
      return res.status(400).json({ ok: false, error: 'Keine Aenderungen angegeben.' });
    }

    params.push(req.params.id, req.user.id);
    const { rows } = await query(
      `UPDATE alert_rule SET ${setClauses.join(', ')}
       WHERE id = $${params.length - 1} AND user_id = $${params.length}
       RETURNING id, source, target_ref, threshold_key, threshold_value, channel_push, channel_email, active, created_at`,
      params
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Regel nicht gefunden.' });
    }
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', requireRole('stab'), async (req, res, next) => {
  try {
    const { rowCount } = await query('DELETE FROM alert_rule WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Regel nicht gefunden.' });
    }
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
