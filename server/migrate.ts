import { actorRoles, roles, staffRoles, type Actor, type Role } from '../shared/model.js';
import { schemaVersion } from '../shared/version.js';
import { credential } from './auth.js';
import { payerNames } from '../shared/finance.js';
import { text, num } from '../shared/model.js';
import { Store, requireThat } from './store.js';
import { seedHandwritingHistory } from './history.js';

function migrateToV2(store: Store, from: number) {
  let updated = 0;
  for (const actor of store.people()) {
    requireThat(roles.includes(actor.role), 'An account has an unsupported role. Migration stopped without changing records.');
    if (actor.roles) requireThat(actor.roles.every(role => staffRoles.includes(actor.role) ? staffRoles.includes(role) : role === actor.role), 'An account has an unsupported role combination. Migration stopped without changing records.');
    actor.roles = actorRoles(actor);
    store.savePerson(actor);
    store.update(store.get(actor.id, 'account'), 'System', { roles: actor.roles });
    updated++;
  }
  if (!store.people().some(actor => actor.id === 'desk-cashier')) {
    const person: Actor = { id: 'desk-cashier', name: 'Demo front desk and cashier', role: 'desk', roles: ['desk', 'cashier'], department: 'general',
      state: 'Active', login: 'desk-cashier', staffId: 'SAMPLE-DESK-CASHIER', mobile: '9000010099', patientIds: [], verifier: false,
      profileConfirmed: true, temporary: false, counter: 'OPD 1', appVersion: 1, preferences: {} };
    store.savePerson(person, credential());
    store.create('account', { name: person.name, role: person.role, roles: person.roles!, departmentId: person.department, staffId: person.staffId }, 'System', { id: person.id, status: 'Active', department: person.department });
  }
  if (!store.all('package').some(entity => entity.id === 'scheme-ayushman-admission')) {
    store.create('package', { name: 'Synthetic Ayushman admission package', kind: 'Scheme treatment', tests: [], price: 1000000,
      payerRates: { Ayushman: 1000000, CGHS: 1200000 }, coveredTypes: ['Bed', 'Consultation', 'Pharmacy', 'Laboratory', 'Procedure'], effective: '2020-01-01', demoAssumption: true },
    'System', { id: 'scheme-ayushman-admission', status: 'Active' });
  }
  let payerRatesAdded = 0;
  for (const tariff of store.all('tariff').filter(entity => text(entity.data, 'payer') === 'Self' && entity.status === 'Active')) {
    for (const payer of payerNames.filter(name => name !== 'Self')) {
      if (store.all('tariff').some(entry => text(entry.data, 'code') === text(tariff.data, 'code') && text(entry.data, 'payer') === payer)) continue;
      store.create('tariff', { ...tariff.data, payer, rate: Math.round(num(tariff.data, 'rate') * (payer === 'CGHS' ? 0.8 : 1)), demoAssumption: true, sourceTariffId: tariff.id }, 'System', { status: 'Active' });
      payerRatesAdded++;
    }
  }
  store.audit('System', 'system', 'schema.migrate', 'v2', { version: from }, { version: 2, accountRoleMetadataUpdated: updated, payerDemoRatesAdded: payerRatesAdded, historicalClinicalAndFinancialRecordsRewritten: 0 });
}
type NewPersona = Pick<Actor, 'id' | 'name' | 'role' | 'roles' | 'labIds' | 'department' | 'staffId' | 'mobile' | 'verifier' | 'counter'>;
function addPersona(store: Store, actor: NewPersona, account: Record<string, string>) {
  if (store.db.prepare('SELECT id FROM users WHERE id=?').get(actor.id) || store.maybe(actor.id)) return false;
  const person: Actor = { ...actor, state: 'Active', login: actor.id, patientIds: [], profileConfirmed: true, temporary: false, appVersion: 1,
    preferences: { theme: 'Light', language: 'English', textSize: '100%', printLanguage: 'English', rows: 5, homeOrder: 'visits,referrals,results,admissions,pending', sort: 'Token' } };
  store.savePerson(person, credential());
  store.create('account', { name: person.name, role: person.role, roles: person.roles ?? [person.role], departmentId: person.department, staffId: person.staffId, phone: person.mobile, email: `${person.id}@sample.invalid`, ...account },
    'System', { id: person.id, status: 'Active', department: person.department });
  return true;
}
// v3 adds the paperless OPD mock: lab units, lab assignments, two personas and seeded handwritten history. Existing records are not rewritten.
function migrateToV3(store: Store, from: number) {
  let labUnitsAdded = 0;
  for (const [labId, name, kind] of [['central-lab', 'Central pathology lab', 'PATHOLOGY'], ['radiology', 'Radiology', 'IMAGING']]) {
    if (store.maybe(`labunit-${labId}`)) continue;
    store.create('labUnit', { labId, name, kind, demoAssumption: true }, 'System', { id: `labunit-${labId}`, status: 'Active' });
    labUnitsAdded++;
  }
  const personas: string[] = [];
  if (addPersona(store, { id: 'doctor-c', name: 'Demo doctor C', role: 'doctor', roles: ['doctor'] as Role[], department: 'general', staffId: 'SAMPLE-DOCTOR-C', mobile: '9000010201', verifier: false, counter: 'OPD 1' },
    { registration: 'SAMPLE-REG-doctor-c', qualification: 'Sample qualification', room: 'Room 3' })) {
    store.create('presence', { name: 'Demo doctor C', status: 'Offline', reportedAt: store.now(), systemReset: '' }, 'System', { id: 'presence-doctor-c', status: 'Offline', doctorId: 'doctor-c', department: 'general' });
    personas.push('doctor-c');
  }
  if (addPersona(store, { id: 'radiology', name: 'Demo radiology technician', role: 'lab', roles: ['lab'] as Role[], labIds: ['radiology'], department: 'general', staffId: 'SAMPLE-RADIOLOGY', mobile: '9000010202', verifier: false, counter: 'Laboratory' },
    { registration: '', qualification: 'Sample qualification' })) personas.push('radiology');
  let labAssignments = 0;
  for (const [id, labIds] of [['lab', ['central-lab']], ['verifier', ['central-lab', 'radiology']]] as [string, string[]][]) {
    const row = store.db.prepare('SELECT body FROM users WHERE id=?').get(id);
    if (!row) continue;
    const person = JSON.parse(String(row.body)) as Actor;
    if (person.role !== 'lab' || person.labIds?.length) continue;
    person.labIds = labIds; store.savePerson(person); labAssignments++;
  }
  if (!store.setting<Record<string, number> | null>('mobileMinVersions', null)) store.set('mobileMinVersions', { doctor: 1, patient: 1 });
  const history = seedHandwritingHistory(store);
  store.audit('System', 'system', 'schema.migrate', 'v3', { version: from }, { version: 3, labUnitsAdded, personasAdded: personas, labAssignments, ...history, historicalClinicalAndFinancialRecordsRewritten: 0 });
}
export const migrationSteps = { migrateToV2, migrateToV3 };
export function migrate(store: Store) {
  const current = store.setting<number>('schemaVersion', 1);
  requireThat(current <= schemaVersion, 'This database belongs to a newer app version. Keep it intact and start that version.');
  if (current === schemaVersion) return;
  store.transact(() => {
    if (current < 2) migrateToV2(store, current);
    if (current < 3) migrateToV3(store, Math.max(current, 2));
    store.set('schemaVersion', schemaVersion);
  });
}
