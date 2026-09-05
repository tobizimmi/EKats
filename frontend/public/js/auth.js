(async function checkExistingSession() {
  try {
    await api.get('/auth/me');
    window.location.href = '/';
  } catch (err) {
    // keine gueltige Session -> auf der Login-Seite bleiben
  }
})();

document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  try {
    await api.post('/auth/login', { email, password });
    window.location.href = '/';
  } catch (err) {
    errorEl.textContent = err.message || 'Anmeldung fehlgeschlagen.';
  }
});
