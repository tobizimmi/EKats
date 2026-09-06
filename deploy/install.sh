#!/usr/bin/env bash
# EKats-Installationsskript: richtet Datenbank, .env, systemd-Service fuer den Node-Prozess ein.
#
# Nutzung (auf dem Zielserver, als root/sudo, NACHDEM das Repo geklont wurde):
#   git clone https://github.com/tobizimmi/EKats.git /var/www/EKats
#   cd /var/www/EKats
#   sudo bash deploy/install.sh
#
# Beruehrt NICHT die bestehende Apache-Konfiguration von zimmimail.de (fremde, produktive
# Konfiguration) - dafuer siehe deploy/apache-ekats.conf.example und die Ausgabe am Skriptende.
#
# Idempotent: mehrfaches Ausfuehren ist sicher (z.B. nach einem Fehler, oder um nach einem
# "git pull" Migration/Service neu anzustossen - fuer reine Updates aber deploy/update.sh nutzen).
# Eine bereits vorhandene backend/.env wird NICHT ueberschrieben.
#
# Anpassbar per Umgebungsvariable, z.B.:
#   EKATS_PORT=3001 EKATS_ADMIN_EMAIL=wehrfuehrer@zimmimail.de sudo -E bash deploy/install.sh

set -euo pipefail

EKATS_DOMAIN="${EKATS_DOMAIN:-zimmimail.de}"
EKATS_BASE_PATH="${EKATS_BASE_PATH:-/EKats}"
EKATS_PORT="${EKATS_PORT:-3000}"
EKATS_DB_NAME="${EKATS_DB_NAME:-ekats}"
EKATS_DB_USER="${EKATS_DB_USER:-ekats}"
EKATS_SYSTEM_USER="${EKATS_SYSTEM_USER:-ekats}"
EKATS_WEHR_NAME="${EKATS_WEHR_NAME:-Freiwillige Feuerwehr}"
EKATS_ADMIN_EMAIL="${EKATS_ADMIN_EMAIL:-stab@${EKATS_DOMAIN}}"
# EKATS_ADMIN_PASSWORD / EKATS_DB_PASSWORD: leer lassen fuer automatische, zufaellige Generierung.

log()  { echo -e "\n==> $*"; }
warn() { echo -e "\n!! $*" >&2; }
die()  { echo -e "\nFEHLER: $*" >&2; exit 1; }

# Reiner TCP-Connect-Test (kein ss/netstat/lsof noetig, funktioniert auf jedem Debian/Ubuntu mit
# Bash). Wichtig auf Servern mit mehreren Diensten/Docker-Containern: ein Port kann jederzeit
# schon von etwas voellig anderem belegt sein (siehe README/Deployment-Erfahrungsbericht).
port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

[ "$(id -u)" -eq 0 ] || die "Bitte als root ausfuehren (sudo bash deploy/install.sh)."
command -v apt-get >/dev/null || die "Dieses Skript ist fuer Debian/Ubuntu (apt-get) geschrieben."

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$REPO_DIR/backend"
ENV_FILE="$BACKEND_DIR/.env"
[ -f "$BACKEND_DIR/package.json" ] || die "backend/package.json nicht gefunden unter $REPO_DIR - falsches Verzeichnis?"

# Verhindert "could not change directory ... Permission denied"-Meldungen von "sudo -u postgres":
# sudo versucht das aktuelle Arbeitsverzeichnis fuer den Zielbenutzer beizubehalten: liegt das
# Repo (wie z.B. bei Plesk ueblich) in einem Verzeichnis, in das der postgres-Systembenutzer nicht
# hineinwechseln darf, meldet sudo das (harmlos) bei jedem einzelnen Aufruf. Ab hier bewusst in
# einem neutralen Verzeichnis weiterarbeiten; alle Pfade oben wurden bereits absolut aufgeloest.
cd /

log "Installationsverzeichnis: $REPO_DIR"

