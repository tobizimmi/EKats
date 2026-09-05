const { query } = require('../db');

// Gemeinsames internes Format, das jeder Fetcher liefern muss (siehe CLAUDE.md Abschnitt 2.3):
//   source, external_id, title, lat, lon, value_numeric, unit, severity, item_timestamp,
//   valid_until (optional), payload (Rohdaten/Zusatzfelder als Objekt)
//
// upsertDatapoints() schreibt eine Liste normalisierter Items in `live_datapoint`. Der UNIQUE-
// Constraint auf (source, external_id) sorgt dafuer, dass ein wiederholter Fetch bestehende
// Zeilen aktualisiert statt Duplikate anzulegen. Gibt die geschriebenen Zeilen (inkl. id) zurueck,
// damit notifications/evaluate.js direkt im Anschluss Schwellenwerte gegen sie pruefen kann.
async function upsertDatapoints(items) {
  const rows = [];
  for (const item of items) {
    const geomParam =
      item.lat !== null && item.lat !== undefined && item.lon !== null && item.lon !== undefined
        ? [item.lon, item.lat]
        : null;

    const { rows: inserted } = await query(
      `INSERT INTO live_datapoint
         (source, external_id, title, geom, value_numeric, unit, severity, item_timestamp, valid_until, payload, fetched_at)
       VALUES
         ($1, $2, $3,
          CASE WHEN $4::double precision IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($4, $5), 4326) END,
          $6, $7, $8, $9, $10, $11::jsonb, now())
       ON CONFLICT (source, external_id) DO UPDATE SET
         title = EXCLUDED.title,
         geom = EXCLUDED.geom,
         value_numeric = EXCLUDED.value_numeric,
         unit = EXCLUDED.unit,
         severity = EXCLUDED.severity,
         item_timestamp = EXCLUDED.item_timestamp,
         valid_until = EXCLUDED.valid_until,
         payload = EXCLUDED.payload,
         fetched_at = now()
       RETURNING id, source, external_id, title, value_numeric, unit, severity, item_timestamp, payload,
                 ST_Y(geom) AS lat, ST_X(geom) AS lon`,
      [
        item.source,
        item.external_id,
        item.title ?? null,
        geomParam ? geomParam[0] : null,
        geomParam ? geomParam[1] : null,
        item.value_numeric ?? null,
        item.unit ?? null,
        item.severity ?? null,
        item.item_timestamp ?? null,
        item.valid_until ?? null,
        JSON.stringify(item.payload ?? {}),
      ]
    );
    rows.push(inserted[0]);
  }
  return rows;
}

module.exports = { upsertDatapoints };
