# EKats — Lage-/Frühwarn-Dashboard für Feuerwehr-Führungsebenen

Web-Tool (PWA) für Wehrführung, Führungsstab und Führungshaus/ELW: bündelt Live-Lagedaten
(Wetterwarnungen, Pegelstände, Hochwasserlage, Waldbrand-Hotspots, Waldbrandgefahrenindex) auf einer
Karte des eigenen Zuständigkeitsgebiets, mit schwellenwert-basierten Push-/E-Mail-Benachrichtigungen.

Dies ist **Version 1 (Modul 1 — Lage-/Frühwarn-Dashboard)** gemäß `CLAUDE.md`. Explizit **nicht**
Teil dieser Version: Objektpläne (Modul 2), Schnittstellen zu DIVERA/iKAT (Modul 3),
SMS-Alarmierung, Mandantenfähigkeit für mehrere Wehren (das Datenmodell ist darauf vorbereitet,
siehe `wehr`-Tabelle, aber die UI geht von genau einer Wehr aus).

Kein Konkurrenzprodukt zu iKAT (Offline-Zuverlässigkeit im Fahrzeug), sondern eine Ergänzung mit
Fokus auf Live-Daten für die Führungsebene.

## Tech-Stack

- **Backend:** Node.js, Express
- **Datenbank:** PostgreSQL + PostGIS
- **Scheduler:** node-cron
- **Frontend:** PWA, Vanilla JS, Leaflet (lokal vendored, kein CDN, keine Tracking-Skripte)
- **Auth:** JWT in httpOnly-Cookie, bcrypt für Passwort-Hashing
- **Push:** web-push (VAPID), E-Mail-Fallback über nodemailer

## Setup

### 1. Datenbank

Lokal per Docker (falls verfügbar):

```bash
docker compose up -d postgres
```

Alternativ eine bestehende PostgreSQL-16-Instanz mit PostGIS-Erweiterung verwenden (Paket
`postgresql-16-postgis-3` unter Debian/Ubuntu, `postgis` unter Homebrew) und `DATABASE_URL`
entsprechend setzen.

### 2. Backend konfigurieren und starten

```bash
cd backend
cp .env.example .env
# .env ausfuellen: DATABASE_URL, JWT_SECRET, SEED_ADMIN_PASSWORD, ggf. NASA_FIRMS_MAP_KEY, SMTP_*

npm install
npm run migrate   # frische DB: Baseline-Schema; bestehende DB: nur neue sql/migrations/*.sql
npm run seed      # legt erste Wehr + Admin-Account an (SEED_ADMIN_EMAIL/-PASSWORD)
npm start         # startet Server (Port 3000) + Cron-Scheduler
```

Danach im Browser `http://localhost:3000` öffnen und mit `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`
anmelden. Das Frontend (`frontend/public/`) wird vom Backend als statische Dateien mitausgeliefert —
kein separater Build-Schritt nötig.

Für Web Push zusätzlich ein VAPID-Schlüsselpaar erzeugen und in `.env` eintragen:

```bash
npx web-push generate-vapid-keys
```

### 3. DWD-Stationslookup einmalig befüllen

Der Waldbrandgefahrenindex-Feed liefert selbst keine Koordinaten; die Zuordnung läuft über eine
Lookup-Tabelle, die aus der offiziellen DWD-Stationsliste befüllt wird:

```bash
npm run import-dwd-stations
```

(Läuft danach automatisch wöchentlich über den Scheduler, siehe `FETCH_DWD_STATIONS_IMPORT_CRON`.)

## Deployment auf zimmimail.de (Produktivbetrieb)

