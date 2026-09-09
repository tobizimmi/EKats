// Kartenskizzen direkt am Objekt (Konzept Teil 2, Baustein B): mit Stift und vordefinierten
// Symbolen auf einem Kartenausschnitt einzeichnen (Zufahrt, Gefahrenbereich, Sammelplatz, Hydrant,
// Absperrung) - gespeichert als GeoJSON (Migration 012), nicht als Bild, damit die Skizze spaeter
// bearbeitbar bleibt. Nutzt Leaflet-Geoman (lokal vendored, MIT-Lizenz, siehe
// vendor/leaflet-geoman/) fuer Freihand-Linien und platzierbare Marker; die Symbolpalette selbst
// ist eine eigene, kleine UI statt Geomans generischer Formen-Toolbar.

const OBJECT_SKETCH_SYMBOLS = [
  { key: 'zugang', emoji: '🚪', label: 'Zugang' },
  { key: 'gefahrenbereich', emoji: '⚠️', label: 'Gefahrenbereich' },
  { key: 'sammelplatz', emoji: '📍', label: 'Sammelplatz' },
  { key: 'hydrant', emoji: '🚰', label: 'Hydrant' },
  { key: 'absperrung', emoji: '🚧', label: 'Absperrung' },
];
const OBJECT_SKETCH_SYMBOL_BY_KEY = Object.fromEntries(OBJECT_SKETCH_SYMBOLS.map((s) => [s.key, s]));

