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
| Hochwasserzentralen-API (LHP) | Landespegel + Hochwasserlage aller Bundesländer | nein | alle 20 Min. |
| NASA FIRMS | Satelliten-Hotspots Waldbrand | ja, kostenloser MAP_KEY | alle 45 Min. |
| DWD Waldbrandgefahrenindex | Flächige Gefahreneinschätzung je Station | nein | 1×/Tag |
| warnung.bund.de (BBK/NINA) | Bevölkerungswarnungen (MoWaS/DWD/LHP/BIWAPP/KATWARN/Polizei) | nein | alle 15 Min. |
| Kachelmannwetter/Meteologix | Zusätzliches, optionales aktuelles Wetter (kostenpflichtig, siehe unten — keine Warnungen/Radar, dazu bietet die API nichts) | ja, `KACHELMANN_API_KEY` | alle 30 Min. |
| Bright Sky (DWD-Vorhersage) | Echte Wettervorhersage (Temperatur/Niederschlag/Wind), keine Warnung | nein | stündlich |
| Blitzortung.org | Live-Blitzeinschläge (Gewitterzug) | nein | Live-Stream (kein Intervall) |
| EMSC/SeismicPortal | Erdbeben (Magnitude, Region, Tiefe) im Umkreis der Wehr | nein | alle 30 Min. |

Intervalle über die `FETCH_*_CRON`-Variablen in `.env` änderbar. Jeder Fetcher läuft isoliert
(`src/scheduler.js`): schlägt eine Quelle fehl, laufen die anderen normal weiter. Blitzortung.org ist
die einzige Ausnahme von diesem Cron-Muster — siehe eigener Abschnitt unten.

**warnung.bund.de (BBK)** ist der offizielle Warnaggregator hinter der NINA-App und bündelt sechs
Warnsysteme in einer einzigen, kostenlosen, unauthentifizierten API — darunter amtliche
Bevölkerungswarnungen (MoWaS: Chemieunfälle, Evakuierungen, Großschadenslagen) und
Polizei-Meldungen. Bemerkenswert: **KATWARN-Meldungen sind darüber erreichbar**, obwohl KATWARN
selbst keine nutzbare öffentliche API hat — der Aggregator löst diese sonst übliche Einschränkung
indirekt. Abgefragt wird pro Landkreis im Zuständigkeitsgebiet (amtlicher Regionalschlüssel, aus
dem Kreis-AGS abgeleitet) — jede Meldung ist dadurch bereits beim Abruf exakt einem Kreis
zugeordnet (`payload.landkreisAgs`), präziser als die Bundesland-Näherung bei DWD-Unwetterwarnungen
(siehe „Zuständigkeitsgebiet" unten für die drei Filterarten). Detailtexte (Beschreibung/
Verhaltenshinweise) werden best-effort nachgeladen; schlägt das fehl, bleibt die Meldung trotzdem
mit Titel/Dringlichkeit/Kreis nutzbar.

Die Hochwasserzentralen-API liefert **die Hochwasser-Klassifizierung aller Pegel-Stationen in
Deutschland** (nicht nur die Bundeswasserstraßen von PEGELONLINE) — deckt damit auch die von den
Ländern selbst betriebenen „weiteren Pegel" ab. Ein einziger Abruf liefert bundesweit alle Stationen
als GeoJSON; die Ergebnisliste wird danach auf einen Umkreis (`HOCHWASSERZENTRALEN_RADIUS_KM`,
Standard 60 km) um mindestens einen Wehr-Kartenmittelpunkt eingegrenzt (analog zu `FIRMS_RADIUS_KM`).
**Die API liefert laut eigener Dokumentation keinen numerischen Wasserstand-Messwert**, nur eine
5-stufige Klassifizierung (Kein Hochwasser / Klein / Mittel / Groß / Sehr groß) — `value_numeric`
bleibt deshalb bei dieser Quelle immer leer, `severity` trägt die Klassifizierung.

### Verifikationsstand der Fetcher

