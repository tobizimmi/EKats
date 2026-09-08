// Gemeinsamer fetch-Wrapper: Cookie-basierte Session (credentials: 'include'), einheitliches
// {ok, data|error}-Antwortformat aus dem Backend. Bewusst ein RELATIVER Pfad (kein fuehrender "/"):
// so funktioniert die App unveraendert egal ob sie unter der Domain-Root oder einem Unterpfad
// (z.B. https://zimmimail.de/EKats/) ausgeliefert wird - siehe README "Deployment".
async function apiRequest(path, { method = 'GET', body } = {}) {
  const res = await fetch(`api${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error(`Unerwartete Antwort vom Server (Status ${res.status}).`);
  }

  if (!res.ok || !json.ok) {
    const message = json?.error || `Fehler (Status ${res.status}).`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return json.data;
}

const api = {
  get: (path) => apiRequest(path),
  post: (path, body) => apiRequest(path, { method: 'POST', body }),
  put: (path, body) => apiRequest(path, { method: 'PUT', body }),
  patch: (path, body) => apiRequest(path, { method: 'PATCH', body }),
  delete: (path, body) => apiRequest(path, { method: 'DELETE', body }),
};