if [[ "$REPO_DIR" == *"/httpdocs"* || "$REPO_DIR" == *"/httpdocs/"* ]]; then
  warn "Das Repo liegt unter einem 'httpdocs'-Verzeichnis - das ist bei Plesk/cPanel typischerweise \
der oeffentliche Webserver-Dokumentenstamm der Domain. backend/.env (Secrets!) und der gesamte \
Quellcode liegen damit im gleichen Baum, den Apache/nginx fuer die Domain ausliefert. Nur der \
ProxyPass-Reverse-Proxy fuer ${EKATS_BASE_PATH}/ (siehe deploy/apache-ekats.conf.example) verhindert \
direkten Zugriff darauf - eine Fehlkonfiguration dort wuerde die .env offenlegen. Empfehlung: das \
Repo stattdessen AUSSERHALB von httpdocs ablegen (bei Plesk z.B. im privaten Vhost-Verzeichnis, \
Geschwisterordner von httpdocs) und nur bei Bedarf per ProxyPass verlinken. Wird hier nicht \
automatisch verschoben, um keine laufende Installation zu zerstoeren."
fi

# ---------------------------------------------------------------------------
log "Pruefe/installiere Node.js (>= 20)"
NEED_NODE_INSTALL=true
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
  if [ "$NODE_MAJOR" -ge 20 ]; then
    NEED_NODE_INSTALL=false
    log "Node.js $(node -v) bereits vorhanden, ueberspringe Installation."
  fi
fi
if [ "$NEED_NODE_INSTALL" = true ]; then
  log "Installiere Node.js 20.x via NodeSource-Repository"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# ---------------------------------------------------------------------------
log "Pruefe/installiere PostgreSQL + PostGIS + Build-Werkzeuge (fuer bcrypt-Kompilierung)"
apt-get update -y
if ! command -v psql >/dev/null 2>&1; then
  apt-get install -y postgresql postgresql-contrib
fi
PG_VERSION="$(psql -V | grep -oE '[0-9]+' | head -1)"
apt-get install -y "postgresql-${PG_VERSION}-postgis-3" build-essential python3 openssl
systemctl enable --now postgresql

# ---------------------------------------------------------------------------
log "Lege Systemd-Benutzer '$EKATS_SYSTEM_USER' an (fuehrt den Node-Prozess aus, keine Login-Shell)"
if ! id -u "$EKATS_SYSTEM_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir "$BACKEND_DIR" --shell /usr/sbin/nologin "$EKATS_SYSTEM_USER"
else
  log "Benutzer '$EKATS_SYSTEM_USER' existiert bereits, ueberspringe."
fi

# ---------------------------------------------------------------------------
log "Konfiguration (.env)"
if [ -f "$ENV_FILE" ]; then
  FRESH_ENV=false
  log "Vorhandene $ENV_FILE gefunden - wird NICHT ueberschrieben, bestehende Werte werden wiederverwendet."
  existing_var() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }
  DATABASE_URL_EXISTING="$(existing_var DATABASE_URL || true)"
  EKATS_DB_USER="$(echo "$DATABASE_URL_EXISTING" | sed -E 's#^postgres://([^:]+):.*#\1#')"
  EKATS_DB_PASSWORD="$(echo "$DATABASE_URL_EXISTING" | sed -E 's#^postgres://[^:]+:([^@]+)@.*#\1#')"
  EKATS_DB_NAME="$(echo "$DATABASE_URL_EXISTING" | sed -E 's#.*/([^/?]+)$#\1#')"
  EKATS_PORT="$(existing_var PORT || echo "$EKATS_PORT")"
  ADMIN_PASSWORD_NOTE="(unveraendert, siehe vorherige Installation - bei Bedarf in $ENV_FILE nachsehen bzw. in der App aendern)"
else
  FRESH_ENV=true
  EKATS_DB_PASSWORD="${EKATS_DB_PASSWORD:-$(openssl rand -hex 24)}"
  JWT_SECRET="$(openssl rand -hex 48)"
  ADMIN_PASSWORD="${EKATS_ADMIN_PASSWORD:-$(openssl rand -base64 18)}"
  ADMIN_PASSWORD_NOTE="$ADMIN_PASSWORD"
fi

# ---------------------------------------------------------------------------
log "Datenbank/Rolle anlegen (idempotent)"
role_exists=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${EKATS_DB_USER}'")
if [ "$role_exists" != "1" ]; then
  sudo -u postgres psql -c "CREATE ROLE ${EKATS_DB_USER} LOGIN PASSWORD '${EKATS_DB_PASSWORD}';"
