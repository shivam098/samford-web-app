import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Actor, Data, Entity, Receipt } from '../shared/model.js';
import { visitStatusCode, patientVisitMessage } from '../shared/handwriting.js';

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
      CREATE TABLE IF NOT EXISTS auth_challenges(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS entities_type_patient ON entities(type, json_extract(body,'$.patientId'));
      CREATE INDEX IF NOT EXISTS entities_type_doctor_date ON entities(type, json_extract(body,'$.doctorId'), json_extract(body,'$.data.date'));
      CREATE INDEX IF NOT EXISTS entities_type_mobile ON entities(type, json_extract(body,'$.data.mobile'));
      CREATE INDEX IF NOT EXISTS entities_type_document ON entities(type, json_extract(body,'$.data.documentId'));
      CREATE INDEX IF NOT EXISTS users_mobile ON users(json_extract(body,'$.mobile'));
      CREATE TABLE IF NOT EXISTS blobs(sha256 TEXT PRIMARY KEY, media_type TEXT NOT NULL, size INTEGER NOT NULL, width INTEGER, height INTEGER, created_at TEXT NOT NULL, created_by TEXT NOT NULL, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS blob_refs(sha256 TEXT NOT NULL, document_entity_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(sha256, document_entity_id, role));
      CREATE INDEX IF NOT EXISTS blob_refs_document ON blob_refs(document_entity_id);
      CREATE TABLE IF NOT EXISTS feed_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, audience TEXT NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS feed_events_audience ON feed_events(audience, seq);
      CREATE TABLE IF NOT EXISTS mobile_tokens(token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, actor_id TEXT NOT NULL, device_id TEXT NOT NULL, mobile TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_used_at TEXT NOT NULL, revoked_at TEXT);
      CREATE INDEX IF NOT EXISTS mobile_tokens_actor ON mobile_tokens(actor_id);
      CREATE TABLE IF NOT EXISTS mobile_idempotency(scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL, encrypted INTEGER NOT NULL, permanent INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope, key));
      CREATE TABLE IF NOT EXISTS mobile_otp(id TEXT PRIMARY KEY, mobile TEXT NOT NULL, ip TEXT NOT NULL, device_id TEXT NOT NULL, code_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, failures INTEGER NOT NULL, consumed INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS mobile_otp_mobile ON mobile_otp(mobile, created_at);
      CREATE INDEX IF NOT EXISTS mobile_otp_ip ON mobile_otp(ip, created_at);`);
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
    const previous = entity.type === 'visit' ? this.db.prepare('SELECT body FROM entities WHERE id=?').get(entity.id) : undefined;
    this.db.prepare('INSERT INTO entities(id,type,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(entity.id, entity.type, JSON.stringify(entity));
    this.db.prepare('INSERT OR IGNORE INTO entity_versions VALUES(?,?,?)').run(entity.id, entity.version, JSON.stringify(entity));
    if (entity.type === 'visit') this.visitChanged(previous ? JSON.parse(String(previous.body)) as Entity : undefined, entity);
    return entity;
  }
  private visitChanged(before: Entity | undefined, visit: Entity) {
    const keys = (entity: Entity) => JSON.stringify([entity.status, entity.doctorId, entity.data.token, entity.data.date, entity.data.time, entity.data.priority]);
    if (before && keys(before) === keys(visit)) return;
    const status = visitStatusCode(visit.status);
    const token = status !== 'BOOKED' && typeof visit.data.token === 'number' && visit.data.token > 0 ? visit.data.token : null;
    const data = { status, token, date: visit.data.date ?? null, time: visit.data.time ?? null };
    const tokenText = token ? `token ${token}` : 'an appointment';
    if (visit.doctorId) this.emit(`doctor:${visit.doctorId}`, 'QUEUE_UPDATED', { message: `Queue updated: ${tokenText} is ${status.toLowerCase().replaceAll('_', ' ')}.`, visitId: visit.id, patientId: visit.patientId ?? null, data });
    if (before?.doctorId && before.doctorId !== visit.doctorId) this.emit(`doctor:${before.doctorId}`, 'QUEUE_UPDATED', { message: 'A visit moved to another doctor.', visitId: visit.id, patientId: visit.patientId ?? null, data: { ...data, status: 'CANCELLED' } });
    if (visit.patientId) this.emit(`patient:${visit.patientId}`, 'VISIT_UPDATED', {
      message: patientVisitMessage(status, token, String(visit.data.date ?? ''), String(visit.data.time ?? '')), visitId: visit.id, patientId: visit.patientId, data,
      notify: status === 'CALLED' && before?.status !== 'Called' ? { title: 'Token called', body: token ? `Token ${token} is being called. Please go to the doctor's room.` : 'You are being called.' } : undefined
    });
  }
  emit(audience: string, type: string, event: { message: string; visitId?: string | null; documentId?: string | null; patientId?: string | null; data?: Data; notify?: { title: string; body: string } }) {
    this.db.prepare('INSERT INTO feed_events(audience,type,at,body) VALUES(?,?,?,?)').run(audience, type, this.now(),
      JSON.stringify({ message: event.message, visitId: event.visitId ?? null, documentId: event.documentId ?? null, patientId: event.patientId ?? null, data: event.data ?? {}, ...(event.notify ? { notify: event.notify } : {}) }));
  }
  query(type: string, field: 'patientId' | 'documentId' | 'mobile', value: string): Entity[] {
    const expression = { patientId: "json_extract(body,'$.patientId')", documentId: "json_extract(body,'$.data.documentId')", mobile: "json_extract(body,'$.data.mobile')" }[field];
    return this.db.prepare(`SELECT body FROM entities WHERE type=? AND ${expression}=?`).all(type, value).map(row => JSON.parse(String(row.body)) as Entity);
  }
  visitsFor(doctorId: string, date: string): Entity[] {
    return this.db.prepare("SELECT body FROM entities WHERE type='visit' AND json_extract(body,'$.doctorId')=? AND json_extract(body,'$.data.date')=?").all(doctorId, date).map(row => JSON.parse(String(row.body)) as Entity);
  }
  count(type: string) { return Number(this.db.prepare('SELECT COUNT(*) AS n FROM entities WHERE type=?').get(type)?.n ?? 0); }
  maybe(id: string): Entity | undefined {
    const row = this.db.prepare('SELECT body FROM entities WHERE id=?').get(id);
    return row ? JSON.parse(String(row.body)) as Entity : undefined;
  }
  patientAccountByMobile(mobile: string): Actor | undefined {
    return this.db.prepare("SELECT body FROM users WHERE json_extract(body,'$.mobile')=?").all(mobile).map(row => JSON.parse(String(row.body)) as Actor).find(actor => actor.role === 'patient');
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
