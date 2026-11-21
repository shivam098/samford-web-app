import { randomUUID, createHash } from 'node:crypto';
import { text, num, bool, rows, istDate, type Actor, type Data, type Entity, type Json } from '../shared/model.js';
import { deliveryStateLabels, deliveryStateByLabel, documentTypeLabels, visitStatusCode, resultFlagCodes, actorLabIds, routingFrom, type Routing } from '../shared/handwriting.js';
import { bundleLimits } from '../shared/mobile-contract.js';
import { Store, DomainError, requireThat } from './store.js';
import { fail } from './api-error.js';
import { blobInfo, signBlob, mediaTypes } from './blobs.js';
import { ensurePatientFamily } from './auth.js';
import type { Context } from './context.js';

export type PageInput = { index: number; pngSha256: string; widthPx: number; heightPx: number };
export type DocumentInput = { clientDocId?: string | null; type: string; title: string; pages: PageInput[]; pdfSha256: string; inkSha256: string | null; inkFormat: string | null; routing: Routing; hints?: Data | null; signedAt: string };
export type CompleteBody = { bundleId: string; completedAt: string; documents: DocumentInput[]; followUp?: { date: string; note?: string; requestBooking?: boolean } };
export type AddendumBody = { clientAddendumId: string; baseVersion: number; reason: string; title?: string; pages: PageInput[]; pdfSha256: string; inkSha256: string | null; inkFormat: string | null; routing?: Routing; hints?: Data; signedAt: string };
export type Writer = { actorId: string; create(type: string, data: Data, status: string, extra?: Partial<Entity>): Entity; update(entity: Entity, data: Data, status?: string): Entity };
export type Viewer = { kind: 'DOCTOR'; doctorId: string } | { kind: 'PATIENT'; profileIds: Set<string> };

export const storeWriter = (store: Store, actorId: string): Writer => ({
  actorId,
  create: (type, data, status, extra = {}) => store.create(type, data, actorId, { status, ...extra }),
  update: (entity, data, status = entity.status) => store.update(entity, actorId, data, status)
});
const contextWriter = (ctx: Context): Writer => ({
  actorId: ctx.actor.id,
  create: (type, data, status, extra = {}) => ctx.create(type, data, status, extra),
  update: (entity, data, status = entity.status) => ctx.update(entity, data, status)
});

export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
export const sha256Text = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const json = (value: unknown) => value as Json;

