import { DatabaseSync, backup } from 'node:sqlite';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

const directory = resolve('data', 'backups');
await mkdir(directory, { recursive: true });
const target = resolve(directory, `samford-${new Date().toISOString().replaceAll(':', '-')}.sqlite`);
const source = new DatabaseSync(resolve('data', 'samford.sqlite'), { readOnly: true });
try { await backup(source, target); } finally { source.close(); }
const check = new DatabaseSync(target, { readOnly: true });
try {
  const result = check.prepare('PRAGMA integrity_check').all();
  if (result.length !== 1 || Object.values(result[0])[0] !== 'ok') throw new Error(`Backup integrity check failed. Preserve ${target} for investigation; do not promote.`);
} finally { check.close(); }
console.log(`Consistent SQLite online backup verified: ${target}`);
