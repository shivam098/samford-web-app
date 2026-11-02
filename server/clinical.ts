import { randomInt, randomUUID } from 'node:crypto';
import { text, num, bool, rows, strings, istDate, doctorRoles, type Data, type Entity } from '../shared/model.js';
import { hash } from './auth.js';
import { Context } from './context.js';
import { requireThat } from './store.js';
import { documentCommand } from './documents.js';
import { journeys } from '../shared/journeys.js';
import { claimHandover } from './handover.js';
import { homePolicy, validateHomeLayout } from './home.js';
import { layoutFromPreferences } from '../shared/home.js';
import { printLanguage } from '../shared/i18n.js';

export function checkedMedicines(ctx: Context, patientId: string, lines: Data[], warningReason = ''): Data[] {
  requireThat(lines.length > 0 && lines.length <= 30, 'Add at least one medicine and review every line.');
  const activeAllergies = ctx.all('allergy').filter(e => e.patientId === patientId && e.status === 'Active');
  const seen = new Set<string>();
  return lines.map(line => {
    const item = ctx.get(text(line, 'itemId'), 'item');
    requireThat(item.status === 'Active', `${text(item.data, 'name')} is no longer available. Remove it before approving.`);
    requireThat(bool(line, 'reviewed'), 'Review each copied or new medicine line before approving.');
    requireThat(text(line, 'dose') && text(line, 'frequency') && text(line, 'route'), 'Each medicine needs dose, frequency and route.');
    requireThat(Number.isInteger(num(line, 'days')) && num(line, 'days') > 0 && num(line, 'days') <= 365, 'Medicine duration must be 1-365 days.');
    requireThat(Number.isInteger(num(line, 'quantity')) && num(line, 'quantity') > 0, 'Enter a positive whole quantity for every medicine.');
    const warning = activeAllergies.some(a => text(a.data, 'substance').toLowerCase() === text(item.data, 'salt').toLowerCase()) || seen.has(item.id);
    requireThat(!warning || warningReason.trim().length >= 5, `${text(item.data, 'name')} has an allergy or duplicate warning. Remove it or record a reviewed reason.`);
    seen.add(item.id);
    const start = text(line, 'start') || istDate(ctx.now());
    const end = istDate(new Date(new Date(`${start}T00:00:00+05:30`).getTime() + (num(line, 'days') - 1) * 86400000).toISOString());
    if (text(line, 'frequency').startsWith('Taper')) requireThat(text(line, 'remark'), 'A tapering schedule needs explicit reviewed instructions.');
    return { id: text(line, 'id') || randomUUID(), itemId: item.id, name: text(item.data, 'name'), salt: text(item.data, 'salt'), strength: text(item.data, 'strength'),
      dose: text(line, 'dose'), frequency: text(line, 'frequency'), route: text(line, 'route'), days: num(line, 'days'), quantity: num(line, 'quantity'),
      food: text(line, 'food'), remark: text(line, 'remark'), reviewed: true, start, end, dispensed: 0 };
  });
}
export function orderTests(ctx: Context, visit: Entity | undefined, patientId: string, doctorId: string, testIds: string[], extra: Data = {}, packageId = ''): Entity[] {
  requireThat(testIds.length > 0 && testIds.length <= 30, 'Choose at least one catalog test.');
  requireThat(new Set(testIds).size === testIds.length, 'Remove duplicate tests from this order.');
  const patient = ctx.get(patientId, 'patient');
  const admission = ctx.all('admission').find(e => e.patientId === patientId && e.status === 'Admitted');
  const covered = text(patient.data, 'payer') !== 'Self' || Boolean(admission);
  return testIds.map(id => {
    const test = ctx.get(id, 'test');
    requireThat(test.status === 'Active', `${text(test.data, 'name')} is retired. Remove it from the selected set.`);
    const tariff = ctx.tariff(id, text(patient.data, 'payer'));
    const order = ctx.create('order', { name: text(test.data, 'name'), testId: id, loinc: text(test.data, 'loinc'), container: text(test.data, 'container'), fasting: text(test.data, 'fasting'), visitId: visit?.id ?? '', admissionId: admission?.id ?? '', packageId, amount: num(tariff.data, 'rate'), ...extra }, covered ? 'Cleared' : 'Payment pending', { patientId, doctorId, department: ctx.store.person(doctorId).department });
    if (!packageId) {
      const bill = ctx.charge(patientId, text(test.data, 'name'), num(tariff.data, 'rate'), order.id, { orderId: order.id, tariffId: tariff.id }, admission?.id);
      ctx.update(order, { billId: bill.id });
    }
    return ctx.get(order.id);
  });
}
export function clinicalCommand(name: string, ctx: Context): boolean {
  const p = ctx.p;
  switch (name) {
    case 'handover.claim':
      claimHandover(ctx); break;
    case 'profile.correction':
      ctx.create('correction', { name: 'Profile correction', reason: ctx.t('reason') }, 'Requested', { doctorId: ctx.actor.id, department: ctx.actor.department }); break;
    case 'preferences.save': {
      const order = ctx.t('homeOrder').split(',').map(x => x.trim());
      const hidden = ctx.t('hiddenCards').split(',').map(x => x.trim());
      requireThat(order.includes('referrals') && order.includes('results') && new Set(order).size === order.length, 'Home must include referrals and results, with no repeated cards.');
      requireThat(order.every(key => ['visits', 'referrals', 'results', 'admissions', 'pending'].includes(key)), 'Home card IDs are visits, referrals, results, admissions and pending.');
      requireThat(!hidden.includes('referrals') && !hidden.includes('results'), 'New referrals and Results to review cannot be hidden.');
      requireThat(ctx.t('shortcuts').split(',').filter(Boolean).length <= 6, 'Pin no more than six shortcuts.');
      requireThat(ctx.t('shortcuts').split(',').map(id => id.trim()).filter(Boolean).every(id => journeys.some(journey => journey.id === id && journey.roles.includes(ctx.actor.role))), 'Choose shortcut journey IDs available to your role.');
      const policy = homePolicy(ctx.store, ctx.actor.department);
      const layout = p.layout && typeof p.layout === 'object' && !Array.isArray(p.layout) ? p.layout : layoutFromPreferences(p);
      const normalized = validateHomeLayout(layout, strings(policy, 'lockedCards'));
      const preferences = { ...p }; delete preferences.layout;
      ctx.actor.preferences = { ...ctx.actor.preferences, ...preferences, ...normalized };
      ctx.store.savePerson(ctx.actor); ctx.result = { saved: true }; break;
    }
    case 'preferences.resetHome': {
      const policy = homePolicy(ctx.store, ctx.actor.department); const layout = policy.layout;
      requireThat(layout && typeof layout === 'object' && !Array.isArray(layout), 'Hospital defaults are unavailable. Contact administration.');
      ctx.actor.preferences = { ...ctx.actor.preferences, ...validateHomeLayout(layout, strings(policy, 'lockedCards')) };
      ctx.store.savePerson(ctx.actor); ctx.result = { reset: true, hospitalDefaultVersion: num(policy, 'version') }; break;
    }
    case 'preferences.language':
      ctx.actor.preferences = { ...ctx.actor.preferences, language: ctx.t('language'), ...(ctx.t('printLanguage') ? { printLanguage: ctx.t('printLanguage') } : {}) };
      ctx.store.savePerson(ctx.actor); ctx.result = { language: ctx.t('language'), authoredContentTranslated: false }; break;
    case 'presence.set': {
      const e = ctx.all('presence').find(e => e.doctorId === ctx.actor.id);
      const reset = e ? text(e.data, 'systemReset') : '';
      requireThat(!reset || ctx.request.createdAt > reset, 'This presence update predates the 22:00 hospital reset. Review your current presence and send a fresh update.', 'STALE_PRESENCE');
      const data = { ...p, name: ctx.actor.name, reportedAt: ctx.request.createdAt, receivedAt: ctx.now(), awayUntil: ctx.t('status') === 'Away' ? new Date(new Date(ctx.now()).getTime() + ctx.n('minutes', 30) * 60000).toISOString() : '' };
      if (e) ctx.update(e, data, ctx.t('status')); else ctx.create('presence', data, ctx.t('status'), { doctorId: ctx.actor.id, department: ctx.actor.department });
      break;
    }
    case 'availability.request': {
      requireThat(ctx.t('endDate') >= ctx.t('date'), 'The end date must be on or after the first date.');
      if (['Late start', 'Extra session'].includes(ctx.t('kind'))) requireThat(ctx.t('start'), 'Enter the new session start time.');
      if (['Early finish', 'Extra session'].includes(ctx.t('kind'))) requireThat(ctx.t('end'), 'Enter the new session end time.');
      const affected = ctx.all('visit').filter(v => v.doctorId === ctx.actor.id && text(v.data, 'date') >= ctx.t('date') && text(v.data, 'date') <= ctx.t('endDate') && !['Cancelled', 'Done'].includes(v.status));
      ctx.create('availability', { ...p, name: `${ctx.t('kind')} ${ctx.t('date')}`, affectedIds: affected.map(v => v.id), affectedCount: affected.length }, 'Requested', { doctorId: ctx.actor.id, department: ctx.actor.department }); break;
    }
    case 'visit.call': {
      const visit = ctx.clinical(ctx.targetOf('visit'), true);
      const calls = num(visit.data, 'calls') + 1;
      ctx.update(visit, { calls, calledAt: ctx.now() }, calls >= 3 ? 'Missed' : 'Called'); break;
    }
    case 'visit.open':
      ctx.update(ctx.clinical(ctx.targetOf('visit'), true), { openedAt: ctx.now(), identityConfirmed: true }, 'In consultation'); break;
    case 'visit.skip':
      ctx.update(ctx.clinical(ctx.targetOf('visit'), true), { skipReason: ctx.t('reason'), skipUntil: new Date(new Date(ctx.now()).getTime() + 300000).toISOString() }, 'Waiting'); break;
    case 'history.add': {
      const patient = ctx.patient();
      if (['Ocular', 'Dental', 'Obstetric'].includes(ctx.t('section'))) ctx.feature(ctx.t('section'));
      ctx.create('history', { ...p, name: ctx.t('section') }, 'Recorded', { patientId: patient.id, doctorId: ctx.actor.id }); break;
    }
    case 'allergy.add': {
      const patient = ctx.patient();
      if (ctx.t('substance') !== 'No known allergies') requireThat(ctx.t('reaction'), 'Describe the reaction, or explicitly say unknown.');
      if (ctx.t('substance') === 'No known allergies') requireThat(!ctx.all('allergy').some(e => e.patientId === patient.id && e.status === 'Active' && text(e.data, 'substance') !== 'No known allergies'), 'An active allergy exists. Correct it with a reason before recording no known allergies.');
      ctx.create('allergy', { ...p, name: ctx.t('substance') }, 'Active', { patientId: patient.id, doctorId: ctx.actor.id });
      ctx.update(patient, { allergyVersion: num(patient.data, 'allergyVersion') + 1 }); break;
    }
    case 'allergy.void': {
      const allergy = ctx.targetOf('allergy'); const patient = ctx.patient(allergy.patientId);
      ctx.update(allergy, { correctionReason: ctx.t('reason') }, 'Entered in error');
      ctx.update(patient, { allergyVersion: num(patient.data, 'allergyVersion') + 1 }); break;
    }
    case 'vital.record': {
      const patient = ctx.patient();
      const v = ctx.t('visitId') ? ctx.get(ctx.t('visitId'), 'visit') : undefined;
      const admission = ctx.t('admissionId') ? ctx.get(ctx.t('admissionId'), 'admission') : undefined;
      requireThat(v || admission, 'Link these readings to a visit or active admission.');
      requireThat((!v || v.patientId === patient.id) && (!admission || admission.patientId === patient.id), 'The encounter and patient do not match.');
      if (doctorRoles.includes(ctx.actor.role)) ctx.clinical((admission || v)!);
      if (admission) requireThat(admission.status === 'Admitted', 'Admission is no longer active.');
      const extreme = ctx.n('systolic') > 220 || ctx.n('systolic') < 70 || ctx.n('diastolic') > 130 || ctx.n('spo2') < 90 || ctx.n('pulse') < 40 || ctx.n('pulse') > 180 || ctx.n('temperature') > 41;
      requireThat(!extreme || ctx.b('extremeConfirmed'), 'These measurements are outside the demo safety range. Recheck and confirm before saving.');
      requireThat(!p.ofc || num(patient.data, 'age') < 5, 'Head circumference is shown only for children under five.');
      ctx.create('vital', { ...p, name: `Vitals ${ctx.now()}`, examinedAbsent: ctx.b('restAbsent'), alert: ctx.n('spo2') < 90 }, 'Recorded', { patientId: patient.id, doctorId: (admission || v)?.doctorId });
      break;
    }
    case 'vital.acknowledge':
      ctx.update(ctx.clinical(ctx.targetOf('vital')), { alertReviewed: true, reviewAction: ctx.t('action'), reviewedAt: ctx.now(), reviewedBy: ctx.actor.id }); break;
    case 'note.save': {
      const visit = ctx.visit();
      if (ctx.t('mode') === 'Dictation simulation') ctx.feature('Dictation');
      const versions = ctx.all('note').filter(e => text(e.data, 'visitId') === visit.id);
      const clean = { ...p }; delete clean.handwriting;
      if (p.handwriting) {
        const upload = new Context(ctx.store, ctx.actor, { ...ctx.request, payload: { patientId: visit.patientId!, kind: 'Other', file: p.handwriting, synthetic: true } });
        documentCommand('document.upload', upload); ctx.touched.push(...upload.touched); clean.handwritingDocumentId = upload.touched[0];
      }
      const e = ctx.create('note', { ...clean, name: `OPD note v${versions.length + 1}`, noteVersion: versions.length + 1, visitId: visit.id, attestation: ctx.actor.role === 'resident' ? 'Resident draft' : 'Synthetic reviewed note' }, ctx.actor.role === 'resident' ? 'Draft' : 'Reviewed', { patientId: visit.patientId, doctorId: visit.doctorId, department: visit.department });
      ctx.update(visit, { latestNoteId: e.id, noteRevision: versions.length + 1 });
      if (!ctx.t('icd')) ctx.create('coding', { name: 'Missing diagnosis code', sourceId: e.id, doctorText: ctx.t('diagnosis'), mlc: bool(ctx.get(visit.patientId!).data, 'mlc') }, 'Requested', { patientId: visit.patientId, doctorId: visit.doctorId, department: visit.department });
      break;
    }
    case 'note.countersign': {
      const note = ctx.clinical(ctx.targetOf('note'));
      const latest = ctx.all('note').filter(e => text(e.data, 'visitId') === text(note.data, 'visitId')).sort((a, b) => num(b.data, 'noteVersion') - num(a.data, 'noteVersion'))[0];
      requireThat(latest.id === note.id, 'A newer note exists. Review the current draft rather than signing an old version.');
      ctx.update(note, { approvedBy: ctx.actor.id, approvedAt: ctx.now(), attestation: 'Consultant countersigned synthetic note' }, 'Reviewed'); break;
    }
    case 'rx.approve': {
      const visit = ctx.visit();
      const lines = checkedMedicines(ctx, visit.patientId!, rows(p, 'lines'), ctx.t('warningReason'));
      const previous = ctx.all('rx').find(e => text(e.data, 'visitId') === visit.id);
      requireThat(!previous || !['Part dispensed', 'Dispensed'].includes(previous.status), 'This prescription has dispensed lines. Use a new reviewed prescription encounter rather than rewriting the supplied version.');
      const data = { ...p, visitId: visit.id, name: `Prescription ${text(visit.data, 'number')}`, lines, rxVersion: previous ? num(previous.data, 'rxVersion', 1) + 1 : 1,
        allergyVersion: num(ctx.get(visit.patientId!).data, 'allergyVersion'), authorId: ctx.actor.id, approverId: ctx.actor.role === 'doctor' ? ctx.actor.id : '', attestation: 'SAMPLE - not a legal signature' };
      const status = ctx.actor.role === 'resident' ? 'Draft' : ctx.b('sendNow') ? 'Sent' : 'Approved';
      if (previous) ctx.update(previous, data, status); else ctx.create('rx', data, status, { patientId: visit.patientId, doctorId: visit.doctorId, department: visit.department });
      break;
    }
    case 'rx.countersign': {
      const rx = ctx.clinical(ctx.targetOf('rx'));
      checkedMedicines(ctx, rx.patientId!, rows(rx.data, 'lines'), text(rx.data, 'warningReason'));
      ctx.update(rx, { approverId: ctx.actor.id, approvedAt: ctx.now() }, bool(rx.data, 'sendNow') ? 'Sent' : 'Approved'); break;
    }
    case 'rx.send':
      ctx.update(ctx.clinical(ctx.targetOf('rx')), { sentAt: ctx.now() }, 'Sent'); break;
    case 'set.personal': {
      if (ctx.t('kind') === 'Medicines') {
        requireThat(rows(p, 'lines').length, 'Add medicine lines to the set.');
        for (const line of rows(p, 'lines')) requireThat(ctx.get(text(line, 'itemId'), 'item').status === 'Active', 'Remove retired medicines from the set.');
      } else {
        requireThat(strings(p, 'tests').length, 'Choose tests for the set.');
        for (const id of strings(p, 'tests')) requireThat(ctx.get(id, 'test').status === 'Active', 'Remove retired tests from the set.');
      }
      ctx.create('set', { ...p, scope: 'Personal', offered: ctx.b('offerDepartment') }, 'Active', { doctorId: ctx.actor.id, department: ctx.actor.department }); break;
    }
    case 'catalog.request':
      ctx.create('catalogRequest', { ...p }, 'Requested', { doctorId: ctx.actor.id, department: ctx.actor.department }); break;
    case 'order.send': {
      const visit = ctx.visit();
      orderTests(ctx, visit, visit.patientId!, visit.doctorId!, strings(p, 'tests'), p); break;
    }
    case 'order.cancel': {
      const order = ctx.clinical(ctx.targetOf('order'));
      ctx.update(order, { cancellationReason: ctx.t('reason') }, 'Cancelled');
      if (text(order.data, 'billId') && !text(order.data, 'packageId')) {
        const bill = ctx.get(text(order.data, 'billId'), 'bill');
        if (bill.status === 'Paid' && num(bill.data, 'paid') > 0) {
          const refund = ctx.create('refund', { name: 'Cancelled test refund', billId: bill.id, lineId: text(rows(bill.data, 'lines')[0], 'id'), amount: num(bill.data, 'paid'), reason: ctx.t('reason') }, 'Pending approval', { patientId: order.patientId });
          ctx.approval('Refund', refund.id, {}, ctx.t('reason'), num(bill.data, 'paid'));
        } else ctx.update(bill, { cancellationReason: ctx.t('reason') }, 'Cancelled');
      }
      break;
    }
    case 'followup.request': {
      const visit = ctx.visit();
      requireThat(ctx.t('date') >= text(visit.data, 'date'), 'Follow-up date must not precede the visit.');
      ctx.create('followup', { ...p, name: `Follow-up ${ctx.t('date')}`, visitId: visit.id }, ctx.b('requestBooking') ? 'Requested' : 'Recommended', { patientId: visit.patientId, doctorId: visit.doctorId }); break;
    }
    case 'followup.acknowledge':
      ctx.update(ctx.clinical(ctx.targetOf('followup')), { responseSeenAt: ctx.now() }); break;
    case 'referral.send': {
      const visit = ctx.visit();
      let receiverId = ctx.t('receiverId');
      const dept = ctx.get(ctx.t('departmentId'), 'department');
      if (ctx.t('kind') === 'Internal') {
        const routing = ctx.all('routing').find(e => e.department === dept.id);
        if (routing && text(routing.data, 'receiver') === 'Duty doctor') {
          const roster = ctx.all('roster').find(e => e.department === dept.id && text(e.data, 'date') === istDate(ctx.now()) && ['On call', 'Night'].includes(text(e.data, 'shift')));
          requireThat(roster, 'No duty doctor is rostered. Ask the desk to update the roster.');
          receiverId = text(roster.data, 'doctorId');
        }
        if (routing && text(routing.data, 'receiver') === 'Department queue') {
          receiverId = '';
        } else {
          const receiver = ctx.store.person(receiverId);
          requireThat(receiver.role === 'doctor' && receiver.state === 'Active' && receiver.department === dept.id && receiver.id !== ctx.actor.id, 'Choose another active consultant in the selected department.');
        }
      } else requireThat(ctx.t('hospital').length > 2, 'Enter the external hospital for the referral letter.');
      ctx.create('referral', { ...p, name: `${ctx.t('urgency')} ${ctx.t('kind')} referral`, visitId: visit.id, receiverId, senderId: ctx.actor.id, sentAt: ctx.now(), publicText: `New referral. ${ctx.t('urgency')}. Unlock to view.`, escalation: [] }, ctx.t('kind') === 'External' ? 'External letter ready' : 'Sent', { patientId: visit.patientId, doctorId: visit.doctorId, department: dept.id }); break;
    }
    case 'referral.see':
    case 'referral.answer': {
      const referral = ctx.targetOf('referral');
      requireThat(text(referral.data, 'receiverId') === ctx.actor.id || (!text(referral.data, 'receiverId') && referral.department === ctx.actor.department), 'Only the receiving consultant can answer this referral.');
      if (name === 'referral.see') { ctx.update(referral, { seenAt: ctx.now(), receiverId: ctx.actor.id }, 'Seen'); break; }
      const decision = ctx.t('decision');
      if (decision === 'Suggest another doctor') {
        const receiver = ctx.store.person(ctx.t('receiverId'));
        requireThat(receiver.role === 'doctor' && receiver.state === 'Active' && receiver.id !== ctx.actor.id, 'Choose a different active receiving doctor.');
        ctx.update(referral, { receiverId: receiver.id, reply: ctx.t('reply'), redirectedBy: ctx.actor.id }, 'Sent');
      } else {
        ctx.update(referral, { receiverId: ctx.actor.id, reply: ctx.t('reply'), answeredAt: ctx.now() }, decision === 'Accept' ? 'Accepted' : 'Declined');
        if (decision === 'Accept') {
          const source = ctx.get(text(referral.data, 'visitId'), 'visit');
          if (source.doctorId === ctx.actor.id && !['Done', 'Cancelled'].includes(source.status) && text(source.data, 'date') === istDate(ctx.now())) {
            ctx.update(source, { referralId: referral.id, priority: text(referral.data, 'urgency') !== 'Routine' });
            ctx.update(ctx.get(referral.id), { receivedVisitId: source.id });
          } else {
            const token = Math.max(0, ...ctx.all('visit').filter(v => v.doctorId === ctx.actor.id && text(v.data, 'date') === istDate(ctx.now())).map(v => num(v.data, 'token'))) + 1;
            const received = ctx.create('visit', { ...source.data, name: 'Accepted referral visit', number: `OPD-REF-${randomUUID().slice(0, 8)}`, date: istDate(ctx.now()), token, calls: 0, priority: text(referral.data, 'urgency') !== 'Routine', referralId: referral.id, room: text(ctx.get(ctx.actor.id).data, 'room') }, 'Waiting', { patientId: referral.patientId, doctorId: ctx.actor.id, department: ctx.actor.department });
            ctx.update(ctx.get(referral.id), { receivedVisitId: received.id });
          }
        }
      } break;
    }
    case 'admission.request': {
      const visit = ctx.visit(); const consultant = ctx.store.person(ctx.t('doctorId'));
      requireThat(consultant.role === 'doctor' && consultant.state === 'Active', 'Choose an active consultant of record.');
      requireThat(!ctx.all('admission').some(e => e.patientId === visit.patientId && ['Requested', 'Admitted'].includes(e.status)), 'This patient already has an open admission request or stay.');
      ctx.create('admission', { ...p, name: `Admission ${text(ctx.get(visit.patientId!).data, 'uhid')}`, visitId: visit.id, emergency: false, requestedAt: ctx.now() }, 'Requested', { patientId: visit.patientId, doctorId: consultant.id, department: consultant.department }); break;
    }
    case 'operation.request': {
      const patient = ctx.patient();
      const consultant = ctx.store.person(ctx.t('doctorId')); requireThat(consultant.role === 'doctor' && consultant.state === 'Active', 'Choose an active surgeon.');
      if (ctx.t('admissionId')) requireThat(ctx.get(ctx.t('admissionId'), 'admission').patientId === patient.id, 'Admission and patient must match.');
      ctx.create('operation', { ...p, name: ctx.t('procedure'), surgeonId: consultant.id, checklistComplete: false }, 'Requested', { patientId: patient.id, doctorId: ctx.actor.id, department: ctx.actor.department }); break;
    }
    case 'operation.respond':
      ctx.update(ctx.clinical(ctx.targetOf('operation')), { slotReply: ctx.t('reason') }, ctx.t('decision') === 'Accept' ? 'Scheduled' : 'Reschedule requested'); break;
    case 'visit.hold':
      ctx.update(ctx.clinical(ctx.targetOf('visit')), { holdReason: ctx.t('reason') }, 'Held'); break;
    case 'visit.resume':
      ctx.update(ctx.clinical(ctx.targetOf('visit')), { resumedAt: ctx.now() }, 'Waiting'); break;
    case 'visit.cancel': {
      const visit = ctx.targetOf('visit');
      if (doctorRoles.includes(ctx.actor.role)) ctx.clinical(visit, true);
      if (ctx.actor.role === 'patient') {
        ctx.patient(visit.patientId);
        requireThat(new Date(`${text(visit.data, 'date')}T${text(visit.data, 'time')}:00+05:30`).getTime() - new Date(ctx.now()).getTime() >= 7200000, 'Online cancellation closes two hours before the slot. Contact the front desk.');
      }
      ctx.update(visit, { cancelReason: ctx.t('reason'), cancelledAt: ctx.now() }, 'Cancelled');
      for (const bill of ctx.all('bill').filter(e => text(e.data, 'sourceId') === visit.id && num(e.data, 'paid') > 0)) {
        const line = rows(bill.data, 'lines')[0];
        const payment = ctx.all('payment').find(e => text(e.data, 'billId') === bill.id && e.status === 'Paid');
        const automatic = ctx.actor.role === 'patient' && text(visit.data, 'source') === 'Online' && payment && rows(payment.data, 'payments').every(p => text(p, 'mode') !== 'Cash');
        const refund = ctx.create('refund', { name: 'Cancelled visit refund', billId: bill.id, lineId: text(line, 'id'), amount: num(bill.data, 'paid') - num(bill.data, 'refunded'), reason: ctx.t('reason'),
          ...(automatic ? { originalModes: rows(payment.data, 'payments'), completedAt: ctx.now(), creditNumber: `CREDIT-${ctx.all('refund').length + 1}`, automaticOnlineCancellation: true } : {}) }, automatic ? 'Completed' : 'Pending approval', { patientId: visit.patientId });
        if (automatic) ctx.update(bill, { refunded: num(bill.data, 'paid') });
        else ctx.approval('Refund', refund.id, {}, ctx.t('reason'), num(bill.data, 'paid'));
      } break;
    }
    case 'visit.move': {
      const visit = ctx.targetOf('visit');
      if (doctorRoles.includes(ctx.actor.role)) ctx.clinical(visit, true);
      const slot = ctx.book(visit.patientId!, ctx.t('doctorId'), ctx.t('date'), ctx.t('time'), visit.data, visit.id);
      const old = { doctorId: visit.doctorId!, date: text(visit.data, 'date'), time: text(visit.data, 'time'), reason: ctx.t('reason'), at: ctx.now() };
      const token = Math.max(0, ...ctx.all('visit').filter(v => v.doctorId === ctx.t('doctorId') && text(v.data, 'date') === ctx.t('date')).map(v => num(v.data, 'token'))) + 1;
      ctx.update({ ...visit, doctorId: ctx.t('doctorId'), department: slot.department }, { date: ctx.t('date'), time: ctx.t('time'), room: slot.room, token, calls: 0, needsMove: false, moves: [...rows(visit.data, 'moves'), old] }, visit.status === 'Booked' ? 'Booked' : 'Waiting');
      ctx.message(visit.patientId!, 'Appointment moved', `${visit.id}-move-${visit.version}`);
      break;
    }
    case 'certificate.issue': {
      const patient = ctx.patient();
      ctx.create('certificate', { ...p, language: printLanguage(ctx.actor), number: `CERT-${String(ctx.all('certificate').length + 1).padStart(6, '0')}`, name: ctx.t('title'), registration: text(ctx.get(ctx.actor.id).data, 'registration'), author: ctx.actor.name }, 'Issued', { patientId: patient.id, doctorId: ctx.actor.id }); break;
    }
    case 'visit.done': {
      const visit = ctx.clinical(ctx.targetOf('visit'));
      const notes = ctx.all('note').filter(e => text(e.data, 'visitId') === visit.id);
      requireThat(notes.length > 0, 'Save or explicitly resolve the consultation note before finishing.');
      const latestNote = notes.sort((a, b) => num(b.data, 'noteVersion') - num(a.data, 'noteVersion'))[0];
      requireThat(latestNote.status === 'Reviewed', 'The consultant must countersign the latest resident note before this visit can be finished.');
      requireThat(!ctx.all('rx').some(e => text(e.data, 'visitId') === visit.id && e.status === 'Draft'), 'Ask the consultant to countersign the resident prescription before finishing.');
      ctx.update(visit, { firstDoneAt: text(visit.data, 'firstDoneAt') || ctx.request.createdAt, completedAt: ctx.now() }, 'Done');
      if (!ctx.all('coding').some(e => text(e.data, 'sourceId') === visit.id)) ctx.create('coding', { name: text(visit.data, 'number'), sourceId: visit.id, doctorText: text(notes.at(-1)!.data, 'diagnosis'), mlc: bool(ctx.get(visit.patientId!).data, 'mlc') }, 'Requested', { patientId: visit.patientId, doctorId: visit.doctorId, department: visit.department });
      const next = ctx.all('visit').filter(e => e.doctorId === visit.doctorId && e.status === 'Waiting' && text(e.data, 'skipUntil') <= ctx.now() && text(e.data, 'date') === text(visit.data, 'date') && text(e.data, 'mode') === text(visit.data, 'mode') && text(e.data, 'opdType') === text(visit.data, 'opdType')).sort((x, y) => Number(bool(y.data, 'priority')) - Number(bool(x.data, 'priority')) || num(x.data, 'token') - num(y.data, 'token'))[0];
      if (next) { ctx.update(next, { calls: num(next.data, 'calls') + 1, calledAt: ctx.now() }, 'Called'); ctx.result.nextVisitId = next.id; }
      break;
    }
    case 'round.save': {
      const admission = ctx.admission();
      ctx.create('round', { ...p, name: `Round ${istDate(ctx.now())}` }, 'Recorded', { patientId: admission.patientId, doctorId: admission.doctorId, department: admission.department }); break;
    }
    case 'ward.order': {
      const admission = ctx.admission();
      if (ctx.t('kind') === 'Medicine') requireThat(ctx.t('itemId') && ctx.get(ctx.t('itemId'), 'item').status === 'Active' && ctx.t('dose') && ctx.t('schedule'), 'Choose an active medicine, dose and schedule.');
      ctx.create('wardOrder', { ...p, name: `${ctx.t('kind')}: ${ctx.t('instruction')}`, authorId: ctx.actor.id, approverId: ctx.actor.role === 'doctor' ? ctx.actor.id : '' }, ctx.actor.role === 'resident' ? 'Draft' : 'Active', { patientId: admission.patientId, doctorId: admission.doctorId }); break;
    }
    case 'ward.countersign':
      ctx.update(ctx.clinical(ctx.targetOf('wardOrder')), { approverId: ctx.actor.id, approvedAt: ctx.now() }, 'Active'); break;
    case 'ward.stop':
      ctx.update(ctx.clinical(ctx.targetOf('wardOrder')), { reason: ctx.t('reason'), stoppedAt: ctx.now() }, 'Stopped'); break;
    case 'discharge.draft': {
      const admission = ctx.admission();
      const lines = checkedMedicines(ctx, admission.patientId!, rows(p, 'lines'));
      const prior = ctx.all('discharge').filter(e => text(e.data, 'admissionId') === admission.id);
      ctx.create('discharge', { ...p, lines, name: `Discharge summary v${prior.length + 1}`, summaryVersion: prior.length + 1, authorId: ctx.actor.id }, 'Draft', { patientId: admission.patientId, doctorId: admission.doctorId, department: admission.department }); break;
    }
    case 'discharge.approve': {
      const summary = ctx.clinical(ctx.targetOf('discharge'));
      requireThat(ctx.t('pin') === '2468', 'The demo signing PIN was not accepted.');
      requireThat(ctx.get(text(summary.data, 'admissionId'), 'admission').status === 'Admitted', 'The admission is not active.');
      checkedMedicines(ctx, summary.patientId!, rows(summary.data, 'lines'));
      ctx.update(summary, { approvedBy: ctx.actor.id, approvedAt: ctx.now(), pendingPlan: ctx.t('pendingPlan'), nursingHandoff: 'Requested', billingHandoff: 'Requested', attestation: 'SAMPLE - not a legal signature' }, 'Approved'); break;
    }
    case 'result.review': {
      const result = ctx.clinical(ctx.targetOf('result'));
      requireThat(!ctx.all('review').some(e => text(e.data, 'resultId') === result.id && num(e.data, 'resultVersion') === num(result.data, 'reportVersion', 1)), 'This version already has a recorded review. A corrected report requires a separate review.');
      ctx.create('review', { ...p, name: `Reviewed ${text(result.data, 'name')}`, resultId: result.id, resultVersion: num(result.data, 'reportVersion', 1), reviewedAt: ctx.now() }, 'Acknowledged', { patientId: result.patientId, doctorId: ctx.actor.id });
      if (ctx.t('decision') === 'Repeat test') {
        const order = ctx.get(text(result.data, 'orderId'), 'order');
        orderTests(ctx, undefined, result.patientId!, result.doctorId!, [text(order.data, 'testId')], { priority: 'Routine', history: ctx.t('action'), repeatOf: order.id });
      } break;
    }
    case 'question.answer': {
      const question = ctx.clinical(ctx.targetOf('question'));
      if (text(question.data, 'kind') === 'Pharmacy' && ctx.t('decision') === 'Approve proposal') {
        const rx = ctx.get(text(question.data, 'sourceId'), 'rx');
        requireThat(num(question.data, 'rxVersion') === num(rx.data, 'rxVersion'), 'This question refers to an old prescription. Ask pharmacy to review the current version.', 'STALE_PRESCRIPTION');
        const lines = rows(rx.data, 'lines').map(line => {
          if (text(line, 'id') !== text(question.data, 'lineId')) return line;
          requireThat(num(line, 'dispensed') === 0, 'This line was already partly dispensed. Ask pharmacy to reconcile it before substitution.');
          return { ...line, itemId: text(question.data, 'proposedItemId'), reviewed: true };
        });
        const checked = checkedMedicines(ctx, rx.patientId!, lines, ctx.t('reply'));
        ctx.update(rx, { lines: checked, rxVersion: num(rx.data, 'rxVersion') + 1, amendmentReason: ctx.t('reply'), authorId: ctx.actor.id, approverId: ctx.actor.id,
          source: text(rx.data, 'source') === 'Paper' ? 'App amendment of paper' : text(rx.data, 'source', 'App') }, 'Sent');
      }
      ctx.update(question, { decision: ctx.t('decision'), reply: ctx.t('reply'), answeredAt: ctx.now(), answeredBy: ctx.actor.id }, 'Answered'); break;
    }
    case 'video.start': {
      ctx.feature('Video');
      const visit = ctx.visit();
      requireThat(text(visit.data, 'mode') === 'Video', 'This encounter was not booked as video.');
      requireThat(!ctx.all('video').some(e => text(e.data, 'visitId') === visit.id && !['Ended', 'No show'].includes(e.status)), 'An active video simulation already exists for this visit.');
      ctx.create('video', { ...p, name: 'Simulated video visit', notRecorded: true, events: [{ stage: 'Waiting', at: ctx.now() }], durationSeconds: 0 }, 'Waiting', { patientId: visit.patientId, doctorId: visit.doctorId }); break;
    }
    case 'video.transition': {
      ctx.feature('Video');
      const video = ctx.clinical(ctx.targetOf('video'));
      const next = ctx.t('next');
      const allowed: Record<string, string[]> = {
        Waiting: ['Patient joined', 'Running late', 'No show'], Ready: ['Connect', 'Running late', 'No show'],
        Active: ['Mute', 'Camera off', 'Drop connection', 'End'], Reconnecting: ['Reconnect', 'Switch to phone', 'End'],
        Telephone: ['End']
      };
      requireThat(allowed[video.status]?.includes(next), 'That call action is not available in the current stage.');
      const states: Record<string, string> = { 'Patient joined': 'Ready', Connect: 'Active', 'Drop connection': 'Reconnecting', Reconnect: 'Active', 'Switch to phone': 'Telephone', End: 'Ended', 'No show': 'No show' };
      const data: Data = { events: [...rows(video.data, 'events'), { stage: next, at: ctx.now() }] };
      if (next === 'Connect') data.startedAt = ctx.now();
      if (next === 'Mute') data.muted = !bool(video.data, 'muted');
      if (next === 'Camera off') data.cameraOff = !bool(video.data, 'cameraOff');
      if (next === 'End') data.durationSeconds = Math.max(0, Math.round((new Date(ctx.now()).getTime() - new Date(text(video.data, 'startedAt', ctx.now())).getTime()) / 1000));
      if (next === 'Running late') ctx.message(video.patientId!, 'Doctor running late', `${video.id}-late`);
      ctx.update(video, data, states[next] || video.status); break;
    }
    case 'abha.request': {
      const patient = ctx.patient(); const code = String(randomInt(100000, 1000000));
      const record = ctx.create('abha', { name: 'Synthetic ABHA link', address: ctx.t('address'), consent: true, codeHash: hash(code), expires: Date.now() + 300000, failures: 0, attempts: [] }, 'OTP sent', { patientId: patient.id, doctorId: ctx.actor.role === 'doctor' ? ctx.actor.id : undefined });
      ctx.result = { simulatedCode: code, abhaId: record.id }; break;
    }
    case 'abha.verify': {
      const abha = ctx.targetOf('abha'); ctx.patient(abha.patientId);
      requireThat(num(abha.data, 'expires') > Date.now(), 'The simulated OTP expired. Request a new code.');
      requireThat(hash(ctx.t('otp')) === text(abha.data, 'codeHash'), 'The OTP did not match. Check it or request another code.');
      ctx.update(abha, { linkedAt: ctx.now(), codeHash: '', linkedRecords: ['Synthetic care context - no live records'] }, 'Linked');
      ctx.update(ctx.get(abha.patientId!), { abha: ctx.t('address') || text(abha.data, 'address'), abhaStatus: 'Linked' }); break;
    }
    case 'abha.withdraw': {
      const abha = ctx.targetOf('abha'); ctx.patient(abha.patientId);
      ctx.update(abha, { consent: false, withdrawnAt: ctx.now(), reason: ctx.t('reason') }, 'Consent withdrawn'); break;
    }
    case 'help.create':
      ctx.create('help', { name: ctx.t('topic'), topic: ctx.t('topic'), detail: ctx.t('detail'), replies: [], actorId: ctx.actor.id, appVersion: ctx.actor.appVersion, number: `HELP-${ctx.all('help').length + 1}` }, 'Open', { doctorId: ctx.actor.id, department: ctx.actor.department }); break;
    case 'article.read': {
      const article = ctx.targetOf('article');
      ctx.update(article, { readBy: [...new Set([...strings(article.data, 'readBy'), ctx.actor.id])], helpful: ctx.b('helpful') ? [...new Set([...strings(article.data, 'helpful'), ctx.actor.id])] : strings(article.data, 'helpful') }); break;
    }
    case 'announcement.dismiss': {
      const announcement = ctx.targetOf('announcement');
      ctx.update(announcement, { dismissedBy: [...new Set([...strings(announcement.data, 'dismissedBy'), ctx.actor.id])] }); break;
    }
    default: return false;
  }
  return true;
}
