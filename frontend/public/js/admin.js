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