elif [ "$FRESH_ENV" = true ]; then
  # Rolle existiert bereits (z.B. Rest eines fruehereren, abgebrochenen Laufs), aber wir generieren
  # gerade eine NEUE .env mit einem NEUEN Passwort - ohne diesen Sync wuerde .env ein Passwort
  # enthalten, das nicht zum bestehenden Rollen-Passwort passt ("password authentication failed").
  log "Rolle '${EKATS_DB_USER}' existiert bereits - synchronisiere ihr Passwort mit der neuen .env."
  sudo -u postgres psql -c "ALTER ROLE ${EKATS_DB_USER} WITH PASSWORD '${EKATS_DB_PASSWORD}';"
else
  log "Rolle '${EKATS_DB_USER}' existiert bereits, ueberspringe."
fi
db_exists=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${EKATS_DB_NAME}'")
if [ "$db_exists" != "1" ]; then
  sudo -u postgres psql -c "CREATE DATABASE ${EKATS_DB_NAME} OWNER ${EKATS_DB_USER};"
else
  log "Datenbank '${EKATS_DB_NAME}' existiert bereits, ueberspringe."
fi
sudo -u postgres psql -d "${EKATS_DB_NAME}" -c "CREATE EXTENSION IF NOT EXISTS postgis;"
sudo -u postgres psql -d "${EKATS_DB_NAME}" -c "GRANT ALL ON SCHEMA public TO ${EKATS_DB_USER};"

# ---------------------------------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  PORT_AUTO_CHANGED=false
  if port_in_use "$EKATS_PORT"; then
    ORIGINAL_PORT="$EKATS_PORT"
    for candidate in $(seq $((EKATS_PORT + 1)) $((EKATS_PORT + 30))); do
      if ! port_in_use "$candidate"; then
        EKATS_PORT="$candidate"
        break
      fi
    done
    if [ "$EKATS_PORT" = "$ORIGINAL_PORT" ]; then
      die "Port ${ORIGINAL_PORT} und die naechsten 30 Ports sind alle belegt. Bitte EKATS_PORT explizit auf einen freien Port setzen."
    fi
    PORT_AUTO_CHANGED=true
    warn "Port ${ORIGINAL_PORT} ist bereits belegt (auf diesem Server laufen offenbar weitere \
Dienste/Docker-Container - 'sudo ss -ltnp | grep ${ORIGINAL_PORT}' zeigt was). Verwende \
stattdessen freien Port ${EKATS_PORT}. WICHTIG: das ProxyPass-Ziel in \
deploy/apache-ekats.conf.example muss diesen Port verwenden, nicht ${ORIGINAL_PORT}!"
  fi

  log "Erzeuge $ENV_FILE"
  cp "$BACKEND_DIR/.env.example" "$ENV_FILE"
  BASE_URL="https://${EKATS_DOMAIN}${EKATS_BASE_PATH}"

  # Web-Push-VAPID-Schluessel generieren (npx laedt web-push einmalig, Netzzugriff zu npm noetig).
  VAPID_JSON="$(cd "$BACKEND_DIR" && npx --yes web-push generate-vapid-keys --json 2>/dev/null || echo '{}')"
  VAPID_PUBLIC="$(echo "$VAPID_JSON" | node -e 'process.stdin.on("data",d=>{try{console.log(JSON.parse(d).publicKey||"")}catch(e){console.log("")}})' 2>/dev/null || true)"
  VAPID_PRIVATE="$(echo "$VAPID_JSON" | node -e 'process.stdin.on("data",d=>{try{console.log(JSON.parse(d).privateKey||"")}catch(e){console.log("")}})' 2>/dev/null || true)"
  [ -z "$VAPID_PUBLIC" ] && warn "VAPID-Schluessel konnten nicht automatisch erzeugt werden - spaeter manuell per 'npx web-push generate-vapid-keys' in $ENV_FILE eintragen."

  sed -i \
    -e "s#^HOST=.*#HOST=127.0.0.1#" \
    -e "s#^PORT=.*#PORT=${EKATS_PORT}#" \
    -e "s#^NODE_ENV=.*#NODE_ENV=production#" \
    -e "s#^BASE_URL=.*#BASE_URL=${BASE_URL}#" \
    -e "s#^DATABASE_URL=.*#DATABASE_URL=postgres://${EKATS_DB_USER}:${EKATS_DB_PASSWORD}@localhost:5432/${EKATS_DB_NAME}#" \
    -e "s#^JWT_SECRET=.*#JWT_SECRET=${JWT_SECRET}#" \
    -e "s#^COOKIE_SECURE=.*#COOKIE_SECURE=true#" \
    -e "s#^COOKIE_PATH=.*#COOKIE_PATH=${EKATS_BASE_PATH}/#" \
    -e "s#^VAPID_PUBLIC_KEY=.*#VAPID_PUBLIC_KEY=${VAPID_PUBLIC}#" \
    -e "s#^VAPID_PRIVATE_KEY=.*#VAPID_PRIVATE_KEY=${VAPID_PRIVATE}#" \
    -e "s#^SEED_WEHR_NAME=.*#SEED_WEHR_NAME=${EKATS_WEHR_NAME}#" \
    -e "s#^SEED_ADMIN_EMAIL=.*#SEED_ADMIN_EMAIL=${EKATS_ADMIN_EMAIL}#" \
    -e "s#^SEED_ADMIN_PASSWORD=.*#SEED_ADMIN_PASSWORD=${ADMIN_PASSWORD}#" \
    "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# ---------------------------------------------------------------------------
