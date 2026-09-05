function notFoundHandler(req, res) {
  res.status(404).json({ ok: false, error: 'Nicht gefunden.' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error('[error]', err);
  const status = err.status || 500;
  res.status(status).json({
    ok: false,
    error: status === 500 ? 'Interner Serverfehler.' : err.message,
  });
}

module.exports = { notFoundHandler, errorHandler };