function objectSketchSymbolIcon(emoji) {
  return L.divIcon({
    html: `<div class="object-sketch-symbol-icon">${emoji}</div>`,
    className: 'object-sketch-symbol-wrap',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

// Baut aus einer gespeicherten FeatureCollection Leaflet-Layer auf einer (bereits initialisierten)
// Karte auf - fuer schreibgeschuetzte Vorschauen ebenso genutzt wie zum Vorbefuellen des Editors.
function renderSketchGeoJsonOnMap(map, geojson) {
  const layers = [];
  (geojson?.features || []).forEach((feature) => {
    if (feature.geometry?.type === 'LineString') {
      const latlngs = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
      const layer = L.polyline(latlngs, {
        color: feature.properties?.color || '#b3261e',
        weight: 3,
      }).addTo(map);
      layers.push({ layer, kind: 'stroke' });
    } else if (feature.geometry?.type === 'Point') {
      const [lon, lat] = feature.geometry.coordinates;
      const symbolKey = feature.properties?.symbolKey;
      const symbol = OBJECT_SKETCH_SYMBOL_BY_KEY[symbolKey];
      const layer = L.marker([lat, lon], {
        icon: symbol ? objectSketchSymbolIcon(symbol.emoji) : undefined,
      }).addTo(map);
      layers.push({ layer, kind: 'symbol', symbolKey });
    }
  });
  return layers;
}

function sketchLayersToGeoJson(sketchLayers) {
  const features = sketchLayers.map(({ layer, kind, symbolKey }) => {
    const geoJson = layer.toGeoJSON();
    geoJson.properties = kind === 'symbol' ? { symbolKey } : { color: layer.options.color || '#b3261e' };
    return geoJson;
  });
  return { type: 'FeatureCollection', features };
}

// Schreibgeschuetzte Vorschau: eigene kleine Leaflet-Instanz ohne Interaktion, identisch zur
// Karten-Mini-Vorschau der Objekt-Detailseite (js/objekte-page.js) - eine Idee, zwei Groessen.
function renderObjectSketchPreview(containerEl, center, geojson) {
  containerEl.innerHTML = '';
  if (!center || center.lat === null || center.lat === undefined) {
    containerEl.textContent = 'Keine Kartenposition vorhanden.';
    return;
  }
  const hasContent = geojson?.features?.length > 0;
  const mapEl = document.createElement('div');
  mapEl.className = 'object-sketch-preview-map';
  containerEl.appendChild(mapEl);

  const map = L.map(mapEl, {
    attributionControl: false,
    zoomControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: false,
    boxZoom: false,
    keyboard: false,
  }).setView([center.lat, center.lon], 16);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  renderSketchGeoJsonOnMap(map, geojson);
  setTimeout(() => map.invalidateSize(), 0);

  if (!hasContent) {
    const hint = document.createElement('p');
    hint.className = 'muted object-sketch-empty-hint';
    hint.textContent = 'Noch keine Kartenskizze vorhanden.';
    containerEl.appendChild(hint);
  }
}

// Interaktiver Editor: eigene Symbolpalette + Stift-Werkzeug statt Geomans Standard-Toolbar (siehe
// Dateikopf). `onSaved`/`onCancel` steuern den Wechsel zurueck in die Vorschau im Objekt-Dialog.
class ObjectSketchEditor {
  constructor({ toolbarEl, mapContainerEl, errorEl, objectId, center, initialGeoJson }) {
    this.toolbarEl = toolbarEl;
    this.mapContainerEl = mapContainerEl;
    this.errorEl = errorEl;
    this.objectId = objectId;
    this.center = center;
    this.sketchLayers = [];

    this.map = L.map(mapContainerEl).setView([center.lat, center.lon], 17);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap-Mitwirkende',
    }).addTo(this.map);
    // Geoman braucht keine eigene sichtbare Toolbar - wir loesen enableDraw() gezielt ueber die
    // eigene Symbolpalette aus, damit nur die fuer Feuerwehrplaene relevanten Werkzeuge erscheinen.
    this.map.pm.addControls({ position: 'topleft', drawMarker: false, drawPolyline: false, drawRectangle: false,
      drawPolygon: false, drawCircle: false, drawCircleMarker: false, drawText: false, editMode: true,
      dragMode: false, cutPolygon: false, removalMode: true, rotateMode: false });

    this.map.on('pm:create', (e) => {
      const kind = e.shape === 'Marker' ? 'symbol' : 'stroke';
      this.sketchLayers.push({ layer: e.layer, kind, symbolKey: kind === 'symbol' ? this.activeSymbolKey : undefined });
      this.map.pm.disableDraw();
    });
    this.map.on('pm:remove', (e) => {
      this.sketchLayers = this.sketchLayers.filter((entry) => entry.layer !== e.layer);
    });

    renderSketchGeoJsonOnMap(this.map, initialGeoJson).forEach((entry) => this.sketchLayers.push(entry));

    this.renderToolbar();
    setTimeout(() => this.map.invalidateSize(), 0);
  }

  renderToolbar() {
    this.toolbarEl.innerHTML = '';

    const penBtn = document.createElement('button');
    penBtn.type = 'button';
    penBtn.className = 'secondary';
    penBtn.textContent = '✏️ Stift (Freihand)';
    penBtn.addEventListener('click', () => {
      this.activeSymbolKey = null;
      this.map.pm.enableDraw('Line', { freehand: true, templineStyle: { color: '#b3261e' }, hintlineStyle: { color: '#b3261e', dashArray: [5, 5] } });
    });
    this.toolbarEl.appendChild(penBtn);

    OBJECT_SKETCH_SYMBOLS.forEach((symbol) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'secondary';
      btn.textContent = `${symbol.emoji} ${symbol.label}`;
      btn.addEventListener('click', () => {
        this.activeSymbolKey = symbol.key;
        this.map.pm.enableDraw('Marker', { markerStyle: { icon: objectSketchSymbolIcon(symbol.emoji) } });
      });
      this.toolbarEl.appendChild(btn);
    });

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'secondary';
    clearBtn.textContent = 'Alles löschen';
    clearBtn.addEventListener('click', () => {
      if (!confirm('Wirklich die gesamte Kartenskizze dieses Objekts löschen?')) return;
      this.sketchLayers.forEach(({ layer }) => this.map.removeLayer(layer));
      this.sketchLayers = [];
    });
    this.toolbarEl.appendChild(clearBtn);
  }

  async save() {
    this.errorEl.textContent = '';
    try {
      const geojson = sketchLayersToGeoJson(this.sketchLayers);
      await api.put(`/objects/${this.objectId}/sketch`, { geojson });
      return true;
    } catch (err) {
      this.errorEl.textContent = err.message;
      return false;
    }
  }

  destroy() {
    this.map.remove();
  }
}
