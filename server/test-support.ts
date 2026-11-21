import express, { type Request, type Response, type NextFunction, type Router } from 'express';
import { randomUUID } from 'node:crypto';
import { Store, requireThat } from './store.js';
import { execute } from './engine.js';
import { slotsFor } from './context.js';
import { ensurePatientFamily } from './auth.js';
import { text, istDate, type Actor, type Data, type Entity } from '../shared/model.js';
import { actorLabIds, deliveryStateLabels, resultFlagLabels } from '../shared/handwriting.js';
import { versionsOf, deliveriesOf, recipientDto } from './handwriting.js';
import { sendError } from './mobile-api.js';

// Isolated E2E shortcuts. Every step runs through the same engine commands and rules as the web desks.
export function testSupportRouter(store: Store): Router {
  const router = express.Router();
  router.use(express.json({ limit: '64kb', strict: true, type: () => true }));
  const run = (actor: Actor, name: string, payload: Data, target?: Entity) => {
    const anchor = target ?? (['visitId', 'admissionId', 'patientId'].map(key => text(payload, key)).filter(Boolean).map(id => store.get(id))[0]);
    return execute(store, actor, name, { operationId: `test-support-${randomUUID()}`, actorId: actor.id, targetId: target?.id, expectedVersion: anchor?.version, createdAt: store.now(), payload, deviceId: 'test-support' });
  };
  router.post('/visits', (req, res) => {
    const body = (req.body ?? {}) as Data;
    const desk = store.person('desk');
    const doctor = store.person(text(body, 'doctorId'));
    requireThat(doctor.role === 'doctor' && doctor.state === 'Active', 'doctorId must be an active consultant.');
    let patientId = text(body, 'patientId');
    if (!patientId) {
      const patient = (body.patient ?? {}) as Data;
      const registered = run(desk, 'patient.register', { name: text(patient, 'name'), age: Number(patient.age), sex: text(patient, 'sex'), mobile: text(patient, 'mobile'), address: 'Sample district',
        category: 'General', payer: 'Self', duplicateReason: 'Synthetic end-to-end test patient' });
      patientId = text(registered.data ?? {}, 'patientId');
    }
    const today = istDate(store.now());
    const slot = slotsFor(store, doctor.id, today, desk).find(entry => entry.state === 'Free' && !entry.extra);
    requireThat(slot, 'No free slot remains today for this doctor in the isolated backend.');
    const booked = run(desk, 'visit.book', { patientId, doctorId: doctor.id, date: today, time: text(slot, 'time'), mode: 'Walk-in', opdType: 'General', visitType: 'New' });
    const visitId = booked.entityIds.find(id => store.get(id).type === 'visit')!;
    const payer = text(store.get(patientId, 'patient').data, 'payer');
    run(desk, 'visit.checkin', { clearance: payer === 'Self' ? 'Collect at billing' : 'Covered' }, store.get(visitId, 'visit'));
    res.status(201).json({ visitId, patientId, token: store.get(visitId).data.token });
  });
  router.post('/deliveries', (req, res) => {
    const body = (req.body ?? {}) as Data;
    const documentId = text(body, 'documentId'); const recipient = text(body, 'recipient'); const labId = text(body, 'labId'); const state = text(body, 'state');
    const latest = versionsOf(store, documentId).at(-1);
    requireThat(latest, 'Unknown documentId.');
    let delivery = deliveriesOf(store, documentId).find(item => text(item.data, 'versionEntityId') === latest.id && text(item.data, 'recipient') === recipient && (recipient !== 'LAB' || text(item.data, 'labId') === labId));
    requireThat(delivery, 'That recipient is not routed for the latest version of this document.');
    requireThat(deliveryStateLabels[state] && state !== 'SUPERSEDED' && state !== 'AVAILABLE', 'Choose a recipient state to reach.');
    const step = (actor: Actor, name: string, payload: Data = {}) => { run(actor, name, payload, delivery); delivery = store.get(delivery!.id); };
    const current = () => text(delivery!.data, 'state');
    if (recipient === 'PHARMACY') {
      requireThat(['VIEWED', 'DISPENSED', 'PARTIALLY_DISPENSED', 'NOT_DISPENSED'].includes(state), 'Pharmacy states are VIEWED, DISPENSED, PARTIALLY_DISPENSED and NOT_DISPENSED.');
      const pharmacist = store.person('pharmacy');
      if (current() === 'AVAILABLE') step(pharmacist, 'handwriting.view');
      if (state !== 'VIEWED') step(pharmacist, 'handwriting.dispense', { outcome: deliveryStateLabels[state], note: text(body, 'note') || (state === 'DISPENSED' ? '' : 'Synthetic test note') });
    } else if (recipient === 'LAB') {
      requireThat(['VIEWED', 'SAMPLE_COLLECTED', 'RESULT_READY'].includes(state), 'Lab states are VIEWED, SAMPLE_COLLECTED and RESULT_READY.');
      const staff = store.people().filter(person => person.role === 'lab' && person.state === 'Active' && actorLabIds(person).includes(labId));
      const technician = staff.find(person => !person.verifier); const verifier = staff.find(person => person.verifier && person.id !== technician?.id);
      requireThat(technician && verifier, 'The isolated backend has no lab technician and verifier for that lab.');
      if (current() === 'AVAILABLE') step(technician, 'handwriting.view');
      if (state !== 'VIEWED' && current() === 'VIEWED') step(technician, 'handwriting.sample', { confirmed: true, note: text(body, 'note') });
      if (state === 'RESULT_READY') {
        const result = (body.result ?? {}) as Data;
        step(technician, 'handwriting.result', { testName: text(result, 'testName') || 'Synthetic test', value: text(result, 'value') || String(result.value ?? '1.0'), unit: text(result, 'unit'),
          refRange: text(result, 'refRange'), flag: resultFlagLabels[text(result, 'flag')] ?? 'Normal', summary: text(result, 'summary') });
        step(verifier, 'handwriting.verify', { confirmed: true });
      }
    } else if (recipient === 'PATIENT') {
      requireThat(state === 'VIEWED', 'The patient state is VIEWED.');
      const patient = store.get(delivery.patientId ?? '', 'patient');
      requireThat(text(patient.data, 'mobile'), 'This synthetic patient has no mobile for a patient-portal identity.');
      const family = ensurePatientFamily(store, text(patient.data, 'mobile'), [patient.id]);
      if (current() === 'AVAILABLE') step(family, 'handwriting.view');
    } else requireThat(false, 'recipient must be PHARMACY, LAB or PATIENT.');
    res.json({ documentId, delivery: recipientDto(store.get(delivery.id)) });
  });
  router.post('/clock', (req, res) => {
    const minutes = (req.body ?? {}).minutes;
    requireThat(typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0 && minutes <= 60 * 24 * 120, 'minutes must be 0-172800.');
    store.set('clockOffset', store.setting<number>('clockOffset', 0) + minutes * 60000);
    res.json({ now: store.now() });
  });
  router.use((_req: Request, _res: Response, next: NextFunction) => next(Object.assign(new Error('Not found'), { status: 404 })));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if ((error as { status?: number }).status === 404 && !(error instanceof Error && 'code' in error)) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown test-support route.', retryable: false } }); return; }
    sendError(res, error);
  });
  return router;
}
