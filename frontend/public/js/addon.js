// Gemeinsames Skript fuer die Addon-Einzelseiten (eine Datenquelle je Seite, z.B.
// dwd-unwetter.html). Jede Addon-Seite setzt das Attribut `data-addon-source` auf <body>
// (z.B. 'dwd_unwetter', siehe backend/src/routes/datapoints.js VALID_SOURCES) - bewusst kein
// inline <script>, das wuerde an der Content-Security-Policy (script-src 'self') scheitern.
// Anders als js/map.js (Dashboard, alle Quellen + kritische Objekte kombiniert) zeigt diese Seite
// bewusst nur EINE Quelle - kein Layer-Toggle noetig, da es nur einen Layer gibt.

const ADDON_SOURCE = document.body.dataset.addonSource;
const ADDON_REFRESH_INTERVAL_MS = 60 * 1000;

let addonMap;
let addonMarkersById = new Map();

function initAddonMap(center) {
  addonMap = L.map('map', { zoomControl: true }).setView(
    [center?.lat ?? 51.1657, center?.lon ?? 10.4515],
    center ? 11 : 6
  );

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap-Mitwirkende',
  }).addTo(addonMap);
}

function renderAddonMap(datapoints) {
  addonMarkersById.forEach((marker) => addonMap.removeLayer(marker));
  addonMarkersById.clear();

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
      marker.addTo(addonMap);
      addonMarkersById.set(dp.id, marker);
    });
}

function focusAddonDatapointOnMap(dp) {
  if (dp.lat === null || dp.lon === null) return;
  addonMap.flyTo([dp.lat, dp.lon], Math.max(addonMap.getZoom(), 12));
  const marker = addonMarkersById.get(dp.id);
  if (marker) marker.openTooltip();
}

window.selectDatapoint = function selectDatapoint(dp) {
  renderDetailPanel(dp);
  focusAddonDatapointOnMap(dp);
};

async function loadAndRenderAddonDatapoints() {
  try {
    const datapoints = await api.get(`/datapoints?source=${ADDON_SOURCE}`);
    renderAddonMap(datapoints);
    renderList(datapoints);
    return datapoints;
  } catch (err) {
    console.error('[addon] Datenpunkte konnten nicht geladen werden:', err);
    return null;
  }
}

(async function bootstrapAddon() {
  const user = await initHeader();
  if (!user) return;

  initAddonMap(user.wehrCenter);
  registerServiceWorker();

  await loadAndRenderAddonDatapoints();
  setInterval(loadAndRenderAddonDatapoints, ADDON_REFRESH_INTERVAL_MS);
})();
