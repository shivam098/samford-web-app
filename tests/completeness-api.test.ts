import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { testHospital, medicineLine, notePayload, prepareAdmission } from './harness.js';
import { makePdf } from '../server/documents.js';
import { text, num, rows, strings, type Data, type Entity } from '../shared/model.js';
import { defaultHomeLayout } from '../shared/home.js';
import { handoverGroups } from '../shared/handover.js';
import { commands } from '../shared/commands.js';
import { hi } from '../shared/i18n.js';

test('applied deposits cannot be refunded again and pending refunds are reserved before final billing', async () => {
  const h = await testHospital();
  try {
    const admission = await prepareAdmission(h);
    const cashier = await h.client('cashier'); const doctor = await h.client('doctor-a'); const manager = await h.client('manager');
    const deposit = await cashier.entity('admission.advance', { amount: 1000 }, admission.id, 'bill');
    await cashier.cmd('bill.pay', { payments: [{ mode: 'Cash', amount: 1000 }], outcome: 'Success' }, deposit.id);
    const lineId = text(rows(deposit.data, 'lines')[0], 'id');
    const pending = await cashier.entity('refund.request', { billId: deposit.id, lineId, amount: 100, reason: 'Synthetic pre-bill deposit refund' }, undefined, 'refund');
    const discharge = await doctor.entity('discharge.draft', { admissionId: admission.id, diagnosis: 'Sample condition', course: 'Sample stay', procedures: 'No procedure', condition: 'Sample stable', lines: [medicineLine()], followup: 'Sample review', reviewed: true }, undefined, 'discharge');
    await doctor.cmd('discharge.approve', { pin: '2468', pendingPlan: 'No unowned work', reviewed: true }, discharge.id);
    await cashier.cmd('discharge.bill', {}, discharge.id);
    const final = h.store.get(text(h.store.get(admission.id).data, 'finalBillId'));
    assert.equal(num(final.data, 'recordedAdvances'), 90000);
    const approval = h.store.all('approval').find(entry => text(entry.data, 'targetId') === pending.id)!;
    await manager.cmd('approval.decide', { decision: 'Approve', reason: 'Independent refund review' }, approval.id);
    await cashier.cmd('refund.request', { billId: deposit.id, lineId, amount: 900, reason: 'Would refund an applied deposit' }, undefined, 422);
    const unused = num(final.data, 'advanceRefundDue');
    const refund = await cashier.entity('refund.request', { billId: deposit.id, lineId, amount: unused / 100, reason: 'Refund only unused deposit' }, undefined, 'refund');
    await cashier.cmd('refund.request', { billId: deposit.id, lineId, amount: 0.01, reason: 'Already reserved' }, undefined, 422);
    await manager.cmd('approval.decide', { decision: 'Approve', reason: 'Independent unused-balance review' }, h.store.all('approval').find(entry => text(entry.data, 'targetId') === refund.id)!.id);
    assert.equal(num(h.store.get(deposit.id).data, 'refunded') + num(final.data, 'appliedAdvance'), 100000);
    await cashier.cmd('admission.advance', { amount: 100 }, admission.id, 422);
  } finally { await h.close(); }
});

test('department-head identity projection is department-scoped and staff read projections exclude credentials', async () => {
  const h = await testHospital();
  try {
    const head = await (await h.client('head')).request('/api/state');
    assert.ok(head.people.every((person: { id: string; department: string }) => person.id === 'head' || person.department === 'general'));
    assert.ok(!head.people.some((person: { id: string }) => person.id === 'doctor-b'));
    const doctor = await (await h.client('doctor-a')).request('/api/state');
    assert.ok(doctor.people.some((person: { id: string }) => person.id === 'nurse'));
    assert.ok(doctor.people.filter((person: { id: string }) => person.id !== 'doctor-a').every((person: { login: string; mobile: string; patientIds: string[] }) => !person.login && !person.mobile && person.patientIds.length === 0));
  } finally { await h.close(); }
});

