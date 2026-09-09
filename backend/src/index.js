const { createApp } = require('./app');
const config = require('./config');
const { startScheduler } = require('./scheduler');
const { startBlitzortungStream } = require('./fetchers/blitzortung');

config.assertSafeToStart();

const app = createApp();

app.listen(config.port, config.host, () => {
  console.log(
    `[server] EKats Backend laeuft auf http://${config.host}:${config.port} (extern via ${config.baseUrl}, env=${config.env})`
  );
  startScheduler();
  // Kein Cron-Job wie die uebrigen Quellen (siehe fetchers/blitzortung.js) - eine dauerhaft offene
  // WebSocket-Verbindung, einmal beim Start aufgebaut statt periodisch neu verbunden.
  startBlitzortungStream();
});
