// Prioritaets-Leiste: verdichtet alle Datenpunkte (alle Quellen) UND ueberfaellige Objekt-
// Ueberpruefungen zu vier Dringlichkeits-Kacheln oberhalb der Karte - siehe Konzeptpapier
// "Einsatzleiter-Portal 2.0", Abschnitt "Dashboard-UX: von der Liste zur Lage". Ein Einsatzleiter
// soll die Gesamtlage in Sekunden erfassen, nicht erst jede Zeile der Lage-Liste durchgehen.
// Klick auf eine Kachel filtert die Lage-Liste (list.js) auf genau diese Stufe (erneuter Klick
// hebt den Filter wieder auf). Nur auf dem Dashboard eingebunden (index.html), da sie sowohl
// live_datapoint-Quellen als auch Objekte kombiniert - auf den Addon-Einzelseiten (nur eine
// Quelle, keine Objekte) waere sie redundant zu den dortigen Dringlichkeits-Badges.

const PRIORITY_BUCKETS = [
  { key: 'critical', label: 'Kritisch', match: (score) => score >= 4 },
  { key: 'high', label: 'Hoch', match: (score) => score === 3 },
  { key: 'medium', label: 'Mittel', match: (score) => score === 1 || score === 2 },
  { key: 'ok', label: 'Unauffällig', match: (score) => score === 0 },
];

let activePriorityBucket = null;
let lastPriorityDatapoints = [];

function overdueObjects() {
  if (typeof allObjectsCache === 'undefined' || typeof isOverdue !== 'function') return [];
  return allObjectsCache.filter((obj) => isOverdue(obj));
}

function bucketForScore(score) {
  return PRIORITY_BUCKETS.find((b) => b.match(score)) || PRIORITY_BUCKETS[PRIORITY_BUCKETS.length - 1];
}

function computePriorityCounts(datapoints) {
  const counts = { critical: 0, high: 0, medium: 0, ok: 0 };
  datapoints.forEach((dp) => {
    counts[bucketForScore(severityScore(dp)).key] += 1;
  });
  // Ueberfaellige Objekt-Ueberpruefungen sind fuer einen Einsatzleiter genauso dringend wie eine
  // kritische Wetterlage - siehe Konzeptpapier "Objekte gehoeren in dieselbe Prioritaetslogik".
  counts.critical += overdueObjects().length;
  return counts;
}

function applyPriorityFilter() {
  if (!activePriorityBucket) {
    renderList(lastPriorityDatapoints);
    return;
  }
  const filtered = lastPriorityDatapoints.filter(
    (dp) => bucketForScore(severityScore(dp)).key === activePriorityBucket
  );
  // Ueberfaellige Objekte stecken nicht in der Lage-Liste (die zeigt nur live_datapoint-Quellen,
  // Objekte haben ihre eigene Liste im Objekte-Tab) - der Kritisch-Filter wirkt hier deshalb nur auf
  // die Datenpunkt-Seite der Kachel, auch wenn die Kachel selbst beide zusammenzaehlt.
  renderList(filtered);
}

function renderPriorityBar() {
  const bar = document.getElementById('priority-bar');
  if (!bar) return;
  const counts = computePriorityCounts(lastPriorityDatapoints);

  bar.innerHTML = '';
  PRIORITY_BUCKETS.forEach((bucket) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `priority-tile priority-${bucket.key}`;
    tile.classList.toggle('active', activePriorityBucket === bucket.key);
    tile.setAttribute('aria-pressed', String(activePriorityBucket === bucket.key));

    const n = document.createElement('span');
    n.className = 'priority-tile-n';
    n.textContent = String(counts[bucket.key]);
    const l = document.createElement('span');
    l.className = 'priority-tile-l';
    l.textContent = bucket.label;

    tile.appendChild(n);
    tile.appendChild(l);
    tile.addEventListener('click', () => {
      activePriorityBucket = activePriorityBucket === bucket.key ? null : bucket.key;
      renderPriorityBar();
      applyPriorityFilter();
    });
    bar.appendChild(tile);
  });
}

// Von app.js nach jedem Datenpunkt-Refresh aufgerufen; auch erneut nach loadObjects(), damit die
// Ueberfaellig-Zahl in der "Kritisch"-Kachel sofort stimmt statt erst beim naechsten 60s-Intervall.
function updatePriorityBar(datapoints) {
  lastPriorityDatapoints = datapoints;
  renderPriorityBar();
  applyPriorityFilter();
}
