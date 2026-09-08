// Lage-Uebersichtsliste: gruppiert nach Landkreis (Heimat zuerst, dann Nachbarn, dann
// bundeslandweite Sammelgruppen fuer Quellen ohne Kreis-Zuordnung - siehe gebiet-info.js), innerhalb
// jeder Gruppe sortiert nach Dringlichkeit (siehe severity.js). Gemeinsam genutzt vom
// Dashboard-Lage-Tab und allen Addon-Einzelseiten (js/addon.js).

function renderDatapointItem(dp) {
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'situation-item-row';

  const dot = document.createElement('span');
  dot.className = `severity-dot severity-${Math.min(severityScore(dp), 4)}`;
  row.appendChild(dot);

  const textWrap = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'situation-item-title';
  title.textContent = dp.title || SOURCE_LABELS[dp.source] || dp.source;

  const meta = document.createElement('div');
  meta.className = 'situation-item-meta';
  meta.textContent = `${SOURCE_LABELS[dp.source] || dp.source} · ${formatValue(dp)} · ${formatTimestamp(
    dp.item_timestamp || dp.fetched_at
  )}`;

  textWrap.appendChild(title);
  textWrap.appendChild(meta);
  row.appendChild(textWrap);
  li.appendChild(row);

  li.addEventListener('click', () => window.selectDatapoint(dp));
  return li;
}

async function renderList(datapoints) {
  const list = document.getElementById('situation-list');
  list.innerHTML = '';

  if (datapoints.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Keine aktuellen Meldungen.';
    list.appendChild(li);
    document.getElementById('list-updated').textContent = `Stand: ${new Date().toLocaleTimeString('de-DE')}`;
    return;
  }

  const gebietInfo = await loadGebietInfo();
  const groups = groupDatapointsByLandkreis(datapoints, gebietInfo);

  groups.forEach((group) => {
    const heading = document.createElement('li');
    heading.className = 'situation-group-heading';
    heading.textContent = group.label;
    list.appendChild(heading);

    const sorted = [...group.items].sort((a, b) => severityScore(b) - severityScore(a));
    sorted.forEach((dp) => list.appendChild(renderDatapointItem(dp)));
  });

  document.getElementById('list-updated').textContent = `Stand: ${new Date().toLocaleTimeString('de-DE')}`;
}
