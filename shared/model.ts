export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type Data = { [key: string]: Json };
export const roles = [
  'doctor', 'resident', 'superadmin', 'admin', 'head', 'it', 'auditor',
  'desk', 'cashier', 'pharmacist', 'store', 'nurse', 'lab', 'ot', 'mrd',
  'services', 'manager', 'patient'
] as const;
export type Role = typeof roles[number];
export const roleNames: Record<Role, string> = {
  doctor: 'Consultant', resident: 'Resident', superadmin: 'Super admin',
  admin: 'Hospital admin', head: 'Department head (read-only)', it: 'IT support',
  auditor: 'Auditor', desk: 'Front desk', cashier: 'Cashier', pharmacist: 'Pharmacist',
  store: 'Store keeper', nurse: 'Ward nurse', lab: 'Lab technician / verifier',
  ot: 'OT coordinator', mrd: 'Medical records', services: 'Support services',
  manager: 'Operations manager', patient: 'Patient'
};
export const adminRoles: Role[] = ['superadmin', 'admin', 'head', 'it', 'auditor'];
export const doctorRoles: Role[] = ['doctor', 'resident'];
export const staffRoles: Role[] = ['desk', 'cashier', 'pharmacist', 'store', 'nurse', 'lab', 'ot', 'mrd', 'services', 'manager'];
export type Entity = {
  id: string; type: string; version: number; status: string;
  createdAt: string; updatedAt: string; createdBy: string; updatedBy: string;
  patientId?: string; doctorId?: string; department?: string; data: Data;
};
export type Actor = {
  id: string; name: string; role: Role; department: string; state: string;
  roles?: Role[];
  login: string; staffId: string; mobile: string; patientIds: string[];
  verifier: boolean; profileConfirmed: boolean; temporary: boolean;
  counter: string; appVersion: number; preferences: Data;
};
export type FieldKind = 'text' | 'textarea' | 'number' | 'date' | 'datetime' | 'time' | 'select' | 'boolean' | 'entity' | 'medicines' | 'tests' | 'payments' | 'checklist' | 'file' | 'csv' | 'password' | 'homeLayout' | 'handovers' | 'payerRates' | 'denominations';
export type Field = {
  key: string; label: string; kind: FieldKind; required?: boolean;
  options?: string[]; source?: string; states?: string[]; min?: number; max?: number;
  default?: Json; help?: string; clinical?: boolean;
  hidden?: boolean;
  crossPatient?: boolean;
};
export type CommandDef = {
  name: string; label: string; journeys: string[]; roles: Role[];
  target?: string; from?: string[]; fields: Field[]; help: string;
  confirm?: string; local?: boolean;
};
export type Journey = {
  id: string; title: string; group: string; roles: Role[];
  collection: string[]; description: string; boundary?: string;
};
export type CommandRequest = {
  operationId: string; actorId: string; targetId?: string; expectedVersion?: number;
  actingRole?: Role;
  createdAt: string; payload: Data; deviceId: string;
  contextVersions?: Record<string, number>;
};
export type Receipt = {
  operationId: string; acceptedAt: string; entityIds: string[];
  message: string; data?: Data; replayed?: boolean;
};
export type ApiError = { message: string; code: string; retryable: boolean; current?: Entity; reference?: string };
export type Snapshot = {
  actor: Actor; entities: Entity[]; people: Actor[]; now: string;
  revision: number; notifications: { id: string; text: string; href: string; critical: boolean }[];
  summary: Data; settings: Data; faults: Data;
};
export const text = (data: Data, key: string, fallback = ''): string => typeof data[key] === 'string' ? data[key] : fallback;
export const num = (data: Data, key: string, fallback = 0): number => typeof data[key] === 'number' ? data[key] : fallback;
export const bool = (data: Data, key: string): boolean => data[key] === true;
export const rows = (data: Data, key: string): Data[] => Array.isArray(data[key]) ? data[key].filter((v): v is Data => v !== null && typeof v === 'object' && !Array.isArray(v)) : [];
export const strings = (data: Data, key: string): string[] => Array.isArray(data[key]) ? data[key].filter((v): v is string => typeof v === 'string') : [];
export const label = (entity: Entity): string => text(entity.data, 'name') || text(entity.data, 'title') || text(entity.data, 'number') || `${entity.type} ${entity.id.slice(-6)}`;
export const istDate = (time = new Date().toISOString()): string => new Date(new Date(time).getTime() + 330 * 60000).toISOString().slice(0, 10);
export const currency = (paise: number): string => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);
export const reportKinds: Partial<Record<Role, string[]>> = {
  superadmin: ['activity', 'referrals', 'orders', 'critical', 'sync', 'accounts'],
  admin: ['activity', 'referrals', 'orders', 'critical', 'sync', 'accounts'],
  head: ['activity', 'referrals', 'orders', 'critical', 'sync'],
  it: ['sync'], doctor: ['activity'], resident: ['activity'],
  manager: ['census', 'collections', 'claims', 'day-end', 'diseases', 'demography', 'pharmacy', 'lab', 'inventory'],
  cashier: ['collections', 'claims', 'day-end'], pharmacist: ['pharmacy', 'day-end'], store: ['inventory'], lab: ['lab'], mrd: ['diseases'], desk: ['day-end']
};
export function featureEnabled(snapshot: Snapshot, feature: string) {
  const flag = snapshot.entities.find(e => e.type === 'feature' && e.department === snapshot.actor.department && text(e.data, 'feature') === feature);
  return !flag || text(flag.data, 'state') === 'On' || (text(flag.data, 'state') === 'Pilot' && text(flag.data, 'pilotDoctors').split(',').map(s => s.trim()).includes(snapshot.actor.id));
}
export const documentKinds: Partial<Record<Role, string[]>> = {
  desk: ['OPD slip', 'ID card', 'Admission form', 'Wristband', 'Gate pass', 'Consent form'],
  cashier: ['Receipt', 'Bill', 'Gate pass', 'Credit note'], pharmacist: ['Bill', 'Receipt', 'Credit note'],
  nurse: ['Discharge summary', 'ID card', 'OPD slip', 'Admission form', 'Wristband', 'Gate pass', 'Consent form'],
  manager: ['Receipt', 'Bill', 'ID card', 'OPD slip', 'Admission form', 'Wristband', 'Gate pass', 'Credit note'],
  lab: ['Result', 'Sample label', 'Dispatch manifest'],
  patient: ['Prescription', 'OPD slip', 'ID card', 'Receipt', 'Bill', 'Result', 'Discharge summary', 'Credit note']
};
export function actorRoles(actor: Pick<Actor, 'role' | 'roles'>): Role[] {
  if (!staffRoles.includes(actor.role)) return [actor.role];
  return [...new Set([actor.role, ...(actor.roles ?? [])].filter(role => staffRoles.includes(role)))];
}
export function hasRole(actor: Pick<Actor, 'role' | 'roles'>, allowed: readonly Role[]) {
  return actorRoles(actor).some(role => allowed.includes(role));
}
export function roleLabel(actor: Pick<Actor, 'role' | 'roles'>) { return actorRoles(actor).map(role => roleNames[role]).join(' + '); }
export function actorReportKinds(actor: Actor) { return [...new Set(actorRoles(actor).flatMap(role => reportKinds[role] ?? []))]; }
export function actorDocumentKinds(actor: Actor): string[] | undefined {
  if (doctorRoles.includes(actor.role)) return undefined;
  return [...new Set(actorRoles(actor).flatMap(role => documentKinds[role] ?? []))];
}
