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
const { renderHtmlToPdf } = require('../pdf/renderHtml');

const router = express.Router();
router.use(requireAuth);

const CATEGORIES = ['schule_kita', 'krankenhaus_pflege', 'industrie_gefahrstoff', 'versammlungsstaette', 'sonstiges'];

const SELECT_COLUMNS = `
  id, name, category, address, street, house_number, postal_code, city, district,
  hazards, access_info, contact_name, contact_phone, contact_email, emergency_phone, notes,
  review_interval_months, last_reviewed_at,
  CASE WHEN review_interval_months IS NOT NULL
    THEN COALESCE(last_reviewed_at, created_at) + (review_interval_months || ' months')::interval
    ELSE NULL
  END AS next_review_at,
  has_official_plan, has_fw_plan, plan_date, plan_creator,
  fire_water_supply_type, fire_water_supply_capacity_lpm, fire_water_supply_location,
  fire_alarm_system, fire_alarm_monitoring_station, occupant_count_max, elevators,
  smoke_heat_exhaust_system, pv_battery_system, pv_battery_disconnect_location, assembly_point,
  built_year, floors, area, special_features, custom_fields,
  created_by, created_at, updated_at, ST_Y(geom) AS lat, ST_X(geom) AS lon
`;

const FIRE_WATER_SUPPLY_TYPES = [
  'hydrant_unterflur', 'hydrant_ueberflur', 'loeschwasserbrunnen',
  'zisterne', 'loeschteich', 'offenes_gewaesser', 'keine_angabe',
];

// Validiert critical_object.custom_fields gegen die je Wehr definierten object_field_definition-
// Zeilen (Migration 008): unbekannte Keys, falscher Typ oder fehlende Pflichtfelder -> 400 statt
// stillschweigend falsche/unvollstaendige Daten zu speichern.
async function validateCustomFields(customFields, wehrId) {
  if (customFields === undefined) return { ok: true, value: undefined };

  const { rows: definitions } = await query(
    'SELECT key, label, field_type, options, required FROM object_field_definition WHERE wehr_id = $1',
    [wehrId]
  );
  const byKey = new Map(definitions.map((d) => [d.key, d]));

  for (const key of Object.keys(customFields || {})) {
    if (!byKey.has(key)) {
      return { ok: false, error: `Unbekanntes Zusatzfeld: "${key}".` };
    }
  }

  for (const def of definitions) {
    const value = customFields ? customFields[def.key] : undefined;
    if (def.required && (value === undefined || value === null || value === '')) {
      return { ok: false, error: `Pflichtfeld "${def.label}" fehlt.` };
    }
    if (value === undefined || value === null || value === '') continue;

    if (def.field_type === 'number' && typeof value !== 'number') {
      return { ok: false, error: `"${def.label}" muss eine Zahl sein.` };
    }
    if (def.field_type === 'boolean' && typeof value !== 'boolean') {
      return { ok: false, error: `"${def.label}" muss ein Wahrheitswert sein.` };
    }
    if ((def.field_type === 'text' || def.field_type === 'textarea' || def.field_type === 'date') && typeof value !== 'string') {
      return { ok: false, error: `"${def.label}" muss Text sein.` };
    }
    if (def.field_type === 'select') {
      const allowed = (def.options || []).map((o) => o.value);
      if (!allowed.includes(value)) {
        return { ok: false, error: `"${def.label}": ungueltiger Wert.` };
      }
    }
  }

  return { ok: true, value: customFields || {} };
}

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
  // Strukturierte Adresse (Nutzerwunsch, angelehnt an das urspruengliche lokale
  // Feuerwehr-Objektverwaltungstool) - ergaenzt "address" (bleibt als freie Anzeige-/Fallback-Zeile
  // erhalten, siehe Migration 015), ersetzt es aber nicht.
  street: z.string().trim().max(200).nullable().optional(),
  houseNumber: z.string().trim().max(20).nullable().optional(),
  postalCode: z.string().trim().max(10).nullable().optional(),
  city: z.string().trim().max(200).nullable().optional(),
  district: z.string().trim().max(200).nullable().optional(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  hazards: z.string().trim().max(2000).nullable().optional(),
  accessInfo: z.string().trim().max(2000).nullable().optional(),
  contactName: z.string().trim().max(200).nullable().optional(),
  contactPhone: z.string().trim().max(50).nullable().optional(),
  contactEmail: z.string().trim().max(200).nullable().optional(),
  emergencyPhone: z.string().trim().max(50).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  reviewIntervalMonths: z.number().int().positive().nullable().optional(),
  // Planstatus (Nutzerwunsch, angelehnt an das urspruengliche lokale Tool): getrennt vom
  // Ueberpruefungs-Turnus oben - dort geht es um WANN zuletzt begangen, hier um OB/WANN ein
  // Feuerwehrplan fuer das Objekt existiert.
  hasOfficialPlan: z.boolean().nullable().optional(),
  hasFwPlan: z.boolean().nullable().optional(),
  planDate: z.string().trim().max(30).nullable().optional(),
  planCreator: z.string().trim().max(200).nullable().optional(),
  // Standardfelder (Migration 008, recherchiert gegen DIN 14095 "Allgemeine Objektinformationen" -
  // siehe Kommentar in der Migration fuer die Quellenlage).
  fireWaterSupplyType: z.enum(FIRE_WATER_SUPPLY_TYPES).nullable().optional(),
  fireWaterSupplyCapacityLpm: z.number().int().min(0).nullable().optional(),
  fireWaterSupplyLocation: z.string().trim().max(300).nullable().optional(),
  fireAlarmSystem: z.boolean().nullable().optional(),
  fireAlarmMonitoringStation: z.string().trim().max(200).nullable().optional(),
  occupantCountMax: z.number().int().min(0).nullable().optional(),
  elevators: z.boolean().nullable().optional(),
  smokeHeatExhaustSystem: z.boolean().nullable().optional(),
  pvBatterySystem: z.boolean().nullable().optional(),
  pvBatteryDisconnectLocation: z.string().trim().max(300).nullable().optional(),
  assemblyPoint: z.string().trim().max(300).nullable().optional(),
  builtYear: z.number().int().min(1000).max(2100).nullable().optional(),
  // floors/area bewusst Text statt Zahl (siehe Migration 015) - in der Praxis oft mit
  // Zusatzangabe erfasst ("3 (EG + 2 OG)", "ca. 2.500 qm") statt als reine Zahl.
  floors: z.string().trim().max(50).nullable().optional(),
  area: z.string().trim().max(50).nullable().optional(),
  specialFeatures: z.string().trim().max(2000).nullable().optional(),
  customFields: z.record(z.string(), z.any()).nullable().optional(),
});

