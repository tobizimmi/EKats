const path = require('path');
require('dotenv').config();

function required(name, fallback = undefined) {
  const value = process.env[name] ?? fallback;
  return value;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  // Standardmaessig NUR localhost: der Node-Prozess soll in Produktion nie direkt oeffentlich
  // erreichbar sein, sondern ausschliesslich ueber einen TLS-terminierenden Reverse-Proxy
  // (Apache/nginx) davor - siehe deploy/apache-ekats.conf.example.
  host: process.env.HOST || '127.0.0.1',
  port: parseInt(process.env.PORT || '3000', 10),
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,

  databaseUrl: required('DATABASE_URL', 'postgres://ekats:ekats@localhost:5432/ekats'),

  jwtSecret: required('JWT_SECRET', 'dev-insecure-secret-change-me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  // Pfad-Scope des Auth-Cookies. Bei Deployment unter einem Unterpfad (z.B. "/EKats/", siehe
  // README "Deployment") auf genau diesen Pfad einschraenken, damit das Cookie nicht bei jedem
  // Request an andere Anwendungen auf derselben Domain mitgeschickt wird.
  cookiePath: process.env.COOKIE_PATH || '/',

  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@example.org',

  nasaFirmsMapKey: process.env.NASA_FIRMS_MAP_KEY || '',
  firmsRadiusKm: parseFloat(process.env.FIRMS_RADIUS_KM || '50'),
  // Radius um den Wehr-Kartenmittelpunkt, in dem hochwasserzentralen.de-Pegel abgefragt werden -
  // groesserer Default als FIRMS_RADIUS_KM, da das Pegelnetz dichter ist und Hochwasser an einem
  // Oberlauf auch ausserhalb des engeren Umkreises relevant sein kann.
  hochwasserzentralenRadiusKm: parseFloat(process.env.HOCHWASSERZENTRALEN_RADIUS_KM || '60'),

  // Kachelmannwetter/Meteologix (optional, kostenpflichtig - siehe fetchers/kachelmann.js fuer den
  // Verifikationsstand). V1-Vereinfachung wie bei NASA_FIRMS_MAP_KEY: EIN globaler Key, nicht pro
  // Wehr - WER den Datenpunkt sehen darf, steuert separat die Feature-Zugriffssteuerung
  // (Migration 009), nicht der Key selbst.
  kachelmannApiKey: process.env.KACHELMANN_API_KEY || '',
  kachelmannRadiusKm: parseFloat(process.env.KACHELMANN_RADIUS_KM || '50'),

  // Blitzortung.org (kostenloses Community-Blitzortungsnetz, siehe fetchers/blitzortung.js) - anders
  // als die uebrigen Quellen ein dauerhaft offener WebSocket statt eines periodischen HTTP-Abrufs,
  // daher per eigenem Schalter deaktivierbar (z.B. falls ausgehende WebSocket-Verbindungen auf dem
  // Produktivserver per Firewall blockiert sind).
  blitzortungEnabled: process.env.BLITZORTUNG_ENABLED !== 'false',
  blitzortungRadiusKm: parseFloat(process.env.BLITZORTUNG_RADIUS_KM || '75'),

  // Erdbeben (EMSC/SeismicPortal, siehe fetchers/erdbeben.js) - groesserer Radius als bei den
  // uebrigen Quellen, da staerkere Erdbeben auch deutlich ausserhalb des unmittelbaren Gebiets
  // gespuert werden koennen. minmag=2.0 filtert die haeufigen Mikrobeben (Bergbau/Kavernen) auf ein
  // fuer den Lagedienst noch relevantes Mass; lookbackDays begrenzt gleichzeitig die Abfrage UND
  // (ueber expireStaleItems) wie lange ein Ereignis als "aktuell" gilt.
  erdbebenRadiusKm: parseFloat(process.env.ERDBEBEN_RADIUS_KM || '300'),
  erdbebenMinMagnitude: parseFloat(process.env.ERDBEBEN_MIN_MAGNITUDE || '2.0'),
  erdbebenLookbackDays: parseInt(process.env.ERDBEBEN_LOOKBACK_DAYS || '30', 10),

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'EKats <no-reply@example.org>',
  },

  seed: {
    wehrName: process.env.SEED_WEHR_NAME || 'Freiwillige Feuerwehr Musterstadt',
    wehrLat: process.env.SEED_WEHR_LAT ? parseFloat(process.env.SEED_WEHR_LAT) : null,
    wehrLon: process.env.SEED_WEHR_LON ? parseFloat(process.env.SEED_WEHR_LON) : null,
    adminEmail: process.env.SEED_ADMIN_EMAIL || 'stab@example.org',
    adminPassword: process.env.SEED_ADMIN_PASSWORD || '',
  },

  cron: {
    dwdUnwetter: process.env.FETCH_DWD_UNWETTER_CRON || '*/20 * * * *',
    pegelonline: process.env.FETCH_PEGELONLINE_CRON || '*/15 * * * *',
    hochwasserzentralen: process.env.FETCH_HOCHWASSERZENTRALEN_CRON || '*/20 * * * *',
    firms: process.env.FETCH_FIRMS_CRON || '*/45 * * * *',
    waldbrandindex: process.env.FETCH_WALDBRANDINDEX_CRON || '0 6 * * *',
    dwdStationsImport: process.env.FETCH_DWD_STATIONS_IMPORT_CRON || '0 4 * * 1',
    bbkWarnungen: process.env.FETCH_BBK_WARNUNGEN_CRON || '*/15 * * * *',
    kachelmann: process.env.FETCH_KACHELMANN_CRON || '*/30 * * * *',
    erdbeben: process.env.FETCH_ERDBEBEN_CRON || '*/30 * * * *',
    // Stuendlich reicht fuer eine Vorhersage (MOSMIX aktualisiert selbst nur ein paar Mal taeglich) -
    // haeltsich damit bewusst zurueck gegenueber dem kostenlosen oeffentlichen Bright-Sky-Dienst.
    wetterVorhersage: process.env.FETCH_WETTER_VORHERSAGE_CRON || '0 * * * *',
    cleanup: process.env.CLEANUP_CRON || '30 3 * * *',
  },

  dataRetentionDays: parseInt(process.env.DATA_RETENTION_DAYS || '14', 10),

  userAgent: 'EKats/1.0 (+https://github.com/tobizimmi/ekats)',

  // Datei-Anhaenge (Lageplaene/Grundrisse) zu kritischen Objekten. Bewusst AUSSERHALB von
  // frontend/public, damit Dateien nicht als statische Assets direkt erreichbar sind - Auslieferung
  // ausschliesslich ueber den authentifizierten Download-Endpunkt in routes/objects.js.
  uploadDir: process.env.UPLOAD_DIR || path.join(__dirname, '..', 'storage', 'objects'),
  maxUploadMb: parseInt(process.env.MAX_UPLOAD_MB || '15', 10),
  allowedUploadMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'],
};

