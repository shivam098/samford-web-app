// Release smoke for the paperless OPD backend: origin safety, mobile v1 behaviour and handwritten-record access.
// Usage: node --import tsx scripts/release-smoke.ts --base <url> [--mode readonly|full] [--release <release dir>] [--out <proof.json>]
// readonly is safe on the live/public demo. It signs demo sessions in and out, reads, and checks refusals. It sends no clinical command.
// full also runs the paperless round trip (desk check-in -> tablet -> pharmacy -> patient app). It writes clinical records, so it
// refuses anything but a loopback rehearsal server off the live port 4317.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { synthesizePage, pagesToPdf, placeholderInk } from '../server/fixtures.js';

type Data = Record<string, any>;
type Reply = { status: number; headers: Headers; bytes: Buffer; body: any };
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index].replace(/^--/, ''), process.argv[index + 1] ?? '');
const base = (args.get('base') ?? '').replace(/\/$/, '');
const mode = args.get('mode') ?? 'readonly';
if (!/^https?:\/\/[^/]+$/.test(base) || !['readonly', 'full'].includes(mode)) throw new Error('Pass --base <scheme://host[:port]> and --mode readonly|full.');
const target = new URL(base);
if (mode === 'full' && (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || ['', '4317'].includes(target.port))) {
  throw new Error('full mode writes clinical records. It only runs against a loopback rehearsal server, never the live port 4317 or a public URL.');
}
const release = args.get('release') ? JSON.parse(readFileSync(join(args.get('release')!, 'release.json'), 'utf8')) as { version: string; source: string; hashes: Record<string, string> } : undefined;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const steps: string[] = []; const facts: Data = {};
const ok = (message: string) => { steps.push(message); console.log(`ok - ${message}`); };

async function http(method: string, path: string, opts: { token?: string; device?: string; key?: string; json?: unknown; raw?: Buffer; type?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.device) headers['X-Device-Id'] = opts.device;
  if (opts.key) headers['Idempotency-Key'] = opts.key;
  let body: BodyInit | undefined;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  if (opts.raw) { headers['Content-Type'] = opts.type ?? 'application/octet-stream'; body = new Uint8Array(opts.raw); }
  const response = await fetch(`${base}${path}`, { method, headers, body, redirect: 'manual' });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, bytes, body: (response.headers.get('content-type') ?? '').includes('json') && bytes.length ? JSON.parse(bytes.toString('utf8')) : undefined };
}
const expectError = (reply: Reply, status: number, code: string) => { assert.equal(reply.status, status, JSON.stringify(reply.body)); assert.equal(reply.body?.error?.code, code); };
class Device {
  device = `smoke-${randomUUID()}`; token = '';
  call(method: string, path: string, opts: Parameters<typeof http>[2] = {}) { return http(method, `/api/mobile/v1${path}`, { token: this.token, device: this.device, ...opts }); }
  get(path: string, headers?: Record<string, string>) { return this.call('GET', path, { headers }); }
  post(path: string, json: unknown, key: string = randomUUID()) { return this.call('POST', path, { json, key }); }
  async signOut() { assert.equal((await this.call('DELETE', '/session')).status, 204); expectError(await this.get('/session'), 401, 'TOKEN_INVALID'); }
}
async function revalidates(device: Device, path: string, what: string) {
  const first = await device.get(path); assert.equal(first.status, 200, `${what}: ${JSON.stringify(first.body)}`);
  const tag = first.headers.get('etag'); assert.ok(tag, `${what} has an ETag`);
  const weak = tag.startsWith('W/') ? tag : `W/${tag}`;
  assert.equal((await device.get(path, { 'If-None-Match': weak })).status, 304, `${what} revalidates with a weak ETag`);
  return first;
}
async function web(actorId: string) {
  const deviceId = `smoke-web-${randomUUID()}`; const cookies = new Map<string, string>();
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Samford-Request': '1' }) } });
    for (const cookie of response.headers.getSetCookie()) { const entry = cookie.split(';')[0]; const index = entry.indexOf('='); cookies.set(entry.slice(0, index), entry.slice(index + 1)); }
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, bytes, body: (response.headers.get('content-type') ?? '').includes('json') && bytes.length ? JSON.parse(bytes.toString('utf8')) : undefined };
  };
  const signIn = await request('/api/auth/demo', 'POST', { actorId, deviceId });
  assert.equal(signIn.status, 200, JSON.stringify(signIn.body));
  return {
    request,
    async cmd(name: string, payload: Data, anchorId?: string, targetId?: string) {
      const envelope: Data = { operationId: randomUUID(), actorId, deviceId, payload, createdAt: new Date().toISOString(), ...(targetId ? { targetId } : {}) };
      if (anchorId) { const anchor = await request(`/api/entities/${encodeURIComponent(anchorId)}`); assert.equal(anchor.status, 200, JSON.stringify(anchor.body)); envelope.expectedVersion = anchor.body.version; }
      const reply = await request(`/api/commands/${name}`, 'POST', envelope);
      assert.equal(reply.status, 200, `${name}: ${JSON.stringify(reply.body).slice(0, 500)}`); return reply.body;
    },
    async signOut() { assert.equal((await request('/api/auth/logout', 'POST', { unsent: 0 })).status, 200); }
  };
}

