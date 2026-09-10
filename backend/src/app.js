const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const datapointsRoutes = require('./routes/datapoints');
const alertRulesRoutes = require('./routes/alertRules');
const pushRoutes = require('./routes/push');
const wehrRoutes = require('./routes/wehr');
const objectsRoutes = require('./routes/objects');
const vehiclesRoutes = require('./routes/vehicles');
const stationsRoutes = require('./routes/stations');
const auditLogRoutes = require('./routes/auditLog');
const landkreiseRoutes = require('./routes/landkreise');
const bundeslaenderRoutes = require('./routes/bundeslaender');
const objectFieldsRoutes = require('./routes/objectFields');
const featureAccessRoutes = require('./routes/featureAccess');
const pdfTemplatesRoutes = require('./routes/pdfTemplates');
const userPreferencesRoutes = require('./routes/userPreferences');
const smtpSettingsRoutes = require('./routes/smtpSettings');
const fetcherHealthRoutes = require('./routes/fetcherHealth');
const einsatztagebuchRoutes = require('./routes/einsatztagebuch');
const einsatzRoutes = require('./routes/einsatz');
const uebergabeprotokollRoutes = require('./routes/uebergabeprotokoll');
const checklistsRoutes = require('./routes/checklists');
const hydrantenKarteRoutes = require('./routes/hydrantenKarte');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Security-Header. Leaflet selbst ist lokal vendored (kein Skript-CDN, keine Tracking-Skripte,
  // siehe CLAUDE.md Abschnitt 4) - einzige erlaubte Drittanbieter-Verbindung sind die
  // OpenStreetMap-Kartenkacheln (nur Bilder, kein Script/Tracking).
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          // maps.dwd.de: DWD-Wetterbild-Widget (Konzept Teil 2, Baustein D) - der offiziell von DWD
          // dokumentierte WMS-Geodienst zum Einbetten von Kartenbildern auf fremden Webseiten
          // ("Ihr Homepagewetter", siehe README "DWD-Wetterbild-Widget"). Wie beim OSM-Kartenlayer
          // nur ein Bild-Host, kein Skript/Tracking.
          imgSrc: ["'self'", 'data:', 'https://tile.openstreetmap.org', 'https://maps.dwd.de'],
          // nominatim.openstreetmap.org: Adress-zu-Koordinaten-Geocoding beim Objekt-Anlegen (Button
          // "Koordinaten aus Adresse ermitteln", siehe js/objects.js) - reiner Lookup-Request direkt
          // vom Browser, kein Tracking/Skript. Gleiche Nominatim-Instanz, gleiches Nutzungsmuster wie
          // beim urspruenglichen Feuerwehr-Objektverwaltungstool, das diese Funktion inspiriert hat.
          // tile.openstreetmap.org: war bisher nur unter imgSrc erlaubt (normaler <img>-Kartenkachel-
          // Ladepfad) - fuer Offline-Kartenkacheln (js/offline-tiles.js, Admin-Bereich "Gebiet
          // herunterladen") braucht sowohl die Seite selbst (fetch() beim Vorab-Download) als auch der
          // Service Worker (cache-first-Bedienung bereits heruntergeladener Kacheln, siehe sw.js)
          // programmatischen fetch()-Zugriff auf denselben, bereits vertrauten Host - kein neuer
          // Drittanbieter, nur ein zusaetzlicher Zugriffsweg auf dieselben Bild-URLs.
          connectSrc: ["'self'", 'https://nominatim.openstreetmap.org', 'https://tile.openstreetmap.org'],
          workerSrc: ["'self'"],
          manifestSrc: ["'self'"],
          // blob: fuer die PDF-Vorlagen-Live-Vorschau im Admin-Bereich (Konzept Teil 3): das Blob
          // wird client-seitig aus der eigenen (same-origin) Fetch-Antwort erzeugt, kein
          // Drittanbieter-Inhalt - trotzdem ohne diese Direktive von default-src blockiert.
          frameSrc: ["'self'", 'blob:'],
          // Verstoesse werden serverseitig geloggt (siehe /api/csp-report unten) statt nur in der
          // Browser-Konsole eines einzelnen Nutzers zu verschwinden - genau ein solcher, nur durch
          // manuelles Einfuegen der Konsolenausgabe entdeckter Verstoss (Service Worker blockierte
          // Kartenkacheln) war die Ursache fuer die "Karte bleibt grau"-Stoerung.
          reportUri: '/api/csp-report',
        },
      },
    })
  );
  // Browser-Origin-Header enthaelt nie einen Pfad (nur Schema+Host+Port) - falls BASE_URL einen
  // Unterpfad traegt (z.B. "https://zimmimail.de/EKats", siehe README "Deployment"), muss der Pfad
  // fuer den CORS-Vergleich abgeschnitten werden.
  app.use(cors({ origin: new URL(config.baseUrl).origin, credentials: true }));
  app.use(cookieParser());
  // 2mb statt 200kb: der Objekt-Import (routes/objects.js, POST /import) laedt den kompletten
  // JSON-Export (GET /export) wieder ein - bei vielen Objekten mit vollen Freitextfeldern
  // (Gefahren/Hinweise/Zusatzfelder je bis 2000 Zeichen) reicht das alte 200kb-Limit nicht.
  app.use(express.json({ limit: '2mb' }));

  // Globales Rate-Limit auf allen /api-Endpunkten (Login hat zusaetzlich sein eigenes, engeres Limit).
  app.use(
    '/api',
    rateLimit({
      windowMs: 60 * 1000,
      limit: 120,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );

  app.get('/api/health', (req, res) => res.json({ ok: true, data: { status: 'up' } }));

  // CSP-Verstoss-Reports: unauthentifiziert (der Browser sendet sie automatisch, es gibt keine
  // Session in diesem Moment) und oeffentlich erreichbar - daher eigenes, strenges Rate-Limit und
  // strikt begrenzte Body-Groesse, damit dieser Endpunkt nicht fuer Log-Flooding missbraucht werden
  // kann. Nur geloggt, nicht dauerhaft gespeichert (kein Nutzerbezug, reine Betriebsdiagnose).
  app.post(
    '/api/csp-report',
    rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: false, legacyHeaders: false }),
    express.json({ type: ['application/json', 'application/csp-report'], limit: '20kb' }),
    (req, res) => {
      const report = req.body?.['csp-report'] || req.body;
      console.warn('[csp-violation]', JSON.stringify(report).slice(0, 2000));
      res.status(204).end();
    }
  );

  app.use('/api/auth', authRoutes);
  app.use('/api/users', usersRoutes);
  app.use('/api/datapoints', datapointsRoutes);
  app.use('/api/alert-rules', alertRulesRoutes);
  app.use('/api/push', pushRoutes);
  app.use('/api/wehr', wehrRoutes);
  app.use('/api/objects', objectsRoutes);
  app.use('/api/vehicles', vehiclesRoutes);
  app.use('/api/stations', stationsRoutes);
  app.use('/api/audit-log', auditLogRoutes);
  app.use('/api/landkreise', landkreiseRoutes);
  app.use('/api/bundeslaender', bundeslaenderRoutes);
  app.use('/api/object-fields', objectFieldsRoutes);
  app.use('/api/feature-access', featureAccessRoutes);
  app.use('/api/pdf-templates', pdfTemplatesRoutes);
  app.use('/api/user-preferences', userPreferencesRoutes);
  app.use('/api/smtp-settings', smtpSettingsRoutes);
  app.use('/api/fetcher-health', fetcherHealthRoutes);
  app.use('/api/einsatztagebuch', einsatztagebuchRoutes);
  app.use('/api/einsaetze', einsatzRoutes);
  app.use('/api/uebergabeprotokoll', uebergabeprotokollRoutes);
  app.use('/api/checklists', checklistsRoutes);
  app.use('/api/hydranten-karte', hydrantenKarteRoutes);

  app.use('/api', notFoundHandler);

  app.use(express.static(path.join(__dirname, '..', '..', 'frontend', 'public')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'frontend', 'public', 'index.html'));
  });

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
