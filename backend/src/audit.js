const { query } = require('./db');

// Schreibt einen Audit-Log-Eintrag fuer sicherheitsrelevante Aktionen (DSGVO-Rechenschaftspflicht
// + Vorfall-Forensik, siehe backend/sql/migrations/005_add_security_hardening.sql). Bewusst
// "fire-and-forget mit Fehler-Log": ein Logging-Fehler darf niemals die eigentliche Aktion
// (z.B. Nutzer loeschen) zum Scheitern bringen.
async function logAudit({ wehrId, actorUserId, actorEmail, action, targetType, targetId, details, ip }) {
  try {
    await query(
      `INSERT INTO audit_log (wehr_id, actor_user_id, actor_email, action, target_type, target_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        wehrId ?? null,
        actorUserId ?? null,
        actorEmail ?? null,
        action,
        targetType ?? null,
        targetId !== undefined && targetId !== null ? String(targetId) : null,
        JSON.stringify(details ?? {}),
        ip ?? null,
      ]
    );
  } catch (err) {
    console.error('[audit] Log-Eintrag fehlgeschlagen:', err.message);
  }
}

module.exports = { logAudit };
