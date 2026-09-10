// Kartenskizzen direkt am Objekt (Konzept Teil 2, Baustein B): mit Stift, Flächen-Werkzeugen und
// vordefinierten Symbolen auf einem Kartenausschnitt einzeichnen - gespeichert als GeoJSON
// (Migration 012), nicht als Bild, damit die Skizze spaeter bearbeitbar bleibt. Nutzt
// Leaflet-Geoman (lokal vendored, MIT-Lizenz, siehe vendor/leaflet-geoman/) fuer
// Freihand-Linien/Flaechen/Kreise und platzierbare Marker; die Symbolpalette und die
// Textbeschriftung sind eine eigene, kleine UI statt Geomans generischer Toolbar/Text-Werkzeug -
// so bleibt die Serialisierung (Punkt/Linie/Flaeche + eigene properties) vollstaendig unter eigener
// Kontrolle statt von unklarem internem Geoman-Verhalten abzuhaengen.

const OBJECT_SKETCH_SYMBOLS = [
  { key: 'zugang', emoji: '🚪', label: 'Zugang' },
  { key: 'gefahrenbereich', emoji: '⚠️', label: 'Gefahrenbereich' },
  { key: 'sammelplatz', emoji: '📍', label: 'Sammelplatz' },
  { key: 'hydrant', emoji: '🚰', label: 'Hydrant' },
  { key: 'absperrung', emoji: '🚧', label: 'Absperrung' },
  { key: 'fluchtweg', emoji: '🏃', label: 'Fluchtweg' },
  { key: 'stromabschaltung', emoji: '🔌', label: 'Stromabschaltung' },
  { key: 'gasabsperrung', emoji: '⛽', label: 'Gasabsperrung' },
  { key: 'brandmeldezentrale', emoji: '🚨', label: 'Brandmeldezentrale' },
];
const OBJECT_SKETCH_SYMBOL_BY_KEY = Object.fromEntries(OBJECT_SKETCH_SYMBOLS.map((s) => [s.key, s]));

// Kleine, feuerwehrplan-taugliche Farbauswahl statt eines freien Colorpickers als Pflicht - das
// native <input type="color"> darunter erlaubt trotzdem jede Farbe, diese Palette ist nur die
// Voreinstellung/Schnellauswahl.
const OBJECT_SKETCH_DEFAULT_COLOR = '#b3261e';