const INSECURE_JWT_SECRET_DEFAULT = 'dev-insecure-secret-change-me';

// Verhindert den haeufigsten Produktiv-Fehlkonfigurationsfall: JWT_SECRET in .env vergessen zu
// setzen. Ohne diesen Guard wuerde der Server klaglos mit dem oeffentlich bekannten Default-Secret
// starten - damit koennte jeder gueltige Admin-JWTs faelschen. In Produktion daher harter Abbruch
// statt stiller Fallback; in Entwicklung nur eine Warnung (Default bleibt praktisch fuer lokales
// Arbeiten ohne .env).
function assertSafeToStart() {
  const insecureSecret = config.jwtSecret === INSECURE_JWT_SECRET_DEFAULT || config.jwtSecret.length < 32;
  if (config.env === 'production') {
    if (insecureSecret) {
      throw new Error(
        'JWT_SECRET ist nicht gesetzt oder zu kurz (< 32 Zeichen). In Produktion wird der Start ' +
          'verweigert, da sonst jeder gueltige Admin-Sitzungen faelschen koennte. ' +
          'Erzeugen mit: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"'
      );
    }
    if (!config.cookieSecure) {
      console.warn(
        '[config] WARNUNG: COOKIE_SECURE ist nicht auf "true" gesetzt, obwohl NODE_ENV=production ' +
          'ist. Das Auth-Cookie wird dann auch ueber unverschluesseltes HTTP uebertragen. Nur ' +
          'ignorieren, wenn TLS zwingend ausserhalb dieses Prozesses erzwungen wird.'
      );
    }
  } else if (insecureSecret) {
    console.warn(
      '[config] JWT_SECRET nutzt den unsicheren Entwicklungs-Default - fuer Produktivbetrieb in ' +
        '.env unbedingt einen langen zufaelligen Wert setzen (siehe .env.example).'
    );
  }
}

module.exports = config;
module.exports.assertSafeToStart = assertSafeToStart;
