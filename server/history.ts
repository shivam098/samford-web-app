import { randomUUID } from 'node:crypto';
import { istDate, text, type Actor, type Data, type Entity } from '../shared/model.js';
import { Store } from './store.js';
import { syntheticDocument, placeholderInkFormat } from './fixtures.js';
import { storeTrustedBlob, mediaTypes } from './blobs.js';
import { completeVisit, signAddendum, moveDelivery, enterResult, releaseResults, storeWriter, deliveriesOf } from './handwriting.js';

type Kind = 'summary' | 'prescription' | 'investigations';
function blobsFor(store: Store, seed: string, kind: Kind, pageCount: number, title: string, actorId: string) {
  const doc = syntheticDocument(seed, kind, pageCount, title);
  return {
    pages: doc.pages.map((page, index) => ({ index, pngSha256: storeTrustedBlob(store, mediaTypes.png, page.png, actorId, { width: page.width, height: page.height }), widthPx: page.width, heightPx: page.height })),
    pdfSha256: storeTrustedBlob(store, mediaTypes.pdf, doc.pdf, actorId), inkSha256: storeTrustedBlob(store, mediaTypes.ink, doc.ink, actorId), inkFormat: placeholderInkFormat
  };
}
// Runs the real domain flows with the clock pinned to a historical instant, so records, audit and feed events keep realistic times.
function at<T>(store: Store, instant: string, fn: () => T): T {
  store.now = () => instant;
  try { return fn(); } finally { Reflect.deleteProperty(store, 'now'); }
}
function actor(store: Store, id: string): Actor | undefined {
  const row = store.db.prepare('SELECT body FROM users WHERE id=?').get(id);
  return row ? JSON.parse(String(row.body)) as Actor : undefined;
}
const copy = (store: Store, documentId: string, kind: string) => deliveriesOf(store, documentId).find(item => text(item.data, 'recipient') === kind && text(item.data, 'state') !== 'SUPERSEDED')!;

