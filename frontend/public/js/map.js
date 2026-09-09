// Kartenansicht: ein Leaflet-Layer je Quelle, einzeln ein-/ausblendbar (siehe CLAUDE.md 2.2).
// Tile-Quelle: OpenStreetMap-Standardkacheln (keine Drittanbieter-Tracking-Skripte, nur Kachelbilder).

const OBJECT_LAYER_KEY = 'objects';
const GEBIET_LAYER_KEY = 'gebiet';

// wetter_vorhersage liefert dutzende stuendliche Werte je Wehr (Zeitreihe an einem Punkt, kein
// raeumliches Ereignis wie die uebrigen Quellen) und wird vom Backend bereits aus der kombinierten
// Ansicht ausgeschlossen (siehe datapoints.js) - ohne diese Ausnahme bliebe hier nur ein staendig
// leerer, verwirrender Layer-Toggle uebrig. Eigene Themenseite: wetter-vorhersage.html.
const MAP_EXCLUDED_SOURCES = ['wetter_vorhersage'];

let map;
let layerGroups = {};
let markersByDatapointId = new Map();
let markersByObjectId = new Map();
let placementCallback = null;

function initMap(center) {
  map = L.map('map', { zoomControl: true }).setView(
    [center?.lat ?? 51.1657, center?.lon ?? 10.4515],
    center ? 12 : 6
  );

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap-Mitwirkende',
  }).addTo(map);

  Object.keys(SOURCE_LABELS)
    .filter((source) => !MAP_EXCLUDED_SOURCES.includes(source))
    .forEach((source) => {
      layerGroups[source] = L.layerGroup().addTo(map);
    });
  layerGroups[OBJECT_LAYER_KEY] = L.layerGroup().addTo(map);
  layerGroups[GEBIET_LAYER_KEY] = L.layerGroup().addTo(map);
  addRadarLayerControl(map);

  map.on('click', (event) => {
    if (!placementCallback) return;
    const cb = placementCallback;
    disarmObjectPlacement();
    cb(event.latlng);
  });

  buildLayerToggles();
}

// Aktiviert den "naechster Kartenklick platziert ein neues Objekt"-Modus (siehe objects.js).
function armObjectPlacement(callback) {
  placementCallback = callback;
  map.getContainer().classList.add('placing-object');
}

function disarmObjectPlacement() {
  placementCallback = null;
  map.getContainer().classList.remove('placing-object');
}

function buildLayerToggles() {
  const container = document.getElementById('layer-toggles');
  container.innerHTML = '';
  const allLayers = {
    ...SOURCE_LABELS,
    [OBJECT_LAYER_KEY]: 'Kritische Objekte',
    [GEBIET_LAYER_KEY]: 'Zuständigkeitsgebiet',
  };
  MAP_EXCLUDED_SOURCES.forEach((source) => delete allLayers[source]);
  Object.entries(allLayers).forEach(([source, label]) => {
    const id = `layer-toggle-${source}`;
    const wrapper = document.createElement('label');
    wrapper.setAttribute('for', id);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = id;
    checkbox.checked = true;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        map.addLayer(layerGroups[source]);
      } else {
        map.removeLayer(layerGroups[source]);
      }
    });

    wrapper.appendChild(checkbox);
    wrapper.appendChild(document.createTextNode(label));
    container.appendChild(wrapper);
  });
}

function renderMap(datapoints) {
  Object.values(layerGroups).forEach((group) => group.clearLayers());
  markersByDatapointId.clear();

  datapoints.forEach((dp) => {
    const layer = createDatapointLayer(dp);
    if (!layer) return;
    // Pegel-Marker haben bereits ein permanentes Wert-Label (js/bundesland.js) - bindTooltip() ersetzt
    // ein bestehendes Tooltip komplett statt es zu ergaenzen, ein zweiter Aufruf hier wuerde das
    // Wert-Label also wieder durch den (nicht-permanenten) Titel-Tooltip ueberschreiben.
    if (!layer.getTooltip()) {
      layer.bindTooltip(dp.title || SOURCE_LABELS[dp.source] || dp.source);
    }
    layer.on('click', () => window.selectDatapoint(dp));
    layer.addTo(layerGroups[dp.source]);
    markersByDatapointId.set(dp.id, layer);
  });
}

// Funktioniert generisch fuer Punkt-Marker (circleMarker, hat getLatLng) und Flaechen-Layer
// (L.geoJSON, hat getBounds) - siehe createDatapointLayer() in js/bundesland.js.
function focusDatapointOnMap(dp) {
  const layer = markersByDatapointId.get(dp.id);
  if (!layer) return;
  if (typeof layer.getBounds === 'function') {
    map.fitBounds(layer.getBounds());
  } else if (typeof layer.getLatLng === 'function') {
    map.flyTo(layer.getLatLng(), Math.max(map.getZoom(), 12));
  }
  layer.openTooltip();
}

// Kritische Objekte werden bewusst als Quadrat (statt Kreis) dargestellt, damit sie sich auf den
// ersten Blick von den nach Dringlichkeit eingefaerbten Lage-Markern unterscheiden.
const objectIcon = L.divIcon({
  className: 'object-marker',
  html: '<div class="object-marker-inner"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

// Zeigt den Heimat-Landkreis (kraeftig) und die angrenzenden Landkreise (dezent) als Umriss-Layer,
// damit die Wehr ihr Zustaendigkeitsgebiet auf einen Blick sieht (siehe admin.html "Wehr-
// Einstellungen" fuer die Auswahl). Rein informativ, keine Klick-Interaktion noetig.
function renderGebiet(geojson) {
  layerGroups[GEBIET_LAYER_KEY].clearLayers();
  if (!geojson || !geojson.features || geojson.features.length === 0) return;

  L.geoJSON(geojson, {
    style: (feature) =>
      feature.properties.isHome
        ? { color: '#6d28d9', weight: 3, fillOpacity: 0.08, fillColor: '#6d28d9' }
        : { color: '#6d28d9', weight: 1.5, dashArray: '4 4', fillOpacity: 0 },
    onEachFeature: (feature, layer) => layer.bindTooltip(feature.properties.name),
  }).addTo(layerGroups[GEBIET_LAYER_KEY]);
}

function renderObjects(objects) {
  layerGroups[OBJECT_LAYER_KEY].clearLayers();
  markersByObjectId.clear();

  objects
    .filter((obj) => obj.lat !== null && obj.lon !== null)
    .forEach((obj) => {
      const marker = L.marker([obj.lat, obj.lon], { icon: objectIcon });
      marker.bindTooltip(obj.name);
      marker.on('click', () => window.selectObject(obj));
      marker.addTo(layerGroups[OBJECT_LAYER_KEY]);
      markersByObjectId.set(obj.id, marker);
    });
}
