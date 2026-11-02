import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Actor, Data, Entity, Receipt } from '../shared/model.js';

export class DomainError extends Error {
  constructor(public status: number, public code: string, message: string, public current?: Entity) { super(message); }
}
export function requireThat(condition: unknown, message: string, code = 'VALIDATION_FAILED'): asserts condition {
  if (!condition) throw new DomainError(422, code, message);
}
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS entities(id TEXT PRIMARY KEY, type TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS entities_type ON entities(type);
      CREATE TABLE IF NOT EXISTS entity_versions(id TEXT, version INTEGER, body TEXT, PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, body TEXT NOT NULL, credential TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(actor TEXT, operation TEXT, hash TEXT, body TEXT, PRIMARY KEY(actor,operation));
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_challenges(id TEXT PRIMARY KEY, body TEXT NOT NULL);`);
  }
  now() { return new Date(Date.now() + this.setting<number>('clockOffset', 0)).toISOString(); }
  all(type?: string): Entity[] {
    const records = type ? this.db.prepare('SELECT body FROM entities WHERE type=?').all(type) : this.db.prepare('SELECT body FROM entities').all();
    return records.map(row => JSON.parse(String(row.body)) as Entity);
  }
  get(id: string, type?: string): Entity {
    const row = this.db.prepare('SELECT body FROM entities WHERE id=?').get(id);
    if (!row) throw new DomainError(404, 'NOT_FOUND', 'This item is no longer available. Refresh the list.');
    const entity = JSON.parse(String(row.body)) as Entity;
    if (type && entity.type !== type) throw new DomainError(422, 'WRONG_ITEM', `Choose a ${type} record.`);
    return entity;
  }
  put(entity: Entity) {
    this.db.prepare('INSERT INTO entities(id,type,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(entity.id, entity.type, JSON.stringify(entity));
    this.db.prepare('INSERT OR IGNORE INTO entity_versions VALUES(?,?,?)').run(entity.id, entity.version, JSON.stringify(entity));
    return entity;
  }
  create(type: string, data: Data, actor: string, extra: Partial<Entity> = {}) {
    const now = this.now();
    return this.put({ id: `${type}-${randomUUID()}`, type, version: 1, status: 'Open', createdAt: now, updatedAt: now, createdBy: actor, updatedBy: actor, data, ...extra });
  }
  update(entity: Entity, actor: string, data: Data = {}, status = entity.status) {
    return this.put({ ...entity, status, version: entity.version + 1, updatedAt: this.now(), updatedBy: actor, data: { ...entity.data, ...data } });
  }
  people(): Actor[] { return this.db.prepare('SELECT body FROM users').all().map(row => JSON.parse(String(row.body)) as Actor); }
  person(id: string): Actor {
    const row = this.db.prepare('SELECT body FROM users WHERE id=?').get(id);
    if (!row) throw new DomainError(404, 'NO_ACCOUNT', 'Account not found. Contact hospital IT.');
    return JSON.parse(String(row.body)) as Actor;
  }
  credential(id: string): Data {
    const row = this.db.prepare('SELECT credential FROM users WHERE id=?').get(id);
    if (!row) throw new DomainError(404, 'NO_ACCOUNT', 'Account not found.');
    return JSON.parse(String(row.credential)) as Data;
  }
  savePerson(actor: Actor, credential?: Data) {
    if (credential) this.db.prepare('INSERT INTO users VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,credential=excluded.credential').run(actor.id, JSON.stringify(actor), JSON.stringify(credential));
    else this.db.prepare('UPDATE users SET body=? WHERE id=?').run(JSON.stringify(actor), actor.id);
  }
  setting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT body FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(String(row.body)) as T : fallback;
  }
  set(key: string, value: unknown) {
    this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(key, JSON.stringify(value));
  }
  audit(actor: string, role: string, action: string, target: string, before: unknown, after: unknown, reason = '', result = 'Accepted') {
    const body = { at: this.now(), actor, role, action, target, before, after, reason, result };
    const entry = this.db.prepare('INSERT INTO audit(body) VALUES(?)').run(JSON.stringify(body));
    return Number(entry.lastInsertRowid);
  }
  audits(): Data[] { return this.db.prepare('SELECT seq,body FROM audit ORDER BY seq DESC').all().map(r => ({ seq: Number(r.seq), ...JSON.parse(String(r.body)) as Data })); }
  revision() { return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM audit').get()?.n); }
  transact<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  receipt(actor: string, operation: string): { hash: string; receipt: Receipt } | undefined {
    const row = this.db.prepare('SELECT hash,body FROM receipts WHERE actor=? AND operation=?').get(actor, operation);
    return row ? { hash: String(row.hash), receipt: JSON.parse(String(row.body)) as Receipt } : undefined;
  }
  saveReceipt(actor: string, operation: string, hash: string, receipt: Receipt) {
    this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run(actor, operation, hash, JSON.stringify(receipt));
  }
  close() { this.db.close(); }
}
