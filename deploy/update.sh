#!/usr/bin/env bash
# Aktualisiert eine bestehende EKats-Installation: git pull, Abhaengigkeiten, Migration, Neustart.
# Nutzung auf dem Server: cd /var/www/EKats && sudo bash deploy/update.sh
#
# Aendert NICHT die .env oder die Apache-Konfiguration - nur Code-Update + Migration + Neustart des
# systemd-Service. Fuer die Erstinstallation stattdessen deploy/install.sh verwenden.

set -euo pipefail

log() { echo -e "\n==> $*"; }

[ "$(id -u)" -eq 0 ] || { echo "Bitte als root ausfuehren (sudo bash deploy/update.sh)." >&2; exit 1; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$REPO_DIR/backend"
SERVICE_USER="$(systemctl show -p User --value ekats 2>/dev/null || echo ekats)"

log "git pull (Branch: $(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD))"
git -C "$REPO_DIR" pull --ff-only

log "npm-Abhaengigkeiten aktualisieren"
(cd "$BACKEND_DIR" && npm ci)

log "Datenbank-Schema migrieren (nur additive, idempotente Aenderungen - CREATE TABLE IF NOT EXISTS)"
(cd "$BACKEND_DIR" && npm run migrate)

log "Dateirechte auffrischen"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "$REPO_DIR"

log "Service neu starten"
systemctl restart ekats
sleep 2
systemctl --no-pager status ekats | head -10

PORT_FOR_CHECK="$(grep -E '^PORT=' "$BACKEND_DIR/.env" | cut -d= -f2-)"
if curl -sf "http://127.0.0.1:${PORT_FOR_CHECK}/api/health" >/dev/null; then
  log "Update abgeschlossen, Backend antwortet."
else
  echo "!! Backend antwortet nicht nach dem Update. Logs pruefen: journalctl -u ekats -n 50 --no-pager" >&2
  exit 1
fi
