// Verifies an additive schema upgrade against a fresh pre-upgrade backup. Read-only on the shared database.
// Usage: node --import tsx scripts/verify-upgrade.ts --backup <backup.sqlite> --mode dry-run|live [--expect <dry-run proof.json>] [--out <proof.json>]
// dry-run: migrates a temporary copy and requires every original row to stay byte-identical, then runs the startup jobs on that
//          copy to predict exactly which records they will append System versions to after the real start.
// live:    compares the running database with the same backup. History rows must be byte-identical, current rows may only gain
//          newer versions, and with --expect every System update must have been predicted by the dry-run.
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { seed } from '../server/seed.js';
import { migrate } from '../server/migrate.js';
import { scheduledChecks } from '../server/admin.js';
import { schemaVersion } from '../shared/version.js';

type Row = Record<string, unknown>;
type Change = { type: string; id: string; updatedBy: string; newerVersion: boolean };
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index].replace(/^--/, ''), process.argv[index + 1] ?? '');
const backupPath = resolve(args.get('backup') ?? '');
const mode = args.get('mode') ?? 'dry-run';
if (!args.get('backup') || !['dry-run', 'live'].includes(mode)) throw new Error('Pass --backup <fresh backup> and --mode dry-run|live.');
const expected = args.get('expect') ? JSON.parse(readFileSync(resolve(args.get('expect')!), 'utf8')) as { checked?: { predictedStartupJobs?: { entityIds?: string[]; userStateChanges?: string[] } } } : null;
const failures: string[] = []; const notes: Record<string, unknown> = {};
const check = (condition: unknown, message: string) => { if (!condition) failures.push(message); };
const open = (path: string) => new DatabaseSync(path, { readOnly: true });
const tally = (items: string[]) => items.reduce<Record<string, number>>((counts, item) => ({ ...counts, [item]: (counts[item] ?? 0) + 1 }), {});

function entityChanges(before: DatabaseSync, after: DatabaseSync) {
  const missing: string[] = []; const changes: Change[] = [];
  const read = after.prepare('SELECT body FROM entities WHERE id=?');
  for (const row of before.prepare('SELECT id,type,body FROM entities ORDER BY id').all() as Row[]) {
    const current = read.get(String(row.id)) as Row | undefined;
    if (!current) { missing.push(String(row.id)); continue; }
    if (current.body === row.body) continue;
    const now = JSON.parse(String(current.body)); const old = JSON.parse(String(row.body));
    changes.push({ type: String(row.type), id: String(row.id), updatedBy: String(now.updatedBy ?? ''), newerVersion: Number(now.version) > Number(old.version) });
  }
  return { missing, changes, originals: (before.prepare('SELECT COUNT(*) AS n FROM entities').get() as Row).n };
}
// Users carry no version history. The v3 migration adds lab assignments; startup jobs may only change the account state.
function userChanges(before: DatabaseSync, after: DatabaseSync) {
  const problems: string[] = []; const labAssignments: string[] = []; const stateChanges: string[] = [];
  const read = after.prepare('SELECT body,credential FROM users WHERE id=?');
  const users = before.prepare('SELECT id,body,credential FROM users').all() as Row[];
  for (const row of users) {
    const current = read.get(String(row.id)) as Row | undefined;
    if (!current) { problems.push(`Original user missing: ${String(row.id)}`); continue; }
    if (current.credential !== row.credential) problems.push(`Original credential changed: ${String(row.id)}`);
    const old = JSON.parse(String(row.body)); const now = JSON.parse(String(current.body));
    if (now.labIds && !old.labIds && old.role === 'lab') { labAssignments.push(String(row.id)); delete now.labIds; }
    if (old.state !== now.state) { stateChanges.push(`${String(row.id)}:${String(old.state)}->${String(now.state)}`); now.state = old.state; }
    if (JSON.stringify(old) !== JSON.stringify(now)) problems.push(`Original user fields changed: ${String(row.id)}`);
  }
  return { problems, labAssignments, stateChanges, originals: users.length };
}
function insertOnlyTables(before: DatabaseSync, after: DatabaseSync, tables: [string, string][]) {
  for (const [table, key] of tables) {
    const columns = key.split(','); const read = after.prepare(`SELECT * FROM ${table} WHERE ${columns.map(column => `${column}=?`).join(' AND ')}`);
    const rows = before.prepare(`SELECT * FROM ${table}`).all() as Row[];
    let changed = 0;
    for (const row of rows) {
      const current = read.get(...columns.map(column => row[column] as string | number)) as Row | undefined;
      if (!current || JSON.stringify({ ...current }) !== JSON.stringify({ ...row })) changed++;
    }
    check(changed === 0, `${changed} original ${table} row(s) changed or disappeared`);
    notes[`original_${table}`] = rows.length;
  }
}
const setting = (db: DatabaseSync, key: string) => { const row = db.prepare('SELECT body FROM settings WHERE key=?').get(key) as Row | undefined; return row ? JSON.parse(String(row.body)) : undefined; };

