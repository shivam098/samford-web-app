import { text, num, bool, rows, istDate, hasRole, type Data } from '../shared/model.js';
import { Context } from './context.js';
import { requireThat } from './store.js';

export function servicesCommand(name: string, ctx: Context): boolean {
  const p = ctx.p;
  switch (name) {
    case 'trip.request': {
      const patient = ctx.patient();
      ctx.create('trip', { ...p, name: `${ctx.t('kind')} to ${ctx.t('to')}`, requestedAt: ctx.now() }, 'Requested', { patientId: patient.id }); break;
    }
    case 'trip.assign': {
      const trip = ctx.targetOf('trip'); const vehicle = ctx.get(ctx.t('vehicleId'), 'vehicle');
      requireThat(vehicle.status === 'Free' && text(vehicle.data, 'kind') === text(trip.data, 'kind'), 'Choose a free vehicle of the requested type.');
      requireThat(text(vehicle.data, 'serviceDue') > istDate(ctx.now()), 'This vehicle is due for service and cannot be assigned.');
      ctx.update(vehicle, { tripId: trip.id }, 'Assigned');
      ctx.update(trip, { ...p, assignedAt: ctx.now(), driverNotification: 'Simulated SMS delivered' }, 'Booked'); break;
    }
    case 'trip.advance': {
      const trip = ctx.targetOf('trip');
      const transitions: Record<string, string> = { Booked: 'On the way', 'On the way': 'Arrived', Arrived: 'Completed' };
      requireThat(transitions[trip.status] === ctx.t('next'), 'Follow the trip stages in order.');
      if (ctx.t('next') === 'Completed') {
        requireThat(typeof p.km === 'number', 'Enter kilometres to close the trip.');
        const tariff = ctx.tariff('transport');
        const bill = ctx.charge(trip.patientId!, 'Transport', Math.round(ctx.n('km') * num(tariff.data, 'rate')), trip.id, { km: ctx.n('km'), tariffId: tariff.id });
        ctx.update(ctx.get(text(trip.data, 'vehicleId'), 'vehicle'), { tripId: '', lastKm: ctx.n('km'), fuel: ctx.n('fuel') }, 'Free');
        ctx.update(trip, { km: ctx.n('km'), fuel: ctx.n('fuel'), completedAt: ctx.now(), billId: bill.id }, 'Completed');
      } else ctx.update(trip, { stages: [...rows(trip.data, 'stages'), { status: ctx.t('next'), at: ctx.now() }] }, ctx.t('next'));
      break;
    }
    case 'diet.order': {
      const admission = ctx.admission(); const order = ctx.get(ctx.t('orderId'), 'wardOrder');
      requireThat(order.status === 'Active' && text(order.data, 'kind') === 'Diet' && text(order.data, 'admissionId') === admission.id, 'Choose this patient’s signed active diet order.');
      const late = new Date(ctx.t('mealAt')).getTime() - new Date(ctx.now()).getTime() < 7200000;
      const nextMeal: Record<string, { name: string; time: string; nextDay: boolean }> = { Breakfast: { name: 'Lunch', time: '13:00', nextDay: false }, Lunch: { name: 'Dinner', time: '20:00', nextDay: false }, Dinner: { name: 'Breakfast', time: '08:00', nextDay: true } };
      const next = nextMeal[ctx.t('meal')];
      const nextDate = istDate(new Date(new Date(ctx.t('mealAt')).getTime() + (next.nextDay ? 86400000 : 0)).toISOString());
      const effectiveAt = late ? new Date(`${nextDate}T${next.time}:00+05:30`).toISOString() : ctx.t('mealAt');
      const nil = text(order.data, 'diet') === 'Nil by mouth';
      const meal = late && !nil ? next.name : ctx.t('meal');
      for (const prior of ctx.all('diet').filter(e => e.patientId === admission.patientId && e.status === 'Ordered' && (nil || text(e.data, 'meal') === meal))) ctx.update(prior, { supersededByOrder: order.id }, 'Superseded');
      ctx.create('diet', { ...p, meal, requestedMeal: ctx.t('meal'), name: `${meal} - ${text(order.data, 'diet')}`, diet: text(order.data, 'diet'), bedId: text(admission.data, 'bedId'), effectiveAt, cutoffApplied: late }, nil ? 'No tray - nil by mouth' : 'Ordered', { patientId: admission.patientId, doctorId: admission.doctorId }); break;
    }
    case 'diet.deliver': {
      const diet = ctx.targetOf('diet'); const admission = ctx.get(text(diet.data, 'admissionId'), 'admission');
      requireThat(admission.status === 'Admitted', 'The patient is no longer admitted. Do not deliver a tray.');
      requireThat(!ctx.all('wardOrder').some(e => e.patientId === diet.patientId && e.status === 'Active' && text(e.data, 'kind') === 'Diet' && text(e.data, 'diet') === 'Nil by mouth'), 'The patient has an active nil-by-mouth order. No tray can be delivered.');
      requireThat(text(diet.data, 'effectiveAt') <= ctx.now(), 'This order applies to a later meal because of the two-hour cutoff.');
      ctx.update(diet, { deliveredAt: ctx.now(), deliveredBy: ctx.actor.id, bedId: text(admission.data, 'bedId') }, 'Delivered'); break;
    }
    case 'mortuary.receive': {
      const cabinet = ctx.get(ctx.t('cabinetId'), 'cabinet');
      requireThat(cabinet.status === 'Free', 'This cabinet is occupied. Choose a free cabinet.');
      const entry = ctx.create('mortuary', { ...p, receivedAt: ctx.now() }, 'Received');
      ctx.update(cabinet, { mortuaryId: entry.id }, 'Occupied'); break;
    }
    case 'mortuary.release': {
      const entry = ctx.targetOf('mortuary'); const second = ctx.store.person(ctx.t('secondStaffId'));
      requireThat(hasRole(second, ['services']) && second.state === 'Active' && second.id !== ctx.actor.id, 'A second distinct support staff member must check the release.');
      requireThat(!bool(entry.data, 'mlc') || ctx.b('police'), 'MLC release is blocked without police clearance.');
      requireThat(/^\d{4}$/.test(ctx.t('receiverLast4')), 'Store only the receiver ID’s last four digits.');
      ctx.update(entry, { ...p, releasedAt: ctx.now(), firstStaffId: ctx.actor.id }, 'Released');
      ctx.update(ctx.get(text(entry.data, 'cabinetId'), 'cabinet'), { mortuaryId: '' }, 'Free'); break;
    }
    case 'facility.raise':
      if (ctx.t('assetId')) ctx.get(ctx.t('assetId'), 'asset');
      ctx.create('facility', { ...p, name: `${ctx.t('category')} - ${ctx.t('location')}`, dueAt: new Date(new Date(ctx.now()).getTime() + (ctx.t('urgency') === 'Urgent' ? 1 : 24) * 3600000).toISOString() }, 'Open'); break;
    case 'facility.assign':
      ctx.update(ctx.targetOf('facility'), { team: ctx.t('team'), assignedAt: ctx.now() }, 'In progress'); break;
    case 'facility.close':
      ctx.update(ctx.targetOf('facility'), { closingNote: ctx.t('note'), closedAt: ctx.now() }, 'Closed'); break;
    case 'facility.reopen': {
      const request = ctx.targetOf('facility');
      requireThat(request.createdBy === ctx.actor.id, 'Only the requester can reopen this request.');
      requireThat(new Date(ctx.now()).getTime() - new Date(text(request.data, 'closedAt')).getTime() <= 86400000, 'The 24-hour reopening window ended. Raise a new request.');
      ctx.update(request, { reopenReason: ctx.t('reason') }, 'Reopened'); break;
    }
    case 'coding.finish': {
      const coding = ctx.targetOf('coding');
      requireThat(/^[A-Z][0-9]{2}(?:\.[0-9A-Z]{1,4})?$/.test(ctx.t('icd')), 'Use an ICD-10-style code such as R50.9. This sample catalog does not make clinical coding decisions.');
      const source = ctx.get(text(coding.data, 'sourceId'));
      requireThat(source.type === 'note' || ['Done', 'Discharged'].includes(source.status), 'The encounter must be finished before filing.');
      const pendingOperation = ctx.all('operation').some(e => e.patientId === coding.patientId && ['In theatre', 'Recovery', 'Shifted to ward'].includes(e.status));
      const hasConsent = ctx.all('consent').some(e => e.patientId === coding.patientId && e.status === 'Signed');
      const complete = ctx.b('complete') && (!pendingOperation || hasConsent);
      ctx.update(coding, { icd: ctx.t('icd'), otherCodes: ctx.t('otherCodes'), detail: ctx.t('detail'), reason: ctx.t('reason'), codedBy: ctx.actor.id, codedAt: complete ? ctx.now() : '', locked: complete && bool(coding.data, 'mlc'), incompleteReason: complete ? '' : 'Review missing notes, summary or signed consent.' }, complete ? 'Coded' : 'Incomplete'); break;
    }
    case 'coding.question': {
      const coding = ctx.targetOf('coding');
      ctx.create('question', { ...p, name: 'Coding clarification', kind: 'Coding', sourceId: coding.id }, 'Open', { patientId: coding.patientId, doctorId: coding.doctorId }); break;
    }
    case 'hospitalDocument.publish': {
      const prior = ctx.all('hospitalDocument').filter(e => text(e.data, 'title') === ctx.t('title')).sort((a, b) => num(b.data, 'documentVersion') - num(a.data, 'documentVersion'))[0];
      requireThat(!prior || prior.createdBy === ctx.actor.id || ctx.actor.role === 'manager', 'Only the document owner or operations manager may publish a new version.');
      ctx.create('hospitalDocument', { ...p, documentVersion: prior ? num(prior.data, 'documentVersion') + 1 : 1, previousId: prior?.id ?? '', ownerId: prior ? text(prior.data, 'ownerId') : ctx.actor.id }, 'Published'); break;
    }
    case 'enquiry.save':
      ctx.create('enquiry', { ...p, name: ctx.t('question') }, ctx.t('callback') ? 'Callback due' : 'Answered'); break;
    case 'feedback.save': {
      const patient = ctx.patient();
      ctx.create('feedback', { ...p, name: ctx.b('complaint') ? 'Patient complaint' : 'Patient feedback', dueAt: new Date(new Date(ctx.now()).getTime() + 7 * 86400000).toISOString() }, ctx.b('complaint') ? 'Open' : 'Recorded', { patientId: patient.id, department: ctx.t('departmentId') }); break;
    }
    case 'feedback.close':
      ctx.update(ctx.targetOf('feedback'), { action: ctx.t('action'), closedAt: ctx.now() }, 'Closed'); break;
    case 'message.retry': {
      const message = ctx.targetOf('message');
      const failed = ctx.store.setting<Data>('faults', {}).provider === 'Failure';
      ctx.update(message, { attempts: [...rows(message.data, 'attempts'), { at: ctx.now(), actor: ctx.actor.id, status: failed ? 'Failed' : 'Delivered', reason: failed ? 'Simulated provider still unavailable.' : 'Simulated delivery only.' }] }, failed ? 'Failed' : 'Delivered'); break;
    }
    default: return false;
  }
  return true;
}