function objectSketchSymbolIcon(emoji) {
  return L.divIcon({
    html: `<div class="object-sketch-symbol-icon">${emoji}</div>`,
    className: 'object-sketch-symbol-wrap',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function escapeSketchText(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function objectSketchTextIcon(text) {
  return L.divIcon({
    html: `<div class="object-sketch-text-icon">${escapeSketchText(text)}</div>`,
    className: 'object-sketch-symbol-wrap',
    iconSize: null,
    iconAnchor: [0, 10],
  });
}

// Baut aus einer gespeicherten FeatureCollection Leaflet-Layer auf einer (bereits initialisierten)
// Karte auf - fuer schreibgeschuetzte Vorschauen ebenso genutzt wie zum Vorbefuellen des Editors.
// geometry.type allein reicht nicht mehr zur Unterscheidung, seit Kreise und Textlabels ebenfalls
// als "Point" gespeichert werden (siehe sketchLayersToGeoJson) - properties.shapeType/.text
// entscheiden zusaetzlich.
function renderSketchGeoJsonOnMap(map, geojson) {
  const layers = [];
  (geojson?.features || []).forEach((feature) => {
    const type = feature.geometry?.type;
    const props = feature.properties || {};
    const color = props.color || OBJECT_SKETCH_DEFAULT_COLOR;

    if (type === 'LineString') {
      const latlngs = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
      const layer = L.polyline(latlngs, { color, weight: 3 }).addTo(map);
      layers.push({ layer, kind: 'stroke' });
    } else if (type === 'Polygon') {
      const rings = feature.geometry.coordinates.map((ring) => ring.map(([lon, lat]) => [lat, lon]));
      const layer = L.polygon(rings, { color, weight: 3, fillOpacity: 0.15 }).addTo(map);
      layers.push({ layer, kind: 'area' });
    } else if (type === 'Point' && props.shapeType === 'circle') {
      const [lon, lat] = feature.geometry.coordinates;
      const layer = L.circle([lat, lon], { radius: props.radius || 10, color, weight: 3, fillOpacity: 0.15 }).addTo(map);
      layers.push({ layer, kind: 'circle' });
    } else if (type === 'Point' && props.text) {
      const [lon, lat] = feature.geometry.coordinates;
      const layer = L.marker([lat, lon], { icon: objectSketchTextIcon(props.text) }).addTo(map);
      layers.push({ layer, kind: 'text', text: props.text });
    } else if (type === 'Point') {
      const [lon, lat] = feature.geometry.coordinates;
      const symbolKey = props.symbolKey;
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
  const features = sketchLayers.map(({ layer, kind, symbolKey, text }) => {
    if (kind === 'circle') {
      const center = layer.getLatLng();
      return {
        type: 'Feature',
        properties: { shapeType: 'circle', radius: layer.getRadius(), color: layer.options.color || OBJECT_SKETCH_DEFAULT_COLOR },
        geometry: { type: 'Point', coordinates: [center.lng, center.lat] },
      };
    }
    if (kind === 'text') {
      const latlng = layer.getLatLng();
      return {
        type: 'Feature',
        properties: { text },
        geometry: { type: 'Point', coordinates: [latlng.lng, latlng.lat] },
      };
    }
    const geoJson = layer.toGeoJSON();
    geoJson.properties = kind === 'symbol' ? { symbolKey } : { color: layer.options.color || OBJECT_SKETCH_DEFAULT_COLOR };
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

// Interaktiver Editor: eigene Symbolpalette + Zeichenwerkzeuge statt Geomans Standard-Toolbar (siehe
// Dateikopf). `onSaved`/`onCancel` steuern den Wechsel zurueck in die Vorschau im Objekt-Dialog bzw.
// auf der Objekt-Detailseite.
class ObjectSketchEditor {
  // saveUrl/clearConfirmText erlauben die Wiederverwendung fuer die wehrweite Hydrantenkarte
  // (js/hydranten-karte.js): ohne diese Overrides bleibt das Verhalten fuer die bestehenden
  // objektgebundenen Aufrufstellen unveraendert (saveUrl faellt auf /objects/:id/sketch zurueck).
  constructor({ toolbarEl, mapContainerEl, errorEl, objectId, saveUrl, clearConfirmText, center, initialGeoJson }) {
    this.toolbarEl = toolbarEl;
    this.mapContainerEl = mapContainerEl;
    this.errorEl = errorEl;
    this.objectId = objectId;
    this.saveUrl = saveUrl || `/objects/${objectId}/sketch`;
    this.clearConfirmText = clearConfirmText || 'Wirklich die gesamte Kartenskizze dieses Objekts löschen?';
    this.center = center;
    this.sketchLayers = [];
    this.activeColor = OBJECT_SKETCH_DEFAULT_COLOR;
    this.activeMarkerMode = 'symbol'; // 'symbol' | 'text' - entscheidet, was ein als naechstes gesetzter Marker wird
    this.activeSymbolKey = null;

    this.map = L.map(mapContainerEl).setView([center.lat, center.lon], 17);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap-Mitwirkende',
    }).addTo(this.map);
    // Geoman braucht keine eigene sichtbare Toolbar - wir loesen enableDraw() gezielt ueber die
    // eigene Symbolpalette/Werkzeugleiste aus, damit nur die fuer Feuerwehrplaene relevanten
    // Werkzeuge erscheinen.
    this.map.pm.addControls({ position: 'topleft', drawMarker: false, drawPolyline: false, drawRectangle: false,
      drawPolygon: false, drawCircle: false, drawCircleMarker: false, drawText: false, editMode: true,
      dragMode: false, cutPolygon: false, removalMode: true, rotateMode: false });

    this.map.on('pm:create', (e) => this.handleCreate(e));
    this.map.on('pm:remove', (e) => {
      this.sketchLayers = this.sketchLayers.filter((entry) => entry.layer !== e.layer);
    });

    renderSketchGeoJsonOnMap(this.map, initialGeoJson).forEach((entry) => this.sketchLayers.push(entry));

    this.renderToolbar();
    setTimeout(() => this.map.invalidateSize(), 0);
  }

  // Klassifiziert eine frisch gezeichnete Geoman-Form anhand von e.shape und wendet die aktuell
  // gewaehlte Farbe konsequent NACH der Erstellung per setStyle() an, statt auf Geomans
  // Zeichen-Vorschau-Optionen (templineStyle o.ae. je Formtyp) zu vertrauen - so gibt es nur eine
  // Stelle, die die Endfarbe bestimmt, unabhaengig vom Formtyp.
  handleCreate(e) {
    const layer = e.layer;
    if (e.shape === 'Marker') {
      if (this.activeMarkerMode === 'text') {
        const text = (prompt('Textbeschriftung eingeben:') || '').trim().slice(0, 60);
        if (!text) {
          this.map.removeLayer(layer);
        } else {
          layer.setIcon(objectSketchTextIcon(text));
          this.sketchLayers.push({ layer, kind: 'text', text });
        }
      } else {
        this.sketchLayers.push({ layer, kind: 'symbol', symbolKey: this.activeSymbolKey });
      }
    } else if (e.shape === 'Circle') {
      layer.setStyle({ color: this.activeColor });
      this.sketchLayers.push({ layer, kind: 'circle' });
    } else if (e.shape === 'Rectangle' || e.shape === 'Polygon') {
      layer.setStyle({ color: this.activeColor });
      this.sketchLayers.push({ layer, kind: 'area' });
    } else {
      // Line (Freihand-Stift)
      layer.setStyle({ color: this.activeColor });
      this.sketchLayers.push({ layer, kind: 'stroke' });
    }
    this.map.pm.disableDraw();
  }

  renderToolbar() {
    this.toolbarEl.innerHTML = '';

    const colorLabel = document.createElement('label');
    colorLabel.className = 'object-sketch-color-picker';
    colorLabel.title = 'Zeichenfarbe fuer Stift, Flaechen und Kreis';
    colorLabel.append('Farbe ');
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = this.activeColor;
    colorInput.addEventListener('input', () => {
      this.activeColor = colorInput.value;
    });
    colorLabel.appendChild(colorInput);
    this.toolbarEl.appendChild(colorLabel);

    const penBtn = document.createElement('button');
    penBtn.type = 'button';
    penBtn.className = 'secondary';
    penBtn.textContent = '✏️ Stift (Freihand)';
    penBtn.addEventListener('click', () => {
      this.map.pm.enableDraw('Line', {
        freehand: true,
        templineStyle: { color: this.activeColor },
        hintlineStyle: { color: this.activeColor, dashArray: [5, 5] },
      });
    });
    this.toolbarEl.appendChild(penBtn);

    const rectBtn = document.createElement('button');
    rectBtn.type = 'button';
    rectBtn.className = 'secondary';
    rectBtn.textContent = '⬛ Rechteck';
    rectBtn.addEventListener('click', () => this.map.pm.enableDraw('Rectangle'));
    this.toolbarEl.appendChild(rectBtn);

    const polygonBtn = document.createElement('button');
    polygonBtn.type = 'button';
    polygonBtn.className = 'secondary';
    polygonBtn.textContent = '⬠ Fläche (frei)';
    polygonBtn.addEventListener('click', () => this.map.pm.enableDraw('Polygon'));
    this.toolbarEl.appendChild(polygonBtn);

    const circleBtn = document.createElement('button');
    circleBtn.type = 'button';
    circleBtn.className = 'secondary';
    circleBtn.textContent = '⭕ Kreis';
    circleBtn.addEventListener('click', () => this.map.pm.enableDraw('Circle'));
    this.toolbarEl.appendChild(circleBtn);

    const textBtn = document.createElement('button');
    textBtn.type = 'button';
    textBtn.className = 'secondary';
    textBtn.textContent = '🔤 Text';
    textBtn.addEventListener('click', () => {
      this.activeMarkerMode = 'text';
      this.map.pm.enableDraw('Marker', { markerStyle: { icon: objectSketchTextIcon('Text') } });
    });
    this.toolbarEl.appendChild(textBtn);

    OBJECT_SKETCH_SYMBOLS.forEach((symbol) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'secondary';
      btn.textContent = `${symbol.emoji} ${symbol.label}`;
      btn.addEventListener('click', () => {
        this.activeMarkerMode = 'symbol';
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
      if (!confirm(this.clearConfirmText)) return;
      this.sketchLayers.forEach(({ layer }) => this.map.removeLayer(layer));
      this.sketchLayers = [];
    });
    this.toolbarEl.appendChild(clearBtn);
  }

  async save() {
    this.errorEl.textContent = '';
    try {
      const geojson = sketchLayersToGeoJson(this.sketchLayers);
      await api.put(this.saveUrl, { geojson });
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
