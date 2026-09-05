// Manueller Einzelabruf zum Testen, z.B.: npm run fetch -- pegelonline
const { pool } = require('./db');
const { runJob, jobs } = require('./scheduler');

async function main() {
  const jobName = process.argv[2];
  if (!jobName || !jobs[jobName]) {
    console.error(`Bitte einen gueltigen Job angeben: ${Object.keys(jobs).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  await runJob(jobName, jobs[jobName]);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
