const THRESHOLD_META = {
  dwd_unwetter: { key: 'warnstufe', label: 'Warnstufe (1-4)', targetLabel: 'Bundesland-Code (optional, z.B. NW)' },
  pegelonline: { key: 'wasserstand_cm', label: 'Wasserstand (cm)', targetLabel: 'Pegelname (Pflicht, Teilstring)' },
  hochwasserzentralen: {
    key: 'meldestufe',
    label: 'Meldestufe (0-4)',
    targetLabel: 'Name/Gewässer (optional, Teilstring)',
  },
  waldbrandindex: { key: 'gefahrenstufe', label: 'Gefahrenstufe (1-5)', targetLabel: 'Bundesland-Code (optional)' },
  firms: { key: 'radius_km', label: 'Radius (km)', targetLabel: 'nicht verwendet' },
};

function updateRuleFormLabels() {
  const source = document.getElementById('rule-source').value;
  const meta = THRESHOLD_META[source];
  document.getElementById('rule-threshold-label').textContent = `Schwellenwert: ${meta.label}`;
  document.getElementById('rule-target-label').textContent = meta.targetLabel;
  const targetInput = document.getElementById('rule-target');
  targetInput.disabled = source === 'firms';
  if (source === 'firms') targetInput.value = '';
}

async function loadRules() {
  const tbody = document.getElementById('rule-table-body');
  tbody.innerHTML = '';
  const rules = await api.get('/alert-rules');
  rules.forEach((rule) => {
    const tr = document.createElement('tr');
    const channels = [rule.channel_push && 'Push', rule.channel_email && 'E-Mail'].filter(Boolean).join(', ');
    tr.innerHTML = `
      <td>${SOURCE_LABELS[rule.source] || rule.source}</td>
      <td>${rule.target_ref || '-'}</td>
      <td>${rule.threshold_value}</td>
      <td>${channels || '-'}</td>
      <td>${rule.active ? 'ja' : 'nein'}</td>
      <td></td>`;
    const actionCell = tr.querySelector('td:last-child');

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'secondary';
    toggleBtn.type = 'button';
    toggleBtn.textContent = rule.active ? 'Deaktivieren' : 'Aktivieren';
    toggleBtn.addEventListener('click', async () => {
      await api.patch(`/alert-rules/${rule.id}`, { active: !rule.active });
      loadRules();
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'secondary';
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Löschen';
    deleteBtn.style.marginLeft = '0.4rem';
    deleteBtn.addEventListener('click', async () => {
      await api.delete(`/alert-rules/${rule.id}`);
      loadRules();
    });

    actionCell.appendChild(toggleBtn);
    actionCell.appendChild(deleteBtn);
    tbody.appendChild(tr);
  });
}

(async function bootstrapSettings() {
  const user = await initHeader();
  if (!user) return;

  document.getElementById('rule-source').addEventListener('change', updateRuleFormLabels);
  updateRuleFormLabels();

  await initPushUi(document.getElementById('push-status'), document.getElementById('push-button'));

  document.getElementById('delete-account-button').addEventListener('click', async () => {
    if (!confirm('Ihr Konto wird endgültig gelöscht. Fortfahren?')) return;
    try {
      await api.delete('/users/me');
      window.location.href = 'login.html';
    } catch (err) {
      alert(err.message);
    }
  });

  if (user.role !== 'mitglied') {
    await loadRules();

    document.getElementById('rule-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const errorEl = document.getElementById('rule-error');
      errorEl.textContent = '';
      const source = document.getElementById('rule-source').value;
      const meta = THRESHOLD_META[source];
      try {
        await api.post('/alert-rules', {
          source,
          targetRef: document.getElementById('rule-target').value.trim() || null,
          thresholdKey: meta.key,
          thresholdValue: document.getElementById('rule-threshold').value,
          channelPush: document.getElementById('rule-channel-push').checked,
          channelEmail: document.getElementById('rule-channel-email').checked,
        });
        event.target.reset();
        updateRuleFormLabels();
        await loadRules();
      } catch (err) {
        errorEl.textContent = err.message;
      }
    });
  }
})();