let workingDirectory = '';
let afterPath = resolve('data', 'samford.sqlite');
if (mode === 'dry-run') {
  workingDirectory = mkdtempSync(join(tmpdir(), 'samford-upgrade-'));
  afterPath = join(workingDirectory, 'samford.sqlite');
  const source = open(backupPath);
  try { await sqliteBackup(source, afterPath); } finally { source.close(); }
  const store = new Store(afterPath);
  try { seed(store); migrate(store); } finally { store.close(); }
}
const before = open(backupPath);
let after = open(afterPath);
try {
  for (const [name, db] of [['backup', before], ['after', after]] as const) {
    const rows = db.prepare('PRAGMA integrity_check').all() as Row[];
    check(rows.length === 1 && Object.values(rows[0])[0] === 'ok', `${name}: SQLite integrity check failed`);
  }
  notes.priorSchema = setting(before, 'schemaVersion') ?? 1; notes.afterSchema = setting(after, 'schemaVersion');
  check(notes.afterSchema === schemaVersion, `Expected schema ${schemaVersion} after the upgrade, found ${String(notes.afterSchema)}`);

  const entities = entityChanges(before, after);
  notes.originalRecords = entities.originals;
  check(entities.missing.length === 0, `Original records missing: ${entities.missing.join(', ')}`);
  const overwritten = entities.changes.filter(change => !change.newerVersion);
  if (mode === 'live') check(overwritten.length === 0, `Original records overwritten without a newer version: ${overwritten.map(change => change.id).join(', ')}`);
  const versions = before.prepare('SELECT id,version,body FROM entity_versions').all() as Row[];
  const readVersion = after.prepare('SELECT body FROM entity_versions WHERE id=? AND version=?');
  const changedVersions = versions.filter(row => (readVersion.get(String(row.id), Number(row.version)) as Row | undefined)?.body !== row.body);
  check(changedVersions.length === 0, `Original version rows changed: ${changedVersions.slice(0, 20).map(row => `${String(row.id)} v${String(row.version)}`).join(', ')}`);
  notes.originalVersionsByteIdentical = versions.length - changedVersions.length;

  const users = userChanges(before, after);
  failures.push(...users.problems);
  notes.originalUsersAndCredentials = users.originals; notes.labAssignmentsAdded = users.labAssignments;
  insertOnlyTables(before, after, [['receipts', 'actor,operation'], ['audit', 'seq']]);
  const sessions = before.prepare('SELECT token,body FROM sessions').all() as Row[];
  const readSession = after.prepare('SELECT body FROM sessions WHERE token=?');
  const sessionState = sessions.map(row => { const current = readSession.get(String(row.token)) as Row | undefined; return !current ? 'ended' : current.body === row.body ? 'unchanged' : 'refreshed'; });
  notes.originalSessions = tally(sessionState);

  if (mode === 'dry-run') {
    check(entities.changes.length === 0, `The migration changed original records: ${entities.changes.map(change => change.id).join(', ')}`);
    check(users.stateChanges.length === 0, `The migration changed account states: ${users.stateChanges.join(', ')}`);
    check(sessionState.every(state => state === 'unchanged'), 'The migration changed sign-in sessions');
  }
  const added = after.prepare('SELECT type, COUNT(*) AS n FROM entities GROUP BY type').all() as Row[];
  const beforeCounts = new Map((before.prepare('SELECT type, COUNT(*) AS n FROM entities GROUP BY type').all() as Row[]).map(row => [String(row.type), Number(row.n)]));
  notes.addedRecordsByType = Object.fromEntries(added.map(row => [String(row.type), Number(row.n) - (beforeCounts.get(String(row.type)) ?? 0)]).filter(([, count]) => Number(count) > 0));
  const v3 = (after.prepare("SELECT body FROM audit ORDER BY seq DESC").all() as Row[]).map(row => JSON.parse(String(row.body))).find(entry => entry.action === 'schema.migrate' && entry.target === 'v3');
  notes.migrationAudit = v3?.after ?? null;
  check(v3, 'The v3 migration audit entry is missing');

  if (mode === 'dry-run') {
    // Run the same startup jobs the server runs after migrating, on the copy, to predict their System versions.
    after.close();
    const store = new Store(afterPath);
    try { scheduledChecks(store); } finally { store.close(); }
    after = open(afterPath);
    const jobs = entityChanges(before, after); const jobUsers = userChanges(before, after);
    const unexpected = jobs.changes.filter(change => !change.newerVersion || change.updatedBy !== 'System');
    check(unexpected.length === 0, `Startup jobs changed records outside System versions: ${unexpected.map(change => change.id).join(', ')}`);
    failures.push(...jobUsers.problems.map(problem => `Startup jobs: ${problem}`));
    notes.predictedStartupJobs = { byType: tally(jobs.changes.map(change => change.type)), entityIds: jobs.changes.map(change => change.id), userStateChanges: jobUsers.stateChanges };
  } else {
    const system = entities.changes.filter(change => change.newerVersion && change.updatedBy === 'System');
    const activity = entities.changes.filter(change => change.newerVersion && change.updatedBy !== 'System');
    notes.systemVersionsSinceBackup = { byType: tally(system.map(change => change.type)), entityIds: system.map(change => change.id) };
    notes.userActivitySinceBackup = tally(activity.map(change => `${change.type} by ${change.updatedBy}`));
    notes.userStateChanges = users.stateChanges;
    if (expected) {
      const predicted = new Set(expected.checked?.predictedStartupJobs?.entityIds ?? []);
      const unpredicted = system.filter(change => !predicted.has(change.id));
      check(unpredicted.length === 0, `System versions the dry-run did not predict (a scheduled boundary such as 22:00 IST may have passed): ${unpredicted.map(change => change.id).join(', ')}`);
      const predictedStates = new Set(expected.checked?.predictedStartupJobs?.userStateChanges ?? []);
      const unpredictedStates = users.stateChanges.filter(change => !predictedStates.has(change));
      check(unpredictedStates.length === 0, `Account state changes the dry-run did not predict: ${unpredictedStates.join(', ')}`);
    }
  }
  const proof = { verifiedAt: new Date().toISOString(), mode, status: failures.length ? 'FAIL - preserve data and investigate before any rollback' : 'PASS', backupPath, checked: notes, failures,
    note: mode === 'dry-run' ? 'The migration ran on a copy of the fresh backup and every original row stayed byte-identical. The startup jobs were then run on the copy to predict the System versions the real start will append.'
      : `Read-only comparison of the live database with the fresh backup after startup. Every original version row is byte-identical and current rows only gained newer versions.${expected ? ' Every System version was predicted by the dry-run.' : ''}` };
  const out = args.get('out'); if (out) writeFileSync(out, JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  before.close(); after.close();
  if (workingDirectory) rmSync(workingDirectory, { recursive: true, force: true });
}
