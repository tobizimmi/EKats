// Wetter- & Lageuebersicht (Dashboard-Tab "Wetter"): fasst die Datenpunkte, die die API bereits auf
// das Zustaendigkeitsgebiet der Wehr (Heimat-Landkreis + Nachbarlandkreise, siehe
// backend/src/utils/zustaendigkeit.js) gefiltert hat, je Quelle kompakt zusammen - Anzahl je
// Dringlichkeitsstufe als Badges, plus die wichtigsten Einzelmeldungen. Ergaenzt die chronologische
// Lage-Liste (list.js) um eine nach Quelle gruppierte, auf einen Blick erfassbare Sicht. Nur auf dem
// Dashboard eingebunden (index.html) - die Addon-Einzelseiten zeigen ohnehin nur eine Quelle.

let gebietInfoCache = null;

async function loadGebietInfo() {
  if (gebietInfoCache) return gebietInfoCache;
  try {
    gebietInfoCache = await api.get('/wehr');
  } catch (err) {
    console.warn('[weather-overview] Zustaendigkeitsgebiet-Info konnte nicht geladen werden:', err);
    gebietInfoCache = null;
  }
  return gebietInfoCache;
}

function renderGebietInfoLine(wehrInfo) {
  const el = document.getElementById('wetter-gebiet-info');
  if (!el) return;

  if (!wehrInfo || !wehrInfo.home_landkreis_ags) {
    el.innerHTML =
      'Kein Zuständigkeitsgebiet konfiguriert – zeigt Meldungen bundesweit ungefiltert. ' +
      '<a href="admin.html">Jetzt einrichten</a>';
    return;
  }

  const neighborNames = (wehrInfo.neighborLandkreise || []).map((l) => l.name);
  el.textContent = neighborNames.length
    ? `Mein Gebiet: ${wehrInfo.home_landkreis_name} (Heimat) + Nachbarn: ${neighborNames.join(', ')}`
    : `Mein Gebiet: ${wehrInfo.home_landkreis_name} (Heimat, keine Nachbarlandkreise ermittelt)`;
}

const WEATHER_SOURCE_ORDER = ['dwd_unwetter', 'waldbrandindex', 'hochwasserzentralen', 'pegelonline', 'firms'];

function groupBySource(datapoints) {
  const groups = new Map();
  datapoints.forEach((dp) => {
    if (!groups.has(dp.source)) groups.set(dp.source, []);
    groups.get(dp.source).push(dp);
  });
  return groups;
}

const LEVEL_LABELS = { 1: 'gering', 2: 'mittel', 3: 'hoch', 4: 'extrem' };

function renderSeverityBadges(items) {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  items.forEach((dp) => {
    const score = Math.min(severityScore(dp), 4);
    if (score >= 1) counts[score] += 1;
  });

  const wrap = document.createElement('div');
  wrap.className = 'weather-badge-row';
  const levelsPresent = [4, 3, 2, 1].filter((level) => counts[level] > 0);

  if (levelsPresent.length === 0) {
    const span = document.createElement('span');
    span.className = 'muted';
    span.textContent = 'unauffällig';
    wrap.appendChild(span);
    return wrap;
  }

  levelsPresent.forEach((level) => {
    const badge = document.createElement('span');
    badge.className = `badge severity-${level}`;
    badge.textContent = `${counts[level]}× ${LEVEL_LABELS[level]}`;
    wrap.appendChild(badge);
  });
  return wrap;
}

function renderWeatherItemList(items) {
  const sorted = [...items].sort((a, b) => severityScore(b) - severityScore(a)).slice(0, 5);
  const ul = document.createElement('ul');
  ul.className = 'plain-list weather-item-list';

  sorted.forEach((dp) => {
    const li = document.createElement('li');
    const main = document.createElement('div');
    main.className = 'item-main';
    main.textContent = dp.title || SOURCE_LABELS[dp.source] || dp.source;
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = `${formatValue(dp)} · ${formatTimestamp(dp.item_timestamp || dp.fetched_at)}`;
    li.appendChild(main);
    li.appendChild(meta);
    li.addEventListener('click', () => window.selectDatapoint(dp));
    ul.appendChild(li);
  });

  return ul;
}

function renderSourceSection(sourceKey, items) {
  const section = document.createElement('div');
  section.className = 'weather-section';

  const heading = document.createElement('h3');
  heading.className = 'weather-section-title';
  heading.textContent = SOURCE_LABELS[sourceKey] || sourceKey;
  section.appendChild(heading);

  if (items.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Keine aktuellen Meldungen im Gebiet.';
    section.appendChild(p);
    return section;
  }

  section.appendChild(renderSeverityBadges(items));
  section.appendChild(renderWeatherItemList(items));
  return section;
}

async function renderWeatherOverview(datapoints) {
  const container = document.getElementById('wetter-overview');
  if (!container) return;

  renderGebietInfoLine(await loadGebietInfo());

  container.innerHTML = '';
  const groups = groupBySource(datapoints);
  WEATHER_SOURCE_ORDER.forEach((sourceKey) => {
    container.appendChild(renderSourceSection(sourceKey, groups.get(sourceKey) || []));
  });
}
