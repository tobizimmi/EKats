// Eigene Ansicht fuer die Wetter-Vorhersage (Bright Sky) statt der generischen Addon-Tabelle+Karte
// (js/addon.js): die Quelle liefert stuendliche Zeitreihen-Werte an EINEM Punkt (Wehr-Kartenmittel-
// punkt), kein raeumliches Einzelereignis wie die uebrigen Quellen - eine Tabelle mit ~40 Zeilen mit
// identischer Koordinate und eine Karte mit ~40 uebereinandergestapelten Markern an derselben Stelle
// waren weder als Liste noch als Karte brauchbar (Nutzer-Rueckmeldung: "die Karte bringt mir bei
// Wetter-Vorhersage nichts"). Stattdessen: nach Tag gruppierte Vorhersage-Karten mit Icon, Temperatur,
// Niederschlag und Windrichtung/-geschwindigkeit je Stunde, plus EIN Standort-Marker auf der Karte
// statt vieler gestapelter.

// Bright Sky nutzt dieselbe Icon-Taxonomie wie Dark Sky/Open-Meteo-aehnliche APIs (siehe
// backend/src/fetchers/brightsky.js, Feld payload.condition/payload.icon - VERIFIKATIONSSTAND dort:
// Feldnamen aus der oeffentlich dokumentierten Bright-Sky-Konvention abgeleitet, nicht live gegen die
// echte API geprueft). Emoji statt Icon-Bibliothek - passt zum Projekt-Stil (keine neue Abhaengigkeit
// fuer das Pegel-Diagramm gab es aus demselben Grund nicht) und funktioniert ohne zusaetzliche Assets.
const WEATHER_ICONS = {
  'clear-day': '☀️',
  'clear-night': '🌙',
  'partly-cloudy-day': '⛅',
  'partly-cloudy-night': '🌥️',
  cloudy: '☁️',
  fog: '🌫️',
  wind: '💨',
  rain: '🌧️',
  sleet: '🌨️',
  snow: '❄️',
  hail: '🌨️',
  thunderstorm: '⛈️',
};

function weatherIcon(condition) {
  return WEATHER_ICONS[condition] || '❔';
}

const CARDINAL_DIRECTIONS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];

function degToCardinal(deg) {
  if (deg === null || deg === undefined) return null;
  return CARDINAL_DIRECTIONS[Math.round(deg / 45) % 8];
}

function groupByDay(datapoints) {
  const groups = new Map();
  datapoints.forEach((dp) => {
    const key = new Date(dp.item_timestamp).toISOString().slice(0, 10);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(dp);
  });
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function formatDayHeading(dayKey) {
  const date = new Date(`${dayKey}T12:00:00`);
  const isToday = date.toDateString() === new Date().toDateString();
  const weekday = date.toLocaleDateString('de-DE', { weekday: 'long' });
  const dateStr = date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  return isToday ? `Heute, ${dateStr}` : `${weekday}, ${dateStr}`;
}

function renderHourTile(dp) {
  const p = dp.payload || {};
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'forecast-hour-tile';

  const time = document.createElement('div');
  time.className = 'forecast-hour-time';
  time.textContent = new Date(dp.item_timestamp).toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
  });
  tile.appendChild(time);

  const icon = document.createElement('div');
  icon.className = 'forecast-hour-icon';
  icon.textContent = weatherIcon(p.condition);
  icon.title = p.condition || 'Unbekannt';
  tile.appendChild(icon);

  const temp = document.createElement('div');
  temp.className = 'forecast-hour-temp';
  temp.textContent =
    dp.value_numeric !== null && dp.value_numeric !== undefined ? `${Math.round(dp.value_numeric)}°C` : '-';
  tile.appendChild(temp);

  if (p.windSpeedKmh !== null && p.windSpeedKmh !== undefined) {
    const wind = document.createElement('div');
    wind.className = 'forecast-hour-wind';
    const cardinal = degToCardinal(p.windDirectionDeg);
    if (p.windDirectionDeg !== null && p.windDirectionDeg !== undefined) {
      // Windrichtung ist meteorologisch "kommt aus" - der Pfeil zeigt dahin, wohin der Wind weht
      // (Nutzer-Interesse: wohin treibt z.B. eine Rauch-/Gaswolke), daher +180 Grad gedreht.
      const arrow = document.createElement('span');
      arrow.className = 'wind-arrow';
      arrow.textContent = '↑';
      arrow.style.transform = `rotate(${(p.windDirectionDeg + 180) % 360}deg)`;
      arrow.setAttribute('aria-hidden', 'true');
      wind.appendChild(arrow);
    }
    wind.appendChild(
      document.createTextNode(` ${Math.round(p.windSpeedKmh)} km/h${cardinal ? ` ${cardinal}` : ''}`)
    );
    if (cardinal) {
      wind.setAttribute('aria-label', `Wind aus ${cardinal}, ${Math.round(p.windSpeedKmh)} km/h`);
    }
    tile.appendChild(wind);
  }

  if (p.precipitation !== null && p.precipitation !== undefined && p.precipitation > 0) {
    const precip = document.createElement('div');
    precip.className = 'forecast-hour-precip';
    precip.textContent = `${p.precipitation} mm`;
    tile.appendChild(precip);
  }

  tile.addEventListener('click', () => window.selectDatapoint(dp));
  return tile;
}

