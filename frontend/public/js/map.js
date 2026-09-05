// Kartenansicht: ein Leaflet-Layer je Quelle, einzeln ein-/ausblendbar (siehe CLAUDE.md 2.2).
// Tile-Quelle: OpenStreetMap-Standardkacheln (keine Drittanbieter-Tracking-Skripte, nur Kachelbilder).

const SEVERITY_COLORS = ['#6b7280', '#2e7d32', '#f9a825', '#ef6c00', '#c62828'];

let map;
let layerGroups = {};
let markersByDatapointId = new Map();

function initMap(center) {
  map = L.map('map', { zoomControl: true }).setView(
    [center?.lat ?? 51.1657, center?.lon ?? 10.4515],
    center ? 12 : 6
  );

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap-Mitwirkende',
  }).addTo(map);

  Object.keys(SOURCE_LABELS).forEach((source) => {
    layerGroups[source] = L.layerGroup().addTo(map);
  });

  buildLayerToggles();
}

function buildLayerToggles() {
  const container = document.getElementById('layer-toggles');
  container.innerHTML = '';
  Object.entries(SOURCE_LABELS).forEach(([source, label]) => {
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

  datapoints
    .filter((dp) => dp.lat !== null && dp.lon !== null)
    .forEach((dp) => {
      const color = SEVERITY_COLORS[Math.min(severityScore(dp), 4)];
      const marker = L.circleMarker([dp.lat, dp.lon], {
        radius: 8,
        color,
        fillColor: color,
        fillOpacity: 0.85,
        weight: 2,
      });
      marker.bindTooltip(dp.title || SOURCE_LABELS[dp.source] || dp.source);
      marker.on('click', () => window.selectDatapoint(dp));
      marker.addTo(layerGroups[dp.source]);
      markersByDatapointId.set(dp.id, marker);
    });
}

function focusDatapointOnMap(dp) {
  if (dp.lat === null || dp.lon === null) return;
  map.flyTo([dp.lat, dp.lon], Math.max(map.getZoom(), 12));
  const marker = markersByDatapointId.get(dp.id);
  if (marker) marker.openTooltip();
}
