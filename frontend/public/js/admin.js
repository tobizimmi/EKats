function renderNeighborLandkreise(wehr) {
  const el = document.getElementById('wehr-neighbors');
  if (!wehr.home_landkreis_ags) {
    el.textContent = '';
    return;
  }
  const names = (wehr.neighborLandkreise || []).map((k) => k.name);
  el.textContent = names.length
    ? `Angrenzende Landkreise: ${names.join(', ')}`
    : 'Keine angrenzenden Landkreise gefunden (Grenzgebiet zum Ausland o.ä.).';
}

async function loadLandkreisOptions(selectedAgs) {
  const select = document.getElementById('wehr-landkreis');
  const landkreise = await api.get('/landkreise');
  select.innerHTML = '<option value="">– keiner ausgewählt –</option>';
  landkreise.forEach((lk) => {
    const opt = document.createElement('option');
    opt.value = lk.ags;
    opt.textContent = `${lk.name} (${lk.state})`;
    opt.selected = lk.ags === selectedAgs;
    select.appendChild(opt);
  });
}

async function loadWehr() {
  const wehr = await api.get('/wehr');
  document.getElementById('wehr-name').value = wehr.name || '';
  document.getElementById('wehr-lat').value = wehr.center_lat ?? '';
  document.getElementById('wehr-lon').value = wehr.center_lon ?? '';
  await loadLandkreisOptions(wehr.home_landkreis_ags);
  renderNeighborLandkreise(wehr);
}

async function loadUsers(currentUserId) {
  const tbody = document.getElementById('user-table-body');
  tbody.innerHTML = '';
  const users = await api.get('/users');

  users.forEach((user) => {
    const tr = document.createElement('tr');

    const emailCell = document.createElement('td');
    emailCell.textContent = user.email + (user.id === currentUserId ? ' (Sie)' : '');

    const roleCell = document.createElement('td');
    const roleSelect = document.createElement('select');
    ['admin', 'stab', 'mitglied'].forEach((role) => {
      const opt = document.createElement('option');
      opt.value = role;
      opt.textContent = ROLE_LABELS[role];
      opt.selected = role === user.role;
      roleSelect.appendChild(opt);
    });
    roleSelect.addEventListener('change', async () => {
      try {
        await api.patch(`/users/${user.id}`, { role: roleSelect.value });
        await loadUsers(currentUserId);
        await loadAuditLog();
      } catch (err) {
        alert(err.message);
        roleSelect.value = user.role;
      }
    });
    roleCell.appendChild(roleSelect);

    const createdCell = document.createElement('td');
    createdCell.textContent = formatTimestamp(user.created_at);

    const actionCell = document.createElement('td');

    const resetBtn = document.createElement('button');
    resetBtn.className = 'secondary';
    resetBtn.type = 'button';
    resetBtn.textContent = 'Passwort zurücksetzen';
    resetBtn.addEventListener('click', async () => {
      const newPassword = prompt(`Neues Passwort für ${user.email} (mind. 8 Zeichen):`);
      if (!newPassword) return;
      try {
        await api.post(`/users/${user.id}/reset-password`, { newPassword });
        alert('Passwort zurückgesetzt. Bitte dem Nutzer sicher mitteilen.');
        await loadAuditLog();
      } catch (err) {
        alert(err.message);
      }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'secondary';
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Löschen';
    deleteBtn.style.marginLeft = '0.4rem';
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`Konto ${user.email} wirklich löschen?`)) return;
      try {
        await api.delete(`/users/${user.id}`);
        await loadUsers(currentUserId);
        await loadAuditLog();
      } catch (err) {
        alert(err.message);
      }
    });
    actionCell.appendChild(resetBtn);
    actionCell.appendChild(deleteBtn);

    tr.appendChild(emailCell);
    tr.appendChild(roleCell);
    tr.appendChild(createdCell);
    tr.appendChild(actionCell);
    tbody.appendChild(tr);
  });
}