log "npm-Abhaengigkeiten installieren (npm ci)"
(cd "$BACKEND_DIR" && npm ci)

# bcrypt hat ein natives Compile-Postinstall-Skript (node-gyp-build). Manche Hosting-Setups (siehe
# ggf. eine "allow-scripts"-Warnung oben) blockieren Postinstall-Skripte standardmaessig - dann
# fehlt die kompilierte Bindung und bcrypt.hash()/compare() crasht erst beim ersten Login-Versuch.
# Hier frueh und klar pruefen statt das dem Nutzer beim Login ueberlassen.
if ! (cd "$BACKEND_DIR" && node -e "require('bcrypt')" 2>/tmp/ekats-bcrypt-check.log); then
  warn "bcrypt konnte nicht geladen werden (vermutlich Postinstall-Skript blockiert - siehe evtl. \
'allow-scripts'-Warnung oben). Details: $(cat /tmp/ekats-bcrypt-check.log 2>/dev/null)"
  die "Ohne funktionierendes bcrypt startet die App nicht. Entweder das Postinstall-Skript freigeben \
(z.B. 'npm approve-scripts --allow-scripts-pending' in $BACKEND_DIR, dann 'npm rebuild bcrypt' und \
dieses Skript erneut ausfuehren) oder in package.json auf 'bcryptjs' (reines JS, kein Compile noetig) \
wechseln."
fi

log "Datenbank-Schema migrieren"
(cd "$BACKEND_DIR" && npm run migrate)

log "Erst-Setup (Wehr + Stab-Account, nur falls DB noch leer ist)"
(cd "$BACKEND_DIR" && npm run seed)

log "DWD-Stationslookup befuellen (best effort, braucht Internetzugang zu opendata.dwd.de)"
(cd "$BACKEND_DIR" && npm run import-dwd-stations) || warn "DWD-Stationsimport fehlgeschlagen - spaeter manuell erneut versuchen: cd $BACKEND_DIR && npm run import-dwd-stations"

# ---------------------------------------------------------------------------
log "Dateirechte setzen"
chown -R "${EKATS_SYSTEM_USER}:${EKATS_SYSTEM_USER}" "$REPO_DIR"

# Plesk-Vhost-Verzeichnisse (z.B. /var/www/vhosts/<domain>) sind ueblicherweise nur fuer den
# von Plesk angelegten Domain-Systembenutzer durchquerbar - unser eigener, dedizierter
# EKATS_SYSTEM_USER darf sonst NICHT einmal per "cd" hineingelangen, obwohl er $REPO_DIR selbst
# gehoert. Ohne dieses Recht scheitert der Service-Start mit systemd-Status "200/CHDIR"
# (chdir ins WorkingDirectory schlaegt fehl -> Endlos-Restart-Schleife). "o+x" erlaubt nur das
# gezielte Hineinwechseln (kein Directory-Listing, dafuer waere zusaetzlich Lese-Recht noetig).
PARENT_DIR="$(dirname "$REPO_DIR")"
if [ "$PARENT_DIR" != "/" ] && [ "$PARENT_DIR" != "/var/www" ]; then
  chmod o+x "$PARENT_DIR" 2>/dev/null \
    || warn "Konnte 'x'-Recht auf $PARENT_DIR nicht setzen. Falls der Service danach mit \
'status=200/CHDIR' fehlschlaegt (siehe 'systemctl status ekats'), manuell pruefen: \
'sudo chmod o+x $PARENT_DIR' (oder ${EKATS_SYSTEM_USER} zur Gruppe des Vhost-Verzeichnisses hinzufuegen)."
fi

