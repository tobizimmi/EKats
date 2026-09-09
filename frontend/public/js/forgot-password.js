document.getElementById('forgot-password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = document.getElementById('forgot-password-error');
  const successEl = document.getElementById('forgot-password-success');
  const submitBtn = document.getElementById('forgot-password-submit');
  errorEl.textContent = '';
  successEl.hidden = true;

  const email = document.getElementById('email').value.trim();
  submitBtn.disabled = true;

  try {
    await api.post('/auth/forgot-password', { email });
    // Bewusst immer dieselbe Erfolgsmeldung, unabhaengig davon ob die E-Mail wirklich existiert -
    // der Backend-Endpunkt antwortet ebenfalls immer identisch (siehe routes/auth.js), damit sich
    // daraus nicht ableiten laesst, welche E-Mail-Adressen als Konto registriert sind.
    successEl.hidden = false;
    document.getElementById('forgot-password-form').reset();
  } catch (err) {
    errorEl.textContent = err.message || 'Anfrage fehlgeschlagen. Bitte später erneut versuchen.';
  } finally {
    submitBtn.disabled = false;
  }
});
