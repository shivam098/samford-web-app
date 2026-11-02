import { resolve } from 'node:path';
import { createApplication } from './app.js';
import { scheduledChecks } from './admin.js';
const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be 1024-65535.');
const { app, store } = createApplication({ database: resolve(process.env.SAMFORD_DATA_DIR ?? 'data', 'samford.sqlite') });
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Samford public synthetic demo ready: http://127.0.0.1:${port}`);
  console.log('Loopback only. No live integrations. Public demo personas are not production authentication.');
});
const jobs = setInterval(() => {
  try { scheduledChecks(store); }
  catch { console.error('Scheduled demo checks failed. Existing data was preserved; inspect job status and restart safely.'); }
}, 30000);
function stop() { clearInterval(jobs); server.close(() => { store.close(); process.exit(0); }); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