// Jobs, die nicht in severity.js::SOURCE_LABELS stehen, weil sie keine nutzerseitig sichtbare
// Datenquelle sind, sondern interne Wartungsjobs (siehe scheduler.js).
const FETCHER_HEALTH_EXTRA_LABELS = {
  dwd_stations_import: 'DWD-Stationsimport (intern)',
  cleanup: 'Alte Datenpunkte aufräumen (intern)',
};

// Fehlermeldungen eines Fetchers koennen Fragmente einer externen Antwort enthalten (siehe
// httpClient.js-Fehlertexte) - anders als die uebrigen, vom System selbst erzeugten Admin-Tabellen-
// Felder hier bewusst escaped statt roh interpoliert.
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDurationMs(ms) {
  if (ms === null || ms === undefined) return '-';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

async function loadFetcherHealth() {
  const tbody = document.getElementById('fetcher-health-table-body');
  tbody.innerHTML = '';
  let rows;
  try {
    rows = await api.get('/fetcher-health');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="error-message">${err.message}</td></tr>`;
    return;
  }

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">Noch kein Fetcher-Lauf protokolliert (Server evtl. gerade erst gestartet).</td></tr>';
    return;
  }

  rows.forEach((row) => {
    const label = SOURCE_LABELS[row.source_key] || FETCHER_HEALTH_EXTRA_LABELS[row.source_key] || row.source_key;
    const hasRecentError = row.last_error_at && (!row.last_success_at || new Date(row.last_error_at) > new Date(row.last_success_at));
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${label}</td>
      <td>${formatTimestamp(row.last_run_at)}</td>
      <td>${formatTimestamp(row.last_success_at)}</td>
      <td class="${hasRecentError ? 'error-message' : 'muted'}">${row.last_error_at ? formatTimestamp(row.last_error_at) : '-'}${row.last_error_message ? ` – ${escapeHtml(row.last_error_message)}` : ''}</td>
      <td>${formatDurationMs(row.last_duration_ms)}</td>
      <td>${row.last_written_count ?? '-'}</td>`;
    tbody.appendChild(tr);
  });
}

async function loadAuditLog() {
  const tbody = document.getElementById('audit-log-table-body');
  tbody.innerHTML = '';
  const entries = await api.get('/audit-log');

  if (entries.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="5" class="muted">Keine Einträge.</td>';
    tbody.appendChild(tr);
    return;
  }

  entries.forEach((entry) => {
    const tr = document.createElement('tr');
    const detailsText = entry.details && Object.keys(entry.details).length ? JSON.stringify(entry.details) : '-';
    tr.innerHTML = `
      <td>${formatTimestamp(entry.created_at)}</td>
      <td>${entry.action}</td>
      <td>${entry.actor_email || '-'}</td>
      <td>${entry.target_type || '-'}${entry.target_id ? ` #${entry.target_id}` : ''}</td>
      <td class="muted">${detailsText}</td>`;
    tbody.appendChild(tr);
  });
}

async function loadStations() {
  const tbody = document.getElementById('station-table-body');
  tbody.innerHTML = '';
  const stations = await api.get('/stations');

  const stationSelect = document.getElementById('vehicle-station');
  stationSelect.innerHTML = '<option value="">–</option>';
  stations.forEach((station) => {
    const opt = document.createElement('option');
    opt.value = station.id;
    opt.textContent = station.name;
    stationSelect.appendChild(opt);
  });

  stations.forEach((station) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${station.name}</td><td>${station.address || '-'}</td><td></td>`;
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'secondary';
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Löschen';
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`Wache "${station.name}" wirklich löschen?`)) return;
      try {
        await api.delete(`/stations/${station.id}`);
        await loadStations();
        await loadVehicles();
      } catch (err) {
        alert(err.message);
      }
    });
    tr.querySelector('td:last-child').appendChild(deleteBtn);
    tbody.appendChild(tr);
  });
  return stations;
}

