# Projekt-Briefing: Lage-/Frühwarn-Dashboard für Feuerwehr-Führungsebenen

Dieses Dokument ist als Einstiegspunkt für Claude Code gedacht. Lies es komplett, bevor du mit dem Bauen beginnst. Wenn Rückfragen offen sind, frag den Nutzer, statt Annahmen zu treffen, die den DSGVO- oder Sicherheits-Rahmen betreffen.

## 1. Projektvision

Ein Web-Tool (PWA) für Feuerwehr-Führungsebenen (Wehrführung, Führungsstab, Führungshaus/ELW) sowie perspektivisch Einsatzfahrzeuge, das:

1. **Live-Lagedaten bündelt** (Wetterwarnungen, Pegelstände, Hochwasserlage, Waldbrand-Hotspots) auf einer Karte des eigenen Zuständigkeitsgebiets, mit Schwellenwert-basierten Benachrichtigungen
2. **Perspektivisch** (nicht Teil des ersten Baus) eigene, DSGVO-konform verwaltete Objektpläne/Einsatzvorplanung ergänzt, offline-fähig für den Fahrzeugeinsatz
3. **Perspektivisch** Schnittstellen zu bestehender Feuerwehr-Software (DIVERA 24/7 API ist offen dokumentiert unter api.divera247.com) anbietet, um als Ergänzung statt Konkurrenzprodukt zu bestehenden Lösungen wie iKAT zu funktionieren

**Wichtig:** Dies ist explizit kein Konkurrenzprodukt zu iKAT (die auf Offline-Zuverlässigkeit im Fahrzeug spezialisiert sind), sondern eine Ergänzung mit Fokus auf Live-Daten für die Führungsebene. Der Nutzer ist selbst aktives Mitglied einer Freiwilligen Feuerwehr und testet das Tool zuerst in der eigenen Wehr.

## 2. Baue jetzt: Version 1 (Modul 1 — Lage-/Frühwarn-Dashboard)

**Nicht bauen in dieser Phase:** Objektpläne (Modul 2), Schnittstellen zu DIVERA/iKAT (Modul 3), SMS-Alarmierung, Mandantenfähigkeit für mehrere Wehren. Diese sind bewusst verschoben — siehe Abschnitt 6 für den Kontext, warum das Datenmodell trotzdem darauf vorbereitet sein sollte.

### 2.1 Zielgruppe V1
Wehrführung, Führungsstab, Führungshaus — primär Web-Nutzung am Desktop/Tablet im Stabsraum, nicht zwingend im Einsatzfahrzeug (das kommt mit Modul 2).

### 2.2 Kernfunktionen
- **Kartenansicht** (Leaflet oder MapLibre) mit eigenem Zuständigkeitsgebiet, frei verschieb-/zoombar
- **Overlay-Ebenen**, einzeln ein-/ausblendbar:
  - DWD-Wetterwarnungen (Gemeindeebene)
  - Pegelstände (PEGELONLINE)
  - Hochwasserwarnungen (Hochwasserzentralen-API)
  - Waldbrand-Hotspots (NASA FIRMS)
  - Waldbrandgefahrenindex (DWD)
- **Lage-Übersichtsliste** neben der Karte, sortiert nach Dringlichkeit
- **Detail-Panel** bei Klick auf einen Marker (aktueller Wert, 24h-Verlauf, Quelle, Zeitstempel)
- **Benachrichtigungen**: Schwellenwert-basiert pro Nutzer/Wehr konfigurierbar (Pegel-Meldestufe, DWD-Warnstufe, Hotspot-Radius, Waldbrandgefahrenstufe). Kanäle: Web Push (PWA) + E-Mail. Kein SMS in V1.
- **Rollen**: "Wehrführung/Stab" (voller Zugriff, kann Schwellenwerte konfigurieren) vs. "Mitglied" (nur Lesezugriff)
- **Offline-Fallback für Modul 1**: Service Worker cached App-Shell + letzten Datenstand (IndexedDB), zeigt bei Verbindungsverlust deutlich sichtbaren Hinweis mit Zeitstempel. Kein voller Offline-Betrieb nötig für Modul 1 (siehe Unterschied zu Modul 2 in Abschnitt 6).

### 2.3 Datenquellen (alle offen/kostenlos zugänglich)

| Quelle | Zweck | Zugang | Hinweis |
|---|---|---|---|
| DWD Wetterwarnungen | Gemeindewarnungen | offen, kein Key nötig, siehe opendata.dwd.de und GitHub bundesAPI/dwd-api als Referenz | Alle 30 Min. aktualisiert |
| PEGELONLINE (WSV) | Pegelstände | offene REST-API, pegelonline.wsv.de/webservice, kein Key | Quelle muss bei Nutzung genannt werden (Pflicht laut Anbieter) |
| Hochwasserzentralen-API (LHP) | Hochwasserlage länderübergreifend | hochwasserzentralen.de/webservices, offen | Betrieben von bayerischem/baden-württembergischem Landesamt |
| NASA FIRMS | Satelliten-Hotspots Waldbrand | benötigt kostenlosen MAP_KEY (Registrierung bei NASA FIRMS) | Rate-Limit beachten |
| DWD Waldbrandgefahrenindex | Flächige Gefahreneinschätzung | offen über DWD Geoportal | Aktuell täglich, wird künftig stündlich |

