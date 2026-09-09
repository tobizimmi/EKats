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
| Kachelmannwetter/Meteologix | Zusätzliche, optionale Wetterwarnungen (kostenpflichtig, siehe unten) | ja, `KACHELMANN_API_KEY` | alle 30 Min. |
| Bright Sky (DWD-Vorhersage) | Echte Wettervorhersage (Temperatur/Niederschlag/Wind), keine Warnung | nein | stündlich |

Intervalle über die `FETCH_*_CRON`-Variablen in `.env` änderbar. Jeder Fetcher läuft isoliert
(`src/scheduler.js`): schlägt eine Quelle fehl, laufen die anderen normal weiter.

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
| `wetter-vorhersage.html` | Wetter-Vorhersage (Bright Sky) |
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

PEGELONLINE liefert keine amtliche Meldestufe (nur eine grobe Einordnung relativ zu langjährigen
Mittelwerten) — für eine echte Meldestufe die Hochwasserzentralen-Quelle nutzen. Jede
Regel/Datapoint/Kanal-Kombination löst wegen `alert_log` nur einmal aus (siehe
`src/notifications/evaluate.js`). **`bbk_warnung` hat noch keine Schwellenwert-Regel** — die Quelle
ist neu (Phase 1 des Einsatzleiter-Portal-Konzepts) und wird bislang nur über die Prioritäts-Leiste
und die Lage-Liste angezeigt, nicht über Push/E-Mail.

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
eigener Layer, als Quadrat dargestellt (unterscheidbar von den runden, nach Dringlichkeit
eingefärbten Lage-Markern).

- **Anlegen** (Rolle Stab/Admin): Button „Objekt anlegen“ klicken, dann auf die gewünschte Position
  in der Karte klicken — öffnet ein Formular für Name, Kategorie, Adresse, besondere Gefahren,
  Zufahrt/Schlüsseldepot, Ansprechpartner und Überprüfungsintervall.
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

### Kartenskizzen direkt am Objekt

Im Objekt-Dialog (Karte) lässt sich zusätzlich zu den Anhängen eine **Kartenskizze** direkt in der
App einzeichnen — mit einem Freihand-Stift und einer festen Symbolpalette (Zugang, Gefahrenbereich,
Sammelplatz, Hydrant, Absperrung), angelehnt an gängige Einsatzplan-Piktogramme. Anders als ein
hochgeladener Lageplan bleibt die Skizze **strukturiert bearbeitbar**: gespeichert wird sie als
GeoJSON (`critical_object_map_sketch`, Migration 012) statt als Bild — Stiftlinien als
`LineString`-Features, Symbole als `Point`-Features mit einer `symbolKey`-Eigenschaft. Eine
schreibgeschützte Vorschau (dieselbe Komponente wie die Mini-Vorschau der Objekt-Detailseite, nur
größer) zeigt die Skizze im Objekt, ein „Skizze bearbeiten"-Button öffnet den interaktiven Editor.

Technisch auf [Leaflet-Geoman](https://github.com/geoman-io/leaflet-geoman) aufgebaut (Freie
Version, MIT-Lizenz, lokal vendored unter `frontend/public/vendor/leaflet-geoman/` — Lizenztext
liegt daneben) statt Geomans eigener Formen-Toolbar nutzt EKats nur `map.pm.enableDraw()`
programmatisch, ausgelöst über die eigene, für Feuerwehrpläne zugeschnittene Symbolleiste. Kein
Netzwerkzugriff nötig für die Zeichenfunktion selbst (nur die Kartenkacheln laden weiterhin von
OpenStreetMap) — funktioniert daher auch bei eingeschränkter Konnektivität zur Karte, solange diese
bereits einmal geladen wurde.

### Export

Im Admin-Bereich („Objektdaten-Export“) lassen sich alle Objekte der eigenen Wehr inkl. aller
Aufgaben und Anhangs-**Metadaten** (Dateiname/Typ/Größe, nicht die Binärdateien selbst) als
JSON-Datei herunterladen (`GET /api/objects/export`, Stab/Admin). Die eigentlichen Anhangsdateien
müssen einzeln über den Datei-Download-Endpunkt geholt werden.

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

