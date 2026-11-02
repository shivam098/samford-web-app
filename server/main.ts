import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createApplication } from './app.js';
import { scheduledChecks } from './admin.js';
import { applicationVersion } from '../shared/version.js';
const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be 1024-65535.');
const assets = resolve(process.env.SAMFORD_ASSET_DIR ?? 'dist');
let manifest: { version: string };
try { manifest = JSON.parse(readFileSync(resolve(assets, 'build.json'), 'utf8')); }
catch { throw new Error('Matching candidate assets have not been deployed. Use Start-Candidate.ps1 for an isolated preview; do not overwrite the live dist while testers are active.'); }
if (manifest.version !== applicationVersion) throw new Error('Frontend/backend version mismatch. No database was opened.');
let runtime: ReturnType<typeof createApplication> | undefined;
let jobs: ReturnType<typeof setInterval> | undefined;
const server = createServer((req, res) => {
  if (runtime) runtime.app(req, res);
  else { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('The synthetic workspace is starting. Retry shortly.'); }
});
server.on('error', error => { console.error(`Server could not bind: ${error.message}. Database initialization was not started.`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  try { runtime = createApplication({ database: resolve(process.env.SAMFORD_DATA_DIR ?? 'data', 'samford.sqlite'), dist: assets }); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Startup failed; existing data was not reset.'); server.close(); process.exitCode = 1; return; }
  console.log(`Samford public synthetic demo ready: http://127.0.0.1:${port}`);
  console.log(`Version ${applicationVersion}. Loopback only. No live integrations. Public demo personas are not production authentication.`);
  jobs = setInterval(() => {
    try { if (runtime) scheduledChecks(runtime.store); }
    catch { console.error('Scheduled demo checks failed. Existing data was preserved; inspect job status and restart safely.'); }
  }, 30000);
});
function stop() { clearInterval(jobs); server.close(() => { runtime?.store.close(); process.exit(0); }); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