test('explicit synthetic reset rebuilds current role and payer fixtures without discarding earlier audit', async () => {
  const h = await testHospital();
  try {
    const superuser = await h.client('super'); const dual = await h.client('desk-cashier');
    const earlier = h.store.audits();
    await superuser.request('/api/demo/reset', 'POST', { confirm: 'RESET SHARED SYNTHETIC DATA' });
    await dual.request('/api/state', 'GET', undefined, 401); await dual.login();
    assert.deepEqual(h.store.person('desk-cashier').roles, ['desk', 'cashier']);
    assert.equal(h.store.setting('schemaVersion', 0), 2);
    assert.equal(h.store.get('scheme-ayushman-admission').status, 'Active');
    for (const audit of earlier) assert.ok(h.store.audits().some(entry => entry.seq === audit.seq));
  } finally { await h.close(); }
});

test('multi-role staff combine permissions without changing identity or bypassing a second approver', async () => {
  const h = await testHospital();
  try {
    const dual = await h.client('desk-cashier'); const superuser = await h.client('super'); const manager = await h.client('manager');
    await dual.cmd('counter.choose', { counter: 'OPD 2', printer: 'Sample combined-role printer' }, undefined, 200, 'cashier');
    assert.equal(h.store.person('desk-cashier').role, 'desk');
    assert.deepEqual(h.store.person('desk-cashier').roles, ['desk', 'cashier']);
    await dual.request('/api/state');
    const patient = await dual.entity('patient.register', { name: 'Dual-role sample patient', age: 30, sex: 'Female', mobile: '9000099111', address: 'Sample district', category: 'General', payer: 'Self', unknown: false, mlc: false }, undefined, 'patient');
    const bill = await dual.entity('bill.service', { patientId: patient.id, tariffId: 'tariff-consultation', quantity: 1, emergency: false }, undefined, 'bill');
    const paid = await dual.cmd('bill.pay', { payments: [{ mode: 'UPI', amount: 500 }], outcome: 'Success' }, bill.id, 200, 'cashier');
    assert.equal(paid.data?.actingRole, 'cashier'); assert.equal(h.store.get(paid.entityIds.find(id => h.store.get(id).type === 'payment')!).createdBy, 'desk-cashier');
    await dual.cmd('note.save', notePayload, undefined, 403);
    await superuser.cmd('account.role', { role: 'desk', roles: ['cashier', 'manager'], departmentId: 'general', reason: 'Synthetic combined staff duties', confirmed: true }, 'desk-cashier');
    await dual.request('/api/state', 'GET', undefined, 401); await dual.login();
    const writeoff = await dual.entity('stock.writeoff', { batchId: 'batch-expired', quantity: 1, reason: 'Synthetic stock check' }, undefined, 'writeoff');
    const approval = h.store.all('approval').find(entry => text(entry.data, 'targetId') === writeoff.id)!;
    await dual.cmd('approval.decide', { decision: 'Approve', reason: 'Same person in another role' }, approval.id, 422, 'manager');
    await manager.cmd('approval.decide', { decision: 'Approve', reason: 'Different person reviewed it' }, approval.id);
    assert.equal(h.store.get(writeoff.id).status, 'Completed');
    await superuser.cmd('account.role', { role: 'desk', roles: ['doctor'], departmentId: 'general', reason: 'Invalid hybrid identity', confirmed: true }, 'desk-cashier', 422);
    await superuser.cmd('account.role', { role: 'desk', roles: [], departmentId: 'general', reason: 'Withdraw finance roles', confirmed: true }, 'desk-cashier');
    await dual.request('/api/state', 'GET', undefined, 401); await dual.login();
    await dual.cmd('bill.discount', { percent: 5, reason: 'No longer permitted' }, bill.id, 403);
  } finally { await h.close(); }
});