**Wichtiger Verifikationshinweis:** Die genaue Endpunkt-URL, das Antwortformat und das
Authentifizierungsschema der Kachelmann-Business-API sind **nicht verifiziert** — Meteologix/
Kachelmannwetter veröffentlicht seine kommerzielle API-Dokumentation nicht öffentlich zugänglich,
und ein Test-Zugang war aus dieser Entwicklungsumgebung nicht erreichbar. Der Connector ist nach
dem gleichen Muster wie `hochwasserzentralen.js` gebaut: die komplette Infrastruktur (Zugriffs-
prüfung, Scheduler-Integration, Datenmodell, Severity-Einordnung, Anzeige) ist real und getestet,
aber der eigentliche HTTP-Request/das Parsing (`fetchJson(...${BASE_URL}/warnings/live...`) beruht
auf einer plausiblen, aber nicht bestätigten Annahme über die API-Form — vor Produktivbetrieb mit
einem echten API-Key gegen `npm run fetch -- kachelmann` prüfen und ggf. anpassen.

Schema: `wehr_feature_role_access`, `user_feature_access`
(`backend/sql/migrations/009_add_feature_access.sql`).

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

## Individuelles Dashboard (Phase 6)

`dashboard.html` ("Mein Dashboard" in der Seitenleiste) ergänzt die feste Karten-Ansicht
(`index.html`, unverändert) um einen Baukasten: jeder Nutzer stellt sich seine eigene Auswahl und
Reihenfolge aus fünf Widget-Typen zusammen — Karte (nicht-interaktive Mini-Karte aller Objekte),
Prioritäts-Leiste, Objekt-Übersicht, DWD-Wetterbild und (mehrfach möglich, je Station ein Widget)
Pegel-Liniendiagramm. Umsortieren per natives HTML5-Drag-and-Drop (Desktop) oder die Auf-/Ab-Buttons
je Widget-Karte als Tastatur-/Touch-Fallback, dieselbe Grundidee wie das bereits produktive
Drag-and-Drop-Dashboard im Schwesterprojekt FKatInfo.

**Persistenz:** Das Layout (Liste aus `{id, type, config}`) liegt unter dem Schlüssel
`dashboard_layout` in derselben `user_preference`-Tabelle wie die Spaltenwahl der Themenseiten
(Migration 011, Phase 4) — ein Eintrag mehr in derselben Tabelle statt eines eigenen Mechanismus.
„Zurücksetzen" löscht die Zeile über denselben Self-Service-Endpunkt
(`DELETE /api/user-preferences/dashboard_layout`); die Seite fällt dann auf die eingebaute
Standardauswahl (Karte, Prioritäts-Leiste, Objekt-Übersicht, DWD-Wetterbild) zurück.