const proof: Data = { startedAt: new Date().toISOString(), base, mode, release: release ? { version: release.version, source: release.source } : null, status: 'IN PROGRESS', steps, facts };
const signedOut: (() => Promise<void>)[] = [];
try {
  // Web origin: health, the exact release bundle, and refusals.
  const health = await http('GET', '/api/health');
  assert.equal(health.status, 200); assert.equal(health.body.status, 'ok'); assert.equal(health.body.synthetic, true);
  if (release) assert.equal(health.body.version, release.version);
  facts.version = health.body.version; ok(`health ${health.body.version}`);
  const page = await http('GET', '/'); assert.equal(page.status, 200); assert.match(page.bytes.toString('utf8'), /<html/i);
  if (release) { assert.equal(sha((await http('GET', '/main.js')).bytes), release.hashes['public\\main.js'] ?? release.hashes['public/main.js']); ok('served bundle matches the immutable release'); }
  assert.equal((await http('GET', '/api/state')).status, 401);
  for (const path of ['/data/samford.sqlite', '/server.mjs', '/.env', '/release.json', '/fixtures/seed-history/manifest.json', '/api/test-support/clock']) {
    const refused = await http('GET', path); assert.ok(refused.status === 404, `${path} must not be served (got ${refused.status})`);
  }
  ok('anonymous state, files, fixtures and test-support routes are refused');

  // Mobile metadata and doctor tablet session.
  const meta = await http('GET', '/api/mobile/v1/meta'); assert.equal(meta.status, 200); assert.equal(meta.body.synthetic, true);
  if (release) assert.equal(meta.body.serverVersion, release.version);
  const today = new Date(Date.parse(meta.body.serverTime) + 330 * 60000).toISOString().slice(0, 10);
  Object.assign(facts, { apiVersion: meta.body.apiVersion, minDoctorAppVersion: meta.body.minDoctorAppVersion, minPatientAppVersion: meta.body.minPatientAppVersion, serverDateIst: today });
  const personas = await http('GET', '/api/mobile/v1/doctor/personas'); assert.equal(personas.status, 200);
  const personaIds = personas.body.personas.map((persona: Data) => persona.personaId);
  for (const id of ['doctor-a', 'doctor-c']) assert.ok(personaIds.includes(id), id);
  assert.equal((await http('GET', '/api/mobile/v1/doctor/personas', { headers: { 'If-None-Match': `W/${personas.headers.get('etag')!.replace(/^W\//, '')}` } })).status, 304);
  facts.doctorPersonas = personaIds; ok(`meta ${meta.body.apiVersion}, ${personaIds.length} doctor personas, weak ETag revalidation`);
  const tablet = new Device();
  const signIn = await tablet.call('POST', '/doctor/sessions', { key: randomUUID(), json: { personaId: 'doctor-a', deviceId: tablet.device, deviceName: 'Release smoke tablet' } });
  assert.equal(signIn.status, 201, JSON.stringify(signIn.body)); tablet.token = signIn.body.token; signedOut.push(() => tablet.signOut());
  assert.equal((await tablet.get('/session')).body.kind, 'DOCTOR');
  const labs = await tablet.get('/doctor/labs'); assert.deepEqual(labs.body.labs.map((lab: Data) => lab.labId).sort(), ['central-lab', 'radiology']);
  await revalidates(tablet, '/doctor/queue', 'doctor queue');
  const events = await revalidates(tablet, '/doctor/events?limit=500', 'doctor events');
  let doctorCursor = events.body.nextCursor as string;
  for (let more = events.body.hasMore as boolean; more;) { const next = (await tablet.get(`/doctor/events?limit=500&cursor=${doctorCursor}`)).body; doctorCursor = next.nextCursor; more = next.hasMore; }
  const denied = await tablet.get('/doctor/patients/patient-b/record');
  if (mode === 'full' || denied.status !== 200) expectError(denied, 403, 'CARE_RELATIONSHIP_REQUIRED');
  facts.recordWithoutCare = denied.status;
  ok('doctor tablet sign-in, labs, queue and events with 304s; a record without a care visit is refused');

  // Patient app: OTP sign-in, the seeded returning-patient history and exact handwritten bytes.
  const phone = new Device();
  const challenge = await phone.call('POST', '/patient/otp/request', { key: randomUUID(), json: { mobile: '9000000002', deviceId: phone.device } });
  assert.equal(challenge.status, 201, JSON.stringify(challenge.body)); assert.match(challenge.body.demoCode, /^\d{6}$/);
  const verified = await phone.call('POST', '/patient/otp/verify', { key: randomUUID(), json: { challengeId: challenge.body.challengeId, code: challenge.body.demoCode, deviceId: phone.device } });
  assert.equal(verified.status, 201, JSON.stringify(verified.body)); phone.token = verified.body.token; signedOut.push(() => phone.signOut());
  assert.ok(verified.body.profiles.some((profile: Data) => profile.profileId === 'patient-b'));
  const record = await revalidates(phone, '/patient/profiles/patient-b/record', 'patient record');
  const history = record.body.visits.find((visit: Data) => visit.visitId === 'visit-history-b');
  assert.ok(history, 'the seeded returning-patient visit is present');
  const rx = history.documents.find((doc: Data) => doc.type === 'PRESCRIPTION'); const latest = rx.versions.at(-1);
  facts.seededPrescriptionVersions = rx.versions.map((version: Data) => version.version);
  for (const pageRef of latest.pages) {
    const bytes = await phone.get(`/blobs/${pageRef.pngSha256}`); assert.equal(bytes.status, 200); assert.equal(sha(bytes.bytes), pageRef.pngSha256);
    assert.ok(String(pageRef.url).startsWith(`${base}/api/mobile/v1/files/${pageRef.pngSha256}?`), `signed URL uses the request origin: ${pageRef.url}`);
    const signed = await fetch(pageRef.url); assert.equal(signed.status, 200); assert.equal(sha(Buffer.from(await signed.arrayBuffer())), pageRef.pngSha256);
  }
  expectError(await http('GET', `/api/mobile/v1/files/${latest.pages[0].pngSha256}?exp=${Math.floor(Date.now() / 1000) + 600}&sig=forged`), 403, 'SIGNATURE_INVALID');
  const feed = await revalidates(phone, '/patient/profiles/patient-b/feed?limit=500', 'patient feed');
  let patientCursor = feed.body.nextCursor as string;
  for (let more = feed.body.hasMore as boolean; more;) { const next = (await phone.get(`/patient/profiles/patient-b/feed?limit=500&cursor=${patientCursor}`)).body; patientCursor = next.nextCursor; more = next.hasMore; }
  await revalidates(phone, '/patient/notifications', 'patient notifications');
  expectError(await phone.get('/patient/profiles/patient-a/record'), 404, 'NOT_FOUND');
  expectError(await phone.get('/doctor/queue'), 403, 'FORBIDDEN');
  ok(`patient OTP sign-in, seeded Rx versions ${facts.seededPrescriptionVersions.join(',')} with exact page bytes by bearer and signed URL, feed and notifications with 304s, other family and doctor routes refused`);

  // Web pharmacy desk reads the same signed pages (reads only; the UI gate's view command is not sent in readonly mode).
  const pharmacy = await web('pharmacy'); signedOut.push(() => pharmacy.signOut());
  const visibleDocs = (await pharmacy.request('/api/entities?type=handwrittenDocument')).body as Data[];
  assert.ok(visibleDocs.length > 0 && visibleDocs.every(doc => doc.data.type === 'PRESCRIPTION'), 'the pharmacy sees prescriptions only');
  const webDoc = await pharmacy.request(`/api/handwriting/documents/${rx.documentId}`); assert.equal(webDoc.status, 200, JSON.stringify(webDoc.body));
  const webLatest = webDoc.body.versions.at(-1); assert.equal(webLatest.version, latest.version);
  const webPage = await pharmacy.request(webLatest.pages.at(-1).url); assert.equal(sha(webPage.bytes), latest.pages.at(-1).pngSha256);
  ok('pharmacy web desk sees the same signed Rx version and bytes');

  if (mode === 'full') {
    // Front desk books and checks in the returning patient for the tablet doctor.
    const desk = await web('desk'); signedOut.push(() => desk.signOut());
    const slots = await desk.request(`/api/slots?doctorId=doctor-a&date=${today}`); assert.equal(slots.status, 200, JSON.stringify(slots.body));
    const free = (slots.body as Data[]).find(slot => slot.state === 'Free' && !slot.extra);
    let visitId: string;
    if (free) {
      await desk.cmd('visit.book', { patientId: 'patient-b', doctorId: 'doctor-a', date: today, time: free.time, mode: 'Walk-in', opdType: 'General', visitType: 'Follow-up' }, 'patient-b');
      const booked = ((await desk.request('/api/entities?type=visit')).body as Data[]).filter(visit => visit.patientId === 'patient-b' && visit.doctorId === 'doctor-a' && visit.data.date === today && visit.status === 'Booked')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      assert.ok(booked, 'the booked visit is visible to the desk');
      await desk.cmd('visit.checkin', { clearance: 'Collect at billing', priority: false }, booked.id, booked.id);
      visitId = booked.id; facts.checkInPath = `desk booking at ${free.time} and check-in`;
    } else {
      const walkIn = await tablet.post('/doctor/walk-ins', { patientId: 'patient-b' }); assert.equal(walkIn.status, 201, JSON.stringify(walkIn.body));
      visitId = walkIn.body.visitId; facts.checkInPath = 'no free desk slot today; tablet demo walk-in for the existing patient';
    }
    const queued = (await tablet.get('/doctor/queue')).body.entries.find((entry: Data) => entry.visitId === visitId);
    assert.ok(queued, 'the checked-in patient reaches the tablet queue'); assert.equal(queued.returning, true); assert.ok(queued.lastVisitAt);
    Object.assign(facts, { queueToken: queued.token, returning: queued.returning, lastVisitAt: queued.lastVisitAt });
    ok(`${facts.checkInPath}: patient-b reaches the tablet queue as returning (token ${queued.token}, last visit ${queued.lastVisitAt})`);

    // Tablet: start, open the returning patient's history, complete with an immutable handwritten Rx.
    assert.equal((await tablet.post(`/doctor/queue/${queued.queueEntryId}/start`, { identityConfirmed: true })).status, 200);
    const doctorRecord = await tablet.get('/doctor/patients/patient-b/record'); assert.equal(doctorRecord.status, 200, JSON.stringify(doctorRecord.body));
    assert.ok(doctorRecord.body.visits.some((visit: Data) => visit.visitId === 'visit-history-b'), 'the treating doctor sees the earlier visit by doctor-c');
    const drawn = synthesizePage('release-smoke', 'prescription', 0, 600, 848); const pdf = pagesToPdf([drawn], 'Prescription'); const ink = placeholderInk([drawn]);
    const blobs = [{ bytes: drawn.png, type: 'image/png' }, { bytes: pdf, type: 'application/pdf' }, { bytes: ink, type: 'application/vnd.samford.ink+json' }];
    const bundleId = randomUUID();
    const bundle = { bundleId, completedAt: new Date().toISOString(), documents: [{ clientDocId: randomUUID(), type: 'PRESCRIPTION', title: 'Prescription', routing: { pharmacy: true, labs: [], patient: true },
      pages: [{ index: 0, pngSha256: sha(drawn.png), widthPx: drawn.width, heightPx: drawn.height }], pdfSha256: sha(pdf), inkSha256: sha(ink), inkFormat: 'samford-ink-placeholder/0', signedAt: new Date().toISOString() }] };
    const missing = await tablet.post(`/doctor/visits/${visitId}/complete`, bundle, bundleId); expectError(missing, 409, 'MISSING_BLOBS');
    for (const blob of blobs) assert.ok([200, 201].includes((await tablet.call('PUT', `/blobs/${sha(blob.bytes)}`, { raw: blob.bytes, type: blob.type })).status));
    const done = await tablet.post(`/doctor/visits/${visitId}/complete`, bundle, bundleId); assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.deepEqual((await tablet.post(`/doctor/visits/${visitId}/complete`, bundle, bundleId)).body, done.body, 'a replayed bundle returns the original result');
    const documentId = done.body.documents[0].documentId as string;
    const states = async () => Object.fromEntries((await tablet.get(`/doctor/visits/${visitId}/delivery`)).body.documents[0].recipients.map((item: Data) => [item.kind, item.state]));
    assert.deepEqual(await states(), { PHARMACY: 'AVAILABLE', PATIENT: 'AVAILABLE' });
    ok(`tablet completion: missing blobs refused, upload, signed bundle ${documentId} v1 (record hash ${String(done.body.recordHash).slice(0, 12)}…), idempotent replay`);

    // Pharmacy dispenses; the patient app sees the document and acknowledges it; the tablet sees both.
    const copy = `${documentId}-v1-pharmacy`;
    await pharmacy.cmd('handwriting.view', {}, copy, copy);
    await pharmacy.cmd('handwriting.dispense', { outcome: 'Dispensed' }, copy, copy);
    const newFeed = (await phone.get(`/patient/profiles/patient-b/feed?cursor=${patientCursor}&limit=500`)).body.events as Data[];
    assert.ok(newFeed.some(event => event.type === 'DOCUMENT_AVAILABLE' && event.documentId === documentId), 'the patient feed announces the new document');
    const viewed = await phone.post(`/patient/documents/${documentId}/viewed`, { version: 1 }); assert.equal(viewed.status, 200, JSON.stringify(viewed.body));
    assert.deepEqual(await states(), { PHARMACY: 'DISPENSED', PATIENT: 'VIEWED' });
    const doctorEvents = (await tablet.get(`/doctor/events?cursor=${doctorCursor}&limit=500`)).body.events as Data[];
    assert.ok(doctorEvents.some(event => event.documentId === documentId), 'delivery changes reach the doctor events feed');
    ok('pharmacy viewed and dispensed, patient app received and viewed, tablet delivery and events reflect both');
  }
  proof.status = 'PASS';
} catch (error) {
  proof.status = 'FAIL'; proof.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  for (const signOut of signedOut.reverse()) { try { await signOut(); } catch (error) { proof.signOutProblem = error instanceof Error ? error.message : String(error); } }
  proof.finishedAt = new Date().toISOString();
  proof.effects = mode === 'readonly'
    ? 'Demo sign-in, device, OTP and audit metadata only; every smoke session was signed out. No clinical, delivery or billing command was sent.'
    : 'Isolated rehearsal only: one desk booking and check-in (or demo walk-in), one completed visit with a handwritten Rx, pharmacy view and dispense, and a patient view.';
  const out = args.get('out'); if (out) writeFileSync(out, JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ status: proof.status, error: proof.error, facts }, null, 2));
}
