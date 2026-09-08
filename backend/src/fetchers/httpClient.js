const config = require('../config');

// Gemeinsamer fetch-Wrapper fuer alle Connectors: setzt einen erkennbaren User-Agent
// (von PEGELONLINE/DWD ausdruecklich gewuenscht) und einen Timeout, da externe Behoerden-APIs
// gelegentlich haengen bleiben statt sauber zu antworten.
async function fetchText(url, { timeoutMs = 15000, headers = {} } = {}) {
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
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, opts) {
  const text = await fetchText(url, opts);
  return JSON.parse(text);
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

module.exports = { fetchText, fetchJson, fetchBuffer };
