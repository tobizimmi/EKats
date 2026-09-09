// Health-Dashboard je Datenquelle im Admin-Bereich (Migration 016): bisher war der einzige Weg zu
// sehen, ob ein Fetcher zuverlaessig laeuft, das Server-Log - kein Admin-UI. Eine Zeile je Quelle
// (source_key aus dem gemeinsamen internen Format, siehe fetchers/normalize.js), per UPSERT nach
// jedem Lauf aktualisiert. Aufgerufen aus scheduler.js::runJob() fuer die Cron-Jobs sowie aus
// fetchers/blitzortung.js fuer dessen persistente WebSocket-Verbindung (dort bedeutet "Erfolg" ein
// erfolgreicher Flush gespeicherter Einschlaege, "Fehler" ein Verbindungsfehler - ein eigenes
// Betriebsmodell, aber dieselbe Tabelle/Anzeige).
const { query } = require('./db');

async function recordSuccess(sourceKey, { durationMs = null, writtenCount = null } = {}) {
  try {
    await query(
      `INSERT INTO fetcher_health (source_key, last_run_at, last_success_at, last_duration_ms, last_written_count)
       VALUES ($1, now(), now(), $2, $3)
       ON CONFLICT (source_key) DO UPDATE SET
         last_run_at = now(),
         last_success_at = now(),
         last_duration_ms = COALESCE(EXCLUDED.last_duration_ms, fetcher_health.last_duration_ms),
         last_written_count = COALESCE(EXCLUDED.last_written_count, fetcher_health.last_written_count)`,
      [sourceKey, durationMs, writtenCount]
    );
  } catch (err) {
    console.error(`[fetcherHealth] Konnte Erfolg fuer "${sourceKey}" nicht speichern:`, err.message);
  }
}

async function recordFailure(sourceKey, { durationMs = null, message = '' } = {}) {
  try {
    await query(
      `INSERT INTO fetcher_health (source_key, last_run_at, last_duration_ms, last_error_at, last_error_message)
       VALUES ($1, now(), $2, now(), $3)
       ON CONFLICT (source_key) DO UPDATE SET
         last_run_at = now(),
         last_duration_ms = EXCLUDED.last_duration_ms,
         last_error_at = now(),
         last_error_message = EXCLUDED.last_error_message`,
      [sourceKey, durationMs, String(message).slice(0, 2000)]
    );
  } catch (err) {
    console.error(`[fetcherHealth] Konnte Fehler fuer "${sourceKey}" nicht speichern:`, err.message);
  }
}

module.exports = { recordSuccess, recordFailure };
