import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { createApplication } from '../server/app.js';
import { anchorFor } from '../server/engine.js';
import { synthesizePage, pagesToPdf, placeholderInk } from '../server/fixtures.js';
import { canonicalJson } from '../server/handwriting.js';
import { contractErrors } from '../server/mobile-validate.js';
import { text, type Data, type CommandRequest, type Entity } from '../shared/model.js';

type Reply = { status: number; headers: Headers; body: any; bytes: Buffer };
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function valid(schema: string, value: unknown) { assert.deepEqual(contractErrors(schema, value), [], `${schema} response violates the contract`); }
function code(reply: Reply, status: number, errorCode: string) {
  assert.equal(reply.status, status, JSON.stringify(reply.body));
  assert.equal(reply.body.error.code, errorCode); valid('Error', reply.body);
  assert.equal(typeof reply.body.error.requestId, 'string');
}

async function backend(options: { relaxed?: boolean } = {}) {
  mkdirSync('test-artifacts', { recursive: true });
  const directory = mkdtempSync(join(resolve('test-artifacts'), 'mobile-'));
  const database = join(directory, 'test.sqlite');
  const relaxed = options.relaxed !== false;
  const start = async () => {
    const runtime = createApplication({ database, dist: 'dist-candidate', test: relaxed, relaxedLimits: relaxed, testSupport: true, isolated: true });
    const server: Server = await new Promise(done => { const server = runtime.app.listen(0, '127.0.0.1', () => done(server)); });
    return { runtime, server };
  };
  let current = await start();
  const origin = () => `http://127.0.0.1:${(current.server.address() as { port: number }).port}`;
  const call = async (method: string, path: string, opts: { token?: string; device?: string; key?: string; json?: unknown; raw?: Buffer; type?: string; headers?: Record<string, string> } = {}): Promise<Reply> => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.device) headers['X-Device-Id'] = opts.device;
    if (opts.key) headers['Idempotency-Key'] = opts.key;
    let body: Uint8Array | string | undefined;
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
    if (opts.raw) { headers['Content-Type'] = opts.type ?? 'application/octet-stream'; body = opts.raw; }
    const response = await fetch(`${origin()}${path.startsWith('/api/') ? path : `/api/mobile/v1${path}`}`, { method, headers, body: body as BodyInit | undefined });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes, body: (response.headers.get('content-type') ?? '').includes('json') && bytes.length ? JSON.parse(bytes.toString('utf8')) : undefined };
  };
  class Device {
    device = `device-${randomUUID()}`; token = '';
    call(method: string, path: string, opts: Parameters<typeof call>[2] = {}) { return call(method, path, { token: this.token, device: this.device, ...opts }); }
    get(path: string, headers?: Record<string, string>) { return this.call('GET', path, { headers }); }
    post(path: string, json: unknown, key: string = randomUUID()) { return this.call('POST', path, { json, key }); }
    async upload(blob: { sha: string; bytes: Buffer; type: string }) { return this.call('PUT', `/blobs/${blob.sha}`, { raw: blob.bytes, type: blob.type }); }
  }
  async function doctor(personaId: string) {
    const tablet = new Device();
    const reply = await call('POST', '/doctor/sessions', { key: randomUUID(), json: { personaId, deviceId: tablet.device, deviceName: 'Test tablet' } });
    assert.equal(reply.status, 201, JSON.stringify(reply.body)); tablet.token = reply.body.token; return tablet;
  }
  async function patient(mobile: string) {
    const phone = new Device();
    const challenge = await call('POST', '/patient/otp/request', { key: randomUUID(), json: { mobile, deviceId: phone.device } });
    assert.equal(challenge.status, 201, JSON.stringify(challenge.body));
    const session = await call('POST', '/patient/otp/verify', { key: randomUUID(), json: { challengeId: challenge.body.challengeId, code: challenge.body.demoCode, deviceId: phone.device } });
    assert.equal(session.status, 201, JSON.stringify(session.body)); valid('PatientSession', session.body);
    phone.token = session.body.token; return Object.assign(phone, { profiles: session.body.profiles as Data[] });
  }
  async function web(actorId: string) {
    const cookies = new Map<string, string>(); const deviceId = `web-${randomUUID()}`;
    const request = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`${origin()}${path}`, { method, headers: { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Samford-Request': '1' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const cookie of response.headers.getSetCookie()) { const entry = cookie.split(';')[0]; const index = entry.indexOf('='); cookies.set(entry.slice(0, index), entry.slice(index + 1)); }
      return { status: response.status, body: (response.headers.get('content-type') ?? '').includes('json') ? await response.json() : await response.text() };
    };
    assert.equal((await request('/api/auth/demo', 'POST', { actorId, deviceId })).status, 200);
    return {
      request,
      async cmd(name: string, payload: Data = {}, targetId?: string, expected = 200) {
        const envelope: CommandRequest = { operationId: randomUUID(), actorId, deviceId, payload, createdAt: current.runtime.store.now(), ...(targetId ? { targetId } : {}) };
        const anchor = anchorFor(current.runtime.store, name, envelope); if (anchor) envelope.expectedVersion = anchor.version;
        const reply = await request(`/api/commands/${name}`, 'POST', envelope);
        assert.equal(reply.status, expected, `${name}: ${JSON.stringify(reply.body).slice(0, 600)}`); return reply.body;
      }
    };
  }
  return {
    get store() { return current.runtime.store; }, call, doctor, patient, web, Device, origin,
    async restart() { await new Promise<void>(done => current.server.close(() => done())); current.runtime.store.close(); current = await start(); },
    async close() { await new Promise<void>(done => current.server.close(() => done())); current.runtime.store.close(); rmSync(directory, { recursive: true, force: true }); }
  };
}
type Blob = { sha: string; bytes: Buffer; type: string };
function handwritten(seed: string, kind: 'summary' | 'prescription' | 'investigations', type: string, title: string, pageCount: number, routing: Data, hints?: Data) {
  const pages = Array.from({ length: pageCount }, (_, index) => synthesizePage(seed, kind, index, 600, 848));
  const pdf = pagesToPdf(pages, title); const ink = placeholderInk(pages);
  const blobs: Blob[] = [...pages.map(page => ({ sha: sha(page.png), bytes: page.png, type: 'image/png' })), { sha: sha(pdf), bytes: pdf, type: 'application/pdf' }, { sha: sha(ink), bytes: ink, type: 'application/vnd.samford.ink+json' }];
  const doc: Data = { clientDocId: randomUUID(), type, title, pages: pages.map((page, index) => ({ index, pngSha256: sha(page.png), widthPx: page.width, heightPx: page.height })),
    pdfSha256: sha(pdf), inkSha256: sha(ink), inkFormat: 'samford-ink-placeholder/0', routing, ...(hints ? { hints } : {}), signedAt: new Date().toISOString() };
  return { doc, blobs };
}
async function allEvents(device: { get(path: string): Promise<Reply> }, path: string) {
  const events: Data[] = []; let cursor = '';
  for (;;) {
    const page = await device.get(`${path}${path.includes('?') ? '&' : '?'}limit=50${cursor ? `&cursor=${cursor}` : ''}`);
    assert.equal(page.status, 200); events.push(...page.body.events); cursor = page.body.nextCursor;
    if (!page.body.hasMore) return { events, cursor, etag: page.headers.get('etag')! };
  }
}