# ---------------------------------------------------------------------------
log "systemd-Service einrichten"
cat > /etc/systemd/system/ekats.service <<EOF
[Unit]
Description=EKats Lage-/Fruehwarn-Dashboard (Backend)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=${EKATS_SYSTEM_USER}
Group=${EKATS_SYSTEM_USER}
WorkingDirectory=${BACKEND_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=$(command -v node) src/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${BACKEND_DIR}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now ekats
sleep 2

# ---------------------------------------------------------------------------
log "Health-Check"
PORT_FOR_CHECK="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2-)"
if curl -sf "http://127.0.0.1:${PORT_FOR_CHECK}/api/health" >/dev/null; then
  echo "Backend antwortet auf Port ${PORT_FOR_CHECK}."
else
  if systemctl status ekats --no-pager 2>/dev/null | grep -q "200/CHDIR"; then
    warn "Backend antwortet NICHT - Service scheitert mit 'status=200/CHDIR' (siehe 'systemctl \
status ekats'): '${EKATS_SYSTEM_USER}' darf ein Verzeichnis oberhalb von ${BACKEND_DIR} nicht \
durchqueren. Der automatische Fix oben ('chmod o+x' auf $PARENT_DIR) wurde bereits versucht - \
falls es weiterhin auftritt, jeden Pfad-Bestandteil zwischen dort und ${BACKEND_DIR} pruefen \
('namei -l ${BACKEND_DIR}') und die restriktive Ebene identifizieren, dann 'systemctl restart ekats'."
  else
    warn "Backend antwortet NICHT. Logs pruefen: journalctl -u ekats -n 50 --no-pager"
  fi
fi

# ---------------------------------------------------------------------------
cat <<SUMMARY

============================================================
 EKats-Installation abgeschlossen
============================================================
 App-Verzeichnis:     ${REPO_DIR}
 Konfiguration:       ${ENV_FILE}
 systemd-Service:     ekats.service (systemctl status ekats)
 Lokaler Port:        ${PORT_FOR_CHECK} (nur 127.0.0.1, nicht oeffentlich)$([ "${PORT_AUTO_CHANGED:-false}" = true ] && echo "
 !!! Port war belegt, automatisch auf ${PORT_FOR_CHECK} ausgewichen - ProxyPass-Ziel in
     deploy/apache-ekats.conf.example MUSS diesen Port verwenden (nicht den Default 3000)! !!!")

 Login (Rolle "Stab"):
   E-Mail:    ${EKATS_ADMIN_EMAIL}
   Passwort:  ${ADMIN_PASSWORD_NOTE}

 NAECHSTER SCHRITT (manuell, da bestehende Apache/Plesk-Config nicht automatisch geaendert wird):
 Siehe deploy/apache-ekats.conf.example fuer den genauen Block + zwei Wege, ihn dauerhaft
 (Plesk-Reconfigure-sicher) einzubinden:
   - Panel: Websites & Domains -> ${EKATS_DOMAIN} -> "Apache & nginx-Einstellungen" ->
     Feld "Zusaetzliche Apache-Direktiven fuer HTTPS"
   - CLI: /var/www/vhosts/system/${EKATS_DOMAIN}/conf/vhost_ssl.conf ergaenzen, dann
     'plesk sbin httpdmng --reconfigure-domain ${EKATS_DOMAIN}'

 Danach erreichbar unter: https://${EKATS_DOMAIN}${EKATS_BASE_PATH}/

 Optional noch in ${ENV_FILE} ergaenzen und danach "systemctl restart ekats":
   - NASA_FIRMS_MAP_KEY (kostenloser Key: https://firms.modaps.eosdis.nasa.gov/api/map_key/)
   - SMTP_* (fuer E-Mail-Benachrichtigungen)
============================================================
SUMMARY
