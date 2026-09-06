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
          imgSrc: ["'self'", 'data:', 'https://tile.openstreetmap.org'],
          connectSrc: ["'self'"],
          workerSrc: ["'self'"],
          manifestSrc: ["'self'"],
        },
      },
    })
  );
  // Browser-Origin-Header enthaelt nie einen Pfad (nur Schema+Host+Port) - falls BASE_URL einen
  // Unterpfad traegt (z.B. "https://zimmimail.de/EKats", siehe README "Deployment"), muss der Pfad
  // fuer den CORS-Vergleich abgeschnitten werden.
  app.use(cors({ origin: new URL(config.baseUrl).origin, credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: '200kb' }));

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

  app.use('/api/auth', authRoutes);
  app.use('/api/users', usersRoutes);
  app.use('/api/datapoints', datapointsRoutes);
  app.use('/api/alert-rules', alertRulesRoutes);
  app.use('/api/push', pushRoutes);
  app.use('/api/wehr', wehrRoutes);
  app.use('/api/objects', objectsRoutes);

  app.use('/api', notFoundHandler);

  app.use(express.static(path.join(__dirname, '..', '..', 'frontend', 'public')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'frontend', 'public', 'index.html'));
  });

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
