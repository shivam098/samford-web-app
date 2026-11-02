import { handoverGroups, type HandoverGroupKey } from '../shared/handover.js';
import { text, num, bool, rows, type Actor, type Data, type Entity } from '../shared/model.js';
import { Store, requireThat } from './store.js';
import { Context } from './context.js';

type Assignment = { entity: Entity; field: 'doctorId' | 'receiverId' };
export function groupedWork(store: Store, doctorId: string): Map<HandoverGroupKey, Assignment[]> {
  const groups = new Map<HandoverGroupKey, Assignment[]>(handoverGroups.map(group => [group.key, []]));
  const add = (group: HandoverGroupKey, entity: Entity, field: Assignment['field'] = 'doctorId') => groups.get(group)!.push({ entity, field });
  for (const entity of store.all()) {
    if (entity.type === 'referral' && ['Sent', 'Seen'].includes(entity.status)) {
      if (entity.doctorId === doctorId) add('referralsSent', entity);
      if (text(entity.data, 'receiverId') === doctorId) add('referralsReceived', entity, 'receiverId');
      continue;
    }
    if (entity.doctorId !== doctorId) continue;
    if (entity.type === 'note' && entity.status === 'Draft') add('unsignedNotes', entity);
    if (['admission', 'wardOrder', 'discharge'].includes(entity.type) && !['Discharged', 'Stopped', 'Cancelled'].includes(entity.status)) {
      const admission = entity.type === 'admission' ? entity : store.get(text(entity.data, 'admissionId'), 'admission');
      if (['Admitted', 'Requested'].includes(admission.status)) add('admissions', entity);
    }
    if (entity.type === 'visit' && !['Done', 'Cancelled'].includes(entity.status)) add('followups', entity);
    if (entity.type === 'followup' && ['Requested', 'Booked', 'Recommended'].includes(entity.status)) add('followups', entity);
    if (entity.type === 'question' && entity.status === 'Open') add('questions', entity);
    if (entity.type === 'rx' && !['Dispensed', 'Cancelled'].includes(entity.status)) add('pendingCare', entity);
    if (entity.type === 'order' && !['Released', 'Cancelled', 'Skipped'].includes(entity.status)) add('pendingCare', entity);
    if (entity.type === 'result' && entity.status === 'Released' && !store.all('review').some(review => text(review.data, 'resultId') === entity.id)) add('pendingCare', entity);
  }
  return groups;
}
export function handoverSummary(store: Store, doctorId: string): Data {
  const groups = groupedWork(store, doctorId);
  return {
    groups: handoverGroups.map(group => ({ key: group.key, label: group.label, count: groups.get(group.key)!.length,
      hospitalIds: [...new Set(groups.get(group.key)!.map(item => item.entity.patientId ? text(store.get(item.entity.patientId, 'patient').data, 'uhid') : '').filter(Boolean))] })),
    devices: store.all('device').filter(device => text(device.data, 'actorId') === doctorId).map(device => ({
      id: device.id, name: text(device.data, 'name'), unsent: num(device.data, 'unsent'), lastSync: text(device.data, 'lastSync'), status: device.status
    }))
  };
}
export function handoverPlan(ctx: Context, owner: Actor, required: boolean): Data[] {
  const work = groupedWork(ctx.store, owner.id);
  let plan = rows(ctx.p, 'handovers');
  if (!plan.length && ctx.t('receiverId')) plan = handoverGroups.map(group => ({ group: group.key, receiverType: 'Doctor', receiverId: ctx.t('receiverId') }));
  requireThat(new Set(plan.map(row => text(row, 'group'))).size === plan.length, 'Choose only one recipient for each handover group.');
  requireThat(plan.every(row => handoverGroups.some(group => group.key === text(row, 'group'))), 'The handover contains an unknown group. Refresh the summary.');
  for (const group of handoverGroups) {
    if (!work.get(group.key)!.length) continue;
    const row = plan.find(row => text(row, 'group') === group.key);
    if (!required && (!row || text(row, 'receiverType') === 'Leave waiting')) continue;
    requireThat(row, `${group.label} has open work. Choose a consultant or Department queue before removing access.`);
    const kind = text(row, 'receiverType');
    requireThat(['Doctor', 'Department queue'].includes(kind), `Choose a recipient for ${group.label}.`);
    if (kind === 'Doctor') {
      const receiver = ctx.store.person(text(row, 'receiverId'));
      requireThat(receiver.role === 'doctor' && receiver.state === 'Active' && receiver.id !== owner.id, `Choose a different active consultant for ${group.label}.`);
    }
  }
  return plan;
}
function assign(ctx: Context, original: Entity, field: Assignment['field'], receiverId: string, queueDepartment: string, handoverId: string, originalOwner: string) {
  const entity = ctx.get(original.id);
  const queue = !receiverId;
  const data: Data = { handedOverFrom: originalOwner, handedOverAt: ctx.now(), handoverReason: ctx.t('reason'),
    handoverId, handoverQueue: queue, handoverDepartment: queueDepartment };
  if (entity.type === 'referral') data.senderId = text(entity.data, 'senderId') || entity.createdBy;
  if (entity.type === 'visit' && entity.status === 'Booked') data.needsMove = true;
  if (entity.type === 'visit' && entity.status !== 'Booked' && receiverId && entity.doctorId !== receiverId) {
    data.handoverTokenHistory = [...rows(entity.data, 'handoverTokenHistory'), { doctorId: entity.doctorId ?? '', token: num(entity.data, 'token'), room: text(entity.data, 'room'), at: ctx.now() }];
    data.token = Math.max(0, ...ctx.all('visit').filter(visit => visit.id !== entity.id && visit.doctorId === receiverId && text(visit.data, 'date') === text(entity.data, 'date')).map(visit => num(visit.data, 'token'))) + 1;
    data.room = text(ctx.get(receiverId, 'account').data, 'room');
    data.calls = 0;
  }
  if (field === 'receiverId') ctx.update({ ...entity, department: queue ? queueDepartment : ctx.store.person(receiverId).department }, { ...data, receiverId });
  else ctx.update({ ...entity, doctorId: receiverId || undefined, department: queue ? queueDepartment : entity.department }, data);
}
export function applyHandover(ctx: Context, owner: Actor, plan: Data[]) {
  const groups = groupedWork(ctx.store, owner.id);
  for (const group of handoverGroups) {
    const work = groups.get(group.key)!; const choice = plan.find(row => text(row, 'group') === group.key);
    if (!work.length || !choice || text(choice, 'receiverType') === 'Leave waiting') continue;
    const receiverId = text(choice, 'receiverType') === 'Doctor' ? text(choice, 'receiverId') : '';
    const handover = ctx.create('handover', { name: group.label, group: group.key, fromDoctorId: owner.id, receiverId,
      receiverType: receiverId ? 'Doctor' : 'Department queue', items: work.map(item => ({ id: item.entity.id, field: item.field })),
      count: work.length, hospitalIds: [...new Set(work.map(item => item.entity.patientId ? text(ctx.get(item.entity.patientId).data, 'uhid') : '').filter(Boolean))],
      reason: ctx.t('reason') }, receiverId ? 'Assigned' : 'Awaiting claim', { department: receiverId ? ctx.store.person(receiverId).department : owner.department });
    for (const item of work) assign(ctx, item.entity, item.field, receiverId, owner.department, handover.id, owner.id);
  }
}
export function claimHandover(ctx: Context) {
  const handover = ctx.targetOf('handover');
  requireThat(ctx.actor.role === 'doctor' && handover.department === ctx.actor.department, 'Only an active consultant in this department may claim this queue.');
  const items = rows(handover.data, 'items');
  requireThat(items.every(item => {
    const entity = ctx.get(text(item, 'id'));
    return bool(entity.data, 'handoverQueue') && text(entity.data, 'handoverId') === handover.id;
  }), 'Some queued work was already reassigned. Refresh before claiming.');
  for (const item of items) {
    requireThat(['doctorId', 'receiverId'].includes(text(item, 'field')), 'This queue contains an unsupported assignment.');
    assign(ctx, ctx.get(text(item, 'id')), text(item, 'field') as Assignment['field'], ctx.actor.id, ctx.actor.department, handover.id, text(handover.data, 'fromDoctorId'));
  }
  ctx.update(handover, { receiverId: ctx.actor.id, claimedAt: ctx.now(), claimedBy: ctx.actor.id }, 'Claimed');
}
