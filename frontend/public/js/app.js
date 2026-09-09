const REFRESH_INTERVAL_MS = 60 * 1000;

window.selectDatapoint = function selectDatapoint(dp) {
  renderDetailPanel(dp);
  focusDatapointOnMap(dp);
};

// Generische Tab-Umschaltung ueber data-tab/data-tab-panel (siehe index.html) - beliebig viele Tabs,
// kein Spezialfall mehr fuer genau zwei wie zuvor fest in objects.js verdrahtet.
function initTabs() {
  const buttons = [...document.querySelectorAll('.tab-button[data-tab]')];
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('[data-tab-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.tabPanel !== btn.dataset.tab;
      });
    });
  });
}

async function loadAndRenderDatapoints() {
  try {
    const datapoints = await api.get('/datapoints');
    renderMap(datapoints);
    updatePriorityBar(datapoints); // rendert die Lage-Liste selbst (siehe priority-bar.js)
    renderWeatherOverview(datapoints);
    saveOfflineSnapshot(datapoints);
    updateOfflineBanner();
    return datapoints;
  } catch (err) {
    console.error('[app] Datapoints konnten nicht geladen werden:', err);
    const snapshot = await loadOfflineSnapshot();
    if (snapshot) {
      renderMap(snapshot.data);
      updatePriorityBar(snapshot.data);
    }
    updateOfflineBanner(snapshot?.savedAt);
    return null;
  }
}

(async function bootstrap() {
  const user = await initHeader();
  if (!user) return;

  initMap(user.wehrCenter);
  registerServiceWorker();
  initObjectsUi(user);
  initTabs();

  await loadBundeslandFeatures();
  await loadLandkreisFeatures();
  await loadAndRenderDatapoints();
  const objects = await loadObjects();
  renderPriorityBar(); // Objekte sind jetzt geladen - "Kritisch"-Kachel neu zaehlen (ueberfaellige Objekte)

  // Direktsprung von der Objekt-Detailseite (objekt-detail.html "Bearbeiten") bzw. der
  // Objekt-Uebersicht ("Auf der Karte oeffnen") - oeffnet den Dialog fuer das per ?object=<id>
  // referenzierte Objekt direkt, statt es erst manuell auf der Karte suchen zu muessen.
  const requestedObjectId = Number(new URLSearchParams(window.location.search).get('object'));
  if (requestedObjectId) {
    const requestedObject = objects.find((o) => o.id === requestedObjectId);
    if (requestedObject) window.selectObject(requestedObject);
  }
  api
    .get('/wehr/gebiet-geojson')
    .then(renderGebiet)
    .catch((err) => console.warn('[app] Zustaendigkeitsgebiet konnte nicht geladen werden:', err));
  setInterval(loadAndRenderDatapoints, REFRESH_INTERVAL_MS);
})();