Zielbild: VPS mit Root-Zugriff, verwaltet über **Plesk** (erkennbar am Pfad
`/var/www/vhosts/<domain>/...`), EKats erreichbar unter `https://zimmimail.de/EKats/` — als
Unterpfad der bestehenden Domain, damit das vorhandene TLS-Zertifikat mitgenutzt wird und keine
neue Subdomain/kein neues Zertifikat nötig ist. Das Frontend verwendet ausschließlich relative
Pfade und funktioniert dadurch unverändert unter jedem Unterpfad; das Backend bindet nur an
`127.0.0.1` und ist nie direkt öffentlich erreichbar, sondern ausschließlich über Apache als
Reverse-Proxy.

### 1. Repository auf den Server holen

**Wichtig: NICHT unter `httpdocs/`** klonen. `httpdocs/` ist bei Plesk der öffentliche
Web-Dokumentenstamm der Domain — Apache liefert von dort direkt Dateien aus. Läge der Quellcode
(inkl. `backend/.env` mit Secrets) darin, wäre nur der weiter unten konfigurierte Reverse-Proxy die
einzige Barriere gegen direkten Zugriff auf `.env` & Co. Stattdessen ins private Vhost-Verzeichnis
(Geschwisterordner von `httpdocs`) klonen, das Apache nicht ausliefert:

```bash
git clone https://github.com/tobizimmi/EKats.git /var/www/vhosts/zimmimail.de/EKats
```

(Setzt voraus, dass der Server bereits Zugriff auf das GitHub-Repo hat — z.B. über denselben
Mechanismus, mit dem auch FKatInfo dort geklont wurde: hinterlegter Deploy-Key/SSH-Key oder ein
Personal-Access-Token in der Remote-URL. Ist das Repo privat und noch kein Zugriff eingerichtet,
zunächst wie gewohnt einen Deploy-Key in den GitHub-Repo-Einstellungen hinzufügen.)

`install.sh` warnt automatisch, falls es doch unter einem `httpdocs`-Pfad ausgeführt wird, bricht
aber nicht ab (falls es dafür einen bewussten Grund gibt).

### 2. Installationsskript ausführen

```bash
cd /var/www/vhosts/zimmimail.de/EKats
sudo bash deploy/install.sh
```

Das Skript ist **idempotent** (mehrfach ausführbar) und erledigt automatisch:

- Node.js 20 installieren (falls nicht vorhanden)
- PostgreSQL + PostGIS-Erweiterung installieren
- einen dedizierten Systembenutzer `ekats` ohne Login-Shell anlegen
- Datenbank + Rolle anlegen, PostGIS aktivieren
- `backend/.env` generieren (zufällige Secrets, VAPID-Schlüsselpaar, Cookie-Pfad `/EKats/`) —
  **wird bei erneutem Lauf nicht überschrieben**
- `npm ci`, Schema-Migration, Erst-Setup (Wehr + erster Admin-Account), DWD-Stationsimport
- einen systemd-Service `ekats` einrichten und starten (siehe `deploy/ekats.service` als Referenz)

Am Ende gibt das Skript die Zugangsdaten des ersten Admin-Accounts aus (E-Mail/Passwort einmalig
notieren). Anpassbar per Umgebungsvariable, z.B. anderer Port oder andere Admin-E-Mail:

```bash
EKATS_PORT=3001 EKATS_ADMIN_EMAIL=wehrfuehrer@zimmimail.de sudo -E bash deploy/install.sh
```

### 3. Apache als Reverse-Proxy einbinden (manueller Schritt)

`install.sh` fasst die bestehende, produktive zimmimail.de-Konfiguration bewusst **nicht**
automatisch an. Da der Server über **Plesk** verwaltet wird, würde eine von Hand editierte
Apache-VirtualHost-Datei beim nächsten Plesk-Reconfigure wieder überschrieben — Plesk bietet dafür
zwei offizielle, dauerhafte Wege (Details/genauer Wortlaut in `deploy/apache-ekats.conf.example`):

- **Panel (einfacher):** Websites & Domains → zimmimail.de → „Apache & nginx-Einstellungen“ →
  Feld „Zusätzliche Apache-Direktiven für **HTTPS**“ → Inhalt aus
  `deploy/apache-ekats.conf.example` einfügen → Anwenden. Plesk aktiviert nötige Module und
  generiert die Config selbst neu.
