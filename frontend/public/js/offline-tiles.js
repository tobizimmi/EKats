// Offline-Kartenkacheln (Produkt-Review "Später"-Paket): explizites "Gebiet vorab herunterladen"
// für den Feld-Einsatz mit schlechter Verbindung, OHNE den bestehenden Live-Ansatz zu verändern.
// sw.js cacht Kartenkacheln bewusst NICHT automatisch (siehe dortiger Kommentar) - das bleibt so.
// Stattdessen gibt es hier eine eigene, klar vom App-Shell-Cache getrennte Kachel-Cache-Bucket
// (TILE_CACHE_NAME), die NUR durch diese explizite Aktion befüllt wird. sw.js bedient
// tile.openstreetmap.org-Anfragen zusätzlich aus genau diesem Cache, falls die Kachel dort schon
// liegt (cache-first NUR für diesen Host, kein automatisches Nachladen ins Cache) - sonst wie bisher
// normal vom Netz. Denselben Cache-Namen dort duplizieren, statt ein Modul zu teilen: sw.js läuft in
// einem eigenen Worker-Scope ohne Zugriff auf normale Skript-Dateien der Seite.
const TILE_CACHE_NAME = 'ekats-tiles-v1';

function latLonToTile(lat, lon, zoom) {
  const n = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

// Grobe Grad-Naeherung eines Umkreises - identisches Prinzip wie backend/src/utils/geo.js
// bboxForRadius(), hier eigenstaendig im Frontend nachgebildet (kein gemeinsames Modul zwischen
// Server und Browser im Projekt).
function bboxForRadius(lat, lon, radiusKm) {
  const latDelta = radiusKm / 111.32;
  const lonDelta = radiusKm / (111.32 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return { latMin: lat - latDelta, latMax: lat + latDelta, lonMin: lon - lonDelta, lonMax: lon + lonDelta };
}

function computeTileList(lat, lon, radiusKm, minZoom, maxZoom) {
  const bbox = bboxForRadius(lat, lon, radiusKm);
  const tiles = [];
  for (let zoom = minZoom; zoom <= maxZoom; zoom += 1) {
    // Nordwest-/Suedost-Ecke der Bounding-Box in Kachel-Koordinaten - dazwischen liegt der komplette
    // abzudeckende Bereich (Y waechst mit sinkendem Breitengrad, daher NW = latMax/lonMin).
    const nw = latLonToTile(bbox.latMax, bbox.lonMin, zoom);
    const se = latLonToTile(bbox.latMin, bbox.lonMax, zoom);
    for (let x = nw.x; x <= se.x; x += 1) {
      for (let y = nw.y; y <= se.y; y += 1) {
        tiles.push(`https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`);
      }
    }
  }
  return tiles;
}

// onProgress(done, total) wird nach jeder Kachel aufgerufen (erfolgreich oder fehlgeschlagen -
// ein einzelner 404/Timeout blockiert nicht den Rest des Gebiets). Bereits gecachte Kacheln werden
// uebersprungen (kein erneuter Download), macht einen zweiten Lauf ueber ein teils schon
// heruntergeladenes Gebiet guenstig.
async function downloadOfflineTiles({ lat, lon, radiusKm, minZoom, maxZoom, onProgress }) {
  const urls = computeTileList(lat, lon, radiusKm, minZoom, maxZoom);
  const cache = await caches.open(TILE_CACHE_NAME);
  let done = 0;
  let failed = 0;

  for (const url of urls) {
    const request = new Request(url);
    const existing = await cache.match(request);
    if (!existing) {
      try {
        const response = await fetch(request);
        if (response.ok) {
          await cache.put(request, response);
        } else {
          failed += 1;
        }
      } catch (err) {
        failed += 1;
      }
      // Kleine Pause zwischen echten Downloads (nicht bei bereits gecachten Treffern) - Anfragen
      // laufen ohnehin schon sequenziell statt parallel, diese zusaetzliche Bremse ist ein bewusstes
      // Zugestaendnis an die OSM-Tile-Nutzungsrichtlinie (kein Bulk-Ansturm auf den oeffentlichen
      // Dienst), nicht technisch fuer die Cache-Befuellung selbst noetig.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    done += 1;
    if (onProgress) onProgress(done, urls.length, failed);
  }

  return { total: urls.length, failed };
}

async function clearOfflineTiles() {
  await caches.delete(TILE_CACHE_NAME);
}

async function offlineTileCacheSize() {
  const cache = await caches.open(TILE_CACHE_NAME);
  const keys = await cache.keys();
  return keys.length;
}
