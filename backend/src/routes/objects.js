const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const { z } = require('zod');
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const config = require('../config');
const { logAudit } = require('../audit');

const router = express.Router();
router.use(requireAuth);

const CATEGORIES = ['schule_kita', 'krankenhaus_pflege', 'industrie_gefahrstoff', 'versammlungsstaette', 'sonstiges'];

const SELECT_COLUMNS = `
  id, name, category, address, hazards, access_info, contact_name, contact_phone, notes,
  review_interval_months, last_reviewed_at,
  CASE WHEN review_interval_months IS NOT NULL
    THEN COALESCE(last_reviewed_at, created_at) + (review_interval_months || ' months')::interval
    ELSE NULL
  END AS next_review_at,
  created_by, created_at, updated_at, ST_Y(geom) AS lat, ST_X(geom) AS lon
`;

// Stellt sicher, dass ein Objekt existiert UND der eigenen Wehr gehoert - von allen Unterrouten
// (Aufgaben/Anhaenge/PDF) genutzt, damit niemand per erratener ID auf fremde Wehr-Objekte zugreift.
async function loadOwnedObject(objectId, wehrId) {
  const { rows } = await query('SELECT id, name, address FROM critical_object WHERE id = $1 AND wehr_id = $2', [
    objectId,
    wehrId,
  ]);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Objekte (Kernfelder)
// ---------------------------------------------------------------------------

// Alle Rollen (auch "mitglied") duerfen kritische Objekte der eigenen Wehr sehen - das Wissen
// darum ist im Einsatz fuer jeden relevant, nur das Anlegen/Aendern ist stab/admin vorbehalten.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ${SELECT_COLUMNS} FROM critical_object WHERE wehr_id = $1 ORDER BY name`,
      [req.user.wehrId]
    );
    return res.json({ ok: true, data: rows });
  } catch (err) {
    return next(err);
  }
});

// Vollstaendiger Export aller Objektdaten inkl. Aufgaben und Anhangs-Metadaten (nicht die
// Binaerdateien selbst - die werden einzeln ueber den Download-Endpunkt geholt).
router.get('/export', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const { rows: objects } = await query(
      `SELECT ${SELECT_COLUMNS} FROM critical_object WHERE wehr_id = $1 ORDER BY name`,
      [req.user.wehrId]
    );
    const { rows: tasks } = await query(
      `SELECT t.id, t.critical_object_id, t.title, t.description, t.sort_order,
              t.vehicle_id, v.name AS vehicle_name, t.station_id, s.name AS station_name
       FROM critical_object_task t
       JOIN critical_object o ON o.id = t.critical_object_id
       LEFT JOIN vehicle v ON v.id = t.vehicle_id
       LEFT JOIN station s ON s.id = t.station_id
       WHERE o.wehr_id = $1
       ORDER BY t.critical_object_id, t.sort_order`,
      [req.user.wehrId]
    );
    const { rows: attachments } = await query(
      `SELECT a.id, a.critical_object_id, a.filename, a.mime_type, a.size_bytes, a.uploaded_at
       FROM critical_object_attachment a
       JOIN critical_object o ON o.id = a.critical_object_id
       WHERE o.wehr_id = $1
       ORDER BY a.critical_object_id, a.uploaded_at`,
      [req.user.wehrId]
    );

    const tasksByObject = new Map();
    tasks.forEach((t) => {
      if (!tasksByObject.has(t.critical_object_id)) tasksByObject.set(t.critical_object_id, []);
      tasksByObject.get(t.critical_object_id).push(t);
    });
    const attachmentsByObject = new Map();
    attachments.forEach((a) => {
      if (!attachmentsByObject.has(a.critical_object_id)) attachmentsByObject.set(a.critical_object_id, []);
      attachmentsByObject.get(a.critical_object_id).push(a);
    });

    const exportData = {
      exportedAt: new Date().toISOString(),
      objects: objects.map((o) => ({
        ...o,
        tasks: tasksByObject.get(o.id) || [],
        attachments: attachmentsByObject.get(o.id) || [],
      })),
    };

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ekats-objekte-export-${Date.now()}.json"`);
    return res.send(JSON.stringify(exportData, null, 2));
  } catch (err) {
    return next(err);
  }
});

const objectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.enum(CATEGORIES).optional().default('sonstiges'),
  address: z.string().trim().max(300).nullable().optional(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  hazards: z.string().trim().max(2000).nullable().optional(),
  accessInfo: z.string().trim().max(2000).nullable().optional(),
  contactName: z.string().trim().max(200).nullable().optional(),
  contactPhone: z.string().trim().max(50).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  reviewIntervalMonths: z.number().int().positive().nullable().optional(),
});

router.post('/', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const parsed = objectSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const d = parsed.data;
    const { rows } = await query(
      `INSERT INTO critical_object
         (wehr_id, name, category, address, geom, hazards, access_info, contact_name, contact_phone, notes,
          review_interval_months, created_by)
       VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326), $7, $8, $9, $10, $11, $12, $13)
       RETURNING ${SELECT_COLUMNS}`,
      [
        req.user.wehrId,
        d.name,
        d.category,
        d.address || null,
        d.lon,
        d.lat,
        d.hazards || null,
        d.accessInfo || null,
        d.contactName || null,
        d.contactPhone || null,
        d.notes || null,
        d.reviewIntervalMonths || null,
        req.user.id,
      ]
    );
    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

const updateSchema = objectSchema.partial();

router.patch('/:id', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const d = parsed.data;
    const setClauses = [];
    const params = [];

    const simpleColumns = {
      name: 'name',
      category: 'category',
      address: 'address',
      hazards: 'hazards',
      accessInfo: 'access_info',
      contactName: 'contact_name',
      contactPhone: 'contact_phone',
      notes: 'notes',
      reviewIntervalMonths: 'review_interval_months',
    };
    for (const [key, column] of Object.entries(simpleColumns)) {
      if (d[key] !== undefined) {
        params.push(d[key] || null);
        setClauses.push(`${column} = $${params.length}`);
      }
    }
    if (d.lat !== undefined && d.lon !== undefined) {
      params.push(d.lon, d.lat);
      setClauses.push(`geom = ST_SetSRID(ST_MakePoint($${params.length - 1}, $${params.length}), 4326)`);
    }
    if (setClauses.length === 0) {
      return res.status(400).json({ ok: false, error: 'Keine Aenderungen angegeben.' });
    }
    setClauses.push('updated_at = now()');

    params.push(req.params.id, req.user.wehrId);
    const { rows } = await query(
      `UPDATE critical_object SET ${setClauses.join(', ')}
       WHERE id = $${params.length - 1} AND wehr_id = $${params.length}
       RETURNING ${SELECT_COLUMNS}`,
      params
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Objekt nicht gefunden.' });
    }
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/mark-reviewed', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE critical_object SET last_reviewed_at = now(), updated_at = now()
       WHERE id = $1 AND wehr_id = $2
       RETURNING ${SELECT_COLUMNS}`,
      [req.params.id, req.user.wehrId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Objekt nicht gefunden.' });
    }
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query('DELETE FROM critical_object WHERE id = $1 AND wehr_id = $2 RETURNING name', [
      req.params.id,
      req.user.wehrId,
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Objekt nicht gefunden.' });
    }
    await logAudit({
      wehrId: req.user.wehrId,
      actorUserId: req.user.id,
      actorEmail: req.user.email,
      action: 'object.delete',
      targetType: 'critical_object',
      targetId: req.params.id,
      details: { name: rows[0].name },
      ip: req.ip,
    });
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Aufgaben je Objekt (Fahrzeug ODER Wache zugeordnet)
// ---------------------------------------------------------------------------

router.get('/:id/tasks', async (req, res, next) => {
  try {
    const object = await loadOwnedObject(req.params.id, req.user.wehrId);
    if (!object) return res.status(404).json({ ok: false, error: 'Objekt nicht gefunden.' });

    const { rows } = await query(
      `SELECT t.id, t.title, t.description, t.sort_order, t.vehicle_id, v.name AS vehicle_name,
              t.station_id, s.name AS station_name, t.created_at, t.updated_at
       FROM critical_object_task t
       LEFT JOIN vehicle v ON v.id = t.vehicle_id
       LEFT JOIN station s ON s.id = t.station_id
       WHERE t.critical_object_id = $1
       ORDER BY t.sort_order, t.id`,
      [req.params.id]
    );
    return res.json({ ok: true, data: rows });
  } catch (err) {
    return next(err);
  }
});

// Basis-Objekt separat von .refine() halten: ZodEffects (das Ergebnis von .refine()) hat kein
// .partial() mehr - die PATCH-Route braucht aber die ungepruefte Basis, weil ein Teil-Update
// (z.B. nur der Titel) nicht zwingend beide Zuordnungsfelder mitschickt.
const taskBaseSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).nullable().optional(),
  vehicleId: z.number().int().nullable().optional(),
  stationId: z.number().int().nullable().optional(),
  sortOrder: z.number().int().optional().default(0),
});
const taskSchema = taskBaseSchema.refine((d) => (d.vehicleId ? !d.stationId : !!d.stationId), {
  message: 'Genau eines von vehicleId/stationId muss gesetzt sein.',
});

// Prueft, dass das referenzierte Fahrzeug/die Wache existiert UND der eigenen Wehr gehoert - sonst
// koennte eine erratene fremde ID entweder in einem rohen FK-Fehler (500) enden oder, schlimmer,
// eine Aufgabe klaglos mit dem Fahrzeug/der Wache einer fremden Wehr verknuepfen.
async function assertOwnedTaskTarget(vehicleId, stationId, wehrId) {
  if (vehicleId) {
    const { rows } = await query('SELECT id FROM vehicle WHERE id = $1 AND wehr_id = $2', [vehicleId, wehrId]);
    return rows.length > 0;
  }
  if (stationId) {
    const { rows } = await query('SELECT id FROM station WHERE id = $1 AND wehr_id = $2', [stationId, wehrId]);
    return rows.length > 0;
  }
  return true;
}

router.post('/:id/tasks', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const object = await loadOwnedObject(req.params.id, req.user.wehrId);
    if (!object) return res.status(404).json({ ok: false, error: 'Objekt nicht gefunden.' });

    const parsed = taskSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const d = parsed.data;
    if (!(await assertOwnedTaskTarget(d.vehicleId, d.stationId, req.user.wehrId))) {
      return res.status(400).json({ ok: false, error: 'Fahrzeug/Wache nicht gefunden.' });
    }
    const { rows } = await query(
      `INSERT INTO critical_object_task (critical_object_id, vehicle_id, station_id, title, description, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, description, sort_order, vehicle_id, station_id, created_at, updated_at`,
      [req.params.id, d.vehicleId || null, d.stationId || null, d.title, d.description || null, d.sortOrder]
    );
    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id/tasks/:taskId', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const object = await loadOwnedObject(req.params.id, req.user.wehrId);
    if (!object) return res.status(404).json({ ok: false, error: 'Objekt nicht gefunden.' });

    const parsed = taskBaseSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const d = parsed.data;
    if (
      (d.vehicleId !== undefined || d.stationId !== undefined) &&
      !(await assertOwnedTaskTarget(d.vehicleId, d.stationId, req.user.wehrId))
    ) {
      return res.status(400).json({ ok: false, error: 'Fahrzeug/Wache nicht gefunden.' });
    }
    const setClauses = [];
    const params = [];
    const columnMap = { title: 'title', description: 'description', vehicleId: 'vehicle_id', stationId: 'station_id', sortOrder: 'sort_order' };
    for (const [key, column] of Object.entries(columnMap)) {
      if (d[key] !== undefined) {
        params.push(d[key] === '' ? null : d[key]);
        setClauses.push(`${column} = $${params.length}`);
      }
    }
    if (setClauses.length === 0) {
      return res.status(400).json({ ok: false, error: 'Keine Aenderungen angegeben.' });
    }
    setClauses.push('updated_at = now()');
    params.push(req.params.taskId, req.params.id);
    const { rows } = await query(
      `UPDATE critical_object_task SET ${setClauses.join(', ')}
       WHERE id = $${params.length - 1} AND critical_object_id = $${params.length}
       RETURNING id, title, description, sort_order, vehicle_id, station_id, created_at, updated_at`,
      params
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Aufgabe nicht gefunden.' });
    }
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id/tasks/:taskId', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const object = await loadOwnedObject(req.params.id, req.user.wehrId);
    if (!object) return res.status(404).json({ ok: false, error: 'Objekt nicht gefunden.' });

    const { rowCount } = await query(
      'DELETE FROM critical_object_task WHERE id = $1 AND critical_object_id = $2',
      [req.params.taskId, req.params.id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Aufgabe nicht gefunden.' });
    }
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// PDF-Aufgabenzettel je Fahrzeug/Wache
// ---------------------------------------------------------------------------

function renderTasksPdf(res, { objectName, objectAddress, targetLabel, tasks }) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="einsatzplan-${objectName.replace(/[^a-z0-9]+/gi, '_')}-${targetLabel.replace(/[^a-z0-9]+/gi, '_')}.pdf"`
  );

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  doc.fontSize(18).text('Einsatzplan-Aufgabenzettel', { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(14).text(objectName);
  if (objectAddress) doc.fontSize(10).fillColor('#555').text(objectAddress);
  doc.moveDown(0.3);
  doc.fontSize(12).fillColor('#000').text(`Fuer: ${targetLabel}`);
  doc.fontSize(9).fillColor('#888').text(`Erstellt: ${new Date().toLocaleString('de-DE')}`);
  doc.moveDown();

  if (tasks.length === 0) {
    doc.fontSize(11).fillColor('#000').text('Keine Aufgaben hinterlegt.');
  } else {
    tasks.forEach((task, i) => {
      doc.fontSize(12).fillColor('#000').text(`${i + 1}. ${task.title}`);
      if (task.description) {
        doc.fontSize(10).fillColor('#333').text(task.description, { indent: 15 });
      }
      doc.moveDown(0.5);
    });
  }

  doc.end();
}

router.get('/:id/tasks/vehicle/:vehicleId/pdf', async (req, res, next) => {
  try {
    const object = await loadOwnedObject(req.params.id, req.user.wehrId);
    if (!object) return res.status(404).json({ ok: false, error: 'Objekt nicht gefunden.' });

    const { rows: vehicleRows } = await query('SELECT name FROM vehicle WHERE id = $1 AND wehr_id = $2', [
      req.params.vehicleId,
      req.user.wehrId,
    ]);
    if (vehicleRows.length === 0) return res.status(404).json({ ok: false, error: 'Fahrzeug nicht gefunden.' });

    const { rows: tasks } = await query(
      'SELECT title, description FROM critical_object_task WHERE critical_object_id = $1 AND vehicle_id = $2 ORDER BY sort_order, id',
      [req.params.id, req.params.vehicleId]
    );

    return renderTasksPdf(res, {
      objectName: object.name,
      objectAddress: object.address,
      targetLabel: `Fahrzeug ${vehicleRows[0].name}`,
      tasks,
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id/tasks/station/:stationId/pdf', async (req, res, next) => {
  try {
    const object = await loadOwnedObject(req.params.id, req.user.wehrId);
    if (!object) return res.status(404).json({ ok: false, error: 'Objekt nicht gefunden.' });

    const { rows: stationRows } = await query('SELECT name FROM station WHERE id = $1 AND wehr_id = $2', [
      req.params.stationId,
      req.user.wehrId,
    ]);
    if (stationRows.length === 0) return res.status(404).json({ ok: false, error: 'Wache nicht gefunden.' });

    const { rows: tasks } = await query(
      'SELECT title, description FROM critical_object_task WHERE critical_object_id = $1 AND station_id = $2 ORDER BY sort_order, id',
      [req.params.id, req.params.stationId]
    );

    return renderTasksPdf(res, {
      objectName: object.name,
      objectAddress: object.address,
      targetLabel: `Wache ${stationRows[0].name}`,
      tasks,
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Datei-Anhaenge (Lageplaene/Grundrisse)
// ---------------------------------------------------------------------------

fs.mkdirSync(config.uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 10);
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!config.allowedUploadMimeTypes.includes(file.mimetype)) {
      return cb(new Error(`Dateityp ${file.mimetype} nicht erlaubt.`));
    }
    return cb(null, true);
  },
});

router.get('/:id/attachments', async (req, res, next) => {
  try {
    const object = await loadOwnedObject(req.params.id, req.user.wehrId);
    if (!object) return res.status(404).json({ ok: false, error: 'Objekt nicht gefunden.' });

    const { rows } = await query(
      `SELECT id, filename, mime_type, size_bytes, uploaded_by, uploaded_at
       FROM critical_object_attachment WHERE critical_object_id = $1 ORDER BY uploaded_at`,
      [req.params.id]
    );
    return res.json({ ok: true, data: rows });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/attachments', requireRole('stab', 'admin'), (req, res, next) => {
  upload.single('file')(req, res, async (uploadErr) => {
    try {
      if (uploadErr) {
        return res.status(400).json({ ok: false, error: uploadErr.message });
      }
      if (!req.file) {
        return res.status(400).json({ ok: false, error: 'Keine Datei hochgeladen.' });
      }
      const object = await loadOwnedObject(req.params.id, req.user.wehrId);
      if (!object) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ ok: false, error: 'Objekt nicht gefunden.' });
      }

      const { rows } = await query(
        `INSERT INTO critical_object_attachment
           (critical_object_id, filename, mime_type, size_bytes, storage_key, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, filename, mime_type, size_bytes, uploaded_by, uploaded_at`,
        [req.params.id, req.file.originalname, req.file.mimetype, req.file.size, req.file.filename, req.user.id]
      );
      return res.status(201).json({ ok: true, data: rows[0] });
    } catch (err) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return next(err);
    }
  });
});

router.get('/:id/attachments/:attachmentId/file', async (req, res, next) => {
  try {
    const object = await loadOwnedObject(req.params.id, req.user.wehrId);
    if (!object) return res.status(404).json({ ok: false, error: 'Objekt nicht gefunden.' });

    const { rows } = await query(
      'SELECT filename, mime_type, storage_key FROM critical_object_attachment WHERE id = $1 AND critical_object_id = $2',
      [req.params.attachmentId, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Anhang nicht gefunden.' });

    const attachment = rows[0];
    const filePath = path.join(config.uploadDir, attachment.storage_key);
    res.setHeader('Content-Type', attachment.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${attachment.filename.replace(/"/g, '')}"`);
    return res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) next(err);
    });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id/attachments/:attachmentId', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const object = await loadOwnedObject(req.params.id, req.user.wehrId);
    if (!object) return res.status(404).json({ ok: false, error: 'Objekt nicht gefunden.' });

    const { rows } = await query(
      'DELETE FROM critical_object_attachment WHERE id = $1 AND critical_object_id = $2 RETURNING storage_key',
      [req.params.attachmentId, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Anhang nicht gefunden.' });

    fs.unlink(path.join(config.uploadDir, rows[0].storage_key), () => {});
    return res.json({ ok: true, data: null });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