export function labUnits(store: Store) {
  return store.all('labUnit').filter(entity => entity.status === 'Active')
    .map(entity => ({ labId: text(entity.data, 'labId'), name: text(entity.data, 'name'), kind: text(entity.data, 'kind') || 'OTHER' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export const labName = (store: Store, labId: string) => text(store.maybe(`labunit-${labId}`)?.data ?? {}, 'name') || labId;
export const routingOf = (version: Entity): Routing => routingFrom(version.data.routing);
const pagesOf = (version: Entity): PageInput[] => rows(version.data, 'pages').map(page => ({ index: num(page, 'index'), pngSha256: text(page, 'pngSha256'), widthPx: num(page, 'widthPx'), heightPx: num(page, 'heightPx') }));
const versionNumber = (entity: Entity) => num(entity.data, 'version');
const byVersion = (a: Entity, b: Entity) => versionNumber(a) - versionNumber(b);
export const versionsOf = (store: Store, documentId: string) => store.query('handwrittenDocument', 'documentId', documentId).sort(byVersion);
export const deliveriesOf = (store: Store, documentId: string) => store.query('handwritingDelivery', 'documentId', documentId);
const patientName = (store: Store, patientId?: string) => text(store.maybe(patientId ?? '')?.data ?? {}, 'name') || 'the patient';
const typeLabel = (type: string) => documentTypeLabels[type] ?? 'Document';
const blobRef = (store: Store, sha256: string, entityId: string, role: string) =>
  store.db.prepare('INSERT OR IGNORE INTO blob_refs(sha256, document_entity_id, role) VALUES(?,?,?)').run(sha256, entityId, role);

// Care relationship: an active visit with this doctor, or one completed within seven days.
const careStatuses = new Set(['Waiting', 'Called', 'In consultation', 'Held']);
export function careVisit(store: Store, doctorId: string, patientId: string, visitId?: string): Entity | undefined {
  const candidates = visitId ? [store.maybe(visitId)].filter((visit): visit is Entity => visit?.type === 'visit' && visit.patientId === patientId) : store.query('visit', 'patientId', patientId);
  const now = Date.parse(store.now());
  return candidates.find(visit => visit.doctorId === doctorId && (careStatuses.has(visit.status) ||
    (visit.status === 'Done' && now - Date.parse(text(visit.data, 'completedAt') || text(visit.data, 'firstDoneAt') || visit.updatedAt) <= 7 * 86400000)));
}
export const doctorMayRead = (store: Store, doctorId: string, version: Entity) => version.doctorId === doctorId || Boolean(careVisit(store, doctorId, version.patientId ?? ''));
const resultVersion = (store: Store, result: Entity) => store.maybe(`${text(result.data, 'documentId')}-v${num(result.data, 'version')}`);
export function blobReadable(store: Store, sha256: string, viewer: Viewer): boolean {
  if (viewer.kind === 'DOCTOR' && blobInfo(store, sha256)?.createdBy === viewer.doctorId) return true;
  for (const ref of store.db.prepare('SELECT document_entity_id FROM blob_refs WHERE sha256=?').all(sha256)) {
    const entity = store.maybe(String(ref.document_entity_id));
    if (entity?.type === 'handwrittenDocument') {
      if (viewer.kind === 'DOCTOR' ? doctorMayRead(store, viewer.doctorId, entity) : viewer.profileIds.has(entity.patientId ?? '') && routingOf(entity).patient) return true;
    } else if (entity?.type === 'investigationResult' && entity.status === 'Released') {
      const version = resultVersion(store, entity);
      if (viewer.kind === 'DOCTOR' ? entity.doctorId === viewer.doctorId || Boolean(careVisit(store, viewer.doctorId, entity.patientId ?? '')) : viewer.profileIds.has(entity.patientId ?? '') && Boolean(version && routingOf(version).patient)) return true;
    }
  }
  return false;
}

type Missing = { sha256: string; mediaType: string; role: 'PAGE' | 'PDF' | 'INK'; clientDocId: string | null; pageIndex?: number };
function checkStructure(store: Store, doc: DocumentInput) {
  const where = doc.clientDocId ? { clientDocId: doc.clientDocId } : undefined;
  doc.pages.forEach((page, position) => { if (page.index !== position) fail(422, 'VALIDATION_FAILED', 'Page indexes must be 0..n-1 in page order.', where); });
  if ((doc.inkSha256 === null) !== (doc.inkFormat === null)) fail(422, 'VALIDATION_FAILED', 'Send inkSha256 and inkFormat together, or both as null.', where);
  if (doc.routing.pharmacy && doc.type !== 'PRESCRIPTION') fail(422, 'ROUTING_INVALID', 'Only a PRESCRIPTION can be routed to the pharmacy.', where);
  if (doc.routing.labs.length && doc.type !== 'INVESTIGATIONS') fail(422, 'ROUTING_INVALID', 'Only INVESTIGATIONS can be routed to labs.', where);
  const known = new Set(labUnits(store).map(lab => lab.labId));
  const unknown = doc.routing.labs.filter(lab => !known.has(lab));
  if (unknown.length) fail(422, 'UNKNOWN_LAB', `Unknown lab ${unknown.join(', ')}. Choose labs from GET /doctor/labs.`, { ...where, unknownLabs: unknown });
  if (doc.hints && Buffer.byteLength(JSON.stringify(doc.hints)) > bundleLimits.hintsBytes) fail(422, 'VALIDATION_FAILED', 'Typed hints must be at most 32 KiB.', where);
}
function collectMissing(store: Store, doc: DocumentInput, missing: Missing[], seen: Set<string>) {
  const need = (sha256: string, mediaType: string, role: Missing['role'], pageIndex?: number) => {
    if (seen.has(sha256)) return;
    seen.add(sha256);
    if (!blobInfo(store, sha256)) missing.push({ sha256, mediaType, role, clientDocId: doc.clientDocId ?? null, ...(pageIndex === undefined ? {} : { pageIndex }) });
  };
  for (const page of doc.pages) need(page.pngSha256, mediaTypes.png, 'PAGE', page.index);
  need(doc.pdfSha256, mediaTypes.pdf, 'PDF');
  if (doc.inkSha256) need(doc.inkSha256, mediaTypes.ink, 'INK');
}
function checkBlobs(store: Store, doc: DocumentInput) {
  const where: Data = doc.clientDocId ? { clientDocId: doc.clientDocId } : {};
  for (const page of doc.pages) {
    const info = blobInfo(store, page.pngSha256)!;
    if (info.mediaType !== mediaTypes.png) fail(422, 'BLOB_TYPE_MISMATCH', `Page ${page.index} must reference a PNG image.`, { ...where, sha256: page.pngSha256 });
    if (info.width !== page.widthPx || info.height !== page.heightPx) fail(422, 'PAGE_DIMENSIONS_MISMATCH', `Page ${page.index} is ${info.width}x${info.height} pixels, not ${page.widthPx}x${page.heightPx}.`, { ...where, pageIndex: page.index });
  }
  if (blobInfo(store, doc.pdfSha256)!.mediaType !== mediaTypes.pdf) fail(422, 'BLOB_TYPE_MISMATCH', 'pdfSha256 must reference a PDF.', { ...where, sha256: doc.pdfSha256 });
  if (doc.inkSha256 && blobInfo(store, doc.inkSha256)!.mediaType !== mediaTypes.ink) fail(422, 'BLOB_TYPE_MISMATCH', 'inkSha256 must reference vector ink JSON.', { ...where, sha256: doc.inkSha256 });
}
function validateAll(store: Store, documents: DocumentInput[]) {
  for (const doc of documents) checkStructure(store, doc);
  const missing: Missing[] = []; const seen = new Set<string>();
  for (const doc of documents) collectMissing(store, doc, missing, seen);
  if (missing.length) fail(409, 'MISSING_BLOBS', 'Upload the listed files, then retry the same request with the same Idempotency-Key.', { missing: json(missing) }, true);
  for (const doc of documents) checkBlobs(store, doc);
}

type SignArgs = { doctor: Actor; visit: Entity; documentId: string; version: number; doc: DocumentInput; receivedAt: string; reason: string | null; previous?: Entity; origin: Data };
export function signVersion(store: Store, args: SignArgs): Entity {
  const { doctor, visit, documentId, version, doc, receivedAt, reason, previous } = args;
  const routing: Routing = { pharmacy: doc.routing.pharmacy, labs: [...doc.routing.labs], patient: doc.routing.patient };
  const pages = doc.pages.map(page => ({ index: page.index, pngSha256: page.pngSha256, widthPx: page.widthPx, heightPx: page.heightPx }));
  const hints = doc.hints && Object.keys(doc.hints).length ? doc.hints : null;
  const previousRecordHash = previous ? text(previous.data, 'recordHash') : null;
  const recordHash = sha256Text(canonicalJson({ schema: 'samford-record/1', documentId, version, visitId: visit.id, patientId: visit.patientId, doctorId: doctor.id, type: doc.type, title: doc.title, pages,
    pdfSha256: doc.pdfSha256, inkSha256: doc.inkSha256, inkFormat: doc.inkFormat, routing, hints, signedAt: doc.signedAt, receivedAt, reason, previousRecordHash }));
  const id = `${documentId}-v${version}`;
  const entity = store.put({ id, type: 'handwrittenDocument', version: 1, status: 'Signed', createdAt: receivedAt, updatedAt: receivedAt, createdBy: doctor.id, updatedBy: doctor.id,
    patientId: visit.patientId, doctorId: doctor.id, department: visit.department ?? doctor.department,
    data: { documentId, version, visitId: visit.id, type: doc.type, typeLabel: typeLabel(doc.type), title: doc.title, name: `${doc.title} v${version}`, pages, pdfSha256: doc.pdfSha256, inkSha256: doc.inkSha256, inkFormat: doc.inkFormat,
      routing, hints, signedAt: doc.signedAt, receivedAt, reason, authorName: doctor.name, recordHash, previousRecordHash, supersedes: previous?.id ?? null, ...args.origin } });
  for (const page of pages) blobRef(store, page.pngSha256, id, 'PAGE');
  blobRef(store, doc.pdfSha256, id, 'PDF');
  if (doc.inkSha256) blobRef(store, doc.inkSha256, id, 'INK');
  return entity;
}
export function deliver(store: Store, version: Entity, at: string, actorId: string): Entity[] {
  const routing = routingOf(version); const title = text(version.data, 'title');
  const targets: { kind: string; labId: string | null; name: string }[] = [];
  if (routing.pharmacy) targets.push({ kind: 'PHARMACY', labId: null, name: 'Hospital pharmacy' });
  for (const labId of routing.labs) targets.push({ kind: 'LAB', labId, name: labName(store, labId) });
  if (routing.patient) targets.push({ kind: 'PATIENT', labId: null, name: 'Patient app' });
  return targets.map(target => store.put({
    id: `${version.id}-${target.kind === 'LAB' ? `lab-${target.labId}` : target.kind.toLowerCase()}`, type: 'handwritingDelivery', version: 1, status: 'Available',
    createdAt: at, updatedAt: at, createdBy: actorId, updatedBy: actorId, patientId: version.patientId, doctorId: version.doctorId, department: version.department,
    data: { documentId: text(version.data, 'documentId'), version: versionNumber(version), versionEntityId: version.id, visitId: text(version.data, 'visitId'), docType: text(version.data, 'type'), title,
      recipient: target.kind, labId: target.labId, recipientName: target.name, name: `${title} - ${target.name}`, state: 'AVAILABLE', note: '', history: [{ state: 'AVAILABLE', at, by: actorId }] }
  }));
}
function emitSigned(store: Store, version: Entity, amended: boolean) {
  const v = versionNumber(version); const documentId = text(version.data, 'documentId'); const visitId = text(version.data, 'visitId'); const type = text(version.data, 'type');
  store.emit(`doctor:${version.doctorId}`, 'DOCUMENT_SIGNED', { message: `${text(version.data, 'title')} version ${v} signed for ${patientName(store, version.patientId)}.`, visitId, documentId, patientId: version.patientId, data: { version: v, type, recordHash: text(version.data, 'recordHash') } });
  if (!routingOf(version).patient) return;
  const label = typeLabel(type).toLowerCase();
  store.emit(`patient:${version.patientId}`, amended ? 'DOCUMENT_AMENDED' : 'DOCUMENT_AVAILABLE', {
    message: amended ? `Your doctor signed an updated ${label}.` : `A new ${label} from your visit is ready to view.`, visitId, documentId, patientId: version.patientId, data: { version: v, type },
    notify: amended ? { title: 'Document updated', body: 'Your doctor signed an updated version of a document.' } : { title: 'New document', body: 'A new document from your hospital visit is ready to view.' }
  });
}
function patientStateMessage(kind: string, state: string, recipientName: string) {
  if (kind === 'PHARMACY') return ({ VIEWED: 'The hospital pharmacy opened your prescription.', DISPENSED: 'The hospital pharmacy dispensed your prescription.',
    PARTIALLY_DISPENSED: 'The hospital pharmacy partially dispensed your prescription. Ask the pharmacy about the remaining medicines.',
    NOT_DISPENSED: 'The hospital pharmacy could not dispense your prescription. Please contact the pharmacy.' } as Record<string, string>)[state] ?? 'Your prescription was updated.';
  return ({ VIEWED: `${recipientName} received your test request.`, SAMPLE_COLLECTED: `${recipientName} collected your sample.`, RESULT_READY: `${recipientName} has finished your tests.` } as Record<string, string>)[state] ?? 'Your test request was updated.';
}
function emitStateChange(store: Store, delivery: Entity) {
  const state = text(delivery.data, 'state'); const kind = text(delivery.data, 'recipient'); const recipientName = text(delivery.data, 'recipientName');
  const data = { version: num(delivery.data, 'version'), recipientKind: kind, labId: (delivery.data.labId ?? null) as Json, state, note: text(delivery.data, 'note') || null };
  const common = { visitId: text(delivery.data, 'visitId'), documentId: text(delivery.data, 'documentId'), patientId: delivery.patientId, data };
  store.emit(`doctor:${delivery.doctorId}`, 'DOCUMENT_STATE_CHANGED', { message: `${recipientName}: ${text(delivery.data, 'title')} ${(deliveryStateLabels[state] ?? state).toLowerCase()} for ${patientName(store, delivery.patientId)}.`, ...common });
  if (kind === 'PATIENT' || state === 'SUPERSEDED') return;
  const version = store.maybe(text(delivery.data, 'versionEntityId'));
  if (!version || !routingOf(version).patient) return;
  const dispensed = kind === 'PHARMACY' && ['DISPENSED', 'PARTIALLY_DISPENSED'].includes(state);
  store.emit(`patient:${delivery.patientId}`, 'DOCUMENT_STATE_CHANGED', { message: patientStateMessage(kind, state, recipientName), ...common,
    notify: dispensed ? { title: 'Prescription dispensed', body: state === 'DISPENSED' ? 'The hospital pharmacy dispensed your prescription.' : 'The hospital pharmacy partially dispensed your prescription.' } : undefined });
}
const transitions: Record<string, Record<string, string[]>> = {
  PHARMACY: { AVAILABLE: ['VIEWED'], VIEWED: ['DISPENSED', 'PARTIALLY_DISPENSED', 'NOT_DISPENSED'], PARTIALLY_DISPENSED: ['DISPENSED'] },
  LAB: { AVAILABLE: ['VIEWED'], VIEWED: ['SAMPLE_COLLECTED'], SAMPLE_COLLECTED: ['RESULT_READY'] },
  PATIENT: { AVAILABLE: ['VIEWED'] }
};
export function moveDelivery(store: Store, writer: Writer, delivery: Entity, state: string, note = ''): Entity {
  const from = text(delivery.data, 'state'); const kind = text(delivery.data, 'recipient');
  if (!transitions[kind]?.[from]?.includes(state)) {
    throw new DomainError(409, 'INVALID_STATE', from === 'SUPERSEDED' ? 'A newer signed version replaced this copy. Open the latest version.' :
      `This copy is ${(deliveryStateLabels[from] ?? from).toLowerCase()}; it cannot become ${(deliveryStateLabels[state] ?? state).toLowerCase()}. Refresh and choose the next step.`);
  }
  const at = store.now();
  const updated = writer.update(delivery, { state, note, history: [...rows(delivery.data, 'history'), { state, at, by: writer.actorId, note }] }, deliveryStateLabels[state]);
  emitStateChange(store, updated);
  return updated;
}
export type ResultInput = { testName: string; value: string; unit?: string; refRange?: string; flag?: string; summary?: string; reportPdfSha256?: string };
export function enterResult(store: Store, writer: Writer, actor: Actor, delivery: Entity, input: ResultInput): Entity {
  requireThat(text(delivery.data, 'recipient') === 'LAB', 'Results can be entered only for a lab copy.');
  if (!['SAMPLE_COLLECTED', 'RESULT_READY'].includes(text(delivery.data, 'state'))) throw new DomainError(409, 'INVALID_STATE', 'Record sample collection before entering results.');
  requireThat(actorLabIds(actor).includes(text(delivery.data, 'labId')), 'This request was routed to a different lab.', 'ACCESS_DENIED');
  requireThat(input.testName.trim() && input.value.trim(), 'Enter the test name and value.');
  requireThat(!input.flag || ['NORMAL', 'ABNORMAL', 'CRITICAL'].includes(input.flag), 'Choose Normal, Abnormal or Critical.');
  const result = writer.create('investigationResult', {
    documentId: text(delivery.data, 'documentId'), version: num(delivery.data, 'version'), deliveryId: delivery.id, labId: text(delivery.data, 'labId'), visitId: text(delivery.data, 'visitId'),
    name: input.testName.trim(), testName: input.testName.trim(), value: input.value.trim(), unit: input.unit?.trim() ?? '', refRange: input.refRange?.trim() ?? '', flag: input.flag ?? '',
    summary: input.summary?.trim() ?? '', reportPdfSha256: input.reportPdfSha256 ?? '', enteredBy: actor.id, enteredByName: actor.name, enteredAt: store.now()
  }, 'Entered', { patientId: delivery.patientId, doctorId: delivery.doctorId, department: delivery.department });
  if (input.reportPdfSha256) blobRef(store, input.reportPdfSha256, result.id, 'REPORT');
  return result;
}
function emitResult(store: Store, result: Entity) {
  const flag = text(result.data, 'flag'); const lab = labName(store, text(result.data, 'labId'));
  const common = { visitId: text(result.data, 'visitId'), documentId: text(result.data, 'documentId'), patientId: result.patientId };
  store.emit(`doctor:${result.doctorId}`, 'LAB_RESULT_READY', { message: `${lab}: ${text(result.data, 'testName')} ready${flag ? ` (${flag})` : ''} for ${patientName(store, result.patientId)}.`, ...common,
    data: { resultId: result.id, labId: text(result.data, 'labId'), flag: flag || null, testName: text(result.data, 'testName') } });
  const version = resultVersion(store, result);
  if (version && routingOf(version).patient) store.emit(`patient:${result.patientId}`, 'LAB_RESULT_READY', { message: 'A lab result is ready to view.', ...common,
    data: { resultId: result.id, labId: text(result.data, 'labId') }, notify: { title: 'Result ready', body: 'A lab result is ready to view.' } });
}
// Independent verification mirrors SJ15: a different lab user with verifier rights releases entered results.
export function releaseResults(store: Store, writer: Writer, actor: Actor, delivery: Entity): Entity[] {
  requireThat(actor.verifier, 'Your account does not have lab verifier rights.', 'ACCESS_DENIED');
  requireThat(actorLabIds(actor).includes(text(delivery.data, 'labId')), 'This request was routed to a different lab.', 'ACCESS_DENIED');
  const pending = store.query('investigationResult', 'documentId', text(delivery.data, 'documentId')).filter(result => text(result.data, 'deliveryId') === delivery.id && result.status === 'Entered');
  requireThat(pending.length, 'Enter at least one result before verification.');
  requireThat(pending.every(result => text(result.data, 'enteredBy') !== actor.id), 'A different authorized person must verify these results.');
  const at = store.now();
  const released = pending.map(result => writer.update(result, { verifiedBy: actor.id, verifiedByName: actor.name, releasedAt: at }, 'Released'));
  if (text(delivery.data, 'state') === 'SAMPLE_COLLECTED') moveDelivery(store, writer, delivery, 'RESULT_READY');
  for (const result of released) emitResult(store, result);
  return released;
}

function deviceTouch(store: Store, deviceEntityId: string | undefined, actorId: string, at: string) {
  const device = deviceEntityId ? store.maybe(deviceEntityId) : undefined;
  if (device) store.update(device, actorId, { lastSync: at, unsent: 0 });
}
export function completeVisit(store: Store, doctor: Actor, visitId: string, body: CompleteBody, options: { deviceEntityId?: string; coding?: boolean } = {}): Data {
  const visit = store.maybe(visitId);
  if (!visit || visit.type !== 'visit' || visit.doctorId !== doctor.id) fail(404, 'NOT_FOUND', 'This visit is not in your queue.');
  if (visit.status === 'Done') fail(409, 'VISIT_ALREADY_COMPLETED', 'This visit was already completed with another bundle. Keep this bundle and sign it as addenda instead.', { bundleId: text((visit.data.handwriting ?? {}) as Data, 'bundleId') || null });
  if (visit.status === 'Cancelled') fail(409, 'VISIT_CLOSED', 'This visit was cancelled. The bundle stays on the tablet; contact the front desk.');
  if (visit.status === 'Booked') fail(409, 'NOT_CHECKED_IN', 'The front desk has not checked this patient in.');
  if (!(visit.status === 'In consultation' || (visit.status === 'Held' && text(visit.data, 'openedAt')))) fail(409, 'VISIT_NOT_STARTED', 'Confirm the patient and start the visit before completing it.');
  if (new Set(body.documents.map(doc => doc.clientDocId)).size !== body.documents.length) fail(422, 'VALIDATION_FAILED', 'Each document needs a unique clientDocId.');
  if (body.documents.reduce((sum, doc) => sum + doc.pages.length, 0) > bundleLimits.pagesPerBundle) fail(422, 'VALIDATION_FAILED', `A bundle can contain at most ${bundleLimits.pagesPerBundle} pages.`);
  if (body.followUp && body.followUp.date < text(visit.data, 'date')) fail(422, 'VALIDATION_FAILED', 'The follow-up date must not precede the visit.');
  validateAll(store, body.documents);
  const receivedAt = store.now();
  const documentIds = body.documents.map(() => `hwdoc-${randomUUID()}`);
  const patient = store.get(visit.patientId ?? '', 'patient');
  const done = store.update(visit, doctor.id, { firstDoneAt: text(visit.data, 'firstDoneAt') || body.completedAt, completedAt: receivedAt, clientCompletedAt: body.completedAt, completedOn: 'Doctor tablet',
    handwriting: { bundleId: body.bundleId, documentIds, receivedAt } }, 'Done');
  const signed = body.documents.map((doc, index) => {
    const version = signVersion(store, { doctor, visit: done, documentId: documentIds[index], version: 1, doc, receivedAt, reason: null, origin: { bundleId: body.bundleId, clientDocId: doc.clientDocId ?? null } });
    deliver(store, version, receivedAt, doctor.id);
    emitSigned(store, version, false);
    return { doc, version };
  });
  const recordHash = sha256Text(canonicalJson({ schema: 'samford-bundle/1', bundleId: body.bundleId, visitId: visit.id, recordHashes: signed.map(item => text(item.version.data, 'recordHash')) }));
  store.update(done, doctor.id, { handwriting: { bundleId: body.bundleId, documentIds, receivedAt, recordHash } });
  let followUpId: string | null = null;
  if (body.followUp) {
    const requestBooking = body.followUp.requestBooking !== false;
    followUpId = store.create('followup', { name: `Follow-up ${body.followUp.date}`, visitId: visit.id, date: body.followUp.date, note: body.followUp.note ?? '', requestBooking, print: false, source: 'Doctor tablet' },
      doctor.id, { status: requestBooking ? 'Requested' : 'Recommended', patientId: visit.patientId, doctorId: visit.doctorId, department: visit.department }).id;
  }
  const summary = signed.find(item => item.doc.type === 'VISIT_SUMMARY');
  if (options.coding !== false) store.create('coding', { name: text(visit.data, 'number') || visit.id, sourceId: visit.id, doctorText: text((summary?.doc.hints ?? {}) as Data, 'diagnosis') || 'See the signed handwritten visit summary.', mlc: bool(patient.data, 'mlc'), handwritten: true },
    doctor.id, { status: 'Requested', patientId: visit.patientId, doctorId: visit.doctorId, department: visit.department });
  deviceTouch(store, options.deviceEntityId, doctor.id, receivedAt);
  store.audit(doctor.id, 'doctor', 'handwriting.completeVisit', visit.id, { status: visit.status }, { status: 'Done', bundleId: body.bundleId, documents: signed.length, recordHash, channel: 'Doctor tablet' });
  return { bundleId: body.bundleId, visitId: visit.id, visitStatus: 'COMPLETED', receivedAt, recordHash,
    documents: signed.map(item => ({ clientDocId: item.doc.clientDocId ?? '', documentId: text(item.version.data, 'documentId'), version: 1, type: item.doc.type, title: item.doc.title, recordHash: text(item.version.data, 'recordHash') })), followUpId };
}
export function signAddendum(store: Store, doctor: Actor, documentId: string, body: AddendumBody, deviceEntityId?: string): Data {
  const latest = versionsOf(store, documentId).at(-1);
  if (!latest || !doctorMayRead(store, doctor.id, latest)) fail(404, 'NOT_FOUND', 'Document not found.');
  if (latest.doctorId !== doctor.id) fail(403, 'NOT_AUTHOR', 'Only the doctor who signed this document can sign a new version.');
  const current = versionNumber(latest);
  if (body.baseVersion !== current) fail(409, 'NOT_LATEST_VERSION', `Version ${current} is the latest. Review it before signing a new version.`, { latestVersion: current });
  const visit = store.get(text(latest.data, 'visitId'), 'visit');
  const doc: DocumentInput = { clientDocId: null, type: text(latest.data, 'type'), title: body.title ?? text(latest.data, 'title'), pages: body.pages, pdfSha256: body.pdfSha256,
    inkSha256: body.inkSha256, inkFormat: body.inkFormat, routing: body.routing ?? routingOf(latest), hints: body.hints ?? null, signedAt: body.signedAt };
  validateAll(store, [doc]);
  const receivedAt = store.now();
  for (const delivery of deliveriesOf(store, documentId).filter(item => text(item.data, 'versionEntityId') === latest.id && text(item.data, 'state') !== 'SUPERSEDED')) {
    store.update(delivery, doctor.id, { state: 'SUPERSEDED', history: [...rows(delivery.data, 'history'), { state: 'SUPERSEDED', at: receivedAt, by: doctor.id, note: `Replaced by version ${current + 1}` }] }, 'Superseded');
  }
  const version = signVersion(store, { doctor, visit, documentId, version: current + 1, doc, receivedAt, reason: body.reason, previous: latest, origin: { addendumId: body.clientAddendumId } });
  deliver(store, version, receivedAt, doctor.id);
  emitSigned(store, version, true);
  deviceTouch(store, deviceEntityId, doctor.id, receivedAt);
  store.audit(doctor.id, 'doctor', 'handwriting.addendum', version.id, { version: current }, { version: current + 1, reasonRecorded: true, recordHash: text(version.data, 'recordHash') }, body.reason);
  return { documentId, version: current + 1, previousVersion: current, recordHash: text(version.data, 'recordHash'), createdAt: receivedAt };
}
export function startVisit(store: Store, doctor: Actor, visitId: string): Data {
  const visit = store.maybe(visitId);
  if (!visit || visit.type !== 'visit' || visit.doctorId !== doctor.id) fail(404, 'NOT_FOUND', 'This visit is not in your queue.');
  const result = (entity: Entity) => ({ queueEntryId: entity.id, visitId: entity.id, status: 'IN_CONSULTATION', startedAt: text(entity.data, 'openedAt') || entity.updatedAt });
  if (visit.status === 'In consultation') return result(visit);
  if (visit.status === 'Booked') fail(409, 'NOT_CHECKED_IN', 'The front desk has not checked this patient in.');
  if (visit.status === 'Done') fail(409, 'VISIT_ALREADY_COMPLETED', 'This visit is already completed.', { bundleId: text((visit.data.handwriting ?? {}) as Data, 'bundleId') || null });
  if (visit.status === 'Cancelled') fail(409, 'VISIT_CLOSED', 'This visit was cancelled.');
  if (!['Waiting', 'Called', 'Held', 'Missed'].includes(visit.status)) fail(409, 'INVALID_STATE', `A ${visit.status.toLowerCase()} visit cannot be started.`);
  const started = store.update(visit, doctor.id, { openedAt: store.now(), identityConfirmed: true, startedOn: 'Doctor tablet' }, 'In consultation');
  store.audit(doctor.id, 'doctor', 'visit.open', visit.id, { status: visit.status }, { status: started.status, channel: 'Doctor tablet', identityConfirmed: true });
  return result(started);
}
export function walkIn(store: Store, doctor: Actor, body: { patientId?: string; name?: string; age?: number; sex?: string; mobile?: string }): Entity {
  let patient: Entity | undefined;
  if (body.patientId) {
    patient = store.maybe(body.patientId);
    if (!patient || patient.type !== 'patient' || patient.status !== 'Active') fail(404, 'NOT_FOUND', 'Patient not found.');
  } else {
    const name = (body.name ?? '').trim();
    if (!name) fail(422, 'VALIDATION_FAILED', 'Enter the synthetic patient name.');
    patient = body.mobile ? store.query('patient', 'mobile', body.mobile).find(entry => entry.status === 'Active' && text(entry.data, 'name').toLowerCase() === name.toLowerCase()) : undefined;
    if (!patient) {
      patient = store.create('patient', { name, age: body.age ?? 0, sex: body.sex ?? 'Other', mobile: body.mobile ?? '', payer: 'Self', address: 'Sample district', category: 'General',
        uhid: `SMP-${String(store.count('patient') + 1).padStart(6, '0')}`, aadhaarLast4: '', allergyVersion: 0, mlc: false, unknown: false, arrivalAt: store.now(), demoWalkIn: true }, doctor.id, { status: 'Active' });
    }
    if (body.mobile) ensurePatientFamily(store, body.mobile, [patient.id]);
  }
  const today = istDate(store.now());
  const sameDay = store.visitsFor(doctor.id, today);
  const open = sameDay.find(visit => visit.patientId === patient!.id && ['Waiting', 'Called', 'In consultation', 'Held'].includes(visit.status));
  if (open) fail(422, 'VALIDATION_FAILED', 'This patient is already checked in to your queue today.', { visitId: open.id });
  const token = Math.max(0, ...sameDay.map(visit => num(visit.data, 'token'))) + 1;
  const time = new Date(Date.parse(store.now()) + 330 * 60000).toISOString().slice(11, 16);
  const returning = store.query('visit', 'patientId', patient.id).some(visit => visit.status === 'Done');
  const visit = store.create('visit', { number: `OPD-W-${randomUUID().slice(0, 8).toUpperCase()}`, name: `${today} ${time}`, date: today, time, token, mode: 'Walk-in', opdType: 'General', visitType: returning ? 'Follow-up' : 'New',
    room: text(store.maybe(doctor.id)?.data ?? {}, 'room'), priority: false, checkinAt: store.now(), calls: 0, moves: [], source: 'Doctor tablet demo walk-in', demoWalkIn: true },
  doctor.id, { status: 'Waiting', patientId: patient.id, doctorId: doctor.id, department: doctor.department });
  store.audit(doctor.id, 'doctor', 'demo.mobileWalkIn', visit.id, null, { demoOnly: true, bypassedFrontDeskAndBilling: true, existingPatient: Boolean(body.patientId) });
  return visit;
}

// DTOs follow docs/mobile-api-v1.yaml. Signed URL fields are volatile and excluded from ETags.
export type UrlMaker = (sha256: string) => { url: string; exp: number };
const sexOf = (value: string) => ['Female', 'Male', 'Other'].includes(value) ? value : 'Other';
export const masked = (mobile: string) => mobile ? `******${mobile.slice(-4)}` : '';
export function patientSummary(patient: Entity) {
  return { patientId: patient.id, uhid: text(patient.data, 'uhid'), name: text(patient.data, 'name'), age: Math.max(0, Math.trunc(num(patient.data, 'age'))), sex: sexOf(text(patient.data, 'sex')), mobileMasked: masked(text(patient.data, 'mobile')) };
}
export function allergiesOf(store: Store, patientId: string) {
  return store.query('allergy', 'patientId', patientId).filter(allergy => allergy.status === 'Active')
    .map(allergy => ({ substance: text(allergy.data, 'substance') || text(allergy.data, 'name'), reaction: text(allergy.data, 'reaction'), certainty: text(allergy.data, 'certainty') }));
}
function versionDto(version: Entity, urls: UrlMaker): Data {
  let exp = Number.MAX_SAFE_INTEGER;
  const sign = (sha256: string) => { const signed = urls(sha256); exp = Math.min(exp, signed.exp); return signed.url; };
  const inkSha256 = text(version.data, 'inkSha256') || null;
  const pages = pagesOf(version).map(page => ({ ...page, url: sign(page.pngSha256) }));
  const pdfUrl = sign(text(version.data, 'pdfSha256'));
  const inkUrl = inkSha256 ? sign(inkSha256) : null;
  return { version: versionNumber(version), createdAt: text(version.data, 'receivedAt'), signedAt: text(version.data, 'signedAt'), reason: text(version.data, 'reason') || null, authorName: text(version.data, 'authorName'),
    title: text(version.data, 'title'), pages, pdfSha256: text(version.data, 'pdfSha256'), pdfUrl, inkSha256, inkFormat: text(version.data, 'inkFormat') || null, inkUrl,
    recordHash: text(version.data, 'recordHash'), urlsExpireAt: new Date(exp * 1000).toISOString() };
}
export const recipientDto = (delivery: Entity) => ({ kind: text(delivery.data, 'recipient'), labId: text(delivery.data, 'labId') || null, name: text(delivery.data, 'recipientName'),
  state: text(delivery.data, 'state'), version: num(delivery.data, 'version'), updatedAt: delivery.updatedAt, note: text(delivery.data, 'note') || null });
export function documentDto(versions: Entity[], deliveries: Entity[], viewer: Viewer, urls: UrlMaker): Data | undefined {
  const visible = (viewer.kind === 'PATIENT' ? versions.filter(version => routingOf(version).patient) : versions).sort(byVersion);
  const latest = visible.at(-1);
  if (!latest) return undefined;
  return { documentId: text(latest.data, 'documentId'), visitId: text(latest.data, 'visitId'), patientId: latest.patientId ?? '', type: text(latest.data, 'type'), title: text(latest.data, 'title'),
    author: { doctorId: latest.doctorId ?? '', name: text(latest.data, 'authorName') }, latestVersion: versionNumber(latest), routing: routingOf(latest), hints: (latest.data.hints ?? null) as Json,
    versions: visible.map(version => versionDto(version, urls)), recipients: deliveries.filter(delivery => text(delivery.data, 'versionEntityId') === latest.id).map(recipientDto) };
}
export function documentFor(store: Store, documentId: string, viewer: Viewer, urls: UrlMaker): Data | undefined {
  const versions = versionsOf(store, documentId);
  const latest = versions.at(-1);
  if (!latest) return undefined;
  if (viewer.kind === 'DOCTOR' && !doctorMayRead(store, viewer.doctorId, latest)) return undefined;
  if (viewer.kind === 'PATIENT' && !viewer.profileIds.has(latest.patientId ?? '')) return undefined;
  return documentDto(versions, deliveriesOf(store, documentId), viewer, urls);
}
function group(entities: Entity[]) {
  const map = new Map<string, Entity[]>();
  for (const entity of entities) { const key = text(entity.data, 'documentId'); map.set(key, [...(map.get(key) ?? []), entity]); }
  return map;
}
const flagFromWeb = (flag: string) => flag === 'Critical' ? 'CRITICAL' : ['High', 'Low', 'Abnormal'].includes(flag) ? 'ABNORMAL' : flag === 'Normal' ? 'NORMAL' : null;
export function labResultsFor(store: Store, patientId: string, viewer: Viewer, urls: UrlMaker): Data[] {
  const handwritten = store.query('investigationResult', 'patientId', patientId).filter(result => result.status === 'Released')
    .filter(result => viewer.kind === 'DOCTOR' || Boolean(resultVersion(store, result) && routingOf(resultVersion(store, result)!).patient))
    .map(result => {
      const report = text(result.data, 'reportPdfSha256') || null;
      return { resultId: result.id, documentId: text(result.data, 'documentId') || null, labId: text(result.data, 'labId') || null, testName: text(result.data, 'testName'), value: text(result.data, 'value'),
        unit: text(result.data, 'unit') || null, refRange: text(result.data, 'refRange') || null, flag: text(result.data, 'flag') || null, reportedAt: text(result.data, 'releasedAt') || result.updatedAt,
        summary: text(result.data, 'summary') || null, reportPdfSha256: report, reportUrl: report ? urls(report).url : null };
    });
  const structured = store.query('result', 'patientId', patientId).filter(result => result.status === 'Released').map(result => {
    const low = result.data.low; const high = result.data.high;
    return { resultId: result.id, documentId: null, labId: null, testName: text(result.data, 'name'),
      value: typeof result.data.value === 'number' ? String(result.data.value) : text(result.data, 'narrative') || text(result.data, 'value'),
      unit: text(result.data, 'unit') || null, refRange: typeof low === 'number' && typeof high === 'number' ? `${low}-${high}` : null, flag: flagFromWeb(text(result.data, 'flag')),
      reportedAt: text(result.data, 'releasedAt') || result.updatedAt, summary: text(result.data, 'narrative') || null, reportPdfSha256: null, reportUrl: null };
  });
  return [...handwritten, ...structured].sort((a, b) => b.reportedAt.localeCompare(a.reportedAt)) as Data[];
}
export function patientRecord(store: Store, patient: Entity, viewer: Viewer, urls: UrlMaker): Data {
  const versions = group(store.query('handwrittenDocument', 'patientId', patient.id));
  const deliveries = group(store.query('handwritingDelivery', 'patientId', patient.id));
  const byVisit = new Map<string, Data[]>();
  for (const [documentId, list] of versions) {
    const dto = documentDto(list, deliveries.get(documentId) ?? [], viewer, urls);
    if (dto) byVisit.set(text(dto, 'visitId'), [...(byVisit.get(text(dto, 'visitId')) ?? []), dto]);
  }
  const names = new Map<string, string>();
  const name = (id: string) => { if (!names.has(id)) names.set(id, text(store.maybe(id)?.data ?? {}, 'name') || id); return names.get(id)!; };
  const visits = store.query('visit', 'patientId', patient.id).filter(visit => visit.status !== 'Cancelled' && visit.doctorId && /^\d{4}-\d{2}-\d{2}$/.test(text(visit.data, 'date')))
    .sort((a, b) => `${text(b.data, 'date')} ${text(b.data, 'time')}`.localeCompare(`${text(a.data, 'date')} ${text(a.data, 'time')}`))
    .map(visit => ({ visitId: visit.id, date: text(visit.data, 'date'), doctorId: visit.doctorId!, doctorName: name(visit.doctorId!), department: name(visit.department ?? ''), status: visitStatusCode(visit.status),
      completedAt: visit.status === 'Done' ? text(visit.data, 'completedAt') || text(visit.data, 'firstDoneAt') || null : null,
      documents: (byVisit.get(visit.id) ?? []).sort((a, b) => text(a, 'documentId').localeCompare(text(b, 'documentId'))) }));
  return { patient: patientSummary(patient), allergies: allergiesOf(store, patient.id), visits: json(visits), labResults: json(labResultsFor(store, patient.id, viewer, urls)), generatedAt: store.now() };
}
export function visitDelivery(store: Store, visit: Entity): Data {
  const versions = group(store.query('handwrittenDocument', 'patientId', visit.patientId ?? '').filter(version => text(version.data, 'visitId') === visit.id));
  const deliveries = store.query('handwritingDelivery', 'patientId', visit.patientId ?? '').filter(delivery => text(delivery.data, 'visitId') === visit.id);
  return { visitId: visit.id, documents: [...versions.values()].map(list => list.sort(byVersion).at(-1)!).map(latest => ({ documentId: text(latest.data, 'documentId'), version: versionNumber(latest),
    type: text(latest.data, 'type'), title: text(latest.data, 'title'), recipients: deliveries.filter(delivery => text(delivery.data, 'versionEntityId') === latest.id).map(recipientDto) })) };
}
export function queueEntry(store: Store, visit: Entity): Data {
  const patient = store.get(visit.patientId ?? '', 'patient');
  const status = visitStatusCode(visit.status);
  const earlier = store.query('visit', 'patientId', patient.id).filter(other => other.id !== visit.id && other.status === 'Done');
  const documents = new Set(store.query('handwrittenDocument', 'patientId', patient.id).filter(version => text(version.data, 'visitId') !== visit.id).map(version => text(version.data, 'documentId')));
  const lastVisitAt = earlier.map(other => text(other.data, 'completedAt') || text(other.data, 'firstDoneAt')).filter(Boolean).sort().at(-1) ?? null;
  const vital = store.query('vital', 'patientId', patient.id).filter(entry => text(entry.data, 'visitId') === visit.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  const numeric = (key: string, integer = false) => vital && typeof vital.data[key] === 'number' ? (integer ? Math.round(vital.data[key] as number) : vital.data[key] as number) : null;
  return {
    queueEntryId: visit.id, visitId: visit.id, token: status !== 'BOOKED' && num(visit.data, 'token') > 0 ? num(visit.data, 'token') : null, status, date: text(visit.data, 'date'), time: text(visit.data, 'time'),
    mode: text(visit.data, 'mode') || 'Walk-in', priority: bool(visit.data, 'priority'), checkedInAt: text(visit.data, 'checkinAt') || null, startedAt: text(visit.data, 'openedAt') || null,
    completedAt: status === 'COMPLETED' ? text(visit.data, 'completedAt') || null : null, returning: earlier.length > 0 || documents.size > 0, lastVisitAt, priorDocumentCount: documents.size,
    patient: { ...patientSummary(patient), allergies: allergiesOf(store, patient.id) },
    vitals: vital ? { bp: typeof vital.data.systolic === 'number' && typeof vital.data.diastolic === 'number' ? `${vital.data.systolic}/${vital.data.diastolic}` : null,
      pulse: numeric('pulse', true), tempC: numeric('temperature'), spo2: numeric('spo2', true), weightKg: numeric('weight'), recordedAt: vital.createdAt } : null,
    demoWalkIn: bool(visit.data, 'demoWalkIn')
  };
}
export const signedUrls = (store: Store, base: string): UrlMaker => sha256 => {
  const { exp, sig } = signBlob(store, sha256);
  return { url: `${base}/files/${sha256}?exp=${exp}&sig=${sig}`, exp };
};

// Web desk actions on handwritten copies (SJ10 pharmacy, SJ14/SJ15 lab, SJ36 patient portal).
export function handwritingCommand(name: string, ctx: Context): boolean {
  if (!name.startsWith('handwriting.')) return false;
  const delivery = ctx.targetOf('handwritingDelivery');
  const expected = ({ pharmacist: 'PHARMACY', lab: 'LAB', patient: 'PATIENT' } as Record<string, string>)[ctx.actor.role] ?? '';
  requireThat(text(delivery.data, 'recipient') === expected, 'This copy is addressed to a different recipient.', 'ACCESS_DENIED');
  const writer = contextWriter(ctx);
  switch (name) {
    case 'handwriting.view': moveDelivery(ctx.store, writer, delivery, 'VIEWED'); break;
    case 'handwriting.dispense': {
      const outcome = deliveryStateByLabel[ctx.t('outcome')];
      requireThat(outcome === 'DISPENSED' || ctx.t('note').trim().length >= 3, 'Explain what was not dispensed and what the patient should do.');
      moveDelivery(ctx.store, writer, delivery, outcome, ctx.t('note').trim()); break;
    }
    case 'handwriting.sample': moveDelivery(ctx.store, writer, delivery, 'SAMPLE_COLLECTED', ctx.t('note').trim()); break;
    case 'handwriting.result': {
      const result = enterResult(ctx.store, writer, ctx.actor, delivery, { testName: ctx.t('testName'), value: ctx.t('value'), unit: ctx.t('unit'), refRange: ctx.t('refRange'),
        flag: resultFlagCodes[ctx.t('flag')] ?? '', summary: ctx.t('summary') });
      ctx.result = { resultId: result.id, state: 'Entered - awaiting independent verification' }; break;
    }
    case 'handwriting.verify': ctx.result = { released: releaseResults(ctx.store, writer, ctx.actor, delivery).length }; break;
    default: return false;
  }
  return true;
}
