import { randomUUID } from 'node:crypto';
import { doctorRoles, adminRoles, actorRoles, hasRole, text, num, bool, strings, istDate, type Actor, type Data, type Entity, type CommandRequest, type Snapshot } from '../shared/model.js';
import { Store, requireThat } from './store.js';

const staffRead: Record<string, string[]> = {
  desk: ['patient', 'visit', 'presence', 'availability', 'followup', 'board', 'document', 'bill', 'payment', 'admission', 'bed', 'certificate', 'consent', 'packageRun', 'trip', 'vehicle', 'enquiry', 'feedback', 'message', 'abha', 'facility', 'counterClose', 'refund'],
  cashier: ['patient', 'visit', 'bill', 'payment', 'claim', 'refund', 'return', 'counterClose', 'admission', 'discharge', 'document', 'packageRun', 'facility', 'approval', 'question'],
  pharmacist: ['patient', 'rx', 'question', 'batch', 'dispense', 'return', 'wardRequest', 'wardOrder', 'admission', 'bill', 'payment', 'document', 'requisition', 'stockTransfer', 'refund', 'counterClose', 'facility'],
  store: ['batch', 'requisition', 'purchase', 'grn', 'stockTransfer', 'vendor', 'asset', 'writeoff', 'stockCount', 'facility', 'approval'],
  nurse: ['patient', 'visit', 'admission', 'bed', 'round', 'wardOrder', 'administration', 'nursing', 'vital', 'wardRequest', 'discharge', 'document', 'consent', 'register', 'certificate', 'daycare', 'operation', 'diet', 'facility', 'trip'],
  lab: ['patient', 'order', 'sample', 'result', 'review', 'question', 'facility', 'document'],
  ot: ['patient', 'operation', 'admission', 'bed', 'asset', 'consent', 'facility'],
  mrd: ['patient', 'coding', 'note', 'discharge', 'document', 'consent', 'hospitalDocument', 'question', 'facility'],
  services: ['bed', 'diet', 'trip', 'vehicle', 'mortuary', 'cabinet', 'asset', 'facility'],
  manager: ['patient', 'visit', 'availability', 'followup', 'presence', 'board', 'document', 'bill', 'payment', 'claim', 'refund', 'counterClose', 'requisition', 'purchase', 'grn', 'stockTransfer', 'vendor', 'asset', 'batch', 'writeoff', 'stockCount', 'itemPrice', 'catalogRequest', 'admission', 'bed', 'discharge', 'daycare', 'register', 'consent', 'certificate', 'packageRun', 'trip', 'vehicle', 'diet', 'facility', 'coding', 'hospitalDocument', 'enquiry', 'feedback', 'message', 'approval', 'job', 'jobRun', 'nursing', 'vital', 'administration'],
};
const commonCatalog = ['department', 'room', 'session', 'holiday', 'roster', 'test', 'item', 'tariff', 'payer', 'package', 'packageRate', 'letterhead', 'feature', 'homeDefault'];
const doctorRead = ['patient', 'visit', 'presence', 'availability', 'history', 'allergy', 'document', 'vital', 'note', 'rx', 'order', 'sample', 'result', 'review', 'followup', 'referral', 'admission', 'bed', 'operation', 'round', 'wardOrder', 'administration', 'nursing', 'discharge', 'question', 'video', 'abha', 'help', 'article', 'set', 'template', 'signin', 'message', 'certificate', 'coding', 'correction', 'jobRun', 'announcement', 'handover'];
const adminRead = ['account', 'access', 'correction', 'device', 'department', 'room', 'session', 'holiday', 'roster', 'jobRun', 'set', 'template', 'letterhead', 'routing', 'wording', 'feature', 'announcement', 'help', 'article', 'roleApproval', 'import', 'integration', 'test', 'item', 'handover', 'homeDefault'];
export function covers(actor: Actor, doctorId?: string) {
  return actor.id === doctorId || (actor.role === 'resident' && text(actor.preferences, 'coverDoctor') === doctorId);
}
export function slotsFor(store: Store, doctorId: string, date: string, actor: Actor, excludeVisitId = ''): Data[] {
  const person = store.person(doctorId);
  requireThat(person.role === 'doctor' && person.state === 'Active', 'Choose an active consultant.');
  const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
  const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const holiday = store.all('holiday').some(e => text(e.data, 'date') === date);
  const availability = store.all('availability').filter(e => e.doctorId === doctorId && e.status === 'Approved' && text(e.data, 'date') <= date && text(e.data, 'endDate') >= date);
  const visits = store.all('visit').filter(e => e.id !== excludeVisitId && e.doctorId === doctorId && text(e.data, 'date') === date && e.status !== 'Cancelled' && !bool(e.data, 'needsMove'));
  const result: Data[] = [];
  for (const session of store.all('session').filter(e => e.doctorId === doctorId && text(e.data, 'date') === date)) {
    const start = minutes(text(session.data, 'start')); const end = minutes(text(session.data, 'end')); const size = num(session.data, 'slotMinutes', 10);
    const max = end + (hasRole(actor, ['desk', 'manager']) ? size * 3 : 0);
    for (let at = start; at < max; at += size) {
      const time = clock(at); const extra = at >= end;
      const change = availability.find(e => text(e.data, 'kind') === 'Leave' || (text(e.data, 'kind') === 'Late start' && time < text(e.data, 'start')) || (text(e.data, 'kind') === 'Early finish' && time >= text(e.data, 'end')));
      const closed = actor.role === 'patient' && new Date(`${date}T${time}:00+05:30`).getTime() - new Date(store.now()).getTime() < 3600000;
      const booked = visits.some(e => text(e.data, 'time') === time);
      const extraFull = extra && visits.filter(e => bool(e.data, 'extraBooking')).length >= 3;
      result.push({ time, sessionId: session.id, room: text(session.data, 'room'), extra,
        state: holiday || change || closed || extraFull ? 'Blocked' : booked ? 'Booked' : 'Free',
        reason: holiday ? 'Hospital holiday' : change ? `Approved ${text(change.data, 'kind').toLowerCase()}` : closed ? 'Online booking closes one hour before' : extraFull ? 'Three extra bookings already used' : booked ? 'Already booked' : extra ? 'Extra booking requires a reason' : '' });
    }
  }
  return result.filter((entry, index) => result.findIndex(other => other.time === entry.time) === index);
}
export function patientScope(store: Store, actor: Actor): Set<string> {
  if (actor.role === 'patient') return new Set(actor.patientIds);
  if (!doctorRoles.includes(actor.role)) return new Set();
  return new Set(store.all().filter(e =>
    ((['visit', 'admission', 'note', 'rx', 'order', 'result', 'question', 'discharge', 'wardOrder', 'followup'].includes(e.type) && covers(actor, e.doctorId)) ||
     (e.type === 'operation' && text(e.data, 'surgeonId') === actor.id) || (bool(e.data, 'handoverQueue') && text(e.data, 'handoverDepartment') === actor.department) ||
     (e.type === 'referral' && (covers(actor, e.doctorId) || text(e.data, 'receiverId') === actor.id || (!text(e.data, 'receiverId') && e.department === actor.department))))
  ).map(e => e.patientId).filter((x): x is string => Boolean(x)));
}
export function visible(store: Store, actor: Actor, entity: Entity): boolean {
  return actorRoles(actor).some(role => visibleRole(store, { ...actor, role, roles: [role] }, entity));
}
function visibleRole(store: Store, actor: Actor, entity: Entity): boolean {
  if (actor.role === 'auditor') return false;
  if (adminRoles.includes(actor.role)) {
    if (!adminRead.includes(entity.type)) return false;
    if (entity.type === 'set' && text(entity.data, 'scope') === 'Personal') return false;
    if (actor.role === 'it' && !['account', 'device', 'help', 'article', 'integration', 'jobRun'].includes(entity.type)) return false;
    if (actor.role === 'head' && entity.department && entity.department !== actor.department) return false;
    return true;
  }
  if (commonCatalog.includes(entity.type)) return true;
  if (entity.type === 'hospitalDocument' && entity.status === 'Published' && actor.role !== 'patient') return true;
  if (entity.type === 'article' && entity.status === 'Published') return true;
  if (entity.type === 'announcement') return !strings(entity.data, 'dismissedBy').includes(actor.id) && text(entity.data, 'start') <= store.now() && text(entity.data, 'end') > store.now() &&
    (!entity.department || entity.department === actor.department) &&
    (text(entity.data, 'audience') === 'All' || (text(entity.data, 'audience') === 'Doctors' ? doctorRoles.includes(actor.role) : !doctorRoles.includes(actor.role)));
  if (actor.role === 'patient') {
    if (!['patient', 'visit', 'result', 'rx', 'document', 'bill', 'payment', 'discharge', 'abha', 'feedback', 'message', 'packageRun'].includes(entity.type)) return false;
    const pid = entity.type === 'patient' ? entity.id : entity.patientId;
    if (!pid || !actor.patientIds.includes(pid)) return false;
    if (entity.type === 'result') return entity.status === 'Released';
    if (entity.type === 'rx') return entity.status !== 'Draft';
    if (entity.type === 'discharge') return entity.status !== 'Draft';
    if (entity.type === 'document') return entity.status === 'Available' && !['ID proof (not Aadhaar)', 'Scheme card'].includes(text(entity.data, 'kind'));
    return true;
  }
  if (doctorRoles.includes(actor.role)) {
    if (!doctorRead.includes(entity.type)) return false;
    if (entity.type === 'handover') return text(entity.data, 'receiverId') === actor.id || (entity.status === 'Awaiting claim' && entity.department === actor.department);
    if (entity.type === 'referral') return covers(actor, entity.doctorId) || text(entity.data, 'receiverId') === actor.id || (!text(entity.data, 'receiverId') && entity.department === actor.department);
    if (entity.type === 'set') return text(entity.data, 'scope') === 'Personal' ? entity.createdBy === actor.id : entity.department === actor.department;
    if (entity.type === 'template') return entity.department === actor.department;
    if (entity.type === 'presence' || entity.type === 'bed' || entity.type === 'jobRun') return true;
    if (['signin', 'help', 'availability', 'correction'].includes(entity.type)) return entity.createdBy === actor.id;
    if (entity.type === 'result' && entity.status !== 'Released') return false;
    if (entity.type === 'document' && (entity.status !== 'Available' || ['ID proof (not Aadhaar)', 'Scheme card'].includes(text(entity.data, 'kind')))) return false;
    if (entity.patientId || entity.type === 'patient') return patientScope(store, actor).has(entity.type === 'patient' ? entity.id : entity.patientId!);
    return !entity.doctorId || covers(actor, entity.doctorId);
  }
  if (entity.type === 'facility') return actor.role === 'services' || actor.role === 'manager' || entity.createdBy === actor.id;
  if (entity.type === 'document' && actor.role === 'lab') return ['Result', 'Sample label', 'Dispatch manifest'].includes(text(entity.data, 'kind'));
  if (entity.type === 'document' && actor.role === 'pharmacist') return ['Bill', 'Receipt', 'Credit note', 'Paper prescription'].includes(text(entity.data, 'kind'));
  if (entity.type === 'question' && actor.role !== 'manager') return (actor.role === 'pharmacist' && text(entity.data, 'kind') === 'Pharmacy') || (actor.role === 'lab' && text(entity.data, 'kind') === 'Lab') || (actor.role === 'mrd' && text(entity.data, 'kind') === 'Coding') || (actor.role === 'cashier' && text(entity.data, 'kind') === 'Insurance');
  return (staffRead[actor.role] ?? []).includes(entity.type);
}
export function safeEntity(actor: Actor, entity: Entity): Entity {
  const copy = structuredClone(entity);
  delete copy.data.file;
  delete copy.data.codeHash;
  delete copy.data.trackingHash;
  if (entity.type === 'import') delete copy.data.passwords;
  if (adminRoles.includes(actor.role)) {
    if (entity.type === 'help') delete copy.data.detail;
    if (entity.type === 'account' && actor.role === 'it') copy.data = { name: text(copy.data, 'name'), role: text(copy.data, 'role'), staffId: text(copy.data, 'staffId'), phone: text(copy.data, 'phone') };
  }
  return copy;
}
export class Context {
  touched: string[] = [];
  result: Data = {};
  constructor(public store: Store, public actor: Actor, public request: CommandRequest, public target?: Entity) {}
  get p() { return this.request.payload; }
  t(key: string, fallback = '') { return text(this.p, key, fallback); }
  n(key: string, fallback = 0) { return num(this.p, key, fallback); }
  b(key: string) { return bool(this.p, key); }
  now() { return this.store.now(); }
  get(id: string, type?: string) { return this.store.get(id, type); }
  all(type: string) { return this.store.all(type); }
  create(type: string, data: Data, status = 'Open', extra: Partial<Entity> = {}) {
    const entity = this.store.create(type, data, this.actor.id, { status, ...extra });
    this.touched.push(entity.id); return entity;
  }
  update(entity: Entity, data: Data = {}, status = entity.status) {
    const changed = this.store.update(entity, this.actor.id, data, status);
    this.touched.push(changed.id); return changed;
  }
  targetOf(type: string) {
    requireThat(this.target?.type === type, `Choose a ${type} item.`);
    return this.target;
  }
  patient(id = this.t('patientId')) {
    const p = this.get(id, 'patient');
    requireThat(p.status === 'Active', 'This patient record was merged. Open the verified record instead.');
    if (doctorRoles.includes(this.actor.role)) requireThat(patientScope(this.store, this.actor).has(id), 'This patient is outside your care scope.', 'ACCESS_DENIED');
    if (this.actor.role === 'patient') requireThat(this.actor.patientIds.includes(id), 'This patient is not linked to your family account.', 'ACCESS_DENIED');
    return p;
  }
  clinical(entity: Entity, allowClosed = false) {
    requireThat(doctorRoles.includes(this.actor.role) && (covers(this.actor, entity.doctorId) || (entity.type === 'operation' && text(entity.data, 'surgeonId') === this.actor.id)), 'Only the treating, assigned surgeon or covering doctor can change this work.', 'ACCESS_DENIED');
    if (!allowClosed && entity.type === 'visit') requireThat(['Waiting', 'Called', 'In consultation', 'Held'].includes(entity.status), 'The visit is closed or not checked in. Open an active visit first.');
    if (!allowClosed && entity.type === 'admission') requireThat(entity.status === 'Admitted', 'This admission is not active.');
    return entity;
  }
  visit() { return this.clinical(this.get(this.t('visitId'), 'visit')); }
  admission() {
    const admission = this.get(this.t('admissionId'), 'admission');
    requireThat(admission.status === 'Admitted', 'Choose an active admission.');
    if (doctorRoles.includes(this.actor.role)) this.clinical(admission);
    return admission;
  }
  feature(name: string) {
    const config = this.all('feature').find(e => e.department === this.actor.department && text(e.data, 'feature') === name);
    const allowed = !config || text(config.data, 'state') === 'On' || (text(config.data, 'state') === 'Pilot' && text(config.data, 'pilotDoctors').split(',').map(x => x.trim()).includes(this.actor.id));
    requireThat(allowed, `${name} is disabled for this department. Your local draft is kept.`);
  }
  message(patientId: string, template: string, sourceId: string, channel = 'SMS', audience?: string) {
    const patient = this.get(patientId, 'patient');
    const preference = this.all('updates').find(e => e.patientId === patientId);
    if (audience && preference && preference.data[audience] === false) return;
    const existing = this.all('message').find(e => text(e.data, 'sourceId') === sourceId && text(e.data, 'template') === template && text(e.data, 'channel') === channel);
    if (existing) return existing;
    const failed = this.store.setting<Data>('faults', {}).provider === 'Failure';
    return this.create('message', { name: `${template} (${channel})`, sourceId, template, channel, mobile: `******${text(patient.data, 'mobile').slice(-4)}`, simulated: true, attempts: [{ at: this.now(), status: failed ? 'Failed' : 'Delivered', reason: failed ? 'Simulated provider unavailable. Retry or print.' : 'Simulated receipt only' }] }, failed ? 'Failed' : 'Delivered', { patientId, doctorId: this.actor.role === 'doctor' ? this.actor.id : undefined });
  }
  bill(patientId: string, name: string, lines: Data[], sourceId: string, admissionId = '') {
    const existing = this.all('bill').find(e => text(e.data, 'sourceId') === sourceId);
    if (existing) return existing;
    const financialYear = Number(istDate(this.now()).slice(5, 7)) < 4 ? Number(istDate(this.now()).slice(0, 4)) - 1 : Number(istDate(this.now()).slice(0, 4));
    const count = this.store.setting<number>(`billSequence:${financialYear}`, 0) + 1;
    this.store.set(`billSequence:${financialYear}`, count);
    const total = lines.reduce((sum, line) => sum + num(line, 'total'), 0);
    requireThat(Number.isSafeInteger(total) && total >= 0, 'Bill amounts are invalid. Review the tariff.');
    return this.create('bill', { name, number: `SAMPLE-${financialYear}-${String(count).padStart(6, '0')}`, sourceId, admissionId, lines, subtotal: total, total, paid: 0, discount: 0, counter: this.actor.counter, payer: text(this.get(patientId).data, 'payer'), discountStatus: 'None', final: false }, total === 0 ? 'Paid' : 'Unpaid', { patientId });
  }
  charge(patientId: string, name: string, total: number, sourceId: string, extra: Data = {}, admissionId = '') {
    return this.bill(patientId, name, [{ id: randomUUID(), name, quantity: 1, total, ...extra }], sourceId, admissionId);
  }
  tariff(code: string, payer = 'Self') {
    const today = istDate(this.now());
    const eligible = this.all('tariff').filter(e => text(e.data, 'code') === code && text(e.data, 'effective') <= today && e.status === 'Active');
    const list = eligible.filter(e => text(e.data, 'payer') === payer);
    requireThat(list.length, `No active ${payer} tariff is available for this service. Ask the billing master owner; a price was not guessed.`);
    return list.sort((x, y) => text(y.data, 'effective').localeCompare(text(x.data, 'effective')))[0];
  }
  approval(kind: string, targetId: string, data: Data, reason: string, amount = 0) {
    requireThat(!this.all('approval').some(e => e.status === 'Pending' && text(e.data, 'kind') === kind && text(e.data, 'targetId') === targetId), 'This item already has a pending approval.');
    return this.create('approval', { name: `${kind} approval`, kind, targetId, requestedBy: this.actor.id, amount, reason, effect: data }, 'Pending');
  }
  book(patientId: string, doctorId: string, date: string, time: string, extra: Data = {}, excluding?: string) {
    this.patient(patientId);
    const doc = this.store.person(doctorId);
    requireThat(doc.role === 'doctor' && doc.state === 'Active', 'Choose an active consultant.');
    requireThat(!this.all('holiday').some(e => text(e.data, 'date') === date), 'This date is a hospital holiday. Choose another day.');
    const leave = this.all('availability').some(e => e.doctorId === doctorId && e.status === 'Approved' && text(e.data, 'date') <= date && text(e.data, 'endDate') >= date && text(e.data, 'kind') === 'Leave');
    requireThat(!leave, 'This doctor is on approved leave. Choose another session.');
    const slot = slotsFor(this.store, doctorId, date, this.actor, excluding).find(slot => slot.time === time);
    requireThat(slot, 'This time is outside published slot intervals. Choose a listed free slot.');
    requireThat(slot.state !== 'Booked', 'This slot was just taken. Please pick another.', 'SLOT_TAKEN');
    requireThat(slot.state === 'Free', text(slot, 'reason') || 'This slot is blocked. Choose another.');
    requireThat(!slot.extra || text(extra, 'extraReason').trim().length >= 5, 'An extra booking requires a reason. No more than three are allowed per session.');
    if (extra.mode === 'Video') {
      const feature = this.all('feature').find(e => e.department === doc.department && text(e.data, 'feature') === 'Video');
      requireThat(!feature || text(feature.data, 'state') === 'On' || (text(feature.data, 'state') === 'Pilot' && text(feature.data, 'pilotDoctors').includes(doc.id)), 'Video consultations are unavailable for this doctor.');
    }
    return { department: doc.department, room: text(slot, 'room'), extraBooking: Boolean(slot.extra) };
  }
}
export function notifications(store: Store, actor: Actor, entities: Entity[]) {
  const output: Snapshot['notifications'] = [];
  if (doctorRoles.includes(actor.role)) {
    for (const e of entities) {
      if (e.type === 'referral' && (text(e.data, 'receiverId') === actor.id || (!text(e.data, 'receiverId') && e.department === actor.department)) && ['Sent', 'Seen'].includes(e.status)) {
        const wording = store.all('wording').find(e => text(e.data, 'kind') === 'Referral');
        const content = (wording ? text(wording.data, 'unlocked') : '{doctor} referred {patient} to you').replaceAll('{doctor}', store.person(text(e.data, 'senderId') || e.createdBy).name).replaceAll('{patient}', text(store.get(e.patientId!).data, 'name'));
        output.push({ id: e.id, text: content, href: 'DJ21', critical: text(e.data, 'urgency') !== 'Routine' });
      }
      if (e.type === 'result' && e.status === 'Released' && covers(actor, e.doctorId) && !store.all('review').some(r => text(r.data, 'resultId') === e.id && num(r.data, 'resultVersion') === num(e.data, 'reportVersion', 1))) output.push({ id: e.id, text: `${text(e.data, 'flag')} result needs review`, href: 'DJ20', critical: text(e.data, 'flag') === 'Critical' });
      if (e.type === 'question' && e.status === 'Open' && covers(actor, e.doctorId)) output.push({ id: e.id, text: `${text(e.data, 'kind')} question waiting`, href: 'DJ22', critical: false });
      if (e.type === 'followup' && ['Booked', 'Declined'].includes(e.status) && !text(e.data, 'responseSeenAt') && covers(actor, e.doctorId)) output.push({ id: e.id, text: `Front desk ${e.status.toLowerCase()} a follow-up request`, href: 'DJ12', critical: false });
      if (e.type === 'vital' && num(e.data, 'spo2', 100) < 90 && !bool(e.data, 'alertReviewed') && covers(actor, e.doctorId)) output.push({ id: e.id, text: 'Ward reading needs attention', href: 'DJ18', critical: true });
      if (e.type === 'handover' && e.status === 'Awaiting claim' && e.department === actor.department) output.push({ id: e.id, text: 'Department handover needs a receiving consultant', href: 'DJ03', critical: false });
      if (e.type === 'operation' && e.status === 'Offered' && (covers(actor, e.doctorId) || text(e.data, 'surgeonId') === actor.id)) output.push({ id: e.id, text: text(e.data, 'slotChangeReason') ? `OT slot changed: ${text(e.data, 'slotChangeReason')}` : 'OT coordinator offered an operation slot', href: 'DJ14', critical: text(e.data, 'urgency') === 'Emergency' });
    }
  }
  return output;
}
