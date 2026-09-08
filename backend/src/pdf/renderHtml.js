// HTML-Template-PDF-Rendering ueber headless Chromium/Playwright (Konzept Teil 3, "Offene
// Entscheidungen" Punkt 2: Nutzer hat dem zusaetzlichen Betriebsaufwand zugestimmt).
//
// Zwei Sicherheitsentscheidungen aus dem Konzept, hier umgesetzt:
// 1. Platzhalter statt Skriptsprache: renderTemplate() kennt nur {{pfad.zu.feld}}, {{#each pfad}}
//    (Wiederholung ueber ein Array) und {{#if pfad}} (Sichtbarkeit je nach Wahrheitswert) - bewusst
//    "logic-less" nach dem Mustache-Vorbild: KEIN eval(), KEINE Ausdruecke/Funktionsaufrufe/
//    Vergleiche. Ein kompromittierter Admin-Account kann damit kein beliebiges JS auf dem Server
//    ausfuehren, nur vordefinierte Datenfelder einsetzen/iterieren/ein-ausblenden. #each ist noetig,
//    weil ein Aufgabenzettel eine Aufgabenliste unbekannter Laenge darstellen muss - ohne jede Form
//    von Wiederholung waere das Format für den Hauptanwendungsfall nicht nutzbar.
// 2. Kein Netzwerkzugriff beim Rendern: page.setContent() laedt das HTML direkt in den DOM (keine
//    Navigation/kein Request), zusaetzlich blockt page.route() defensiv JEDEN Netzwerk-Request
//    (SSRF-Schutz gegen z.B. <img src="http://internes-system/...">). Bilder muessen daher als
//    Data-URI eingebettet sein - ein per URL eingebundenes Bild wird schlicht nicht geladen.
//
// Browser-Pfad: in Produktion per `npx playwright install chromium` selbst verwaltet (kein
// executablePath noetig, Playwright findet seinen eigenen Download). In dieser Entwicklungs-Sandbox
// zeigt PLAYWRIGHT_CHROMIUM_PATH auf die vorinstallierte Chromium-Instanz (siehe README
// Verifikationsstand) - diese Variable ist NICHT fuer den Produktivbetrieb gedacht.
const { chromium } = require('playwright');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), obj);
}

const TAG_RE = /\{\{\s*(#each|#if|\/each|\/if)?\s*([a-zA-Z0-9_.]*)\s*\}\}/g;

// Parst das Template in einen kleinen Baum aus Text-/Wert-/each-/if-Knoten (Stack-basiert, damit
// verschachtelte {{#each}}/{{#if}}-Bloecke korrekt aufgeloest werden). Siehe Sicherheitsentscheidung
// 1 oben - das ist die vollstaendige Ausdrucksmaechtigkeit dieser "Sprache".
function parseTemplate(template) {
  const root = { children: [] };
  const stack = [root];
  let lastIndex = 0;
  let match;
  TAG_RE.lastIndex = 0;
  while ((match = TAG_RE.exec(template)) !== null) {
    const [full, control, path] = match;
    const textBefore = template.slice(lastIndex, match.index);
    if (textBefore) stack[stack.length - 1].children.push({ type: 'text', value: textBefore });
    lastIndex = match.index + full.length;

    if (control === '#each') {
      const node = { type: 'each', path, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else if (control === '#if') {
      const node = { type: 'if', path, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else if (control === '/each' || control === '/if') {
      if (stack.length > 1) stack.pop(); // ueberschuessiges Schluss-Tag ohne passenden Anfang ignorieren
    } else {
      stack[stack.length - 1].children.push({ type: 'value', path });
    }
  }
  const trailing = template.slice(lastIndex);
  if (trailing) stack[stack.length - 1].children.push({ type: 'text', value: trailing });
  return root;
}

function renderNodes(nodes, data) {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      out += node.value;
    } else if (node.type === 'value') {
      const value = getPath(data, node.path);
      out += value === undefined || value === null ? '' : escapeHtml(value);
    } else if (node.type === 'if') {
      if (getPath(data, node.path)) out += renderNodes(node.children, data);
    } else if (node.type === 'each') {
      const arr = getPath(data, node.path);
      if (Array.isArray(arr)) {
        for (const item of arr) out += renderNodes(node.children, item);
      }
    }
  }
  return out;
}

function renderTemplate(htmlTemplate, data) {
  return renderNodes(parseTemplate(htmlTemplate).children, data);
}

function launchOptions() {
  const opts = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    opts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  return opts;
}

// Startet je Aufruf einen frischen Browser-Prozess statt eine Dauer-Instanz zu halten: ein
// PDF-Export ist eine seltene, admin-ausgeloeste Aktion (kein Hochlast-Pfad) - der ~0,5-1s
// Start-Overhead ist der bewusste Kompromiss gegen einen dauerhaft im RAM haengenden
// Chromium-Prozess auf einem ggf. kleinen Plesk-VPS (siehe README Verifikationsstand fuer
// gemessene Werte).
async function renderHtmlToPdf(htmlTemplate, data, pdfOptions = {}) {
  const html = renderTemplate(htmlTemplate, data);
  const browser = await chromium.launch(launchOptions());
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({
      format: 'A4',
      margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' },
      printBackground: true,
      ...pdfOptions,
    });
  } finally {
    await browser.close();
  }
}

module.exports = { renderTemplate, renderHtmlToPdf, escapeHtml };
