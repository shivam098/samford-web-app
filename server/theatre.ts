import { text, num, type Data, type Entity } from '../shared/model.js';
import { Context } from './context.js';
import { requireThat } from './store.js';
export function intervalsOverlap(start: string, end: string, otherStart: string, otherEnd: string) {
  return new Date(start).getTime() < new Date(otherEnd).getTime() && new Date(end).getTime() > new Date(otherStart).getTime();
}
export function theatreSlot(ctx: Context, operation: Entity, data: Data, ignored: string[] = [], proposed: Entity[] = []): Data {
  const start = text(data, 'start'); const theatre = text(data, 'theatre');
  requireThat(Number.isFinite(Date.parse(start)) && ['OT 1', 'OT 2'].includes(theatre), 'Choose a valid theatre and start time.');
  const end = new Date(Date.parse(start) + num(operation.data, 'duration') * 60000).toISOString();
  const assetId = text(data, 'assetId') || text(operation.data, 'assetId');
  if (assetId) requireThat(ctx.get(assetId, 'asset').status === 'Available', 'The selected equipment is under maintenance.');
  const others = [...ctx.all('operation').filter(other => other.id !== operation.id && !ignored.includes(other.id)), ...proposed];
  requireThat(!others.some(other => ['Offered', 'Scheduled', 'In theatre', 'Recovery'].includes(other.status) &&
    (text(other.data, 'theatre') === theatre || text(other.data, 'surgeonId') === text(operation.data, 'surgeonId') || (assetId && text(other.data, 'assetId') === assetId)) &&
    intervalsOverlap(start, end, text(other.data, 'start'), text(other.data, 'end'))),
  'The theatre, surgeon or equipment is already booked for this interval.');
  return { ...data, start, end, theatre, assetId };
}
export function emergencySchedule(ctx: Context) {
  const operation = ctx.targetOf('operation');
  requireThat(text(operation.data, 'urgency') === 'Emergency', 'This action is only for a doctor-requested emergency operation.');
  const planned = ctx.get(ctx.t('plannedId'), 'operation');
  requireThat(planned.id !== operation.id && ['Offered', 'Scheduled'].includes(planned.status), 'Only a different planned case that has not entered theatre may be moved.');
  requireThat(ctx.request.contextVersions?.[planned.id] === planned.version, 'Review the latest planned case before rescheduling it.', 'VERSION_CONFLICT');
  const emergencyEnd = new Date(Date.parse(ctx.t('start')) + num(operation.data, 'duration') * 60000).toISOString();
  requireThat((text(planned.data, 'theatre') === ctx.t('theatre') || text(planned.data, 'surgeonId') === text(operation.data, 'surgeonId')) &&
    intervalsOverlap(ctx.t('start'), emergencyEnd, text(planned.data, 'start'), text(planned.data, 'end')),
  'The selected planned case does not conflict with this emergency. Use ordinary scheduling instead.');
  const moved = theatreSlot(ctx, planned, { ...planned.data, theatre: ctx.t('rescheduledTheatre'), start: ctx.t('rescheduledStart') }, [operation.id]);
  const emergency = theatreSlot(ctx, operation, { theatre: ctx.t('theatre'), start: ctx.t('start'), anaesthetist: ctx.t('anaesthetist'), scrubNurse: ctx.t('scrubNurse'), assetId: ctx.t('assetId'), implants: ctx.t('implants') },
    [planned.id], [{ ...planned, data: moved }]);
  ctx.update(planned, { ...moved, checklistComplete: false, slotChangedAt: ctx.now(), slotChangeReason: ctx.t('reason'),
    previousSlot: { theatre: text(planned.data, 'theatre'), start: text(planned.data, 'start'), end: text(planned.data, 'end') }, movedForEmergency: operation.id }, 'Offered');
  ctx.update(operation, { ...emergency, scheduledBy: ctx.actor.id, emergencyMoveReason: ctx.t('reason'), displacedCaseId: planned.id }, 'Offered');
}
