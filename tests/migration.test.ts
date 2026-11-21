import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, rmdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { Store } from '../server/store.js';
import { seed } from '../server/seed.js';
import { migrate, migrationSteps } from '../server/migrate.js';
import { text, type Data } from '../shared/model.js';

function fixture() {
  mkdirSync('test-artifacts', { recursive: true });
  const directory = mkdtempSync(join(resolve('test-artifacts'), 'migration-')); const path = join(directory, 'test.sqlite');
  return { directory, path, clean() { for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true }); rmdirSync(directory); } };
}
function state(db: DatabaseSync) {
  return {
    entities: db.prepare("SELECT id,body FROM entities WHERE type<>'account' ORDER BY id").all(),
    versions: db.prepare('SELECT id,version,body FROM entity_versions ORDER BY id,version').all(),
    credentials: db.prepare('SELECT id,credential FROM users ORDER BY id').all(),
    receipts: db.prepare('SELECT actor,operation,hash,body FROM receipts ORDER BY actor,operation').all(),
    audit: db.prepare('SELECT seq,body FROM audit ORDER BY seq').all(),
    sessions: db.prepare('SELECT token,body FROM sessions ORDER BY token').all()
  };
}
function preserved(db: DatabaseSync, before: ReturnType<typeof state>) {
  for (const row of before.entities) assert.equal(db.prepare('SELECT body FROM entities WHERE id=?').get(row.id!)?.body, row.body);
  for (const row of before.versions) assert.equal(db.prepare('SELECT body FROM entity_versions WHERE id=? AND version=?').get(row.id!, row.version!)?.body, row.body);
  for (const row of before.credentials) assert.equal(db.prepare('SELECT credential FROM users WHERE id=?').get(row.id!)?.credential, row.credential);
  for (const row of before.receipts) assert.deepEqual(db.prepare('SELECT actor,operation,hash,body FROM receipts WHERE actor=? AND operation=?').get(row.actor!, row.operation!), row);
  for (const row of before.audit) assert.equal(db.prepare('SELECT body FROM audit WHERE seq=?').get(row.seq!)?.body, row.body);
  assert.deepEqual(db.prepare('SELECT token,body FROM sessions ORDER BY token').all(), before.sessions);
}
test('v1 migration preserves original record/version/credential/receipt/audit bytes and is idempotent', () => {
  const f = fixture(); const store = new Store(f.path);
  try {
    seed(store);
    const before = state(store.db); migrate(store); preserved(store.db, before);
    assert.equal(store.setting('schemaVersion', 0), 3);
    assert.deepEqual(store.person('desk-cashier').roles, ['desk', 'cashier']);
    const after = state(store.db); const accounts = store.db.prepare("SELECT body FROM entities WHERE type='account' ORDER BY id").all();
    migrate(store); assert.deepEqual(state(store.db), after);
    assert.deepEqual(store.db.prepare("SELECT body FROM entities WHERE type='account' ORDER BY id").all(), accounts);
  } finally { store.close(); f.clean(); }
});
test('v2 database upgrades to v3 additively: original bytes kept, labs, personas and handwritten history added once', () => {
  const f = fixture(); const store = new Store(f.path);
  try {
    seed(store);
    store.transact(() => { migrationSteps.migrateToV2(store, 1); store.set('schemaVersion', 2); });
    const before = state(store.db); const users = store.db.prepare('SELECT id,body FROM users ORDER BY id').all();
    migrate(store); preserved(store.db, before);
    assert.equal(store.setting('schemaVersion', 0), 3);
    for (const row of users) {
      const now = JSON.parse(String(store.db.prepare('SELECT body FROM users WHERE id=?').get(row.id!)!.body)); const old = JSON.parse(String(row.body));
      if (['lab', 'verifier'].includes(String(row.id))) { delete now.labIds; assert.deepEqual(now, old); } else assert.deepEqual(now, old);
    }
    assert.deepEqual(store.person('lab').labIds, ['central-lab']); assert.deepEqual(store.person('verifier').labIds, ['central-lab', 'radiology']);
    assert.equal(store.person('doctor-c').role, 'doctor'); assert.deepEqual(store.person('radiology').labIds, ['radiology']);
    assert.deepEqual(store.all('labUnit').map(lab => text(lab.data, 'labId')).sort(), ['central-lab', 'radiology']);
    assert.equal(store.get('visit-history-a').status, 'Done'); assert.equal(store.get('visit-history-b').status, 'Done');
    assert.equal(store.all('handwrittenDocument').length, 6); assert.equal(store.all('investigationResult').filter(result => result.status === 'Released').length, 1);
    assert.equal(store.all('coding').length, 0, 'seeded history creates no coding work');
    const orphans = store.db.prepare('SELECT COUNT(*) AS n FROM blob_refs r LEFT JOIN blobs b ON b.sha256=r.sha256 WHERE b.sha256 IS NULL').get()!;
    assert.equal(Number(orphans.n), 0);
    assert.ok(store.audits().some(entry => entry.action === 'schema.migrate' && entry.target === 'v3'));
    const after = state(store.db); const events = store.db.prepare('SELECT COUNT(*) AS n FROM feed_events').get()!.n;
    migrate(store); assert.deepEqual(state(store.db), after); assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM feed_events').get()!.n, events);
  } finally { store.close(); f.clean(); }
});
test('pre-release blob reference tables gain indexed owner columns when opened', () => {
  const f = fixture(); const db = new DatabaseSync(f.path);
  db.exec('CREATE TABLE entities(id TEXT PRIMARY KEY, type TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE blob_refs(sha256 TEXT NOT NULL, document_entity_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(sha256, document_entity_id, role));');
  db.prepare('INSERT INTO entities VALUES(?,?,?)').run('doc-v1', 'handwrittenDocument', JSON.stringify({ id: 'doc-v1', patientId: 'patient-x', doctorId: 'doctor-x' }));
  db.prepare('INSERT INTO blob_refs VALUES(?,?,?)').run('a'.repeat(64), 'doc-v1', 'PAGE'); db.close();
  const store = new Store(f.path);
  try { assert.deepEqual({ ...store.db.prepare('SELECT patient_id, doctor_id FROM blob_refs').get() }, { patient_id: 'patient-x', doctor_id: 'doctor-x' }); }
  finally { store.close(); f.clean(); }
});
test('unsupported identities roll migration back, and newer databases are refused', () => {
  const f = fixture(); const store = new Store(f.path);
  try {
    seed(store); const actor = store.person('other-family'); actor.roles = ['doctor']; store.savePerson(actor);
    const before = state(store.db); const users = store.db.prepare('SELECT body FROM users ORDER BY id').all();
    const accounts = store.db.prepare("SELECT body FROM entities WHERE type='account' ORDER BY id").all();
    assert.throws(() => migrate(store), /unsupported role combination/);
    assert.deepEqual(state(store.db), before); assert.deepEqual(store.db.prepare('SELECT body FROM users ORDER BY id').all(), users);
    assert.deepEqual(store.db.prepare("SELECT body FROM entities WHERE type='account' ORDER BY id").all(), accounts);
    store.set('schemaVersion', 99); assert.throws(() => migrate(store), /newer app version/);
  } finally { store.close(); f.clean(); }
});
test('occupied-port startup fails before creating a database', async () => {
  const f = fixture(); const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const child = spawn(process.execPath, ['--import', 'tsx', 'server\\main.ts'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), SAMFORD_ASSET_DIR: resolve('dist-candidate'), SAMFORD_DATA_DIR: f.directory }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stderr.on('data', chunk => { output += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    assert.equal(code, 1); assert.match(output, /EADDRINUSE/); assert.equal(existsSync(join(f.directory, 'samford.sqlite')), false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); f.clean(); }
});
test('read-only online backup of the live v1 database migrates only its copy and leaves live assets unchanged', { skip: process.env.SAMFORD_LIVE_PROOF !== '1' }, async () => {
  const f = fixture(); let store: Store | undefined;
  const live = new DatabaseSync(resolve('data', 'samford.sqlite'), { readOnly: true });
  try { await backup(live, f.path); } finally { live.close(); }
  try {
    store = new Store(f.path); const before = state(store.db);
    assert.equal(store.setting('schemaVersion', 1), 1);
    migrate(store); preserved(store.db, before);
    const after = state(store.db); migrate(store); assert.deepEqual(state(store.db), after);
    const assets = JSON.parse(readFileSync('data\\live-asset-baseline.json', 'utf8')) as { assets: { Path: string; Hash: string }[] };
    for (const asset of assets.assets) assert.equal(createHash('sha256').update(readFileSync(join('dist', basename(asset.Path)))).digest('hex').toUpperCase(), asset.Hash);
    const health = await (await fetch('http://127.0.0.1:4317/api/health')).json();
    assert.equal(health.version, '0.1.0');
    const legacyClaims = store.all('claim').filter(claim => !claim.data.packageQuote).map(claim => ({ id: claim.id, status: claim.status, admissionId: text(claim.data, 'admissionId') }));
    const proof: Data = { generatedAt: new Date().toISOString(), liveVersion: health.version, migratedCopySchema: store.setting('schemaVersion', 0),
      originalRecordsPreserved: before.entities.length, originalVersionsPreserved: before.versions.length, originalCredentialsPreserved: before.credentials.length,
      originalReceiptsPreserved: before.receipts.length, originalAuditEntriesPreserved: before.audit.length, migrationRepeatedWithoutChanges: true,
      originalLiveAssetsUnchanged: assets.assets.length, legacyClaimsRequiringExplicitPackageReconciliation: legacyClaims };
    writeFileSync('test-artifacts\\migration-live-proof.json', JSON.stringify(proof, null, 2));
  } finally { store?.close(); f.clean(); }
});
