const REFRESH_INTERVAL_MS = 60 * 1000;

function renderDetailPanel(dp) {
  const panel = document.getElementById('detail-panel');
  const content = document.getElementById('detail-content');
  content.innerHTML = '';

  const entries = [
    ['Quelle', SOURCE_LABELS[dp.source] || dp.source],
    ['Titel', dp.title || '-'],
    ['Wert', formatValue(dp)],
    ['Stufe/Status', dp.severity || '-'],
    ['Zeitstempel', formatTimestamp(dp.item_timestamp)],
    ['Zuletzt abgerufen', formatTimestamp(dp.fetched_at)],
  ];
  entries.forEach(([label, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    content.appendChild(dt);
    content.appendChild(dd);
  });

  panel.hidden = false;
}

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

  await loadAndRenderDatapoints();
  setInterval(loadAndRenderDatapoints, REFRESH_INTERVAL_MS);
})();
