// Feld-Definitionen fuer freie Zusatzfelder je Wehr (Konzept Teil 2, Migration 008). Admin-only
// CRUD; die Werte selbst liegen in critical_object.custom_fields (siehe routes/objects.js).
const express = require('express');
const { z } = require('zod');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../audit');

const router = express.Router();
router.use(requireAuth);

const FIELD_TYPES = ['text', 'textarea', 'number', 'boolean', 'date', 'select'];
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

// Alle Rollen duerfen die Definitionen LESEN (das Objekt-Formular braucht sie, um Custom-Felder zu
// rendern) - nur Admin darf sie anlegen/aendern/loeschen.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id, key, label, field_type, options, required, sort_order FROM object_field_definition WHERE wehr_id = $1 ORDER BY sort_order, id',
      [req.user.wehrId]
    );
    return res.json({ ok: true, data: rows });
  } catch (err) {
    return next(err);
  }
});

const fieldSchema = z
  .object({
    key: z.string().regex(KEY_PATTERN, 'key: nur Kleinbuchstaben/Ziffern/Unterstrich, mit Buchstabe beginnend, max. 50 Zeichen.'),
    label: z.string().trim().min(1).max(150),
    fieldType: z.enum(FIELD_TYPES),
    options: z.array(z.object({ value: z.string().trim().min(1).max(100), label: z.string().trim().min(1).max(150) })).nullable().optional(),
    required: z.boolean().optional().default(false),
    sortOrder: z.number().int().optional().default(0),
  })
  .refine((d) => d.fieldType !== 'select' || (d.options && d.options.length > 0), {
    message: 'options: bei field_type "select" mindestens eine Option erforderlich.',
  });

router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const parsed = fieldSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const d = parsed.data;

    const dup = await query('SELECT 1 FROM object_field_definition WHERE wehr_id = $1 AND key = $2', [
      req.user.wehrId,
      d.key,
    ]);
    if (dup.rows.length > 0) {
      return res.status(409).json({ ok: false, error: `Feld-Key "${d.key}" existiert bereits.` });
    }

    const { rows } = await query(
      `INSERT INTO object_field_definition (wehr_id, key, label, field_type, options, required, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, key, label, field_type, options, required, sort_order`,
      [req.user.wehrId, d.key, d.label, d.fieldType, d.options ? JSON.stringify(d.options) : null, d.required, d.sortOrder]
    );

    await logAudit({
      wehrId: req.user.wehrId,
      actorUserId: req.user.id,
      actorEmail: req.user.email,
      action: 'object_field_definition.create',
      targetType: 'object_field_definition',
      targetId: rows[0].id,
      details: { key: d.key, label: d.label },
      ip: req.ip,
    });
    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

const updateSchema = z.object({
  label: z.string().trim().min(1).max(150).optional(),
  options: z.array(z.object({ value: z.string().trim().min(1).max(100), label: z.string().trim().min(1).max(150) })).nullable().optional(),
  required: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

// key/fieldType sind bewusst nicht aenderbar: bereits gespeicherte custom_fields-Werte in
// critical_object referenzieren den key direkt, ein Typwechsel wuerde vorhandene Werte inkonsistent
// machen (z.B. "boolean" nachtraeglich auf "number"). Neu anlegen statt umbauen.
router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const d = parsed.data;
    const setClauses = [];
    const params = [];

    if (d.label !== undefined) {
      params.push(d.label);
      setClauses.push(`label = $${params.length}`);
    }
    if (d.options !== undefined) {
      params.push(d.options ? JSON.stringify(d.options) : null);
      setClauses.push(`options = $${params.length}`);
    }
    if (d.required !== undefined) {
      params.push(d.required);
      setClauses.push(`required = $${params.length}`);
    }
    if (d.sortOrder !== undefined) {
      params.push(d.sortOrder);
      setClauses.push(`sort_order = $${params.length}`);
    }
    if (setClauses.length === 0) {
      return res.status(400).json({ ok: false, error: 'Keine Aenderungen angegeben.' });
    }
    setClauses.push('updated_at = now()');

    params.push(req.params.id, req.user.wehrId);
    const { rows } = await query(
      `UPDATE object_field_definition SET ${setClauses.join(', ')}
       WHERE id = $${params.length - 1} AND wehr_id = $${params.length}
       RETURNING id, key, label, field_type, options, required, sort_order`,
      params
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Feld-Definition nicht gefunden.' });
    }
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      'DELETE FROM object_field_definition WHERE id = $1 AND wehr_id = $2 RETURNING key',
      [req.params.id, req.user.wehrId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Feld-Definition nicht gefunden.' });
    }
    await logAudit({
      wehrId: req.user.wehrId,
      actorUserId: req.user.id,
      actorEmail: req.user.email,
      action: 'object_field_definition.delete',
      targetType: 'object_field_definition',
      targetId: req.params.id,
      details: { key: rows[0].key },
      ip: req.ip,
    });
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