test('paper prescriptions require identity and readable scan, preserve attribution and dispense only approved original items', async () => {
  const h = await testHospital();
  try {
    const pharmacy = await h.client('pharmacy'); const doctor = await h.client('doctor-a'); const stranger = await h.client('doctor-b');
    const file = { name: 'synthetic-paper-rx.pdf', mime: 'application/pdf', base64: (await makePdf('Synthetic paper Rx', ['External demo prescriber. Sample medicine instructions.'], {})).toString('base64') };
    const payload: Data = { patientId: 'patient-a', prescriberName: 'External demo doctor', registration: 'SAMPLE-EXTERNAL-REG', prescriptionDate: h.today(), file, lines: [medicineLine()], transcriptionConfirmed: true, synthetic: true };
    await pharmacy.cmd('pharmacy.paperRx', { ...payload, registration: '' }, undefined, 422);
    await pharmacy.cmd('pharmacy.paperRx', { ...payload, file: { ...file, base64: Buffer.from('not a valid scan').toString('base64') } }, undefined, 422);
    const rx = await pharmacy.entity('pharmacy.paperRx', payload, undefined, 'rx');
    assert.equal(rx.createdBy, 'pharmacy'); assert.equal(text(rx.data, 'authorId'), 'paper:SAMPLE-EXTERNAL-REG'); assert.equal(text(rx.data, 'source'), 'Paper');
    const scanId = text(rx.data, 'scanDocumentId');
    await pharmacy.request(`/api/entities/${scanId}`); await stranger.request(`/api/entities/${scanId}`, 'GET', undefined, 404);
    const lineId = text(rows(rx.data, 'lines')[0], 'id');
    await pharmacy.cmd('pharmacy.question', { lineId, proposedItemId: 'medicine-alt', reason: 'No in-app author is assigned' }, rx.id, 422);
    await pharmacy.cmd('pharmacy.dispense', { lineId, batchId: 'batch-a', quantity: 5, nearExpiry: true }, rx.id);
    assert.equal(h.store.get(rx.id).status, 'Dispensed');
    const printable = await doctor.entity('document.generate', { patientId: 'patient-a', kind: 'Prescription', sourceId: rx.id }, undefined, 'document');
    assert.ok(strings(printable.data, 'lines').some(line => line.includes('External demo doctor') && line.includes('SAMPLE-EXTERNAL-REG')));
  } finally { await h.close(); }
});

test('Home layout validates ordering, per-card rows, locked cards and hospital-default reset', async () => {
  const h = await testHospital();
  try {
    const doctor = await h.client('doctor-a'); const admin = await h.client('admin');
    const preferences: Data = { theme: 'Dark', textSize: '125%', language: 'English', printLanguage: 'English', quietFrom: '22:00', quietTo: '07:00',
      homeOrder: 'visits,referrals,results,admissions,pending', hiddenCards: '', rows: 5, sort: 'Token', shortcuts: 'DJ09,DJ20' };
    const layout = { cards: [{ id: 'results', visible: true, rows: 2 }, { id: 'referrals', visible: true, rows: 3 }, { id: 'visits', visible: true, rows: 1 }, { id: 'admissions', visible: false, rows: 4 }, { id: 'pending', visible: true, rows: 6 }] };
    await doctor.cmd('preferences.save', { ...preferences, layout });
    const saved = h.store.person('doctor-a').preferences;
    assert.equal(text(saved, 'homeOrder'), 'results,referrals,visits,admissions,pending'); assert.equal(text(saved, 'hiddenCards'), 'admissions');
    assert.equal((saved.cardRows as Data).visits, 1);
    await doctor.cmd('preferences.save', { ...preferences, layout: { cards: layout.cards.map(card => card.id === 'referrals' ? { ...card, visible: false } : card) } }, undefined, 422);
    const defaults = defaultHomeLayout();
    await admin.cmd('home.defaults', { departmentId: 'general', layout: defaults, lockedCards: ['admissions'], reason: 'Department review' });
    const effective = await doctor.request('/api/state');
    assert.equal(effective.actor.preferences.hiddenCards, '');
    await doctor.cmd('preferences.save', { ...preferences, layout }, undefined, 422);
    await doctor.cmd('preferences.resetHome', { confirmed: true });
    const reset = h.store.person('doctor-a').preferences;
    assert.equal(text(reset, 'homeOrder'), 'visits,referrals,results,admissions,pending'); assert.equal(text(reset, 'theme'), 'Dark'); assert.equal(text(reset, 'shortcuts'), 'DJ09,DJ20');
  } finally { await h.close(); }
});

