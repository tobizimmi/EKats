const cron = require('node-cron');
const config = require('./config');
const { query } = require('./db');
const { evaluateAlertsForSource } = require('./notifications/evaluate');

const { fetchDwdUnwetter } = require('./fetchers/dwdUnwetter');
const { fetchPegelonline } = require('./fetchers/pegelonline');
const { fetchHochwasserzentralen } = require('./fetchers/hochwasserzentralen');
const { fetchNasaFirms } = require('./fetchers/nasaFirms');
const { fetchDwdWaldbrand } = require('./fetchers/dwdWaldbrand');
const { importDwdStations } = require('./fetchers/dwdStationsImport');
const { fetchBbkWarnungen } = require('./fetchers/bbkWarnungen');
const { fetchKachelmannWarnings } = require('./fetchers/kachelmann');
const { fetchBrightskyForecast } = require('./fetchers/brightsky');

// Jeder Job laeuft isoliert: schlaegt ein Fetcher fehl (z.B. Quelle down, Format geaendert),
// sollen die anderen vier trotzdem normal weiterlaufen.
async function runJob(name, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - startedAt;
    console.log(`[scheduler] ${name} ok (${ms}ms):`, result);
    if (result?.rows?.length) {
      await evaluateAlertsForSource(result.source, result.rows);
    }
    return result;
  } catch (err) {
    console.error(`[scheduler] ${name} fehlgeschlagen:`, err.message);
    return null;
  }
}

async function cleanupOldDatapoints() {
  const { rowCount } = await query(
    `DELETE FROM live_datapoint
     WHERE fetched_at < now() - ($1 || ' days')::interval
       AND (valid_until IS NULL OR valid_until < now())`,
    [config.dataRetentionDays]
  );
  console.log(`[scheduler] cleanup: ${rowCount} alte Datenpunkte geloescht.`);

  // Pegel-Liniendiagramm-Historie (Migration 013) teilt sich dieselbe Aufbewahrungsfrist wie
  // live_datapoint - keine zweite Retention-Regel im System (Konzept Teil 2, Entscheidung
  // "Rueckblick der neuen Pegel-Historie").
  const { rowCount: historyDeleted } = await query(
    `DELETE FROM datapoint_history WHERE fetched_at < now() - ($1 || ' days')::interval`,
    [config.dataRetentionDays]
  );
  console.log(`[scheduler] cleanup: ${historyDeleted} alte Historien-Punkte geloescht.`);

  return { deleted: rowCount, historyDeleted };
}

function startScheduler() {
  cron.schedule(config.cron.dwdUnwetter, () => runJob('dwd_unwetter', fetchDwdUnwetter));
  cron.schedule(config.cron.pegelonline, () => runJob('pegelonline', fetchPegelonline));
  cron.schedule(config.cron.hochwasserzentralen, () =>
    runJob('hochwasserzentralen', fetchHochwasserzentralen)
  );
  cron.schedule(config.cron.firms, () => runJob('firms', fetchNasaFirms));
  cron.schedule(config.cron.waldbrandindex, () => runJob('waldbrandindex', fetchDwdWaldbrand));
  cron.schedule(config.cron.dwdStationsImport, () => runJob('dwd_stations_import', importDwdStations));
  cron.schedule(config.cron.bbkWarnungen, () => runJob('bbk_warnung', fetchBbkWarnungen));
  cron.schedule(config.cron.kachelmann, () => runJob('kachelmann', fetchKachelmannWarnings));
  cron.schedule(config.cron.wetterVorhersage, () => runJob('wetter_vorhersage', fetchBrightskyForecast));
  cron.schedule(config.cron.cleanup, () => runJob('cleanup', cleanupOldDatapoints));

  console.log('[scheduler] Cron-Jobs registriert:', config.cron);
}

module.exports = {
  startScheduler,
  runJob,
  cleanupOldDatapoints,
  jobs: {
    dwd_unwetter: fetchDwdUnwetter,
    pegelonline: fetchPegelonline,
    hochwasserzentralen: fetchHochwasserzentralen,
    firms: fetchNasaFirms,
    waldbrandindex: fetchDwdWaldbrand,
    dwd_stations_import: importDwdStations,
    bbk_warnung: fetchBbkWarnungen,
    kachelmann: fetchKachelmannWarnings,
    wetter_vorhersage: fetchBrightskyForecast,
  },
};
