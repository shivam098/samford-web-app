import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { randomUUID } from 'node:crypto';
import { Store, DomainError } from './store.js';
import { ApiError, fail } from './api-error.js';
import { applicationVersion } from '../shared/version.js';
import { mobileApiVersion, blobLimits } from '../shared/mobile-contract.js';
import { num, text, istDate, type Data, type Json } from '../shared/model.js';
import { contractErrors } from './mobile-validate.js';
import { authenticate, revokeSession, doctorSignIn, personaDto, otpRequest, otpVerify, profilesFor, CommitThenFail, deviceEntityId, type Principal } from './mobile-auth.js';
import { labUnits, startVisit, walkIn, queueEntry, careVisit, patientRecord, completeVisit, signAddendum, visitDelivery, documentFor, blobReadable, signedUrls, canonicalJson, sha256Text,
  moveDelivery, storeWriter, versionsOf, deliveriesOf, routingOf, type Viewer, type CompleteBody, type AddendumBody } from './handwriting.js';
import { storeBlob, blobInfo, blobBytes, verifySignature, sealText, openText, mediaTypes } from './blobs.js';
import { demoIds } from './personas.js';

export { ApiError };
export type MobileOptions = { relaxedLimits?: boolean; testSupport?: boolean };
export function minimumVersions(store: Store) {
  const value = store.setting<Data>('mobileMinVersions', {});
  return { doctor: num(value, 'doctor', 1), patient: num(value, 'patient', 1) };
}
type Ctx = { req: Request; principal: Principal; base: string; viewer: Viewer };
type Auth = 'none' | 'doctor' | 'patient' | 'any';
const volatileFields = new Set(['url', 'pdfUrl', 'inkUrl', 'urlsExpireAt', 'generatedAt', 'serverTime', 'reportUrl']);
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !volatileFields.has(key)).map(([key, item]) => [key, stable(item)]));
  return value;
}
// ETags ignore signed URLs and clock fields so an unchanged record or feed revalidates with 304.
export const etagOf = (body: unknown) => `"${sha256Text(canonicalJson(stable(body))).slice(0, 32)}"`;
const tagMatches = (req: Request, tag: string) => String(req.headers['if-none-match'] ?? '').split(',').map(part => part.trim().replace(/^W\//, '')).some(part => part === tag || part === '*');
const ipOf = (req: Request) => String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? 'unknown');
export function apiBase(req: Request) {
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  return `${forwarded === 'https' ? 'https' : req.protocol}://${req.headers.host}/api/mobile/v1`;
}
const shaPattern = /^[0-9a-f]{64}$/;
const sha = (req: Request) => { const value = String(req.params.sha256); if (!shaPattern.test(value)) fail(400, 'BAD_REQUEST', 'Use a lowercase hexadecimal SHA-256 in the path.'); return value; };
const param = (req: Request, name: string) => { const value = String(req.params[name]); if (!/^[A-Za-z0-9._:-]{1,120}$/.test(value)) fail(404, 'NOT_FOUND', 'Not found.'); return value; };

export function mobileRouter(store: Store, options: MobileOptions): Router {
  const router = express.Router();
  const relaxed = options.relaxedLimits === true;
  const windows = new Map<string, { started: number; count: number }>();
  let lastSweep = 0;
  const limit = (key: string, max: number) => {
    const now = Date.now(); let window = windows.get(key);
    if (!window || now - window.started >= 60000) { window = { started: now, count: 0 }; windows.set(key, window); }
    window.count++;
    // Sweeping is periodic so many distinct tokens (1 lakh patients) do not make every request scan the map.
    if (windows.size > 5000 && now - lastSweep > 10000) { lastSweep = now; for (const [entry, value] of windows) if (now - value.started >= 60000) windows.delete(entry); }
    if (window.count > max * (relaxed ? 100 : 1)) fail(429, 'RATE_LIMITED', 'Too many requests. Wait before retrying.', { retryAfterSeconds: Math.max(1, Math.ceil((window.started + 60000 - now) / 1000)) });
  };
  const guard = (req: Request, auth: Auth): Principal | undefined => {
    if (auth === 'none') { limit(`ip:${ipOf(req)}`, 120); return undefined; }
    let principal: Principal;
    try { principal = authenticate(store, req); }
    catch (error) { limit(`ip:${ipOf(req)}`, 120); throw error; }
    limit(`token:${principal.tokenHash}`, 600);
    if (auth === 'doctor' && principal.kind !== 'DOCTOR') fail(403, 'FORBIDDEN', 'This route is only for the doctor tablet app.');
    if (auth === 'patient' && principal.kind !== 'PATIENT') fail(403, 'FORBIDDEN', 'This route is only for the patient app.');
    return principal;
  };
  const profileIds = (principal: Principal) => new Set(profilesFor(store, principal.mobile).map(profile => text(profile, 'profileId')));
  const viewerOf = (principal: Principal): Viewer => principal.kind === 'DOCTOR' ? { kind: 'DOCTOR', doctorId: principal.actor.id } : { kind: 'PATIENT', profileIds: profileIds(principal) };
  const get = (path: string, auth: Exclude<Auth, 'none'>, handler: (ctx: Ctx) => unknown) => router.get(path, (req, res) => {
    const principal = guard(req, auth)!;
    const body = handler({ req, principal, base: apiBase(req), viewer: viewerOf(principal) });
    const tag = etagOf(body); res.set('ETag', tag);
    if (tagMatches(req, tag)) { res.status(304).end(); return; }
    res.json(body);
  });
  let lastCleanup = 0;
  const lookup = (scope: string, key: string) => {
    const row = store.db.prepare('SELECT fingerprint, status, body, encrypted, permanent, created_at FROM mobile_idempotency WHERE scope=? AND key=?').get(scope, key);
    if (!row) return undefined;
    const age = Date.parse(store.now()) - Date.parse(String(row.created_at));
    const keep = Number(row.permanent) ? Number.POSITIVE_INFINITY : Number(row.encrypted) ? 86400000 : 7 * 86400000;
    const forget = () => { store.db.prepare('DELETE FROM mobile_idempotency WHERE scope=? AND key=?').run(scope, key); return undefined; };
    if (age > keep) return forget();
    try { return { fingerprint: String(row.fingerprint), status: Number(row.status), body: JSON.parse(Number(row.encrypted) ? openText(store, String(row.body)) : String(row.body)) as unknown }; }
    catch { return forget(); }
  };
  type PostOptions = { auth: 'none' | 'doctor' | 'patient'; schema: string; limit: string; status: number; keyEquals?: string; sensitive?: boolean; permanent?: boolean };
  const post = (path: string, opts: PostOptions, handler: (ctx: { req: Request; principal?: Principal; body: Data }) => Data | CommitThenFail) =>
    router.post(path, (req, res, next) => { try { res.locals.principal = guard(req, opts.auth); next(); } catch (error) { next(error); } }, express.json({ limit: opts.limit, strict: true, type: () => true }), (req, res) => {
      const principal = res.locals.principal as Principal | undefined;
      const key = String(req.headers['idempotency-key'] ?? '');
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header of 8-128 letters, digits, - or _. A UUID is recommended.');
      const errors = contractErrors(opts.schema, req.body);
      if (errors.length) fail(422, 'VALIDATION_FAILED', 'The request does not match the mobile API contract.', { errors });
      const body = req.body as Data;
      if (opts.keyEquals && body[opts.keyEquals] !== key) fail(422, 'VALIDATION_FAILED', `Idempotency-Key must equal ${opts.keyEquals}.`);
      const scope = principal ? `${principal.kind}:${principal.actor.id}` : `DEVICE:${text(body, 'deviceId')}`;
      const fingerprint = sha256Text(`POST ${req.baseUrl}${req.path}\n${canonicalJson(body)}`);
      const saved = lookup(scope, key);
      if (saved) {
        if (saved.fingerprint !== fingerprint) fail(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request. Use a new key for new work.');
        res.set('Idempotent-Replayed', 'true').status(saved.status).json(saved.body); return;
      }
      let failure: ApiError | undefined;
      const output = store.transact(() => {
        const result = handler({ req, principal, body });
        if (result instanceof CommitThenFail) { failure = result.error; return undefined; }
        const serialized = JSON.stringify(result);
        store.db.prepare('INSERT INTO mobile_idempotency(scope, key, fingerprint, status, body, encrypted, permanent, created_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(scope, key, fingerprint, opts.status, opts.sensitive ? sealText(store, serialized) : serialized, opts.sensitive ? 1 : 0, opts.permanent ? 1 : 0, store.now());
        return result;
      });
      if (failure) throw failure;
      if (Date.now() - lastCleanup > 3600000) {
        lastCleanup = Date.now();
        store.db.prepare('DELETE FROM mobile_idempotency WHERE permanent=0 AND created_at < ?').run(new Date(Date.parse(store.now()) - 7 * 86400000).toISOString());
      }
      res.status(opts.status).json(output);
    });

  router.use((req, res, next) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.set({ 'X-Request-Id': requestId, 'X-Samford-Api-Version': mobileApiVersion });
    if (req.path === '/meta' || req.path.startsWith('/files/')) { next(); return; }
    const app = String(req.headers['x-samford-app'] ?? ''); const version = Number(req.headers['x-samford-app-version']);
    const minimum = minimumVersions(store);
    const required = app === 'doctor-android' ? minimum.doctor : app === 'patient-android' ? minimum.patient : 0;
    if (required && Number.isFinite(version) && version < required) { next(new ApiError(426, 'APP_UPDATE_REQUIRED', `Update the app to version ${required} or later. Unsent work stays on the device.`, { minimumVersion: required })); return; }
    next();
  });
  router.get('/meta', (req, res) => {
    limit(`ip:${ipOf(req)}`, 120);
    const minimum = minimumVersions(store);
    res.json({ apiVersion: mobileApiVersion, serverVersion: applicationVersion, synthetic: true, minDoctorAppVersion: minimum.doctor, minPatientAppVersion: minimum.patient,
      serverTime: store.now(), docsUrl: 'https://github.com/shivam098/samford-web-app/blob/main/docs/mobile-sync.md' });
  });
  get('/session', 'any', ({ principal }) => principal.kind === 'DOCTOR'
    ? { kind: 'DOCTOR', deviceId: principal.deviceId, expiresAt: principal.expiresAt, doctor: personaDto(store, principal.actor) }
    : { kind: 'PATIENT', deviceId: principal.deviceId, expiresAt: principal.expiresAt, account: { accountId: principal.actor.id, mobileMasked: `******${principal.mobile.slice(-4)}` } });
  router.delete('/session', (req, res) => { limit(`ip:${ipOf(req)}`, 120); revokeSession(store, req); res.status(204).end(); });

  router.get('/doctor/personas', (req, res) => {
    guard(req, 'none');
    const personas = demoIds.map(id => store.db.prepare('SELECT body FROM users WHERE id=?').get(id)).filter(Boolean).map(row => JSON.parse(String(row!.body)))
      .filter(actor => actor.role === 'doctor' && actor.state === 'Active').map(actor => personaDto(store, actor));
    const body = { personas }; const tag = etagOf(body); res.set('ETag', tag);
    if (tagMatches(req, tag)) { res.status(304).end(); return; }
    res.json(body);
  });
  post('/doctor/sessions', { auth: 'none', schema: 'DoctorSessionRequest', limit: '64kb', status: 201, sensitive: true }, ({ req, body }) =>
    doctorSignIn(store, demoIds, text(body, 'personaId'), text(body, 'deviceId'), text(body, 'deviceName') || undefined, Number(req.headers['x-samford-app-version']) || 1));
  get('/doctor/labs', 'doctor', () => ({ labs: labUnits(store) }));
  get('/doctor/queue', 'doctor', ({ req, principal }) => {
    const date = req.query.date === undefined ? istDate(store.now()) : String(req.query.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) fail(422, 'VALIDATION_FAILED', 'date must be YYYY-MM-DD.');
    const order = (entry: Data) => [entry.token === null ? 1 : 0, num(entry, 'token'), text(entry, 'time')] as const;
    const entries = store.visitsFor(principal.actor.id, date).filter(visit => visit.patientId).map(visit => queueEntry(store, visit))
      .sort((a, b) => { const x = order(a); const y = order(b); return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]); });
    return { date, doctorId: principal.actor.id, entries, serverTime: store.now() };
  });
  post('/doctor/queue/:queueEntryId/start', { auth: 'doctor', schema: 'StartVisitRequest', limit: '64kb', status: 200 }, ({ req, principal }) => startVisit(store, principal!.actor, param(req, 'queueEntryId')));
  post('/doctor/walk-ins', { auth: 'doctor', schema: 'WalkInRequest', limit: '64kb', status: 201 }, ({ principal, body }) =>
    queueEntry(store, walkIn(store, principal!.actor, { patientId: body.patientId as string | undefined, name: body.name as string | undefined, age: body.age as number | undefined, sex: body.sex as string | undefined, mobile: body.mobile as string | undefined })));
  get('/doctor/patients/:patientId/record', 'doctor', ({ req, principal, base, viewer }) => {
    const patient = store.maybe(param(req, 'patientId'));
    if (!patient || patient.type !== 'patient') fail(404, 'NOT_FOUND', 'Patient not found.');
    const visitId = req.query.visitId === undefined ? undefined : String(req.query.visitId);
    const care = careVisit(store, principal.actor.id, patient.id, visitId);
    if (!care) {
      store.audit(principal.actor.id, 'doctor', 'record.read', patient.id, null, { channel: 'Doctor tablet', allowed: false }, '', 'Rejected');
      fail(403, 'CARE_RELATIONSHIP_REQUIRED', 'Open the record from a visit with this patient in the last 7 days that has been checked in.');
    }
    store.audit(principal.actor.id, 'doctor', 'record.read', patient.id, null, { channel: 'Doctor tablet', justifyingVisitId: care.id });
    return patientRecord(store, patient, viewer, signedUrls(store, base));
  });
  post('/doctor/visits/:visitId/complete', { auth: 'doctor', schema: 'CompleteVisitRequest', limit: '1mb', status: 201, keyEquals: 'bundleId', permanent: true }, ({ req, principal, body }) =>
    completeVisit(store, principal!.actor, param(req, 'visitId'), body as unknown as CompleteBody, { deviceEntityId: deviceEntityId(principal!.actor.id, principal!.deviceId) }));
  get('/doctor/visits/:visitId/delivery', 'doctor', ({ req, principal }) => {
    const visit = store.maybe(param(req, 'visitId'));
    if (!visit || visit.type !== 'visit' || visit.doctorId !== principal.actor.id) fail(404, 'NOT_FOUND', 'This visit is not in your queue.');
    return visitDelivery(store, visit);
  });
  get('/doctor/documents/:documentId', 'doctor', ({ req, base, viewer }) => documentFor(store, param(req, 'documentId'), viewer, signedUrls(store, base)) ?? fail(404, 'NOT_FOUND', 'Document not found.'));
  post('/doctor/documents/:documentId/addenda', { auth: 'doctor', schema: 'AddendumRequest', limit: '1mb', status: 201, keyEquals: 'clientAddendumId', permanent: true }, ({ req, principal, body }) =>
    signAddendum(store, principal!.actor, param(req, 'documentId'), body as unknown as AddendumBody, deviceEntityId(principal!.actor.id, principal!.deviceId)));
  const feed = (req: Request, audiences: string[]) => {
    const raw = req.query.cursor;
    if (raw !== undefined && (typeof raw !== 'string' || !/^(c1\.\d{1,15})?$/.test(raw))) fail(400, 'INVALID_CURSOR', 'Send nextCursor exactly as returned, or omit cursor to start from the beginning.');
    const cursor = typeof raw === 'string' && raw ? Number(raw.slice(3)) : 0;
    const size = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if (!Number.isInteger(size) || size < 1 || size > 500) fail(400, 'BAD_REQUEST', 'limit must be an integer from 1 to 500.');
    const rows = audiences.length ? store.db.prepare(`SELECT seq, audience, type, at, body FROM feed_events WHERE audience IN (${audiences.map(() => '?').join(',')}) AND seq > ? ORDER BY seq LIMIT ?`).all(...audiences, cursor, size + 1) : [];
    const page = rows.slice(0, size).map(row => ({ seq: Number(row.seq), audience: String(row.audience), type: String(row.type), at: String(row.at), body: JSON.parse(String(row.body)) as Data }));
    return { page, hasMore: rows.length > size, nextCursor: `c1.${page.length ? page.at(-1)!.seq : cursor}` };
  };
  const events = (req: Request, audience: string) => {
    const { page, hasMore, nextCursor } = feed(req, [audience]);
    return { events: page.map(row => ({ eventId: String(row.seq), type: row.type, at: row.at, message: text(row.body, 'message'), visitId: (row.body.visitId ?? null) as Json,
      documentId: (row.body.documentId ?? null) as Json, patientId: (row.body.patientId ?? null) as Json, data: (row.body.data ?? {}) as Json })), nextCursor, hasMore, serverTime: store.now() };
  };
  get('/doctor/events', 'doctor', ({ req, principal }) => events(req, `doctor:${principal.actor.id}`));

  post('/patient/otp/request', { auth: 'none', schema: 'OtpRequest', limit: '64kb', status: 201, sensitive: true }, ({ req, body }) => otpRequest(store, text(body, 'mobile'), text(body, 'deviceId'), ipOf(req), relaxed));
  post('/patient/otp/verify', { auth: 'none', schema: 'OtpVerify', limit: '64kb', status: 201, sensitive: true }, ({ body }) =>
    otpVerify(store, { challengeId: text(body, 'challengeId'), code: text(body, 'code'), deviceId: text(body, 'deviceId'), deviceName: text(body, 'deviceName') || undefined }));
  get('/patient/profiles', 'patient', ({ principal }) => ({ profiles: profilesFor(store, principal.mobile) }));
  const ownProfile = (req: Request, viewer: Viewer) => {
    const profileId = param(req, 'profileId');
    if (viewer.kind !== 'PATIENT' || !viewer.profileIds.has(profileId)) fail(404, 'NOT_FOUND', 'This profile is not linked to your mobile.');
    return profileId;
  };
  get('/patient/profiles/:profileId/record', 'patient', ({ req, base, viewer }) => patientRecord(store, store.get(ownProfile(req, viewer), 'patient'), viewer, signedUrls(store, base)));
  get('/patient/profiles/:profileId/feed', 'patient', ({ req, viewer }) => events(req, `patient:${ownProfile(req, viewer)}`));
  get('/patient/documents/:documentId', 'patient', ({ req, base, viewer }) => documentFor(store, param(req, 'documentId'), viewer, signedUrls(store, base)) ?? fail(404, 'NOT_FOUND', 'Document not found.'));
  post('/patient/documents/:documentId/viewed', { auth: 'patient', schema: 'ViewedRequest', limit: '64kb', status: 200 }, ({ req, principal, body }) => {
    const documentId = param(req, 'documentId'); const profiles = profileIds(principal!);
    const visible = versionsOf(store, documentId).filter(version => profiles.has(version.patientId ?? '') && routingOf(version).patient);
    const latest = visible.at(-1);
    if (!latest) fail(404, 'NOT_FOUND', 'Document not found.');
    const requested = num(body, 'version'); const latestNumber = num(latest.data, 'version');
    if (requested > latestNumber || !visible.some(version => num(version.data, 'version') === requested)) fail(422, 'VALIDATION_FAILED', 'That version of this document does not exist.');
    if (requested < latestNumber) fail(409, 'NOT_LATEST_VERSION', `Version ${latestNumber} replaced this version. Open the latest version.`, { latestVersion: latestNumber });
    const delivery = deliveriesOf(store, documentId).find(item => text(item.data, 'versionEntityId') === latest.id && text(item.data, 'recipient') === 'PATIENT');
    if (!delivery) fail(404, 'NOT_FOUND', 'Document not found.');
    const viewedAt = (entity: typeof delivery) => text([...(entity.data.history as Data[] ?? [])].reverse().find(entry => text(entry, 'state') === 'VIEWED') ?? {}, 'at') || entity.updatedAt;
    if (text(delivery.data, 'state') === 'VIEWED') return { documentId, version: requested, state: 'VIEWED', viewedAt: viewedAt(delivery) };
    const updated = moveDelivery(store, storeWriter(store, principal!.actor.id), delivery, 'VIEWED');
    return { documentId, version: requested, state: 'VIEWED', viewedAt: viewedAt(updated) };
  });
  get('/patient/notifications', 'patient', ({ req, viewer }) => {
    const audiences = viewer.kind === 'PATIENT' ? [...viewer.profileIds].map(id => `patient:${id}`) : [];
    const { page, hasMore, nextCursor } = feed(req, audiences);
    const notifications = page.filter(row => row.body.notify && typeof row.body.notify === 'object').map(row => {
      const notify = row.body.notify as Data;
      return { notificationId: String(row.seq), profileId: row.audience.slice('patient:'.length), type: row.type, title: text(notify, 'title'), body: text(notify, 'body'), at: row.at,
        documentId: (row.body.documentId ?? null) as Json, visitId: (row.body.visitId ?? null) as Json };
    });
    return { notifications, nextCursor, hasMore, serverTime: store.now() };
  });

  const sendBlob = (res: Response, digest: string, cacheControl: string) => {
    const info = blobInfo(store, digest); const bytes = blobBytes(store, digest);
    if (!info || !bytes) fail(404, 'NOT_FOUND', 'Not found.');
    res.set({ 'Content-Type': info.mediaType, 'Content-Length': String(bytes.length), ETag: `"${digest}"`, 'Cache-Control': cacheControl,
      ...(info.mediaType === mediaTypes.pdf ? { 'Content-Disposition': `inline; filename="samford-${digest.slice(0, 12)}.pdf"` } : {}) });
    res.end(bytes);
  };
  router.put('/blobs/:sha256', (req, res, next) => {
    try {
      res.locals.principal = guard(req, 'doctor');
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > blobLimits.pdf) fail(413, 'PAYLOAD_TOO_LARGE', 'Blobs are limited to 25 MiB.');
      next();
    } catch (error) { next(error); }
  }, express.raw({ type: () => true, limit: blobLimits.pdf }), async (req, res) => {
    const principal = res.locals.principal as Principal;
    const mediaType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const { info, created } = await storeBlob(store, sha(req), mediaType, bytes, principal.actor.id);
    res.status(created ? 201 : 200).json({ sha256: info.sha256, size: info.size, mediaType: info.mediaType, widthPx: info.width, heightPx: info.height, createdAt: info.createdAt, created });
  });
  router.head('/blobs/:sha256', (req, res) => { guard(req, 'doctor'); res.status(blobInfo(store, sha(req)) ? 200 : 404).end(); });
  router.get('/blobs/:sha256', (req, res) => {
    const principal = guard(req, 'any')!; const digest = sha(req);
    if (!blobReadable(store, digest, viewerOf(principal))) fail(404, 'NOT_FOUND', 'Not found.');
    if (tagMatches(req, `"${digest}"`)) { res.set('ETag', `"${digest}"`).status(304).end(); return; }
    sendBlob(res, digest, 'private, max-age=31536000, immutable');
  });
  router.get('/files/:sha256', (req, res) => {
    limit(`ip:${ipOf(req)}`, 600);
    const digest = sha(req); const exp = Number(req.query.exp);
    if (!verifySignature(store, digest, exp, String(req.query.sig ?? ''))) fail(403, 'SIGNATURE_INVALID', 'This link expired or is invalid. Refresh the document to get a new link.');
    sendBlob(res, digest, `private, max-age=${Math.max(0, Math.floor(exp - Date.parse(store.now()) / 1000))}`);
  });
  router.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'This mobile API route does not exist. Check the contract version.')));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => sendError(res, error));
  return router;
}
export function sendError(res: Response, error: unknown) {
  const requestId = String(res.locals.requestId ?? randomUUID());
  let status = 500; let code = 'INTERNAL_ERROR'; let message = 'The mock backend could not complete this request. Retry later; keep unsent work on the device.';
  let details: Data | undefined; let retryable = true;
  if (error instanceof ApiError) ({ status, code, message, details, retryable } = error);
  else if (error instanceof DomainError) { status = error.status; code = error.code; message = error.message; retryable = status >= 500 || status === 429; }
  else {
    const bodyError = error as { status?: number; type?: string };
    if (bodyError.status === 413) { status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'This request is larger than the allowed limit.'; retryable = false; }
    else if (bodyError.status === 415) { status = 415; code = 'UNSUPPORTED_MEDIA_TYPE'; message = 'This content encoding or type is not supported.'; retryable = false; }
    else if (bodyError.status === 400) { status = 400; code = 'BAD_REQUEST'; message = 'The request body is not valid JSON.'; retryable = false; }
    else console.error(`Mobile request failure ${requestId}: ${error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error'}`);
  }
  if (res.headersSent) return;
  if (status === 429 && details?.retryAfterSeconds) res.set('Retry-After', String(details.retryAfterSeconds));
  res.status(status).json({ error: { code, message, retryable, ...(details ? { details } : {}), requestId } });
}