Vier der fünf Connectors (`dwdUnwetter`, `pegelonline`, `nasaFirms`, `dwdWaldbrand`) sind gegen
Endpunkte und Feldnamen implementiert, die im Schwesterprojekt
[FKatInfo](https://github.com/tobizimmi/FKatInfo) bereits produktiv gegen die echten APIs liefen
(siehe Kommentare am Kopf jeder Datei) und wurden hier zusätzlich mit realistischen Fixture-Daten
end-to-end gegen eine echte PostGIS-Datenbank getestet (Parsing → Normalisierung → Upsert →
Alert-Engine).

**Der fünfte Connector, `hochwasserzentralen.js`, ist NICHT live verifiziert** — hochwasserzentralen.de
ist aus dieser Entwicklungsumgebung nicht erreichbar (weder `www.hochwasserzentralen.de` noch die
API-Subdomain `api.hochwasserzentralen.de`). Er wurde zweimal korrigiert: zuerst zielte er auf einen
erfundenen Endpunkt (`pegel_alle.json`), dann auf eine inoffizielle, aber ebenfalls veraltete
Community-OpenAPI-Spec (die zugehörigen `www.hochwasserzentralen.de/webservices/*.php`-Endpunkte
existieren nicht mehr — live per `curl -sv` auf dem Produktivserver bestätigt: HTTP 200 mit
`Content-Length: 0`). Die aktuelle Version basiert auf der **offiziellen, vom Anbieter selbst
veröffentlichten OpenAPI-3.0-Spezifikation** („LHP-PublicAPI", von
[hochwasserzentralen.de/developers/api-docs](https://www.hochwasserzentralen.de/developers/api-docs)),
inkl. echter Beispiel-Antworten, gegen die die Parsing-Logik mit Fixture-Daten getestet wurde — die
bestmögliche verfügbare Basis (Erstanbieter-Dokumentation statt Reverse-Engineering), aber weiterhin
nicht live gegen eine echte Antwort geprüft. Vor Produktivbetrieb `npm run fetch --
hochwasserzentralen` prüfen (siehe ausführlicher Kommentar am Dateianfang). Die Spec verlangt formal
ein `BasicAuth`-Schema, definiert aber kein tatsächliches Auth-Schema und nennt sich selbst
„PublicAPI" mit offener CC-BY-4.0-Lizenz — vermutlich ein Doku-Artefakt der Beta-Version; falls der
Live-Abruf mit `401` scheitert, wären hier Zugangsdaten zu ergänzen. Der Fetcher scheitert ansonsten
defensiv (Warnung im Log, kein Absturz der anderen Jobs), falls die Annahmen nicht zutreffen.

**Der sechste Connector, `bbkWarnungen.js`, ist ebenfalls NICHT live verifiziert** — warnung.bund.de
war aus dieser Entwicklungsumgebung nicht erreichbar. Implementiert gegen die inoffizielle, aber
vom bundesAPI-Projekt gepflegte OpenAPI-Spec
[bundesAPI/nina-api](https://github.com/bundesAPI/nina-api) (verifiziert erreichbar über
`raw.githubusercontent.com`). Zwei Annahmen sind dabei nicht letztgültig verifiziert: (1) dass ein
5-stelliger Kreis-AGS mit sieben angehängten Nullen ("`<ags>0000000`") als Regionalschlüssel den
gesamten Kreis adressiert (aus der in der Recherche gefundenen Beispiel-URL abgeleitet, nicht aus
einer offiziellen ARS-Spezifikation), und (2) das genaue Antwortformat des Detail-Endpunkts
(`/warnings/{id}.json`) für Beschreibung/Verhaltenshinweise — schlägt (2) fehl, bleibt die Meldung
trotzdem mit Titel/Dringlichkeit/Kreis nutzbar (siehe Kommentar am Dateianfang). Vor
Produktivbetrieb `npm run fetch -- bbk_warnung` prüfen.

**Der siebte Connector, `brightsky.js` (Wetter-Vorhersage), ist ebenfalls NICHT live verifiziert** —
`api.brightsky.dev` war aus dieser Entwicklungsumgebung nicht erreichbar. Implementiert gegen die
öffentlich dokumentierte, stabile Bright-Sky-API-Konvention (kostenlos, kein API-Key, `/weather`-
Endpunkt mit `lat`/`lon`/`date`, liefert DWD-Stationsmessungen und MOSMIX-Vorhersagen) — siehe
Kommentar am Dateianfang für die genaue Quellenlage. Vor Produktivbetrieb
`npm run fetch -- wetter_vorhersage` prüfen.

**Live-Abruf gegen die echten Behörden-APIs konnte aus derselben Netzwerkrichtlinien-Einschränkung
in dieser Entwicklungsumgebung generell nicht getestet werden** (auch für die verifizierten
Connectors nicht) — bitte nach dem ersten Deploy einmal `npm run fetch -- <quelle>` pro Quelle
manuell laufen lassen und die Logs/`live_datapoint`-Tabelle prüfen.

### Addon-Seiten je Datenquelle

Jede Datenquelle hat zusätzlich zum kombinierten Dashboard eine eigene, tiefere Seite mit
Mini-Karte + durchsuch-/filterbarer Tabelle (analog zur Objekt-Übersicht):

| Seite | Quelle |
|---|---|
| `dwd-unwetter.html` | DWD-Unwetterwarnungen |
| `wetter-vorhersage.html` | Wetter-Vorhersage (Bright Sky) — eigene Ansicht, siehe unten |
| `pegelonline.html` | Pegelstände (PEGELONLINE) |
| `hochwasserzentralen.html` | Landespegel (Hochwasserzentralen) |
| `waldbrandindex.html` | Waldbrandgefahrenindex |
| `firms.html` | Feuer-Hotspots (NASA FIRMS) |
| `bbk-warnungen.html` | Bevölkerungswarnungen (BBK/NINA) |
| `kachelmann.html` | Kachelmann/Meteologix |

Nur das **Dashboard** (`index.html`) zeigt weiterhin alle Quellen (inkl. kritische Objekte)
gemeinsam auf einer Karte mit Layer-Toggles — bewusst schlank gehalten (nur Priorität, Karte,
Übersicht), damit jede Quelle für die Detailarbeit ihre eigene, tiefere Seite behält (Konzept Teil
2: „Dashboard bleibt schlank, Themenseiten werden mächtiger"). `wetter_vorhersage` ist dabei die
einzige Quelle, die **nicht** im kombinierten Dashboard/Karte erscheint — sie liefert dutzende
stündliche Werte je Wehr (Zeitreihe an einem Punkt, kein raumliches Einzelereignis) und würde die
Lage-Übersicht nur zumüllen; `GET /api/datapoints` ohne `source`-Filter blendet sie serverseitig
aus (siehe `backend/src/routes/datapoints.js`).

Die Addon-Seiten teilen sich ein gemeinsames Skript (`js/addon.js`) — welche Quelle eine Seite
anzeigt, steht im `data-addon-source`-Attribut auf `<body>` (nicht als Inline-`<script>`, das würde
an der Content-Security-Policy scheitern). Die eigentliche Tabelle stammt aus der gemeinsamen
Komponente `js/data-table.js` (siehe „Generische Tabellen-Komponente" unten).

**`wetter-vorhersage.html` ist die eine Ausnahme** und nutzt statt `addon.js`/`data-table.js` ein
eigenes Skript (`js/wetter-vorhersage.js`): eine Tabelle mit ~40 Zeilen und eine Karte mit ~40
übereinandergestapelten Markern an derselben Koordinate (jede Vorhersage-Stunde trägt den
Wehr-Kartenmittelpunkt als Ort, kein raumliches Einzelereignis) waren als Ansicht unbrauchbar.
Stattdessen: nach Tag gruppierte Vorhersage-Karten (Icon, Temperatur, Windrichtung/-geschwindigkeit
als gedrehter Pfeil + Himmelsrichtung, Niederschlagsmenge falls >0), ein Klick auf eine Stunde öffnet
das gewohnte Detail-Panel mit allen Werten (inkl. Böen, Bewölkung). Die Karte zeigt nur noch EINEN
Marker für den Vorhersage-Standort statt der gestapelten Duplikate, plus denselben zuschaltbaren
DWD-Niederschlagsradar-Layer wie die übrigen Kartenseiten (`addRadarLayerControl()`).

Wetter-Icons sind Emoji nach Bright Skys Icon-Taxonomie (`clear-day`, `partly-cloudy-day`, `rain`,
`thunderstorm`, …) — bewusst keine Icon-Bibliothek/Bilddateien, passt zum bisherigen
Projekt-Stil (siehe Pegel-Diagramm: handgeschriebenes SVG statt Chart-Bibliothek).

**Gebietsfilter-Ausnahme:** `wetter_vorhersage`-Datenpunkte tragen immer die Koordinate des
Wehr-Kartenmittelpunkts selbst (nie eine unabhängige Ereignis-Koordinate, siehe `brightsky.js`) und
sind deshalb von der Kreis-Zugehörigkeitsprüfung ausgenommen (`UNSCOPED_SOURCES` in
`backend/src/utils/gebietFilter.js`). Eine `ST_Contains`-Prüfung "liegt der eigene Kartenmittelpunkt
im eigenen Zuständigkeitsgebiet" testet sonst nur, ob Heimat-Landkreis-Auswahl und
Kartenmittelpunkt-Klick exakt zusammenpassen — bei einem nur knapp außerhalb der Kreisgrenze
gesetzten Mittelpunkt blieb die eigene Vorhersage dadurch dauerhaft leer, unabhängig vom
tatsächlichen Zuständigkeitsgebiet.

### Seitenleisten-Navigation

Mit acht Themenseiten plus Objekt-Übersicht, Einstellungen und Admin wurde die bisherige
horizontale Kopfzeile zu voll — sie ist einer gruppierten Seitenleiste gewichen (Übersicht /
Datenquellen / Objekte / Verwaltung), am Desktop dauerhaft sichtbar links, am Mobiltelefon
standardmäßig eingeklappt und über ein Menü-Symbol aufklappbar. `js/header.js` rendert die
komplette Seitenleiste in ein leeres `<div id="app-sidebar-root"></div>` — jede Seite trägt dafür
nur noch diesen einen Platzhalter statt eines mehrzeiligen Navigations-Blocks, ein gemeinsames
„Include" ohne eigenes Templating-System.

### Generische Tabellen-Komponente

`js/data-table.js` stellt Suche, Spalten-Ein-/Ausblenden und CSV-Export bereit — genutzt von allen
Themenseiten (mit quellenspezifischen Zusatzspalten aus tatsächlich verifizierten `payload`-Feldern
der jeweiligen Fetcher, siehe `backend/src/fetchers/*.js`) und von der neuen Objekt-Detailseite.
Die Spalten-Sichtbarkeit wird **serverseitig** über `/api/user-preferences/:key` gespeichert
(`user_preference`-Tabelle, Migration 011) — geräteübergreifend nutzbar, mit
„Spalten zurücksetzen"-Button (löscht die gespeicherte Einstellung, die Seite fällt auf ihre
eingebauten Standardspalten zurück). Derselbe Endpunkt ist als generischer Key-Value-Speicher
angelegt, damit spätere Phasen (z.B. ein persönliches Dashboard-Layout) ihn mitnutzen können, ohne
eine weitere Tabelle zu brauchen.

## Benachrichtigungen (Schwellenwerte)

Konfigurierbar unter „Einstellungen“ (nur Rolle „Stab“). `threshold_key` je Quelle:

| Quelle | threshold_key | threshold_value | target_ref |
|---|---|---|---|
| dwd_unwetter | `warnstufe` | 1–4 | optional: Bundesland-Code (z.B. `NW`) |
| pegelonline | `wasserstand_cm` | Zentimeter | **Pflicht**: Pegelname-Teilstring |
| hochwasserzentralen | `meldestufe` | 0–4 | optional: Namens-Teilstring |
| waldbrandindex | `gefahrenstufe` | 1–5 | optional: Bundesland-Code |
| firms | `radius_km` | Kilometer um den Wehr-Kartenmittelpunkt | nicht verwendet |
| erdbeben | `magnitude` | Mindest-Magnitude | nicht verwendet |

PEGELONLINE liefert keine amtliche Meldestufe (nur eine grobe Einordnung relativ zu langjährigen
Mittelwerten) — für eine echte Meldestufe die Hochwasserzentralen-Quelle nutzen. Jede
Regel/Datapoint/Kanal-Kombination löst wegen `alert_log` nur einmal aus (siehe
`src/notifications/evaluate.js`). **`bbk_warnung` hat noch keine Schwellenwert-Regel** — die Quelle
ist neu (Phase 1 des Einsatzleiter-Portal-Konzepts) und wird bislang nur über die Prioritäts-Leiste
und die Lage-Liste angezeigt, nicht über Push/E-Mail.

### SMTP-Konfiguration

Für den E-Mail-Kanal (Alarm-Mails hier sowie die Passwort-vergessen-Links, siehe „Sicherheit &
Datenschutz“) lässt sich SMTP entweder klassisch über `.env` (`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/
`SMTP_PASS`/`SMTP_FROM`) **oder** je Wehr im Admin-Bereich (Abschnitt „SMTP-Konfiguration“)
hinterlegen — ein in der DB gesetztes Feld überschreibt den `.env`-Wert nur für dieses Feld, leere
Felder fallen weiterhin auf `.env` zurück. Das Passwort wird AES-256-GCM-verschlüsselt gespeichert
(`utils/crypto.js`, Schlüssel per `scrypt` aus `JWT_SECRET` abgeleitet — kein zusätzliches Secret in
`.env` nötig) und nie im Klartext an das Frontend zurückgegeben (nur ob eines gesetzt ist). Ein
„Test-E-Mail an mich senden“-Button im Admin-Bereich verschickt sofort eine Testmail an den
anfordernden Admin, um die Konfiguration ohne Umweg über eine echte Warnung zu prüfen.
`notifications/mailer.js` baut den `nodemailer`-Transporter je Versand frisch auf (kein Caching) —
eine Admin-Änderung wirkt dadurch sofort, ohne Server-Neustart.

## Zuständigkeitsgebiet (Landkreis + Nachbarlandkreise)

Im Admin-Bereich („Wehr-Einstellungen“) legt der Admin den **Heimat-Landkreis** der Wehr fest
(Auswahl aus allen 402 deutschen Kreisen/kreisfreien Städten mit amtlichem Gemeindeschlüssel).
Wehrweite Einstellung, nicht pro Nutzer — passend zum bestehenden Modell (Kartenmittelpunkt ist
ebenfalls wehrweit).

- **Nachbarlandkreise** werden nicht manuell gepflegt, sondern automatisch aus den echten
  Kreisgrenzen berechnet (`ST_Touches` in PostGIS) — bleibt dadurch immer korrekt.
- Auf dem Dashboard erscheint das Zuständigkeitsgebiet als eigener Karten-Layer (Umriss, Heimat-
  Landkreis hervorgehoben, Nachbarn gestrichelt), ein-/ausblendbar wie die anderen Layer.
- Als Nebenprodukt desselben Imports werden die 402 Kreis-Polygone zusätzlich je Bundesland zu 16
  Flächen aggregiert (Tabelle `bundesland`) — Grundlage für „Warnungen als Fläche“, siehe unten.
- **`GET /api/datapoints` filtert automatisch auf dieses Gebiet** (Heimat-Landkreis + Nachbarn,
  siehe `backend/src/utils/zustaendigkeit.js` + `utils/gebietFilter.js`) — drei Filterarten je nach
  Präzision der Quelle:
  1. **Kreis-genau** (`bbk_warnung`): wird beim Abruf schon pro Kreis erfragt, trägt den exakten
     Kreis in `payload.landkreisAgs` — einfacher Gleichheitsvergleich, die präziseste Filterart.
  2. **Geokoordinate** (PEGELONLINE, Hochwasserzentralen, NASA FIRMS, Waldbrandgefahrenindex —
     letzterer hat über die `dwd_station`-Zuordnung eine echte Stationskoordinate): muss innerhalb
     der Gebiets-Polygone liegen (`ST_Contains`). *Frühere Version hatte den Waldbrandgefahrenindex
     fälschlich wie Bundesland-genau (3.) behandelt — eine Station irgendwo im selben, oft großen
     Bundesland wurde dadurch angezeigt und einem Nachbarlandkreis zugeordnet, obwohl sie
     geografisch weit entfernt lag.*
     **Zusatzregel für PEGELONLINE + Hochwasserzentralen** (`RADIUS_SCOPED_SOURCES` in
     `gebietFilter.js`): Pegelmessstellen liegen nur an (Bundes-)Wasserstraßen — viele Kreise haben
     überhaupt keine eigene Station, auch nicht in ihren direkt angrenzenden Nachbarkreisen (nur ein
     Nachbarschafts-Ring wird berechnet). Reine Kreis-Zugehörigkeit blendete dadurch die nächstgelegene,
     für die Lage trotzdem relevante Messstelle komplett aus — ein Wehr konnte "Pegel"-Werte fetchen,
     aber auf Karte/Liste erschien nichts. Zusätzlich zählt daher ein 60km-Luftlinien-Umkreis um den
     Wehr-Kartenmittelpunkt (`ST_DWithin`) als ODER-Bedingung.
  3. **Bundesland-genau** (nur DWD-Unwetterwarnungen — einzige Quelle wirklich ohne
     Geokoordinate): gegen die im Gebiet vertretenen Bundesländer geprüft — präziser ist dort ohne
     die amtliche Warncell-Zuordnung nicht möglich (siehe „Warnungen als Fläche“ unten).

  Ist noch kein Heimat-Landkreis konfiguriert, bleibt die Anzeige bewusst ungefiltert (bundesweit),
  statt versehentlich alles auszublenden — das Dashboard zeigt dann einen Hinweis mit Link zur
  Einrichtung. Karte und Lage-Liste zeigen dadurch ausschließlich Meldungen aus dem eigenen und den
  angrenzenden Landkreisen, nicht mehr bundesweit.
- Ein neuer Dashboard-Tab **„Wetter“** fasst dieselben (bereits gebietsgefilterten) Datenpunkte je
  Quelle kompakt zusammen (Anzahl je Dringlichkeitsstufe als Badges, wichtigste Einzelmeldungen) —
  siehe „Wetter- & Lageübersicht“ unten.
- Die **Lage-Liste** (Dashboard-Tab „Lage“ und alle fünf Addon-Einzelseiten, `js/list.js` +
  `js/gebiet-info.js`) ist zusätzlich nach Landkreis gruppiert: Heimat-Landkreis zuerst, dann die
  Nachbarn alphabetisch, danach eine Sammelgruppe „Ganzes Bundesland“ für die beiden
  bundeslandweiten Quellen ohne Geokoordinate. Welcher Landkreis zu einer Meldung gehört, ermittelt
  `GET /api/datapoints` selbst per `LEFT JOIN LATERAL` gegen die `landkreis`-Polygone (`ST_Contains`)
  — eine feste Zuordnung wäre bei Meldungen nahe einer Kreisgrenze ungenau, die Live-Prüfung nicht.

### Datenquelle & Lizenzhinweis

Kreisgrenzen + amtliche Gemeindeschlüssel (AGS) stammen von
[m-ad/geofeatures-ags-germany](https://github.com/m-ad/geofeatures-ags-germany) (`node
src/importLandkreise.js`, einmaliger Import, kein Cron). Die Geometrie ist ursprünglich aus der
**GADM**-Datenbank abgeleitet, deren Lizenz Weiterverbreitung ohne Erlaubnis untersagt — die Daten
werden deshalb **bewusst nicht im EKats-Repository vorgehalten**, sondern bei jedem Import-Lauf
live von der Quelle geladen (wie bei den DWD-Datenquellen auch). Bei Bedarf `npm run
import-landkreise` erneut ausführen (idempotent).

## Wetter- & Lageübersicht für das eigene Gebiet

Dritter Tab neben „Lage“ und „Objekte“ auf dem Dashboard (`js/weather-overview.js`). Gruppiert die
bereits auf das Zuständigkeitsgebiet gefilterten Datenpunkte (siehe oben) je Quelle:

- Kopfzeile mit dem eigenen Gebiet („Mein Gebiet: Städteregion Aachen (Heimat) + Nachbarn: Düren,
  Euskirchen, Heinsberg“) bzw. einem Hinweis + Link zur Einrichtung, falls noch kein
  Heimat-Landkreis konfiguriert ist.
- Je Quelle (DWD-Unwetterwarnung, Waldbrandgefahrenindex, Landespegel, Pegelstand, Feuer-
  Hotspot): Anzahl der Meldungen je Dringlichkeitsstufe als farbige Badges, darunter die bis zu
  fünf dringendsten Einzelmeldungen — Klick fokussiert wie in der Lage-Liste die Karte und öffnet
  das Detail-Panel.
- Das Detail-Panel zeigt seit dieser Erweiterung zusätzlich quellenspezifische Informationen aus
  den Rohdaten, die zuvor nirgends in der App auftauchten: bei DWD-Unwetterwarnungen insbesondere
  **Beschreibung und amtliche Verhaltenshinweise** (`payload.description`/`payload.instruction`,
  von der DWD-API mitgeliefert) — die eigentlich wichtige Information für Einsatzkräfte, nicht nur
  die Warnstufe. Bei den übrigen Quellen z.B. Gewässername, zuständige Behörde, Satellit.
- **Bewusst keine neue Wetterdatenquelle** (z.B. Temperatur-/Windvorhersage): Die dafür nötigen
  DWD-Endpunkte (`opendata.dwd.de`) waren aus der Entwicklungsumgebung dieses Projekts nicht
  erreichbar, siehe „Windrichtung/-geschwindigkeit“ weiter unten — die Übersicht fasst stattdessen
  die bereits vorhandenen, verifizierten Quellen besser aufbereitet zusammen.

## Prioritäts-Leiste (Einsatzleiter-Portal, Phase 1)

Vier Ampel-Kacheln (Kritisch/Hoch/Mittel/Unauffällig) oberhalb der Karte auf dem Dashboard
(`js/priority-bar.js`) — verdichten die gesamte Lage auf einen Blick, statt jede Zeile der
Lage-Liste einzeln durchgehen zu müssen. Umsetzung von Phase 1 des Konzeptpapiers
„Einsatzleiter-Portal 2.0" (Recherche zu neuen Datenquellen + Dashboard-UX-Konzept).

- Zählt **alle** Datenpunkt-Quellen zusammen (nicht mehr getrennt je Quelle) UND überfällige
  Objekt-Überprüfungen (`isOverdue()` aus `objects.js`) in der „Kritisch"-Kachel — Objekte und
  Wetterlage konkurrieren um dieselbe Aufmerksamkeit eines Einsatzleiters, siehe Konzeptpapier
  „Objekte gehören in dieselbe Prioritätslogik".
- Klick auf eine Kachel filtert die Lage-Liste auf genau diese Dringlichkeitsstufe (erneuter Klick
  hebt den Filter wieder auf).
- Nur auf dem Dashboard, nicht auf den Addon-Einzelseiten (dort gibt es nur eine Quelle und keine
  Objekte, die Kacheln wären redundant zu den dortigen Dringlichkeits-Badges).

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
eigener Layer, als (abgerundetes) Quadrat mit der Objekt-Nummer darauf dargestellt (unterscheidbar
von den runden, nach Dringlichkeit eingefärbten Lage-Markern). Das Formular selbst ist thematisch
gruppiert (Stammdaten/Adresse/Ansprechpartner/Planstatus/Gebäudedaten/Besonderheiten/DIN-14095-
Standardfelder als eigene Abschnitte statt einer langen Liste) — Vorbild ist auch hier das
ursprüngliche lokale Feuerwehr-Objektverwaltungstool, dessen Feld-Gruppierung und -Umfang EKats bei
dieser Überarbeitung übernommen hat (siehe strukturierte Adresse, Kontakt-Email/Notfalltelefon,
Planstatus und Gebäudedaten unten in "Anlegen").

- **Anlegen** (Rolle Stab/Admin): Button „Objekt anlegen“ klicken — öffnet direkt das Formular für
  Name, Kategorie, Adresse, besondere Gefahren, Zufahrt/Schlüsseldepot, Ansprechpartner und
  Überprüfungsintervall. Die Position (lat/lon, Pflichtfeld) lässt sich auf drei Wegen setzen: Adresse
  eintragen und „Koordinaten aus Adresse ermitteln“ klicken (Geocoding über den öffentlichen
  [Nominatim](https://nominatim.org/)-Dienst von OpenStreetMap, reiner Client-seitiger Lookup — siehe
  CSP `connect-src` in `backend/src/app.js`), „Position auf Karte wählen“ klicken und auf die Karte
  klicken (der Dialog schließt dafür kurz, bereits eingegebene Werte bleiben erhalten und werden beim
  Wiederöffnen übernommen), oder lat/lon direkt eintippen. Beim Bearbeiten sind dieselben Felder
  vorbelegt und lassen sich auf demselben Weg korrigieren (z.B. nach ungenauer Erst-Geocodierung).
  Frühere Version verlangte den Kartenklick *vor* dem Formular — dieser direktere Ablauf orientiert
  sich am ursprünglichen, lokalen Feuerwehr-Objektverwaltungstool, das diese Funktion inspiriert hat.
- **Bearbeiten/Löschen** (Stab/Admin): bestehendes Objekt auf der Karte oder in der Objekt-Liste
  anklicken.
- **Ansehen** (Mitglied): Klick öffnet dieselbe Ansicht schreibgeschützt (Formularfelder,
  Aufgaben-Formular und Anhangs-Upload sind deaktiviert/ausgeblendet).

Objekte sind je Wehr gespeichert (`critical_object`-Tabelle,
`backend/sql/migrations/002_add_critical_objects.sql`).

### Fahrzeuge/Wachen und Aufgaben (Einsatzpläne)

Im Admin-Bereich werden **Wachen** und **Fahrzeuge** als eigene Stammdaten gepflegt (je Wehr, nur
Admin darf anlegen/löschen — jede Rolle darf sie lesen, z.B. um sie einer Aufgabe zuzuordnen).
Ein Fahrzeug kann optional einer Wache zugeordnet werden.

Je Objekt lassen sich beliebig viele **Aufgaben** hinterlegen (Titel + Beschreibung), jede Aufgabe
ist **entweder** einem Fahrzeug **oder** einer Wache zugeordnet (serverseitig per CHECK-Constraint
erzwungen). Für jedes Fahrzeug/jede Wache mit mindestens einer Aufgabe an einem Objekt erscheint im
Objekt-Dialog ein PDF-Download-Link („PDF: <Name>“) — das erzeugte PDF enthält Objektname/-adresse
und die für dieses Fahrzeug/diese Wache hinterlegten Aufgaben (`backend/src/routes/objects.js`,
`renderTasksPdf` via `pdfkit`). Anlegen/Bearbeiten/Löschen von Aufgaben ist Stab/Admin vorbehalten.

Schema: `vehicle`, `station`, `critical_object_task` (`backend/sql/migrations/003_add_tasks_vehicles_attachments.sql`).

### Datei-Anhänge (Lagepläne/Grundrisse)

Je Objekt können Dateien (PNG/JPEG/WebP/GIF/PDF, Größenlimit über `MAX_UPLOAD_MB` in `.env`,
Standard 15 MB) hochgeladen werden — z.B. Lagepläne oder Grundrisse. Dateien werden **außerhalb**
des Web-Roots unter `backend/storage/objects/` abgelegt und ausschließlich über einen
authentifizierten Download-Endpunkt ausgeliefert (nie als statische Datei erreichbar). Hochladen/
Löschen ist Stab/Admin vorbehalten, Ansehen/Herunterladen allen Rollen möglich.

Schema: `critical_object_attachment` (`backend/sql/migrations/003_add_tasks_vehicles_attachments.sql`).

### Überprüfungs-Turnus

Je Objekt lässt sich ein Überprüfungsintervall in Monaten hinterlegen (z.B. „alle 12 Monate den
Lageplan aktualisieren“). Der Objekt-Dialog zeigt den Status („Zuletzt überprüft … · Fällig …“,
inkl. Hervorhebung bei Überfälligkeit) und einen Button „Jetzt als überprüft markieren“
(Stab/Admin), der `last_reviewed_at` auf jetzt setzt. Ohne Intervall gilt ein Objekt als „kein
Turnus definiert“ und taucht nie als überfällig auf.

Schema: `critical_object.review_interval_months` / `last_reviewed_at`, `next_review_at` wird bei
jeder Abfrage aus `COALESCE(last_reviewed_at, created_at) + review_interval_months` berechnet
(`backend/sql/migrations/004_add_object_review_schedule.sql`).

### Objekt-Übersichtsliste

Ein zweiter Tab neben der Lage-Übersicht („Objekte“) zeigt alle Objekte der eigenen Wehr als Liste,
mit Volltextsuche (Name/Adresse), Kategorie-Filter, Sortierung (Name/Kategorie/Fälligkeit) und
einem Schnellfilter „Nur überfällige“. Ein Klick auf einen Listeneintrag öffnet denselben
Objekt-Dialog wie ein Klick auf den Kartenmarker.

### Objekt-Einzelseite (`objekt-detail.html`)

Eigenständige Seite je Objekt (`objekt-detail.html?id=<id>`, erreichbar per Klick auf eine Tabellenzeile
oder einen Kartenmarker auf `objekte.html`) statt eines Dialogs — Vorbild ist auch hier das
ursprüngliche lokale Feuerwehr-Objektverwaltungstool des Nutzers: Kopfbereich mit Zurück-Link, Titel,
„#id · Kategorie · Ort"-Unterzeile und Aktions-Buttons (PDF exportieren/Bearbeiten/Löschen), darunter
zweispaltig links die gruppierten Themenblöcke — Stammdaten, Ansprechpartner, Planstatus,
Gebäudedaten, **Gebäude- und Anlagentechnik (DIN 14095)** (Löschwasser-Ergiebigkeit/-Lage,
Brandmeldeanlage + Aufschaltstelle, max. Personenzahl, Aufzüge, Rauch-/Wärmeabzugsanlage,
PV-/Batteriespeicher + Notabschaltung), Besonderheiten & Gefahren, Überprüfung, optional Notizen und
**Zusatzfelder** (wehr-eigene Custom-Felder aus `/object-fields`, schreibgeschützt formatiert nach
`field_type`) — rechts eine interaktive Mini-Karte mit Marker, eine **Kartenskizze**-Karte (Vorschau +
„Skizze bearbeiten", siehe unten) sowie eine Metadaten-Karte (erstellt/zuletzt geändert).
„Bearbeiten" verlinkt auf `index.html?object=<id>` — die Hauptkarte öffnet dieses Objekt beim Laden
automatisch im Formular-Dialog (für Mitglied schreibgeschützt, sonst bearbeitbar), da
Anlegen/Bearbeiten mit Kartenposition weiterhin dort verankert bleibt. Es gibt keinen
Einzelobjekt-GET-Endpunkt — die (ohnehin kleine) Wehr-weite Objektliste wird geladen und das Objekt
clientseitig herausgefiltert.

### Objekt-Detailseite (`objekte.html`)

Eigenständige, tiefere Ansicht zusätzlich zur Karte (die für Anlegen/Bearbeiten mit Kartenposition
weiterhin allein zuständig bleibt) — nutzt dieselbe generische Tabellen-Komponente wie die
Themenseiten, mit allen Standard- und wehr-eigenen Zusatzfeldern als frei wählbaren Spalten. Vier
Werkzeuge:

- **„Nur überfällige"-Ansicht** — dieselbe Überfälligkeits-Logik wie die Dashboard-Liste, hier als
  eigener Umschalter statt Checkbox.
- **Massenbearbeitung** — mehrere Objekte per Checkbox auswählen und in einem Rutsch das
  Überprüfungsintervall setzen (`Promise.all` über die bestehende `PATCH /api/objects/:id`-Route,
  kein neuer Bulk-Endpunkt nötig).
- **Karten-Mini-Vorschau je Zeile** — ein kleiner, nicht-interaktiver Leaflet-Ausschnitt direkt in
  der Tabellenzeile statt nur Adresstext.
- **Sammel-PDF-Export** — Datenblätter aller ausgewählten (oder, ohne Auswahl, aller aktuell
  gefilterten) Objekte werden sequentiell als einzelne PDFs heruntergeladen (bewusst nacheinander
  statt parallel, damit der Browser das nicht als Popup-Flut blockiert).
- **„Karte anzeigen"-Umschalter** — blendet zusätzlich zur Tabelle eine Übersichtskarte mit allen
  (gefilterten) Objekten ein, nummerierte Marker wie auf der Hauptkarte, Klick öffnet denselben
  Detail-Dialog. Erst beim ersten Einblenden initialisiert (Leaflet braucht einen bereits sichtbaren,
  korrekt bemessenen Container). Bleibt bewusst rein zur Orientierung — Anlegen/Bearbeiten mit
  Kartenposition ist weiterhin allein Sache der Hauptkarte.

### Kartenskizzen direkt am Objekt

Sowohl im Objekt-Dialog (Karte) als auch auf der eigenständigen Objekt-Detailseite
(`objekt-detail.html`) lässt sich zusätzlich zu den Anhängen eine **Kartenskizze** direkt in der App
einzeichnen. Werkzeuge:

- **Freihand-Stift** und **Flächen** (Rechteck, freies Polygon, Kreis) in einer frei wählbaren Farbe
  (natives `<input type="color">`, Vorgabe Feuerwehr-Rot `#b3261e`)
- **Symbolpalette**, angelehnt an gängige Einsatzplan-Piktogramme: Zugang, Gefahrenbereich,
  Sammelplatz, Hydrant, Absperrung, Fluchtweg, Stromabschaltung, Gasabsperrung, Brandmeldezentrale
- **Freie Textbeschriftung** (Klick platziert einen Marker, Text wird abgefragt und als kleines
  Label auf der Karte angezeigt)

Anders als ein hochgeladener Lageplan bleibt die Skizze **strukturiert bearbeitbar**: gespeichert
wird sie als GeoJSON (`critical_object_map_sketch`, Migration 012) statt als Bild — Stiftlinien und
Flächen als `LineString`/`Polygon`-Features mit einer `color`-Eigenschaft, Symbole als
`Point`-Features mit `symbolKey`, Kreise als `Point` mit `properties.shapeType: "circle"` +
`radius` (Meter, da `L.Circle` selbst keinen GeoJSON-Radius kennt — wird beim Speichern manuell aus
`layer.getRadius()` ergänzt), Textlabels als `Point` mit `properties.text`. Eine schreibgeschützte
Vorschau (dieselbe Komponente an beiden Einbindungsorten) zeigt die Skizze, ein
„Skizze bearbeiten"-Button öffnet den interaktiven Editor.

Technisch auf [Leaflet-Geoman](https://github.com/geoman-io/leaflet-geoman) aufgebaut (Freie
Version, MIT-Lizenz, lokal vendored unter `frontend/public/vendor/leaflet-geoman/` — Lizenztext
liegt daneben) statt Geomans eigener Formen-Toolbar nutzt EKats nur `map.pm.enableDraw()`
programmatisch, ausgelöst über die eigene, für Feuerwehrpläne zugeschnittene Symbolleiste — auch die
Textbeschriftung ist ein eigener Marker-Modus statt Geomans eingebautem `Text`-Werkzeug, damit die
Serialisierung vollständig unter eigener Kontrolle bleibt. Die Farbe einer Form wird bewusst NACH
dem Zeichnen per `layer.setStyle()` angewendet (nicht nur über Geomans Zeichen-Vorschau-Optionen),
damit unabhängig vom Formtyp (Linie/Rechteck/Polygon/Kreis) eine einzige Stelle die Endfarbe
bestimmt. Kein Netzwerkzugriff nötig für die Zeichenfunktion selbst (nur die Kartenkacheln laden
weiterhin von OpenStreetMap) — funktioniert daher auch bei eingeschränkter Konnektivität zur Karte,
solange diese bereits einmal geladen wurde.

### Wehr-weite Hydrantenkarte

`hydranten.html` ("Objekte" in der Seitenleiste, neben der Objekt-Übersicht) erweitert dieselbe
Kartenskizzen-Idee vom einzelnen Objekt auf das **gesamte Zuständigkeitsgebiet der Wehr** —
Löschwasserversorgung (Hydranten, Löschteiche, Saugstellen) ist nicht an einzelne Objekte gebunden
und gehört nicht in eine einzelne Objekt-Skizze. Technisch eine Zeile je Wehr statt je Objekt
(`wehr_hydranten_karte`, Migration 021, sonst identisches Schema wie `critical_object_map_sketch`).

**Derselbe Editor, andere Speicher-URL:** Statt den Kartenskizzen-Editor zu duplizieren, wurde
`ObjectSketchEditor` (`js/object-sketch.js`) minimal generalisiert — ein optionaler `saveUrl`-Parameter
überschreibt die sonst aus `objectId` abgeleitete Standard-URL (`/objects/:id/sketch`); die
bestehenden Aufrufstellen (Objekt-Dialog, Objekt-Detailseite) übergeben weiterhin nur `objectId` und
verhalten sich unverändert. Symbolpalette (inkl. eines eigenen "Hydrant"-Symbols 🚰), Zeichenwerkzeuge
und Serialisierung sind dadurch für beide Anwendungsfälle exakt identisch. API:
`GET/PUT/DELETE /api/hydranten-karte` (Lesen für alle Rollen, Schreiben nur `stab`/`admin`), 500 KB
Größenlimit (großzügiger als die 300 KB je Objektskizze, da eine wehrweite Karte deutlich mehr Punkte
enthalten kann).

### Export / Import

Im Admin-Bereich („Objektdaten-Export/-Import“) lassen sich alle Objekte der eigenen Wehr inkl.
aller Aufgaben und Anhangs-**Metadaten** (Dateiname/Typ/Größe, nicht die Binärdateien selbst) als
JSON-Datei herunterladen (`GET /api/objects/export`, Stab/Admin). Die eigentlichen Anhangsdateien
müssen einzeln über den Datei-Download-Endpunkt geholt werden.

Dieselbe Datei kann über denselben Admin-Bereich wieder importiert werden (`POST
/api/objects/import`, Stab/Admin) — z.B. als Sicherung/Wiederherstellung oder um Objektdaten in eine
andere EKats-Installation zu übertragen. Sicherheits- und Datenintegritäts-Überlegungen:

- **Immer Neuanlage, nie Überschreiben**: `critical_object.id` ist eine global (nicht je Wehr)
  fortlaufende Seriennummer — eine importierte `id` aus einer fremden Installation zu übernehmen
  würde entweder auf ein zufälliges, völlig anderes Objekt derselben Wehr zeigen oder mit einer
  bestehenden `id` kollidieren. Der Import ignoriert importierte `id`-Werte daher vollständig und
  legt jedes Objekt als komplett neue Zeile mit neuer `id` an; bestehende Objekte werden nie
  verändert oder gelöscht.
- **Wehr-Scoping**: importierte Objekte werden immer der Wehr des einloggten Nutzers zugeordnet,
  unabhängig davon, welcher Wehr sie ursprünglich gehörten — verhindert, dass eine Export-Datei
  versehentlich fremde Wehr-Zuordnungen in die eigene Installation einschleust.
- **Aufgaben-Zuordnung per Name statt ID**: aus demselben Grund referenziert eine exportierte
  Aufgabe ihr Fahrzeug/ihre Wache nicht über die (in der Zielinstallation bedeutungslose)
  `vehicle_id`/`station_id`, sondern über den zum Exportzeitpunkt aktuellen Namen
  (`vehicle_name`/`station_name`). Beim Import wird dieser Name gegen die Fahrzeuge/Wachen der
  eigenen Wehr abgeglichen; findet sich kein exakter Treffer, wird die Aufgabe übersprungen und als
  „Aufgaben-Hinweis“ in der Ergebnismeldung aufgeführt, statt das Objekt selbst fehlschlagen zu
  lassen.
- **Zeilenweise Fehlerbehandlung**: jedes Objekt wird einzeln validiert (Pflichtfelder, bekannte
  Zusatzfeld-Schlüssel und -Typen anhand der *aktuellen* Feld-Definitionen der Wehr — siehe
  „Zusatzfelder“ unten). Ein fehlerhaftes Objekt wird mit Fehlermeldung übersprungen, der Import der
  restlichen Datei läuft trotzdem weiter; die Antwort listet importierte Anzahl, übersprungene
  Objekte samt Grund und Aufgaben-Hinweise gesammelt auf.
- Rollenbeschränkung wie beim Export (`requireRole('stab', 'admin')`); die JSON-Body-Größe (`app.js`,
  `express.json`) wurde von 200kb auf 2mb angehoben, da eine Export-Datei mit vielen Objekten und
  vollen Freitextfeldern das alte Limit überschreiten kann.

### Import aus der urspünglichen, lokalen Feuerwehr-Objektverwaltung

Zusätzlicher, eigener Importer (`POST /api/objects/import-feuerwehrapp`, Admin-Bereich → Objektdaten-
Export/-Import) für Wehren, die zuvor das ursprüngliche, lokale Feuerwehr-Objektverwaltungstool
(Electron/Node-App, SQLite über `sql.js`) genutzt haben und ihre Bestandsdaten übernehmen wollen -
anderes Datenmodell als EKats, daher ein eigener Endpunkt statt Wiederverwendung des JSON-Imports
oben. Liest die hochgeladene `.sqlite`-Datei direkt aus dem Upload-Buffer via `sql.js` (WASM, keine
native Kompilierung nötig - dieselbe Bibliothek, die das Referenz-Tool selbst verwendet), ohne sie
auf Platte zu schreiben.

- **Feld-Mapping**: strukturierte Adresse (Straße/Hausnr./PLZ/Ort/Ortsteil), Kontakt-Email/
  Notfalltelefon, Planstatus, Baujahr/Etagen/Fläche/Besonderheiten übernehmen 1:1 (dieselben Felder
  wurden für EKats extra ergänzt, siehe oben). Der freie Objekttyp des Referenz-Tools wird
  bestmöglich auf die feste EKats-Kategorie-Enum abgebildet (`FEUERWEHRAPP_TYPE_TO_CATEGORY` in
  `routes/objects.js`), unbekannte/eigene Typen landen in „Sonstiges" statt den Import mit einem
  Fehler abzubrechen. Die dortige einzelne Freitext-Löschwasserversorgung wird als Bestwert in EKats'
  Feld „Lage/Standort" übernommen (EKats hat hier drei strukturierte Felder statt einem) - „Art"
  bleibt bewusst leer statt fälschlich „keine Angabe" zu suggerieren.
- **Gleiche Sicherheitsprinzipien wie beim JSON-Import**: jedes Objekt wird immer als neue Zeile in
  der eigenen Wehr angelegt (nie per fremder id referenziert/überschrieben), Fahrzeugaufgaben werden
  per Fahrzeugname (nicht per dort bedeutungsloser id) gegen die eigenen Fahrzeuge zugeordnet -
  unbekannte Fahrzeugnamen werden als Hinweis gemeldet, nie stillschweigend verworfen oder falsch
  verknüpft. Zusatzfelder durchlaufen dieselbe Validierung (`validateCustomFields`) gegen die
  aktuellen Feld-Definitionen der Wehr. Einzelne fehlerhafte Objekte (z.B. fehlende Koordinaten)
  überspringen nur diese Zeile, nicht den gesamten Import.
- Datei-Erkennung per Endung (`.sqlite`/`.sqlite3`/`.db`) statt MIME-Type, da Browser dafür keinen
  standardisierten MIME-Type senden. Multipart-Upload mit eigenem 25MB-Limit (separates
  `multer.memoryStorage()`, unabhängig vom JSON-Body-Limit oben).

### Standardfelder (Einsatzplan, DIN 14095)

Zusätzlich zu den Kernfeldern trägt jedes Objekt zwölf recherchierte Standardfelder, angelehnt an
die in DIN 14095 „Feuerwehrpläne für bauliche Anlagen" für den Abschnitt „Allgemeine
Objektinformationen" üblichen Angaben: Löschwasserversorgung (Art/Ergiebigkeit in l/min/Lage —
Unterflur-/Überflur-Hydrant, Löschwasserbrunnen, Zisterne, Löschteich, offenes Gewässer),
Brandmeldeanlage (vorhanden + Aufschaltstelle), maximale Personenzahl, Aufzüge, Rauch-/
Wärmeabzugsanlage, PV-/Batteriespeicheranlage (vorhanden + Lage der Notabschaltung — ein in der
Praxis zunehmend relevantes Gefahrenmerkmal für die Einsatztaktik), Sammelplatz und Baujahr. Diese
Recherche stützt sich auf öffentlich zugängliche Zusammenfassungen der Norm (die DIN-Norm selbst ist
kostenpflichtig und aus dieser Entwicklungsumgebung nicht abrufbar) sowie gängige
Löschwasserversorgungs-Konventionen (Durchmesser × 10 l/min für Unterflur-, × 15 l/min für
Überflur-Hydranten) — **kein verbindliches Normzitat**, sondern eine begründete Näherung an die in
der Praxis für Feuerwehrpläne relevanten Angaben. Alle Felder sind optional und ohne Vorbelegung.

Schema: zwölf Spalten auf `critical_object`
(`backend/sql/migrations/008_add_object_custom_fields.sql`).

### Zusatzfelder (frei definierbar je Wehr)

Reichen die Standardfelder nicht aus, kann jede Wehr im Admin-Bereich („Objekt-Zusatzfelder")
beliebige weitere Felder je Objekt definieren: Schlüssel (technischer Name), Label, Typ (Text,
mehrzeiliger Text, Zahl, Ja/Nein, Datum, Auswahlliste mit selbst definierten Optionen) und ob das
Feld Pflicht ist. Der Objekt-Dialog rendert daraus automatisch die passenden Eingabeelemente; die
Werte liegen gesammelt als JSON in `critical_object.custom_fields` und werden bei jedem
Speichern serverseitig gegen die aktuellen Definitionen geprüft (unbekannter Schlüssel, falscher
Typ oder fehlendes Pflichtfeld → 400). Lesen dürfen alle Rollen, Definitionen anlegen/ändern/löschen
ist Admin vorbehalten; Schlüssel und Typ sind nach dem Anlegen nicht mehr änderbar (bereits
gespeicherte Werte referenzieren den Schlüssel direkt).

Schema: `object_field_definition` (`backend/sql/migrations/008_add_object_custom_fields.sql`).

### Objekt-Datenblatt (PDF)

Zusätzlich zu den Aufgabenzetteln lässt sich für jedes Objekt ein vollständiges Datenblatt mit allen
Kern-, Standard- und Zusatzfeldern als PDF exportieren (Link „PDF: Objekt-Datenblatt" im
Objekt-Dialog) — sofern im Admin-Bereich eine Vorlage für den Dokumenttyp „Objekt-Datenblatt"
hinterlegt ist (siehe „PDF-Vorlagen" unten). Ohne Vorlage liefert der Endpunkt bewusst einen klaren
Fehler statt eines leeren PDFs.

## Zugriffssteuerung je Datenquelle

Seit Phase 5 ist die Zugriffssteuerung, die ursprünglich nur für Kachelmann galt (siehe unten),
auf **alle acht Datenquellen** generalisiert (`backend/src/utils/featureAccess.js`,
`backend/src/routes/featureAccess.js`, Migration 009). Im Admin-Bereich (Abschnitt
„Zugriffssteuerung je Datenquelle") legt ein Admin für jede Quelle einzeln fest, welche **Rollen**
standardmäßig Zugriff haben (`wehr_feature_role_access`, Matrix-Ansicht mit einer Zeile je
Quelle), und kann zusätzlich über die Einzelnutzer-Freigabe **einzelne Nutzer** individuell
freischalten oder sperren (`user_feature_access`) — ein Einzel-Override gewinnt in beide
Richtungen gegen die Rollen-Voreinstellung.

`GET /api/datapoints` prüft den Zugriff quellen-generisch: eine gezielte Abfrage
(`?source=...`) ohne Zugriff liefert `403`; die ungefilterte Abfrage (kombinierte Lage-Übersicht)
blendet Quellen ohne Zugriff still aus, statt einen Fehler zu werfen. Eine Quelle **ohne
konfigurierte Regel bleibt offen für alle** (Rückwärtskompatibilität — die Zugriffssteuerung war
vor Phase 5 nicht vorhanden, ihr bloßes Ausrollen darf keine bisher freie Quelle versehentlich
sperren). Die einzige Ausnahme ist **Kachelmann/Meteologix**: als einzige kostenpflichtige Quelle
bleibt sie ohne konfigurierte Regel gesperrt (`DEFAULT_CLOSED_FEATURES` in `featureAccess.js`), um
keinen versehentlichen API-Kostenanfall zu riskieren. Die Matrix-Ansicht im Admin-Bereich markiert
diese Quelle entsprechend mit einem Hinweis-Badge „ohne Regel gesperrt".

## Kachelmann/Meteologix (optionale Zusatz-Wetterquelle)

Als siebte Datenquelle ist ein Connector für die kommerzielle Kachelmannwetter/Meteologix-API
vorbereitet (`backend/src/fetchers/kachelmann.js`) — vom Nutzer als optionales, später
abonnementpflichtiges Feature gewünscht. Anders als die übrigen Quellen ist sie **nicht für jede
Wehr automatisch aktiv**, sondern über die oben beschriebene Zugriffssteuerung frei- bzw.
sperrbar (und dort die einzige Quelle, die ohne aktive Freigabe geschlossen bleibt):

- Der Fetcher selbst läuft nur, wenn zusätzlich ein `KACHELMANN_API_KEY` gesetzt ist **und**
  mindestens eine Rolle/ein Nutzer Zugriff hat — sonst überspringt er den Lauf mit einer klaren
  Log-Meldung statt unnötig eine kostenpflichtige API anzufragen.
- Sind Zugriff und API-Key vorhanden, erscheinen Kachelmann-Meldungen automatisch überall dort,
  wo auch die anderen Quellen erscheinen (Karte, Lage-Liste, Prioritäts-Leiste,
  Wetter-Übersicht) — die gesamte Anzeige-Pipeline ist quellen-generisch (`SOURCE_LABELS`,
  `severityScore()` in `js/severity.js`), es war dafür **keine eigene Widget-Komponente** nötig,
  nur ein Eintrag in der bestehenden Quellen-Zuordnung plus die Aufnahme in
  `WEATHER_SOURCE_ORDER` (`js/weather-overview.js`), analog zu `dwd_unwetter`.

**Verifikationsstand (Stand: Nutzer hat inzwischen einen echten Kachelmann-„Public API"-Zugang):**
Der Nutzer hat die interaktive Swagger-Doku (`api.kachelmannwetter.com/v02/_doc.html`) als
HTML-/PDF-Export bereitgestellt (aus dieser Sandbox selbst nicht erreichbar). Daraus **verifiziert**:
Basis-URL `https://api.kachelmannwetter.com/v02`, Auth-Header `X-API-Key`. Diese „Public API" deckt
Stationsdaten, aktuelles Wetter, Vorhersagen und Astronomie ab — **keine Warnungen, kein
Regenradar** (kommt in der kompletten Doku nicht vor). Das separate „Unwetteralarm Pro"-Produkt des
Nutzers (`pro.meteologix.com`) ist ein reines Web-Dashboard ohne eigenen API-Zugang — Regenradar/
Warnungen bleiben daher weiterhin über den bestehenden DWD-WMS-Layer abgedeckt, nicht über
Kachelmann. Der Fetcher ruft entsprechend `fetchKachelmannCurrentWeather()` statt Warnungen ab
(Endpunktpfad `.../weather/current/{lat}/{lon}` von der einzigen im Doku-Export im Detail gezeigten
Operation abgeleitet, aber selbst **nicht verifiziert** — vor Produktivbetrieb mit dem echten
API-Key gegen `npm run fetch -- kachelmann` prüfen; die Fehlermeldung bei falschem Pfad enthält
einen fertigen `curl`-Befehl zum Gegenprüfen).

Schema: `wehr_feature_role_access`, `user_feature_access`
(`backend/sql/migrations/009_add_feature_access.sql`).

## Blitzortung.org (Live-Gewitterzug)

Neunte Datenquelle, ursprünglich im Konzeptpapier "Einsatzleiter-Portal 2.0" (Phase 2) vorgeschlagen
und dort zunächst offen geblieben: `backend/src/fetchers/blitzortung.js` bindet das kostenlose,
gemeinnützige Community-Blitzortungsnetz Blitzortung.org an, um "wohin zieht das Gewitter gerade"
sichtbar zu machen — ohne RADOLAN-Binärformat parsen zu müssen (siehe „Geplant: Wetter-Entwicklung"
unten für den Hintergrund, warum das bisher nicht direkt über DWD-Rohdaten ging).

**Technisch eine Ausnahme unter den zehn Quellen:** Blitzortung.org bietet keine periodisch
abrufbare HTTP-API, sondern einen dauerhaft offenen WebSocket-Livestream einzelner
Blitzeinschläge. Statt eines `FETCH_*_CRON`-Jobs läuft deshalb eine einzelne, lang laufende
Verbindung mit automatischem Reconnect (inkl. Verbindungs-Timeout, falls ein Netzwerkproblem die
Verbindung stillschweigend haengen laesst statt sie aktiv abzulehnen), gestartet einmal beim
Server-Start (`index.js`, `startBlitzortungStream()`) statt über `scheduler.js`. Abschaltbar über
`BLITZORTUNG_ENABLED=false` in `.env` (z.B. falls ausgehende WebSocket-Verbindungen auf dem
Produktivserver per Firewall blockiert sind).

**Gebietsfilterung schon bei der Aufnahme, nicht erst bei der Abfrage:** Das globale Netz liefert
während aktiver Gewitterlagen potenziell tausende Einschläge pro Minute weltweit — ungefiltert
würde `live_datapoint` explodieren. Nur Einschläge innerhalb `BLITZORTUNG_RADIUS_KM` (Standard 75
km) um mindestens einen Wehr-Kartenmittelpunkt werden gespeichert, dieselbe Grundidee wie
`FIRMS_RADIUS_KM` bei NASA FIRMS, nur am Empfang statt an der Abfrage-URL. Jeder Einschlag bleibt
zusätzlich nur 30 Minuten als "gültig" markiert (`valid_until`) und verschwindet danach von selbst
aus der Lage-Übersicht, ohne auf den nächtlichen Cleanup-Job warten zu müssen — ein einzelner
Blitzeinschlag ist für die Gewitterzug-Anzeige nur kurzfristig relevant.

**Verifikationsstand:** Das Protokoll (vier gleichwertige Server
`wss://ws{1,5,6,7}.blitzortung.org:3000/`, Subscribe-Nachricht `{"time":0}`, reines JSON ohne
zusätzliche Kompression) ist gegen die aktiv gepflegte, quelloffene Referenzimplementierung
[SimonSchick/BlitzortungAPI](https://github.com/SimonSchick/BlitzortungAPI) abgeglichen, aber
**nicht live gegen den echten Server getestet** — blitzortung.org ist wie alle Drittanbieter-Hosts
in der Entwicklungsumgebung nicht erreichbar. Ein zusätzlicher, dort dokumentierter Vorbehalt: das
Zeitfeld (`time`) ist eine Nanosekunden-Unix-Epoche, die den verlustfrei darstellbaren
JS-Number-Bereich sprengt — die Umrechnung nutzt `BigInt`, was einen als String übertragenen Wert
exakt handhabt; kommt der Wert stattdessen als JSON-Zahl, ist er bereits vor der Verarbeitung durch
`JSON.parse()` gerundet (technisch nicht mehr reparierbar, aber auch keine Verschlechterung
gegenüber dem Ist-Zustand). Unerwartete Nachrichtenformen werden laut geloggt statt still
falsch verarbeitet (`handleMessage()`), nach demselben Muster wie bei Kachelmann/Bright Sky.

**Nutzungsbedingungen:** Blitzortung.org untersagt die Weitergabe an Dritte über einen eigenen
öffentlichen Endpunkt (nur über einen selbst betriebenen Server). EKats zeigt die Daten
ausschließlich innerhalb der eigenen, per Login geschützten Wehr-Installation an — keine
öffentliche Weiterverbreitung, damit für den internen Gebrauch einer einzelnen Wehr unkritisch.

Kein neues Schema nötig — nutzt die bestehende `live_datapoint`-Tabelle wie die übrigen Quellen.

## Erdbeben (EMSC) + Recherche weiterer Quellen

Zehnte Datenquelle, aus dem Roadmap-Paket "Später" (siehe Produkt-Review September 2026):
`backend/src/fetchers/erdbeben.js` bindet den kostenlosen, unauthentifizierten
FDSN-Event-Webservice des European-Mediterranean Seismological Centre
(`seismicportal.eu`, derselbe Standard wie `earthquake.usgs.gov`) an — relevant für
KatS-Vollständigkeit auch in einem seismisch wenig aktiven Land (Kavernen-/Bergbaugebiete,
Grenzregionen). Abgefragt wird je Wehr ein Umkreis (`ERDBEBEN_RADIUS_KM`, Standard 300 km — bewusst
größer als bei den übrigen Quellen, da stärkere Beben auch deutlich weiter entfernt gespürt werden),
gefiltert auf mindestens `ERDBEBEN_MIN_MAGNITUDE` (Standard 2.0, filtert die häufigen Mikrobeben aus
Bergbau/Kavernen) innerhalb eines rollierenden Zeitfensters `ERDBEBEN_LOOKBACK_DAYS` (Standard 30
Tage). Ereignisse, die aus diesem Fenster herausaltern, verschwinden aus der "aktuellen Lage"
(`expireStaleItems()`, dieselbe Logik wie bei NASA FIRMS) — die Zeile bleibt bis zur regulären
Aufbewahrungsfrist erhalten, wird aber nicht mehr als aktiv angezeigt.

**Verifikationsstand:** Endpunkt/Parameter/JSON-Schema sind über die öffentliche
EMSC-CSEM/webservices101-Dokumentation verifiziert, aber **nicht live gegen den echten Server
getestet** — ein Abruf aus der Entwicklungsumgebung liefert "HTTP 403 Forbidden", während `curl`
gegen denselben Host von der hiesigen Egress-Firewall komplett verweigert wird; das 403 stammt damit
mit hoher Wahrscheinlichkeit von der Netz-Policy dieser Umgebung, nicht von seismicportal.eu selbst,
lässt sich von hier aber nicht abschließend unterscheiden. Vor Produktivbetrieb `npm run fetch --
erdbeben` von einem Server mit normalem Internetzugang prüfen (gleiches Muster wie bei
Kachelmann/BBK).

**Recherchiert, aber bewusst nicht gebaut** (siehe Produkt-Review Abschnitt "Neue Datenquellen"):

- **Radioaktivität (ODL, BfS-IMIS):** Es existiert ein offener WFS-Endpunkt
  (`imis.bfs.de/ogc/opendata/...&typeName=opendata:odlinfo_odl_1h_latest&outputFormat=application/json`),
  von Dritten nachweislich genutzt (siehe z.B. ein KNX-Forum-Plugin). Die offizielle BfS-Dokumentation
  erwähnt an anderer Stelle aber auch eine Registrierung (Benutzername/Passwort) für den
  Daten-Interface-Zugang — ob das nur eine separate, feiner aufgelöste Rohdatenschnittstelle betrifft
  oder auch diesen "opendata"-Layer, ließ sich von hier aus nicht zweifelsfrei klären (der Host war
  nicht erreichbar). Konsistent mit "erst verifizieren, dann bauen" (siehe Kachelmann-Historie) daher
  zurückgestellt, bis das an einem echten Zugang geprüft werden kann.
- **Straßensperrungen/Verkehr:** Der frühere "Mobilitäts Daten Marktplatz (MDM)" ist inzwischen in
  "Mobilithek" aufgegangen — ein Portal für Datenaustausch zwischen Behörden/Anbietern, keine
  einzelne, direkt konsumierbare bundesweite JSON-API für Straßensperrungen. Die Datenlandschaft ist
  weiterhin pro Bundesland/Baulastträger fragmentiert (wie schon im Produkt-Review vermutet) — ein
  Aufwand, der eine eigene, tiefere Recherche-Runde verdient, keinen spekulativen Fetcher gegen ein
  unklares Zielformat.

Kein neues Schema nötig — nutzt wie Blitzortung/FIRMS die bestehende `live_datapoint`-Tabelle.

## PDF-Vorlagen (HTML-Templates, Chromium-Rendering)

Die bisher fest im Code (`pdfkit`) erzeugten Aufgabenzettel lassen sich jetzt wehrweit über eigene,
im Admin-Bereich bearbeitbare HTML-Vorlagen ersetzen (Abschnitt „PDF-Vorlagen"), getrennt nach
Dokumenttyp (Aufgabenzettel / Objekt-Datenblatt) — inkl. Live-Vorschau mit Beispieldaten direkt im
Browser. Ohne hinterlegte Vorlage nutzt der Aufgabenzettel weiterhin den bisherigen
`pdfkit`-Fallback; das Objekt-Datenblatt existiert dagegen ausschließlich über die Vorlage (siehe
oben).

**Sicherheitsentscheidung „Platzhalter statt Skriptsprache":** Vorlagen kennen ausschließlich
`{{pfad.zu.feld}}` (Werteinsetzung), `{{#each pfad}}...{{/each}}` (Wiederholung über eine Liste,
z.B. die Aufgabenliste) und `{{#if pfad}}...{{/if}}` (Ein-/Ausblenden je Wahrheitswert) — bewusst
im Mustache-Stil „logic-less" ohne `eval()`, Ausdrücke, Vergleiche oder Funktionsaufrufe. Ein
kompromittierter Admin-Account kann damit keinen beliebigen Code auf dem Server ausführen, nur
vordefinierte Datenfelder einsetzen. Gerendert wird serverseitig per headless Chromium
(`page.setContent()`, kein Navigations-/Netzwerkzugriff — `page.route()` blockt zusätzlich jeden
Request als SSRF-Schutz, Bilder müssen daher als Data-URI eingebettet sein).

**Verifikationsstand/Performance (gemessen in dieser Entwicklungsumgebung):** Chromium wurde
probeweise installiert und gegen echte Vorlagen getestet (Playwright, `chromium.launch()` je
Export statt einer Dauerinstanz — ein PDF-Export ist eine seltene, admin-ausgelöste Aktion, kein
Hochlast-Pfad). Gemessene Werte: **~390 ms durchschnittliche Renderzeit** pro PDF und **~700 MB
transienter Spitzen-RSS** über den gesamten Chromium-Prozessbaum während des Renderns (danach sofort
wieder freigegeben, da der Browser-Prozess je Export beendet wird) — auf einem kleinen Plesk-VPS mit
wenig freiem RAM ist das im Blick zu behalten, aber für eine seltene, manuelle Aktion vertretbar. In
Produktion installiert `npm run postinstall`/`npx playwright install chromium` sein eigenes
Chromium; ein `PLAYWRIGHT_CHROMIUM_PATH` in `.env` ist nur für diese Sandbox nötig, in der ein
vorinstalliertes Chromium an einem abweichenden Pfad liegt.

Schema: `pdf_template` (`backend/sql/migrations/010_add_pdf_templates.sql`).

**Neue Platzhalter fürs Objekt-Datenblatt** (Migration 015, siehe „Objektverwaltung" oben):
`{{objekt.strasse}}`, `{{objekt.hausnummer}}`, `{{objekt.plz}}`, `{{objekt.ort}}`,
`{{objekt.ortsteil}}`, `{{objekt.contactEmail}}`, `{{objekt.emergencyPhone}}`,
`{{objekt.hasOfficialPlan}}`/`{{objekt.hasFwPlan}}` (Text „ja"/„nein", für ein Badge-Aussehen
`{{#if objekt.hasOfficialPlan}}...{{/if}}` nutzen), `{{objekt.planDate}}`, `{{objekt.planCreator}}`,
`{{objekt.floors}}`, `{{objekt.area}}`, `{{objekt.specialFeatures}}` — `{{objekt.adresse}}` bleibt
zusätzlich als vorformatierte einzeilige Anschrift verfügbar. Bestehende, vor Migration 015 erstellte
Vorlagen funktionieren unverändert weiter (nur zusätzliche Platzhalter, keine entfernt) — wer sie
nutzen will, muss sie im Vorlagen-Editor selbst ergänzen.

## Einsatztagebuch

`einsatztagebuch.html` ("Einsatzführung" in der Seitenleiste) schließt die größte inhaltliche Lücke
aus dem Produkt-Review: EKats bündelt externe Lage-Informationen sehr gut, bot aber bisher keine
Möglichkeit, während eines Einsatzes selbst etwas zu protokollieren. Ein durchlaufendes,
chronologisches Logbuch je Wehr (`einsatztagebuch_eintrag`, Migration 017) — bewusst **kein**
eigenes "Einsatz"-Konzept mit Beginn/Ende/Zuordnung (das wäre ein deutlich größerer Baustein mit
eigenem Lebenszyklus); ein Eintrag "Einsatz X begonnen" trägt sich als normaler Tagebucheintrag
genauso ein. Jeder Eintrag hat einen frei wählbaren `entry_time` (Default: jetzt, aber änderbar, da
ein Eintrag oft erst nachträglich getippt wird, den tatsächlichen Ereigniszeitpunkt aber zeigen
soll), eine optionale Kategorie (Meldung/Maßnahme/Lageänderung/Sonstiges) und den Freitext.

Lesen für alle Rollen, Anlegen/Ändern/Löschen nur für `stab`/`admin` (dasselbe Muster wie bei
`critical_object`) — die Formular-Karte ist für `mitglied` per `data-role="stab-only"` ausgeblendet.
API: `GET/POST/PATCH/DELETE /api/einsatztagebuch`, `GET` filterbar über `?since=&until=` (ISO-Zeit,
filtert auf `entry_time`). Kein PDF-Export in dieser ersten Ausbaustufe.

## Übergabeprotokoll

`uebergabeprotokoll.html` ("Einsatzführung" in der Seitenleiste, neben dem Einsatztagebuch) deckt
den zweiten Punkt aus dem "Später"-Roadmap-Paket ab: eine strukturierte Schichtübergabe statt eines
rein chronologischen Logs. Jeder Punkt (`uebergabe_eintrag`, Migration 019) hat genau zwei Zustände —
`offen`/`erledigt` — und die Seite zeigt zwei getrennte Listen ("Offene Punkte" oben, "Erledigt"
darunter), damit eine übernehmende Schicht auf einen Blick sieht, was noch aussteht. Ein Punkt lässt
sich abhaken und bei Bedarf wieder öffnen; ein Wechsel auf `erledigt` setzt automatisch
`resolved_by`/`resolved_at`, ein Zurückwechseln löscht diese Felder wieder, statt einen veralteten
Stand stehen zu lassen. Technisch bewusst dasselbe Grundmuster wie beim Einsatztagebuch (ein
durchlaufender Bestand je Wehr statt eigener "Schicht"-Datensätze mit Beginn/Ende) — der einzige
fachliche Unterschied ist der Status statt eines reinen Zeitstempels.

Lesen für alle Rollen, Anlegen/Status ändern/Löschen nur für `stab`/`admin` (identisches Muster wie
Einsatztagebuch/`critical_object`). API: `GET/POST/PATCH/DELETE /api/uebergabeprotokoll`, `GET`
filterbar über `?status=offen|erledigt`.

## Checklisten/SOPs

`checklisten.html` ("Einsatzführung" in der Seitenleiste) rundet das "Später"-Paket ab: hinterlegbare
Standard-Einsatz-Regeln je Objekttyp/Szenario, gemeinsam abhakbar. Zwei schlanke Tabellen
(`checklist_template`/`checklist_item`, Migration 020) statt eines vollen "Einsatz-Lauf"-Konzepts mit
eigener Instanz je Benutzung — eine Checkliste ist ein gemeinsam sichtbarer, gemeinsam abhakbarer
Arbeitsstand je Wehr (kein Journal vergangener Durchläufe), der sich per "Zurücksetzen" für den
nächsten Einsatz/die nächste Übung wieder leeren lässt.

**Zwei unterschiedliche Berechtigungsstufen innerhalb desselben Moduls:** Anlegen/Ändern/Löschen einer
Vorlage (Name, Objekttyp/Szenario, komplette Punkteliste) ist Admin-Konfiguration und bleibt
`stab`/`admin` vorbehalten — die komplette Punkteliste wird dabei transaktional ersetzt
(`DELETE`+`INSERT` in einer Transaktion über `withTransaction()`), das ist robuster als granulare
Einzel-Punkt-Endpunkte fürs Umsortieren/Hinzufügen/Entfernen. Das **Abhaken einzelner Punkte**
dagegen ist die eigentliche operative Nutzung während eines Einsatzes und bewusst für **alle** Rollen
offen, auch `mitglied` — ein eigener Endpunkt ohne Rollen-Gate
(`PATCH /api/checklists/items/:id`). API: `GET/POST/PATCH/DELETE /api/checklists`,
`PATCH /api/checklists/items/:id` (Haken), `POST /api/checklists/:id/reset` (alle Haken einer Vorlage
zurücksetzen, wieder `stab`/`admin`-only).

## Individuelles Dashboard (Phase 6, Raster-Umbau: Nutzerwunsch nach freier Position/Größe)

`dashboard.html` ("Mein Dashboard" in der Seitenleiste) ergänzt die feste Karten-Ansicht
(`index.html`, unverändert) um einen Baukasten aus aktuell 21 Widget-Typen (davon einer,
Audit-Log-Feed, nur für die Rolle `admin` im „Widget hinzufügen"-Dialog sichtbar — clientseitig
gefiltert über ein `adminOnly`-Flag im Widget-Katalog, der Endpunkt selbst ist ohnehin
serverseitig `requireRole('admin')`-geschützt): Karte
(nicht-interaktive Mini-Karte aller Objekte), Prioritäts-Leiste, Objekt-Übersicht, DWD-Wetterbild,
Pegel-Liniendiagramm und Waldbrand-Trend (beide mehrfach möglich, je Station ein Widget, gemeinsame
Verlaufs-Grafik aus `js/pegel-chart.js`), FIRMS-Hotspot-Karte (Mini-Karte statt Liste),
Wetter-Vorhersage, Blitz-Zähler, Fahrzeugstatus (Anzahl je Wache), Anstehende Überprüfungen (Liste
statt nur Zahl), BBK/NINA-Feed, Kachelmann-Wetter, Uhr/Datum, Notiz-Pinnwand (geräteübergreifend
geteilter Freitext), Eigene Links, Hochwasserzentralen-Liste, DWD-Unwetter-Ticker, Erdbeben-Liste (EMSC) und eine
Gesamt-Statuszeile (Ein-Zeilen-Ampel über alle Quellen). Die Listen-Widgets (Vorhersage/BBK/
Hochwasser/Unwetter/Erdbeben) speisen sich aus demselben, einmal pro Seitenaufruf geladenen
`GET /api/datapoints` wie die Prioritäts-Leiste — kein zusätzlicher Request je Widget.

**Verlaufs-Widgets (Pegel/Waldbrand):** `datapoint_history` (Migration 013) wurde bewusst nur um
`waldbrandindex` erweitert, nicht um `blitzortung` — Pegelstand und Waldbrandgefahrenindex sind
beides wiederkehrende Messwerte je Station mit stabiler `external_id`, ein Blitzeinschlag dagegen ist
ein Einzelereignis mit neuer `external_id` je Sichtung (kein "Verlauf" im Liniendiagramm-Sinn). Der
Blitz-Zähler zeigt daher bewusst nur die aktuelle Anzahl, keinen Verlauf (siehe Kommentar in
`backend/src/fetchers/normalize.js`, `HISTORY_SOURCES`).

**Freies Raster statt fester Reihenfolge:** Position UND Größe jeder Kachel sind frei wählbar (Ziehen
am Griff-Symbol ⠿, Größenändern an der Kachel-Ecke), umgesetzt mit
[gridstack.js](https://github.com/gridstack/gridstack.js) (MIT, lokal vendored unter
`frontend/public/vendor/gridstack/`, siehe `VERSION.txt` dort für Bezugsweg/Version). Bewusst keine
selbstgebaute Positionier-/Kollisionslogik (anders als beim Kartenskizzen-Editor mit
Leaflet-Geoman weiter unten) — freies Ziehen+Größenändern mit automatischer Kollisionsvermeidung hat
viele Randfälle, die eine gereifte Bibliothek bereits löst, statt sie hier neu zu erfinden.
Unterhalb von 700px Containerbreite schaltet gridstack automatisch auf eine Spalte um
(`columnOpts.breakpoints`), Resize-Griffe werden dort per CSS ausgeblendet, Reihenfolge bleibt per
Drag änderbar; die Mehrspalten-Anordnung bleibt dabei intern gecacht (gridstack-eigener Mechanismus)
und kommt beim Zurückwechseln auf breitere Bildschirme unverändert zurück.

**Persistenz:** Das Layout (Liste aus `{id, type, config, x, y, w, h}`) liegt unter dem Schlüssel
`dashboard_layout` in derselben `user_preference`-Tabelle wie die Spaltenwahl der Themenseiten
(Migration 011, Phase 4) — ein Eintrag mehr in derselben Tabelle statt eines eigenen Mechanismus oder
einer Schema-Migration für den Raster-Umbau. Nach jeder Drag-/Resize-Aktion liest
`syncPositionsAndSave()` die tatsächlichen Positionen direkt aus gridstack aus (`grid.save(false)`)
statt eine eigene Positions-Buchhaltung zu führen. Widgets ohne gespeicherte Position (Altbestand vor
dem Raster-Umbau, oder neu hinzugefügt) werden von gridstack automatisch an die erste freie Stelle
gesetzt und die gefundene Position anschließend sofort mit übernommen. „Zurücksetzen" löscht die
Zeile über denselben Self-Service-Endpunkt (`DELETE /api/user-preferences/dashboard_layout`); die
Seite fällt dann auf die eingebaute Standardauswahl zurück (Karte, Gesamt-Statuszeile,
Prioritäts-Leiste, Objekt-Übersicht, DWD-Wetterbild).

**DWD-Wetterbild-Widget:** bindet den offiziell von DWD dokumentierten WMS-Geodienst
(`maps.dwd.de/geoserver/dwd/ows`, „Ihr Homepagewetter"/"WMS-Dienste für die eigene Website mit den
DWD-Geodiensten") als `<img>` ein — eine Kartenkombination aus Blaue-Marmor-Hintergrund und den
aktuellen amtlichen Warngebieten/-gemeinden, ausgeschnitten auf eine Bounding-Box um den
Wehr-Kartenmittelpunkt. Kein API-Key nötig, `imgSrc`-Direktive der CSP entsprechend um
`https://maps.dwd.de` erweitert (`backend/src/app.js`, dieselbe bewusste, dokumentierte Ergänzung
wie beim OSM-Kartenlayer). **Verifikationshinweis:** Die Layer-Namen (`bluemarble`,
`Warngebiete_Kreise`, `Warnungen_Gemeinden_vereinigt`, ohne `dwd:`-Präfix) sind per
`GetCapabilities`-Abgleich auf dem Produktivserver bestätigt — derselbe `dwd:`-Präfix-Fehler wie
beim Niederschlagsradar-Overlay (siehe „Gewitterzug / Niederschlagsbewegung" unten) betraf
ursprünglich auch dieses Widget. Das Widget fängt einen Ladefehler zusätzlich ab und zeigt statt
eines kaputten Bildes einen Hinweis mit Link zu dwd.de.

**Pegel-Liniendiagramm-Widget:** `live_datapoint` speichert je Station nur den aktuellsten Wert
(`UNIQUE(source, external_id)`) — für einen Zeitreihen-Chart schreibt `upsertDatapoints()`
(`backend/src/fetchers/normalize.js`) zusätzlich in eine neue, schlanke `datapoint_history`-Tabelle
(Migration 013), bewusst nur für Quellen in einer Allowlist (`HISTORY_SOURCES`, aktuell nur
`pegelonline` — ein Unwetterereignis oder FIRMS-Hotspot hat keinen sinnvollen "Verlauf" im
Liniendiagramm-Sinn). `GET /api/datapoints/history?source=pegelonline&externalId=…` liefert die
letzten 14 Tage (deckungsgleich mit `DATA_RETENTION_DAYS` — keine zweite Aufbewahrungsregel), das
Frontend zeichnet daraus ein leichtgewichtiges, handgeschriebenes SVG-Liniendiagramm (keine neue
Chart-Bibliothek nötig). Die Bereinigung alter Historien-Punkte läuft im selben Cleanup-Cron wie bei
`live_datapoint` (`cleanupOldDatapoints()` in `backend/src/scheduler.js`).

Die Zeichenlogik steckt in einer eigenen, geteilten Datei (`frontend/public/js/pegel-chart.js`,
`renderPegelHistoryChart()`) — genutzt sowohl vom Dashboard-Widget als auch vom Detail-Panel jeder
Pegel-Themenseite (`js/detail.js`, `renderDetailPanel()`): ein Klick auf eine Pegel-Messstelle zeigt
den 14-Tage-Verlauf direkt im Detail-Panel, ohne dass dafür erst ein Dashboard-Widget angelegt werden
muss.

**Pegelstand permanent auf der Karte:** Pegel-Marker (PEGELONLINE + Hochwasserzentralen) zeigen den
aktuellen Wert als dauerhaftes Label direkt an der Messstelle (`js/bundesland.js`,
`createDatapointLayer()`, Leaflet-Tooltip mit `permanent: true`) statt nur beim Hovern/Anklicken.
Ein zusätzlicher HW100-Referenzwert (statistisches 100-jährliches Hochwasser) wird bewusst **nicht**
angezeigt: weder PEGELONLINE noch die Hochwasserzentralen-API liefern diesen Wert — letztere liefert
laut eigener Dokumentation überhaupt keine numerischen Messwerte, nur eine Meldestufen-Klassifikation
(0–4). Eine erfundene Zahl anzuzeigen wäre bei einem Katastrophenschutz-Tool falsch und gefährlich;
ein echter HW100-Wert bräuchte eine zusätzliche, länderspezifische Hydrologie-Datenquelle, die aktuell
nicht angebunden ist.

Schema: `datapoint_history` (`backend/sql/migrations/013_add_datapoint_history.sql`).

## Sicherheit & Datenschutz

### Authentifizierung & Sitzungen

- Passwörter: bcrypt (Cost 12), Mindestlänge 8 Zeichen
- Auth: JWT in httpOnly-/Secure-/SameSite=Strict-Cookie (kein `localStorage`-Token), Cookie-Laufzeit
  synchron zu `JWT_EXPIRES_IN`
- **Session-Revocation**: jeder Nutzer trägt eine `token_version` in der DB, die im JWT mitgeführt
  wird. Bei Passwortänderung/-Reset wird sie hochgezählt — alle zuvor ausgestellten Tokens dieses
  Kontos werden dadurch sofort ungültig, statt bis zu `JWT_EXPIRES_IN` (Standard 12h) gültig zu
  bleiben. Rolle und Wehr-Zugehörigkeit werden bei **jedem** Request frisch aus der DB gelesen (nicht
  aus dem ggf. veralteten Token-Payload) — eine Rollenänderung oder -degradierung wirkt dadurch
  sofort, nicht erst nach Ablauf des alten Tokens.
- **Login-Schutz**: IP-basiertes Rate-Limit (10 Versuche/15 Min. über alle Konten) **plus**
  Konto-Lockout (5 Fehlversuche sperren ein einzelnes Konto 15 Minuten, unabhängig von der IP) —
  schützt sowohl vor Angriffen von einer IP als auch vor verteilten Versuchen auf ein Konto.
- **Zwei-Faktor-Authentifizierung (2FA/TOTP)**: optional, nur für `stab`/`admin` anbietbar (Migration
  018), unter „Einstellungen“ selbst einrichtbar — Secret + `otpauth://`-URI zum Eintragen in eine
  Authenticator-App (Google Authenticator, Aegis, FreeOTP, …), Aktivierung erst nach korrektem
  Bestätigungscode. `backend/src/utils/totp.js` implementiert RFC 6238 (TOTP) auf RFC 4226 (HOTP) mit
  Bordmitteln (nur `crypto`) statt einer npm-Bibliothek — derselbe Grundsatz wie beim Web-Push/VAPID
  im Schwesterprojekt FKatInfo; die HOTP-Kernfunktion ist gegen die öffentlichen Testvektoren aus
  RFC 4226 Anhang D verifiziert (alle 10 Vektoren exakt getroffen). Login mit aktivem 2FA läuft
  zweistufig: `POST /api/auth/login` liefert bei korrektem Passwort einen kurzlebigen
  Pending-Token (5 Min.) statt direkt des Auth-Cookies, `POST /api/auth/login-2fa` tauscht Token +
  6-stelligen Code gegen den echten Auth-Cookie — beide Endpunkte teilen sich dasselbe Rate-Limit wie
  der normale Login. Das TOTP-Secret liegt AES-256-GCM-verschlüsselt in der DB (`utils/crypto.js`,
  derselbe Mechanismus wie das SMTP-Passwort) und wird nach der Einrichtung nie wieder im Klartext
  angezeigt. Kein QR-Code-Bild (bewusst: eine Bibliothek nur für eine darstellbare Zeichenkette wäre
  unnötiges Gewicht, jede Authenticator-App akzeptiert auch manuelle Eingabe). Verloren gegangenes
  Gerät/gesperrtes Konto: Admin kann das 2FA eines Nutzers der eigenen Wehr in der Nutzerverwaltung
  zurücksetzen (`POST /api/users/:id/totp/reset`, protokolliert im Audit-Log) — keine Backup-Codes in
  dieser ersten Ausbaustufe.
- **Passwort ändern**: Self-Service unter „Einstellungen“ (erfordert aktuelles Passwort, meldet alle
  *anderen* Sitzungen ab), Admin-Reset in der Nutzerverwaltung (setzt ein neues Passwort direkt,
  meldet alle Sitzungen des Zielkontos ab) sowie **Passwort-vergessen per E-Mail-Link**
  (`forgot-password.html` → `POST /api/auth/forgot-password`, siehe eigener Abschnitt unten) für den
  Fall, dass kein Admin erreichbar ist.
- **Passwort-vergessen-Selbstbedienung**: `POST /api/auth/forgot-password` (E-Mail) antwortet
  **immer identisch**, egal ob die E-Mail als Konto existiert — sonst ließe sich per Rückmeldung
  erraten, welche Adressen registriert sind (User-Enumeration-Oracle). Existiert ein Konto, wird ein
  einmaliger, 1 Stunde gültiger Token erzeugt und **nur als SHA-256-Hash** in `password_reset_token`
  gespeichert (nie im Klartext) und per E-Mail als Link zu `reset-password.html?token=…` verschickt;
  `POST /api/auth/reset-password` prüft Hash + Ablauf + Einmalig-Verwendung, setzt bei Erfolg das
  Passwort (bcrypt) und zählt `token_version` hoch (meldet alle bestehenden Sitzungen ab, dieselbe
  Konsequenz wie beim Admin-Reset). Rate-limitiert wie der Login (`/api/auth/forgot-password` und
  `/reset-password` teilen sich ein Limit von 5 Anfragen/15 Min. je IP).
- **Produktions-Startup-Guard** (`backend/src/config.js`): der Server verweigert den Start, wenn
  `NODE_ENV=production` und `JWT_SECRET` fehlt/zu kurz ist (< 32 Zeichen) oder noch den
  Entwicklungs-Default trägt — verhindert den häufigsten Fehlkonfigurationsfall (vergessenes
  `JWT_SECRET`, mit dem sich sonst beliebige Admin-Sitzungen fälschen ließen). Fehlendes
  `COOKIE_SECURE=true` in Produktion erzeugt eine deutliche Warnung.

### Nachvollziehbarkeit

- **Audit-Log** (`audit_log`-Tabelle, sichtbar im Admin-Bereich): protokolliert sicherheitsrelevante
  Aktionen — Nutzer angelegt/gelöscht, Rolle geändert, Passwort geändert/durch Admin zurückgesetzt,
  Konto-Sperrung, Objekt gelöscht — inkl. handelndem Konto, Ziel, Zeitstempel und IP.

### Datenquellen-Status (Health-Dashboard je Fetcher)

Admin-Bereich, Karte „Datenquellen-Status" — zeigt je Datenquelle (und den beiden internen
Wartungsjobs `dwd_stations_import`/`cleanup`) den letzten Lauf, den letzten Erfolg, den letzten
Fehler (inkl. Fehlertext) sowie Laufzeit und Anzahl geschriebener Zeilen. Bisher war der einzige Weg
zu sehen, ob ein Fetcher zuverlässig läuft, das Server-Log — kein Admin-UI. Eine Zeile je Quelle in
`fetcher_health` (Migration 016), per UPSERT nach jedem Lauf aktualisiert (`backend/src/
fetcherHealth.js`, aufgerufen aus `scheduler.js::runJob()` für die neun Cron-Jobs sowie aus
`fetchers/blitzortung.js` für dessen dauerhafte WebSocket-Verbindung — dort bedeutet „Erfolg" sowohl
ein erfolgreicher Verbindungsaufbau als auch ein erfolgreicher Flush gespeicherter Einschläge, damit
an einem gewitterfreien Tag nicht fälschlich nie ein Erfolg sichtbar wäre, obwohl die Verbindung
durchgehend stand). Manuell testen/befüllen: `npm run fetch -- <jobname>` im `backend/`-Verzeichnis.

### Weitere Maßnahmen

- Rate-Limiting auf allen `/api`-Endpunkten, engeres Limit zusätzlich auf `/api/auth/login`
- Security-Header via `helmet` (inkl. Content-Security-Policy). CSP-Verstöße werden serverseitig
  geloggt (`POST /api/csp-report`, eigenes striktes Rate-Limit) statt nur in der Browser-Konsole
  eines einzelnen Nutzers zu verschwinden - Lehre aus einem realen Vorfall (siehe Changelog: der
  Service Worker blockierte Kartenkacheln per CSP, die Karte blieb grau, bis ein Nutzer die
  Konsolenausgabe manuell weitergab)
- Keine Drittanbieter-Tracking-Skripte; Leaflet lokal vendored; einzige externe Verbindung im
  Frontend sind die OpenStreetMap-Kartenkacheln (nur Bilder)
- Datei-Anhänge (Objektverwaltung) werden außerhalb des Web-Roots gespeichert und ausschließlich
  über einen authentifizierten Endpunkt ausgeliefert
- `npm audit` (Backend): 0 bekannte Schwachstellen zum Stand dieser Version
- `.env` ist gitignored — niemals Secrets committen

### DSGVO

- **Recht auf Löschung**: jeder Nutzer kann sein Konto jederzeit vollständig löschen
  (`DELETE /api/users/me`, kaskadiert auf Push-Subscriptions/Alarmregeln/Alert-Log)
- **Recht auf Auskunft/Datenübertragbarkeit**: „Meine Daten herunterladen“ in den Einstellungen
  (`GET /api/users/me/export`) liefert Profil, eigene Alarmregeln und Push-Subscription-Metadaten
  als JSON
- **Verantwortlichkeit**: Audit-Log (siehe oben) dokumentiert, wer sicherheitsrelevante Änderungen
  vorgenommen hat
- **Personenbezogene Daten Dritter**: Die Objektverwaltung erlaubt das Erfassen von
  Ansprechpartner-Name/-Telefon zu kritischen Objekten (z.B. Schulleitung) — das sind
  personenbezogene Daten *dritter* Personen, keine Nutzerdaten. Der Betreiber (die Wehr) ist hierfür
  datenschutzrechtlich Verantwortlicher und muss dies im eigenen Verarbeitungsverzeichnis
  dokumentieren; die Anwendung stellt keine automatisierte Lösch-/Auskunftsfunktion für diese
  Drittdaten bereit (Löschung erfolgt durch Bearbeiten/Löschen des jeweiligen Objekts).
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

## Wetter-Entwicklung (Windrichtung/-geschwindigkeit, Gewitterzug, Warnungen als Fläche)

Recherche-Ergebnis zur Anforderung „Windrichtung und wie sie sich entwickelt/ändert, ziehende
Gewitter, Warnungen als Fläche statt Punkt wie beim DWD“. Zwei der drei Teile sind inzwischen
umgesetzt (Warnungen als Fläche auf Bundesland-Ebene, Gewitterzug über die DWD-Radar-Kartenschicht
— siehe jeweils unten); Windrichtung/-geschwindigkeit als eigene Datenquelle bleibt **bewusst noch
nicht implementiert**, siehe Begründung dort.

### Warnungen als Fläche statt Punkt (Bundesland-Ebene implementiert, Kreis-Ebene noch offen)

**Bundesland-Ebene ist umgesetzt.** DWD-Unwetterwarnungen liefern den betroffenen Bundesland-Code
(`stateShort`, z.B. `NW`) bereits direkt in der Quelle mit — diese Zuordnung ist offiziell und
musste nicht rekonstruiert werden. Die 16 Bundesland-Flächen werden bei `npm run import-landkreise`
als Nebenprodukt aus den unter „Zuständigkeitsgebiet“ importierten Landkreis-Polygonen aggregiert
(`ST_Union` je Bundesland, Tabelle `bundesland`, Migration 007) und über `GET /api/bundeslaender`
ausgeliefert. Auf Dashboard und `dwd-unwetter.html` erscheinen DWD-Unwetterwarnungen dadurch als
eingefärbte Bundesland-Fläche statt als Punkt (`js/bundesland.js`, `createDatapointLayer()`) —
alle anderen Datenquellen (Pegel, Hochwasser, Waldbrand, FIRMS) bleiben Punkt-Marker, da sie keine
Flächenbezug liefern.

**Kreis-Ebene (präzisere Warnfläche wie direkt beim DWD) ist weiterhin nicht sicher umsetzbar.**
Mit dem Zuständigkeitsgebiet-Feature (siehe oben) liegen zwar echte Kreisgrenzen-Polygone im
System vor — die fehlende Zutat für eine kreisscharfe Warnfläche ist aber die amtliche Zuordnung
DWD-Warncell-ID → Landkreis-AGS. Diese offizielle Zuordnungstabelle (`cap_warncellids_csv`) liegt
auf `dwd.de`, einer aus dieser Entwicklungsumgebung nicht erreichbaren Domain, und es fand sich
keine verlässliche Ersatzquelle. **Eine geratene/falsche Zuordnung würde eine Warnung auf der
falschen Fläche anzeigen — bei einem Katastrophenschutz-Tool ein echtes Sicherheitsrisiko, kein
kosmetisches Problem.** Deshalb bewusst nicht blind umgesetzt; die jetzige Bundesland-Fläche ist
der sichere Zwischenstand, der ohne ungeprüfte Zusatzannahmen auskommt. Sobald die offizielle CSV
von `dwd.de/DE/leistungen/opendata/help/warnungen/cap_warncellids_csv.html` verifiziert werden
kann, ist die Verfeinerung auf Kreis-Ebene ein überschaubarer nächster Schritt (Join-Tabelle +
Wechsel von `bundesland`- auf `landkreis`-Polygone in `createDatapointLayer()`).

### Windrichtung/-geschwindigkeit (Empfehlung: MOSMIX-S, machbar)

DWD Open Data bietet stündliche Stationsvorhersagen (**MOSMIX-S**, ~40 Parameter inkl.
Windrichtung `DD` und -geschwindigkeit `FF` in 10m Höhe) als KMZ (gezipptes KML) je Station:
`https://opendata.dwd.de/weather/local_forecasts/mos/MOSMIX_S/single_stations/<Stations-ID>/kml/MOSMIX_S_LATEST_<Stations-ID>.kmz`.
Geplanter Ansatz (analog zu den bestehenden 5 Connectors):

1. Nächstgelegene MOSMIX-Station zum Wehr-Kartenmittelpunkt bestimmen (`haversineKm`, bereits in
   `backend/src/utils/geo.js` vorhanden).
2. KMZ herunterladen, entpacken (einzelne Datei, keine neue Abhängigkeit nötig — ein minimaler
   Parser für den ZIP-Local-File-Header genügt) und `DD`/`FF`-Zeitreihe aus dem KML extrahieren.
3. **Kein Schema-Update nötig**: ein `live_datapoint`-Eintrag je Station (`source='wind'`),
   `value_numeric`/`unit` = aktuelle Geschwindigkeit, die mehrstündige Entwicklung (Richtung +
   Geschwindigkeit je Stunde) im `payload`-Feld (JSONB) — die Detail-Ansicht kann daraus eine
   Zeitleiste rendern, das bestehende Muster (Addon-Seite + `js/detail.js`) passt unveraendert.

**Grund, warum das noch nicht umgesetzt wurde**: Die MOSMIX-Stations-IDs sind ein **anderer
Stationskatalog** als die bereits in EKats vorhandene `dwd_station`-Tabelle (die stammt aus den
Klima-Tageswerten, nicht aus MOSMIX). Vor der Implementierung muss der korrekte MOSMIX-Stations-
katalog (`https://opendata.dwd.de/weather/lib/met_application_mosmix/stationskatalog.cfg` o.ä.)
geprüft und die Zuordnung nächste-Station-zu-Wehr-Standort gegen echte Daten verifiziert werden —
das war aus dieser Sandbox heraus **nicht möglich** (kein ausgehender Netzwerkzugriff auf
`opendata.dwd.de`, dieselbe Einschränkung wie beim `hochwasserzentralen.js`-Connector, siehe oben).
Ungeprüften Code auszuliefern, der auf einer zusätzlichen, nicht verifizierbaren Annahme (korrekte
Stations-ID-Zuordnung zwischen zwei verschiedenen DWD-Katalogen) aufbaut, wäre nach den gleichen
Maßstäben, an die sich dieses Projekt bereits hält (siehe „Verifikationsstand der Fetcher“ oben),
unehrlich. **Empfehlung**: in einer Session mit echtem Internetzugriff die Stations-ID-Zuordnung
verifizieren, dann den Fetcher nach obigem Muster umsetzen (geschätzter Aufwand: ähnlich zu einem
der 5 bestehenden Connectors, ca. 1 Fetcher-Datei + 1 Addon-Seite + Migration entfällt).

### Gewitterzug / Niederschlagsbewegung (umgesetzt: DWD-WMS-Kartenschicht statt eigenem RADOLAN-Parser)

Die ursprüngliche Überlegung war, DWDs **RADOLAN/RADVOR**-Rohdaten
(`https://opendata.dwd.de/weather/radar/composite/`) selbst zu dekodieren (binäres 900×900-Raster,
eigene Projektion) — das wäre deutlich aufwändiger als jeder bestehende Connector gewesen.
**Einfacherer, umgesetzter Weg**: DWD stellt dieselben Radardaten bereits fertig als Kartenschicht
über den öffentlichen GeoServer bereit (`https://maps.dwd.de/geoserver/dwd/wms`, Layer
`Niederschlagsradar`) — kein eigenes Dekodieren nötig, nur ein Leaflet-`L.tileLayer.wms(...)` als
zuschaltbarer Overlay (`js/bundesland.js`, `createNiederschlagsradarLayer()` +
`addRadarLayerControl()`, auf Dashboard und allen Addon-Kartenseiten über das Leaflet-eigene
Layer-Steuerelement oben rechts erreichbar, Standard AUS). Laut GeoServer-Abstract sogar mit
kurzfristiger Vorhersage-Komponente ("Niederschlagsradar und -vorhersage, Alias für RV-Produkt,
Auflösung 1km, 5-minütig") — die Bewegungsrichtung von Niederschlag/Gewittern ist dadurch direkt
auf der Karte sichtbar, ohne eine eigene Zellverfolgung zu berechnen.

**Verifikationsstand: jetzt live bestätigt.** Zwei vorherige Versuche scheiterten aus zwei
unterschiedlichen Gründen — beide vom Nutzer per `tileerror`-Diagnose auf dem Produktivserver
bestätigt: `dwd:Niederschlagsradar` hatte den richtigen Basisnamen, aber einen überflüssigen
`dwd:`-Präfix (der Endpunkt `.../geoserver/dwd/wms` ist bereits auf den Workspace `dwd`
eingeschränkt — ein zusätzliches `dwd:` im `layers`-Parameter sucht dann fälschlich nach einem
Layer, der wörtlich `dwd:Niederschlagsradar` heißt, den es nicht gibt); `dwd:RX-Produkt` existierte
auf diesem GeoServer schlicht nicht. Der Nutzer hat daraufhin `GetCapabilities` direkt vom
Produktivserver abgerufen (`curl ... | grep -oE '<Name>[^<]*</Name>'`) und den vollständigen
Layer-Katalog sowie den konkreten `<Layer>`-Eintrag für `Niederschlagsradar` geliefert — bestätigt
exakt diesen Namen ohne Präfix, Unterstützung für `EPSG:3857` (Leaflets Standardprojektion) und
eine `time`-Dimension mit Default `"current"` (kein Zusatzparameter nötig, zeigt automatisch den
aktuellsten Stand). Derselbe `dwd:`-Präfix-Fehler betraf auch das ältere DWD-Wetterbild-Widget
(`renderDwdBildWidget()`, Phase 6) — ebenfalls korrigiert. Schlägt der Layer dennoch einmal fehl
(Dienstausfall o.ä.), erscheint dank des `tileerror`-Handlers ein sichtbarer Hinweis direkt auf der
Karte statt einer wortlos leeren Kachelfläche.

**Verlauf-Regler** (Nutzerwunsch: "Regenradar Historie per Slider bewegen"): erscheint automatisch
unten links auf der Karte, sobald der Radar-Layer über die Layer-Auswahl eingeschaltet wird
(`createRadarTimeSliderControl()`, reagiert auf Leaflets `overlayadd`/`overlayremove`-Events).
Deckt die letzten 2 Stunden in 5-Minuten-Schritten ab (`RADAR_TIME_WINDOW_HOURS`/
`RADAR_TIME_STEP_MINUTES`) - passend zur tatsächlich vom Dienst gelieferten Auflösung, per
`GetCapabilities` bestätigt. Ein Abspiel-Button läuft die Schritte automatisch durch (700ms/Schritt,
Endlosschleife) für einen klassischen Radar-Loop. **Bewusst nur rückwärts**: das GetCapabilities-
`time`-Fenster endete beim Abgleich exakt bei "jetzt", nicht in der Zukunft - obwohl der Layer-
Abstract eine Vorhersage-Komponente erwähnt, sind echte Vorhersage-Zeitstempel unbestätigt und
deshalb nicht blind ergänzt (gleiche Vorsicht wie beim Rest des Projekts).

## Bekannte V1-Vereinfachungen

- **PWA-Icon** ist aktuell nur als SVG hinterlegt (`frontend/public/icons/icon.svg`). Für optimale
  iOS-/Android-Homescreen-Darstellung vor Produktivbetrieb noch PNG-Icon-Sets in mehreren Größen
  ergänzen.
- **Eine Wehr pro Installation**: Das Schema (`wehr`-Tabelle) ist mandantenfähig vorbereitet, aber
  Login/Dashboard gehen von genau einer Wehr aus (siehe Abschnitt 6 der `CLAUDE.md` zu Modul 3).
- **NASA FIRMS** nutzt einen einzigen globalen `MAP_KEY` (nicht pro Nutzer) und einen festen Radius
  (`FIRMS_RADIUS_KM`) um den Wehr-Kartenmittelpunkt.
- **Kein 2FA/TOTP**: Für eine höhere Absicherung von Admin-Konten wäre eine
  Zwei-Faktor-Authentifizierung sinnvoll, ist aber noch nicht umgesetzt.
- Siehe außerdem den Abschnitt „Verifikationsstand der Fetcher“ oben.

## Gap-Analyse: Was fehlt für ein vollwertiges Produktivsystem?

Über die bereits umgesetzte Sicherheits-/DSGVO-Härtung hinaus fehlen für ein rundum
produktionsreifes System aus heutiger Sicht folgende Punkte — nach Priorität geordnet, mit
Einschätzung, was sich ohne Netzwerkzugriff/Live-Server aus dieser Umgebung heraus sinnvoll schon
umsetzen ließ vs. was echte Infrastruktur oder Live-Tests braucht:

### Hohe Priorität

- **Automatisierte Tests fehlen komplett.** Die gesamte Verifikation dieses Projekts (auch der
  heutigen Fixes) lief über manuelle curl-/Playwright-Durchläufe in dieser Session - das ist nicht
  wiederholbar und schützt nicht vor Regressionen bei künftigen Änderungen. Mehrere heute gefundene
  Bugs (fehlende Tenant-Prüfung bei Fahrzeug/Aufgaben-IDs, stale Rolle im JWT, CSP blockiert
  Service-Worker-Fetch) wären mit einer Test-Suite vermutlich schon vorher aufgefallen. Empfehlung:
  `vitest` oder `jest` + `supertest` für die Backend-Routen (Start bei Auth/Autorisierung, da dort
  der größte Schaden bei Fehlern entsteht), Playwright-Tests für die kritischen UI-Pfade dauerhaft
  im Repo statt nur als Wegwerf-Skripte in `/tmp`.
- **Kein CI-Pipeline** (z.B. GitHub Actions): Tests/Lint laufen aktuell nirgends automatisch bei
  jedem Push/PR. Ohne (a) wenig sinnvoll umsetzbar, sollte danach folgen.
- **Kein dokumentiertes Datenbank-Backup**: `deploy/` enthält kein Backup-Skript/keine Anleitung.
  Empfehlung: `pg_dump`-Cron-Job + Aufbewahrungsfrist, idealerweise Offsite-Kopie (die Objekt-
  Anhänge in `backend/storage/objects/` brauchen ein separates Datei-Backup).

### Mittlere Priorität

- **Kein Monitoring/Alerting für den Betrieb selbst**: Fehler landen nur in `journalctl`/Konsole.
  Ein fehlschlagender Cron-Job (z.B. alle 5 Datenquellen-Fetcher gleichzeitig kaputt) fällt sonst
  erst auf, wenn jemand die Karte leer sieht - wie im heutigen Vorfall. Empfehlung: einfacher
  externer Uptime-Check gegen `/api/health` plus eine Alarmierung, wenn ein Fetcher mehrfach in
  Folge fehlschlägt (Zähler existiert im Scheduler-Log bereits, wird aber nirgends ausgewertet).
- **Passwort-Richtlinie ist minimal** (nur Mindestlänge 8). Für höhere Sicherheit optional: Prüfung
  gegen bekannte kompromittierte Passwörter (z.B. HaveIBeenPwned-Prefix-API, datensparsam da nur
  ein SHA1-Präfix übertragen wird) oder eine höhere Mindestlänge für Admin-Konten.
- **2FA/TOTP** für Admin-Konten (siehe „Bekannte V1-Vereinfachungen“).
- **Verkehrsdaten**: bereits in früheren Planungsrunden dieses Projekts als eigene Phase
  vorgesehen, aber noch nicht begonnen. (Gebietsdefinition/Zuständigkeitsgebiet ist inzwischen
  umgesetzt, siehe eigener Abschnitt oben.)
- **Mandantenfähigkeit (mehrere Wehren auf einer Installation)**: Schema ist vorbereitet
  (`wehr`-Tabelle), aber bewusst als letzte, größere Ausbaustufe zurückgestellt (siehe frühere
  Planung zu Platform-Admin vs. Wehr-Admin).

### Niedrige Priorität / nice-to-have

- PNG-Icon-Sets für die PWA (aktuell nur SVG, siehe oben)
- Automatisierte Barrierefreiheits-Prüfung (a11y) der Oberfläche
- Wetter-Entwicklung/Gewitterzug (siehe eigener Abschnitt oben) - bewusst noch nicht umgesetzt

### Bereits erledigt (zur Einordnung, was heute dazugekommen ist)

Session-Revocation, Login-Lockout, Audit-Log, Passwort ändern/Admin-Reset, DSGVO-Datenexport,
Produktions-Startup-Guard für `JWT_SECRET`, CSP-Violation-Reporting sowie die Aufteilung der
Datenquellen in eigene Addon-Seiten neben dem kombinierten Dashboard - siehe Abschnitte oben.

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
