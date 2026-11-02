import { text, num, rows, istDate, doctorRoles, adminRoles, reportKinds, type Actor, type Data, type Entity, type Snapshot } from '../shared/model.js';
import { Store, requireThat } from './store.js';
import { visible, safeEntity, notifications } from './context.js';

export function report(store: Store, actor: Actor, kind: string, from = '', to = '', department = ''): Data[] {
  const allowed = ['superadmin', 'admin', 'head', 'it', 'manager', 'cashier', 'pharmacist', 'store', 'lab', 'mrd', 'doctor', 'resident'];
  requireThat(allowed.includes(actor.role), 'Your role cannot view reports.');
  requireThat(reportKinds[actor.role]?.includes(kind), 'This report is outside your role’s authorized reporting scope.');
  if (actor.role === 'head') department = actor.department;
  if (actor.role === 'it') requireThat(kind === 'sync', 'IT support can view only phone and sync health.');
  const inRange = (e: Entity) => {
    const date = istDate(text(e.data, 'firstDoneAt') || e.createdAt);
    return (!from || date >= from) && (!to || date <= to) && (!department || e.department === department || (e.doctorId && store.person(e.doctorId).department === department));
  };
  const data = store.all().filter(inRange);
  if (kind === 'activity') {
    return store.people().filter(p => doctorRoles.includes(p.role) && (!department || p.department === department) && (!doctorRoles.includes(actor.role) || p.id === actor.id)).map(person => {
      const signins = data.filter(e => e.type === 'signin' && e.createdBy === person.id);
      const days = new Set(signins.map(e => istDate(e.createdAt)));
      const firstTimes = [...days].map(day => signins.filter(e => istDate(e.createdAt) === day).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0].createdAt);
      const avgMinutes = firstTimes.length ? Math.round(firstTimes.map(time => {
        const parts = new Date(new Date(time).getTime() + 330 * 60000).toISOString(); return Number(parts.slice(11, 13)) * 60 + Number(parts.slice(14, 16));
      }).reduce((a, b) => a + b, 0) / firstTimes.length) : 0;
      const visits = data.filter(e => e.type === 'visit' && e.doctorId === person.id && e.status === 'Done');
      return { doctor: person.name, doctorId: person.id, department: person.department, signInDays: days.size,
        averageFirstSignIn: firstTimes.length ? `${String(Math.floor(avgMinutes / 60)).padStart(2, '0')}:${String(avgMinutes % 60).padStart(2, '0')} IST` : 'No sign-in',
        lastActivity: data.filter(e => e.updatedBy === person.id).map(e => e.updatedAt).sort().at(-1) ?? '',
        patientsAttended: visits.length, prescriptions: data.filter(e => e.type === 'rx' && e.doctorId === person.id && e.status !== 'Draft').length,
        referralsSent: data.filter(e => e.type === 'referral' && e.doctorId === person.id).length,
        referralsReceived: data.filter(e => e.type === 'referral' && text(e.data, 'receiverId') === person.id).length,
        calendar: [...days].map(day => ({ date: day, firstSignIn: firstTimes.find(time => istDate(time) === day) ?? '', done: visits.filter(e => istDate(text(e.data, 'firstDoneAt')) === day).length })),
        note: 'App activity, not attendance.', receivedUpTo: store.now() };
    });
  }
  if (kind === 'sync') return store.all('device').filter(e => !department || e.department === department).map(e => ({ device: text(e.data, 'name'), actor: text(e.data, 'actorId'), appVersion: num(e.data, 'appVersion'), unsent: num(e.data, 'unsent'), lastSync: text(e.data, 'lastSync'), state: e.status }));
  if (kind === 'demography') {
    requireThat(actor.role === 'manager', 'Demography is restricted to operations.');
    const groups = new Map<string, number>();
    for (const patient of data.filter(e => e.type === 'patient' && e.status === 'Active')) {
      const age = num(patient.data, 'age');
      const key = `${age < 18 ? '0-17' : age < 60 ? '18-59' : '60+'} | ${text(patient.data, 'sex')} | ${text(patient.data, 'address')} | ${text(patient.data, 'category')} | ${text(patient.data, 'payer')}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    return [...groups].map(([group, count]) => ({ group, count }));
  }
  const only = (type: string) => data.filter(e => e.type === type);
  const median = (values: number[]) => { if (!values.length) return 0; const sorted = values.sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return Math.round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2); };
  if (kind === 'referrals') return ['Sent', 'Seen', 'Accepted', 'Declined'].map(status => ({ status, count: only('referral').filter(e => e.status === status).length,
    medianResponseSeconds: median(only('referral').filter(e => e.status === status && text(e.data, 'answeredAt')).map(e => (new Date(text(e.data, 'answeredAt')).getTime() - new Date(e.createdAt).getTime()) / 1000)) }));
  if (kind === 'critical') {
    const critical = only('result').filter(e => text(e.data, 'flag') === 'Critical' && e.status === 'Released');
    const times = critical.flatMap(result => {
      const review = only('review').find(e => text(e.data, 'resultId') === result.id);
      return review ? [(new Date(review.createdAt).getTime() - new Date(text(result.data, 'releasedAt')).getTime()) / 1000] : [];
    });
    return [{ released: critical.length, acknowledged: times.length, medianSeconds: median(times), slowestSeconds: times.length ? Math.max(...times) : 0 }];
  }
  if (kind === 'diseases') {
    const groups = new Map<string, number>();
    for (const e of only('coding').filter(e => e.status === 'Coded')) groups.set(text(e.data, 'icd'), (groups.get(text(e.data, 'icd')) ?? 0) + 1);
    return [...groups].map(([icd, count]) => ({ icd, count }));
  }
  if (kind === 'collections') {
    return ['Cash', 'UPI', 'Card'].map(mode => {
      const receipts = only('payment').filter(e => e.status === 'Paid');
      const gross = receipts.flatMap(e => rows(e.data, 'payments')).filter(e => text(e, 'mode') === mode).reduce((n, e) => n + num(e, 'amount'), 0);
      const refunds = only('refund').filter(e => e.status === 'Completed').reduce((n, e) => {
        const paid = rows(e.data, 'originalModes'); const total = paid.reduce((x, p) => x + num(p, 'amount'), 0); const part = paid.filter(p => text(p, 'mode') === mode).reduce((x, p) => x + num(p, 'amount'), 0);
        return n + Math.round(num(e.data, 'amount') * part / Math.max(1, total));
      }, 0);
      return { mode, grossPaise: gross, refundsPaise: refunds, netPaise: gross - refunds };
    });
  }
  if (kind === 'orders') return [{ metric: 'Approved prescriptions', value: only('rx').filter(e => e.status !== 'Draft').length }, { metric: 'Test orders', value: only('order').length }];
  if (kind === 'accounts') return ['access', 'account', 'roleApproval'].map(type => ({ record: type, total: only(type).length, pending: only(type).filter(e => ['Requested', 'Invited', 'Pending'].includes(e.status)).length }));
  if (kind === 'pharmacy') return [{ issuedLines: only('dispense').length, issuedValuePaise: only('dispense').reduce((n, e) => n + num(e.data, 'total'), 0), returnCreditPaise: only('return').reduce((n, e) => n + num(e.data, 'credit'), 0) }];
  if (kind === 'inventory') return [{ batches: only('batch').length, units: only('batch').reduce((n, e) => n + num(e.data, 'quantity'), 0), expiredBatches: only('batch').filter(e => text(e.data, 'expiry') < istDate(store.now())).length, pendingPurchaseOrders: only('purchase').filter(e => e.status === 'Pending approval').length }];
  if (kind === 'lab') {
    const released = only('result').filter(e => e.status === 'Released');
    const times = released.map(e => Math.max(0, (new Date(text(e.data, 'releasedAt')).getTime() - new Date(text(e.data, 'sampleAt')).getTime()) / 60000));
    return [{ collectedSamples: only('sample').length, releasedReports: released.length, medianTurnaroundMinutes: median(times), longestTurnaroundMinutes: times.length ? Math.max(...times) : 0 }];
  }
  return [
    { metric: 'OPD check-ins', value: only('visit').filter(e => Boolean(text(e.data, 'checkinAt'))).length },
    { metric: 'Visits Done', value: only('visit').filter(e => e.status === 'Done').length },
    { metric: 'Active admissions', value: only('admission').filter(e => e.status === 'Admitted').length },
    { metric: 'Occupied beds', value: store.all('bed').filter(e => e.status === 'Occupied').length },
    { metric: 'Approved prescriptions', value: only('rx').filter(e => e.status !== 'Draft').length },
    { metric: 'Test orders', value: only('order').length }, { metric: 'Released reports', value: only('result').filter(e => e.status === 'Released').length },
    { metric: 'Pharmacy issues', value: only('dispense').length },
    { metric: 'Pending approvals', value: only('approval').filter(e => e.status === 'Pending').length }
  ];
}
export function snapshot(store: Store, actor: Actor): Snapshot {
  const entities = store.all().filter(e => visible(store, actor, e)).map(e => safeEntity(actor, e));
  const people = store.people().filter(person =>
    actor.id === person.id || (adminRoles.includes(actor.role) && actor.role !== 'auditor' && (actor.role !== 'head' || person.department === actor.department)) ||
    person.role === 'doctor' || (actor.role === 'services' && person.role === 'services')
  ).map(person => adminRoles.includes(actor.role) ? person : { ...person, login: '', staffId: '', mobile: '', patientIds: [], preferences: {}, counter: '' });
  const day = istDate(store.now());
  const signins = store.all('signin').filter(e => e.createdBy === actor.id && istDate(e.createdAt) === day).map(e => e.createdAt).sort();
  const summary: Data = {
    firstSignIn: signins[0] ?? '', latestSignIn: signins.at(-1) ?? '',
    visits: entities.filter(e => e.type === 'visit' && e.doctorId === actor.id && text(e.data, 'date') === day).length,
    done: entities.filter(e => e.type === 'visit' && e.status === 'Done' && (!doctorRoles.includes(actor.role) || e.doctorId === actor.id)).length,
    requests: entities.filter(e => e.type === 'access' && e.status === 'Requested').length,
    invites: entities.filter(e => e.type === 'account' && e.status === 'Invited').length,
    lockedAccounts: entities.filter(e => e.type === 'account' && e.status === 'Locked').length,
    help: entities.filter(e => e.type === 'help' && e.status !== 'Closed').length,
    admissions: entities.filter(e => e.type === 'admission' && e.status === 'Admitted').length,
    approvals: entities.filter(e => e.type === 'approval' && e.status === 'Pending').length,
    failedJobs: entities.filter(e => e.type === 'jobRun' && e.status === 'Failure').length,
    duePaise: entities.filter(e => e.type === 'bill' && ['Unpaid', 'Part paid'].includes(e.status)).reduce((n, e) => n + num(e.data, 'total') - num(e.data, 'paid'), 0)
  };
  return { actor, entities, people, now: store.now(), revision: store.revision(), notifications: notifications(store, actor, entities), summary,
    settings: { policy: store.setting<Data>('policy', {}), rules: store.setting<Data>('rules', {}), assumptions: 'Synthetic staff-owned billing and AJ22 staff administration; no production authority or migration decision. Public shared demo, not production authentication.' },
    faults: store.setting<Data>(`faults:${actor.id}`, { next: 'None' }) };
}
export function csv(records: Data[]): string {
  const keys = [...new Set(records.flatMap(Object.keys))].filter(key => key !== 'calendar');
  const quote = (value: unknown) => {
    let s = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replaceAll('"', '""')}"`;
  };
  return [keys.map(quote).join(','), ...records.map(row => keys.map(key => quote(row[key])).join(','))].join('\r\n');
}
