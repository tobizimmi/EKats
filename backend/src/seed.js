const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { pool, query } = require('./db');
const config = require('./config');

async function seed() {
  const { rows: existingWehr } = await query('SELECT id FROM wehr ORDER BY id LIMIT 1');
  let wehrId;

  if (existingWehr.length > 0) {
    wehrId = existingWehr[0].id;
    console.log(`[seed] Wehr existiert bereits (id=${wehrId}), ueberspringe Anlage.`);
  } else {
    const { rows } = await query(
      'INSERT INTO wehr (name, center_lat, center_lon) VALUES ($1, $2, $3) RETURNING id',
      [config.seed.wehrName, config.seed.wehrLat, config.seed.wehrLon]
    );
    wehrId = rows[0].id;
    console.log(`[seed] Wehr "${config.seed.wehrName}" angelegt (id=${wehrId}).`);
  }

  const { rows: existingUser } = await query('SELECT id FROM app_user WHERE email = $1', [
    config.seed.adminEmail,
  ]);

  if (existingUser.length > 0) {
    console.log(`[seed] Nutzer ${config.seed.adminEmail} existiert bereits, ueberspringe Anlage.`);
    return;
  }

  const password = config.seed.adminPassword || crypto.randomBytes(9).toString('base64url');
  const passwordHash = await bcrypt.hash(password, 12);

  await query(
    'INSERT INTO app_user (wehr_id, email, password_hash, role) VALUES ($1, $2, $3, $4)',
    [wehrId, config.seed.adminEmail, passwordHash, 'stab']
  );

  console.log(`[seed] Stab-Account angelegt: ${config.seed.adminEmail}`);
  if (!config.seed.adminPassword) {
    console.log(
      `[seed] Kein SEED_ADMIN_PASSWORD gesetzt — zufaelliges Passwort generiert (bitte sofort notieren und nach dem ersten Login aendern):`
    );
    console.log(`[seed]   ${password}`);
  }
}

if (require.main === module) {
  seed()
    .then(() => pool.end())
    .catch((err) => {
      console.error('[seed] Fehler:', err);
      process.exitCode = 1;
      return pool.end();
    });
}

module.exports = { seed };