async function loadVehicles() {
  const tbody = document.getElementById('vehicle-table-body');
  tbody.innerHTML = '';
  const vehicles = await api.get('/vehicles');
  vehicles.forEach((vehicle) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${vehicle.name}</td><td>${vehicle.station_name || '-'}</td><td></td>`;
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'secondary';
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Löschen';
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`Fahrzeug "${vehicle.name}" wirklich löschen?`)) return;
      try {
        await api.delete(`/vehicles/${vehicle.id}`);
        await loadVehicles();
      } catch (err) {
        alert(err.message);
      }
    });
    tr.querySelector('td:last-child').appendChild(deleteBtn);
    tbody.appendChild(tr);
  });
}

// ---------------------------------------------------------------------------
// Objekt-Zusatzfelder (Konzept "Objektverwaltung 2.0")
// ---------------------------------------------------------------------------

const FIELD_TYPE_LABELS = {
  text: 'Text', textarea: 'Mehrzeiliger Text', number: 'Zahl',
  boolean: 'Ja/Nein', date: 'Datum', select: 'Auswahlliste',
};

function parseFieldOptions(raw) {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [value, label] = part.split('=').map((s) => s.trim());
      return { value: value || part, label: label || value || part };
    });
}

async function loadFieldDefinitions() {
  const tbody = document.getElementById('field-def-table-body');
  tbody.innerHTML = '';
  const defs = await api.get('/object-fields');

  if (defs.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="5" class="muted">Keine Zusatzfelder definiert.</td>';
    tbody.appendChild(tr);
    return defs;
  }

  defs.forEach((def) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${def.key}</code></td>
      <td>${def.label}</td>
      <td>${FIELD_TYPE_LABELS[def.field_type] || def.field_type}</td>
      <td>${def.required ? 'ja' : 'nein'}</td>
      <td></td>`;
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'secondary';
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Löschen';
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`Zusatzfeld "${def.label}" wirklich löschen? (Bereits gespeicherte Werte bleiben erhalten.)`)) return;
      try {
        await api.delete(`/object-fields/${def.id}`);
        await loadFieldDefinitions();
      } catch (err) {
        alert(err.message);
      }
    });
    tr.querySelector('td:last-child').appendChild(deleteBtn);
    tbody.appendChild(tr);
  });
  return defs;
}

// ---------------------------------------------------------------------------
// Zugriffssteuerung je Datenquelle (Feature-Zugriffssteuerung, ab Phase 5 auf alle Addons
// generalisiert statt nur Kachelmann - siehe Konzept Teil 2, Baustein C)
// ---------------------------------------------------------------------------

const FEATURE_LABELS = {
  dwd_unwetter: 'DWD-Unwetterwarnungen',
  pegelonline: 'Pegelstände (PEGELONLINE)',
  hochwasserzentralen: 'Hochwasser (Hochwasserzentralen)',
  waldbrandindex: 'Waldbrandgefahrenindex',
  firms: 'Feuer-Hotspots (NASA FIRMS)',
  bbk_warnung: 'Bevölkerungswarnungen (BBK/NINA)',
  kachelmann: 'Kachelmann/Meteologix',
  wetter_vorhersage: 'Wetter-Vorhersage (Bright Sky)',
  blitzortung: 'Blitzortung (Blitzortung.org)',
};
const FEATURE_ROLES = ['admin', 'stab', 'mitglied'];

async function loadFeatureMatrix() {
  const errorEl = document.getElementById('feature-matrix-error');
  errorEl.textContent = '';
  let features;
  try {
    features = await api.get('/feature-access');
  } catch (err) {
    errorEl.textContent = err.message;
    return;
  }

  const tbody = document.getElementById('feature-matrix-body');
  tbody.innerHTML = '';
  features.forEach((feature) => {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    nameTd.textContent = FEATURE_LABELS[feature.featureKey] || feature.featureKey;
    if (!feature.defaultOpen) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'ohne Regel gesperrt';
      badge.style.marginLeft = '0.5rem';
      nameTd.appendChild(badge);
    }
    tr.appendChild(nameTd);

    const checkboxes = {};
    FEATURE_ROLES.forEach((role) => {
      const td = document.createElement('td');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = feature.roles.includes(role);
      checkboxes[role] = checkbox;
      td.appendChild(checkbox);
      tr.appendChild(td);
    });

    const actionTd = document.createElement('td');
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'secondary';
    saveBtn.textContent = 'Speichern';
    saveBtn.addEventListener('click', async () => {
      errorEl.textContent = '';
      const roles = FEATURE_ROLES.filter((role) => checkboxes[role].checked);
      try {
        await api.put(`/feature-access/${feature.featureKey}/roles`, { roles });
      } catch (err) {
        errorEl.textContent = err.message;
      }
    });
    actionTd.appendChild(saveBtn);
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  });

  const select = document.getElementById('feature-user-select');
  if (select.options.length === 0) {
    features.forEach((feature) => {
      const opt = document.createElement('option');
      opt.value = feature.featureKey;
      opt.textContent = FEATURE_LABELS[feature.featureKey] || feature.featureKey;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => loadFeatureUserOverrides(select.value));
  }
  await loadFeatureUserOverrides(select.value);
}

