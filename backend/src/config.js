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

module.exports = config;
