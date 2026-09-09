(async function checkExistingSession() {
  try {
    await api.get('/auth/me');
    window.location.href = './';
  } catch (err) {
    // keine gueltige Session -> auf der Login-Seite bleiben
  }
})();

let pendingTotpToken = null;

function showTotpStep() {
  document.getElementById('login-form').hidden = true;
  document.getElementById('login-2fa-form').hidden = false;
  document.getElementById('totp-code').focus();
}

function showPasswordStep() {
  pendingTotpToken = null;
  document.getElementById('login-2fa-form').hidden = true;
  document.getElementById('login-form').hidden = false;
  document.getElementById('login-2fa-error').textContent = '';
  document.getElementById('totp-code').value = '';
}

document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  try {
    const result = await api.post('/auth/login', { email, password });
    if (result && result.totpRequired) {
      pendingTotpToken = result.pendingToken;
      showTotpStep();
      return;
    }
    window.location.href = './';
  } catch (err) {
    errorEl.textContent = err.message || 'Anmeldung fehlgeschlagen.';
  }
});

document.getElementById('login-2fa-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = document.getElementById('login-2fa-error');
  errorEl.textContent = '';

  const code = document.getElementById('totp-code').value.trim();
  if (!pendingTotpToken) {
    showPasswordStep();
    return;
  }

  try {
    await api.post('/auth/login-2fa', { pendingToken: pendingTotpToken, code });
    window.location.href = './';
  } catch (err) {
    errorEl.textContent = err.message || 'Code ungültig.';
  }
});

document.getElementById('login-2fa-cancel').addEventListener('click', showPasswordStep);