test('per-group handover blocks omissions and unsent loss, supports department queues and preserves clinical authors', async () => {
  const h = await testHospital();
  try {
    const admin = await h.client('admin'); const doctor = await h.client('doctor-a'); const resident = await h.client('resident'); const other = await h.client('doctor-b');
    const draft = await resident.entity('note.save', { ...notePayload, icd: '' }, undefined, 'note');
    const sent = await doctor.entity('referral.send', { visitId: 'visit-a', kind: 'Internal', departmentId: 'surgery', receiverId: 'doctor-b', purpose: 'Treatment', date: h.today(), urgency: 'Urgent', reason: 'Synthetic referral' }, undefined, 'referral');
    const summary = await admin.request('/api/accounts/doctor-a/handover');
    assert.ok(summary.groups.some((group: Data) => group.key === 'unsignedNotes' && group.count === 1));
    assert.ok(!JSON.stringify(summary).includes('Synthetic browser note'));
    const choices = handoverGroups.map(group => ({ group: group.key, receiverType: 'Doctor', receiverId: 'doctor-b' }));
    await admin.cmd('account.deactivate', { handovers: choices.filter(group => group.group !== 'unsignedNotes'), confirmName: 'Demo doctor A', reason: 'Synthetic exit', unsentPlan: 'No pending device items', confirmed: true }, 'doctor-a', 422);
    await doctor.request('/api/sync/device', 'POST', { unsent: 2 });
    await admin.cmd('account.deactivate', { handovers: choices, confirmName: 'Demo doctor A', reason: 'Synthetic exit', unsentPlan: 'Wait for device', unsentAction: 'Wait for sync', confirmed: true }, 'doctor-a', 422);
    await admin.cmd('account.deactivate', { handovers: choices, confirmName: 'Demo doctor A', reason: 'Synthetic exit', unsentPlan: 'Accepted synthetic unsent loss for this test', unsentAction: 'Accept unsent loss with reason', confirmed: true }, 'doctor-a');
    assert.equal(h.store.get(draft.id).doctorId, 'doctor-b'); assert.equal(h.store.get(draft.id).createdBy, 'resident');
    assert.equal(h.store.get(sent.id).createdBy, 'doctor-a'); assert.equal(text(h.store.get(sent.id).data, 'senderId'), 'doctor-a');
    assert.ok((await other.request('/api/entities?type=note')).some((entity: Entity) => entity.id === draft.id));
    assert.ok(h.store.all('device').filter(device => text(device.data, 'actorId') === 'doctor-a').every(device => device.status === 'Signed out'));
    const visitCount = h.store.all('visit').length;
    await other.cmd('referral.answer', { decision: 'Accept', reply: 'Reuse inherited active visit' }, sent.id);
    assert.equal(h.store.all('visit').length, visitCount);
    const tokens = h.store.all('visit').filter(entry => entry.doctorId === 'doctor-b' && text(entry.data, 'date') === h.today() && text(entry.data, 'mode') === 'Walk-in' && num(entry.data, 'token') > 0).map(entry => num(entry.data, 'token'));
    assert.equal(new Set(tokens).size, tokens.length);
    const request = await other.entity('help.create', { topic: 'App problem', detail: 'Synthetic request' }, undefined, 'help');
    assert.equal(request.createdBy, 'doctor-b');
    await admin.cmd('account.suspend', { reason: 'Leave with queued work', handovers: [{ group: 'unsignedNotes', receiverType: 'Department queue', receiverId: '' }], confirmed: true }, 'doctor-b');
    const queue = h.store.all('handover').find(entry => entry.status === 'Awaiting claim' && text(entry.data, 'group') === 'unsignedNotes')!;
    assert.ok(queue); assert.equal(queue.department, 'surgery');
    await (await h.client('super')).cmd('account.reactivate', { reason: 'Wrong-department claim counterexample' }, 'doctor-a'); await doctor.login();
    await doctor.cmd('handover.claim', { confirmed: true }, queue.id, 404);
    await (await h.client('super')).cmd('account.reactivate', { reason: 'Return to claim the department queue' }, 'doctor-b'); await other.login();
    await other.cmd('handover.claim', { confirmed: true }, queue.id);
    assert.equal(h.store.get(queue.id).status, 'Claimed'); assert.equal(h.store.get(draft.id).createdBy, 'resident');
  } finally { await h.close(); }
});