// Gemeinsame INSERT-Logik fuer POST / und POST /import (Roundtrip zum Export, siehe dort) - vermeidet
// die lange Spaltenliste zweimal zu pflegen.
async function insertObjectRow(d, customFieldsValue, wehrId, userId) {
  const { rows } = await query(
    `INSERT INTO critical_object
       (wehr_id, name, category, address, street, house_number, postal_code, city, district, geom,
        hazards, access_info, contact_name, contact_phone, contact_email, emergency_phone, notes,
        review_interval_months, has_official_plan, has_fw_plan, plan_date, plan_creator,
        fire_water_supply_type, fire_water_supply_capacity_lpm,
        fire_water_supply_location, fire_alarm_system, fire_alarm_monitoring_station,
        occupant_count_max, elevators, smoke_heat_exhaust_system, pv_battery_system,
        pv_battery_disconnect_location, assembly_point, built_year, floors, area,
        special_features, custom_fields, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ST_SetSRID(ST_MakePoint($10, $11), 4326), $12, $13,
             $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
             $31, $32, $33, $34, $35, $36, $37, $38, $39, $40)
     RETURNING ${SELECT_COLUMNS}`,
    [
      wehrId,
      d.name,
      d.category,
      d.address || null,
      d.street || null,
      d.houseNumber || null,
      d.postalCode || null,
      d.city || null,
      d.district || null,
      d.lon,
      d.lat,
      d.hazards || null,
      d.accessInfo || null,
      d.contactName || null,
      d.contactPhone || null,
      d.contactEmail || null,
      d.emergencyPhone || null,
      d.notes || null,
      d.reviewIntervalMonths || null,
      d.hasOfficialPlan ?? null,
      d.hasFwPlan ?? null,
      d.planDate || null,
      d.planCreator || null,
      d.fireWaterSupplyType || null,
      d.fireWaterSupplyCapacityLpm ?? null,
      d.fireWaterSupplyLocation || null,
      d.fireAlarmSystem ?? null,
      d.fireAlarmMonitoringStation || null,
      d.occupantCountMax ?? null,
      d.elevators ?? null,
      d.smokeHeatExhaustSystem ?? null,
      d.pvBatterySystem ?? null,
      d.pvBatteryDisconnectLocation || null,
      d.assemblyPoint || null,
      d.builtYear ?? null,
      d.floors || null,
      d.area || null,
      d.specialFeatures || null,
      JSON.stringify(customFieldsValue ?? {}),
      userId,
    ]
  );
  return rows[0];
}

