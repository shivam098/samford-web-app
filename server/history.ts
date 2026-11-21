import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { istDate, text, type Actor, type Data } from '../shared/model.js';
import { routingFrom } from '../shared/handwriting.js';
import { Store } from './store.js';
import { syntheticDocument, placeholderInkFormat } from './fixtures.js';
import { storeTrustedBlob, mediaTypes, sha256Hex, inspectPng, inspectInk, type MediaType } from './blobs.js';
import { completeVisit, signAddendum, moveDelivery, enterResult, releaseResults, storeWriter, deliveriesOf, type DocumentInput, type PageInput, type ResultInput } from './handwriting.js';

type Addendum = { clientDocId: string; reason: string; pages: PageInput[]; pdfSha256: string; inkSha256: string | null; inkFormat: string | null; signedAt: string; hints?: Data };
type VisitSpec = { visitId: string; number: string; token: number; patientId: string; doctorId: string; date: string; signedAt: string; documents: DocumentInput[]; addenda: Addendum[]; result: ResultInput; patientViews: string[] };
export const fixtureDirectory = () => resolve(process.env.SAMFORD_FIXTURE_DIR ?? join('fixtures', 'seed-history'));
const results: Record<string, ResultInput> = {
  'patient-a': { testName: 'Haemoglobin (CBC)', value: '11.2', unit: 'g/dL', refRange: '12.0-15.5', flag: 'ABNORMAL', summary: 'Synthetic sample: mildly low haemoglobin.' },
  'patient-b': { testName: 'Fasting blood glucose', value: '148', unit: 'mg/dL', refRange: '70-99', flag: 'ABNORMAL', summary: 'Synthetic sample: raised fasting glucose.' }
};

// Runs the real domain flows with the clock pinned to a historical instant, so records, audit and feed events keep realistic times.
function at<T>(store: Store, instant: string, fn: () => T): T {
  store.now = () => instant;
  try { return fn(); } finally { Reflect.deleteProperty(store, 'now'); }
}
function actor(store: Store, id: string): Actor | undefined {
  const row = store.db.prepare('SELECT body FROM users WHERE id=?').get(id);
  return row ? JSON.parse(String(row.body)) as Actor : undefined;
}
const copy = (store: Store, documentId: string, kind: string) => deliveriesOf(store, documentId).find(item => text(item.data, 'recipient') === kind && text(item.data, 'state') !== 'SUPERSEDED');
const visitIdFor = (patientId: string) => `visit-history-${patientId.replace(/^patient-/, '')}`;
const visitNumberFor = (patientId: string) => `V-${patientId.replace(/-/g, '').toUpperCase()}`;

function seedVisit(store: Store, spec: VisitSpec): string | undefined {
  const patient = store.maybe(spec.patientId); const doctor = actor(store, spec.doctorId);
  if (patient?.status !== 'Active' || !doctor || doctor.role !== 'doctor' || store.maybe(spec.visitId)) return undefined;
  const signed = Date.parse(spec.signedAt); const t = (minutes: number) => new Date(signed + minutes * 60000).toISOString();
  const visit = at(store, t(-30), () => store.create('visit', {
    number: spec.number, name: `${spec.date} history`, date: spec.date, time: new Date(signed - 30 * 60000 + 330 * 60000).toISOString().slice(11, 16), token: spec.token, mode: 'Walk-in', opdType: 'General',
    visitType: 'New', room: text(store.maybe(doctor.id)?.data ?? {}, 'room') || 'Room 1', priority: false, checkinAt: t(-30), openedAt: t(-20), identityConfirmed: true, calls: 1, moves: [], source: 'Seeded synthetic history'
  }, doctor.id, { id: spec.visitId, status: 'In consultation', patientId: spec.patientId, doctorId: doctor.id, department: doctor.department }));
  const completed = at(store, t(1), () => completeVisit(store, doctor, visit.id, { bundleId: randomUUID(), completedAt: spec.signedAt, documents: spec.documents }, { coding: false }));
  const ids = new Map((completed.documents as Data[]).map(doc => [text(doc, 'clientDocId'), text(doc, 'documentId')]));
  const byType = (type: string) => ids.get(spec.documents.find(doc => doc.type === type)?.clientDocId ?? '');
  const pharmacist = actor(store, 'pharmacy'); const lab = actor(store, 'lab'); const verifier = actor(store, 'verifier');
  const rxId = byType('PRESCRIPTION'); const testsId = byType('INVESTIGATIONS');
  const move = (who: Actor | undefined, documentId: string | undefined, kind: string, state: string, minutes: number, note = '') => {
    const target = documentId ? copy(store, documentId, kind) : undefined;
    if (who && target) at(store, t(minutes), () => moveDelivery(store, storeWriter(store, who.id), target, state, note));
  };
  move(pharmacist, rxId, 'PHARMACY', 'VIEWED', 15);
  let dispenseAt = 30;
  for (const addendum of spec.addenda) {
    const documentId = ids.get(addendum.clientDocId); if (!documentId) continue;
    const minutes = Math.max(16, Math.round((Date.parse(addendum.signedAt) - signed) / 60000) + 1);
    at(store, t(minutes), () => signAddendum(store, doctor, documentId, { clientAddendumId: randomUUID(), baseVersion: 1, reason: addendum.reason, pages: addendum.pages, pdfSha256: addendum.pdfSha256,
      inkSha256: addendum.inkSha256, inkFormat: addendum.inkFormat, signedAt: addendum.signedAt, ...(addendum.hints ? { hints: addendum.hints } : {}) }));
    if (documentId === rxId) { move(pharmacist, rxId, 'PHARMACY', 'VIEWED', minutes + 10); dispenseAt = minutes + 25; }
  }
  move(pharmacist, rxId, 'PHARMACY', 'DISPENSED', dispenseAt);
  if (testsId && lab && verifier) {
    move(lab, testsId, 'LAB', 'VIEWED', 20);
    move(lab, testsId, 'LAB', 'SAMPLE_COLLECTED', 35, 'Synthetic sample collected');
    const target = () => copy(store, testsId, 'LAB');
    if (target()?.data.state === 'SAMPLE_COLLECTED') {
      at(store, t(300), () => enterResult(store, storeWriter(store, lab.id), lab, target()!, spec.result));
      at(store, t(360), () => releaseResults(store, storeWriter(store, verifier.id), verifier, target()!));
    }
  }
  const family = store.patientAccountByMobile(text(patient.data, 'mobile'));
  if (family) for (const type of spec.patientViews) move(family, byType(type), 'PATIENT', 'VIEWED', 540);
  return visit.id;
}

