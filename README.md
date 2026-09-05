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
npm run migrate   # legt Schema inkl. PostGIS-Erweiterung an (sql/schema.sql)
npm run seed      # legt erste Wehr + Stab-Account an (SEED_ADMIN_EMAIL/-PASSWORD)
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

- **Stab** (Wehrführung/Führungsstab): voller Zugriff, kann Schwellenwerte konfigurieren,
  Mitgliederkonten anlegen/löschen.
- **Mitglied**: nur Lesezugriff auf Karte/Liste, kann eigene Push-Anmeldung verwalten und das
  eigene Konto löschen.

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
  sql/schema.sql          PostgreSQL/PostGIS-Schema
  src/
    fetchers/              5 Datenquellen-Connectors + gemeinsames Normalisierungsformat
    notifications/         Schwellenwert-Engine, Web-Push, E-Mail
    routes/                REST-API (Auth, Nutzer, Datapoints, Alarmregeln, Push)
    middleware/             JWT-Auth, Rollen-Check, Error-Handling
    scheduler.js            Cron-Jobs (Fetch + Cleanup)
    app.js / index.js       Express-App-Setup / Server-Start
frontend/
  public/                  PWA: HTML-Seiten, CSS, Vanilla-JS, Service Worker, lokal vendortes Leaflet
CLAUDE.md                  Ursprüngliches Projekt-Briefing (Vision, Anforderungen, Module 2/3)
```

## Lizenz / Kontakt

Kein festgelegtes Lizenzmodell in dieser Phase. Repository-Owner: `tobizimmi` auf GitHub.