router.post('/', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const parsed = objectSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }
    const d = parsed.data;

    const customFieldsResult = await validateCustomFields(d.customFields, req.user.wehrId);
    if (!customFieldsResult.ok) {
      return res.status(400).json({ ok: false, error: customFieldsResult.error });
    }

    const object = await insertObjectRow(d, customFieldsResult.value, req.user.wehrId, req.user.id);
    return res.status(201).json({ ok: true, data: object });
  } catch (err) {
    return next(err);
  }
});

// Wandelt die snake_case-Feldnamen aus dem Export (siehe SELECT_COLUMNS oben) in die camelCase-Form
// um, die objectSchema erwartet - Kehrseite von GET /export, fuer den Roundtrip beim Import.
function exportRowToObjectInput(row) {
  return {
    name: row.name,
    category: row.category,
    address: row.address,
    street: row.street,
    houseNumber: row.house_number,
    postalCode: row.postal_code,
    city: row.city,
    district: row.district,
    lat: row.lat,
    lon: row.lon,
    hazards: row.hazards,
    accessInfo: row.access_info,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    contactEmail: row.contact_email,
    emergencyPhone: row.emergency_phone,
    notes: row.notes,
    reviewIntervalMonths: row.review_interval_months,
    hasOfficialPlan: row.has_official_plan,
    hasFwPlan: row.has_fw_plan,
    planDate: row.plan_date,
    planCreator: row.plan_creator,
    fireWaterSupplyType: row.fire_water_supply_type,
    fireWaterSupplyCapacityLpm: row.fire_water_supply_capacity_lpm,
    fireWaterSupplyLocation: row.fire_water_supply_location,
    fireAlarmSystem: row.fire_alarm_system,
    fireAlarmMonitoringStation: row.fire_alarm_monitoring_station,
    occupantCountMax: row.occupant_count_max,
    elevators: row.elevators,
    smokeHeatExhaustSystem: row.smoke_heat_exhaust_system,
    pvBatterySystem: row.pv_battery_system,
    pvBatteryDisconnectLocation: row.pv_battery_disconnect_location,
    assemblyPoint: row.assembly_point,
    builtYear: row.built_year,
    floors: row.floors,
    area: row.area,
    specialFeatures: row.special_features,
    customFields: row.custom_fields,
  };
}

const importSchema = z.object({
  objects: z.array(z.record(z.string(), z.any())).max(2000),
});