function pdfLooksValid(bytes: Buffer) {
  return /^%PDF-[12]\.\d/.test(bytes.subarray(0, 8).toString('latin1')) && bytes.subarray(Math.max(0, bytes.length - 1024)).toString('latin1').includes('%%EOF');
}
// Reads the doctor app's samford-ink/1 fixtures. Every blob is hash- and structure-checked before anything is stored.
function fixtureSpecs(store: Store): { specs: VisitSpec[]; source: string } | undefined {
  const directory = fixtureDirectory(); const manifestPath = join(directory, 'manifest.json');
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Data[];
  if (!Array.isArray(manifest) || !manifest.length) throw new Error('The fixture manifest is empty.');
  const blobs = new Map<string, { bytes: Buffer; type: MediaType; dimensions?: { width: number; height: number } }>();
  const need = (sha256: string, type: MediaType) => {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('A fixture blob reference is not a SHA-256.');
    if (blobs.has(sha256)) return;
    const bytes = readFileSync(join(directory, 'blobs', `${sha256}.${type === mediaTypes.png ? 'png' : type === mediaTypes.pdf ? 'pdf' : 'json'}`));
    if (sha256Hex(bytes) !== sha256) throw new Error(`Fixture ${sha256} does not match its hash.`);
    const dimensions = type === mediaTypes.png ? inspectPng(bytes) : undefined;
    if (type === mediaTypes.ink) inspectInk(bytes);
    if (type === mediaTypes.pdf && !pdfLooksValid(bytes)) throw new Error(`Fixture ${sha256} is not a PDF.`);
    blobs.set(sha256, { bytes, type, dimensions });
  };
  const pages = (list: unknown): PageInput[] => (Array.isArray(list) ? list as Data[] : []).map(page => {
    need(text(page, 'pngSha256'), mediaTypes.png);
    return { index: Number(page.index), pngSha256: text(page, 'pngSha256'), widthPx: Number(page.widthPx), heightPx: Number(page.heightPx) };
  });
  const content = (doc: Data) => {
    need(text(doc, 'pdfSha256'), mediaTypes.pdf);
    if (text(doc, 'inkSha256')) need(text(doc, 'inkSha256'), mediaTypes.ink);
    return { pages: pages(doc.pages), pdfSha256: text(doc, 'pdfSha256'), inkSha256: text(doc, 'inkSha256') || null, inkFormat: text(doc, 'inkFormat') || null,
      ...(doc.hints && typeof doc.hints === 'object' && !Array.isArray(doc.hints) ? { hints: doc.hints as Data } : {}) };
  };
  const specs = manifest.map((visit, index): VisitSpec => {
    const patientId = text(visit, 'patientId'); const signedAt = new Date(text(visit, 'signedAt')).toISOString();
    return {
      visitId: visitIdFor(patientId), number: visitNumberFor(patientId), token: index + 1, patientId, doctorId: text(visit, 'doctorId'), date: text(visit, 'visitDate') || istDate(signedAt), signedAt,
      documents: (visit.documents as Data[]).map(doc => ({ clientDocId: text(doc, 'clientDocId'), type: text(doc, 'type'), title: text(doc, 'title'), routing: routingFrom(doc.routing), signedAt, ...content(doc) })),
      addenda: (Array.isArray(visit.addenda) ? visit.addenda as Data[] : []).map(addendum => ({ clientDocId: text(addendum, 'clientDocId') || text(addendum, 'documentClientDocId'), reason: text(addendum, 'reason'),
        signedAt: new Date(text(addendum, 'signedAt')).toISOString(), ...content(addendum) })),
      result: results[patientId] ?? results['patient-a'], patientViews: patientId === 'patient-a' ? ['VISIT_SUMMARY', 'PRESCRIPTION'] : []
    };
  });
  for (const [sha256, blob] of blobs) if (storeTrustedBlob(store, blob.type, blob.bytes, 'doctor-app-fixtures', blob.dimensions) !== sha256) throw new Error('Fixture storage mismatch.');
  return { specs, source: `doctor-app samford-ink/1 fixtures (${blobs.size} blobs)` };
}
// Fallback when fixtures are unavailable: deterministic placeholder pages, same visits, relative dates.
function placeholderSpecs(store: Store): VisitSpec[] {
  const now = Date.parse(store.now());
  const document = (seed: string, kind: 'summary' | 'prescription' | 'investigations', type: string, title: string, count: number, routing: DocumentInput['routing'], signedAt: string, hints?: Data): DocumentInput => {
    const doc = syntheticDocument(seed, kind, count, title);
    return { clientDocId: randomUUID(), type, title, routing, signedAt, ...(hints ? { hints } : {}), inkFormat: placeholderInkFormat,
      pages: doc.pages.map((page, index) => ({ index, pngSha256: storeTrustedBlob(store, mediaTypes.png, page.png, 'placeholder-fixtures', { width: page.width, height: page.height }), widthPx: page.width, heightPx: page.height })),
      pdfSha256: storeTrustedBlob(store, mediaTypes.pdf, doc.pdf, 'placeholder-fixtures'), inkSha256: storeTrustedBlob(store, mediaTypes.ink, doc.ink, 'placeholder-fixtures') };
  };
  return [['patient-a', 14, 1], ['patient-b', 30, 2]].map(([patientId, daysAgo, token]) => {
    const id = String(patientId); const date = istDate(new Date(now - Number(daysAgo) * 86400000).toISOString()); const signedAt = new Date(`${date}T10:10:00+05:30`).toISOString();
    const medicines = { medicines: [{ name: 'Sample Paracetamol 500', strength: '500 mg', dose: '1 tablet', frequency: 'Three times a day', durationDays: 5 }] };
    const rx = document(`history-${id}-rx`, 'prescription', 'PRESCRIPTION', 'Prescription', 1, { pharmacy: true, labs: [], patient: true }, signedAt, medicines);
    const addendum = id === 'patient-b' ? [{ clientDocId: rx.clientDocId!, reason: 'Corrected dose and duration (synthetic sample)', signedAt: new Date(Date.parse(signedAt) + 30 * 60000).toISOString(),
      ...(({ pages, pdfSha256, inkSha256, inkFormat }) => ({ pages, pdfSha256, inkSha256, inkFormat }))(document(`history-${id}-rx-v2`, 'prescription', 'PRESCRIPTION', 'Prescription', 1, { pharmacy: true, labs: [], patient: true }, signedAt)) }] : [];
    return { visitId: visitIdFor(id), number: visitNumberFor(id), token: Number(token), patientId: id, doctorId: 'doctor-c', date, signedAt, addenda: addendum, result: results[id], patientViews: id === 'patient-a' ? ['VISIT_SUMMARY', 'PRESCRIPTION'] : [],
      documents: [document(`history-${id}-summary`, 'summary', 'VISIT_SUMMARY', 'Visit summary', 2, { pharmacy: false, labs: [], patient: true }, signedAt, { diagnosis: 'Synthetic sample: review' }), rx,
        document(`history-${id}-tests`, 'investigations', 'INVESTIGATIONS', 'Investigations', 1, { pharmacy: false, labs: ['central-lab'], patient: true }, signedAt, { tests: [{ name: 'Synthetic test panel' }] })] };
  });
}
export function seedHandwritingHistory(store: Store): Data {
  if (store.maybe(visitIdFor('patient-a')) || store.maybe(visitIdFor('patient-b'))) return { historyVisitsAdded: [], historySource: 'already present' };
  store.db.exec('SAVEPOINT handwriting_fixtures');
  let problem = '';
  try {
    const fixtures = fixtureSpecs(store);
    if (fixtures) {
      const added = fixtures.specs.map(spec => seedVisit(store, spec)).filter((id): id is string => Boolean(id));
      store.db.exec('RELEASE handwriting_fixtures');
      return { historyVisitsAdded: added, historySource: fixtures.source };
    }
    problem = 'fixture folder not found';
    store.db.exec('RELEASE handwriting_fixtures');
  } catch (error) {
    problem = error instanceof Error ? error.message : 'fixture seeding failed';
    store.db.exec('ROLLBACK TO handwriting_fixtures'); store.db.exec('RELEASE handwriting_fixtures');
  }
  const added = placeholderSpecs(store).map(spec => seedVisit(store, spec)).filter((id): id is string => Boolean(id));
  return { historyVisitsAdded: added, historySource: 'synthetic placeholder pages', fixtureProblem: problem };
}
