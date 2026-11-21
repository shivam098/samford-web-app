// Isolated single-node load test for the mock backend. Never touches data/ (the shared demo database).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, cpus, totalmem, platform, release } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';
import { seed } from '../server/seed.js';
import { migrate } from '../server/migrate.js';
import { syntheticDocument } from '../server/fixtures.js';
import { storeTrustedBlob, mediaTypes } from '../server/blobs.js';
import { canonicalJson, sha256Text } from '../server/handwriting.js';
import { tokenHashOf, deviceEntityId } from '../server/mobile-auth.js';
import { istDate, type Actor, type Data, type Entity, type Json } from '../shared/model.js';
import { applicationVersion } from '../shared/version.js';

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index].replace(/^--/, ''), process.argv[index + 1] ?? '');
const patientCount = Number(args.get('patients') ?? 100000);
const doctorCount = Number(args.get('doctors') ?? 50);
const port = Number(args.get('port') ?? 4330);
const scale = Number(args.get('scale') ?? 1);
if (port === 4317) throw new Error('Never use the shared demo port.');
const directory = mkdtempSync(join(tmpdir(), 'samford-load-'));
if (resolve(directory).startsWith(resolve('data'))) throw new Error('Refusing to use the shared data directory.');
const database = join(directory, 'samford.sqlite');
let random = 0x2f6b1d3; const next = () => { random = (Math.imul(random ^ (random >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; return random / 4294967296; };
const pick = <T>(list: T[]) => list[Math.floor(next() * list.length)];
const log = (message: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

// ---------- Seeding (direct bulk inserts into an isolated SQLite database) ----------
const seedStarted = performance.now();
const store = new Store(database);
seed(store); migrate(store);
const now = store.now(); const today = istDate(now);
const insertEntity = store.db.prepare('INSERT INTO entities(id,type,body) VALUES(?,?,?)');
const insertVersion = store.db.prepare('INSERT INTO entity_versions VALUES(?,?,?)');
const insertEvent = store.db.prepare('INSERT INTO feed_events(audience,type,at,body) VALUES(?,?,?,?)');
const insertRef = store.db.prepare('INSERT OR IGNORE INTO blob_refs(sha256, document_entity_id, role, patient_id, doctor_id) VALUES(?,?,?,?,?)');
const insertUser = store.db.prepare('INSERT INTO users VALUES(?,?,?)');
const insertToken = store.db.prepare('INSERT INTO mobile_tokens(token_hash, kind, actor_id, device_id, mobile, created_at, expires_at, last_used_at, revoked_at) VALUES(?,?,?,?,?,?,?,?,NULL)');
const put = (entity: Entity) => { const body = JSON.stringify(entity); insertEntity.run(entity.id, entity.type, body); insertVersion.run(entity.id, entity.version, body); };
const entity = (id: string, type: string, status: string, data: Data, extra: Partial<Entity> = {}, at = now, by = 'System'): Entity =>
  ({ id, type, version: 1, status, createdAt: at, updatedAt: at, createdBy: by, updatedBy: by, data, ...extra });
const event = (audience: string, type: string, at: string, body: Data) => insertEvent.run(audience, type, at, JSON.stringify(body));
const batch = (work: () => void) => { store.db.exec('BEGIN'); try { work(); store.db.exec('COMMIT'); } catch (error) { store.db.exec('ROLLBACK'); throw error; } };

log('Generating synthetic page templates');
type Template = { pages: { index: number; pngSha256: string; widthPx: number; heightPx: number }[]; pdfSha256: string; inkSha256: string };
const templates = (kind: 'summary' | 'prescription' | 'investigations', count: number, pages: number): Template[] => Array.from({ length: count }, (_, variant) => {
  const doc = syntheticDocument(`load-${kind}-${variant}`, kind, pages, kind);
  return { pages: doc.pages.map((page, index) => ({ index, pngSha256: storeTrustedBlob(store, mediaTypes.png, page.png, 'load-test', { width: page.width, height: page.height }), widthPx: page.width, heightPx: page.height })),
    pdfSha256: storeTrustedBlob(store, mediaTypes.pdf, doc.pdf, 'load-test'), inkSha256: storeTrustedBlob(store, mediaTypes.ink, doc.ink, 'load-test') };
});
const summaries = templates('summary', 3, 2); const prescriptions = templates('prescription', 3, 1); const investigations = templates('investigations', 2, 1);

log(`Seeding ${doctorCount} doctors`);
const doctors: { id: string; token: string; device: string }[] = [];
batch(() => {
  for (let index = 1; index <= doctorCount; index++) {
    const id = `load-doctor-${String(index).padStart(3, '0')}`; const device = `load-tablet-${index}`;
    const actor: Actor = { id, name: `Synthetic load doctor ${index}`, role: 'doctor', roles: ['doctor'], department: 'general', state: 'Active', login: id, staffId: id.toUpperCase(),
      mobile: `70000${String(index).padStart(5, '0')}`, patientIds: [], verifier: false, profileConfirmed: true, temporary: false, counter: 'OPD 1', appVersion: 1, preferences: {} };
    insertUser.run(id, JSON.stringify(actor), '{}');
    put(entity(id, 'account', 'Active', { name: actor.name, role: 'doctor', roles: ['doctor'], departmentId: 'general', registration: `SAMPLE-REG-${id}`, qualification: 'Sample qualification', room: `Room ${index}` }, { department: 'general' }));
    put(entity(deviceEntityId(id, device), 'device', 'Active', { name: `${actor.name} - load tablet`, actorId: id, deviceId: device, appVersion: 1, lastSync: now, unsent: 0, kind: 'Doctor tablet (Android)' }, { department: 'general' }, now, id));
    const token = `smp_load_${randomBytes(24).toString('base64url')}`;
    insertToken.run(tokenHashOf(token), 'DOCTOR', id, device, actor.mobile, now, new Date(Date.parse(now) + 7 * 86400000).toISOString(), now);
    doctors.push({ id, token, device });
  }
});

log(`Seeding ${patientCount} patients, families, tokens and history`);
type Family = { mobile: string; id: string; token: string; device: string; patients: string[]; withHistory: string[]; blobs: string[] };
const families: Family[] = [];
let patientIndex = 0; let documents = 0; let deliveries = 0; let events = 0; let historyVisits = 0;
const signedVersion = (documentId: string, visit: Entity, doctorId: string, type: string, title: string, template: Template, routing: Data, at: string): Entity => {
  const data = { documentId, version: 1, visitId: visit.id, type, typeLabel: title, title, name: `${title} v1`, pages: template.pages, pdfSha256: template.pdfSha256, inkSha256: template.inkSha256,
    inkFormat: 'samford-ink-placeholder/0', routing, hints: null, signedAt: at, receivedAt: at, reason: null, authorName: `Synthetic ${doctorId}`, previousRecordHash: null, supersedes: null } as Data;
  data.recordHash = sha256Text(canonicalJson({ schema: 'samford-record/1', documentId, version: 1, visitId: visit.id, patientId: visit.patientId, doctorId, type, title, pages: template.pages,
    pdfSha256: template.pdfSha256, inkSha256: template.inkSha256, inkFormat: 'samford-ink-placeholder/0', routing, hints: null, signedAt: at, receivedAt: at, reason: null, previousRecordHash: null }));
  const version = entity(`${documentId}-v1`, 'handwrittenDocument', 'Signed', data, { patientId: visit.patientId, doctorId, department: 'general' }, at, doctorId);
  put(version);
  for (const page of template.pages) insertRef.run(page.pngSha256, version.id, 'PAGE', visit.patientId!, doctorId);
  insertRef.run(template.pdfSha256, version.id, 'PDF', visit.patientId!, doctorId); insertRef.run(template.inkSha256, version.id, 'INK', visit.patientId!, doctorId);
  documents++; return version;
};
const delivery = (version: Entity, kind: string, name: string, state: string, at: string) => {
  put(entity(`${version.id}-${kind.toLowerCase()}`, 'handwritingDelivery', state === 'DISPENSED' ? 'Dispensed' : state === 'VIEWED' ? 'Viewed' : 'Available', {
    documentId: version.data.documentId as Json, version: 1, versionEntityId: version.id, visitId: version.data.visitId as Json, docType: version.data.type as Json, title: version.data.title as Json,
    recipient: kind, labId: null, recipientName: name, name: `${version.data.title} - ${name}`, state, note: '', history: [{ state, at, by: 'load-test' }] }, { patientId: version.patientId, doctorId: version.doctorId, department: 'general' }, at));
  deliveries++;
};
const familySizes = [1, 1, 1, 1, 1, 1, 2, 2, 2, 3];
let pending = 0;
store.db.exec('BEGIN');
while (patientIndex < patientCount) {
  const familyNumber = families.length + 1; const mobile = `8${String(familyNumber).padStart(9, '0')}`;
  const size = Math.min(pick(familySizes), patientCount - patientIndex); const family: Family = { mobile, id: `load-family-${familyNumber}`, token: `smp_load_${randomBytes(24).toString('base64url')}`, device: `load-phone-${familyNumber}`, patients: [], withHistory: [], blobs: [] };
  for (let member = 0; member < size; member++) {
    const id = `load-patient-${String(++patientIndex).padStart(6, '0')}`;
    put(entity(id, 'patient', 'Active', { name: `Synthetic load patient ${patientIndex}`, age: 1 + Math.floor(next() * 85), sex: pick(['Female', 'Male']), mobile, payer: 'Self', address: 'Sample district', category: 'General',
      uhid: `LOAD-${String(patientIndex).padStart(6, '0')}`, aadhaarLast4: '', allergyVersion: 0, mlc: false, unknown: false }));
    family.patients.push(id);
    if (next() < 0.4) {
      const doctorId = pick(doctors).id; const daysAgo = 1 + Math.floor(next() * 180);
      const at = new Date(Date.parse(now) - daysAgo * 86400000).toISOString(); const visitId = `load-visit-${patientIndex}`;
      const visit = entity(visitId, 'visit', 'Done', { number: `OPD-LOAD-${patientIndex}`, name: `History ${patientIndex}`, date: istDate(at), time: '10:00', token: 1 + Math.floor(next() * 40), mode: 'Walk-in', opdType: 'General',
        visitType: 'New', room: 'Room 1', priority: false, checkinAt: at, openedAt: at, firstDoneAt: at, completedAt: at, calls: 1, moves: [], source: 'Load-test history' }, { patientId: id, doctorId, department: 'general' }, at, doctorId);
      put(visit); historyVisits++;
      const summary = signedVersion(`load-doc-${patientIndex}-s`, visit, doctorId, 'VISIT_SUMMARY', 'Visit summary', pick(summaries), { pharmacy: false, labs: [], patient: true }, at);
      const rx = signedVersion(`load-doc-${patientIndex}-r`, visit, doctorId, 'PRESCRIPTION', 'Prescription', pick(prescriptions), { pharmacy: true, labs: [], patient: true }, at);
      delivery(summary, 'PATIENT', 'Patient app', next() < 0.6 ? 'VIEWED' : 'AVAILABLE', at); delivery(rx, 'PHARMACY', 'Hospital pharmacy', 'DISPENSED', at); delivery(rx, 'PATIENT', 'Patient app', 'AVAILABLE', at);
      const base = { visitId, patientId: id };
      event(`patient:${id}`, 'VISIT_UPDATED', at, { message: 'Your visit is complete.', ...base, documentId: null, data: { status: 'COMPLETED' } });
      for (const version of [summary, rx]) {
        event(`patient:${id}`, 'DOCUMENT_AVAILABLE', at, { message: 'A new document from your visit is ready to view.', ...base, documentId: version.data.documentId as Json, data: { version: 1 }, notify: { title: 'New document', body: 'A new document from your hospital visit is ready to view.' } });
        event(`doctor:${doctorId}`, 'DOCUMENT_SIGNED', at, { message: 'Signed.', ...base, documentId: version.data.documentId as Json, data: { version: 1 } });
      }
      event(`patient:${id}`, 'DOCUMENT_STATE_CHANGED', at, { message: 'The hospital pharmacy dispensed your prescription.', ...base, documentId: rx.data.documentId as Json, data: { state: 'DISPENSED', recipientKind: 'PHARMACY' }, notify: { title: 'Prescription dispensed', body: 'The hospital pharmacy dispensed your prescription.' } });
      event(`doctor:${doctorId}`, 'DOCUMENT_STATE_CHANGED', at, { message: 'Dispensed.', ...base, documentId: rx.data.documentId as Json, data: { state: 'DISPENSED', recipientKind: 'PHARMACY' } });
      events += 7; family.withHistory.push(id); family.blobs.push(...(summary.data.pages as Data[]).map(page => String(page.pngSha256)), String(rx.data.pdfSha256));
    }
  }
  const actor: Actor = { id: family.id, name: 'Synthetic load family', role: 'patient', roles: ['patient'], department: 'general', state: 'Active', login: family.id, staffId: family.id, mobile,
    patientIds: family.patients, verifier: false, profileConfirmed: true, temporary: false, counter: 'Online', appVersion: 1, preferences: {} };
  insertUser.run(family.id, JSON.stringify(actor), '{}');
  insertToken.run(tokenHashOf(family.token), 'PATIENT', family.id, family.device, mobile, now, new Date(Date.parse(now) + 90 * 86400000).toISOString(), now);
  families.push(family);
  if (++pending >= 2000) { store.db.exec('COMMIT'); store.db.exec('BEGIN'); pending = 0; }
}
store.db.exec('COMMIT');

log('Seeding today\'s queues');
const completions: { doctor: typeof doctors[number]; visitId: string }[] = [];
batch(() => {
  for (const doctor of doctors) for (let slot = 1; slot <= 35; slot++) {
    const patientId = `load-patient-${String(1 + Math.floor(next() * patientCount)).padStart(6, '0')}`;
    const consulting = slot <= 5; const id = `load-today-${doctor.id}-${slot}`;
    put(entity(id, 'visit', consulting ? 'In consultation' : 'Waiting', { number: `OPD-${id}`, name: `${today} slot ${slot}`, date: today, time: `${String(9 + Math.floor(slot / 6)).padStart(2, '0')}:${String((slot % 6) * 10).padStart(2, '0')}`,
      token: slot, mode: 'Walk-in', opdType: 'General', visitType: 'New', room: 'Room 1', priority: false, checkinAt: now, ...(consulting ? { openedAt: now, identityConfirmed: true } : {}), calls: 0, moves: [] }, { patientId, doctorId: doctor.id, department: 'general' }));
    if (consulting) completions.push({ doctor, visitId: id });
  }
});
store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const counts: Record<string, number> = Object.fromEntries(['patient', 'visit', 'handwrittenDocument', 'handwritingDelivery'].map(type => [type, store.count(type)]));
const feedRows = Number(store.db.prepare('SELECT COUNT(*) AS n FROM feed_events').get()!.n);
store.close();
const seedSeconds = (performance.now() - seedStarted) / 1000;
const databaseBytes = readdirSync(directory).filter(name => name.startsWith('samford.sqlite')).reduce((sum, name) => sum + statSync(join(directory, name)).size, 0);
log(`Seeded in ${seedSeconds.toFixed(1)} s: ${JSON.stringify(counts)}, ${feedRows} feed events, ${families.length} families, database ${(databaseBytes / 1048576).toFixed(0)} MiB`);

// ---------- Server under test: the real isolated backend in its own process, production rate limits ----------
writeFileSync(join(directory, '.samford-isolated'), 'Created by scripts/load-test.ts.\n');
const server = spawn(process.execPath, ['--import', 'tsx', 'scripts/mobile-isolated.ts', '--port', String(port), '--data', directory], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', chunk => { serverLog += chunk; }); server.stderr.on('data', chunk => { serverLog += chunk; });
const base = `http://127.0.0.1:${port}/api/mobile/v1`;
const startupBegan = performance.now();
for (let attempt = 0; ; attempt++) {
  try { if ((await fetch(`${base}/meta`)).ok) break; } catch { /* starting */ }
  if (attempt > 600) throw new Error(`Server did not start: ${serverLog}`);
  await new Promise(done => setTimeout(done, 250));
}
const startupSeconds = (performance.now() - startupBegan) / 1000;
log(`Server ready in ${startupSeconds.toFixed(1)} s`);

type Result = { name: string; requests: number; concurrency: number; seconds: number; rps: number; p50: number; p95: number; p99: number; max: number; statuses: Record<string, number>; megabytes: number };
async function run(name: string, requests: number, concurrency: number, send: (index: number) => Promise<{ status: number; bytes: number }>): Promise<Result> {
  const latencies: number[] = []; const statuses = new Map<number, number>(); let bytes = 0; let cursor = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = cursor++; if (index >= requests) return;
      const begin = performance.now(); let reply: { status: number; bytes: number };
      try { reply = await send(index); } catch { reply = { status: 0, bytes: 0 }; }
      latencies.push(performance.now() - begin); statuses.set(reply.status, (statuses.get(reply.status) ?? 0) + 1); bytes += reply.bytes;
    }
  }));
  const seconds = (performance.now() - started) / 1000; latencies.sort((a, b) => a - b);
  const at = (q: number) => Number(latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))].toFixed(1));
  const result = { name, requests, concurrency, seconds: Number(seconds.toFixed(2)), rps: Number((requests / seconds).toFixed(1)), p50: at(0.5), p95: at(0.95), p99: at(0.99), max: Number(latencies.at(-1)!.toFixed(1)),
    statuses: Object.fromEntries([...statuses].map(([status, count]) => [String(status), count])), megabytes: Number((bytes / 1048576).toFixed(1)) };
  log(`${name}: ${result.rps} req/s, p50 ${result.p50} ms, p95 ${result.p95} ms, p99 ${result.p99} ms, statuses ${JSON.stringify(result.statuses)}`);
  return result;
}
const request = async (path: string, token: string, device: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
  const response = await fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { Authorization: `Bearer ${token}`, 'X-Device-Id': device, ...(init.headers ?? {}) }, body: init.body });
  const body = Buffer.from(await response.arrayBuffer());
  return { status: response.status, bytes: body.length, body, etag: response.headers.get('etag') ?? '' };
};
const results: Result[] = [];
const n = (value: number) => Math.max(1, Math.round(value * scale));
const pollState = new Map<string, { etag: string; cursor: string }>();
results.push(await run('Patient notifications, first poll (200)', n(5000), 50, async index => {
  const family = families[index % families.length];
  const reply = await request('/patient/notifications', family.token, family.device);
  const page = JSON.parse(reply.body.toString()); pollState.set(family.id, { etag: reply.etag, cursor: page.nextCursor });
  return reply;
}));
const polled = families.slice(0, Math.min(families.length, n(5000)));
// Unmeasured: a real client keeps the ETag of the page at its newest cursor, so steady-state polls revalidate that page.
for (let start = 0; start < polled.length; start += 100) await Promise.all(polled.slice(start, start + 100).map(async family => {
  const state = pollState.get(family.id)!; const reply = await request(`/patient/notifications?cursor=${state.cursor}`, family.token, family.device);
  pollState.set(family.id, { etag: reply.etag, cursor: JSON.parse(reply.body.toString()).nextCursor });
}));
results.push(await run('Patient notifications, background re-poll (304)', n(20000), 100, async index => {
  const family = polled[index % polled.length]; const state = pollState.get(family.id)!;
  return request(`/patient/notifications?cursor=${state.cursor}`, family.token, family.device, { headers: { 'If-None-Match': state.etag } });
}));
const historyFamilies = families.filter(family => family.withHistory.length);
results.push(await run('Patient profile feed page (limit 100)', n(5000), 50, async index => {
  const family = historyFamilies[index % historyFamilies.length];
  return request(`/patient/profiles/${family.withHistory[0]}/feed?limit=100`, family.token, family.device);
}));
results.push(await run('Patient profile record (signed URLs)', n(5000), 50, async index => {
  const family = historyFamilies[(index * 7) % historyFamilies.length];
  return request(`/patient/profiles/${family.withHistory[0]}/record`, family.token, family.device);
}));
results.push(await run('Patient blob read (bearer, page PNG or PDF)', n(3000), 50, async index => {
  const family = historyFamilies[(index * 13) % historyFamilies.length];
  return request(`/blobs/${family.blobs[index % family.blobs.length]}`, family.token, family.device);
}));
results.push(await run('Doctor queue (35 entries, returning flags)', n(1000), 20, async index => {
  const doctor = doctors[index % doctors.length];
  return request('/doctor/queue', doctor.token, doctor.device);
}));
const bundles = completions.map(({ doctor, visitId }) => {
  const bundleId = randomUUID();
  const document = (type: string, title: string, template: Template, routing: Data) => ({ clientDocId: randomUUID(), type, title, pages: template.pages, pdfSha256: template.pdfSha256, inkSha256: template.inkSha256,
    inkFormat: 'samford-ink-placeholder/0', routing, signedAt: new Date().toISOString() });
  return { doctor, visitId, bundleId, body: JSON.stringify({ bundleId, completedAt: new Date().toISOString(), documents: [
    document('VISIT_SUMMARY', 'Visit summary', summaries[0], { pharmacy: false, labs: [], patient: true }),
    document('PRESCRIPTION', 'Prescription', prescriptions[0], { pharmacy: true, labs: [], patient: true }),
    document('INVESTIGATIONS', 'Investigations', investigations[0], { pharmacy: false, labs: ['central-lab'], patient: true })] }) };
});
const complete = (bundle: typeof bundles[number]) => request(`/doctor/visits/${bundle.visitId}/complete`, bundle.doctor.token, bundle.doctor.device,
  { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': bundle.bundleId }, body: bundle.body });
const firstRound = bundles.filter((_, index) => index % 5 === 0);
results.push(await run(`Doctor visit completion, ${firstRound.length} doctors at once (3 documents each)`, firstRound.length, firstRound.length, async index => complete(firstRound[index])));
const rest = bundles.filter((_, index) => index % 5 !== 0);
const mixedPolls = run('Patient 304 re-polls during the completion burst', n(10000), 100, async index => {
  const family = polled[(index * 3) % polled.length]; const state = pollState.get(family.id)!;
  return request(`/patient/notifications?cursor=${state.cursor}`, family.token, family.device, { headers: { 'If-None-Match': state.etag } });
});
const burst = run(`Doctor visit completion, remaining ${rest.length} bundles with patient polling in parallel`, rest.length, 50, async index => complete(rest[index]));
results.push(await burst, await mixedPolls);
results.push(await run('Completion replay with the same Idempotency-Key', bundles.length, 50, async index => complete(bundles[index])));
if (results.some(result => result.statuses['0'])) console.error(serverLog.slice(-4000));
server.kill('SIGTERM');
await new Promise(done => server.once('exit', done));

const check = new DatabaseSync(database, { readOnly: true });
const todayDocuments = Number(check.prepare("SELECT COUNT(*) AS n FROM entities WHERE type='handwrittenDocument' AND json_extract(body,'$.data.visitId') LIKE 'load-today-%'").get()!.n);
const doneVisits = Number(check.prepare("SELECT COUNT(*) AS n FROM entities WHERE type='visit' AND id LIKE 'load-today-%' AND json_extract(body,'$.status')='Done'").get()!.n);
check.close();
const finalBytes = readdirSync(directory).filter(name => name.startsWith('samford.sqlite')).reduce((sum, name) => sum + statSync(join(directory, name)).size, 0);
const report = {
  generatedAt: new Date().toISOString(), serverVersion: applicationVersion, sha: process.env.GIT_SHA ?? '',
  machine: { cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, memoryGiB: Number((totalmem() / 1073741824).toFixed(1)), os: `${platform()} ${release()}`, node: process.version },
  dataset: { ...counts, families: families.length, patientTokens: families.length, doctors: doctors.length, feedEvents: feedRows, historyVisits, seededDocuments: documents, seededDeliveries: deliveries, databaseMiB: Number((databaseBytes / 1048576).toFixed(0)), seedSeconds: Number(seedSeconds.toFixed(1)), serverStartupSeconds: Number(startupSeconds.toFixed(1)) },
  integrity: { completionsSubmitted: bundles.length, documentsCreatedToday: todayDocuments, expectedDocuments: bundles.length * 3, visitsCompleted: doneVisits, replaysCreatedDuplicates: todayDocuments !== bundles.length * 3, databaseMiBAfter: Number((finalBytes / 1048576).toFixed(0)) },
  limits: 'Production mobile limits were active (no --relaxed-limits): 600 requests/minute per token. The load client and server shared one machine.',
  results
};
mkdirSync('test-artifacts', { recursive: true });
writeFileSync('test-artifacts\\load-test-results.json', JSON.stringify(report, null, 2));
const table = results.map(result => `| ${result.name} | ${result.requests} | ${result.concurrency} | ${result.rps} | ${result.p50} | ${result.p95} | ${result.p99} | ${Object.entries(result.statuses).map(([status, count]) => `${status}: ${count}`).join(', ')} |`).join('\n');
writeFileSync('docs\\load-test-results.md', `# Isolated single-node load test (mock backend)

Generated ${report.generatedAt} by \`scripts/load-test.ts\` against server ${applicationVersion}. **This is single-node mock evidence on a developer machine, not a production capacity claim.** See [scale-design.md](scale-design.md) for the production design.

- Machine: ${report.machine.cpu}, ${report.machine.cores} logical cores, ${report.machine.memoryGiB} GiB RAM, ${report.machine.os}, Node ${report.machine.node}. Load client and server ran on the same machine.
- Dataset (isolated throwaway SQLite database, never the shared demo): ${counts.patient} patients in ${report.dataset.families} families with one patient-app token each, ${report.dataset.doctors} load doctors, ${report.dataset.historyVisits} earlier visits with ${report.dataset.seededDocuments} signed handwritten documents and ${report.dataset.seededDeliveries} deliveries, ${report.dataset.feedEvents} feed events. Database ${report.dataset.databaseMiB} MiB; seeding took ${report.dataset.seedSeconds} s and server start ${report.dataset.serverStartupSeconds} s.
- Limits: ${report.limits}
- Integrity: ${report.integrity.completionsSubmitted} bundles completed ${report.integrity.visitsCompleted} visits and created ${report.integrity.documentsCreatedToday} documents (expected ${report.integrity.expectedDocuments}); replays ${report.integrity.replaysCreatedDuplicates ? '**created duplicates**' : 'created no duplicates'}.

| Scenario | Requests | Concurrency | Requests/s | p50 ms | p95 ms | p99 ms | HTTP statuses |
|---|---:|---:|---:|---:|---:|---:|---|
${table}

Reading the numbers: background polling is dominated by the 304 path, which re-runs the authorization and feed query but sends no body. Blob reads come from SQLite in this mock; production serves immutable blobs from object storage through a CDN. Completion latency includes the atomic write of documents, deliveries, events and the idempotency record in one SQLite transaction.
`);
log('Wrote docs/load-test-results.md and test-artifacts/load-test-results.json');
if (!args.has('keep')) rmSync(directory, { recursive: true, force: true }); else log(`Kept ${directory}`);
if (report.integrity.replaysCreatedDuplicates || report.integrity.documentsCreatedToday !== report.integrity.expectedDocuments) process.exitCode = 1;