// Importiert einen Export aus GET /export wieder zurueck (Nutzerwunsch: Daten online in der DB
// halten, aber zusaetzlich export-/importierbar). Jedes Objekt wird IMMER als NEUES Objekt der
// eigenen Wehr angelegt, nie per importierter id ueberschrieben - critical_object.id ist global
// (nicht je Wehr eindeutig), ein Ueberschreiben per fremder id waere sowohl ein Datenrisiko (falsches
// Objekt getroffen) als auch ein Sicherheitsrisiko (fremde-Wehr-Objekt per praeparierter id treffen).
// Aufgaben werden per Fahrzeug-/Wachenname der EIGENEN Wehr neu zugeordnet (nicht per importierter
// vehicle_id/station_id, die in der Zielinstallation etwas ganz anderes bedeuten koennten) - kein
// Namenstreffer heisst die Aufgabe wird uebersprungen und als Warnung gemeldet, nie falsch verknuepft.
// Anhaenge werden NICHT importiert: der Export enthaelt nur Metadaten, keine Binaerdateien (siehe
// Kommentar bei /export oben) - ein Eintrag ohne dahinterliegende Datei waere nur ein toter Link.
// Einzelne fehlerhafte Objekte brechen den gesamten Import nicht ab, sondern werden übersprungen und
// gesammelt gemeldet - bei z.B. 150 Objekten soll ein einzelner Tippfehler nicht die anderen 149
// blockieren.
router.post('/import', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ ok: false, error: 'Ungültiges Import-Format: erwartet wird eine Export-Datei aus "Alle Objektdaten exportieren".' });
    }

    const { rows: vehicles } = await query('SELECT id, name FROM vehicle WHERE wehr_id = $1', [req.user.wehrId]);
    const { rows: stations } = await query('SELECT id, name FROM station WHERE wehr_id = $1', [req.user.wehrId]);
    const vehicleByName = new Map(vehicles.map((v) => [v.name.trim().toLowerCase(), v.id]));
    const stationByName = new Map(stations.map((s) => [s.name.trim().toLowerCase(), s.id]));

    const imported = [];
    const errors = [];
    const taskWarnings = [];

    for (const [index, raw] of parsed.data.objects.entries()) {
      const label = raw.name || `Objekt #${index + 1}`;
      const objParsed = objectSchema.safeParse(exportRowToObjectInput(raw));
      if (!objParsed.success) {
        errors.push(`"${label}": ${objParsed.error.issues[0].message}`);
        continue;
      }
      const d = objParsed.data;

      const customFieldsResult = await validateCustomFields(d.customFields, req.user.wehrId);
      if (!customFieldsResult.ok) {
        errors.push(`"${label}": ${customFieldsResult.error}`);
        continue;
      }

      const object = await insertObjectRow(d, customFieldsResult.value, req.user.wehrId, req.user.id);
      imported.push(object);

      for (const task of Array.isArray(raw.tasks) ? raw.tasks : []) {
        const vehicleId = task.vehicle_name ? vehicleByName.get(String(task.vehicle_name).trim().toLowerCase()) : undefined;
        const stationId = task.station_name ? stationByName.get(String(task.station_name).trim().toLowerCase()) : undefined;
        if (!vehicleId && !stationId) {
          taskWarnings.push(
            `Aufgabe "${task.title}" bei "${label}" übersprungen: Fahrzeug/Wache "${task.vehicle_name || task.station_name || '?'}" nicht gefunden.`
          );
          continue;
        }
        await query(
          `INSERT INTO critical_object_task (critical_object_id, vehicle_id, station_id, title, description, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [object.id, vehicleId || null, stationId || null, task.title, task.description || null, task.sort_order || 0]
        );
      }
    }

    await logAudit({
      wehrId: req.user.wehrId,
      actorUserId: req.user.id,
      actorEmail: req.user.email,
      action: 'objects.import',
      details: { importedCount: imported.length, errorCount: errors.length, taskWarningCount: taskWarnings.length },
      ip: req.ip,
    });

    return res.json({
      ok: true,
      data: { importedCount: imported.length, objects: imported, errors, taskWarnings },
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Import aus der urspruenglichen, lokalen Feuerwehr-Objektverwaltung (Electron/Node-App des Nutzers,
// SQLite ueber sql.js - siehe deren db/database.js) - andere Anwendung, anderes Datenmodell, daher
// eigener Importer statt Wiederverwendung von POST /import oben. Dieselben Sicherheitsprinzipien wie
// dort: jedes Objekt wird IMMER neu angelegt (nie per fremder id ueberschrieben), landet in der
// eigenen Wehr, Fahrzeugaufgaben werden per Name statt fremder id neu zugeordnet, ein einzelnes
// fehlerhaftes Objekt blockiert nicht den restlichen Import.
//
// sql.js (WASM, keine native Kompilierung noetig - dieselbe Bibliothek, die das Referenz-Tool selbst
// verwendet) liest die hochgeladene .sqlite-Datei direkt aus dem Upload-Buffer, ohne sie auf Platte
// zu schreiben. Kein Netzwerkzugriff, keine Skriptausfuehrung aus der Datei - nur SELECT-Statements
// gegen ein festes, erwartetes Tabellenschema.
let sqlJsPromise = null;
function getSqlJs() {
  if (!sqlJsPromise) sqlJsPromise = require('sql.js')();
  return sqlJsPromise;
}

function sqliteAll(db, sql) {
  const stmt = db.prepare(sql);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

const sqliteUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/\.(sqlite3?|db)$/i.test(file.originalname)) {
      return cb(new Error('Bitte eine .sqlite-/.db-Datei hochladen.'));
    }
    return cb(null, true);
  },
});

// Bestmoegliche Zuordnung der im Referenz-Tool vordefinierten Objekttypen (freier Text, admin-
// konfigurierbar) auf die feste EKats-Kategorie-Enum - unbekannte/eigene Typen landen in "sonstiges"
// statt den Import mit einem Fehler abzubrechen.
const FEUERWEHRAPP_TYPE_TO_CATEGORY = {
  schule: 'schule_kita',
  'krankenhaus / pflegeeinrichtung': 'krankenhaus_pflege',
  industriebetrieb: 'industrie_gefahrstoff',
  'sport- / veranstaltungshalle': 'versammlungsstaette',
  einkaufszentrum: 'versammlungsstaette',
  'kirche / religionsstätte': 'versammlungsstaette',
  'hotel / beherbergung': 'versammlungsstaette',
};
function mapFeuerwehrappCategory(type) {
  if (!type) return 'sonstiges';
  return FEUERWEHRAPP_TYPE_TO_CATEGORY[String(type).trim().toLowerCase()] || 'sonstiges';
}

// Wandelt eine Zeile der "objects"-Tabelle des Referenz-Tools in die objectSchema-Eingabeform um.
function feuerwehrappRowToObjectInput(row) {
  return {
    name: row.name,
    category: mapFeuerwehrappCategory(row.type),
    street: row.street || null,
    houseNumber: row.house_number || null,
    postalCode: row.postal_code || null,
    city: row.city || null,
    district: row.district || null,
    lat: row.lat,
    lon: row.lng,
    contactName: row.contact_name || null,
    contactPhone: row.contact_phone || null,
    contactEmail: row.contact_email || null,
    emergencyPhone: row.emergency_phone || null,
    hasOfficialPlan: !!row.has_official_plan,
    hasFwPlan: !!row.has_fw_plan,
    planDate: row.plan_date || null,
    planCreator: row.plan_creator || null,
    builtYear: row.construction_year ? Number.parseInt(row.construction_year, 10) || null : null,
    floors: row.floors ? String(row.floors) : null,
    area: row.area ? String(row.area) : null,
    specialFeatures: row.special_features || null,
    hazards: row.hazardous_materials || null,
    accessInfo: row.access_routes || null,
    // Loeschwasserversorgung war im Referenz-Tool EIN Freitextfeld statt EKats' drei strukturierten
    // Feldern (Art/Ergiebigkeit/Lage) - bestmoeglich als Freitext in "Lage/Standort" uebernommen;
    // "Art" bleibt bewusst leer statt fälschlich "keine Angabe" zu suggerieren.
    fireWaterSupplyLocation: row.water_supply || null,
    notes: row.notes || null,
  };
}

router.post('/import-feuerwehrapp', requireRole('stab', 'admin'), (req, res, next) => {
  sqliteUpload.single('file')(req, res, async (uploadErr) => {
    try {
      if (uploadErr) {
        return res.status(400).json({ ok: false, error: uploadErr.message });
      }
      if (!req.file) {
        return res.status(400).json({ ok: false, error: 'Keine Datei hochgeladen.' });
      }

      const SQL = await getSqlJs();
      let sqliteDb;
      try {
        sqliteDb = new SQL.Database(req.file.buffer);
      } catch (err) {
        return res.status(400).json({ ok: false, error: 'Datei ist keine gültige SQLite-Datenbank.' });
      }

      let feObjects;
      let feTasks;
      let feCustomFields;
      try {
        feObjects = sqliteAll(sqliteDb, 'SELECT * FROM objects');
        feTasks = sqliteAll(
          sqliteDb,
          `SELECT ovt.object_id, ovt.task, ovt.notes, ovt.sort_order, v.name AS vehicle_name
           FROM object_vehicle_tasks ovt JOIN vehicles v ON v.id = ovt.vehicle_id`
        );
        feCustomFields = sqliteAll(sqliteDb, 'SELECT object_id, field_key, field_value FROM object_custom_fields');
      } catch (err) {
        return res.status(400).json({
          ok: false,
          error:
            'Datei enthält nicht die erwartete Tabellenstruktur (objects/object_vehicle_tasks/object_custom_fields) - ist das ein Export der lokalen Feuerwehr-Objektverwaltung?',
        });
      } finally {
        sqliteDb.close();
      }

      const tasksByObject = new Map();
      feTasks.forEach((t) => {
        if (!tasksByObject.has(t.object_id)) tasksByObject.set(t.object_id, []);
        tasksByObject.get(t.object_id).push(t);
      });
      const customFieldsByObject = new Map();
      feCustomFields.forEach((f) => {
        if (!customFieldsByObject.has(f.object_id)) customFieldsByObject.set(f.object_id, {});
        customFieldsByObject.get(f.object_id)[f.field_key] = f.field_value;
      });

      const { rows: vehicles } = await query('SELECT id, name FROM vehicle WHERE wehr_id = $1', [req.user.wehrId]);
      const vehicleByName = new Map(vehicles.map((v) => [v.name.trim().toLowerCase(), v.id]));

      const imported = [];
      const errors = [];
      const taskWarnings = [];

      for (const feObj of feObjects) {
        const label = feObj.name || `Objekt #${feObj.id}`;
        const input = feuerwehrappRowToObjectInput(feObj);
        input.customFields = customFieldsByObject.get(feObj.id) || undefined;

        const objParsed = objectSchema.safeParse(input);
        if (!objParsed.success) {
          errors.push(`"${label}": ${objParsed.error.issues[0].message}`);
          continue;
        }
        const d = objParsed.data;

        const customFieldsResult = await validateCustomFields(d.customFields, req.user.wehrId);
        if (!customFieldsResult.ok) {
          errors.push(`"${label}": ${customFieldsResult.error}`);
          continue;
        }

        const object = await insertObjectRow(d, customFieldsResult.value, req.user.wehrId, req.user.id);
        imported.push(object);

        for (const task of tasksByObject.get(feObj.id) || []) {
          const vehicleId = task.vehicle_name ? vehicleByName.get(String(task.vehicle_name).trim().toLowerCase()) : undefined;
          if (!vehicleId) {
            taskWarnings.push(
              `Aufgabe "${task.task}" bei "${label}" übersprungen: Fahrzeug "${task.vehicle_name || '?'}" nicht gefunden.`
            );
            continue;
          }
          await query(
            `INSERT INTO critical_object_task (critical_object_id, vehicle_id, station_id, title, description, sort_order)
             VALUES ($1, $2, NULL, $3, $4, $5)`,
            [object.id, vehicleId, task.task || 'Aufgabe', task.notes || null, task.sort_order || 0]
          );
        }
      }

      await logAudit({
        wehrId: req.user.wehrId,
        actorUserId: req.user.id,
        actorEmail: req.user.email,
        action: 'objects.import_feuerwehrapp',
        details: { importedCount: imported.length, errorCount: errors.length, taskWarningCount: taskWarnings.length },
        ip: req.ip,
      });

      return res.json({
        ok: true,
        data: { importedCount: imported.length, objects: imported, errors, taskWarnings },
      });
    } catch (err) {
      return next(err);
    }
  });
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
      street: 'street',
      houseNumber: 'house_number',
      postalCode: 'postal_code',
      city: 'city',
      district: 'district',
      hazards: 'hazards',
      accessInfo: 'access_info',
      contactName: 'contact_name',
      contactPhone: 'contact_phone',
      contactEmail: 'contact_email',
      emergencyPhone: 'emergency_phone',
      notes: 'notes',
      reviewIntervalMonths: 'review_interval_months',
      hasOfficialPlan: 'has_official_plan',
      hasFwPlan: 'has_fw_plan',
      planDate: 'plan_date',
      planCreator: 'plan_creator',
      fireWaterSupplyType: 'fire_water_supply_type',
      fireWaterSupplyCapacityLpm: 'fire_water_supply_capacity_lpm',
      fireWaterSupplyLocation: 'fire_water_supply_location',
      fireAlarmSystem: 'fire_alarm_system',
      fireAlarmMonitoringStation: 'fire_alarm_monitoring_station',
      occupantCountMax: 'occupant_count_max',
      elevators: 'elevators',
      smokeHeatExhaustSystem: 'smoke_heat_exhaust_system',
      pvBatterySystem: 'pv_battery_system',
      pvBatteryDisconnectLocation: 'pv_battery_disconnect_location',
      assemblyPoint: 'assembly_point',
      builtYear: 'built_year',
      floors: 'floors',
      area: 'area',
      specialFeatures: 'special_features',
    };
    // Boolean-Felder duerfen explizit auf "false" gesetzt werden - "d[key] || null" wuerde false
    // faelschlich zu null verwerfen, daher hier nur echtes undefined/null rausfiltern.
    const booleanKeys = new Set([
      'fireAlarmSystem', 'elevators', 'smokeHeatExhaustSystem', 'pvBatterySystem',
      'hasOfficialPlan', 'hasFwPlan',
    ]);
    for (const [key, column] of Object.entries(simpleColumns)) {
      if (d[key] !== undefined) {
        params.push(booleanKeys.has(key) ? d[key] : (d[key] || null));
        setClauses.push(`${column} = $${params.length}`);
      }
    }
    if (d.customFields !== undefined) {
      const customFieldsResult = await validateCustomFields(d.customFields, req.user.wehrId);
      if (!customFieldsResult.ok) {
        return res.status(400).json({ ok: false, error: customFieldsResult.error });
      }
      params.push(JSON.stringify(customFieldsResult.value ?? {}));
      setClauses.push(`custom_fields = $${params.length}`);
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

// Rendert den Aufgabenzettel entweder ueber eine hinterlegte 'task_sheet'-HTML-Vorlage (Konzept
// Teil 3) oder, falls keine existiert, wie bisher ueber pdfkit (renderTasksPdf) - keine
// Breaking-Change fuer Wehren, die (noch) keine Vorlage angelegt haben.
async function respondWithTaskSheetPdf(req, res, { objectName, objectAddress, targetTypeLabel, targetName, tasks }) {
  const { rows: templateRows } = await query(
    'SELECT html_template FROM pdf_template WHERE wehr_id = $1 AND document_type = $2',
    [req.user.wehrId, 'task_sheet']
  );

  const filenameSafe = `einsatzplan-${objectName.replace(/[^a-z0-9]+/gi, '_')}-${targetName.replace(/[^a-z0-9]+/gi, '_')}.pdf`;

  if (templateRows.length === 0) {
    return renderTasksPdf(res, {
      objectName,
      objectAddress,
      targetLabel: `${targetTypeLabel} ${targetName}`,
      tasks,
    });
  }

  const pdf = await renderHtmlToPdf(templateRows[0].html_template, {
    objekt: { name: objectName, adresse: objectAddress },
    ziel: { typ: targetTypeLabel, name: targetName },
    aufgaben: tasks.map((t, i) => ({ nr: i + 1, titel: t.title, beschreibung: t.description || '' })),
    erstellt: new Date().toLocaleString('de-DE'),
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameSafe}"`);
  return res.send(pdf);
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

    return await respondWithTaskSheetPdf(req, res, {
      objectName: object.name,
      objectAddress: object.address,
      targetTypeLabel: 'Fahrzeug',
      targetName: vehicleRows[0].name,
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

    return await respondWithTaskSheetPdf(req, res, {
      objectName: object.name,
      objectAddress: object.address,
      targetTypeLabel: 'Wache',
      targetName: stationRows[0].name,
      tasks,
    });
  } catch (err) {
    return next(err);
  }
});

// Neu (Konzept Teil 3): druckbares Objekt-Datenblatt mit allen Standard-/Zusatzfeldern. Existiert
// ohne Vorlage nicht (kein pdfkit-Fallback, da es das vorher gar nicht gab) - klare Fehlermeldung
// statt eines leeren/falschen PDFs.
const FIRE_WATER_SUPPLY_LABELS = {
  hydrant_unterflur: 'Hydrant (Unterflur)',
  hydrant_ueberflur: 'Hydrant (Überflur)',
  loeschwasserbrunnen: 'Löschwasserbrunnen',
  zisterne: 'Zisterne',
  loeschteich: 'Löschteich',
  offenes_gewaesser: 'Offenes Gewässer',
  keine_angabe: 'Keine Angabe',
};
const CATEGORY_LABELS = {
  schule_kita: 'Schule/Kita',
  krankenhaus_pflege: 'Krankenhaus/Pflegeeinrichtung',
  industrie_gefahrstoff: 'Industrie/Gefahrstoffbetrieb',
  versammlungsstaette: 'Versammlungsstätte',
  sonstiges: 'Sonstiges',
};
function boolLabel(v) {
  if (v === null || v === undefined) return '';
  return v ? 'ja' : 'nein';
}

router.get('/:id/datasheet/pdf', async (req, res, next) => {
  try {
    const { rows: templateRows } = await query(
      'SELECT html_template FROM pdf_template WHERE wehr_id = $1 AND document_type = $2',
      [req.user.wehrId, 'object_datasheet']
    );
    if (templateRows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'Keine Objekt-Datenblatt-Vorlage hinterlegt (Admin-Bereich > PDF-Vorlagen).',
      });
    }

    const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM critical_object WHERE id = $1 AND wehr_id = $2`, [
      req.params.id,
      req.user.wehrId,
    ]);
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Objekt nicht gefunden.' });
    const o = rows[0];

    const pdf = await renderHtmlToPdf(templateRows[0].html_template, {
      objekt: {
        name: o.name,
        adresse: o.address || '',
        strasse: o.street || '',
        hausnummer: o.house_number || '',
        plz: o.postal_code || '',
        ort: o.city || '',
        ortsteil: o.district || '',
        kategorie: CATEGORY_LABELS[o.category] || o.category,
        hazards: o.hazards || '',
        accessInfo: o.access_info || '',
        specialFeatures: o.special_features || '',
        contactName: o.contact_name || '',
        contactPhone: o.contact_phone || '',
        contactEmail: o.contact_email || '',
        emergencyPhone: o.emergency_phone || '',
        hasOfficialPlan: boolLabel(o.has_official_plan),
        hasFwPlan: boolLabel(o.has_fw_plan),
        planDate: o.plan_date ? new Date(o.plan_date).toLocaleDateString('de-DE') : '',
        planCreator: o.plan_creator || '',
        floors: o.floors || '',
        area: o.area || '',
        fireWaterSupplyType: FIRE_WATER_SUPPLY_LABELS[o.fire_water_supply_type] || '',
        fireWaterSupplyCapacityLpm: o.fire_water_supply_capacity_lpm ?? '',
        fireWaterSupplyLocation: o.fire_water_supply_location || '',
        fireAlarmSystem: boolLabel(o.fire_alarm_system),
        fireAlarmMonitoringStation: o.fire_alarm_monitoring_station || '',
        occupantCountMax: o.occupant_count_max ?? '',
        elevators: boolLabel(o.elevators),
        smokeHeatExhaustSystem: boolLabel(o.smoke_heat_exhaust_system),
        pvBatterySystem: boolLabel(o.pv_battery_system),
        pvBatteryDisconnectLocation: o.pv_battery_disconnect_location || '',
        assemblyPoint: o.assembly_point || '',
        builtYear: o.built_year ?? '',
      },
      erstellt: new Date().toLocaleString('de-DE'),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="objektdatenblatt-${o.name.replace(/[^a-z0-9]+/gi, '_')}.pdf"`);
    return res.send(pdf);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Kartenskizzen (Konzept Teil 2, Migration 012): mit Stift/Symbolen direkt am Objekt eingezeichnete
// Kartenausschnitte. Als GeoJSON gespeichert (nicht als Bild) - bleibt dadurch spaeter bearbeitbar.
// Eine Zeile je Objekt, PUT ersetzt den Inhalt komplett (kein Versionsverlauf fuer V1 noetig).
// ---------------------------------------------------------------------------

const EMPTY_SKETCH = { type: 'FeatureCollection', features: [] };

router.get('/:id/sketch', async (req, res, next) => {
  try {
    const object = await loadOwnedObject(req.params.id, req.user.wehrId);
    if (!object) return res.status(404).json({ ok: false, error: 'Objekt nicht gefunden.' });

    const { rows } = await query(
      'SELECT geojson, updated_at FROM critical_object_map_sketch WHERE critical_object_id = $1',
      [req.params.id]
    );
    return res.json({ ok: true, data: rows[0] || { geojson: EMPTY_SKETCH, updated_at: null } });
  } catch (err) {
    return next(err);
  }
});

// Grosszuegig, aber begrenzt (300 KB) - eine Skizze mit vielen Strichen/Symbolen soll moeglich sein,
// ohne dass die Spalte unbegrenzt wachsen kann.
const sketchSchema = z.object({
  geojson: z
    .object({ type: z.literal('FeatureCollection'), features: z.array(z.any()) })
    .refine((v) => JSON.stringify(v).length <= 300000, { message: 'Kartenskizze ist zu groß (max. 300 KB).' }),
});

router.put('/:id/sketch', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const object = await loadOwnedObject(req.params.id, req.user.wehrId);
    if (!object) return res.status(404).json({ ok: false, error: 'Objekt nicht gefunden.' });

    const parsed = sketchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
    }

    const { rows } = await query(
      `INSERT INTO critical_object_map_sketch (critical_object_id, geojson, updated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (critical_object_id) DO UPDATE SET
         geojson = EXCLUDED.geojson, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING geojson, updated_at`,
      [req.params.id, JSON.stringify(parsed.data.geojson), req.user.id]
    );
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id/sketch', requireRole('stab', 'admin'), async (req, res, next) => {
  try {
    const object = await loadOwnedObject(req.params.id, req.user.wehrId);
    if (!object) return res.status(404).json({ ok: false, error: 'Objekt nicht gefunden.' });

    await query('DELETE FROM critical_object_map_sketch WHERE critical_object_id = $1', [req.params.id]);
    return res.json({ ok: true, data: null });
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