test('weekly rosters validate conflicts and inactive identities without duplicate cells', async () => {
  const h = await testHospital();
  try {
    const admin = await h.client('admin');
    await admin.cmd('roster.repeat', { departmentId: 'general', doctorId: 'doctor-a', month: '2026-12', weekdays: ['Monday'], shift: 'Night', replaceExisting: false, reason: 'Weekly pattern' });
    const entries = h.store.all('roster').filter(entry => entry.department === 'general' && text(entry.data, 'shift') === 'Night');
    assert.deepEqual(entries.map(entry => text(entry.data, 'date')).sort(), ['2026-12-07', '2026-12-14', '2026-12-21', '2026-12-28']);
    await admin.cmd('roster.repeat', { departmentId: 'general', doctorId: 'doctor-a', month: '2026-12', weekdays: ['Monday'], shift: 'Night', replaceExisting: false, reason: 'Repeat identical pattern' });
    assert.equal(h.store.all('roster').filter(entry => entry.department === 'general').length, 4);
    const invitation = await admin.cmd('account.create', { name: 'Demo alternate roster doctor', staffId: 'ROSTER-ALT', registration: 'SAMPLE-ROSTER-ALT', login: 'roster-alt', mobile: '9000066633', email: 'roster@sample.invalid', departmentId: 'general', role: 'doctor', qualification: 'Sample', room: 'Room 4' });
    const alternate = await h.activate(invitation);
    const replacement: Data = { departmentId: 'general', doctorId: alternate.actorId, month: '2026-12', weekdays: ['Monday'], shift: 'Night', reason: 'Reviewed replacement' };
    await admin.cmd('roster.repeat', { ...replacement, replaceExisting: false }, undefined, 422);
    assert.ok(h.store.all('roster').filter(entry => entry.department === 'general').every(entry => entry.doctorId === 'doctor-a'));
    await admin.cmd('roster.repeat', { ...replacement, replaceExisting: true });
    assert.equal(h.store.all('roster').filter(entry => entry.department === 'general').length, 4);
    assert.ok(h.store.all('roster').filter(entry => entry.department === 'general').every(entry => entry.doctorId === alternate.actorId && entry.data.doctorId === alternate.actorId));
    await admin.cmd('account.suspend', { reason: 'Synthetic leave', confirmed: true }, 'doctor-a');
    await admin.cmd('roster.repeat', { departmentId: 'general', doctorId: 'doctor-a', month: '2027-01', weekdays: ['Monday'], shift: 'Night', replaceExisting: false, reason: 'Must refuse inactive' }, undefined, 422);
  } finally { await h.close(); }
});

for (const changed of ['receiver', 'new group', 'unsent'] as const) test(`scheduled exit revalidates ${changed} at execution without removing access on failure`, async () => {
  const h = await testHospital();
  try {
    const admin = await h.client('admin'); const doctor = await h.client('doctor-a');
    const groups = changed === 'new group' ? handoverGroups.filter(group => group.key === 'followups') : handoverGroups;
    await admin.cmd('account.scheduleExit', { lastWorkingDay: h.date(), handovers: groups.map(group => ({ group: group.key, receiverType: 'Doctor', receiverId: 'doctor-b' })),
      confirmName: 'Demo doctor A', reason: 'Synthetic scheduled departure', unsentAction: 'Wait for sync', unsentPlan: 'Wait for all local work', confirmed: true }, 'doctor-a');
    if (changed === 'receiver') await admin.cmd('account.suspend', { reason: 'Receiver became unavailable', confirmed: true }, 'doctor-b');
    if (changed === 'new group') await doctor.cmd('rx.approve', { visitId: 'visit-a', lines: [medicineLine()], sendNow: true, reviewed: true });
    if (changed === 'unsent') await doctor.request('/api/sync/device', 'POST', { unsent: 1 });
    const cutoff = Date.parse(text(h.store.get('doctor-a').data, 'deactivationAt'));
    await (await h.client('super')).request('/api/demo/clock', 'POST', { minutes: Math.ceil((cutoff - Date.parse(h.store.now())) / 60000) + 1 });
    assert.equal(h.store.person('doctor-a').state, 'Active');
    assert.equal(h.store.get('doctor-a').data.scheduleBlocked, true);
    assert.ok(h.store.all('jobRun').some(entry => entry.status === 'Failure' && text(entry.data, 'accountId') === 'doctor-a'));
    assert.equal(h.store.get('visit-a').doctorId, 'doctor-a');
  } finally { await h.close(); }
});

