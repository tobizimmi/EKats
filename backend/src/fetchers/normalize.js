const { query } = require('../db');

// Quellen, fuer die zusaetzlich zum aktuellsten Wert (live_datapoint) auch eine Zeitreihe in
// datapoint_history mitgeschrieben wird - fuers Pegel-Liniendiagramm-Widget (Konzept Teil 2,
// Baustein D, Migration 013). Bewusst als Allowlist statt fuer jede Quelle: ein Unwetterereignis
// oder FIRMS-Hotspot hat keinen sinnvollen "Verlauf" im Liniendiagramm-Sinn, und wetter_vorhersage
// schreibt ohnehin schon dutzende Zukunftswerte je Fetch in live_datapoint - eine ungefilterte
// History wuerde die Tabelle unnoetig aufblaehen.
const HISTORY_SOURCES = new Set(['pegelonline']);

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

    if (HISTORY_SOURCES.has(item.source) && item.value_numeric !== null && item.value_numeric !== undefined) {
      await query(
        `INSERT INTO datapoint_history (source, external_id, value_numeric, unit, item_timestamp)
         VALUES ($1, $2, $3, $4, $5)`,
        [item.source, item.external_id, item.value_numeric, item.unit ?? null, item.item_timestamp ?? null]
      );
    }
  }
  return rows;
}

module.exports = { upsertDatapoints };
