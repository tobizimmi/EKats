const REFRESH_INTERVAL_MS = 60 * 1000;

window.selectDatapoint = function selectDatapoint(dp) {
  renderDetailPanel(dp);
  focusDatapointOnMap(dp);
};

async function loadAndRenderDatapoints() {
  try {
    const datapoints = await api.get('/datapoints');
    renderMap(datapoints);
    renderList(datapoints);
    saveOfflineSnapshot(datapoints);
    updateOfflineBanner();
    return datapoints;
  } catch (err) {
    console.error('[app] Datapoints konnten nicht geladen werden:', err);
    const snapshot = await loadOfflineSnapshot();
    if (snapshot) {
      renderMap(snapshot.data);
      renderList(snapshot.data);
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

  await loadAndRenderDatapoints();
  await loadObjects();
  setInterval(loadAndRenderDatapoints, REFRESH_INTERVAL_MS);
})();