test('mobile v1: metadata, personas, device-bound doctor sign-in, idempotent replay, version gate and sign-out', async () => {
  const b = await backend();
  try {
    const meta = await b.call('GET', '/meta');
    assert.equal(meta.status, 200); valid('Meta', meta.body); assert.equal(meta.body.serverVersion, '0.3.0'); assert.equal(meta.body.minPatientAppVersion, 1);
    const personas = await b.call('GET', '/doctor/personas');
    valid('PersonaList', personas.body); assert.deepEqual(personas.body.personas.map((persona: Data) => persona.personaId), ['doctor-a', 'doctor-b', 'doctor-c']);
    assert.equal((await b.call('GET', '/doctor/personas', { headers: { 'If-None-Match': personas.headers.get('etag')! } })).status, 304);
    const tablet = new b.Device(); const key = randomUUID(); const request = { personaId: 'doctor-a', deviceId: tablet.device, deviceName: 'Ward tablet' };
    const signIn = await b.call('POST', '/doctor/sessions', { key, json: request });
    assert.equal(signIn.status, 201); valid('DoctorSession', signIn.body); assert.equal(signIn.body.doctor.department, 'General medicine');
    const replay = await b.call('POST', '/doctor/sessions', { key, json: request });
    assert.equal(replay.status, 201); assert.equal(replay.body.token, signIn.body.token); assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    code(await b.call('POST', '/doctor/sessions', { key, json: { ...request, deviceName: 'Changed' } }), 422, 'IDEMPOTENCY_KEY_REUSED');
    code(await b.call('POST', '/doctor/sessions', { json: request }), 400, 'IDEMPOTENCY_KEY_REQUIRED');
    code(await b.call('POST', '/doctor/sessions', { key: randomUUID(), json: { ...request, personaId: 'desk' } }), 404, 'UNKNOWN_PERSONA');
    const invalid = await b.call('POST', '/doctor/sessions', { key: randomUUID(), json: { ...request, role: 'admin' } });
    code(invalid, 422, 'VALIDATION_FAILED'); assert.ok(invalid.body.error.details.errors.length);
    tablet.token = signIn.body.token;
    const session = await tablet.get('/session'); valid('SessionInfo', session.body); assert.equal(session.body.kind, 'DOCTOR');
    code(await b.call('GET', '/session', { token: tablet.token, device: 'another-device-123' }), 401, 'DEVICE_MISMATCH');
    code(await b.call('GET', '/doctor/labs', { device: tablet.device }), 401, 'AUTH_REQUIRED');
    code(await tablet.get('/patient/profiles'), 403, 'FORBIDDEN');
    const labs = await tablet.get('/doctor/labs'); valid('LabList', labs.body);
    assert.deepEqual(labs.body.labs.map((lab: Data) => lab.labId).sort(), ['central-lab', 'radiology']);
    const device = b.store.all('device').find(entry => text(entry.data, 'deviceId') === tablet.device)!;
    assert.equal(device.status, 'Active'); assert.equal(text(device.data, 'kind'), 'Doctor tablet (Android)');
    assert.ok(b.store.all('signin').some(entry => text(entry.data, 'deviceId') === tablet.device));
    assert.equal(b.store.get('presence-doctor-a').status, 'Offline', 'tablet sign-in is app activity, not attendance');
    b.store.set('mobileMinVersions', { doctor: 2, patient: 1 });
    code(await tablet.call('GET', '/doctor/labs', { headers: { 'X-Samford-App': 'doctor-android', 'X-Samford-App-Version': '1' } }), 426, 'APP_UPDATE_REQUIRED');
    assert.equal((await b.call('GET', '/meta')).body.minDoctorAppVersion, 2);
    b.store.set('mobileMinVersions', { doctor: 1, patient: 1 });
    code(await tablet.get('/doctor/unknown-route'), 404, 'NOT_FOUND');
    assert.equal((await tablet.call('DELETE', '/session')).status, 204);
    code(await tablet.get('/session'), 401, 'TOKEN_INVALID');
    assert.equal((await tablet.call('DELETE', '/session')).status, 204, 'sign-out is idempotent');
  } finally { await b.close(); }
});