- **CLI:** Block in `/var/www/vhosts/system/zimmimail.de/conf/vhost_ssl.conf` anhängen, dann
  `sudo a2enmod proxy proxy_http headers && sudo plesk sbin httpdmng --reconfigure-domain zimmimail.de`.

Danach kurz `sudo apache2ctl configtest` prüfen. Erreichbar ist EKats anschließend unter
`https://zimmimail.de/EKats/`.

### 4. Spätere Updates

```bash
cd /var/www/vhosts/zimmimail.de/EKats
sudo bash deploy/update.sh
```

Zieht den neuesten Stand per `git pull`, aktualisiert Abhängigkeiten, führt die (additive,
gefahrlose) Schema-Migration erneut aus und startet den Service neu. Lässt `.env` und die
Apache-Konfiguration unangetastet.

### Nützliche Befehle auf dem Server

```bash
systemctl status ekats            # Läuft der Prozess?
journalctl -u ekats -f            # Live-Logs (Fetcher-Läufe, Fehler, Alarme)
systemctl restart ekats           # Neustart, z.B. nach manueller .env-Änderung
```

## Datenquellen

| Quelle | Zweck | API-Key | Update-Intervall (Standard) |
|---|---|---|---|
| DWD Unwetterwarnungen | Amtliche Warnungen, Bundesland-Ebene | nein | alle 20 Min. |
| PEGELONLINE (WSV) | Pegelstände Bundeswasserstraßen | nein | alle 15 Min. |
| Hochwasserzentralen-API (LHP) | Hochwasserlage | nein | alle 20 Min. |
| NASA FIRMS | Satelliten-Hotspots Waldbrand | ja, kostenloser MAP_KEY | alle 45 Min. |
| DWD Waldbrandgefahrenindex | Flächige Gefahreneinschätzung je Station | nein | 1×/Tag |

Intervalle über die `FETCH_*_CRON`-Variablen in `.env` änderbar. Jeder Fetcher läuft isoliert
(`src/scheduler.js`): schlägt eine Quelle fehl, laufen die anderen vier normal weiter.

### Verifikationsstand der Fetcher

