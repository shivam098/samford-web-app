import { actorRoles, roles, staffRoles, type Actor } from '../shared/model.js';
import { schemaVersion } from '../shared/version.js';
import { credential } from './auth.js';
import { payerNames } from '../shared/finance.js';
import { text, num } from '../shared/model.js';
import { Store, requireThat } from './store.js';

export function migrate(store: Store) {
  const current = store.setting<number>('schemaVersion', 1);
  requireThat(current <= schemaVersion, 'This database belongs to a newer app version. Keep it intact and start that version.');
  if (current === schemaVersion) return;
  store.transact(() => {
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
    store.set('schemaVersion', schemaVersion);
    store.audit('System', 'system', 'schema.migrate', 'v2', { version: current }, { version: schemaVersion, accountRoleMetadataUpdated: updated, payerDemoRatesAdded: payerRatesAdded, historicalClinicalAndFinancialRecordsRewritten: 0 });
  });
}