**DWD-Wetterbild-Widget:** bindet den offiziell von DWD dokumentierten WMS-Geodienst
(`maps.dwd.de/geoserver/dwd/ows`, „Ihr Homepagewetter"/"WMS-Dienste für die eigene Website mit den
DWD-Geodiensten") als `<img>` ein — eine Kartenkombination aus Blaue-Marmor-Hintergrund und den
aktuellen amtlichen Warngebieten/-gemeinden, ausgeschnitten auf eine Bounding-Box um den
Wehr-Kartenmittelpunkt. Kein API-Key nötig, `imgSrc`-Direktive der CSP entsprechend um
`https://maps.dwd.de` erweitert (`backend/src/app.js`, dieselbe bewusste, dokumentierte Ergänzung
wie beim OSM-Kartenlayer). **Verifikationshinweis:** `maps.dwd.de` ist wie alle DWD-Hosts in dieser
Sandbox per Netzwerk-Firewall blockiert und die Bild-URL konnte hier nicht gegen die echte Kachel
gerendert geprüft werden — die Wahl stützt sich auf die öffentliche DWD-Dokumentation der
Geodienste (nicht auf `opendata.dwd.de`, das ursprünglich im Konzept vorgesehen war, aber keine
ebenso klar dokumentierte, fürs Einbetten gedachte Bild-URL bietet). Das Widget fängt einen
Ladefehler ab und zeigt statt eines kaputten Bildes einen Hinweis mit Link zu dwd.de — vor
Produktivbetrieb auf dem tatsächlich erreichenden Server prüfen und bei Bedarf die Layer-Auswahl in
`renderDwdBildWidget()` (`js/dashboard.js`) anpassen.

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
- **Passwort ändern**: Self-Service unter „Einstellungen“ (erfordert aktuelles Passwort, meldet alle
  *anderen* Sitzungen ab) sowie Admin-Reset in der Nutzerverwaltung (setzt ein neues Passwort direkt,
  meldet alle Sitzungen des Zielkontos ab) — es gibt (noch) keinen E-Mail-basierten
  Self-Service-Reset (siehe „Bekannte V1-Vereinfachungen“).
- **Produktions-Startup-Guard** (`backend/src/config.js`): der Server verweigert den Start, wenn
  `NODE_ENV=production` und `JWT_SECRET` fehlt/zu kurz ist (< 32 Zeichen) oder noch den
  Entwicklungs-Default trägt — verhindert den häufigsten Fehlkonfigurationsfall (vergessenes
  `JWT_SECRET`, mit dem sich sonst beliebige Admin-Sitzungen fälschen ließen). Fehlendes
  `COOKIE_SECURE=true` in Produktion erzeugt eine deutliche Warnung.

### Nachvollziehbarkeit

- **Audit-Log** (`audit_log`-Tabelle, sichtbar im Admin-Bereich): protokolliert sicherheitsrelevante
  Aktionen — Nutzer angelegt/gelöscht, Rolle geändert, Passwort geändert/durch Admin zurückgesetzt,
  Konto-Sperrung, Objekt gelöscht — inkl. handelndem Konto, Ziel, Zeitstempel und IP.

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

## Geplant: Wetter-Entwicklung (Windrichtung/-geschwindigkeit, Gewitterzug, Warnungen als Fläche)

Recherche-Ergebnis zur Anforderung „Windrichtung und wie sie sich entwickelt/ändert, ziehende
Gewitter, Warnungen als Fläche statt Punkt wie beim DWD“ — **bewusst noch nicht implementiert**,
siehe Begründung unten.

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

### Gewitterzug / Niederschlagsbewegung (Empfehlung: eigene, spätere Phase)

Für „wie zieht ein Gewitter“ liefert DWD **RADOLAN/RADVOR** Radar-Kompositen
(`https://opendata.dwd.de/weather/radar/composite/`, 5-15-Minuten-Takt). Das ist ein
**binäres 900×900-Rasterformat** mit eigener Projektion (polar-stereografisch) — die Auswertung
(Kachel-Dekodierung, Koordinatentransformation, ggf. Zellverfolgung für "zieht nach Nordost")
ist deutlich aufwändiger als jeder bestehende Connector und ohne Möglichkeit zur Live-Verifikation
in dieser Umgebung ein zu hohes Risiko für blind geschriebenen, ungetesteten Code. **Korrektur
einer früheren Annahme**: Die „kostenlosen RADOLAN-Kartendaten“ von DWD
(`dwd.de/DE/leistungen/radolan/radolan_info/home_freie_radolan_kartendaten.html`, ebenfalls nicht
erreichbar aus dieser Umgebung) sind laut Recherche **weiterhin die rohen Binär-Kompositdateien,
keine fertigen Bild-Loops** — es gibt lediglich ein von DWD verlinktes Beispielprogramm namens
`radolan2png` zur Konvertierung, das als Referenz für die Formatauswertung dienen kann. Empfehlung:
als eigene Phase mit echtem DWD-Netzwerkzugriff planen, `radolan2png` als Ausgangspunkt für den
eigenen Parser pruefen.

## Bekannte V1-Vereinfachungen

- **PWA-Icon** ist aktuell nur als SVG hinterlegt (`frontend/public/icons/icon.svg`). Für optimale
  iOS-/Android-Homescreen-Darstellung vor Produktivbetrieb noch PNG-Icon-Sets in mehreren Größen
  ergänzen.
- **Eine Wehr pro Installation**: Das Schema (`wehr`-Tabelle) ist mandantenfähig vorbereitet, aber
  Login/Dashboard gehen von genau einer Wehr aus (siehe Abschnitt 6 der `CLAUDE.md` zu Modul 3).
- **NASA FIRMS** nutzt einen einzigen globalen `MAP_KEY` (nicht pro Nutzer) und einen festen Radius
  (`FIRMS_RADIUS_KM`) um den Wehr-Kartenmittelpunkt.
- **Kein E-Mail-basierter Passwort-Self-Service-Reset**: Passwort ändern erfordert entweder das
  aktuelle Passwort (Self-Service) oder ein Admin-Konto (Reset in der Nutzerverwaltung) - es gibt
  keinen "Passwort vergessen"-Link mit E-Mail-Versand.
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
