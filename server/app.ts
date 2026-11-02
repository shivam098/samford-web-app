import express, { type Request, type Response, type NextFunction } from 'express';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import QRCode from 'qrcode';
import { Store, DomainError, requireThat } from './store.js';
import { seed } from './seed.js';
import { Auth, cookie, hash, demoPassword } from './auth.js';
import { commands } from '../shared/commands.js';
import { traceability } from '../shared/traceability.js';
import { doctorRoles, text, num, type Data, type CommandRequest, type Field } from '../shared/model.js';
import { execute, anchorFor, auditSafe } from './engine.js';
import { visible, safeEntity, slotsFor } from './context.js';
import { snapshot, report, csv } from './reporting.js';
import { scheduledChecks } from './admin.js';
import { makePdf, validateUploadedFile } from './documents.js';

const demoIds = ['doctor-a', 'doctor-b', 'resident', 'super', 'super-two', 'admin', 'head', 'it', 'auditor', 'desk', 'cashier', 'pharmacy', 'store', 'nurse', 'lab', 'verifier', 'ot', 'mrd', 'services', 'services-two', 'manager', 'manager-two', 'family', 'other-family'];
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function fieldSchema(field: Field): Data {
  const schema: Data = { title: field.label, description: field.help || field.label };
  if (field.kind === 'number') { schema.type = 'number'; if (field.min !== undefined) schema.minimum = field.min; if (field.max !== undefined) schema.maximum = field.max; }
  else if (field.kind === 'boolean') { schema.type = 'boolean'; if (field.required) schema.const = true; }
  else if (['tests', 'checklist'].includes(field.kind)) { schema.type = 'array'; schema.items = { type: 'string' }; }
  else if (field.kind === 'medicines') { schema.type = 'array'; schema.items = { type: 'object', required: ['itemId', 'dose', 'frequency', 'route', 'days', 'quantity', 'reviewed'],
    properties: { itemId: { type: 'string' }, dose: { type: 'string' }, frequency: { type: 'string' }, route: { type: 'string' }, days: { type: 'integer', minimum: 1, maximum: 365 }, quantity: { type: 'integer', minimum: 1 }, reviewed: { const: true }, start: { type: 'string', format: 'date' }, food: { type: 'string' }, remark: { type: 'string' } } }; }
  else if (field.kind === 'payments') { schema.type = 'array'; schema.items = { type: 'object', required: ['mode', 'amount'], properties: { mode: { enum: ['Cash', 'UPI', 'Card'] }, amount: { type: 'number', exclusiveMinimum: 0, description: 'Amount in INR; persisted money is integer paise.' } } }; }
  else if (field.kind === 'file') { schema.type = 'object'; schema.properties = { name: { type: 'string' }, mime: { enum: ['application/pdf', 'image/png', 'image/jpeg'] }, base64: { type: 'string', contentEncoding: 'base64' } }; schema.required = ['name', 'mime', 'base64']; }
  else { schema.type = 'string'; if (field.kind === 'date') schema.format = 'date'; if (field.kind === 'datetime') schema.format = 'date-time'; }
  if (field.options && field.kind !== 'checklist') schema.enum = field.options;
  return schema;
}
function apiReference(): Data {
  const paths: Data = {};
  for (const command of commands) {
    paths[`/api/commands/${command.name}`] = { post: {
      summary: command.label, description: `${command.help} Roles: ${command.roles.join(', ')}. ${command.target ? `Target: ${command.target}.` : 'Creates a new workflow item.'} ${command.from ? `Allowed states: ${command.from.join(', ')}.` : ''}`,
      'x-journeys': command.journeys, 'x-roles': command.roles, 'x-ui': command.journeys.map(id => `/#journey/${id}`),
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', additionalProperties: false, required: ['operationId', 'actorId', 'createdAt', 'deviceId', 'payload', ...(command.target ? ['targetId', 'expectedVersion'] : [])],
        properties: {
          operationId: { type: 'string', minLength: 12, description: 'Stable per logical attempt. Retry unchanged; changing content needs a new ID.' },
          actorId: { type: 'string', description: 'Must equal the signed-in actor; replay never reattributes old work to a new persona.' },
          targetId: { type: 'string' }, expectedVersion: { type: 'integer', description: 'Required for target or first visitId/admissionId/patientId context.' },
          createdAt: { type: 'string', format: 'date-time' }, deviceId: { type: 'string' },
          contextVersions: { type: 'object', additionalProperties: { type: 'integer' }, description: 'Reviewed context versions. Prescription approval requires patient allergy context.' },
          payload: { type: 'object', additionalProperties: false, required: command.fields.filter(f => f.required).map(f => f.key), properties: Object.fromEntries(command.fields.map(f => [f.key, fieldSchema(f)])) }
        }
      } } } },
      responses: { '200': { description: 'Accepted receipt (separate from recipient acknowledgement/fulfillment)' }, '403': { description: 'Role denied' }, '409': { description: 'Version/context/idempotency conflict; current authorized record supplied' }, '422': { description: 'Validation or invalid transition; no changes committed' }, '503': { description: 'Retryable simulated failure; retry the identical operation' } }
    } };
  }
  for (const [path, method, summary] of [
    ['/api/bootstrap', 'get', 'Public synthetic personas and simulation boundaries'],
    ['/api/auth/demo', 'post', 'Explicit public demo-persona sign-in (seeded identities only)'],
    ['/api/auth/start', 'post', 'Password journey: login,password,deviceId; returns simulated challenge'],
    ['/api/auth/otp', 'post', 'Complete challenge: challengeId,code'],
    ['/api/auth/captcha', 'get', 'Patient simulated captcha'],
    ['/api/auth/patient', 'post', 'Patient mobile,captchaId,answer,deviceId; returns simulated OTP'],
    ['/api/auth/password', 'post', 'Set personal password; temporary password cannot be reused'],
    ['/api/auth/confirm', 'post', 'Confirm own profile after password setup'],
    ['/api/auth/me', 'get', 'Session metadata only; does not extend idle time'],
    ['/api/auth/logout', 'post', 'End persona session; unsent work must be explicitly resolved'],
    ['/api/auth/lock', 'post', 'Lock own session'],
    ['/api/auth/unlock', 'post', 'Unlock with synthetic PIN 2468'],
    ['/api/access', 'post', 'Request access: name,staffId,mobile,departmentId,registration; no authority granted'],
    ['/api/access/track', 'post', 'Track access request with id and private tracking key'],
    ['/api/state', 'get', 'Authorized current projection, people, settings, counts and tasks'],
    ['/api/entities', 'get', 'Authorized collection; optional type,q,status filters'],
    ['/api/entities/{id}', 'get', 'Authorized entity detail'],
    ['/api/export/entities', 'get', 'Audited staff/admin worklist CSV; types,q,status match the displayed list'],
    ['/api/slots', 'get', 'Shared slot grid: doctorId,date; states only, never other patients’ identities'],
    ['/api/history/{id}', 'get', 'Authorized immutable versions of a record'],
    ['/api/receipts/{operationId}', 'get', 'Own operation outcome for timeout reconciliation'],
    ['/api/sync/device', 'post', 'Report original-persona unsent count and last sync'],
    ['/api/documents/{id}/file', 'get', 'Authorized PDF/image bytes; no filesystem paths'],
    ['/api/reports/{kind}', 'get', 'Role-limited aggregates; from,to,department,format=csv'],
    ['/api/audit', 'get', 'Administrative redacted append-only audit; action,actor,from,to,format=csv'],
    ['/api/board/{id}', 'get', 'Public token-only board; never returns patient identifiers'],
    ['/api/demo/fault', 'post', 'Own next-send fault; simulated provider changes require superadmin/manager'],
    ['/api/demo/clock', 'post', 'Superadmin/manager advance only the demo clock'],
    ['/api/demo/reset', 'post', 'Superadmin reset after exact confirmation; no silent reseeding'],
    ['/api/traceability', 'get', 'Journey-to-UI/API map; evidence is maintained by executed tests']
  ]) paths[path] = { [method]: { summary, responses: { '200': { description: 'Success within the caller scope' }, '401': { description: 'Sign-in/lock/onboarding required' }, '403': { description: 'Role or scope denied' } } } };
  return { openapi: '3.1.0', info: { title: 'Samford synthetic workflow API', version: '0.1.0', description: 'Public, shared synthetic demo. Not production authentication, clinical software, legal signing, medical advice or a live integration. Every mutation is transactional. Money is stored in integer paise. All external effects are simulated.' }, servers: [{ url: '/' }], paths };
}
export function createApplication(options: { database: string; dist?: string; test?: boolean }) {
  const store = new Store(options.database); seed(store); scheduledChecks(store);
  const auth = new Auth(store); const app = express(); const staticRoot = resolve(options.dist ?? 'dist');
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'Cache-Control': 'no-store'
    });
    const host = (req.headers.host ?? '').toLowerCase();
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) && !/^[a-z0-9-]+\.trycloudflare\.com$/.test(host)) return res.status(403).json({ code: 'HOST_DENIED', message: 'This host is not configured for the local synthetic demo.', retryable: false });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      let sameOrigin = !origin;
      if (origin) {
        try { sameOrigin = new URL(origin).host.toLowerCase() === host; }
        catch { sameOrigin = false; }
      }
      if (!sameOrigin) return res.status(403).json({ code: 'ORIGIN_DENIED', message: 'Open the app on its own origin before submitting.', retryable: false });
      if (req.headers['x-samford-request'] !== '1' || !req.is('application/json')) return res.status(403).json({ code: 'CSRF_REQUIRED', message: 'Use the app’s same-origin JSON API.', retryable: false });
    }
    next();
  });
  const limits = new Map<string, { started: number; count: number }>();
  app.use('/api', (req, res, next) => {
    if (options.test) return next();
    const ip = String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress);
    const category = req.path.startsWith('/auth') || req.path === '/access' ? 'auth' : 'api';
    const key = `${ip}:${category}`; let limit = limits.get(key);
    if (!limit || Date.now() - limit.started > 60000) { limit = { started: Date.now(), count: 0 }; limits.set(key, limit); }
    limit.count++;
    if (limit.count > (category === 'auth' ? 100 : 1200)) return res.status(429).json({ code: 'RATE_LIMIT', message: 'Too many requests. Wait a minute before trying again.', retryable: true });
    if (limits.size > 2000) for (const [key, value] of limits) if (Date.now() - value.started > 60000) limits.delete(key);
    next();
  });
  app.use(express.json({ limit: '15mb', strict: true }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', synthetic: true, version: '0.1.0' }));
  app.get('/api/bootstrap', (_req, res) => res.json({
    publicDemo: true, warning: 'PUBLIC SHARED SYNTHETIC DEMO. Anyone with this URL can use demo personas and change sample data. Do not enter real patient information or credentials.',
    personas: store.people().filter(actor => demoIds.includes(actor.id)).map(actor => ({ id: actor.id, name: actor.name, role: actor.role, department: actor.department, state: actor.state, mobile: actor.role === 'patient' ? actor.mobile : '' })),
    departments: store.all('department').map(e => ({ id: e.id, name: text(e.data, 'name') })),
    demoPassword, demoPin: '2468', version: 1
  }));
  app.post('/api/auth/demo', (req, res) => {
    requireThat(typeof req.body.actorId === 'string' && demoIds.includes(req.body.actorId), 'Choose one of the explicit seeded demo personas.');
    requireThat(typeof req.body.deviceId === 'string' && req.body.deviceId.length <= 120, 'A browser device ID is required.');
    const actor = store.person(req.body.actorId);
    requireThat(actor.state === 'Active' && !actor.temporary, 'This demo account needs the normal recovery/onboarding flow before it can be used.');
    const challenge = auth.challenge(actor, req.body.deviceId, false);
    const signed = auth.complete(text(challenge, 'challengeId'), text(challenge, 'simulatedCode'), req, res);
    store.audit(actor.id, actor.role, 'demo.explicitPersonaSignIn', actor.id, null, { publicSyntheticDemo: true });
    res.json({ actor: signed, message: 'Signed in as this named synthetic persona. This is not production authentication.' });
  });
  app.post('/api/auth/start', (req, res) => {
    requireThat(typeof req.body.login === 'string' && req.body.login.length <= 254 && typeof req.body.password === 'string' && req.body.password.length <= 128 && typeof req.body.deviceId === 'string' && req.body.deviceId.length <= 120, 'Enter a valid login, password and browser device ID.');
    res.json(auth.start(req.body.login, req.body.password, req.body.deviceId));
  });
  app.get('/api/auth/captcha', (_req, res) => {
    const x = randomInt(1, 10); const y = randomInt(1, 10); const id = randomUUID();
    store.set(`captcha:${id}`, { answer: String(x + y), expires: Date.now() + 300000 });
    res.json({ id, question: `${x} + ${y} = ?`, simulated: true });
  });
  app.post('/api/auth/patient', (req, res) => {
    for (const key of ['mobile', 'captchaId', 'answer', 'deviceId']) requireThat(typeof req.body[key] === 'string', `Enter ${key}.`);
    res.json(auth.patientStart(req.body.mobile, req.body.captchaId, req.body.answer, req.body.deviceId));
  });
  app.post('/api/auth/otp', (req, res) => {
    requireThat(typeof req.body.challengeId === 'string' && typeof req.body.code === 'string', 'Enter the simulated code.');
    res.json({ actor: auth.complete(req.body.challengeId, req.body.code, req, res) });
  });
  app.get('/api/auth/me', (req, res) => { const { actor, session } = auth.get(req, true, true); res.json({ actor, locked: session.locked, restricted: session.restricted || actor.temporary || !actor.profileConfirmed }); });
  app.post('/api/auth/password', (req, res) => { requireThat(typeof req.body.password === 'string', 'Enter a new password.'); auth.changePassword(req, req.body.password); res.json({ changed: true }); });
  app.post('/api/auth/confirm', (req, res) => { requireThat(req.body.confirmed === true, 'Confirm the displayed profile.'); auth.confirm(req); res.json({ confirmed: true }); });
  app.post('/api/auth/lock', (req, res) => { auth.lock(req, true); res.json({ locked: true }); });
  app.post('/api/auth/unlock', (req, res) => { auth.lock(req, false, req.body.pin); res.json({ unlocked: true }); });
  app.post('/api/auth/logout', (req, res) => {
    const { actor } = auth.get(req, true, true);
    requireThat(req.body.unsent === 0, 'Resolve or retain recovery of unsent work before signing out.');
    auth.revokeKey(cookie(req, 'samford_actor')); res.clearCookie('samford_actor', { path: '/' });
    store.audit(actor.id, actor.role, 'auth.signout', actor.id, null, null); res.json({ signedOut: true });
  });
  app.post('/api/access', (req, res) => {
    for (const key of ['name', 'staffId', 'mobile', 'departmentId', 'registration']) requireThat(typeof req.body[key] === 'string' && req.body[key].trim().length > 0 && req.body[key].length < 200, `Enter a valid ${key}.`);
    store.get(req.body.departmentId, 'department');
    const trackingKey = randomBytes(24).toString('base64url');
    const record = store.transact(() => {
      const record = store.create('access', { name: req.body.name, staffId: req.body.staffId, mobile: req.body.mobile, registration: req.body.registration, departmentId: req.body.departmentId, trackingHash: hash(trackingKey), staffMatch: store.people().some(actor => actor.staffId === req.body.staffId) ? 'Already has a login' : 'Synthetic staff-list review required' }, 'Requester', { status: 'Requested', department: req.body.departmentId });
      store.audit('Requester', 'requester', 'access.requested', record.id, null, { status: 'Requested' }); return record;
    });
    res.json({ id: record.id, trackingKey, status: 'Requested' });
  });
  app.post('/api/access/track', (req, res) => {
    requireThat(typeof req.body.id === 'string' && typeof req.body.trackingKey === 'string', 'Enter the request ID and tracking key.');
    const record = store.get(req.body.id, 'access');
    requireThat(text(record.data, 'trackingHash') === hash(req.body.trackingKey), 'The tracking key did not match.');
    res.json({ id: record.id, status: record.status, reason: text(record.data, 'reason'), accountId: text(record.data, 'accountId'), login: text(record.data, 'staffId').toLowerCase(), message: 'Temporary passwords are handed over by administration; this page never reveals one.' });
  });
  app.get('/api/state', (req, res) => res.json(snapshot(store, auth.get(req).actor)));
  app.get('/api/slots', (req, res) => {
    const actor = auth.get(req).actor;
    requireThat(['doctor', 'resident', 'desk', 'manager', 'patient'].includes(actor.role), 'Your role cannot view appointment slots.');
    const doctorId = String(req.query.doctorId ?? ''); const date = String(req.query.date ?? '');
    requireThat(/^\d{4}-\d{2}-\d{2}$/.test(date), 'Choose a valid date.');
    const exclude = String(req.query.excludeVisitId ?? '');
    if (exclude) requireThat(visible(store, actor, store.get(exclude, 'visit')), 'The visit is outside your scope.');
    res.json(slotsFor(store, doctorId, date, actor, exclude));
  });
  app.get('/api/entities', (req, res) => {
    const actor = auth.get(req).actor; const q = String(req.query.q ?? '').toLowerCase(); const status = String(req.query.status ?? '');
    const entities = store.all(typeof req.query.type === 'string' ? req.query.type : undefined).filter(e => visible(store, actor, e) && (!status || e.status === status)).map(e => safeEntity(actor, e));
    res.json(entities.filter(e => !q || JSON.stringify(e).toLowerCase().includes(q)));
  });
  app.get('/api/entities/:id', (req, res) => {
    const actor = auth.get(req).actor; const entity = store.get(String(req.params.id));
    if (!visible(store, actor, entity)) throw new DomainError(404, 'NOT_FOUND', 'Item not found in your scope.');
    res.json(safeEntity(actor, entity));
  });
  app.get('/api/export/entities', (req, res) => {
    const actor = auth.get(req).actor;
    requireThat(!doctorRoles.includes(actor.role) && actor.role !== 'patient', 'Use authorized clinical PDFs rather than exporting a patient worklist.');
    const types = String(req.query.types ?? '').split(','); const q = String(req.query.q ?? '').toLowerCase(); const status = String(req.query.status ?? '');
    const entities = store.all().filter(e => types.includes(e.type) && visible(store, actor, e) && (!status || e.status === status)).map(e => safeEntity(actor, e))
      .filter(e => !q || `${text(e.data, 'name') || text(e.data, 'title') || text(e.data, 'number')} ${e.id} ${JSON.stringify(e.data)}`.toLowerCase().includes(q));
    const records: Data[] = entities.map(e => ({ workItem: text(e.data, 'name') || text(e.data, 'title') || text(e.data, 'number') || e.id, type: e.type, recordId: e.id, status: e.status, version: e.version, updatedAt: e.updatedAt, updatedBy: e.updatedBy }));
    store.audit(actor.id, actor.role, 'worklist.export', types.join(','), null, { count: records.length });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="sample-worklist.csv"' }).send(csv(records));
  });
  app.get('/api/history/:id', (req, res) => {
    const actor = auth.get(req).actor; const entity = store.get(String(req.params.id));
    if (!visible(store, actor, entity)) throw new DomainError(404, 'NOT_FOUND', 'Item not found in your scope.');
    const versions = store.db.prepare('SELECT body FROM entity_versions WHERE id=? ORDER BY version DESC').all(entity.id).map(row => JSON.parse(String(row.body)));
    res.json(versions.map(e => safeEntity(actor, e)));
  });
  app.post('/api/commands/:name', async (req, res) => {
    const { actor, session } = auth.get(req);
    const name = String(req.params.name); const request = req.body as CommandRequest;
    requireThat(request.deviceId === session.deviceId, 'The action belongs to a different browser. Sign in on the original device.');
    if (name === 'document.upload') await validateUploadedFile(request.payload?.file);
    if (name === 'note.save' && request.payload?.handwriting) await validateUploadedFile(request.payload.handwriting);
    const fault = store.setting<Data>(`faults:${actor.id}`, { next: 'None' }); const next = text(fault, 'next');
    if (next !== 'None') store.set(`faults:${actor.id}`, { next: 'None' });
    if (next === 'Fail before acceptance') throw new DomainError(503, 'SIMULATED_RETRY', 'Simulated network failure before acceptance. Your local item is safe; retry it.');
    if (next === 'Reject') throw new DomainError(422, 'SIMULATED_REJECTION', 'The mock hospital rejected this action for training. Review the saved item, then submit a corrected new action.');
    if (next === 'Conflict') {
      const anchor = anchorFor(store, name, request);
      requireThat(anchor && visible(store, actor, anchor), 'Choose an existing scoped record to simulate a conflict.');
      store.transact(() => {
        store.update(anchor, 'System', { demoConcurrentChange: `Simulated separate update at ${store.now()}` });
        store.audit('System', 'system', 'demo.concurrentChange', anchor.id, auditSafe(anchor), { version: anchor.version + 1 });
      });
    }
    let receipt;
    try { receipt = execute(store, actor, name, request); }
    catch (error) {
      store.audit(actor.id, actor.role, name, request.targetId || '', null, null, error instanceof DomainError ? error.code : 'Internal error', 'Rejected');
      throw error;
    }
    if (next === 'Lose reply after acceptance') throw new DomainError(503, 'OUTCOME_UNKNOWN', 'Simulated lost reply after submission. Retry the identical operation to retrieve its receipt; do not create a duplicate.');
    res.json(receipt);
  });
  app.get('/api/receipts/:operationId', (req, res) => {
    const actor = auth.get(req).actor; const receipt = store.receipt(actor.id, String(req.params.operationId));
    if (!receipt) return res.status(404).json({ code: 'OUTCOME_UNKNOWN', message: 'No accepted receipt exists for this operation yet.', retryable: true });
    res.json(receipt.receipt);
  });
  app.post('/api/sync/device', (req, res) => {
    const { actor, session } = auth.get(req);
    requireThat(Number.isInteger(req.body.unsent) && req.body.unsent >= 0 && req.body.unsent <= 10000, 'Invalid pending item count.');
    const device = store.all('device').find(e => text(e.data, 'actorId') === actor.id && text(e.data, 'deviceId') === session.deviceId)!;
    store.update(device, actor.id, { unsent: req.body.unsent, lastSync: store.now() });
    res.json({ received: true });
  });
  app.post('/api/device/wipe-ack', (req, res) => {
    const token = cookie(req, 'samford_actor'); const row = store.db.prepare('SELECT body FROM sessions WHERE token=?').get(hash(token));
    requireThat(row, 'The device session is unavailable. Contact IT.');
    const session = JSON.parse(String(row.body)) as Data;
    const device = store.all('device').find(e => text(e.data, 'actorId') === text(session, 'actorId') && text(e.data, 'deviceId') === text(session, 'deviceId'));
    requireThat(device?.status === 'Wipe pending' && req.body.confirmed === true && Number.isInteger(req.body.unsentLost), 'Confirm this pending browser-app wipe and its unsent recovery count.');
    store.update(device, 'Device', { unsentLost: req.body.unsentLost, acknowledgedAt: store.now(), unsent: 0 }, 'Wiped');
    store.audit('Device', 'device', 'device.wipeAcknowledged', device.id, null, { unsentLost: req.body.unsentLost });
    auth.revokeKey(token); res.clearCookie('samford_actor', { path: '/' }); res.json({ acknowledged: true });
  });
  app.get('/api/documents/:id/file', async (req, res) => {
    const actor = auth.get(req).actor; const document = store.get(String(req.params.id), 'document');
    if (!visible(store, actor, document) || document.status !== 'Available') throw new DomainError(404, 'NOT_FOUND', 'This document is unavailable in your scope.');
    const data = document.data; const filename = text(data, 'name').replace(/[^a-zA-Z0-9 ._-]/g, '_').slice(0, 100);
    let bytes: Buffer;
    if (data.generated) {
      const header = data.letterhead && typeof data.letterhead === 'object' && !Array.isArray(data.letterhead) ? data.letterhead : {};
      bytes = await makePdf(text(data, 'kind'), Array.isArray(data.lines) ? data.lines.filter((x): x is string => typeof x === 'string') : [], header, text(data, 'barcode'));
    } else bytes = Buffer.from(text(data, 'file'), 'base64');
    requireThat(bytes.length > 0, 'The document content is missing. Ask the originating desk.');
    res.set({ 'Content-Type': text(data, 'mime', 'application/pdf'), 'Content-Disposition': `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${filename}${data.generated ? '.pdf' : ''}"`, 'Content-Length': String(bytes.length) });
    res.send(bytes);
  });
  app.get('/api/reports/:kind', (req, res) => {
    const actor = auth.get(req).actor; const kind = String(req.params.kind);
    const records = report(store, actor, kind, String(req.query.from ?? ''), String(req.query.to ?? ''), String(req.query.department ?? ''));
    if (req.query.format === 'csv') {
      store.audit(actor.id, actor.role, 'report.export', kind, null, { rows: records.length });
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="sample-${kind}.csv"` }).send(`${kind === 'activity' ? '"App activity, not attendance."\r\n' : ''}${csv(records)}`);
    } else res.json({ title: kind === 'activity' ? 'Doctor activity (app use, not attendance)' : `${kind} report`, records, receivedUpTo: store.now() });
  });
  app.get('/api/audit', (req, res) => {
    const actor = auth.get(req).actor; requireThat(['superadmin', 'admin', 'auditor'].includes(actor.role), 'Your role cannot view the administrative audit log.');
    const entries = store.audits().filter(e => (!req.query.action || String(e.action).includes(String(req.query.action))) && (!req.query.actor || e.actor === req.query.actor) && (!req.query.from || String(e.at).slice(0, 10) >= String(req.query.from)) && (!req.query.to || String(e.at).slice(0, 10) <= String(req.query.to)));
    if (req.query.format === 'csv') {
      store.audit(actor.id, actor.role, 'audit.export', '', null, { count: entries.length });
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="sample-audit.csv"' }).send(csv(entries));
    } else res.json(entries);
  });
  app.all('/api/audit/:id', (req, _res) => {
    const actor = auth.get(req).actor; store.audit(actor.id, actor.role, 'audit.editRefused', String(req.params.id), null, null, 'Append-only log', 'Rejected');
    throw new DomainError(403, 'IMMUTABLE_AUDIT', 'The audit log is append-only. Entries cannot be edited or deleted.');
  });
  app.get('/api/board/:id', (req, res) => {
    const board = store.get(String(req.params.id), 'board');
    if (!board.data.enabled) return res.json({ active: false, message: 'Board not active' });
    const doctors = store.people().filter(person => person.role === 'doctor' && (!text(board.data, 'doctorId') || person.id === text(board.data, 'doctorId')));
    const data = doctors.map(doctor => {
      const visits = store.all('visit').filter(e => e.doctorId === doctor.id && text(e.data, 'date') === new Date(new Date(store.now()).getTime() + 330 * 60000).toISOString().slice(0, 10));
      return { doctor: doctor.name, room: text(store.get(doctor.id).data, 'room'), presence: store.all('presence').find(e => e.doctorId === doctor.id)?.status ?? 'Offline',
        currentToken: visits.find(e => ['Called', 'In consultation'].includes(e.status))?.data.token ?? null,
        nextTokens: visits.filter(e => e.status === 'Waiting').sort((a, b) => num(a.data, 'token') - num(b.data, 'token')).slice(0, 3).map(e => num(e.data, 'token')),
        missedTokens: visits.filter(e => e.status === 'Missed').map(e => num(e.data, 'token')) };
    });
    res.json({ active: true, name: text(board.data, 'name'), doctors: data, refreshedAt: store.now() });
  });
  app.get('/api/profile/:id/qr', async (req, res) => {
    const actor = store.person(String(req.params.id)); requireThat(actor.role === 'doctor', 'Only consultant profiles have public QR links.');
    const scheme = req.headers['x-forwarded-proto'] === 'https' ? 'https' : req.protocol;
    const url = `${scheme}://${req.headers.host}/profile/${encodeURIComponent(actor.id)}`;
    res.json({ url, image: await QRCode.toDataURL(url, { width: 180, margin: 1 }) });
  });
  app.get('/profile/:id', (req, res) => {
    const actor = store.person(String(req.params.id)); requireThat(actor.role === 'doctor', 'Profile unavailable.');
    const profile = store.get(actor.id);
    res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sample doctor profile</title><link rel="stylesheet" href="/main.css"></head><body><main class="public-profile"><p class="eyebrow">SAMFORD / SYNTHETIC PROFILE</p><h1>${escape(actor.name)}</h1><p>${escape(actor.department)} | ${escape(text(profile.data, 'qualification'))}</p><p>Registration: ${escape(text(profile.data, 'registration'))}</p><p>No patient information, credentials or clinical access are contained in this profile.</p><a href="/">Open the public synthetic demo</a></main></body></html>`);
  });
  app.post('/api/demo/fault', (req, res) => {
    const actor = auth.get(req).actor;
    if (req.body.next !== undefined) {
      requireThat(['None', 'Fail before acceptance', 'Lose reply after acceptance', 'Conflict', 'Reject'].includes(req.body.next), 'Choose a listed training fault.');
      store.set(`faults:${actor.id}`, { next: req.body.next });
    }
    if (req.body.provider !== undefined) {
      requireThat(['superadmin', 'manager'].includes(actor.role), 'Only demo operations or super admin changes shared provider health.');
      requireThat(['Success', 'Failure'].includes(req.body.provider), 'Choose a valid simulated provider state.');
      store.set('faults', { ...store.setting<Data>('faults', {}), provider: req.body.provider });
      for (const integration of store.all('integration')) store.update(integration, actor.id, { checkedAt: store.now() }, req.body.provider === 'Failure' ? 'Simulated outage' : 'Simulated healthy');
    }
    store.audit(actor.id, actor.role, 'demo.fault', actor.id, null, { next: req.body.next ?? '', provider: req.body.provider ?? '' });
    res.json({ configured: true });
  });
  app.post('/api/demo/clock', (req, res) => {
    const actor = auth.get(req).actor; requireThat(['superadmin', 'manager'].includes(actor.role), 'Only demo operations or super admin changes the shared demo clock.');
    requireThat(typeof req.body.minutes === 'number' && req.body.minutes >= 0 && req.body.minutes <= 60 * 24 * 31, 'Advance by 0 to 44640 minutes.');
    store.set('clockOffset', store.setting<number>('clockOffset', 0) + req.body.minutes * 60000);
    scheduledChecks(store); store.audit(actor.id, actor.role, 'demo.clock', 'clock', null, { minutes: req.body.minutes });
    res.json({ now: store.now(), message: 'Demo deadlines and session expiry now use the advanced clock. Sign in again if the session expired.' });
  });
  app.post('/api/demo/reset', (req, res) => {
    const actor = auth.get(req).actor; requireThat(actor.role === 'superadmin', 'Only a named demo super admin can reset shared samples.');
    requireThat(req.body.confirm === 'RESET SHARED SYNTHETIC DATA', 'Type RESET SHARED SYNTHETIC DATA to confirm. All testers will be signed out.');
    const previousAudit = store.revision();
    store.transact(() => {
      for (const table of ['entities', 'entity_versions', 'users', 'sessions', 'receipts', 'settings', 'auth_challenges']) store.db.exec(`DELETE FROM ${table}`);
    });
    seed(store);
    store.audit(actor.id, actor.role, 'demo.explicitReset', 'synthetic', null, { previousAuditEntries: previousAudit, priorAuditRetained: true });
    res.clearCookie('samford_actor', { path: '/' }); res.json({ reset: true, message: 'Shared synthetic records reset; prior audit retained. Local encrypted drafts were not silently deleted.' });
  });
  app.get('/api/contracts', (req, res) => { auth.get(req); res.json(apiReference()); });
  app.get('/api/traceability', (req, res) => {
    auth.get(req);
    res.json(traceability);
  });
  app.use('/api', (_req, res) => res.status(404).json({ code: 'NOT_FOUND', message: 'API route not found.', retryable: false }));
  for (const file of ['main.js', 'main.css', 'sw.js']) app.get(`/${file}`, (_req, res) => { if (file === 'sw.js') res.set('Service-Worker-Allowed', '/'); res.sendFile(join(staticRoot, file)); });
  app.get('/', (_req, res) => res.sendFile(join(staticRoot, 'index.html')));
  app.use((_req, res) => res.status(404).type('text').send('Page not found. Open / for the synthetic demo.'));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof DomainError) return res.status(error.status).json({ code: error.code, message: error.message, retryable: error.status === 503, ...(error.current ? { current: error.current } : {}) });
    const bodyError = error as { status?: number; type?: string };
    if (bodyError.status === 413) return res.status(413).json({ code: 'TOO_LARGE', message: 'This request is too large. Use a sample document up to 10 MB.', retryable: false });
    if (bodyError.status === 400) return res.status(400).json({ code: 'INVALID_JSON', message: 'This request is not valid JSON. Refresh the form.', retryable: false });
    const reference = randomUUID().slice(0, 8);
    console.error(`Request failure ${reference}: ${error instanceof Error ? error.name : 'Unknown error'}`);
    res.status(500).json({ code: 'SERVICE_ERROR', message: 'The mock service could not complete this action. Your saved input is retained. Retry or contact support.', retryable: true, reference });
  });
  return { app, store, auth };
}
