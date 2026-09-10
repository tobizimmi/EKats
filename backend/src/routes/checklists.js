// Checklisten/SOPs (Migration 020): hinterlegbare Standard-Einsatz-Regeln je Objekttyp/Szenario,
// gemeinsam abhakbar. Vorlagen (checklist_template) verwalten nur stab/admin - dasselbe Muster wie
// bei Alarmregeln/Feld-Definitionen. Das Abhaken einzelner Punkte ist dagegen eine operative Aktion
// waehrend eines Einsatzes und daher fuer ALLE Rollen offen (auch 'mitglied'), anders als das
// Anlegen/Aendern/Loeschen der Vorlage selbst.
const express = require('express');
const { z } = require('zod');
const { query, withTransaction } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

async function loadTemplatesWithItems(wehrId) {
  const { rows: templates } = await query(
    `SELECT id, wehr_id, name, category, created_by, created_at, updated_at
     FROM checklist_template WHERE wehr_id = $1 ORDER BY category NULLS LAST, name`,
    [wehrId]
  );
  if (templates.length === 0) return [];

  const { rows: items } = await query(
    `SELECT id, template_id, position, text, checked, checked_by, checked_by_email, checked_at
     FROM checklist_item WHERE template_id = ANY($1::int[]) ORDER BY position, id`,
    [templates.map((t) => t.id)]
  );
  const itemsByTemplate = new Map();
  for (const item of items) {
    if (!itemsByTemplate.has(item.template_id)) itemsByTemplate.set(item.template_id, []);
    itemsByTemplate.get(item.template_id).push(item);
  }
  return templates.map((t) => ({ ...t, items: itemsByTemplate.get(t.id) || [] }));
}

router.get('/', async (req, res, next) => {
  try {
    const data = await loadTemplatesWithItems(req.user.wehrId);
    return res.json({ ok: true, data });
  } catch (err) {
    return next(err);
  }
});

const templateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100).nullable().optional(),
  items: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
});

router.post('/', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const parsed = templateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const d = parsed.data;

    const result = await withTransaction(async (client) => {
      const { rows: templateRows } = await client.query(
        `INSERT INTO checklist_template (wehr_id, name, category, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id, wehr_id, name, category, created_by, created_at, updated_at`,
        [req.user.wehrId, d.name, d.category || null, req.user.id]
      );
      const template = templateRows[0];
      const insertedItems = [];
      for (let i = 0; i < d.items.length; i += 1) {
        const { rows } = await client.query(
          `INSERT INTO checklist_item (template_id, position, text)
           VALUES ($1, $2, $3) RETURNING id, template_id, position, text, checked, checked_by, checked_by_email, checked_at`,
          [template.id, i, d.items[i]]
        );
        insertedItems.push(rows[0]);
      }
      return { ...template, items: insertedItems };
    });

    return res.status(201).json({ ok: true, data: result });
  } catch (err) {
    return next(err);
  }
});

// PATCH ersetzt Name/Kategorie/die komplette Punkteliste in einer Transaktion - einfacher und
// robuster als granulare Einzel-Item-Endpunkte fuer Umsortieren/Umbenennen/Hinzufuegen/Entfernen, auf
// Kosten des Abhak-Status: bewusst akzeptiert, ein Vorlagen-Update waehrend eines laufenden Einsatzes
// waere ohnehin ein Sonderfall, kein Regelablauf. Zum reinen Abhaken siehe PATCH /items/:id unten.
const updateSchema = templateSchema.partial();

