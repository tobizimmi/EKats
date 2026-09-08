const config = require('../config');

// Gemeinsamer fetch-Wrapper fuer alle Connectors: setzt einen erkennbaren User-Agent
// (von PEGELONLINE/DWD ausdruecklich gewuenscht) und einen Timeout, da externe Behoerden-APIs
// gelegentlich haengen bleiben statt sauber zu antworten.
async function fetchText(url, { timeoutMs = 15000, headers = {}, method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      body,
      signal: controller.signal,
      headers: { 'User-Agent': config.userAgent, ...headers },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} fuer ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, opts) {
  const text = await fetchText(url, opts);
  return JSON.parse(text);
}

// Fuer APIs, die statt JSON ein application/x-www-form-urlencoded POST erwarten (z.B.
// hochwasserzentralen.de get_infospegel.php, siehe fetchers/hochwasserzentralen.js).
async function postForm(url, params, opts) {
  const body = new URLSearchParams(params).toString();
  return fetchJson(url, {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(opts?.headers || {}) },
    body,
  });
}

async function fetchBuffer(url, { timeoutMs = 20000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': config.userAgent, ...headers },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} fuer ${url}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchText, fetchJson, fetchBuffer, postForm };