test('emergency OT move is atomic, version guarded and notifies the displaced surgeon without bypassing pre-op checks', async () => {
  const h = await testHospital();
  try {
    const doctor = await h.client('doctor-a'); const ot = await h.client('ot'); const nurse = await h.client('nurse');
    const start = new Date(Date.parse(h.store.now()) + 7200000).toISOString(); const replacement = new Date(Date.parse(start) + 3600000).toISOString();
    const planned = await doctor.entity('operation.request', { patientId: 'patient-a', procedure: 'Planned sample operation', date: h.today(), duration: 60, urgency: 'Routine', anaesthesia: 'General', doctorId: 'doctor-a', consentExplained: true, fitness: true }, undefined, 'operation');
    await ot.cmd('operation.schedule', { theatre: 'OT 1', start, anaesthetist: 'Demo anaesthetist', scrubNurse: 'Demo nurse' }, planned.id);
    await doctor.cmd('operation.respond', { decision: 'Accept', reason: 'Planned slot accepted' }, planned.id);
    const emergency = await doctor.entity('operation.request', { patientId: 'patient-b', procedure: 'Emergency sample operation', date: h.today(), duration: 30, urgency: 'Emergency', anaesthesia: 'General', doctorId: 'doctor-a', consentExplained: true, fitness: false }, undefined, 'operation');
    const payload: Data = { theatre: 'OT 1', start, anaesthetist: 'Emergency anaesthetist', scrubNurse: 'Emergency nurse', plannedId: planned.id, rescheduledTheatre: 'OT 1', rescheduledStart: replacement, reason: 'Synthetic emergency priority' };
    const stale = ot.envelope('operation.emergencySchedule', payload, emergency.id);
    const consent = await nurse.entity('consent.sign', { patientId: 'patient-a', kind: 'Surgery', language: 'English', signer: 'Demo signer', witness: 'Demo witness', signedAt: h.store.now(), signed: true }, undefined, 'consent');
    await ot.cmd('operation.checklist', { consentId: consent.id, fasting: true, blood: true, fitness: true, authorisation: true }, planned.id);
    await ot.request('/api/commands/operation.emergencySchedule', 'POST', stale, 409);
    assert.equal(h.store.get(emergency.id).status, 'Requested'); assert.equal(text(h.store.get(planned.id).data, 'start'), start);
    await ot.cmd('operation.emergencySchedule', payload, emergency.id);
    assert.equal(text(h.store.get(planned.id).data, 'start'), replacement); assert.equal(h.store.get(planned.id).status, 'Offered'); assert.equal(h.store.get(planned.id).data.checklistComplete, false);
    const state = await doctor.request('/api/state'); assert.ok(state.notifications.some((entry: { id: string; text: string }) => entry.id === planned.id && entry.text.includes('Synthetic emergency priority')));
    await ot.cmd('operation.advance', { next: 'In theatre' }, emergency.id, 422);
  } finally { await h.close(); }
});

