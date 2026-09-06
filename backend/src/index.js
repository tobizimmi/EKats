const { createApp } = require('./app');
const config = require('./config');
const { startScheduler } = require('./scheduler');

const app = createApp();

app.listen(config.port, config.host, () => {
  console.log(
    `[server] EKats Backend laeuft auf http://${config.host}:${config.port} (extern via ${config.baseUrl}, env=${config.env})`
  );
  startScheduler();
});
