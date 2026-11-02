import { randomBytes, randomUUID } from 'node:crypto';
import { type Actor, type Data, type Role, doctorRoles, adminRoles, staffRoles, actorRoles, text, num, bool, rows, strings, istDate, roles } from '../shared/model.js';
import { credential, Auth } from './auth.js';
import { Context } from './context.js';
import { Store, DomainError, requireThat } from './store.js';
import { handoverPlan, applyHandover } from './handover.js';
import { repeatedRosterDates, homeCards } from '../shared/home.js';
import { validateHomeLayout } from './home.js';

export function parseCsv(value: string): Data[] {
  const records: string[][] = []; let record: string[] = []; let field = ''; let quoted = false;
  for (let i = 0; i <= value.length; i++) {
    const ch = value[i] ?? '\n';
    if (ch === '"') {
      if (quoted && value[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted;
    } else if (ch === ',' && !quoted) { record.push(field.trim()); field = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && value[i + 1] === '\n') i++;
      record.push(field.trim()); field = '';
      if (record.some(Boolean)) records.push(record);
      record = [];
    } else field += ch;
  }
  requireThat(!quoted, 'A CSV quoted field was not closed. Check the file.');
  requireThat(records.length >= 2 && records.length <= 501, 'Provide a header and 1-500 rows.');
  const header = records.shift()!;
  requireThat(new Set(header).size === header.length, 'CSV column names must be unique.');
  return records.map(row => Object.fromEntries(header.map((name, i) => [name, row[i] ?? ''])));
}
function accountInputValid(ctx: Context, data: Data, local = new Set<string>()): string {
  for (const key of ['name', 'staffId', 'login', 'departmentId', 'role']) if (!text(data, key)) return `Missing ${key}`;
  if (!roles.includes(text(data, 'role') as Role)) return 'Unrecognized role';
  if (!ctx.all('department').some(e => e.id === text(data, 'departmentId') && e.status === 'Active')) return 'Choose an active department';
  const people = ctx.store.people();
  if (people.some(p => p.staffId.toLowerCase() === text(data, 'staffId').toLowerCase() || p.login.toLowerCase() === text(data, 'login').toLowerCase())) return 'Duplicate login or staff ID';
  if (text(data, 'registration') && ctx.all('account').some(e => text(e.data, 'registration') === text(data, 'registration'))) return 'Duplicate registration number';
  if (local.has(text(data, 'staffId').toLowerCase()) || local.has(text(data, 'login').toLowerCase())) return 'Duplicate within CSV';
  local.add(text(data, 'staffId').toLowerCase()); local.add(text(data, 'login').toLowerCase());
  return '';
}
function invite(ctx: Context, data: Data): { id: string; login: string; temporaryPassword: string } {
  const error = accountInputValid(ctx, data);
  requireThat(!error, error);
  const password = `Demo-${randomBytes(12).toString('base64url')}!`;
  const role = text(data, 'role') as Role;
  const assigned = strings(data, 'roles');
  requireThat(!assigned.length || (staffRoles.includes(role) && assigned.every(value => staffRoles.includes(value as Role))), 'Multiple roles are supported only within staff roles. Do not combine clinical or administrative identities.');
  const id = `actor-${randomUUID()}`;
  const actor: Actor = {
    id, name: text(data, 'name'), role, roles: [...new Set([role, ...assigned as Role[]])], department: text(data, 'departmentId'), state: 'Invited', login: text(data, 'login'),
    staffId: text(data, 'staffId'), mobile: text(data, 'mobile'), patientIds: [], verifier: bool(data, 'verifier'),
    profileConfirmed: false, temporary: true, counter: 'OPD 1', appVersion: 1, preferences: {}
  };
  const cred = credential(password, true, ctx.now());
  cred.expires = new Date(new Date(ctx.now()).getTime() + num(ctx.store.setting<Data>('policy', {}), 'temporaryHours', 24) * 3600000).toISOString();
  ctx.store.savePerson(actor, cred);
  ctx.create('account', { ...data, roles: actor.roles!, name: actor.name, invitedAt: ctx.now(), expires: cred.expires }, 'Invited', { id, department: actor.department });
  return { id, login: actor.login, temporaryPassword: password };
}
function saveActor(ctx: Context, actor: Actor, data: Data = {}) {
  ctx.store.savePerson(actor);
  ctx.update(ctx.get(actor.id, 'account'), { name: actor.name, role: actor.role, roles: actorRoles(actor), departmentId: actor.department, ...data }, actor.state);
}
export function presenceReset(store: Store, date: string, late: boolean) {
  if (store.all('jobRun').some(e => text(e.data, 'job') === '22:00 presence reset' && text(e.data, 'date') === date && e.status === 'Success')) return { reset: 0, skipped: 0, replayed: true };
  const when = new Date(`${date}T22:00:00+05:30`).toISOString();
  const onCall = new Set(store.all('roster').filter(e => text(e.data, 'date') === date && ['On call', 'Night'].includes(text(e.data, 'shift'))).map(e => text(e.data, 'doctorId')));
  let reset = 0; let skipped = 0;
  for (const presence of store.all('presence')) {
    if (onCall.has(presence.doctorId!)) { skipped++; continue; }
    if (text(presence.data, 'reportedAt') > when) continue;
    store.update(presence, 'System', { status: 'Offline', systemReset: when, resetReason: 'Set by hospital at 22:00 IST' }, 'Offline');
    reset++;
  }
  store.create('jobRun', { name: `22:00 reset ${date}`, job: '22:00 presence reset', date, scheduledAt: when, late, reset, skipped }, 'System', { status: 'Success' });
  store.set('lastPresenceDate', date);
  store.audit('System', 'system', 'presence.reset', date, null, { reset, skipped, late });
  return { reset, skipped, replayed: false };
}
export function scheduledChecks(store: Store) {
  store.transact(() => {
    const now = store.now(); const today = istDate(now);
    const latest = new Date(now).getTime() >= new Date(`${today}T22:00:00+05:30`).getTime() ? today : istDate(new Date(new Date(now).getTime() - 86400000).toISOString());
    let last = store.setting<string>('lastPresenceDate', latest);
    for (let i = 0; last < latest && i < 31; i++) {
      const next = new Date(new Date(`${last}T12:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
      presenceReset(store, next, new Date(now).getTime() - new Date(`${next}T22:00:00+05:30`).getTime() > 60000);
      last = next;
    }
    for (const account of store.all('account')) {
      if (account.status === 'Suspended' && text(account.data, 'endDate') && text(account.data, 'endDate') <= today) {
        const actor = store.person(account.id); actor.state = 'Active'; store.savePerson(actor);
        store.update(account, 'System', { automaticallyReactivatedAt: now }, 'Active');
        store.audit('System', 'system', 'account.autoReactivate', actor.id, { state: 'Suspended' }, { state: 'Active' });
      }
      if (account.status === 'Active' && !bool(account.data, 'scheduleBlocked') && text(account.data, 'deactivationAt') && text(account.data, 'deactivationAt') <= now) {
        const actor = store.person(account.id);
        const context = new Context(store, { ...store.person('super'), id: 'System', name: 'System' }, { operationId: `scheduled-${account.id}`, actorId: 'System', createdAt: now, deviceId: 'scheduler',
          payload: { receiverId: text(account.data, 'exitReceiver'), handovers: rows(account.data, 'exitHandovers'), confirmName: actor.name, reason: text(account.data, 'exitReason'), unsentPlan: text(account.data, 'exitUnsentPlan'), unsentAction: text(account.data, 'exitUnsentAction'), confirmed: true } }, account);
        try {
          handoverPlan(context, actor, true);
          const unsent = store.all('device').filter(device => text(device.data, 'actorId') === actor.id).reduce((sum, device) => sum + num(device.data, 'unsent'), 0);
          requireThat(!unsent || context.t('unsentAction') === 'Accept unsent loss with reason', 'Unsent work still needs sync or explicit accepted-loss approval.');
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          store.update(account, 'System', { scheduleBlocked: true, scheduleError: error.message });
          store.create('jobRun', { name: 'Scheduled deactivation blocked', job: 'Scheduled account exit', accountId: actor.id, reason: error.message }, 'System', { status: 'Failure' });
          store.audit('System', 'system', 'account.scheduledExitBlocked', actor.id, null, { nextAction: 'Review group recipients and unsent recovery before removing access.' }, '', 'Rejected');
          continue;
        }
        adminCommand('account.deactivate', context);
        store.audit('System', 'system', 'account.scheduledDeactivate', actor.id, { state: 'Active' }, { state: 'Deactivated', originalRequester: text(account.data, 'exitRequestedBy') });
      }
    }
    for (const bed of store.all('bed').filter(e => e.status === 'Reserved' && text(e.data, 'reservedUntil') <= now)) store.update(bed, 'System', { patientId: '', reservedUntil: '' }, 'Free');
    for (const presence of store.all('presence').filter(e => e.status === 'Away' && text(e.data, 'awayUntil') && text(e.data, 'awayUntil') <= now)) store.update(presence, 'System', { status: 'Offline', resetReason: 'Away timer expired' }, 'Offline');
    for (const referral of store.all('referral').filter(e => ['Sent', 'Seen'].includes(e.status) && text(e.data, 'urgency') !== 'Routine' && !bool(e.data, 'escalated'))) {
      const rule = store.all('routing').find(e => e.department === referral.department);
      const minutes = rule ? num(rule.data, 'minutes', 30) : 30;
      if (new Date(now).getTime() - new Date(referral.createdAt).getTime() > minutes * 60000) {
        store.update(referral, 'System', { escalated: true, escalatedAt: now, escalationTo: rule ? text(rule.data, 'escalateTo') : 'Department duty desk' });
        store.audit('System', 'system', 'referral.escalated', referral.id, null, { target: 'Duty desk' });
      }
    }
    for (const result of store.all('result').filter(e => e.status === 'Released' && text(e.data, 'flag') === 'Critical' && !bool(e.data, 'callDue'))) {
      const reviewed = store.all('review').some(e => text(e.data, 'resultId') === result.id);
      if (!reviewed && new Date(now).getTime() - new Date(text(result.data, 'releasedAt')).getTime() >= 900000) {
        store.update(result, 'System', { callDue: true, escalatedAt: now });
        store.audit('System', 'system', 'critical.callDue', result.id, null, { callDue: true });
      }
    }
    for (const change of store.all('itemPrice').filter(e => e.status === 'Approved' && text(e.data, 'effective') <= today)) {
      const item = store.get(text(change.data, 'itemId'), 'item');
      store.update(item, 'System', { mrp: num(change.data, 'mrp'), priceEffective: text(change.data, 'effective') });
      store.update(change, 'System', { appliedAt: now }, 'Applied');
      store.audit('System', 'system', 'item.priceEffective', item.id, { mrp: num(item.data, 'mrp') }, { mrp: num(change.data, 'mrp') });
    }
    for (const job of store.all('job').filter(e => e.status === 'Enabled' && text(e.data, 'nextRun') && text(e.data, 'nextRun') <= now)) {
      const failed = store.setting<Data>('faults', {}).provider === 'Failure';
      const run = store.create('jobRun', { name: `${text(job.data, 'name')} ${today}`, jobId: job.id, job: text(job.data, 'name'), ranAt: now, scheduledAt: text(job.data, 'nextRun'), late: true, simulated: true }, 'System', { status: failed ? 'Failure' : 'Success' });
      if (!failed && text(job.data, 'name') === 'Appointment reminders') {
        for (const visit of store.all('visit').filter(e => e.status === 'Booked' && text(e.data, 'date') >= today)) {
          const prefs = store.all('updates').find(e => e.patientId === visit.patientId);
          const sourceId = `${visit.id}-${today}`;
          if (prefs?.data.appointments === false || store.all('message').some(e => text(e.data, 'sourceId') === sourceId && text(e.data, 'template') === 'Appointment reminder')) continue;
          const patient = store.get(visit.patientId!, 'patient');
          store.create('message', { name: 'Appointment reminder (WhatsApp)', sourceId, template: 'Appointment reminder', channel: 'WhatsApp', mobile: `******${text(patient.data, 'mobile').slice(-4)}`, simulated: true,
            attempts: [{ at: now, status: 'Delivered', reason: 'Scheduled simulated delivery only' }] }, 'System', { patientId: visit.patientId, status: 'Delivered' });
        }
      }
      if (!failed && text(job.data, 'name') === 'Expiry alerts') {
        const batches = store.all('batch').filter(e => text(e.data, 'expiry') < today);
        for (const batch of batches) if (batch.status === 'Available') store.update(batch, 'System', {}, 'Expired');
        store.update(run, 'System', { expiredBatchCount: batches.length, expiringDocuments: store.all('hospitalDocument').filter(e => text(e.data, 'expiry') <= dateAfter(today, 60)).length });
      }
      store.update(job, 'System', { lastRun: now, nextRun: new Date(new Date(now).getTime() + 86400000).toISOString(), result: failed ? 'Failure' : 'Success' });
      store.audit('System', 'system', 'job.scheduledRun', job.id, null, { result: failed ? 'Failure' : 'Success', runId: run.id });
    }
  });
}
function dateAfter(date: string, days: number) { return new Date(new Date(`${date}T12:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10); }
export function adminCommand(name: string, ctx: Context): boolean {
  const p = ctx.p;
  switch (name) {
    case 'account.create': {
      requireThat(doctorRoles.includes(ctx.t('role') as Role), 'Choose a doctor or resident role.');
      requireThat(ctx.t('registration'), 'Enter a synthetic registration number.');
      const data = { ...p };
      if (ctx.t('copyFrom')) {
        const source = ctx.get(ctx.t('copyFrom'), 'account');
        data.room = text(source.data, 'room'); data.workSetup = text(source.data, 'workSetup');
      }
      ctx.result = invite(ctx, data); break;
    }
    case 'staff.create':
      requireThat(!['doctor', 'resident', 'superadmin', 'patient'].includes(ctx.t('role')), 'Use the dedicated doctor onboarding or super-admin approval flow.');
      ctx.result = invite(ctx, p); break;
    case 'access.approve': {
      const access = ctx.targetOf('access');
      const result = invite(ctx, { ...access.data, ...p, login: text(access.data, 'staffId').toLowerCase(), qualification: 'Pending profile review' });
      ctx.update(access, { accountId: result.id, decidedBy: ctx.actor.id, decidedAt: ctx.now() }, 'Invited');
      ctx.result = result; break;
    }
    case 'access.reject':
      ctx.update(ctx.targetOf('access'), { reason: ctx.t('reason'), decidedAt: ctx.now(), decidedBy: ctx.actor.id }, 'Rejected'); break;
    case 'account.import': {
      const records = parseCsv(ctx.t('csv')); const local = new Set<string>();
      const checked = records.map((data, i) => {
        const error = accountInputValid(ctx, data, local) || (!doctorRoles.includes(text(data, 'role') as Role) ? 'Only doctor/resident rows are allowed' : '') || (!text(data, 'registration') ? 'Missing registration' : '');
        return { row: i + 2, data, status: error ? error.includes('Duplicate') ? 'Duplicate' : 'Needs a fix' : 'Ready', error };
      });
      ctx.create('import', { name: 'Doctor CSV preview', rows: checked, ready: checked.filter(r => r.status === 'Ready').length, errors: checked.filter(r => r.status !== 'Ready').length }, 'Preview');
      break;
    }
    case 'account.importCommit': {
      const batch = ctx.targetOf('import');
      requireThat(batch.createdBy === ctx.actor.id, 'Only the preview owner may commit this import.');
      const created: Data[] = [];
      for (const row of rows(batch.data, 'rows')) {
        if (row.status !== 'Ready') continue;
        const data = row.data;
        requireThat(data && typeof data === 'object' && !Array.isArray(data), 'A CSV row is invalid. Preview it again.');
        if (accountInputValid(ctx, data)) continue;
        created.push(invite(ctx, data));
      }
      ctx.update(batch, { created: created.length, committedAt: ctx.now() }, 'Created');
      ctx.result = { temporarySlips: created, created: created.length }; break;
    }
    case 'account.reset': {
      const account = ctx.targetOf('account'); const actor = ctx.store.person(account.id);
      requireThat(actor.id !== ctx.actor.id, 'You cannot reset your own password. Ask another authorized administrator.');
      requireThat(actor.state !== 'Deactivated', 'A deactivated account cannot be reset. A super admin must restore it first.');
      if (ctx.actor.role !== 'superadmin') requireThat(!adminRoles.includes(actor.role), 'Only a super admin may reset an administrative account.');
      const password = `Demo-${randomBytes(12).toString('base64url')}!`;
      const old = ctx.store.credential(actor.id);
      const next = credential(password, true, ctx.now());
      next.history = [text(old, 'hash'), ...(Array.isArray(old.history) ? old.history : [])].slice(0, 5);
      actor.temporary = true; actor.profileConfirmed = false; actor.state = 'Invited';
      ctx.store.savePerson(actor, next);
      ctx.update(account, { resetAt: ctx.now(), resetReason: ctx.t('reason'), expires: next.expires }, 'Invited');
      if (ctx.b('signOut')) new Auth(ctx.store).revokeActor(actor.id);
      ctx.result = { temporaryPassword: password, login: actor.login, expires: next.expires }; break;
    }
    case 'account.unlock': {
      const account = ctx.targetOf('account'); const actor = ctx.store.person(account.id);
      requireThat(ctx.actor.role === 'superadmin' || !adminRoles.includes(actor.role), 'Only a super admin may unlock an administrator.');
      actor.state = actor.temporary ? 'Invited' : 'Active';
      const cred = ctx.store.credential(actor.id); cred.failures = 0; ctx.store.savePerson(actor, cred);
      ctx.update(account, { unlockReason: ctx.t('reason') }, actor.state); break;
    }
    case 'account.edit': {
      const account = ctx.targetOf('account'); const actor = ctx.store.person(account.id);
      requireThat(doctorRoles.includes(actor.role), 'This page edits clinical profiles. Use admin/staff identities for other accounts.');
      if (actor.department !== ctx.t('departmentId')) {
        const open = ctx.store.all().some(e => e.doctorId === actor.id && ['visit', 'admission', 'question', 'referral'].includes(e.type) && !['Done', 'Cancelled', 'Discharged', 'Answered', 'Declined'].includes(e.status));
        if (open) applyHandover(ctx, actor, handoverPlan(ctx, actor, true));
      }
      actor.name = ctx.t('name'); actor.department = ctx.t('departmentId');
      saveActor(ctx, actor, p); break;
    }
    case 'account.suspend': {
      const actor = ctx.store.person(ctx.targetOf('account').id);
      requireThat(doctorRoles.includes(actor.role) && actor.id !== ctx.actor.id, 'This suspension flow is for other clinical accounts.');
      if (ctx.t('endDate')) requireThat(ctx.t('endDate') > istDate(ctx.now()), 'Automatic return must be in the future.');
      if (rows(ctx.p, 'handovers').length) applyHandover(ctx, actor, handoverPlan(ctx, actor, false));
      actor.state = 'Suspended'; saveActor(ctx, actor, p); new Auth(ctx.store).revokeActor(actor.id); break;
    }
    case 'account.reactivate': {
      const actor = ctx.store.person(ctx.targetOf('account').id);
      requireThat(actor.state !== 'Deactivated' || ctx.actor.role === 'superadmin', 'Only a super admin may restore a deactivated account.');
      actor.state = 'Active'; saveActor(ctx, actor, { reason: ctx.t('reason'), endDate: '' }); break;
    }
    case 'account.deactivate': {
      const actor = ctx.store.person(ctx.targetOf('account').id);
      requireThat(doctorRoles.includes(actor.role), 'Use administrative access removal for a non-clinical account.');
      requireThat(ctx.t('confirmName') === actor.name, 'Type the account name exactly to confirm.');
      const plan = handoverPlan(ctx, actor, true);
      const devices = ctx.all('device').filter(device => text(device.data, 'actorId') === actor.id);
      const unsent = devices.reduce((sum, device) => sum + num(device.data, 'unsent'), 0);
      requireThat(!unsent || ctx.t('unsentAction') === 'Accept unsent loss with reason', 'Unsent items remain. Wait for sync, or explicitly accept unsent loss and record why.');
      applyHandover(ctx, actor, plan);
      actor.state = 'Deactivated'; saveActor(ctx, actor, { reason: ctx.t('reason'), unsentPlan: ctx.t('unsentPlan'), unsentDecision: ctx.t('unsentAction'), reportedUnsentAtExit: unsent, deactivatedAt: ctx.now() });
      for (const device of devices) ctx.update(device, { reason: 'Account deactivated', exitUnsentPlan: ctx.t('unsentPlan'), reportedUnsentAtExit: num(device.data, 'unsent') }, 'Signed out');
      new Auth(ctx.store).revokeActor(actor.id); break;
    }
    case 'account.scheduleExit': {
      const account = ctx.targetOf('account'); const actor = ctx.store.person(account.id);
      requireThat(doctorRoles.includes(actor.role) && ctx.t('confirmName') === actor.name, 'Choose a clinical account and type its name exactly.');
      const plan = handoverPlan(ctx, actor, true);
      const deactivationAt = new Date(`${ctx.t('lastWorkingDay')}T23:59:00+05:30`).toISOString();
      requireThat(deactivationAt > ctx.now(), 'The planned exit time must be in the future.');
      ctx.update(account, { deactivationAt, exitReceiver: ctx.t('receiverId'), exitHandovers: plan, exitReason: ctx.t('reason'), exitUnsentPlan: ctx.t('unsentPlan'), exitUnsentAction: ctx.t('unsentAction'), exitRequestedBy: ctx.actor.id, scheduleBlocked: false, scheduleError: '' }); break;
    }
    case 'device.signout':
    case 'device.wipe': {
      const device = ctx.targetOf('device');
      const owner = ctx.store.person(text(device.data, 'actorId'));
      requireThat(doctorRoles.includes(owner.role), 'Use identity administration for non-doctor sessions.');
      ctx.update(device, { reason: ctx.t('reason'), lossPlan: ctx.t('lossPlan'), requestedAt: ctx.now() }, name === 'device.wipe' ? 'Wipe pending' : 'Signed out');
      break;
    }
    case 'device.minimum':
      ctx.store.set('minimumVersion', { version: ctx.n('version'), date: ctx.t('date'), reason: ctx.t('reason'), changedBy: ctx.actor.id }); break;
    case 'department.save':
      requireThat(!ctx.all('department').some(e => text(e.data, 'shortName').toLowerCase() === ctx.t('shortName').toLowerCase()), 'That department short name already exists.');
      ctx.create('department', p, 'Active'); break;
    case 'room.save':
      ctx.create('room', p, 'Active', { department: ctx.t('departmentId') }); break;
    case 'session.save': {
      const actor = ctx.store.person(ctx.t('doctorId'));
      requireThat(actor.role === 'doctor' && actor.state === 'Active', 'Choose an active consultant.');
      requireThat(ctx.t('start') < ctx.t('end'), 'Session end must be after its start.');
      requireThat(!ctx.all('session').some(e => e.doctorId === actor.id && text(e.data, 'date') === ctx.t('date') && text(e.data, 'start') < ctx.t('end') && text(e.data, 'end') > ctx.t('start')), 'This session overlaps an existing session.');
      ctx.create('session', { ...p, name: `${actor.name} ${ctx.t('date')}` }, 'Published', { doctorId: actor.id, department: actor.department }); break;
    }
    case 'holiday.save':
      ctx.create('holiday', { ...p, name: `Holiday ${ctx.t('date')}` }, 'Active'); break;
    case 'roster.save': {
      const actor = ctx.store.person(ctx.t('doctorId'));
      requireThat(actor.role === 'doctor' && actor.state === 'Active' && actor.department === ctx.t('departmentId'), 'Choose an active consultant from this department.');
      const prior = ctx.all('roster').find(e => e.department === ctx.t('departmentId') && text(e.data, 'date') === ctx.t('date') && text(e.data, 'shift') === ctx.t('shift'));
      if (prior) ctx.update({ ...prior, doctorId: actor.id }, { ...p, name: `${ctx.t('date')} ${ctx.t('shift')} - ${actor.name}` }, 'Published');
      else ctx.create('roster', { ...p, name: `${ctx.t('date')} ${ctx.t('shift')} - ${actor.name}` }, 'Published', { doctorId: actor.id, department: actor.department }); break;
    }
    case 'roster.import': {
      const imported = parseCsv(ctx.t('csv'));
      for (const data of imported) {
        requireThat(/^\d{4}-\d{2}-\d{2}$/.test(text(data, 'date')) && ['Day', 'Night', 'On call'].includes(text(data, 'shift')) && text(data, 'reason'), 'Each row needs a valid date, shift and reason.');
        const actor = ctx.store.person(text(data, 'doctorId'));
        requireThat(actor.state === 'Active' && actor.role === 'doctor' && actor.department === text(data, 'departmentId'), 'Every roster row must name an active doctor in its department.');
      }
      for (const data of imported) {
        const child = new Context(ctx.store, ctx.actor, { ...ctx.request, payload: data });
        adminCommand('roster.save', child); ctx.touched.push(...child.touched);
      } break;
    }
    case 'roster.repeat': {
      const doctor = ctx.store.person(ctx.t('doctorId'));
      requireThat(doctor.role === 'doctor' && doctor.state === 'Active' && doctor.department === ctx.t('departmentId'), 'Choose an active consultant in this department.');
      const dates = repeatedRosterDates(ctx.t('month'), strings(p, 'weekdays'));
      requireThat(dates.length > 0, 'Choose a valid month and at least one weekday.');
      const conflicts = ctx.all('roster').filter(entry => entry.department === doctor.department && dates.includes(text(entry.data, 'date')) && text(entry.data, 'shift') === ctx.t('shift') && text(entry.data, 'doctorId') !== doctor.id);
      requireThat(!conflicts.length || ctx.b('replaceExisting'), `${conflicts.length} existing assignments conflict. Review them and explicitly confirm replacement.`);
      let changed = 0;
      for (const date of dates) {
        const existing = ctx.all('roster').find(entry => entry.department === doctor.department && text(entry.data, 'date') === date && text(entry.data, 'shift') === ctx.t('shift'));
        if (existing && text(existing.data, 'doctorId') === doctor.id) continue;
        const data = { name: `${date} ${ctx.t('shift')} - ${doctor.name}`, departmentId: doctor.department, doctorId: doctor.id, date, shift: ctx.t('shift'), reason: ctx.t('reason'), patternMonth: ctx.t('month') };
        if (existing) ctx.update({ ...existing, doctorId: doctor.id }, data, 'Published');
        else ctx.create('roster', data, 'Published', { doctorId: doctor.id, department: doctor.department });
        changed++;
      }
      ctx.result = { dates, changed, unchanged: dates.length - changed, replaced: conflicts.length }; break;
    }
    case 'job.presence': {
      requireThat(new Date(`${ctx.t('date')}T22:00:00+05:30`).getTime() <= new Date(ctx.now()).getTime(), 'Advance the demo clock past 22:00 IST before running that day’s reset.');
      ctx.result = presenceReset(ctx.store, ctx.t('date'), true); break;
    }
    case 'set.publish': {
      const ids = ctx.t('kind') === 'Medicines' ? rows(p, 'lines').map(line => text(line, 'itemId')) : strings(p, 'tests');
      requireThat(ids.length > 0, 'Choose catalog items for the set.');
      for (const id of ids) requireThat(ctx.get(id, ctx.t('kind') === 'Medicines' ? 'item' : 'test').status === 'Active', 'A selected item is retired. Remove it before publication.');
      const prior = ctx.all('set').find(e => e.department === ctx.t('departmentId') && text(e.data, 'name') === ctx.t('name') && text(e.data, 'scope') === 'Department');
      if (prior) ctx.update(prior, { ...p, publishedVersion: num(prior.data, 'publishedVersion', 1) + 1 }, 'Published');
      else ctx.create('set', { ...p, scope: 'Department', publishedVersion: 1 }, 'Published', { department: ctx.t('departmentId') }); break;
    }
    case 'template.publish': {
      const prior = ctx.all('template').find(e => e.department === ctx.t('departmentId') && text(e.data, 'name') === ctx.t('name'));
      if (prior) ctx.update(prior, p, 'Published');
      else ctx.create('template', p, 'Published', { department: ctx.t('departmentId') }); break;
    }
    case 'letterhead.publish':
      ctx.update(ctx.get('letterhead', 'letterhead'), p, 'Published'); break;
    case 'routing.save': {
      const prior = ctx.all('routing').find(e => e.department === ctx.t('departmentId'));
      if (prior) ctx.update(prior, p); else ctx.create('routing', { ...p, name: `Referral routing ${ctx.t('departmentId')}` }, 'Active', { department: ctx.t('departmentId') }); break;
    }
    case 'wording.save': {
      const locked = ctx.t('locked');
      requireThat(!/[{}@\d]/.test(locked) && !ctx.store.people().some(actor => locked.toLowerCase().includes(actor.name.toLowerCase())) &&
        !ctx.all('patient').some(patient => locked.toLowerCase().includes(text(patient.data, 'name').toLowerCase())),
      'Lock-screen text must be generic: no identity placeholders, names, e-mails or numbers.');
      const prior = ctx.all('wording').find(e => text(e.data, 'kind') === ctx.t('kind'));
      if (prior) ctx.update(prior, p); else ctx.create('wording', { ...p, name: ctx.t('kind') }, 'Active'); break;
    }
    case 'feature.save': {
      const prior = ctx.all('feature').find(e => e.department === ctx.t('departmentId') && text(e.data, 'feature') === ctx.t('feature'));
      if (ctx.t('state') === 'Pilot') requireThat(ctx.t('pilotDoctors'), 'List at least one pilot doctor.');
      if (prior) ctx.update(prior, p); else ctx.create('feature', p, 'Active', { department: ctx.t('departmentId') }); break;
    }
    case 'home.defaults': {
      const layout = p.layout;
      requireThat(layout && typeof layout === 'object' && !Array.isArray(layout), 'Choose a complete default Home arrangement.');
      const locked = [...new Set(['referrals', 'results', ...strings(p, 'lockedCards')])];
      requireThat(locked.every(id => homeCards.some(card => card.id === id)), 'Choose only listed Home cards.');
      validateHomeLayout(layout, locked);
      const existing = ctx.all('homeDefault').find(entry => entry.department === ctx.t('departmentId'));
      const data = { name: 'Department Home defaults', layout, lockedCards: locked, reason: ctx.t('reason') };
      if (existing) ctx.update(existing, data, 'Published');
      else ctx.create('homeDefault', data, 'Published', { department: ctx.t('departmentId') });
      break;
    }
    case 'announcement.publish':
      requireThat(ctx.t('end') > ctx.t('start'), 'Announcement end must follow the start.');
      ctx.create('announcement', p, 'Published', { department: ctx.t('departmentId') || undefined }); break;
    case 'help.reply': {
      const help = ctx.targetOf('help');
      ctx.update(help, { replies: [...rows(help.data, 'replies'), { at: ctx.now(), actor: ctx.actor.id, text: ctx.t('reply') }] }, ctx.t('status')); break;
    }
    case 'article.publish':
      requireThat(/^(DJ|AJ|SJ)\d{2}$/.test(ctx.t('journey')), 'Enter a valid journey ID for the guide link.');
      ctx.create('article', { ...p, readBy: [], helpful: [] }, 'Published'); break;
    case 'policy.save':
      ctx.store.set('policy', { ...p, changedBy: ctx.actor.id, changedAt: ctx.now(), administrativeSecondCheck: true }); break;
    case 'account.role': {
      const actor = ctx.store.person(ctx.targetOf('account').id);
      requireThat(actor.id !== ctx.actor.id, 'You cannot change your own role.');
      requireThat(!doctorRoles.includes(actor.role) && actor.role !== 'patient', 'Use clinical profile administration for clinical accounts.');
      if (actor.role === 'superadmin' && ctx.t('role') !== 'superadmin') requireThat(ctx.store.people().filter(x => x.role === 'superadmin' && x.state === 'Active').length > 1, 'The last active super admin cannot be removed.');
      if (ctx.t('role') === 'superadmin') ctx.create('roleApproval', { name: `${actor.name} elevation`, actorId: actor.id, requestedBy: ctx.actor.id, role: 'superadmin', department: ctx.t('departmentId'), reason: ctx.t('reason') }, 'Pending');
      else {
        const role = ctx.t('role') as Role; const assigned = strings(ctx.p, 'roles');
        requireThat(!assigned.length || (staffRoles.includes(role) && assigned.every(value => staffRoles.includes(value as Role))), 'Only staff roles may be combined; administrative accounts remain separate.');
        actor.role = role; actor.roles = [...new Set([role, ...assigned as Role[]])]; actor.department = ctx.t('departmentId'); saveActor(ctx, actor);
      }
      break;
    }
    case 'role.approve': {
      const approval = ctx.targetOf('roleApproval');
      requireThat(text(approval.data, 'requestedBy') !== ctx.actor.id && text(approval.data, 'actorId') !== ctx.actor.id, 'A different super admin must approve this elevation.');
      const actor = ctx.store.person(text(approval.data, 'actorId')); actor.role = 'superadmin'; actor.roles = ['superadmin']; saveActor(ctx, actor);
      ctx.update(approval, { approvedBy: ctx.actor.id, reason: ctx.t('reason') }, 'Approved'); break;
    }
    case 'account.remove': {
      const actor = ctx.store.person(ctx.targetOf('account').id);
      requireThat(actor.id !== ctx.actor.id, 'You cannot remove your own access.');
      requireThat(!doctorRoles.includes(actor.role) && actor.role !== 'patient', 'Use clinical deactivation with handover for doctors.');
      requireThat(ctx.t('confirmName') === actor.name, 'Type the account name exactly.');
      requireThat(actor.role !== 'superadmin' || ctx.store.people().filter(a => a.role === 'superadmin' && a.state === 'Active').length > 1, 'The last super admin cannot be removed.');
      actor.state = 'Deactivated'; saveActor(ctx, actor, { reason: ctx.t('reason') }); new Auth(ctx.store).revokeActor(actor.id); break;
    }
    default: return false;
  }
  return true;
}
