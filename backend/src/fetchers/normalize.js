const { query } = require('../db');

// Quellen, fuer die zusaetzlich zum aktuellsten Wert (live_datapoint) auch eine Zeitreihe in
// datapoint_history mitgeschrieben wird - fuer Liniendiagramm-Widgets (Konzept Teil 2, Baustein D,
// Migration 013; js/pegel-chart.js). Bewusst als Allowlist statt fuer jede Quelle - nur Quellen mit
// einem stabilen external_id je Station/Messpunkt UND einem sich veraendernden numerischen Wert
// eignen sich fuer einen Verlauf im Liniendiagramm-Sinn:
//   pegelonline:    Pegelstand je Station - klassischer Verlauf.
//   waldbrandindex: Gefahrenindex je Station - dieselbe Eigenschaft, daher ebenfalls sinnvoll.
// Bewusst NICHT aufgenommen:
//   dwd_unwetter/bbk_warnung/hochwasserzentralen: Einzelmeldungen ohne "Verlauf" im selben Sinn.
//   firms: Hotspot-Meldungen sind je Sichtung ein neuer external_id, kein wiederkehrender Messpunkt.
//   blitzortung: dasselbe wie firms - jeder Einschlag ist ein eigenes Ereignis, keine je Station
//   wiederkehrende Messreihe. Die aktuelle Anzahl zeigt bereits das Blitz-Zähler-Dashboard-Widget
//   (js/dashboard.js) - ein "Verlauf" ueber datapoint_history wuerde hier nur die Tabelle unnoetig
//   aufblaehen, ohne eine sinnvolle Liniengrafik zu ergeben.
//   wetter_vorhersage: schreibt ohnehin schon dutzende Zukunftswerte je Fetch in live_datapoint.
const HISTORY_SOURCES = new Set(['pegelonline', 'waldbrandindex']);

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

// Bugfix (Nutzer-Report: "Warnungen werden weiterhin angezeigt, obwohl aktuell keine aktiv sind"):
// event-basierte Quellen (eine Warnung/Meldung/Sichtung je external_id, kein wiederkehrender
// Messwert wie bei pegelonline/hochwasserzentralen) melden das ENDE eines Ereignisses dadurch, dass
// es in der naechsten Abfrage einfach nicht mehr vorkommt - nicht durch ein explizites valid_until.
// upsertDatapoints() allein kann das nicht abbilden: es aktualisiert nur, was im aktuellen Fetch
// ankommt, und fasst nie die Zeilen an, die diesmal fehlen. Ohne diese Funktion blieb eine beendete
// Warnung (valid_until war fuer bbk_warnung/dwd_unwetter oft schon NULL, wenn die Quelle kein festes
// Enddatum mitliefert) bis zur naechsten retentionsbasierten Aufraeumung (Tage) sichtbar, obwohl die
// Quelle sie laengst nicht mehr fuehrt - konkret bei bbk_warnung sogar trotz eines expliziten
// CAP-"Cancel"-Nachrichtentyps, der schon ankam, aber nur uebersprungen statt verarbeitet wurde
// (siehe fetchers/bbkWarnungen.js).
//
// Aufruf NACH einem erfolgreichen upsertDatapoints() mit den external_ids, die der aktuelle Fetch
// tatsaechlich geliefert hat: setzt bei allen anderen, noch als aktiv geltenden Zeilen derselben
// Quelle valid_until = now(), wodurch der bereits ueberall vorhandene Sichtbarkeits-Filter
// ("valid_until IS NULL OR valid_until >= now()", siehe routes/datapoints.js) sie automatisch
// ausblendet - ohne die Zeile zu loeschen (Historie/Audit bleibt erhalten, die eigentliche Loeschung
// macht weiterhin nur scheduler.js::cleanupOldDatapoints() nach Ablauf der Aufbewahrungsfrist).
// Bewusst NICHT fuer kontinuierliche Messwert-Quellen (pegelonline, hochwasserzentralen,
// waldbrandindex, kachelmann, wetter_vorhersage) aufgerufen: dort hat jede Station/jeder Messpunkt
// eine dauerhaft gleichbleibende external_id und wird bei jedem Fetch ohnehin neu geschrieben - ein
// leeres/fehlgeschlagenes Ergebnis fuer eine einzelne Station wuerde sie hier faelschlich als
// "beendet" markieren, statt schlicht "diesmal nicht aktualisiert".
async function expireStaleItems(source, currentExternalIds) {
  await query(
    `UPDATE live_datapoint
     SET valid_until = now()
     WHERE source = $1
       AND external_id != ALL($2::text[])
       AND (valid_until IS NULL OR valid_until > now())`,
    [source, currentExternalIds]
  );
}

module.exports = { upsertDatapoints, expireStaleItems };
