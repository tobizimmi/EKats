const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function migrate() {
  const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  console.log('[migrate] fuehre sql/schema.sql aus ...');
  await pool.query(sql);
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
