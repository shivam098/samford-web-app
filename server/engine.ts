import { createHash } from 'node:crypto';
import { commandByName } from '../shared/commands.js';
import { text, actorRoles, doctorRoles, documentKinds, type Actor, type Entity, type Field, type CommandRequest, type Receipt } from '../shared/model.js';
import { Store, DomainError, requireThat } from './store.js';
import { Context, visible, safeEntity } from './context.js';
import { clinicalCommand } from './clinical.js';
import { adminCommand } from './admin.js';
import { commerceCommand } from './commerce.js';
import { careCommand } from './care.js';
import { servicesCommand } from './services.js';
import { documentCommand } from './documents.js';

function validateField(field: Field, value: unknown) {
  const empty = value === undefined || value === null || value === '';
  if (empty && !field.required) return;
  requireThat(!empty, `${field.label} is required.`);
  switch (field.kind) {
    case 'boolean': requireThat(typeof value === 'boolean' && (!field.required || value), `Confirm: ${field.label}.`); break;
    case 'number':
      requireThat(typeof value === 'number' && Number.isFinite(value), `${field.label} must be a number.`);
      requireThat((field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max), `${field.label} must be between ${field.min ?? 'the allowed minimum'} and ${field.max ?? 'the allowed maximum'}.`); break;
    case 'medicines':
    case 'payments':
    case 'handovers':
      requireThat(Array.isArray(value) && value.every(v => v && typeof v === 'object' && !Array.isArray(v)) && (!field.required || value.length > 0) && value.length <= 50, `Add valid ${field.label.toLowerCase()} rows.`); break;
    case 'homeLayout':
    case 'payerRates':
      requireThat(value && typeof value === 'object' && !Array.isArray(value), `${field.label} must be a structured object.`); break;
    case 'denominations':
      requireThat(typeof value === 'string' || (value && typeof value === 'object' && !Array.isArray(value)), 'Provide denomination counts.'); break;
    case 'tests':
    case 'checklist':
      requireThat(Array.isArray(value) && value.every(v => typeof v === 'string') && (!field.required || value.length > 0) && value.length <= 50, `Choose valid ${field.label.toLowerCase()}.`);
      if (field.options) requireThat(value.every(v => field.options!.includes(v)), `Choose listed ${field.label.toLowerCase()}.`); break;
    case 'file':
      requireThat(value && typeof value === 'object' && !Array.isArray(value), 'Choose a file.'); break;
    default:
      requireThat(typeof value === 'string' && value.length <= (field.kind === 'csv' ? 1000000 : 16000), `${field.label} must be text within the allowed length.`);
      if (field.required) requireThat(value.trim().length > 0, `${field.label} is required.`);
      if (field.options) requireThat(field.options.includes(value), `Choose a listed value for ${field.label}.`);
      if (field.kind === 'date') requireThat(/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, `${field.label} must be a valid calendar date.`);
      if (field.kind === 'datetime') requireThat(!Number.isNaN(Date.parse(value)), `${field.label} must be a date and time.`);
      if (field.kind === 'time') requireThat(/^([01]\d|2[0-3]):[0-5]\d$/.test(value), `${field.label} must be a valid time.`);
  }
}
const clinicalTypes = new Set(['patient', 'visit', 'history', 'allergy', 'vital', 'note', 'rx', 'order', 'sample', 'result', 'review', 'referral', 'admission', 'wardOrder', 'discharge', 'round', 'nursing', 'administration', 'question', 'document', 'abha', 'mortuary', 'consent', 'certificate', 'coding', 'claim', 'bill', 'payment', 'refund', 'dispense', 'return', 'packageRun']);
export function auditSafe(entity: Entity | undefined): unknown {
  if (!entity) return null;
  if (clinicalTypes.has(entity.type)) return { id: entity.id, type: entity.type, version: entity.version, status: entity.status, patientId: entity.patientId, doctorId: entity.doctorId, department: entity.department };
  const data = structuredClone(entity.data);
  for (const key of ['file', 'codeHash', 'trackingHash', 'csv', 'rows', 'detail', 'password', 'temporaryPassword']) delete data[key];
  return { id: entity.id, type: entity.type, version: entity.version, status: entity.status, data };
}
export function anchorFor(store: Store, name: string, request: CommandRequest): Entity | undefined {
  const command = commandByName[name];
  if (command?.target) return store.get(request.targetId ?? '', command.target);
  for (const key of ['visitId', 'admissionId', 'patientId']) if (text(request.payload, key)) return store.get(text(request.payload, key), key.slice(0, -2));
  return undefined;
}
export function execute(store: Store, actor: Actor, name: string, request: CommandRequest): Receipt {
  const def = commandByName[name];
  if (!def) throw new DomainError(404, 'UNKNOWN_COMMAND', 'This action is unavailable. Refresh the app.');
  const permitted = actorRoles(actor).filter(role => def.roles.includes(role) &&
    (name !== 'document.generate' || doctorRoles.includes(role) || documentKinds[role]?.includes(text(request.payload, 'kind'))));
  if (!permitted.length) throw new DomainError(403, 'ROLE_DENIED', 'Your assigned roles cannot perform this action. Sign in as the responsible demo identity.');
  if (request.actingRole && !permitted.includes(request.actingRole)) throw new DomainError(403, 'ROLE_DENIED', 'That acting role is not assigned or cannot perform this action.');
  const effectiveRole = request.actingRole ?? (permitted.includes(actor.role) ? actor.role : permitted[0]);
  requireThat(actor.state === 'Active' && !actor.temporary && actor.profileConfirmed, 'Complete sign-in and profile confirmation first.');
  requireThat(request && typeof request.operationId === 'string' && /^[a-zA-Z0-9_-]{12,100}$/.test(request.operationId), 'A valid operation ID is required.');
  requireThat(Object.keys(request).every(key => ['operationId', 'actorId', 'actingRole', 'targetId', 'expectedVersion', 'createdAt', 'deviceId', 'payload', 'contextVersions'].includes(key)), 'Unexpected request envelope field. Use the published API contract.');
  requireThat(request.actorId === actor.id, 'This saved action belongs to a different persona. Sign in as the original author; it was not reassigned.', 'ACTOR_MISMATCH');
  requireThat(request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload), 'A structured action payload is required.');
  requireThat(typeof request.createdAt === 'string' && !Number.isNaN(Date.parse(request.createdAt)), 'The local save time is invalid.');
  requireThat(typeof request.deviceId === 'string' && request.deviceId.length <= 120, 'A device identity is required.');
  const digest = createHash('sha256').update(JSON.stringify({ name, ...request })).digest('hex');
  const saved = store.receipt(actor.id, request.operationId);
  if (saved) {
    if (saved.hash !== digest) throw new DomainError(409, 'IDEMPOTENCY_MISMATCH', 'This operation ID was already used with different content. Review and create a new action.');
    return { ...saved.receipt, replayed: true };
  }
  const known = new Set(def.fields.map(field => field.key));
  for (const key of Object.keys(request.payload)) requireThat(known.has(key), `Unexpected field "${key}". Refresh the form and try again.`);
  for (const field of def.fields) validateField(field, request.payload[field.key]);
  const anchor = anchorFor(store, name, request);
  if (anchor && !visible(store, actor, anchor)) throw new DomainError(404, 'NOT_FOUND', 'This item is outside your current scope or no longer available.');
  if (anchor) {
    requireThat(Number.isInteger(request.expectedVersion), 'The current record version is required. Refresh before sending.');
    if (request.expectedVersion !== anchor.version) throw new DomainError(409, 'VERSION_CONFLICT', 'Someone else changed this record. Compare your saved action with the hospital version; no overwrite was applied.', safeEntity(actor, anchor));
  }
  if (def.from && anchor) requireThat(def.from.includes(anchor.status), `This action is not available while the item is ${anchor.status}. Refresh and choose the next valid step.`, 'INVALID_TRANSITION');
  for (const field of def.fields.filter(f => f.kind === 'entity' && request.payload[f.key])) {
    const id = text(request.payload, field.key);
    if (['doctor', 'staff'].includes(field.source ?? '')) {
      const person = store.person(id);
      requireThat(person.state === 'Active', `${field.label} is not active.`);
      requireThat(field.source !== 'doctor' || person.role === 'doctor', 'Choose a consultant.');
      requireThat(field.source !== 'staff' || !['doctor', 'resident', 'patient'].includes(person.role), 'Choose a staff member.');
    } else {
      const entity = store.get(id, field.source);
      requireThat(visible(store, actor, entity), `${field.label} is outside your role’s scope.`, 'ACCESS_DENIED');
      if (field.states) requireThat(field.states.includes(entity.status), `Choose ${field.label.toLowerCase()} in an allowed state.`);
    }
  }
  if (request.contextVersions) for (const [id, version] of Object.entries(request.contextVersions)) {
    const entity = store.get(id);
    requireThat(visible(store, actor, entity), 'A context record is outside your scope.', 'ACCESS_DENIED');
    if (entity.version !== version) throw new DomainError(409, 'CONTEXT_CHANGED', 'Patient or prescription context changed while this action was saved. Review the current context before sending a new version.', safeEntity(actor, entity));
  }
  if (name === 'rx.approve' && anchor?.patientId) requireThat(request.contextVersions?.[anchor.patientId] !== undefined, 'Review the current patient allergy context before approving.');
  if (name === 'rx.approve' && anchor) {
    const previous = store.all('rx').find(e => text(e.data, 'visitId') === anchor.id);
    if (previous) requireThat(request.contextVersions?.[previous.id] !== undefined, 'Review the current prescription version before creating an amendment.');
  }
  return store.transact(() => {
    const ctx = new Context(store, { ...actor, role: effectiveRole }, request, def.target ? anchor : undefined);
    const handled = [clinicalCommand, adminCommand, commerceCommand, careCommand, servicesCommand, documentCommand].some(handler => handler(name, ctx));
    if (!handled) throw new DomainError(501, 'NOT_IMPLEMENTED', 'This workflow has not been implemented. No changes were saved.');
    const entities = [...new Set(ctx.touched)].map(id => store.get(id));
    store.audit(actor.id, effectiveRole, name, anchor?.id ?? entities[0]?.id ?? actor.id, auditSafe(anchor), entities.map(auditSafe), text(request.payload, 'reason'));
    const receipt: Receipt = { operationId: request.operationId, acceptedAt: store.now(), entityIds: entities.map(e => e.id), message: `${def.label}: accepted by the mock hospital.`, data: { ...ctx.result, actingRole: effectiveRole, versions: Object.fromEntries(entities.map(e => [e.id, e.version])) } };
    const persisted = structuredClone(receipt);
    if (persisted.data) for (const key of ['temporaryPassword', 'temporarySlips', 'simulatedCode']) if (key in persisted.data) {
      delete persisted.data[key]; persisted.data.oneTimeValue = 'Already shown once. If it was lost, issue a replacement through the appropriate workflow.';
    }
    store.saveReceipt(actor.id, request.operationId, digest, persisted);
    return receipt;
  });
}