function renderDayCard(dayKey, items) {
  const card = document.createElement('div');
  card.className = 'forecast-day-card';

  const heading = document.createElement('h3');
  heading.className = 'forecast-day-heading';
  heading.textContent = formatDayHeading(dayKey);
  card.appendChild(heading);

  const row = document.createElement('div');
  row.className = 'forecast-hour-row';
  [...items]
    .sort((a, b) => new Date(a.item_timestamp) - new Date(b.item_timestamp))
    .forEach((dp) => row.appendChild(renderHourTile(dp)));
  card.appendChild(row);

  return card;
}

function renderForecast(datapoints) {
  const container = document.getElementById('forecast-container');
  container.innerHTML = '';

  if (datapoints.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Aktuell keine Vorhersagedaten verfügbar.';
    container.appendChild(p);
    return;
  }

  groupByDay(datapoints).forEach(([dayKey, items]) => container.appendChild(renderDayCard(dayKey, items)));
}

let forecastMap;
let forecastMarker;

function initForecastMap(center) {
  forecastMap = L.map('map', { zoomControl: true }).setView(
    [center?.lat ?? 51.1657, center?.lon ?? 10.4515],
    center ? 11 : 6
  );
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap-Mitwirkende',
  }).addTo(forecastMap);
  addRadarLayerControl(forecastMap);
}

// Alle Stunden-Datenpunkte teilen sich dieselbe Koordinate (Wehr-Kartenmittelpunkt) - EIN Marker
// statt einem je Stunde, sonst stapeln sich dutzende identische Punkte unsichtbar uebereinander (der
// eigentliche Grund, warum die Karte hier bisher nichts brachte).
function renderForecastMapMarker(datapoints) {
  if (forecastMarker) {
    forecastMap.removeLayer(forecastMarker);
    forecastMarker = null;
  }
  const first = datapoints[0];
  if (!first || first.lat === null || first.lon === null) return;
  forecastMarker = L.circleMarker([first.lat, first.lon], {
    radius: 8,
    color: '#2563eb',
    fillColor: '#2563eb',
    fillOpacity: 0.85,
    weight: 2,
  }).bindTooltip('Standort der Vorhersage');
  forecastMarker.addTo(forecastMap);
}

window.selectDatapoint = function selectDatapoint(dp) {
  renderDetailPanel(dp);
};

async function loadAndRenderForecast() {
  const errorEl = document.getElementById('addon-error');
  try {
    const datapoints = await api.get('/datapoints?source=wetter_vorhersage');
    errorEl.textContent = '';
    renderForecast(datapoints);
    renderForecastMapMarker(datapoints);
    const stand = `Stand: ${new Date().toLocaleTimeString('de-DE')}`;
    document.getElementById('list-updated').textContent =
      datapoints.length === 0 ? `${stand} · Aktuell keine Vorhersagedaten verfügbar.` : stand;
  } catch (err) {
    console.error('[wetter-vorhersage] Vorhersage konnte nicht geladen werden:', err);
    errorEl.textContent =
      err.status === 403
        ? 'Kein Zugriff auf diese Datenquelle - bei Bedarf im Admin-Bereich freischalten lassen.'
        : 'Daten konnten nicht geladen werden. Bitte später erneut versuchen.';
  }
}

(async function bootstrapWetterVorhersage() {
  const user = await initHeader();
  if (!user) return;

  initForecastMap(user.wehrCenter);
  registerServiceWorker();
  await loadAndRenderForecast();
  setInterval(loadAndRenderForecast, 60 * 1000);
})();
