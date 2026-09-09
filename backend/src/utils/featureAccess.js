// Feature-Zugriffssteuerung (Konzept Teil 1 "Offene Entscheidungen" Punkt 1, ab Phase 5
// generalisiert auf alle Addons statt nur Kachelmann - siehe Konzept Teil 2, Baustein C). Prueft,
// ob ein Nutzer Zugriff auf ein Feature hat. Siehe Migration 009 fuer die Tabellen.
const { query } = require('../db');

// Kachelmann ist die einzige kostenpflichtige Quelle und muss deshalb OHNE konfigurierte Regel
// GESPERRT bleiben (kein versehentlicher API-Kostenanfall). Alle anderen Quellen waren vor der
// Generalisierung in Phase 5 frei zugaenglich und muessen es ohne aktive Admin-Einschraenkung auch
// bleiben - Einschraenkung ist immer ein aktiver Admin-Schritt, nie eine Voreinstellung, die durch
// das blosse Ausrollen der Zugriffssteuerung auf eine bisher freie Quelle entsteht (siehe README
// "Rechte je Nutzer und Addon", Rueckwaertskompatibilitaet).
const DEFAULT_CLOSED_FEATURES = new Set(['kachelmann']);

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
    'SELECT role FROM wehr_feature_role_access WHERE wehr_id = $1 AND feature_key = $2',
    [wehrId, featureKey]
  );
  if (roleRows.length === 0) {
    return !DEFAULT_CLOSED_FEATURES.has(featureKey);
  }
  return roleRows.some((r) => r.role === role);
}

module.exports = { hasFeatureAccess, DEFAULT_CLOSED_FEATURES };