async function loadFeatureUserOverrides(featureKey) {
  const errorEl = document.getElementById('feature-matrix-error');
  let data;
  try {
    data = await api.get(`/feature-access/${featureKey}`);
  } catch (err) {
    errorEl.textContent = err.message;
    return;
  }

  const overrideByUser = new Map(data.userOverrides.map((o) => [o.user_id, o.enabled]));
  const tbody = document.getElementById('feature-user-table-body');
  tbody.innerHTML = '';
  data.users.forEach((u) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${u.email}</td><td>${ROLE_LABELS[u.role] || u.role}</td><td></td>`;
    const select = document.createElement('select');
    [
      { value: '', label: 'Nach Rolle (Standard)' },
      { value: 'true', label: 'Immer erlauben' },
      { value: 'false', label: 'Immer sperren' },
    ].forEach((opt) => {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      select.appendChild(o);
    });
    const current = overrideByUser.get(u.id);
    select.value = current === undefined ? '' : String(current);
    select.addEventListener('change', async () => {
      try {
        const enabled = select.value === '' ? null : select.value === 'true';
        await api.put(`/feature-access/${featureKey}/user-override`, { userId: u.id, enabled });
      } catch (err) {
        errorEl.textContent = err.message;
        await loadFeatureUserOverrides(featureKey);
      }
    });
    tr.querySelector('td:last-child').appendChild(select);
    tbody.appendChild(tr);
  });
}

// ---------------------------------------------------------------------------
// PDF-Vorlagen
// ---------------------------------------------------------------------------

async function loadPdfTemplate() {
  const type = document.getElementById('pdf-template-type').value;
  const errorEl = document.getElementById('pdf-template-error');
  errorEl.textContent = '';
  document.getElementById('pdf-template-preview-frame').hidden = true;
  try {
    const data = await api.get(`/pdf-templates/${type}`);
    document.getElementById('pdf-template-html').value = data ? data.html_template : '';
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

async function loadSmtpSettings() {
  const errorEl = document.getElementById('smtp-error');
  errorEl.textContent = '';
  try {
    const data = await api.get('/smtp-settings');
    document.getElementById('smtp-host').value = data.host || '';
    document.getElementById('smtp-port').value = data.port || '';
    document.getElementById('smtp-user').value = data.user || '';
    document.getElementById('smtp-from').value = data.from || '';
    document.getElementById('smtp-pass-hint').textContent = data.hasPassword ? '(gesetzt)' : '(nicht gesetzt)';
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

(async function bootstrapAdmin() {
  const user = await initHeader();
  if (!user) return;

  if (user.role !== 'admin') {
    document.getElementById('admin-guard-notice').hidden = false;
    return;
  }
  document.getElementById('admin-content').hidden = false;

  await loadWehr();
  await loadSmtpSettings();
  await loadUsers(user.id);
  await loadStations();
  await loadVehicles();
  await loadFetcherHealth();
  await loadAuditLog();

  document.getElementById('station-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById('station-error');
    errorEl.textContent = '';
    try {
      await api.post('/stations', {
        name: document.getElementById('station-name').value.trim(),
        address: document.getElementById('station-address').value.trim() || null,
      });
      event.target.reset();
      await loadStations();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  document.getElementById('vehicle-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById('vehicle-error');
    errorEl.textContent = '';
    const stationId = document.getElementById('vehicle-station').value;
    try {
      await api.post('/vehicles', {
        name: document.getElementById('vehicle-name').value.trim(),
        stationId: stationId ? Number(stationId) : null,
      });
      event.target.reset();
      await loadVehicles();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  document.getElementById('wehr-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById('wehr-error');
    errorEl.textContent = '';
    const lat = document.getElementById('wehr-lat').value;
    const lon = document.getElementById('wehr-lon').value;
    const landkreisAgs = document.getElementById('wehr-landkreis').value;
    try {
      const updated = await api.patch('/wehr', {
        name: document.getElementById('wehr-name').value.trim(),
        centerLat: lat === '' ? null : Number(lat),
        centerLon: lon === '' ? null : Number(lon),
        homeLandkreisAgs: landkreisAgs || null,
      });
      renderNeighborLandkreise(updated);
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  document.getElementById('smtp-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById('smtp-error');
    const statusEl = document.getElementById('smtp-status');
    errorEl.textContent = '';
    statusEl.textContent = '';
    const host = document.getElementById('smtp-host').value.trim();
    const port = document.getElementById('smtp-port').value;
    const smtpUser = document.getElementById('smtp-user').value.trim();
    const pass = document.getElementById('smtp-pass').value;
    const from = document.getElementById('smtp-from').value.trim();
    try {
      // Leeres Passwortfeld = unveraendert lassen (kein "pass"-Feld im Body), damit ein
      // gespeichertes Passwort nicht bei jedem Speichern der uebrigen Felder geloescht wird.
      await api.put('/smtp-settings', {
        host: host || null,
        port: port ? Number(port) : null,
        user: smtpUser || null,
        ...(pass ? { pass } : {}),
        from: from || null,
      });
      document.getElementById('smtp-pass').value = '';
      statusEl.textContent = 'Gespeichert.';
      await loadSmtpSettings();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  document.getElementById('smtp-test-button').addEventListener('click', async () => {
    const errorEl = document.getElementById('smtp-error');
    const statusEl = document.getElementById('smtp-status');
    errorEl.textContent = '';
    statusEl.textContent = 'Sende Test-E-Mail…';
    try {
      await api.post('/smtp-settings/test');
      statusEl.textContent = `Test-E-Mail an ${user.email} verschickt.`;
    } catch (err) {
      statusEl.textContent = '';
      errorEl.textContent = err.message;
    }
  });

  document.getElementById('user-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById('user-error');
    errorEl.textContent = '';
    try {
      await api.post('/users', {
        email: document.getElementById('user-email').value.trim(),
        password: document.getElementById('user-password').value,
        role: document.getElementById('user-role').value,
      });
      event.target.reset();
      await loadUsers(user.id);
      await loadAuditLog();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  await loadFieldDefinitions();
  await loadFeatureMatrix();
  await loadPdfTemplate();

  document.getElementById('field-def-type').addEventListener('change', (event) => {
    document.getElementById('field-def-options-row').hidden = event.target.value !== 'select';
  });

  document.getElementById('field-def-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById('field-def-error');
    errorEl.textContent = '';
    const fieldType = document.getElementById('field-def-type').value;
    try {
      await api.post('/object-fields', {
        key: document.getElementById('field-def-key').value.trim(),
        label: document.getElementById('field-def-label').value.trim(),
        fieldType,
        options: fieldType === 'select' ? parseFieldOptions(document.getElementById('field-def-options').value) : null,
        required: document.getElementById('field-def-required').checked,
      });
      event.target.reset();
      document.getElementById('field-def-options-row').hidden = true;
      await loadFieldDefinitions();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  document.getElementById('pdf-template-type').addEventListener('change', loadPdfTemplate);

  document.getElementById('pdf-template-save').addEventListener('click', async () => {
    const errorEl = document.getElementById('pdf-template-error');
    errorEl.textContent = '';
    const type = document.getElementById('pdf-template-type').value;
    const htmlTemplate = document.getElementById('pdf-template-html').value;
    try {
      await api.put(`/pdf-templates/${type}`, { htmlTemplate });
      alert('Vorlage gespeichert.');
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  document.getElementById('pdf-template-delete').addEventListener('click', async () => {
    const type = document.getElementById('pdf-template-type').value;
    if (!confirm('Vorlage wirklich löschen? Der Export nutzt danach wieder das Standardformat (nur Aufgabenzettel) bzw. ist bis zur nächsten Vorlage nicht verfügbar (Objekt-Datenblatt).')) return;
    try {
      await api.delete(`/pdf-templates/${type}`);
      document.getElementById('pdf-template-html').value = '';
    } catch (err) {
      document.getElementById('pdf-template-error').textContent = err.message;
    }
  });

  document.getElementById('pdf-template-preview').addEventListener('click', async () => {
    const errorEl = document.getElementById('pdf-template-error');
    errorEl.textContent = '';
    const type = document.getElementById('pdf-template-type').value;
    const htmlTemplate = document.getElementById('pdf-template-html').value;
    try {
      const res = await fetch(`api/pdf-templates/${type}/preview`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ htmlTemplate }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Vorschau fehlgeschlagen (Status ${res.status}).`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const frame = document.getElementById('pdf-template-preview-frame');
      frame.src = url;
      frame.hidden = false;
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  // Objektdaten-Import (Kehrseite von GET /api/objects/export, siehe backend/src/routes/objects.js
  // POST /import) - liest die vom Nutzer ausgewaehlte Datei clientseitig als JSON, damit ein
  // fehlerhaftes/fremdes JSON-Dokument schon hier mit einer klaren Meldung abgelehnt wird statt erst
  // nach einem Server-Roundtrip.
  document.getElementById('object-import-button').addEventListener('click', async () => {
    const fileInput = document.getElementById('object-import-file');
    const errorEl = document.getElementById('object-import-error');
    const resultEl = document.getElementById('object-import-result');
    errorEl.textContent = '';
    resultEl.hidden = true;

    const file = fileInput.files[0];
    if (!file) {
      errorEl.textContent = 'Bitte zuerst eine Export-Datei auswählen.';
      return;
    }

    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch (err) {
      errorEl.textContent = 'Datei ist kein gültiges JSON.';
      return;
    }

    try {
      const result = await api.post('/objects/import', payload);
      const parts = [`${result.importedCount} Objekt(e) importiert.`];
      if (result.errors.length) parts.push(`${result.errors.length} übersprungen: ${result.errors.join(' | ')}`);
      if (result.taskWarnings.length) parts.push(`${result.taskWarnings.length} Aufgaben-Hinweis(e): ${result.taskWarnings.join(' | ')}`);
      resultEl.textContent = parts.join(' ');
      resultEl.hidden = false;
      fileInput.value = '';
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  // Import aus der urspruenglichen lokalen Feuerwehr-Objektverwaltung: multipart-Upload wie beim
  // Anhang-Upload im Objekt-Dialog (js/objects.js uploadAttachmentToCurrentObject) statt api.post -
  // eine Binaerdatei laesst sich nicht als JSON durch den api.js-Wrapper schicken.
  document.getElementById('object-import-feuerwehrapp-button').addEventListener('click', async () => {
    const fileInput = document.getElementById('object-import-feuerwehrapp-file');
    const errorEl = document.getElementById('object-import-feuerwehrapp-error');
    const resultEl = document.getElementById('object-import-feuerwehrapp-result');
    errorEl.textContent = '';
    resultEl.hidden = true;

    const file = fileInput.files[0];
    if (!file) {
      errorEl.textContent = 'Bitte zuerst eine .sqlite-Datei auswählen.';
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('api/objects/import-feuerwehrapp', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `Fehler (Status ${res.status}).`);
      const result = json.data;
      const parts = [`${result.importedCount} Objekt(e) importiert.`];
      if (result.errors.length) parts.push(`${result.errors.length} übersprungen: ${result.errors.join(' | ')}`);
      if (result.taskWarnings.length) parts.push(`${result.taskWarnings.length} Aufgaben-Hinweis(e): ${result.taskWarnings.join(' | ')}`);
      resultEl.textContent = parts.join(' ');
      resultEl.hidden = false;
      fileInput.value = '';
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
})();