export function seedHandwritingHistory(store: Store): Data {
  const added: string[] = [];
  const now = Date.parse(store.now());
  const day = (daysAgo: number) => { const date = istDate(new Date(now - daysAgo * 86400000).toISOString()); return { date, at: (clock: string) => new Date(`${date}T${clock}:00+05:30`).toISOString() }; };
  const visit = (id: string, patientId: string, doctor: Actor, date: string, checkin: string, opened: string, token: number): Entity => at(store, checkin, () => store.create('visit', {
    number: `OPD-${id.toUpperCase()}`, name: `${date} 10:00`, date, time: '10:00', token, mode: 'Walk-in', opdType: 'General', visitType: 'Follow-up', room: text(store.maybe(doctor.id)?.data ?? {}, 'room') || 'Room 1',
    priority: false, checkinAt: checkin, openedAt: opened, identityConfirmed: true, calls: 1, moves: [], source: 'Seeded synthetic history'
  }, doctor.id, { id, status: 'In consultation', patientId, doctorId: doctor.id, department: doctor.department }));
  const [doctorC, lab, verifier, pharmacist, family] = ['doctor-c', 'lab', 'verifier', 'pharmacy', 'family'].map(id => actor(store, id));
  const patientA = store.maybe('patient-a'); const patientB = store.maybe('patient-b');
  if (patientA?.status === 'Active' && doctorC && lab && verifier && pharmacist && !store.maybe('visit-history-a')) {
    const d = day(21);
    const record = visit('visit-history-a', patientA.id, doctorC, d.date, d.at('09:40'), d.at('09:55'), 4);
    const signedAt = d.at('10:18');
    const result = at(store, d.at('10:20'), () => completeVisit(store, doctorC, record.id, { bundleId: randomUUID(), completedAt: d.at('10:19'), documents: [
      { clientDocId: randomUUID(), type: 'VISIT_SUMMARY', title: 'Visit summary', ...blobsFor(store, 'history-a-summary', 'summary', 2, 'Visit summary', doctorC.id), routing: { pharmacy: false, labs: [], patient: true },
        hints: { diagnosis: 'Synthetic sample: fever review' }, signedAt },
      { clientDocId: randomUUID(), type: 'PRESCRIPTION', title: 'Prescription', ...blobsFor(store, 'history-a-rx', 'prescription', 1, 'Prescription', doctorC.id), routing: { pharmacy: true, labs: [], patient: true },
        hints: { medicines: [{ name: 'Sample Paracetamol 500', strength: '500 mg', dose: '1 tablet', frequency: 'Three times a day', durationDays: 5 }] }, signedAt },
      { clientDocId: randomUUID(), type: 'INVESTIGATIONS', title: 'Investigations', ...blobsFor(store, 'history-a-tests', 'investigations', 1, 'Investigations', doctorC.id), routing: { pharmacy: false, labs: ['central-lab'], patient: true },
        hints: { tests: [{ name: 'Complete blood count', code: '57021-8' }] }, signedAt }
    ] }, { coding: false }));
    const [summaryId, rxId, testsId] = (result.documents as Data[]).map(doc => text(doc, 'documentId'));
    at(store, d.at('10:35'), () => moveDelivery(store, storeWriter(store, pharmacist.id), copy(store, rxId, 'PHARMACY'), 'VIEWED'));
    at(store, d.at('10:50'), () => moveDelivery(store, storeWriter(store, pharmacist.id), copy(store, rxId, 'PHARMACY'), 'DISPENSED'));
    at(store, d.at('10:40'), () => moveDelivery(store, storeWriter(store, lab.id), copy(store, testsId, 'LAB'), 'VIEWED'));
    at(store, d.at('11:00'), () => moveDelivery(store, storeWriter(store, lab.id), copy(store, testsId, 'LAB'), 'SAMPLE_COLLECTED', 'Synthetic sample collected'));
    at(store, d.at('15:00'), () => enterResult(store, storeWriter(store, lab.id), lab, copy(store, testsId, 'LAB'),
      { testName: 'Haemoglobin (CBC)', value: '11.2', unit: 'g/dL', refRange: '12.0-15.5', flag: 'ABNORMAL', summary: 'Synthetic sample: mildly low haemoglobin.' }));
    at(store, d.at('16:00'), () => releaseResults(store, storeWriter(store, verifier.id), verifier, copy(store, testsId, 'LAB')));
    if (family) for (const documentId of [summaryId, rxId]) at(store, d.at('19:00'), () => moveDelivery(store, storeWriter(store, family.id), copy(store, documentId, 'PATIENT'), 'VIEWED'));
    added.push(record.id);
  }
  if (patientB?.status === 'Active' && doctorC && pharmacist && !store.maybe('visit-history-b')) {
    const d = day(14);
    const record = visit('visit-history-b', patientB.id, doctorC, d.date, d.at('09:50'), d.at('10:00'), 3);
    const result = at(store, d.at('10:15'), () => completeVisit(store, doctorC, record.id, { bundleId: randomUUID(), completedAt: d.at('10:14'), documents: [
      { clientDocId: randomUUID(), type: 'VISIT_SUMMARY', title: 'Visit summary', ...blobsFor(store, 'history-b-summary', 'summary', 1, 'Visit summary', doctorC.id), routing: { pharmacy: false, labs: [], patient: true },
        hints: { diagnosis: 'Synthetic sample: blood pressure review' }, signedAt: d.at('10:12') },
      { clientDocId: randomUUID(), type: 'PRESCRIPTION', title: 'Prescription', ...blobsFor(store, 'history-b-rx-v1', 'prescription', 1, 'Prescription', doctorC.id), routing: { pharmacy: true, labs: [], patient: true },
        hints: { medicines: [{ name: 'Sample Paracetamol 500', strength: '500 mg', dose: '2 tablets', frequency: 'Twice a day', durationDays: 3 }] }, signedAt: d.at('10:13') }
    ] }, { coding: false }));
    const rxId = text((result.documents as Data[])[1], 'documentId');
    at(store, d.at('10:30'), () => moveDelivery(store, storeWriter(store, pharmacist.id), copy(store, rxId, 'PHARMACY'), 'VIEWED'));
    at(store, d.at('10:45'), () => signAddendum(store, doctorC, rxId, { clientAddendumId: randomUUID(), baseVersion: 1, reason: 'Corrected dose and duration (synthetic sample)',
      ...blobsFor(store, 'history-b-rx-v2', 'prescription', 1, 'Prescription', doctorC.id),
      hints: { medicines: [{ name: 'Sample Paracetamol 500', strength: '500 mg', dose: '1 tablet', frequency: 'Three times a day', durationDays: 5 }] }, signedAt: d.at('10:44') }));
    at(store, d.at('11:00'), () => moveDelivery(store, storeWriter(store, pharmacist.id), copy(store, rxId, 'PHARMACY'), 'VIEWED'));
    at(store, d.at('11:10'), () => moveDelivery(store, storeWriter(store, pharmacist.id), copy(store, rxId, 'PHARMACY'), 'DISPENSED'));
    added.push(record.id);
  }
  return { historyVisitsAdded: added };
}