test('scheme master rate, insurer expiry/share, deposits, deduction owner and accounts export are distinct from a ledger', async () => {
  const h = await testHospital();
  try {
    const admission = await prepareAdmission(h, 'patient-b'); const cashier = await h.client('cashier'); const manager = await h.client('manager'); const doctor = await h.client('doctor-a'); const nurse = await h.client('nurse');
    const request: Data = { patientId: 'patient-b', admissionId: admission.id, payer: 'Ayushman', policy: 'SAMPLE-POLICY', amount: 10000, cover: 10000, packageId: 'scheme-ayushman-admission' };
    await cashier.cmd('claim.create', { ...request, amount: 9999 }, undefined, 422);
    const claim = await cashier.entity('claim.create', { ...request, cover: 0, eligibilityOutcome: 'Not eligible' }, undefined, 'claim');
    assert.equal(claim.status, 'Eligibility failed'); await cashier.cmd('claim.send', { documents: 'Blocked before eligibility' }, claim.id, 422);
    await cashier.cmd('claim.retryEligibility', { outcome: 'Eligible', cover: 10000, reason: 'Correct sample beneficiary proof' }, claim.id);
    await cashier.cmd('claim.send', { documents: 'Sample admission plan' }, claim.id);
    await cashier.cmd('claim.response', { decision: 'Approved', response: 'Partial simulated cover', approvedAmount: 6000, validUntil: h.date(7) }, claim.id);
    const extra = await cashier.entity('bill.service', { patientId: 'patient-b', tariffId: 'tariff-transport', quantity: 20, emergency: false }, undefined, 'bill'); assert.equal(num(extra.data, 'total'), 50000);
    const deposit = await cashier.entity('admission.advance', { amount: 1000 }, admission.id, 'bill');
    await cashier.cmd('bill.pay', { payments: [{ mode: 'Cash', amount: 1000 }], outcome: 'Success' }, deposit.id);
    const estimate = await cashier.request(`/api/admissions/${admission.id}/estimate`);
    assert.equal(estimate.packageQuote.rate, 1000000); assert.equal(estimate.gross, 1050000); assert.equal(estimate.insurerShare, 600000); assert.equal(estimate.patientDue, 350000);
    const discharge = await doctor.entity('discharge.draft', { admissionId: admission.id, diagnosis: 'Private synthetic diagnosis marker', course: 'Sample stay', procedures: 'Sample course', condition: 'Sample stable', lines: [medicineLine()], followup: 'Sample follow-up', reviewed: true }, undefined, 'discharge');
    await doctor.cmd('discharge.approve', { pin: '2468', pendingPlan: 'No unowned work', reviewed: true }, discharge.id);
    await nurse.cmd('discharge.clear', { returns: true, results: true, medicines: true, insurance: true, note: 'Checked' }, discharge.id);
    await cashier.cmd('discharge.bill', {}, discharge.id);
    const bill = h.store.get(text(h.store.get(admission.id).data, 'finalBillId')); assert.equal(num(bill.data, 'total'), 350000);
    assert.equal(rows(bill.data, 'lines').filter(line => text(line, 'name').startsWith('Scheme package:')).length, 1);
    await cashier.cmd('bill.pay', { payments: [{ mode: 'UPI', amount: 3500 }], outcome: 'Success' }, bill.id);
    await nurse.cmd('discharge.release', { confirmed: true }, admission.id);
    await cashier.cmd('claim.final', {}, claim.id); assert.equal(num(h.store.get(claim.id).data, 'claimedAmount'), 600000);
    await cashier.cmd('claim.settle', { settled: 5500, deductionOwner: 'Patient', reason: 'Simulated deduction' }, claim.id);
    const approval = h.store.all('approval').find(entry => text(entry.data, 'kind') === 'Claim deduction')!;
    await manager.cmd('approval.decide', { decision: 'Approve', reason: 'Independent ownership decision' }, approval.id);
    const adjustment = h.store.all('bill').find(entry => entry.data.postSettlement)!; assert.equal(num(adjustment.data, 'total'), 50000);
    const close = await cashier.entity('counter.close', { countedCash: 1000, denominations: { 500: 2 }, reason: '' }, undefined, 'counterClose');
    assert.equal(num(close.data, 'net'), 450000);
    await manager.request('/api/demo/fault', 'POST', { provider: 'Failure' }); await cashier.cmd('counter.sendAccounts', { confirmed: true }, close.id);
    assert.equal(h.store.get(close.id).status, 'Closed');
    await manager.request('/api/demo/fault', 'POST', { provider: 'Success' }); await cashier.cmd('counter.sendAccounts', { confirmed: true }, close.id);
    assert.equal(h.store.get(close.id).status, 'Accounts sent'); assert.equal(rows(h.store.get(close.id).data, 'accountsAttempts').length, 2);
    const claimsCsv = await cashier.request('/api/reports/claims?format=csv'); assert.match(claimsCsv, /settledPaise/); assert.match(claimsCsv, /550000/);
    const dayCsv = await cashier.request('/api/reports/day-end?format=csv'); assert.match(dayCsv, /450000/); assert.match(dayCsv, /ledgerMaintained/);
    const audit = await (await h.client('auditor')).request('/api/audit'); assert.ok(!JSON.stringify(audit).includes('Private synthetic diagnosis marker'));
  } finally { await h.close(); }
});

