import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { createApplication } from '../server/app.js';

const args = new Map<string, string | true>();
for (let index = 2; index < process.argv.length; index++) {
  const name = process.argv[index];
  if (!name.startsWith('--')) throw new Error(`Unexpected argument ${name}.`);
  const next = process.argv[index + 1];
  if (next && !next.startsWith('--')) { args.set(name.slice(2), next); index++; } else args.set(name.slice(2), true);
}
const port = Number(args.get('port') ?? 4320);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 4317) throw new Error('Choose a port from 1024-65535 other than the shared demo port 4317.');
const host = String(args.get('host') ?? '127.0.0.1');
if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('Use --host 127.0.0.1 (default) or --host 0.0.0.0.');
const data = resolve(String(args.get('data') ?? join(tmpdir(), `samford-isolated-${port}`)));
const marker = join(data, '.samford-isolated');
if (existsSync(data) && readdirSync(data).length && !existsSync(marker)) throw new Error(`${data} is not empty and was not created by this script. Choose a new directory.`);
if (resolve(data) === resolve('data')) throw new Error('Never point an isolated backend at the shared demo data directory.');
mkdirSync(data, { recursive: true });
writeFileSync(marker, 'Created by scripts/mobile-isolated.ts. Safe to delete with this directory.\n');
const database = join(data, 'samford.sqlite');
if (args.has('reset')) for (const suffix of ['', '-wal', '-shm']) rmSync(database + suffix, { force: true });
if (host === '0.0.0.0') console.warn('WARNING: listening on all interfaces. Use only on a trusted test network; this is a public synthetic demo without production authentication.');
const runtime = createApplication({
  database, dist: existsSync(join('dist-candidate', 'index.html')) ? 'dist-candidate' : undefined,
  relaxedLimits: args.has('relaxed-limits'), testSupport: args.has('test-support'), isolated: true
});
const server: Server = runtime.app.listen(port, host, () => {
  const local = `http://127.0.0.1:${port}`;
  const ready = { apiBaseUrl: `${local}/api/mobile/v1`, emulatorApiBaseUrl: `http://10.0.2.2:${port}/api/mobile/v1`, webUrl: `${local}/`, data, pid: process.pid, startedAt: new Date().toISOString(),
    relaxedLimits: args.has('relaxed-limits'), testSupport: args.has('test-support') };
  writeFileSync(join(data, 'ready.json'), JSON.stringify(ready, null, 2));
  console.log(`READY ${ready.apiBaseUrl} (emulator: ${ready.emulatorApiBaseUrl}) data=${data} pid=${process.pid}`);
});
server.on('error', error => { console.error(`Isolated backend could not start: ${error.message}`); runtime.store.close(); process.exit(1); });
const stop = () => server.close(() => { runtime.store.close(); process.exit(0); });
process.on('SIGINT', stop); process.on('SIGTERM', stop);
