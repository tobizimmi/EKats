const fs = require('fs');
const path = require('path');
const { pool, query } = require('./db');

// Baseline (sql/schema.sql) + inkrementelle Migrationen (sql/migrations/NNN_*.sql).
//
// sql/schema.sql spiegelt IMMER den aktuellen Soll-Zustand fuer eine brandneue, leere Datenbank
// wider. sql/migrations/ enthaelt nur die Deltas, die eine bereits laufende (aeltere) Installation
// auf denselben Stand bringen - z.B. die produktive zimmimail.de-Instanz, die schon vor Einfuehrung
// der Admin-Rolle existierte. Jede Migration wird per schema_migrations genau einmal ausgefuehrt.
//
// Bei einer frischen Datenbank enthaelt schema.sql bereits den Endzustand aller Migrationen -
// diese werden dort nur als "bereits angewendet" vermerkt, nicht nochmal ausgefuehrt (sonst z.B.
// doppelte ALTER TABLE ... DROP CONSTRAINT-Fehler).

async function migrate() {
  await query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );

  const { rows: existingTables } = await query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_user'"
  );
  const isFreshInstall = existingTables.length === 0;

  if (isFreshInstall) {
    console.log('[migrate] frische Datenbank erkannt - fuehre Baseline sql/schema.sql aus ...');
    const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sql');
    await pool.query(fs.readFileSync(schemaPath, 'utf8'));
  }

  const migrationsDir = path.join(__dirname, '..', 'sql', 'migrations');
  const files = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
    : [];

  for (const file of files) {
    const { rows } = await query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
    if (rows.length > 0) continue;

    if (isFreshInstall) {
      // Baseline-Schema enthaelt den Endzustand bereits - nur als angewendet vermerken.
      await query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      continue;
    }

    console.log(`[migrate] wende Migration an: ${file}`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await pool.query(sql);
    await query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
  }

  console.log('[migrate] fertig.');
}

if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error('[migrate] Fehler:', err);
      process.exitCode = 1;
      return pool.end();
    });
}

module.exports = { migrate };
