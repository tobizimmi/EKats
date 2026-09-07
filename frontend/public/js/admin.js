async function loadWehr() {
  const wehr = await api.get('/wehr');
  document.getElementById('wehr-name').value = wehr.name || '';
  document.getElementById('wehr-lat').value = wehr.center_lat ?? '';
  document.getElementById('wehr-lon').value = wehr.center_lon ?? '';
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

(async function bootstrapAdmin() {
  const user = await initHeader();
  if (!user) return;

  if (user.role !== 'admin') {
    document.getElementById('admin-guard-notice').hidden = false;
    return;
  }
  document.getElementById('admin-content').hidden = false;

  await loadWehr();
  await loadUsers(user.id);
  await loadStations();
  await loadVehicles();
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
    try {
      await api.patch('/wehr', {
        name: document.getElementById('wehr-name').value.trim(),
        centerLat: lat === '' ? null : Number(lat),
        centerLon: lon === '' ? null : Number(lon),
      });
    } catch (err) {
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
})();
