const { createApp } = require('./app');
const config = require('./config');
const { startScheduler } = require('./scheduler');

const app = createApp();

app.listen(config.port, () => {
  console.log(`[server] EKats Backend laeuft auf ${config.baseUrl} (Port ${config.port}, env=${config.env})`);
  startScheduler();
});