test('pharmacy discount tax and partial/full returns reconcile to original discounted money', async () => {
  const h = await testHospital();
  try {
    const doctor = await h.client('doctor-a'); const pharmacy = await h.client('pharmacy');
    const rx = await doctor.entity('rx.approve', { visitId: 'visit-a', lines: [medicineLine('medicine-a', 10)], sendNow: true, reviewed: true }, undefined, 'rx');
    const issue = await pharmacy.entity('pharmacy.dispense', { lineId: text(rows(rx.data, 'lines')[0], 'id'), batchId: 'batch-a', quantity: 10, nearExpiry: true }, rx.id, 'dispense');
    const billId = text(issue.data, 'billId');
    await pharmacy.cmd('bill.discount', { percent: 5, reason: 'Within pharmacy limit' }, billId);
    const bill = h.store.get(billId); const line = rows(bill.data, 'lines')[0]; assert.equal(num(bill.data, 'total'), 5320);
    assert.equal(num(line, 'taxable') + num(line, 'cgst') + num(line, 'sgst'), num(line, 'netTotal'));
    await pharmacy.cmd('bill.pay', { payments: [{ mode: 'UPI', amount: 53.2 }], outcome: 'Success' }, billId);
    await pharmacy.cmd('pharmacy.return', { quantity: 4, condition: 'Unopened', reason: 'Checked synthetic return' }, issue.id);
    const refund = h.store.all('refund')[0]; assert.equal(refund.status, 'Completed'); assert.equal(num(refund.data, 'amount'), 2128);
    assert.equal(rows(refund.data, 'refundModes')[0].mode, 'UPI');
    await pharmacy.cmd('pharmacy.return', { quantity: 6, condition: 'Unopened', reason: 'Remaining unopened units' }, issue.id);
    assert.equal(h.store.all('refund').reduce((total, entry) => total + num(entry.data, 'amount'), 0), 5320);
    assert.equal(num(h.store.get('batch-a').data, 'quantity'), 300);
  } finally { await h.close(); }
});

test('Hindi declaration coverage and actual tagged PDF preserve authored Unicode and English credentials', async () => {
  const h = await testHospital();
  try {
    const keys = [...new Set(commands.filter(command => command.roles.some(role => ['doctor', 'resident', 'patient'].includes(role))).flatMap(command => [command.label, ...command.fields.filter(field => !field.hidden).flatMap(field => [field.label, ...(field.options ?? [])])]))];
    assert.deepEqual(keys.filter(key => !Object.hasOwn(hi, key)), []);
    const doctor = await h.client('doctor-a'); await doctor.cmd('preferences.language', { language: 'Hindi', printLanguage: 'Hindi' });
    const authored = 'Normal — नमूना शिकायत। चिकित्सा सलाह नहीं।';
    const note = await doctor.entity('note.save', { ...notePayload, complaints: authored }, undefined, 'note');
    const document = await doctor.entity('document.generate', { patientId: 'patient-a', kind: 'OPD summary', sourceId: note.id, sections: ['complaints'], language: 'Hindi' }, undefined, 'document');
    assert.equal(document.data.language, 'Hindi'); assert.equal(h.store.get(note.id).data.complaints, authored);
    const response = await fetch(h.url + `/api/documents/${document.id}/file`, { headers: { Cookie: [...doctor.cookies].map(([key, value]) => `${key}=${value}`).join('; ') } });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition')!, /filename\*=UTF-8/);
    const loading = getDocument({ data: new Uint8Array(await response.arrayBuffer()), useSystemFonts: false });
    const pdf = await loading.promise;
    const actual: string[] = [];
    function walk(node: unknown) {
      if (!node || typeof node !== 'object') return;
      if ('alt' in node && typeof node.alt === 'string') actual.push(node.alt);
      if ('children' in node && Array.isArray(node.children)) for (const child of node.children) walk(child);
    }
    for (let page = 1; page <= pdf.numPages; page++) walk(await (await pdf.getPage(page)).getStructTree());
    assert.ok(actual.includes(`मुख्य शिकायतें: ${authored}`)); assert.ok(actual.some(line => line.includes('SAMPLE-REG-doctor-a'))); assert.ok(actual.some(line => line.includes('केवल नमूना')));
    await loading.destroy();
    const nurse = await h.client('nurse');
    const consent = await nurse.entity('consent.sign', { patientId: 'patient-a', kind: 'Surgery', language: 'Hindi', signer: 'नमूना हस्ताक्षरकर्ता', witness: 'नमूना गवाह', signedAt: h.store.now(), signed: true }, undefined, 'consent');
    const printed = await nurse.entity('document.generate', { patientId: 'patient-a', kind: 'Consent form', sourceId: consent.id }, undefined, 'document');
    assert.equal(printed.data.language, 'Hindi'); assert.ok(strings(printed.data, 'lines').some(line => line.includes('नमूना हस्ताक्षरकर्ता') && line.includes('नमूना गवाह')));
  } finally { await h.close(); }
});
