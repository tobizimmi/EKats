// Wehr-weite Hydrantenkarte (Migration 021, routes/hydrantenKarte.js): dieselbe
// GeoJSON-Kartenskizzen-Infrastruktur wie am Objekt (js/object-sketch.js, dort im Detail erklärt),
// hier aber als eigenständige Seite statt eines Dialog-Panels - eine Zeile je Wehr statt je Objekt.

const hydrantenKarte = { editor: null, center: null };

function renderHydrantenPreview(containerEl, center, geojson) {
  containerEl.innerHTML = '';
  const hasContent = geojson?.features?.length > 0;
  const mapEl = document.createElement('div');
  mapEl.className = 'hydranten-preview-map';
  containerEl.appendChild(mapEl);

  const map = L.map(mapEl).setView([center.lat, center.lon], 14);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap-Mitwirkende',
  }).addTo(map);
  renderSketchGeoJsonOnMap(map, geojson);
  setTimeout(() => map.invalidateSize(), 0);

  if (!hasContent) {
    const hint = document.createElement('p');
    hint.className = 'muted object-sketch-empty-hint';
    hint.textContent = 'Noch keine Hydranten/Löschwasserstellen eingezeichnet.';
    containerEl.appendChild(hint);
  }
}

function openHydrantenEditor(initialGeoJson) {
  document.getElementById('hydranten-preview').hidden = true;
  document.getElementById('hydranten-edit-button').hidden = true;
  document.getElementById('hydranten-editor').hidden = false;
  document.getElementById('hydranten-error').textContent = '';

  hydrantenKarte.editor = new ObjectSketchEditor({
    toolbarEl: document.getElementById('hydranten-toolbar'),
    mapContainerEl: document.getElementById('hydranten-map'),
    errorEl: document.getElementById('hydranten-error'),
    saveUrl: '/hydranten-karte',
    clearConfirmText: 'Wirklich die gesamte Hydrantenkarte der Wehr löschen?',
    center: hydrantenKarte.center,
    initialGeoJson,
  });
}

function closeHydrantenEditor() {
  if (hydrantenKarte.editor) {
    hydrantenKarte.editor.destroy();
    hydrantenKarte.editor = null;
  }
  document.getElementById('hydranten-editor').hidden = true;
  document.getElementById('hydranten-preview').hidden = false;
  document.getElementById('hydranten-edit-button').hidden = false;
}

async function saveHydrantenKarte() {
  if (!hydrantenKarte.editor) return;
  const geojson = sketchLayersToGeoJson(hydrantenKarte.editor.sketchLayers);
  const ok = await hydrantenKarte.editor.save();
  if (!ok) return;
  closeHydrantenEditor();
  renderHydrantenPreview(document.getElementById('hydranten-preview'), hydrantenKarte.center, geojson);
  document.getElementById('hydranten-updated').textContent = `Zuletzt geändert: ${formatTimestamp(new Date().toISOString())}`;
}

async function bootstrapHydrantenPage() {
  const user = await initHeader();
  if (!user) return;
  registerServiceWorker();

  const errorEl = document.getElementById('hydranten-error');
  try {
    const wehr = await api.get('/wehr');
    if (wehr.center_lat === null || wehr.center_lon === null) {
      errorEl.textContent = 'Kein Kartenmittelpunkt für die Wehr hinterlegt (siehe Admin-Bereich).';
      return;
    }
    hydrantenKarte.center = { lat: wehr.center_lat, lon: wehr.center_lon };

    const data = await api.get('/hydranten-karte');
    renderHydrantenPreview(document.getElementById('hydranten-preview'), hydrantenKarte.center, data.geojson);
    if (data.updated_at) {
      document.getElementById('hydranten-updated').textContent = `Zuletzt geändert: ${formatTimestamp(data.updated_at)}`;
    }

    if (user.role !== 'mitglied') {
      const editBtn = document.getElementById('hydranten-edit-button');
      editBtn.hidden = false;
      editBtn.addEventListener('click', () => openHydrantenEditor(data.geojson));
    }
  } catch (err) {
    errorEl.textContent = err.message;
  }

  document.getElementById('hydranten-save-button').addEventListener('click', saveHydrantenKarte);
  document.getElementById('hydranten-cancel-button').addEventListener('click', closeHydrantenEditor);
}

document.addEventListener('DOMContentLoaded', bootstrapHydrantenPage);
