import { randomBytes, randomUUID } from 'node:crypto';
import { text, num, bool, rows, strings, istDate, type Actor, type Data } from '../shared/model.js';
import { credential } from './auth.js';
import { Context } from './context.js';
import { orderTests } from './clinical.js';
import { requireThat } from './store.js';

function freeBed(ctx: Context, id: string, patientId: string, category?: string) {
  const bed = ctx.get(id, 'bed');
  requireThat(bed.status === 'Free' || (bed.status === 'Reserved' && text(bed.data, 'patientId') === patientId && text(bed.data, 'reservedUntil') > ctx.now()), 'That bed is not clean and free, or it is reserved for another patient.');
  requireThat(!category || text(bed.data, 'category') === category, 'Choose a bed in the requested category.');
  return bed;
}
function testFlag(test: string, value: number, low: number, high: number) {
  if (test === 'potassium' && value > 6.5) return 'Critical';
  return value > high ? 'High' : value < low ? 'Low' : 'Normal';
}
export function careCommand(name: string, ctx: Context): boolean {
  const p = ctx.p;
  switch (name) {
    case 'patient.register': {
      requireThat(/^\d{10}$/.test(ctx.t('mobile')), 'Use a synthetic ten-digit mobile number.');
      requireThat(!ctx.t('aadhaarLast4') || /^\d{4}$/.test(ctx.t('aadhaarLast4')), 'Only four Aadhaar digits may be stored. Do not enter the full number.');
      const duplicates = ctx.all('patient').filter(e => e.status === 'Active' && (text(e.data, 'mobile') === ctx.t('mobile') || (text(e.data, 'name').toLowerCase() === ctx.t('name').toLowerCase() && num(e.data, 'age') === ctx.n('age'))));
      requireThat(!duplicates.length || ctx.t('duplicateReason').trim().length >= 5, `Possible existing patient: ${duplicates.map(e => text(e.data, 'uhid')).join(', ')}. Open the match or explain why this is a different person.`, 'DUPLICATE_PATIENT');
      requireThat(!ctx.b('mlc') || (ctx.t('policeStation') && ctx.t('broughtBy')), 'MLC registration needs police station and who brought the patient.');
      const name = ctx.b('unknown') ? `Unknown ${ctx.t('sex').toLowerCase()}, about ${ctx.n('age')} y` : ctx.t('name');
      const patient = ctx.create('patient', { ...p, name, uhid: `SMP-${String(ctx.all('patient').length + 1).padStart(6, '0')}`, allergyVersion: 0, arrivalAt: ctx.now() }, 'Active');
      const family = ctx.store.people().find(actor => actor.role === 'patient' && actor.mobile === ctx.t('mobile'));
      if (family) { family.patientIds.push(patient.id); ctx.store.savePerson(family); }
      else {
        const id = `family-${randomUUID()}`;
        const actor: Actor = { id, name: 'Synthetic patient family', role: 'patient', department: 'general', state: 'Active', login: id, staffId: id, mobile: ctx.t('mobile'), patientIds: [patient.id], verifier: false, profileConfirmed: true, temporary: false, counter: 'Online', appVersion: 1, preferences: {} };
        ctx.store.savePerson(actor, credential(randomBytes(32).toString('base64url')));
        ctx.create('account', { name: actor.name, role: 'patient' }, 'Active', { id });
      }
      ctx.result = { patientId: patient.id, uhid: text(patient.data, 'uhid'), possibleMatches: duplicates.map(e => e.id) }; break;
    }
    case 'patient.merge': {
      const patient = ctx.targetOf('patient'); const into = ctx.get(ctx.t('intoId'), 'patient');
      requireThat(patient.id !== into.id && bool(patient.data, 'unknown') && into.status === 'Active', 'Only an unknown patient can be merged into a different verified active record.');
      requireThat(!ctx.all('admission').some(e => e.patientId === patient.id && e.status === 'Admitted') || !ctx.all('admission').some(e => e.patientId === into.id && e.status === 'Admitted'), 'Both records have active admissions. Resolve the duplicate stay before merging.');
      for (const entity of ctx.store.all().filter(e => e.patientId === patient.id)) ctx.update({ ...entity, patientId: into.id }, { mergedFrom: patient.id });
      for (const actor of ctx.store.people().filter(actor => actor.role === 'patient' && actor.patientIds.includes(patient.id))) {
        actor.patientIds = actor.patientIds.filter(id => id !== patient.id); ctx.store.savePerson(actor);
      }
      ctx.update(patient, { mergedInto: into.id, mergeReason: ctx.t('reason') }, 'Merged');
      if (bool(patient.data, 'mlc')) ctx.update(into, { mlc: true, mlcMergedFrom: patient.id });
      break;
    }
    case 'patient.mlc':
      ctx.update(ctx.targetOf('patient'), { mlc: ctx.b('mlc'), mlcReason: ctx.t('reason') }); break;
    case 'visit.book': {
      const slot = ctx.book(ctx.t('patientId'), ctx.t('doctorId'), ctx.t('date'), ctx.t('time'), p);
      const visit = ctx.create('visit', { ...p, name: `${ctx.t('date')} ${ctx.t('time')}`, number: `OPD-${ctx.all('visit').length + 1}`, room: slot.room, extraBooking: slot.extraBooking, token: 0, calls: 0, source: ctx.actor.role === 'patient' ? 'Online' : 'Desk', moves: [] }, 'Booked', { patientId: ctx.t('patientId'), doctorId: ctx.t('doctorId'), department: slot.department });
      if (ctx.actor.role === 'patient') {
        const patient = ctx.get(visit.patientId!, 'patient');
        const tariff = ctx.tariff('consultation', text(patient.data, 'payer'));
        const bill = ctx.charge(patient.id, 'Online appointment consultation', num(tariff.data, 'rate'), visit.id, { visitId: visit.id, tariffId: tariff.id });
        ctx.result.billId = bill.id;
      }
      ctx.message(visit.patientId!, 'Appointment booked', visit.id); break;
    }
    case 'availability.decide': {
      const request = ctx.targetOf('availability');
      const affected = ctx.all('visit').filter(v => v.doctorId === request.doctorId && text(v.data, 'date') >= text(request.data, 'date') && text(v.data, 'date') <= text(request.data, 'endDate') && !['Cancelled', 'Done'].includes(v.status));
      const approved = ctx.t('decision') === 'Approve';
      ctx.update(request, { decisionReason: ctx.t('reason'), decidedAt: ctx.now(), affectedIds: affected.map(v => v.id), affectedCount: affected.length }, approved ? 'Approved' : 'Declined');
      if (approved) {
        if (text(request.data, 'kind') === 'Extra session') {
          requireThat(text(request.data, 'start') < text(request.data, 'end'), 'An extra session needs start and end times.');
          ctx.create('session', { ...request.data, name: `Extra session ${text(request.data, 'date')}`, room: text(ctx.get(request.doctorId!).data, 'room'), slotMinutes: 10 }, 'Published', { doctorId: request.doctorId, department: request.department });
        } else for (const visit of affected) ctx.update(visit, { needsMove: true, availabilityId: request.id });
      }
      break;
    }
    case 'followup.book': {
      const request = ctx.targetOf('followup');
      const slot = ctx.book(request.patientId!, ctx.t('doctorId'), ctx.t('date'), ctx.t('time'));
      const visit = ctx.create('visit', { ...p, name: `Follow-up ${ctx.t('date')} ${ctx.t('time')}`, number: `OPD-${ctx.all('visit').length + 1}`, room: slot.room, token: 0, calls: 0, mode: 'Walk-in', opdType: 'General', visitType: 'Follow-up', followupId: request.id, moves: [] }, 'Booked', { patientId: request.patientId, doctorId: ctx.t('doctorId'), department: slot.department });
      ctx.update(request, { bookedVisitId: visit.id, bookedBy: ctx.actor.id, bookedAt: ctx.now() }, 'Booked'); ctx.message(visit.patientId!, 'Follow-up booked', visit.id); break;
    }
    case 'followup.decline':
      ctx.update(ctx.targetOf('followup'), { reason: ctx.t('reason') }, 'Declined'); break;
    case 'visit.checkin': {
      const visit = ctx.targetOf('visit');
      requireThat(text(visit.data, 'date') === istDate(ctx.now()), 'Check-in is available only on the appointment date.');
      requireThat(!bool(visit.data, 'needsMove'), 'This visit needs a new slot because availability changed.');
      requireThat(!ctx.b('priority') || ctx.t('priorityReason'), 'Priority arrivals need a visible reason.');
      const patient = ctx.get(visit.patientId!, 'patient');
      if (ctx.t('clearance') === 'Free follow-up') {
        requireThat(ctx.all('visit').some(e => e.patientId === visit.patientId && e.doctorId === visit.doctorId && e.status === 'Done' && new Date(ctx.now()).getTime() - new Date(text(e.data, 'firstDoneAt')).getTime() <= 7 * 86400000), 'No completed visit in the last seven days qualifies for this free follow-up.');
      }
      if (ctx.t('clearance') === 'Covered') requireThat(text(patient.data, 'payer') !== 'Self', 'A self-pay patient needs a billing fee or an eligible free follow-up.');
      const token = Math.max(0, ...ctx.all('visit').filter(e => e.doctorId === visit.doctorId && text(e.data, 'date') === text(visit.data, 'date')).map(e => num(e.data, 'token'))) + 1;
      ctx.update(visit, { ...p, token, checkinAt: ctx.now(), counter: ctx.actor.counter }, 'Waiting');
      const tariff = ctx.tariff('consultation', text(patient.data, 'payer'));
      ctx.charge(patient.id, 'Consultation', ctx.t('clearance') === 'Collect at billing' ? num(tariff.data, 'rate') : 0, visit.id, { visitId: visit.id, mlc: bool(patient.data, 'mlc'), tariffId: tariff.id });
      break;
    }
    case 'board.save':
      ctx.create('board', p, 'Active'); break;
    case 'board.toggle':
      ctx.update(ctx.targetOf('board'), { enabled: ctx.b('enabled') }); break;
    case 'sample.collect': {
      const order = ctx.targetOf('order');
      const active = ctx.all('sample').some(e => text(e.data, 'orderId') === order.id && e.status !== 'Rejected');
      requireThat(!active, 'This order already has an active sample. Use the existing barcode.');
      const sample = ctx.create('sample', { name: `${text(order.data, 'name')} sample`, orderId: order.id, testId: text(order.data, 'testId'), container: ctx.t('container'), fasting: ctx.t('fasting'), barcode: `SMP-${randomUUID().slice(0, 12).toUpperCase()}`, collectedAt: ctx.now() }, 'Collected', { patientId: order.patientId, doctorId: order.doctorId });
      ctx.update(order, { sampleId: sample.id, collectedAt: ctx.now(), receivedBy: ctx.actor.id }, 'Collected'); break;
    }
    case 'sample.defer':
      ctx.update(ctx.targetOf('order'), { holdReason: ctx.t('reason') }, 'Collection held'); break;
    case 'sample.resume':
      ctx.update(ctx.targetOf('order'), { resumeReason: ctx.t('reason') }, 'Cleared'); break;
    case 'sample.accept': {
      const sample = ctx.targetOf('sample');
      requireThat(ctx.t('barcode') === text(sample.data, 'barcode'), 'The barcode does not match this sample. Check patient and container.');
      ctx.update(sample, { acceptedAt: ctx.now(), acceptedBy: ctx.actor.id }, 'Accepted');
      ctx.update(ctx.get(text(sample.data, 'orderId'), 'order'), { acceptedAt: ctx.now() }, 'Accepted'); break;
    }
    case 'sample.reject': {
      const sample = ctx.targetOf('sample');
      ctx.update(sample, { reason: ctx.t('reason'), rejectedAt: ctx.now() }, 'Rejected');
      ctx.update(ctx.get(text(sample.data, 'orderId'), 'order'), { rejectionReason: ctx.t('reason') }, 'Recollection needed'); break;
    }
    case 'sample.dispatch': {
      const sample = ctx.targetOf('sample');
      ctx.update(sample, { ...p, dispatchedAt: ctx.now(), manifest: `DISPATCH-${ctx.all('sample').filter(e => e.status === 'Dispatched').length + 1}` }, 'Dispatched'); break;
    }
    case 'lab.question': {
      const order = ctx.targetOf('order');
      ctx.create('question', { ...p, kind: 'Lab', name: 'Lab question', sourceId: order.id }, 'Open', { patientId: order.patientId, doctorId: order.doctorId }); break;
    }
    case 'result.enter': {
      const sample = ctx.targetOf('sample');
      requireThat(!ctx.all('result').some(e => text(e.data, 'sampleId') === sample.id), 'A report already exists for this sample. Use the correction flow.');
      requireThat(ctx.n('low') <= ctx.n('high'), 'Reference low must not exceed reference high.');
      const order = ctx.get(text(sample.data, 'orderId'), 'order');
      if (text(order.data, 'testId') === 'xray') requireThat(ctx.t('narrative'), 'Enter the radiology narrative.');
      else requireThat(typeof p.value === 'number' && typeof p.low === 'number' && typeof p.high === 'number' && ctx.t('unit'), 'Laboratory results need a value, unit and reference range.');
      requireThat(text(order.data, 'testId') !== 'potassium' || ctx.t('unit') === 'mmol/L', 'Use mmol/L for the synthetic potassium test.');
      ctx.create('result', { ...p, name: text(order.data, 'name'), sampleId: sample.id, orderId: order.id, testId: text(order.data, 'testId'), sampleAt: text(sample.data, 'collectedAt'), enteredBy: ctx.actor.id, reportVersion: 1, flag: testFlag(text(order.data, 'testId'), ctx.n('value'), ctx.n('low'), ctx.n('high')) }, 'Entered', { patientId: sample.patientId, doctorId: sample.doctorId, department: ctx.store.person(sample.doctorId!).department }); break;
    }
    case 'result.verify': {
      const result = ctx.targetOf('result');
      requireThat(ctx.actor.verifier, 'Your account does not have lab verifier rights.');
      requireThat(text(result.data, 'enteredBy') !== ctx.actor.id, 'A different authorized person must verify this entry.');
      ctx.update(result, { verifiedBy: ctx.actor.id, verifiedAt: ctx.now() }, 'Verified'); break;
    }
    case 'result.release': {
      const result = ctx.targetOf('result');
      requireThat(ctx.actor.verifier && text(result.data, 'enteredBy') !== ctx.actor.id, 'Only a different authorized verifier may release this report.');
      ctx.update(result, { releasedBy: ctx.actor.id, releasedAt: ctx.now(), publicText: 'A new report needs review. Unlock to view.' }, 'Released');
      ctx.update(ctx.get(text(result.data, 'orderId'), 'order'), { resultId: result.id, releasedAt: ctx.now() }, 'Released');
      ctx.message(result.patientId!, 'Report ready - your doctor has been told', `${result.id}-v${num(result.data, 'reportVersion')}`, 'WhatsApp', 'reports'); break;
    }
    case 'result.amend': {
      const result = ctx.targetOf('result');
      requireThat(!ctx.all('result').some(e => text(e.data, 'previousId') === result.id), 'A correction of this version already exists. Open the latest version.');
      ctx.create('result', { ...result.data, value: ctx.n('value'), narrative: ctx.t('narrative'), amendmentReason: ctx.t('reason'), previousId: result.id,
        name: `${text(result.data, 'name')} (Amended)`, reportVersion: num(result.data, 'reportVersion', 1) + 1, enteredBy: ctx.actor.id,
        verifiedBy: '', verifiedAt: '', releasedBy: '', releasedAt: '', callDue: false,
        flag: testFlag(text(result.data, 'testId'), ctx.n('value'), num(result.data, 'low'), num(result.data, 'high')) }, 'Entered', { patientId: result.patientId, doctorId: result.doctorId, department: result.department }); break;
    }
    case 'result.call': {
      const result = ctx.targetOf('result');
      requireThat(text(result.data, 'flag') === 'Critical', 'Record a critical call only for a critical report.');
      ctx.update(result, { calls: [...rows(result.data, 'calls'), { ...p, at: ctx.now(), actor: ctx.actor.id }] }); break;
    }
    case 'admission.emergency': {
      const patient = ctx.patient(); const doctor = ctx.store.person(ctx.t('doctorId'));
      requireThat(doctor.role === 'doctor' && doctor.state === 'Active', 'Name an active consultant of record.');
      requireThat(!ctx.all('admission').some(e => e.patientId === patient.id && ['Requested', 'Admitted'].includes(e.status)), 'An admission request or stay already exists.');
      ctx.create('admission', { ...p, name: `Emergency ${text(patient.data, 'uhid')}`, emergency: true, requestedAt: ctx.now(), advanceDue: true }, 'Requested', { patientId: patient.id, doctorId: doctor.id, department: doctor.department }); break;
    }
    case 'bed.reserve': {
      const bed = ctx.targetOf('bed'); ctx.patient();
      ctx.update(bed, { patientId: ctx.t('patientId'), reservedUntil: new Date(new Date(ctx.now()).getTime() + 7200000).toISOString() }, 'Reserved'); break;
    }
    case 'admission.admit': {
      const admission = ctx.targetOf('admission'); const bed = freeBed(ctx, ctx.t('bedId'), admission.patientId!, text(admission.data, 'category'));
      const recordedAdvance = ctx.all('payment').filter(e => e.patientId === admission.patientId && e.status === 'Paid' && text(e.data, 'admissionId') === admission.id && bool(e.data, 'isAdvance')).reduce((sum, e) => sum + num(e.data, 'total'), 0);
      requireThat(Math.round(ctx.n('advance') * 100) <= recordedAdvance, 'This advance has no recorded payment. Set zero or record it through billing.');
      ctx.update(admission, { ...p, number: `IPD-${ctx.all('admission').filter(e => ['Admitted', 'Discharged'].includes(e.status)).length + 1}`, bedId: bed.id, admittedAt: ctx.now(), bedHistory: [{ bedId: bed.id, name: text(bed.data, 'name'), from: ctx.now(), to: '', rate: num(bed.data, 'dailyRate') }], advanceDue: ctx.n('advance') === 0, mlc: bool(ctx.get(admission.patientId!).data, 'mlc') }, 'Admitted');
      ctx.update(bed, { admissionId: admission.id, patientId: admission.patientId!, occupiedAt: ctx.now() }, 'Occupied'); break;
    }
    case 'admission.advance': {
      const admission = ctx.targetOf('admission'); requireThat(ctx.n('amount') > 0, 'Enter a positive advance amount.');
      const bill = ctx.charge(admission.patientId!, 'Admission advance deposit', Math.round(ctx.n('amount') * 100), `${admission.id}-advance-${ctx.request.operationId}`, {}, admission.id);
      ctx.update(bill, { isAdvance: true }); break;
    }
    case 'bed.transfer': {
      const admission = ctx.targetOf('admission'); const bed = freeBed(ctx, ctx.t('bedId'), admission.patientId!);
      requireThat(bed.id !== text(admission.data, 'bedId'), 'Choose a different bed.');
      if (text(bed.data, 'category') === 'ICU') requireThat(ctx.all('wardOrder').some(e => e.status === 'Active' && text(e.data, 'admissionId') === admission.id && text(e.data, 'kind') === 'ICU transfer'), 'A signed doctor ICU-transfer order is required.');
      const old = ctx.get(text(admission.data, 'bedId'), 'bed'); const history = rows(admission.data, 'bedHistory');
      if (history.length) history[history.length - 1].to = ctx.now();
      history.push({ bedId: bed.id, name: text(bed.data, 'name'), from: ctx.now(), to: '', rate: num(bed.data, 'dailyRate'), reason: ctx.t('reason') });
      ctx.update(old, { previousAdmissionId: admission.id, admissionId: '', patientId: '' }, 'Cleaning');
      ctx.update(bed, { admissionId: admission.id, patientId: admission.patientId!, occupiedAt: ctx.now() }, 'Occupied');
      ctx.update(admission, { bedId: bed.id, bedHistory: history }); break;
    }
    case 'bed.clean':
      ctx.update(ctx.targetOf('bed'), { cleanedAt: ctx.now(), cleanedBy: ctx.actor.id, cleaningNote: ctx.t('note') }, 'Free'); break;
    case 'nursing.note': {
      const admission = ctx.admission(); ctx.create('nursing', { ...p, name: 'Nursing handover' }, 'Recorded', { patientId: admission.patientId, doctorId: admission.doctorId }); break;
    }
    case 'dose.record': {
      const order = ctx.targetOf('wardOrder');
      requireThat(text(order.data, 'kind') === 'Medicine' && ctx.get(text(order.data, 'admissionId'), 'admission').status === 'Admitted', 'Choose an active medicine order for an admitted patient.');
      requireThat(!ctx.all('administration').some(e => text(e.data, 'orderId') === order.id && text(e.data, 'scheduled') === ctx.t('scheduled')), 'This scheduled dose is already charted. Its entry cannot be duplicated.');
      const late = new Date(ctx.now()).getTime() - new Date(ctx.t('scheduled')).getTime() > 3600000;
      requireThat((ctx.t('outcome') === 'Given' && !late) || ctx.t('reason'), 'A late, held or missed dose needs a reason.');
      ctx.create('administration', { ...p, name: text(order.data, 'instruction'), orderId: order.id, admissionId: text(order.data, 'admissionId'), recordedAt: ctx.now() }, ctx.t('outcome'), { patientId: order.patientId, doctorId: order.doctorId }); break;
    }
    case 'discharge.clear':
      ctx.update(ctx.targetOf('discharge'), { nursingClearance: p, nursingClearedBy: ctx.actor.id, nursingClearedAt: ctx.now() }, 'Nursing cleared'); break;
    case 'discharge.bill': {
      const discharge = ctx.targetOf('discharge'); const admission = ctx.get(text(discharge.data, 'admissionId'), 'admission');
      requireThat(admission.status === 'Admitted' && !text(admission.data, 'finalBillId'), 'This stay is already discharged or has a final bill.');
      const bills = ctx.all('bill').filter(e => text(e.data, 'admissionId') === admission.id && !['Cancelled', 'Consolidated'].includes(e.status));
      const lines: Data[] = bills.filter(e => !bool(e.data, 'isAdvance') && num(e.data, 'total') > num(e.data, 'paid')).map(e => ({ id: randomUUID(), name: text(e.data, 'name'), total: num(e.data, 'total') - num(e.data, 'paid'), componentBillId: e.id, quantity: 1 }));
      for (const interval of rows(admission.data, 'bedHistory')) {
        const to = text(interval, 'to') || ctx.now();
        const hours = Math.max(1, Math.ceil((new Date(to).getTime() - new Date(text(interval, 'from')).getTime()) / 3600000));
        lines.push({ id: randomUUID(), name: `Bed: ${text(interval, 'name')}`, from: text(interval, 'from'), to, quantity: hours, unit: 'hours', dailyRate: num(interval, 'rate'), total: Math.round(hours * num(interval, 'rate') / 24) });
      }
      const gross = lines.reduce((sum, line) => sum + num(line, 'total'), 0);
      const claims = ctx.all('claim').filter(e => text(e.data, 'admissionId') === admission.id && e.status === 'Approved' && text(e.data, 'validUntil') >= istDate(ctx.now()));
      const insurerShare = Math.min(gross, claims.reduce((sum, claim) => sum + num(claim.data, 'approvedAmount'), 0));
      const advances = bills.filter(e => bool(e.data, 'isAdvance')).reduce((sum, e) => sum + num(e.data, 'paid') - num(e.data, 'refunded'), 0);
      const appliedAdvance = Math.min(gross - insurerShare, advances);
      if (insurerShare) lines.push({ id: randomUUID(), name: 'Approved insurer share', quantity: 1, total: -insurerShare, claimIds: claims.map(e => e.id) });
      if (appliedAdvance) lines.push({ id: randomUUID(), name: 'Recorded advance adjusted', quantity: 1, total: -appliedAdvance });
      const final = ctx.bill(admission.patientId!, 'Final hospital bill', lines, `${admission.id}-final`, admission.id);
      ctx.update(final, { final: true, componentIds: bills.filter(e => !bool(e.data, 'isAdvance') && e.status !== 'Paid').map(e => e.id), recordedAdvances: advances, appliedAdvance, advanceRefundDue: advances - appliedAdvance, insurerShare, schemeCovered: insurerShare > 0 });
      for (const bill of bills.filter(e => !bool(e.data, 'isAdvance') && e.status !== 'Paid')) ctx.update(bill, { consolidatedInto: final.id }, 'Consolidated');
      ctx.update(admission, { finalBillId: final.id });
      ctx.update(discharge, { billingHandoff: 'Final bill prepared', finalBillId: final.id }); break;
    }
    case 'discharge.credit':
      ctx.approval('Discharge credit', ctx.targetOf('admission').id, {}, ctx.t('reason')); break;
    case 'discharge.release': {
      const admission = ctx.targetOf('admission');
      const summary = ctx.all('discharge').filter(e => text(e.data, 'admissionId') === admission.id).sort((a, b) => num(b.data, 'summaryVersion') - num(a.data, 'summaryVersion'))[0];
      requireThat(summary && summary.status === 'Nursing cleared' && text(summary.data, 'approvedBy'), 'The latest discharge version needs consultant approval and nursing clearance.');
      requireThat(text(admission.data, 'finalBillId'), 'Billing must prepare the final bill first.');
      const bill = ctx.get(text(admission.data, 'finalBillId'), 'bill');
      requireThat(bill.status === 'Paid' || bool(admission.data, 'creditApproved'), 'Settle the final bill or obtain independent credit approval before printing the gate pass.');
      const bed = ctx.get(text(admission.data, 'bedId'), 'bed');
      ctx.update(bed, { admissionId: '', patientId: '', previousAdmissionId: admission.id }, 'Cleaning');
      ctx.update(admission, { dischargedAt: ctx.now(), gatePass: `GATE-${ctx.all('admission').filter(e => e.status === 'Discharged').length + 1}`, summaryId: summary.id }, 'Discharged');
      ctx.create('coding', { name: `Discharged ${text(admission.data, 'number')}`, sourceId: admission.id, doctorText: text(summary.data, 'diagnosis'), mlc: bool(ctx.get(admission.patientId!).data, 'mlc') }, 'Requested', { patientId: admission.patientId, doctorId: admission.doctorId, department: admission.department }); break;
    }
    case 'operation.schedule': {
      const operation = ctx.targetOf('operation');
      const start = new Date(ctx.t('start')).getTime(); const end = start + num(operation.data, 'duration') * 60000;
      requireThat(Number.isFinite(start), 'Enter a valid start time.');
      requireThat(!ctx.all('operation').some(e => e.id !== operation.id && ['Offered', 'Scheduled', 'In theatre', 'Recovery'].includes(e.status) &&
        (text(e.data, 'theatre') === ctx.t('theatre') || text(e.data, 'surgeonId') === text(operation.data, 'surgeonId')) &&
        new Date(text(e.data, 'start')).getTime() < end && new Date(text(e.data, 'end')).getTime() > start), 'The theatre or surgeon is already booked for this interval.');
      if (ctx.t('assetId')) requireThat(ctx.get(ctx.t('assetId'), 'asset').status === 'Available', 'This equipment is under maintenance.');
      ctx.update(operation, { ...p, end: new Date(end).toISOString() }, 'Offered'); break;
    }
    case 'operation.checklist': {
      const operation = ctx.targetOf('operation'); const consent = ctx.get(ctx.t('consentId'), 'consent');
      requireThat(consent.status === 'Signed' && consent.patientId === operation.patientId && ['Surgery', 'High risk'].includes(text(consent.data, 'kind')), 'Choose a signed surgical consent for this patient.');
      ctx.update(operation, { checklist: p, checklistComplete: true, fitness: true }); break;
    }
    case 'operation.advance': {
      const operation = ctx.targetOf('operation');
      const transitions: Record<string, string> = { Scheduled: 'In theatre', 'In theatre': 'Recovery', Recovery: 'Shifted to ward' };
      requireThat(transitions[operation.status] === ctx.t('next'), 'Follow the theatre stage order.');
      requireThat(bool(operation.data, 'checklistComplete'), 'Complete consent, fasting, blood, fitness and payer checks before entering theatre.');
      ctx.update(operation, { stages: [...rows(operation.data, 'stages'), { status: ctx.t('next'), at: ctx.now(), actor: ctx.actor.id }] }, ctx.t('next'));
      if (ctx.t('next') === 'In theatre') ctx.charge(operation.patientId!, `Procedure: ${text(operation.data, 'procedure')}`, num(ctx.tariff('operation').data, 'rate'), operation.id, {}, text(operation.data, 'admissionId'));
      break;
    }
    case 'daycare.start': {
      const patient = ctx.patient(); const bed = freeBed(ctx, ctx.t('bedId'), patient.id, 'Day care');
      const consultant = ctx.store.person(ctx.t('doctorId')); requireThat(consultant.role === 'doctor' && consultant.state === 'Active', 'Select an active consultant.');
      const pkg = ctx.get(ctx.t('packageId'), 'package');
      const admission = ctx.create('admission', { name: 'Day-care encounter', number: `DAY-${ctx.all('daycare').length + 1}`, category: 'Day care', bedId: bed.id, admittedAt: ctx.now(), bedHistory: [], isDaycare: true }, 'Admitted', { patientId: patient.id, doctorId: consultant.id, department: consultant.department });
      const day = ctx.create('daycare', { ...p, name: `Day care ${text(patient.data, 'uhid')}`, admissionId: admission.id, startedAt: ctx.now(), packagePrice: num(pkg.data, 'price') }, 'Active', { patientId: patient.id, doctorId: consultant.id });
      ctx.update(bed, { patientId: patient.id, admissionId: admission.id }, 'Occupied');
      ctx.charge(patient.id, `Day-care package ${text(pkg.data, 'name')}`, num(pkg.data, 'price'), day.id, {}, admission.id); break;
    }
    case 'daycare.finish': {
      const day = ctx.targetOf('daycare'); const admission = ctx.get(text(day.data, 'admissionId'), 'admission');
      const old = ctx.get(text(admission.data, 'bedId'), 'bed');
      if (ctx.t('decision') === 'Convert to IPD') {
        const bed = freeBed(ctx, ctx.t('bedId'), day.patientId!); requireThat(text(bed.data, 'category') !== 'Day care', 'Choose an IPD bed for conversion.');
        ctx.update(admission, { isDaycare: false, number: `IPD-CONVERT-${ctx.all('admission').length}`, bedId: bed.id, category: text(bed.data, 'category'), convertedFrom: day.id, bedHistory: [{ bedId: bed.id, name: text(bed.data, 'name'), from: ctx.now(), to: '', rate: num(bed.data, 'dailyRate') }] });
        ctx.update(bed, { patientId: day.patientId!, admissionId: admission.id }, 'Occupied');
        ctx.update(day, { reason: ctx.t('reason'), finishedAt: ctx.now() }, 'Converted to IPD');
      } else {
        ctx.update(admission, { dischargedAt: ctx.now() }, 'Discharged');
        ctx.update(day, { reason: ctx.t('reason'), finishedAt: ctx.now() }, 'Completed');
      }
      ctx.update(old, { admissionId: '', patientId: '' }, 'Cleaning'); break;
    }
    case 'register.record': {
      const patient = ctx.patient();
      if (ctx.t('kind') === 'Immunisation') requireThat(ctx.t('batch') && ctx.t('expiry') >= istDate(ctx.now()) && ctx.t('nextDue') > istDate(ctx.now()), 'Vaccine entry needs an unexpired batch and a future next-due date.');
      ctx.create('register', { ...p, name: `${ctx.t('kind')}: ${ctx.t('detail')}` }, 'Recorded', { patientId: patient.id }); break;
    }
    case 'consent.sign': {
      const patient = ctx.patient(); requireThat(ctx.t('signer') !== ctx.t('witness'), 'The witness must be different from the signer.');
      requireThat(new Date(ctx.t('signedAt')).getTime() <= new Date(ctx.now()).getTime() + 60000, 'Consent cannot be signed in the future.');
      ctx.create('consent', { ...p, name: `${ctx.t('kind')} consent`, simulated: true }, 'Signed', { patientId: patient.id }); break;
    }
    case 'package.sell': {
      const patient = ctx.patient(); const pkg = ctx.get(ctx.t('packageId'), 'package');
      requireThat(pkg.status === 'Active', 'Choose an active package.');
      const pack = ctx.create('packageRun', { name: text(pkg.data, 'name'), packageId: pkg.id, price: num(pkg.data, 'price'), summary: '' }, 'In progress', { patientId: patient.id, doctorId: ctx.t('doctorId') });
      const orders = orderTests(ctx, undefined, patient.id, ctx.t('doctorId'), strings(pkg.data, 'tests'), { priority: 'Routine', history: 'Synthetic health package' }, pack.id);
      const bill = ctx.charge(patient.id, text(pkg.data, 'name'), num(pkg.data, 'price'), pack.id, { packageId: pkg.id });
      for (const order of orders) ctx.update(order, { billId: bill.id });
      ctx.update(pack, { orderIds: orders.map(e => e.id), billId: bill.id }); break;
    }
    case 'package.skip': {
      const pack = ctx.targetOf('packageRun'); const order = ctx.get(ctx.t('orderId'), 'order');
      requireThat(text(order.data, 'packageId') === pack.id && !['Released', 'Skipped'].includes(order.status), 'Choose an unfinished item belonging to this package.');
      ctx.update(order, { skipReason: ctx.t('reason') }, 'Skipped'); break;
    }
    case 'package.release': {
      const pack = ctx.targetOf('packageRun');
      requireThat(strings(pack.data, 'orderIds').every(id => ['Released', 'Skipped'].includes(ctx.get(id, 'order').status)), 'The report pack is waiting for unfinished tests. Release them or skip with a reason.');
      ctx.update(pack, { summary: ctx.t('summary'), releasedAt: ctx.now() }, 'Released');
      ctx.message(pack.patientId!, 'Health report pack ready', pack.id, 'WhatsApp', 'reports'); break;
    }
    default: return false;
  }
  return true;
}
