// Feature-Zugriffssteuerung (Konzept "Offene Entscheidungen" Punkt 1): prueft, ob ein Nutzer Zugriff
// auf ein optionales/kostenpflichtiges Feature (aktuell: 'kachelmann') hat. Siehe Migration 009 fuer
// die Tabellen und die Zugriffslogik im Kommentar dort.
const { query } = require('../db');

async function hasFeatureAccess(userId, role, wehrId, featureKey) {
  const { rows: userRows } = await query(
    'SELECT enabled FROM user_feature_access WHERE user_id = $1 AND feature_key = $2',
    [userId, featureKey]
  );
  if (userRows.length > 0) {
    // Individueller Override schlaegt die Rollenfreigabe in beide Richtungen (sperren wie erlauben).
    return userRows[0].enabled === true;
  }

  const { rows: roleRows } = await query(
    'SELECT 1 FROM wehr_feature_role_access WHERE wehr_id = $1 AND feature_key = $2 AND role = $3',
    [wehrId, featureKey, role]
  );
  return roleRows.length > 0;
}

module.exports = { hasFeatureAccess };
