const resetToken = new URLSearchParams(window.location.search).get('token');

if (!resetToken) {
  document.getElementById('reset-password-missing-token').hidden = false;
  document.getElementById('reset-password-form').hidden = true;
}

document.getElementById('reset-password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = document.getElementById('reset-password-error');
  const submitBtn = document.getElementById('reset-password-submit');
  errorEl.textContent = '';

  const newPassword = document.getElementById('new-password').value;
  const newPasswordConfirm = document.getElementById('new-password-confirm').value;
  if (newPassword !== newPasswordConfirm) {
    errorEl.textContent = 'Die beiden Passwörter stimmen nicht überein.';
    return;
  }

  submitBtn.disabled = true;
  try {
    await api.post('/auth/reset-password', { token: resetToken, newPassword });
    window.location.href = 'login.html';
  } catch (err) {
    errorEl.textContent = err.message || 'Zurücksetzen fehlgeschlagen.';
  } finally {
    submitBtn.disabled = false;
  }
});