router.patch('/:id', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const d = parsed.data;
    if (d.name === undefined && d.category === undefined && d.items === undefined) {
      return res.status(400).json({ ok: false, error: 'Keine Aenderungen angegeben.' });
    }

    const result = await withTransaction(async (client) => {
      const setClauses = [];
      const params = [];
      if (d.name !== undefined) {
        params.push(d.name);
        setClauses.push(`name = $${params.length}`);
      }
      if (d.category !== undefined) {
        params.push(d.category || null);
        setClauses.push(`category = $${params.length}`);
      }
      setClauses.push('updated_at = now()');
      params.push(req.params.id, req.user.wehrId);
      const { rows: templateRows } = await client.query(
        `UPDATE checklist_template SET ${setClauses.join(', ')}
         WHERE id = $${params.length - 1} AND wehr_id = $${params.length}
         RETURNING id, wehr_id, name, category, created_by, created_at, updated_at`,
        params
      );
      if (templateRows.length === 0) return null;
      const template = templateRows[0];

      let items;
      if (d.items !== undefined) {
        await client.query('DELETE FROM checklist_item WHERE template_id = $1', [template.id]);
        items = [];
        for (let i = 0; i < d.items.length; i += 1) {
          const { rows } = await client.query(
            `INSERT INTO checklist_item (template_id, position, text)
             VALUES ($1, $2, $3) RETURNING id, template_id, position, text, checked, checked_by, checked_by_email, checked_at`,
            [template.id, i, d.items[i]]
          );
          items.push(rows[0]);
        }
      } else {
        const { rows } = await client.query(
          `SELECT id, template_id, position, text, checked, checked_by, checked_by_email, checked_at
           FROM checklist_item WHERE template_id = $1 ORDER BY position, id`,
          [template.id]
        );
        items = rows;
      }
      return { ...template, items };
    });

    if (!result) {
      return res.status(404).json({ ok: false, error: 'Checkliste nicht gefunden.' });
    }
    return res.json({ ok: true, data: result });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const { rowCount } = await query('DELETE FROM checklist_template WHERE id = $1 AND wehr_id = $2', [
      req.params.id,
      req.user.wehrId,
    ]);
    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Checkliste nicht gefunden.' });
    }
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

// POST /:id/reset - alle Haken einer Vorlage zuruecksetzen (naechster Einsatz/naechste Uebung).
// Bewusst auf stab/admin beschraenkt: ein versehentliches Zuruecksetzen waehrend eines laufenden
// Einsatzes waere fuer 'mitglied' folgenreicher als das reine Abhaken einzelner Punkte.
router.post('/:id/reset', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const { rows: templateRows } = await query(
      'SELECT id FROM checklist_template WHERE id = $1 AND wehr_id = $2',
      [req.params.id, req.user.wehrId]
    );
    if (templateRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Checkliste nicht gefunden.' });
    }
    await query(
      `UPDATE checklist_item SET checked = false, checked_by = NULL, checked_by_email = NULL, checked_at = NULL
       WHERE template_id = $1`,
      [req.params.id]
    );
    const { rows: items } = await query(
      `SELECT id, template_id, position, text, checked, checked_by, checked_by_email, checked_at
       FROM checklist_item WHERE template_id = $1 ORDER BY position, id`,
      [req.params.id]
    );
    return res.json({ ok: true, data: items });
  } catch (err) {
    return next(err);
  }
});

const toggleSchema = z.object({ checked: z.boolean() });

// PATCH /items/:id - einzelnen Punkt abhaken/wieder freigeben. Fuer ALLE authentifizierten Rollen
// offen (kein requireRole) - das ist die eigentliche operative Nutzung der Checkliste im Einsatz.
router.patch('/items/:id', async (req, res, next) => {
  try {
    const parsed = toggleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }

    const { rows } = await query(
      `UPDATE checklist_item ci
       SET checked = $1,
           checked_by = CASE WHEN $1 THEN $2 ELSE NULL END,
           checked_by_email = CASE WHEN $1 THEN $3 ELSE NULL END,
           checked_at = CASE WHEN $1 THEN now() ELSE NULL END
       FROM checklist_template ct
       WHERE ci.id = $4 AND ci.template_id = ct.id AND ct.wehr_id = $5
       RETURNING ci.id, ci.template_id, ci.position, ci.text, ci.checked, ci.checked_by, ci.checked_by_email, ci.checked_at`,
      [parsed.data.checked, req.user.id, req.user.email, req.params.id, req.user.wehrId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Punkt nicht gefunden.' });
    }
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
