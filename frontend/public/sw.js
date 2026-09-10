// Service Worker fuer Modul 1: cached die App-Shell fuer den Offline-Hinweis (siehe js/offline.js
// fuer den eigentlichen Datenstand in IndexedDB) und zeigt Web-Push-Benachrichtigungen an. Kein
// voller Offline-Betrieb (das ist Modul 2) - API-Aufrufe gehen immer ans Netz, Kartenkacheln werden
// nicht vorab zwischengespeichert.

// Bewusst RELATIV zum Service-Worker-Skript (kein fuehrender "/"): die Cache API und
// self.registration.scope loesen relative URLs relativ zu self.location auf. So funktioniert
// dieselbe sw.js unveraendert egal ob die App an der Domain-Root oder einem Unterpfad
// (z.B. https://zimmimail.de/EKats/) haengt - siehe README "Deployment".
const CACHE_NAME = 'ekats-shell-v39';
// Offline-Kartenkacheln (js/offline-tiles.js, Admin-Bereich "Gebiet herunterladen"): bewusst ein
// EIGENER, von CACHE_NAME komplett getrennter Cache-Bucket - der Name bleibt konstant über
// App-Updates hinweg (kein "-vNN"-Zaehler wie bei CACHE_NAME), damit ein einmal heruntergeladenes
// Gebiet nicht bei jedem Deploy verloren geht. Muss mit der gleichnamigen Konstante in
// js/offline-tiles.js uebereinstimmen (kein gemeinsames Modul zwischen Seiten-Skript und
// Service-Worker-Scope moeglich).
const TILE_CACHE_NAME = 'ekats-tiles-v1';
const APP_SHELL = [
  './',
  'login.html',
  'forgot-password.html',
  'reset-password.html',
  'settings.html',
  'admin.html',
  'dashboard.html',
  'datenschutz.html',
  'impressum.html',
  'dwd-unwetter.html',
  'pegelonline.html',
  'hochwasserzentralen.html',
  'waldbrandindex.html',
  'firms.html',
  'bbk-warnungen.html',
  'kachelmann.html',
  'wetter-vorhersage.html',
  'blitzortung.html',
  'erdbeben.html',
  'objekte.html',
  'objekt-detail.html',
  'hydranten.html',
  'einsatztagebuch.html',
  'uebergabeprotokoll.html',
  'checklisten.html',
  'css/style.css',
  'js/api.js',
  'js/severity.js',
  'js/header.js',
  'js/offline.js',
  'js/map.js',
  'js/bundesland.js',
  'js/gebiet-info.js',
  'js/list.js',
  'js/detail.js',
  'js/pegel-chart.js',
  'js/data-table.js',
  'js/weather-overview.js',
  'js/objects.js',
  'js/objekte-page.js',
  'js/objekt-detail-page.js',
  'js/object-sketch.js',
  'js/einsatztagebuch.js',
  'js/uebergabeprotokoll.js',
  'js/checklisten.js',
  'js/hydranten-karte.js',
  'js/offline-tiles.js',
  'js/priority-bar.js',
  'js/dashboard.js',
  'js/addon.js',
  'js/wetter-vorhersage.js',
  'js/app.js',
  'js/auth.js',
  'js/forgot-password.js',
  'js/reset-password.js',
  'js/settings.js',
  'js/admin.js',
  'js/push.js',
  'js/sw-register.js',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet-geoman/leaflet-geoman.min.js',
  'vendor/leaflet-geoman/leaflet-geoman.css',
  'vendor/gridstack/gridstack-all.js',
  'vendor/gridstack/gridstack.css',
  'manifest.webmanifest',
  'icons/icon.svg',
];
const SCOPE_PATH = new URL(self.registration ? self.registration.scope : './', self.location).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE_NAME && key !== TILE_CACHE_NAME).map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API-Aufrufe: immer ans Netz, nie aus dem Cache beantworten (Live-Daten).
  if (url.pathname.startsWith(`${SCOPE_PATH}api/`)) {
    return;
  }

  // Kartenkacheln (tile.openstreetmap.org): cache-first NUR aus dem expliziten Offline-Download-
  // Bucket (TILE_CACHE_NAME, siehe js/offline-tiles.js) - liegt eine Kachel dort (weil sie ueber
  // "Gebiet herunterladen" im Admin-Bereich vorab geladen wurde), wird sie direkt bedient, auch
  // offline. Liegt sie NICHT dort, faellt das normale fetch() durch (kein automatisches Nachladen
  // ins Cache) - das ist weiterhin der Live-Zustand von vorher, nur fuer vorab heruntergeladene
  // Gebiete zusaetzlich offline-faehig. connect-src der CSP musste dafuer tile.openstreetmap.org
  // erlauben (siehe app.js) - vorher blockierte das jeden fetch() hierher (frueherer Bug: "Karte
  // bleibt grau"), img-src deckte nur den regulaeren <img>-Ladepfad ab.
  if (url.hostname === 'tile.openstreetmap.org') {
    event.respondWith(
      caches.open(TILE_CACHE_NAME).then((cache) => cache.match(event.request).then((cached) => cached || fetch(event.request)))
    );
    return;
  }

  // Sonstige Fremdorigin-Requests NICHT abfangen - der Browser laedt sie ganz normal selbst.
  if (url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch (err) {
    payload = { title: 'EKats', body: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'EKats-Alarm', {
      body: payload.body || '',
      icon: 'icons/icon.svg',
      badge: 'icons/icon.svg',
      data: payload,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(self.registration.scope));
});
