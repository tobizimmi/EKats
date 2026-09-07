// Detail-Panel fuer einen einzelnen Datenpunkt - gemeinsam genutzt vom Dashboard (js/app.js) und
// den Addon-Einzelseiten (js/addon.js), damit die Darstellung ueberall identisch bleibt.

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