test('paperless OPD round trip: queue, care-scoped record, atomic bundle, pharmacy and labs, results and dispensing back, patient app, addendum', async () => {
  const b = await backend();
  try {
    const doctor = await b.doctor('doctor-a');
    const queue = await doctor.get('/doctor/queue'); assert.equal(queue.status, 200); valid('Queue', queue.body);
    const entry = (id: string) => queue.body.entries.find((item: Data) => item.visitId === id);
    assert.equal(entry('visit-a').status, 'WAITING'); assert.equal(entry('visit-a').token, 1); assert.equal(entry('visit-a').returning, true); assert.equal(entry('visit-a').priorDocumentCount, 3);
    assert.deepEqual(entry('visit-a').patient.allergies.map((allergy: Data) => allergy.substance), ['Penicillin']);
    assert.equal(entry('visit-b').returning, true); assert.equal(entry('visit-video').status, 'BOOKED'); assert.equal(entry('visit-video').token, null);
    assert.equal((await doctor.get('/doctor/queue', { 'If-None-Match': queue.headers.get('etag')! })).status, 304);
    code(await doctor.post('/doctor/queue/visit-video/start', { identityConfirmed: true }), 409, 'NOT_CHECKED_IN');
    code(await doctor.post('/doctor/queue/visit-c/start', { identityConfirmed: true }), 404, 'NOT_FOUND');

    const record = await doctor.get('/doctor/patients/patient-a/record'); assert.equal(record.status, 200); valid('PatientRecord', record.body);
    const history = record.body.visits.find((visit: Data) => visit.visitId === 'visit-history-a');
    assert.equal(history.doctorName, 'Demo doctor C'); assert.equal(history.documents.length, 3);
    const oldRx = history.documents.find((doc: Data) => doc.type === 'PRESCRIPTION');
    assert.equal(oldRx.recipients.find((recipient: Data) => recipient.kind === 'PHARMACY').state, 'DISPENSED');
    assert.ok(record.body.labResults.some((result: Data) => result.testName === 'Haemoglobin (CBC)' && result.flag === 'ABNORMAL'));
    const signedPage = await fetch(oldRx.versions[0].pages[0].url); assert.equal(signedPage.status, 200); assert.equal(signedPage.headers.get('content-type'), 'image/png');
    assert.ok(b.store.audits().some(entry => entry.action === 'record.read' && entry.target === 'patient-a' && entry.result === 'Accepted'));
    code(await doctor.get('/doctor/patients/patient-c/record'), 403, 'CARE_RELATIONSHIP_REQUIRED');
    assert.ok(b.store.audits().some(entry => entry.action === 'record.read' && entry.target === 'patient-c' && entry.result === 'Rejected'));

    const summary = handwritten('e2e-summary', 'summary', 'VISIT_SUMMARY', 'Visit summary', 2, { pharmacy: false, labs: [], patient: true }, { diagnosis: 'Synthetic: review' });
    const rx = handwritten('e2e-rx', 'prescription', 'PRESCRIPTION', 'Prescription', 1, { pharmacy: true, labs: [], patient: true }, { medicines: [{ name: 'Sample Paracetamol 500', dose: '1 tablet', frequency: 'TDS', durationDays: 3 }] });
    const tests = handwritten('e2e-tests', 'investigations', 'INVESTIGATIONS', 'Investigations', 1, { pharmacy: false, labs: ['central-lab', 'radiology'], patient: true });
    const bundleId = randomUUID();
    const bundle = { bundleId, completedAt: new Date().toISOString(), documents: [summary.doc, rx.doc, tests.doc], followUp: { date: '2099-01-01', note: 'Synthetic follow-up' } };
    code(await doctor.post('/doctor/visits/visit-a/complete', bundle, bundleId), 409, 'VISIT_NOT_STARTED');
    const started = await doctor.post('/doctor/queue/visit-a/start', { identityConfirmed: true });
    assert.equal(started.status, 200); valid('StartVisitResponse', started.body); assert.equal(started.body.status, 'IN_CONSULTATION');
    assert.equal((await doctor.post('/doctor/queue/visit-a/start', { identityConfirmed: true })).body.startedAt, started.body.startedAt);

    for (const blob of summary.blobs) assert.equal((await doctor.upload(blob)).status, 201);
    const missing = await doctor.post('/doctor/visits/visit-a/complete', bundle, bundleId);
    code(missing, 409, 'MISSING_BLOBS'); assert.equal(missing.body.error.retryable, true);
    assert.deepEqual(missing.body.error.details.missing.map((item: Data) => item.sha256).sort(), [...rx.blobs, ...tests.blobs].map(blob => blob.sha).sort());
    assert.deepEqual([...new Set(missing.body.error.details.missing.map((item: Data) => item.role))].sort(), ['INK', 'PAGE', 'PDF']);
    assert.equal(b.store.get('visit-a').status, 'In consultation', 'a rejected bundle changes nothing');
    for (const blob of [...rx.blobs, ...tests.blobs]) {
      assert.equal((await doctor.call('HEAD', `/blobs/${blob.sha}`)).status, 404);
      assert.equal((await doctor.upload(blob)).status, 201);
    }
    assert.equal((await doctor.upload(rx.blobs[0])).body.created, false);
    const done = await doctor.post('/doctor/visits/visit-a/complete', bundle, bundleId);
    assert.equal(done.status, 201, JSON.stringify(done.body)); valid('CompleteVisitResponse', done.body);
    assert.equal(done.body.recordHash, createHash('sha256').update(canonicalJson({ schema: 'samford-bundle/1', bundleId, visitId: 'visit-a', recordHashes: done.body.documents.map((doc: Data) => doc.recordHash) })).digest('hex'));
    const replay = await doctor.post('/doctor/visits/visit-a/complete', bundle, bundleId);
    assert.equal(replay.status, 201); assert.deepEqual(replay.body, done.body); assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    const second = { ...bundle, bundleId: randomUUID() };
    const conflict = await doctor.post('/doctor/visits/visit-a/complete', second, second.bundleId);
    code(conflict, 409, 'VISIT_ALREADY_COMPLETED'); assert.equal(conflict.body.error.details.bundleId, bundleId);
    const [summaryId, rxId, testsId] = done.body.documents.map((doc: Data) => doc.documentId as string);
    assert.equal(b.store.get('visit-a').status, 'Done');
    assert.ok(b.store.all('coding').some(entry => text(entry.data, 'sourceId') === 'visit-a' && entry.data.handwritten === true));
    assert.equal(b.store.get(done.body.followUpId).status, 'Requested');
    assert.equal((await doctor.get('/doctor/queue')).body.entries.find((item: Data) => item.visitId === 'visit-a').status, 'COMPLETED');
    const delivery = await doctor.get('/doctor/visits/visit-a/delivery'); valid('VisitDelivery', delivery.body);
    const recipients = (documentId: string) => delivery.body.documents.find((doc: Data) => doc.documentId === documentId).recipients.map((item: Data) => `${item.kind}:${item.labId ?? ''}:${item.state}`).sort();
    assert.deepEqual(recipients(summaryId), ['PATIENT::AVAILABLE']);
    assert.deepEqual(recipients(rxId), ['PATIENT::AVAILABLE', 'PHARMACY::AVAILABLE']);
    assert.deepEqual(recipients(testsId), ['LAB:central-lab:AVAILABLE', 'LAB:radiology:AVAILABLE', 'PATIENT::AVAILABLE']);

    const pharmacy = await b.web('pharmacy');
    const pharmacyDocs = (await pharmacy.request('/api/entities?type=handwrittenDocument')).body as Entity[];
    assert.ok(pharmacyDocs.length >= 4 && pharmacyDocs.every(doc => text(doc.data, 'type') === 'PRESCRIPTION'));
    const pharmacyCopy = `${rxId}-v1-pharmacy`;
    await pharmacy.cmd('handwriting.dispense', { outcome: 'Dispensed' }, pharmacyCopy, 422);
    await pharmacy.cmd('handwriting.view', {}, pharmacyCopy);
    await pharmacy.cmd('handwriting.dispense', { outcome: 'Partially dispensed' }, pharmacyCopy, 422);
    await pharmacy.cmd('handwriting.dispense', { outcome: 'Partially dispensed', note: 'Synthetic: one item out of stock' }, pharmacyCopy);
    await pharmacy.cmd('handwriting.dispense', { outcome: 'Dispensed' }, pharmacyCopy);
    const lab = await b.web('lab'); const radiology = await b.web('radiology'); const verifier = await b.web('verifier');
    await lab.cmd('handwriting.view', {}, pharmacyCopy, 404);
    const labCopy = `${testsId}-v1-lab-central-lab`; const imagingCopy = `${testsId}-v1-lab-radiology`;
    await lab.cmd('handwriting.view', {}, imagingCopy, 404);
    await radiology.cmd('handwriting.view', {}, labCopy, 404);
    await lab.cmd('handwriting.view', {}, labCopy);
    await lab.cmd('handwriting.result', { testName: 'Serum potassium', value: '6.9', flag: 'Critical' }, labCopy, 422);
    await lab.cmd('handwriting.sample', { confirmed: true }, labCopy);
    await lab.cmd('handwriting.result', { testName: 'Serum potassium', value: '6.9', unit: 'mmol/L', refRange: '3.5-5.1', flag: 'Critical', summary: 'Synthetic critical value' }, labCopy);
    assert.ok(!(await doctor.get('/doctor/patients/patient-a/record')).body.labResults.some((result: Data) => result.testName === 'Serum potassium'), 'entered results stay hidden until verified');
    const denied = await lab.cmd('handwriting.verify', { confirmed: true }, labCopy, 422); assert.equal(denied.code, 'ACCESS_DENIED');
    await verifier.cmd('handwriting.verify', { confirmed: true }, labCopy);
    await radiology.cmd('handwriting.view', {}, imagingCopy);
    await radiology.cmd('handwriting.sample', { confirmed: true, note: 'Synthetic imaging done' }, imagingCopy);
    await radiology.cmd('handwriting.result', { testName: 'Chest X-ray', value: 'No synthetic abnormality', flag: 'Normal' }, imagingCopy);
    await verifier.cmd('handwriting.verify', { confirmed: true }, imagingCopy);

    const feed = await allEvents(doctor, '/doctor/events');
    for (const event of feed.events) valid('Event', event);
    const types = feed.events.map(event => `${event.type}:${text((event.data ?? {}) as Data, 'state')}`);
    for (const expected of ['DOCUMENT_SIGNED:', 'DOCUMENT_STATE_CHANGED:PARTIALLY_DISPENSED', 'DOCUMENT_STATE_CHANGED:DISPENSED', 'DOCUMENT_STATE_CHANGED:SAMPLE_COLLECTED', 'DOCUMENT_STATE_CHANGED:RESULT_READY', 'LAB_RESULT_READY:', 'QUEUE_UPDATED:']) assert.ok(types.includes(expected), expected);
    assert.ok(feed.events.some(event => event.type === 'LAB_RESULT_READY' && (event.data as Data).flag === 'CRITICAL'));
    const ids = feed.events.map(event => Number(event.eventId)); assert.deepEqual(ids, [...ids].sort((x, y) => x - y));
    const caughtUp = await doctor.get(`/doctor/events?cursor=${feed.cursor}`); assert.deepEqual(caughtUp.body.events, []); assert.equal(caughtUp.body.nextCursor, feed.cursor);
    assert.equal((await doctor.get(`/doctor/events?cursor=${feed.cursor}`, { 'If-None-Match': caughtUp.headers.get('etag')! })).status, 304);
    code(await doctor.get('/doctor/events?cursor=bogus'), 400, 'INVALID_CURSOR');
    const after = await doctor.get('/doctor/visits/visit-a/delivery');
    const states = (documentId: string) => after.body.documents.find((doc: Data) => doc.documentId === documentId).recipients.map((item: Data) => `${item.kind}:${item.labId ?? ''}:${item.state}`).sort();
    assert.deepEqual(states(rxId), ['PATIENT::AVAILABLE', 'PHARMACY::DISPENSED']);
    assert.deepEqual(states(testsId), ['LAB:central-lab:RESULT_READY', 'LAB:radiology:RESULT_READY', 'PATIENT::AVAILABLE']);

    const phone = await b.patient('9000000001');
    assert.deepEqual(phone.profiles.map(profile => profile.profileId).sort(), ['patient-a', 'patient-child']);
    const profiles = await phone.get('/patient/profiles'); valid('ProfileList', profiles.body);
    const mine = await phone.get('/patient/profiles/patient-a/record'); valid('PatientRecord', mine.body);
    assert.equal(mine.body.visits.find((visit: Data) => visit.visitId === 'visit-a').documents.length, 3);
    assert.ok(mine.body.labResults.some((result: Data) => result.testName === 'Serum potassium' && result.flag === 'CRITICAL'));
    assert.equal((await phone.get('/patient/profiles/patient-a/record', { 'If-None-Match': mine.headers.get('etag')! })).status, 304);
    const patientFeed = await allEvents(phone, '/patient/profiles/patient-a/feed');
    const patientTypes = new Set(patientFeed.events.map(event => event.type));
    for (const type of ['VISIT_UPDATED', 'DOCUMENT_AVAILABLE', 'DOCUMENT_STATE_CHANGED', 'LAB_RESULT_READY']) assert.ok(patientTypes.has(type), type);
    assert.ok(!JSON.stringify(patientFeed.events).includes('6.9'), 'patient feed messages carry no result values');
    const notices = await phone.get('/patient/notifications?limit=500'); valid('NotificationPage', notices.body);
    const titles = new Set(notices.body.notifications.map((notice: Data) => notice.title));
    for (const title of ['New document', 'Prescription dispensed', 'Result ready']) assert.ok(titles.has(title), title);
    assert.ok(!/6\.9|potassium/i.test(JSON.stringify(notices.body.notifications)));
    const polled = await phone.get(`/patient/notifications?cursor=${notices.body.nextCursor}`);
    assert.deepEqual(polled.body.notifications, []);
    assert.equal((await phone.get(`/patient/notifications?cursor=${notices.body.nextCursor}`, { 'If-None-Match': polled.headers.get('etag')! })).status, 304);
    const viewed = await phone.post(`/patient/documents/${rxId}/viewed`, { version: 1 }); assert.equal(viewed.status, 200, JSON.stringify(viewed.body)); valid('ViewedResponse', viewed.body);
    assert.equal((await phone.post(`/patient/documents/${rxId}/viewed`, { version: 1 })).body.viewedAt, viewed.body.viewedAt);
    assert.ok((await doctor.get('/doctor/visits/visit-a/delivery')).body.documents.find((doc: Data) => doc.documentId === rxId).recipients.some((item: Data) => item.kind === 'PATIENT' && item.state === 'VIEWED'));
    const page = rx.blobs[0];
    const blob = await phone.get(`/blobs/${page.sha}`);
    assert.equal(blob.status, 200); assert.ok(blob.bytes.equals(page.bytes)); assert.match(blob.headers.get('cache-control') ?? '', /immutable/); assert.equal(blob.headers.get('etag'), `"${page.sha}"`);
    assert.equal((await phone.get(`/blobs/${page.sha}`, { 'If-None-Match': `"${page.sha}"` })).status, 304);
    code(await phone.get(`/blobs/${'0'.repeat(64)}`), 404, 'NOT_FOUND');
    const detail = await phone.get(`/patient/documents/${rxId}`); valid('ClinicalDocument', detail.body);
    const url = new URL(detail.body.versions[0].pdfUrl);
    assert.equal((await fetch(url)).status, 200);
    url.searchParams.set('sig', '0'.repeat(40)); assert.equal((await fetch(url)).status, 403);
    const stranger = await b.patient('9000000003');
    code(await stranger.get(`/patient/documents/${rxId}`), 404, 'NOT_FOUND');
    code(await stranger.get(`/blobs/${page.sha}`), 404, 'NOT_FOUND');
    code(await stranger.get('/patient/profiles/patient-a/record'), 404, 'NOT_FOUND');
    const outsider = await b.doctor('doctor-b');
    code(await outsider.get(`/doctor/documents/${rxId}`), 404, 'NOT_FOUND');
    code(await outsider.get(`/blobs/${page.sha}`), 404, 'NOT_FOUND');

    const amended = handwritten('e2e-rx-v2', 'prescription', 'PRESCRIPTION', 'Prescription', 1, { pharmacy: true, labs: [], patient: true });
    for (const item of amended.blobs) await doctor.upload(item);
    const addendum = { clientAddendumId: randomUUID(), baseVersion: 1, reason: 'Synthetic dose correction', pages: amended.doc.pages, pdfSha256: amended.doc.pdfSha256, inkSha256: amended.doc.inkSha256, inkFormat: amended.doc.inkFormat, signedAt: new Date().toISOString() };
    code(await doctor.post(`/doctor/documents/${rxId}/addenda`, { ...addendum, baseVersion: 2 }, addendum.clientAddendumId), 409, 'NOT_LATEST_VERSION');
    code(await doctor.post(`/doctor/documents/${rxId}/addenda`, addendum), 422, 'VALIDATION_FAILED');
    code(await outsider.post(`/doctor/documents/${rxId}/addenda`, addendum, addendum.clientAddendumId), 404, 'NOT_FOUND');
    const signed = await doctor.post(`/doctor/documents/${rxId}/addenda`, addendum, addendum.clientAddendumId);
    assert.equal(signed.status, 201, JSON.stringify(signed.body)); valid('AddendumResponse', signed.body); assert.equal(signed.body.version, 2);
    assert.deepEqual((await doctor.post(`/doctor/documents/${rxId}/addenda`, addendum, addendum.clientAddendumId)).body, signed.body);
    const versions = await doctor.get(`/doctor/documents/${rxId}`); valid('ClinicalDocument', versions.body);
    assert.deepEqual(versions.body.versions.map((version: Data) => version.version), [1, 2]);
    assert.equal(versions.body.versions[1].reason, 'Synthetic dose correction'); assert.notEqual(versions.body.versions[0].recordHash, versions.body.versions[1].recordHash);
    assert.deepEqual(versions.body.recipients.map((item: Data) => `${item.kind}:${item.state}:${item.version}`).sort(), ['PATIENT:AVAILABLE:2', 'PHARMACY:AVAILABLE:2']);
    assert.equal(b.store.get(pharmacyCopy).status, 'Superseded'); assert.equal(text(b.store.get(`${rxId}-v1`).data, 'recordHash'), done.body.documents[1].recordHash, 'version 1 is never rewritten');
    await pharmacy.cmd('handwriting.view', {}, pharmacyCopy, 422);
    code(await phone.post(`/patient/documents/${rxId}/viewed`, { version: 1 }), 409, 'NOT_LATEST_VERSION');
    assert.ok((await allEvents(phone, '/patient/profiles/patient-a/feed')).events.some(event => event.type === 'DOCUMENT_AMENDED' && event.documentId === rxId));
    assert.equal((await phone.get(`/blobs/${page.sha}`)).status, 200, 'earlier versions remain readable');

    const desk = await b.web('desk'); const mrd = await b.web('mrd'); const admin = await b.web('admin');
    assert.deepEqual((await desk.request('/api/entities?type=handwrittenDocument')).body, []);
    assert.deepEqual((await admin.request('/api/entities?type=handwrittenDocument')).body, []);
    assert.ok(((await mrd.request('/api/entities?type=handwrittenDocument')).body as Entity[]).every(doc => text(doc.data, 'type') === 'VISIT_SUMMARY'));
  } finally { await b.close(); }
});