Baue für jede Quelle einen eigenständigen Fetcher-Modul, das die Rohdaten normalisiert in ein gemeinsames internes Format überführt (Geokoordinate, Wert, Status/Stufe, Zeitstempel, Quelle). So bleibt das Datenmodell erweiterbar, wenn später weitere Quellen (z.B. DWD-Kooperation) dazukommen.

## 3. Tech-Stack (Entscheidung, bitte einhalten)

- **Backend:** Node.js, Express
- **Datenbank:** PostgreSQL + PostGIS-Erweiterung (Geodaten von Anfang an sauber modellieren, nicht als lose Lat/Lng-Spalten)
- **Scheduler:** node-cron für periodischen Datenabruf
- **Frontend:** PWA, Vanilla JS oder ein leichtes Framework (Entscheidung liegt bei dir/Claude Code, aber kein schweres Framework nötig für diesen Scope), Leaflet oder MapLibre für die Karte
- **Auth:** JWT-basiert, bcrypt für Passwort-Hashing
- **Push-Benachrichtigungen:** web-push (VAPID), E-Mail-Fallback über nodemailer
- **Hosting-Zielumgebung:** EU/Deutschland (z.B. Hetzner) — im Code keine Annahmen treffen, die das verhindern (z.B. keine fest verdrahteten US-Dienste ohne Alternative)

Es existiert bereits ein Start im Verzeichnis `backend/` mit einer `package.json` — bitte darauf aufbauen, nicht neu anfangen, außer es gibt einen triftigen Grund.

## 4. Sicherheits- und DSGVO-Anforderungen (nicht verhandelbar)

- **Kein Klartext-Passwort-Storage** — bcrypt oder besser
- **HTTPS/TLS** zwingend im Zielbetrieb (im Dev-Setup dokumentieren, wie das für Produktion nachzurüsten ist)
- **Rate-Limiting** auf allen öffentlichen Endpunkten (express-rate-limit ist bereits in package.json vorgesehen)
- **Security-Header** via helmet
- **Keine Drittanbieter-Tracking-Skripte** im Frontend
- **Datensparsamkeit:** V1 speichert primär Live-Wetterdaten (nicht personenbezogen) und Nutzerkonten (Name/E-Mail/Passwort-Hash der Feuerwehrmitglieder — das IST personenbezogen, entsprechend behandeln: Löschfunktion für Accounts vorsehen, keine unnötigen Zusatzfelder)
- **Datenschutzerklärung/Impressum**: Platzhalter-Seiten im Frontend vorsehen, Nutzer muss sie selbst juristisch prüfen/ausfüllen lassen — das übernimmst du nicht inhaltlich, nur technisch als vorbereitete Route/Seite
- **.env für alle Secrets**, niemals Secrets ins Repo committen — `.env.example` mit Platzhaltern pflegen, `.env` in `.gitignore`

## 5. GitHub-Repo-Setup

Bitte zu Beginn:
1. Lokales Git-Repo initialisieren (`git init`), falls noch nicht vorhanden
2. Sinnvolle `.gitignore` (node_modules, .env, Build-Artefakte)
3. Erstes Commit mit dem bestehenden Grundgerüst
4. Falls der Nutzer ein GitHub-Repo verbunden/erstellt hat: remote hinzufügen und pushen. Falls nicht: den Nutzer fragen, ob er ein leeres Repo auf GitHub anlegen soll, bevor gepusht wird — nicht automatisch annehmen, dass ein Repo existiert.

## 6. Kontext für spätere Module (jetzt nur im Hinterkopf behalten, nicht bauen)

- **Modul 2 (Objektpläne):** wird offline-first für Fahrzeugnutzung, mit vollständigem lokalem Datenabgleich (nicht nur Cache wie Modul 1), inkl. Windrichtungs-Überlagerung auf Objektplänen bei Alarmierung zu einem hinterlegten Objekt. Sync-Konfliktbehandlung erstmal simpel: Last-write-wins mit Zeitstempel.
- **Modul 3 (Schnittstellen):** Anbindung an DIVERA 24/7 (offene REST-API vorhanden), ggf. GroupAlarm, iKAT, FeuerSoftware/EinsatzTablet — erst wenn externe Wehren als Nutzer feststehen.

Wenn das Datenmodell in V1 Entscheidungen trifft, die eine spätere Erweiterung um Modul 2/3 unnötig erschweren würden, weise den Nutzer aktiv darauf hin, statt es stillschweigend zu bauen.

## 7. Erfolgskriterium

V1 ist fertig, wenn es lokal lauffähig ist, die fünf Datenquellen echte aktuelle Daten liefern, Benachrichtigungen bei Testschwellenwerten auslösen, und der Nutzer es in der eigenen Freiwilligen Feuerwehr ausprobieren kann. Perfektion ist nicht das Ziel — ein ehrlich funktionierender, sicherer Grundstand ist das Ziel.