Vier der fünf Connectors (`dwdUnwetter`, `pegelonline`, `nasaFirms`, `dwdWaldbrand`) sind gegen
Endpunkte und Feldnamen implementiert, die im Schwesterprojekt
[FKatInfo](https://github.com/tobizimmi/FKatInfo) bereits produktiv gegen die echten APIs liefen
(siehe Kommentare am Kopf jeder Datei) und wurden hier zusätzlich mit realistischen Fixture-Daten
end-to-end gegen eine echte PostGIS-Datenbank getestet (Parsing → Normalisierung → Upsert →
Alert-Engine).

**Der fünfte Connector, `hochwasserzentralen.js`, ist NICHT live verifiziert.** Diese Sandbox-Umgebung
hatte aus Netzwerkrichtlinien-Gründen keinen ausgehenden Zugriff auf `hochwasserzentralen.de`.
Endpunkt-URL und Feldnamen sind nach bestem Wissen rekonstruiert, aber vor Produktivbetrieb zu
prüfen (siehe ausführlicher Kommentar am Dateianfang). Der Fetcher scheitert defensiv (Warnung im
Log, kein Absturz der anderen Jobs), falls die Annahmen nicht zutreffen.

**Live-Abruf gegen die echten Behörden-APIs konnte aus derselben Netzwerkrichtlinien-Einschränkung
in dieser Entwicklungsumgebung generell nicht getestet werden** (auch für die vier verifizierten
Connectors nicht) — bitte nach dem ersten Deploy einmal `npm run fetch -- <quelle>` pro Quelle
manuell laufen lassen und die Logs/`live_datapoint`-Tabelle prüfen.

## Benachrichtigungen (Schwellenwerte)

Konfigurierbar unter „Einstellungen“ (nur Rolle „Stab“). `threshold_key` je Quelle:

| Quelle | threshold_key | threshold_value | target_ref |
|---|---|---|---|
| dwd_unwetter | `warnstufe` | 1–4 | optional: Bundesland-Code (z.B. `NW`) |
| pegelonline | `wasserstand_cm` | Zentimeter | **Pflicht**: Pegelname-Teilstring |
| hochwasserzentralen | `meldestufe` | 0–4 | optional: Namens-Teilstring |
| waldbrandindex | `gefahrenstufe` | 1–5 | optional: Bundesland-Code |
| firms | `radius_km` | Kilometer um den Wehr-Kartenmittelpunkt | nicht verwendet |

PEGELONLINE liefert keine amtliche Meldestufe (nur eine grobe Einordnung relativ zu langjährigen
Mittelwerten) — für eine echte Meldestufe die Hochwasserzentralen-Quelle nutzen. Jede
Regel/Datapoint/Kanal-Kombination löst wegen `alert_log` nur einmal aus (siehe
`src/notifications/evaluate.js`).

## Rollen

Drei Stufen, jede höhere umfasst die Rechte der niedrigeren:

- **Mitglied**: nur Lesezugriff auf Karte/Liste, kann eigene Push-Anmeldung verwalten und das
  eigene Konto löschen.
- **Stab**: zusätzlich Schwellenwerte (Alarmregeln) konfigurieren.
- **Admin**: zusätzlich Admin-Bereich (`/admin.html`) — Nutzerverwaltung (Konten anlegen, Rolle
  ändern, löschen) und Wehr-Einstellungen (Name, Kartenmittelpunkt). Die letzte "admin"-Rolle
  einer Wehr kann sich nicht selbst degradieren oder löschen (Aussperr-Schutz).

Bereits bestehende Installationen (vor Einführung der Admin-Rolle): der bzw. die bisherigen
`stab`-Accounts werden beim nächsten `deploy/update.sh` automatisch einmalig zu `admin`
hochgestuft (siehe `backend/sql/migrations/001_add_admin_role.sql`) — kein manueller Eingriff
nötig, kein Zugriffsverlust.

## Objektverwaltung (kritische Objekte)

Auf der Karte lassen sich kritische Objekte (Schulen/Kitas, Krankenhäuser/Pflegeeinrichtungen,
Industrie-/Gefahrstoffbetriebe, Versammlungsstätten, Sonstiges) direkt anlegen und pflegen —
eigener Layer, als Quadrat dargestellt (unterscheidbar von den runden, nach Dringlichkeit
eingefärbten Lage-Markern).

- **Anlegen** (Rolle Stab/Admin): Button „Objekt anlegen“ klicken, dann auf die gewünschte Position
  in der Karte klicken — öffnet ein Formular für Name, Kategorie, Adresse, besondere Gefahren,
  Zufahrt/Schlüsseldepot und Ansprechpartner.
- **Bearbeiten/Löschen** (Stab/Admin): bestehendes Objekt auf der Karte anklicken.
- **Ansehen** (Mitglied): Klick öffnet dieselbe Ansicht schreibgeschützt.

Bewusste V1-Einschränkung: keine Datei-Anhänge (Grundrisse/Einsatzpläne als PDF) — nur
Ortsangabe plus Freitext-Hinweise. Objekte sind je Wehr gespeichert (`critical_object`-Tabelle,
`backend/sql/migrations/002_add_critical_objects.sql`).

## Sicherheit & Datenschutz

- Passwörter: bcrypt (Cost 12)
- Auth: JWT in httpOnly-/Secure-/SameSite=Strict-Cookie (kein `localStorage`-Token)
- Rate-Limiting auf allen `/api`-Endpunkten, engeres Limit zusätzlich auf `/api/auth/login`
- Security-Header via `helmet` (inkl. Content-Security-Policy)
- Keine Drittanbieter-Tracking-Skripte; Leaflet lokal vendored; einzige externe Verbindung im
  Frontend sind die OpenStreetMap-Kartenkacheln (nur Bilder)
- DSGVO: jeder Nutzer kann sein Konto jederzeit vollständig löschen (`DELETE /api/users/me`,
  kaskadiert auf Push-Subscriptions/Alarmregeln/Alert-Log)
- `.env` ist gitignored — niemals Secrets committen
- `/datenschutz.html` und `/impressum.html` sind technisch vorbereitete Platzhalterseiten — der
  Betreiber muss sie vor Produktivbetrieb rechtlich prüfen/ausfüllen lassen (siehe Hinweise auf den
  Seiten selbst)

**HTTPS/TLS:** im Dev-Setup läuft der Server über HTTP. Für den Produktivbetrieb zwingend hinter
einen TLS-terminierenden Reverse-Proxy stellen (z.B. Caddy oder nginx mit Let's-Encrypt-Zertifikat)
und `COOKIE_SECURE=true` sowie `BASE_URL=https://...` setzen.

## Offline-Verhalten (Modul 1)

Der Service Worker (`frontend/public/sw.js`) cached die App-Shell (HTML/CSS/JS/Leaflet). Der letzte
erfolgreich geladene Datenstand wird zusätzlich in IndexedDB gespeichert
(`frontend/public/js/offline.js`); bei Verbindungsverlust erscheint ein deutlich sichtbarer Hinweis
mit Zeitstempel des letzten Standes. Kein voller Offline-Betrieb mit Sync (das ist Modul 2 für den
Fahrzeugeinsatz) — API-Aufrufe gehen immer live ans Netz, Kartenkacheln werden nicht vorab
zwischengespeichert.

## Bekannte V1-Vereinfachungen

- **PWA-Icon** ist aktuell nur als SVG hinterlegt (`frontend/public/icons/icon.svg`). Für optimale
  iOS-/Android-Homescreen-Darstellung vor Produktivbetrieb noch PNG-Icon-Sets in mehreren Größen
  ergänzen.
- **Eine Wehr pro Installation**: Das Schema (`wehr`-Tabelle) ist mandantenfähig vorbereitet, aber
  Login/Dashboard gehen von genau einer Wehr aus (siehe Abschnitt 6 der `CLAUDE.md` zu Modul 3).
- **NASA FIRMS** nutzt einen einzigen globalen `MAP_KEY` (nicht pro Nutzer) und einen festen Radius
  (`FIRMS_RADIUS_KM`) um den Wehr-Kartenmittelpunkt.
- Siehe außerdem den Abschnitt „Verifikationsstand der Fetcher“ oben.

## Projektstruktur

```
backend/
  sql/schema.sql          Baseline-Schema (frische Installationen)
  sql/migrations/         Inkrementelle Migrationen (bestehende Installationen)
  src/
    fetchers/              5 Datenquellen-Connectors + gemeinsames Normalisierungsformat
    notifications/         Schwellenwert-Engine, Web-Push, E-Mail
    routes/                REST-API (Auth, Nutzer, Wehr, Datapoints, Alarmregeln, Objekte, Push)
    middleware/             JWT-Auth, Rollen-Check, Error-Handling
    scheduler.js            Cron-Jobs (Fetch + Cleanup)
    app.js / index.js       Express-App-Setup / Server-Start
frontend/
  public/                  PWA: HTML-Seiten, CSS, Vanilla-JS, Service Worker, lokal vendortes Leaflet
CLAUDE.md                  Ursprüngliches Projekt-Briefing (Vision, Anforderungen, Module 2/3)
```

## Lizenz / Kontakt

Kein festgelegtes Lizenzmodell in dieser Phase. Repository-Owner: `tobizimmi` auf GitHub.