test('blob and bundle validation: hashes, types, structure, limits, dimensions, routing and key binding', async () => {
  const b = await backend();
  try {
    const doctor = await b.doctor('doctor-b');
    const walk = await doctor.post('/doctor/walk-ins', { name: 'Synthetic validation walk-in', age: 40, sex: 'Female', mobile: '9000077001' });
    assert.equal(walk.status, 201, JSON.stringify(walk.body)); valid('QueueEntry', walk.body); assert.equal(walk.body.demoWalkIn, true); assert.equal(walk.body.status, 'WAITING');
    code(await doctor.post('/doctor/walk-ins', { name: 'Synthetic validation walk-in', age: 40, sex: 'Female', mobile: '9000077001' }), 422, 'VALIDATION_FAILED');
    const visitId = walk.body.visitId as string;
    await doctor.post(`/doctor/queue/${visitId}/start`, { identityConfirmed: true });
    const doc = handwritten('validation', 'summary', 'VISIT_SUMMARY', 'Visit summary', 1, { pharmacy: false, labs: [], patient: true });
    const [png, pdf, ink] = doc.blobs;
    code(await doctor.call('PUT', `/blobs/${'a'.repeat(64)}`, { raw: png.bytes, type: 'image/png' }), 422, 'HASH_MISMATCH');
    code(await doctor.call('PUT', `/blobs/${png.sha}`, { raw: png.bytes, type: 'image/jpeg' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
    const corrupt = Buffer.from(png.bytes); corrupt[corrupt.length - 20] ^= 0xff;
    code(await doctor.call('PUT', `/blobs/${sha(corrupt)}`, { raw: corrupt, type: 'image/png' }), 422, 'BLOB_INVALID');
    const tiny = synthesizePage('tiny', 'summary', 0, 150, 150).png;
    code(await doctor.call('PUT', `/blobs/${sha(tiny)}`, { raw: tiny, type: 'image/png' }), 422, 'BLOB_INVALID');
    const notPdf = Buffer.from('%PDF-1.7\nnot really a pdf\n%%EOF\n');
    code(await doctor.call('PUT', `/blobs/${sha(notPdf)}`, { raw: notPdf, type: 'application/pdf' }), 422, 'BLOB_INVALID');
    const notJson = Buffer.from('[1,2,3]');
    code(await doctor.call('PUT', `/blobs/${sha(notJson)}`, { raw: notJson, type: 'application/vnd.samford.ink+json' }), 422, 'BLOB_INVALID');
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1);
    code(await doctor.call('PUT', `/blobs/${sha(huge)}`, { raw: huge, type: 'image/png' }), 413, 'PAYLOAD_TOO_LARGE');
    for (const blob of doc.blobs) assert.equal((await doctor.upload(blob)).status, 201);
    code(await doctor.call('PUT', `/blobs/${pdf.sha}`, { raw: pdf.bytes, type: 'image/png' }), 422, 'BLOB_TYPE_MISMATCH');
    const phone = await b.patient('9000077001');
    code(await phone.upload(png), 403, 'FORBIDDEN');
    const complete = async (documents: Data[], key = randomUUID(), bundleId = key) => doctor.post(`/doctor/visits/${visitId}/complete`, { bundleId, completedAt: new Date().toISOString(), documents }, key);
    code(await complete([doc.doc], randomUUID(), randomUUID()), 422, 'VALIDATION_FAILED');
    code(await complete([{ ...doc.doc, pages: [{ ...(doc.doc.pages as Data[])[0], widthPx: 601 }] }]), 422, 'PAGE_DIMENSIONS_MISMATCH');
    code(await complete([{ ...doc.doc, pdfSha256: ink.sha }]), 422, 'BLOB_TYPE_MISMATCH');
    code(await complete([{ ...doc.doc, routing: { pharmacy: true, labs: [], patient: true } }]), 422, 'ROUTING_INVALID');
    code(await complete([{ ...doc.doc, type: 'INVESTIGATIONS', routing: { pharmacy: false, labs: ['no-such-lab'], patient: true } }]), 422, 'UNKNOWN_LAB');
    code(await complete([{ ...doc.doc, pages: [{ ...(doc.doc.pages as Data[])[0], index: 1 }] }]), 422, 'VALIDATION_FAILED');
    code(await complete([{ ...doc.doc, inkSha256: null }]), 422, 'VALIDATION_FAILED');
    code(await complete([doc.doc, { ...doc.doc }]), 422, 'VALIDATION_FAILED');
    assert.equal(b.store.get(visitId).status, 'In consultation');
    const ok = await complete([doc.doc]); assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const visit = await phone.get(`/patient/profiles/${walk.body.patient.patientId}/record`);
    assert.equal(visit.body.visits[0].documents[0].documentId, ok.body.documents[0].documentId);
  } finally { await b.close(); }
});

test('patient OTP limits, wrong-code lock shared with the web portal, token expiry and care window (production limits)', async () => {
  const b = await backend({ relaxed: false });
  try {
    const phone = new b.Device();
    code(await b.call('POST', '/patient/otp/request', { key: randomUUID(), json: { mobile: '9999999999', deviceId: phone.device } }), 404, 'MOBILE_NOT_REGISTERED');
    const key = randomUUID();
    const first = await b.call('POST', '/patient/otp/request', { key, json: { mobile: '9000000002', deviceId: phone.device } });
    assert.equal(first.status, 201); valid('OtpChallenge', first.body); assert.match(first.body.demoNotice, /SYNTHETIC/);
    const again = await b.call('POST', '/patient/otp/request', { key: randomUUID(), json: { mobile: '9000000002', deviceId: phone.device } });
    code(again, 429, 'OTP_RATE_LIMITED'); assert.ok(Number(again.headers.get('retry-after')) > 0);
    const replayed = await b.call('POST', '/patient/otp/request', { key, json: { mobile: '9000000002', deviceId: phone.device } });
    assert.equal(replayed.body.challengeId, first.body.challengeId); assert.equal(replayed.headers.get('idempotent-replayed'), 'true');
    const stored = b.store.db.prepare('SELECT body, encrypted FROM mobile_idempotency WHERE key=?').get(key)!;
    assert.equal(Number(stored.encrypted), 1); assert.ok(!String(stored.body).includes(first.body.demoCode), 'replayable codes are encrypted at rest');
    const verify = (challengeId: string, otp: string) => b.call('POST', '/patient/otp/verify', { key: randomUUID(), json: { challengeId, code: otp, deviceId: phone.device } });
    const wrong = first.body.demoCode === '111111' ? '222222' : '111111';
    const one = await verify(first.body.challengeId, wrong); code(one, 401, 'OTP_INVALID'); assert.equal(one.body.error.details.attemptsRemaining, 2);
    code(await verify(first.body.challengeId, wrong), 401, 'OTP_INVALID');
    code(await verify(first.body.challengeId, wrong), 429, 'OTP_LOCKED');
    code(await verify(first.body.challengeId, first.body.demoCode), 401, 'OTP_EXPIRED');
    code(await b.call('POST', '/patient/otp/request', { key: randomUUID(), json: { mobile: '9000000002', deviceId: phone.device } }), 429, 'OTP_LOCKED');
    assert.ok(b.store.setting<number>('patientLock:9000000002', 0) > Date.now(), 'the lock is the same setting the web portal checks');
    assert.equal((await b.call('POST', '/api/test-support/clock', { json: { minutes: 31 } })).status, 200);
    const fresh = await b.call('POST', '/patient/otp/request', { key: randomUUID(), json: { mobile: '9000000002', deviceId: phone.device } });
    assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
    code(await b.call('POST', '/patient/otp/verify', { key: randomUUID(), json: { challengeId: fresh.body.challengeId, code: fresh.body.demoCode, deviceId: 'other-device-1' } }), 401, 'DEVICE_MISMATCH');
    const session = await verify(fresh.body.challengeId, fresh.body.demoCode);
    assert.equal(session.status, 201); phone.token = session.body.token;
    assert.deepEqual(session.body.profiles.map((profile: Data) => profile.profileId), ['patient-b']);
    const record = await phone.get('/patient/profiles/patient-b/record');
    const rx = record.body.visits.find((visit: Data) => visit.visitId === 'visit-history-b').documents.find((doc: Data) => doc.type === 'PRESCRIPTION');
    assert.deepEqual(rx.versions.map((version: Data) => version.version), [1, 2]); assert.equal(rx.versions[1].reason, 'Corrected dose and duration (synthetic sample)');
    const tablet = await b.doctor('doctor-a');
    assert.equal((await tablet.get('/doctor/patients/patient-b/record')).status, 200);
    await b.call('POST', '/api/test-support/clock', { json: { minutes: 8 * 24 * 60 } });
    code(await tablet.get('/doctor/labs'), 401, 'TOKEN_EXPIRED');
    assert.equal((await phone.get('/patient/profiles')).status, 200, 'patient tokens last 90 days');
    await b.call('POST', '/api/test-support/clock', { json: { minutes: 83 * 24 * 60 } });
    code(await phone.get('/patient/profiles'), 401, 'TOKEN_EXPIRED');
  } finally { await b.close(); }
});

test('front-desk check-in feeds the tablet, follow-up reaches the desk, completion survives restart, IT sign-out revokes the tablet', async () => {
  const b = await backend();
  try {
    const checkIn = await b.call('POST', '/api/test-support/visits', { json: { doctorId: 'doctor-b', patient: { name: 'Synthetic desk patient', age: 33, sex: 'Male', mobile: '9000077002' } } });
    assert.equal(checkIn.status, 201, JSON.stringify(checkIn.body));
    const doctor = await b.doctor('doctor-b');
    const queued = (await doctor.get('/doctor/queue')).body.entries.find((item: Data) => item.visitId === checkIn.body.visitId);
    assert.equal(queued.status, 'WAITING'); assert.equal(queued.token, checkIn.body.token); assert.equal(queued.returning, false); assert.equal(queued.demoWalkIn, false);
    assert.ok((await allEvents(doctor, '/doctor/events')).events.some(event => event.type === 'QUEUE_UPDATED' && event.visitId === checkIn.body.visitId && (event.data as Data).status === 'WAITING'));
    await doctor.post(`/doctor/queue/${checkIn.body.visitId}/start`, { identityConfirmed: true });
    const rx = handwritten('restart-rx', 'prescription', 'PRESCRIPTION', 'Prescription', 1, { pharmacy: true, labs: [], patient: true });
    for (const blob of rx.blobs) await doctor.upload(blob);
    const bundleId = randomUUID();
    const bundle = { bundleId, completedAt: new Date().toISOString(), documents: [rx.doc], followUp: { date: '2099-02-02', requestBooking: true } };
    const done = await doctor.post(`/doctor/visits/${checkIn.body.visitId}/complete`, bundle, bundleId);
    assert.equal(done.status, 201, JSON.stringify(done.body));
    const desk = await b.web('desk');
    assert.ok(((await desk.request('/api/entities?type=followup')).body as Entity[]).some(entry => entry.id === done.body.followUpId && entry.status === 'Requested'));
    const pharmacyReply = await b.call('POST', '/api/test-support/deliveries', { json: { documentId: done.body.documents[0].documentId, recipient: 'PHARMACY', state: 'DISPENSED' } });
    assert.equal(pharmacyReply.status, 200, JSON.stringify(pharmacyReply.body)); assert.equal(pharmacyReply.body.delivery.state, 'DISPENSED');
    const feedBefore = await allEvents(doctor, '/doctor/events');
    await b.restart();
    const replay = await doctor.post(`/doctor/visits/${checkIn.body.visitId}/complete`, bundle, bundleId);
    assert.equal(replay.status, 201); assert.deepEqual(replay.body, done.body);
    assert.equal((await doctor.get(`/doctor/events?cursor=${feedBefore.cursor}`)).body.events.length, 0, 'cursors survive restart');
    const phone = await b.patient('9000077002');
    assert.equal((await phone.get(`/patient/documents/${done.body.documents[0].documentId}`)).body.recipients.find((item: Data) => item.kind === 'PHARMACY').state, 'DISPENSED');
    const device = b.store.all('device').find(entry => text(entry.data, 'deviceId') === doctor.device)!;
    const it = await b.web('it');
    await it.cmd('device.signout', { reason: 'Synthetic lost tablet', confirmed: true }, device.id);
    code(await doctor.get('/doctor/queue'), 401, 'DEVICE_SIGNED_OUT');
    const oldToken = doctor.token;
    const again = await b.call('POST', '/doctor/sessions', { key: randomUUID(), json: { personaId: 'doctor-b', deviceId: doctor.device } });
    assert.equal(again.status, 201); doctor.token = again.body.token;
    assert.equal((await doctor.get('/doctor/queue')).status, 200);
    code(await b.call('GET', '/doctor/queue', { token: oldToken, device: doctor.device }), 401, 'DEVICE_SIGNED_OUT');
    const admin = await b.web('admin');
    await admin.cmd('account.suspend', { reason: 'Synthetic suspension test', confirmed: true }, 'doctor-b');
    code(await doctor.get('/doctor/queue'), 401, 'ACCESS_REVOKED');
    code(await b.call('POST', '/doctor/sessions', { key: randomUUID(), json: { personaId: 'doctor-b', deviceId: doctor.device } }), 404, 'UNKNOWN_PERSONA');
    await admin.cmd('account.reactivate', { reason: 'Synthetic return' }, 'doctor-b');
    code(await doctor.get('/doctor/queue'), 401, 'TOKEN_INVALID');
  } finally { await b.close(); }
});
