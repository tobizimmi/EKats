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
      } catch (err) {
        alert(err.message);
        roleSelect.value = user.role;
      }
    });
    roleCell.appendChild(roleSelect);

    const createdCell = document.createElement('td');
    createdCell.textContent = formatTimestamp(user.created_at);

    const actionCell = document.createElement('td');
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'secondary';
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Löschen';
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`Konto ${user.email} wirklich löschen?`)) return;
      try {
        await api.delete(`/users/${user.id}`);
        await loadUsers(currentUserId);
      } catch (err) {
        alert(err.message);
      }
    });
    actionCell.appendChild(deleteBtn);

    tr.appendChild(emailCell);
    tr.appendChild(roleCell);
    tr.appendChild(createdCell);
    tr.appendChild(actionCell);
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
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
})();
