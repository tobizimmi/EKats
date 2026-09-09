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
let addonTable;

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

  datapoints.forEach((dp) => {
    const layer = createDatapointLayer(dp);
    if (!layer) return;
    layer.bindTooltip(dp.title || SOURCE_LABELS[dp.source] || dp.source);
    layer.on('click', () => window.selectDatapoint(dp));
    layer.addTo(addonMap);
    addonMarkersById.set(dp.id, layer);
  });
}

// Funktioniert generisch fuer Punkt-Marker (circleMarker, hat getLatLng) und Flaechen-Layer
// (L.geoJSON, hat getBounds) - siehe createDatapointLayer() in js/bundesland.js.
function focusAddonDatapointOnMap(dp) {
  const layer = addonMarkersById.get(dp.id);
  if (!layer) return;
  if (typeof layer.getBounds === 'function') {
    addonMap.fitBounds(layer.getBounds());
  } else if (typeof layer.getLatLng === 'function') {
    addonMap.flyTo(layer.getLatLng(), Math.max(addonMap.getZoom(), 12));
  }
  layer.openTooltip();
}

window.selectDatapoint = function selectDatapoint(dp) {
  renderDetailPanel(dp);
  focusAddonDatapointOnMap(dp);
};

async function loadAndRenderAddonDatapoints() {
  const errorEl = document.getElementById('addon-error');
  try {
    const datapoints = await api.get(`/datapoints?source=${ADDON_SOURCE}`);
    errorEl.textContent = '';
    renderAddonMap(datapoints);
    addonTable.setData(datapoints);
    document.getElementById('list-updated').textContent = `Stand: ${new Date().toLocaleTimeString('de-DE')}`;
    return datapoints;
  } catch (err) {
    console.error('[addon] Datenpunkte konnten nicht geladen werden:', err);
    // 403 = Feature-Zugriffssteuerung (aktuell Kachelmann, ab Phase 5 potenziell jede Quelle, siehe
    // backend/src/utils/featureAccess.js) - ohne diese Unterscheidung wirkt die Seite bei fehlender
    // Freigabe nur "kaputt" statt verstaendlich, warum sie leer bleibt.
    errorEl.textContent =
      err.status === 403
        ? 'Kein Zugriff auf diese Datenquelle - bei Bedarf im Admin-Bereich freischalten lassen.'
        : 'Daten konnten nicht geladen werden. Bitte später erneut versuchen.';
    return null;
  }
}

(async function bootstrapAddon() {
  const user = await initHeader();
  if (!user) return;

  initAddonMap(user.wehrCenter);
  registerServiceWorker();

  // Spalten-Sichtbarkeit wird je Quelle unter einem eigenen Schluessel gespeichert
  // (Konzept Teil 2, Baustein D - siehe backend/src/routes/userPreferences.js).
  addonTable = new DataTable({
    containerEl: document.getElementById('addon-table-container'),
    prefKey: `columns:${ADDON_SOURCE}`,
    source: ADDON_SOURCE,
    onRowClick: (dp) => window.selectDatapoint(dp),
  });
  await addonTable.init();

  await loadBundeslandFeatures();
  await loadLandkreisFeatures();
  await loadAndRenderAddonDatapoints();
  setInterval(loadAndRenderAddonDatapoints, ADDON_REFRESH_INTERVAL_MS);
})();
