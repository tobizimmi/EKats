// Lage-Uebersichtsliste, sortiert nach Dringlichkeit (siehe severity.js).

function renderList(datapoints) {
  const list = document.getElementById('situation-list');
  list.innerHTML = '';

  const sorted = [...datapoints].sort((a, b) => severityScore(b) - severityScore(a));

  if (sorted.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Keine aktuellen Meldungen.';
    list.appendChild(li);
    return;
  }

  sorted.forEach((dp) => {
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
    list.appendChild(li);
  });

  document.getElementById('list-updated').textContent = `Stand: ${new Date().toLocaleTimeString('de-DE')}`;
}
