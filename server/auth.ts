import { randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { adminRoles, doctorRoles, text, num, type Actor, type Data } from '../shared/model.js';
import { Store, DomainError, requireThat } from './store.js';

export const demoPassword = 'SamplePass2026!';
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}
export function matches(password: string, encoded: string): boolean {
  const [salt, digest] = encoded.split(':');
  if (!salt || !digest || digest.length !== 64) return false;
  const actual = scryptSync(password, salt, 32);
  return timingSafeEqual(actual, Buffer.from(digest, 'hex'));
}
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function credential(password = demoPassword, temporary = false, now = new Date().toISOString()): Data {
  return { hash: hashPassword(password), history: [], temporary, expires: temporary ? new Date(new Date(now).getTime() + 86400000).toISOString() : '', failures: 0 };
}
export function cookie(req: Request, name: string) {
  const item = (req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
}
export function setCookie(req: Request, res: Response, name: string, value: string, maxAge = 43200000) {
  res.cookie(name, value, { httpOnly: true, sameSite: 'strict', secure: req.headers['x-forwarded-proto'] === 'https' || req.secure, path: '/', maxAge });
}
export type Session = { actorId: string; createdAt: string; lastAt: string; restricted: boolean; locked: boolean; deviceId: string; role: string; key: string };
export class Auth {
  constructor(public store: Store) {}
  private saveSession(key: string, session: Session) {
    this.store.db.prepare('INSERT INTO sessions VALUES(?,?) ON CONFLICT(token) DO UPDATE SET body=excluded.body').run(hash(key), JSON.stringify({ ...session, key: '' }));
  }
  get(req: Request, allowRestricted = false, allowLocked = false): { actor: Actor; session: Session } {
    const key = cookie(req, 'samford_actor');
    const row = this.store.db.prepare('SELECT body FROM sessions WHERE token=?').get(hash(key));
    if (!row) throw new DomainError(401, 'SIGN_IN', 'Please sign in again. Your saved drafts are safe.');
    const session = { ...JSON.parse(String(row.body)) as Session, key };
    const actor = this.store.person(session.actorId);
    if (!['Active', 'Invited'].includes(actor.state)) {
      throw new DomainError(401, 'ACCESS_REVOKED', `Your account is ${actor.state.toLowerCase()}. Saved drafts are kept for recovery. Contact IT.`);
    }
    if (actor.role !== session.role) throw new DomainError(401, 'ROLE_CHANGED', 'Your role changed. Sign in again to use the new permissions.');
    const device = this.store.all('device').find(e => text(e.data, 'deviceId') === session.deviceId && text(e.data, 'actorId') === actor.id);
    if (device && device.status !== 'Active') {
      throw new DomainError(401, device.status === 'Wipe pending' ? 'WIPE_PENDING' : 'DEVICE_SIGNED_OUT', device.status === 'Wipe pending' ? 'Hospital IT requested removal of this browser’s Samford data. Record your unsent recovery before confirming the wipe.' : 'This device was signed out by IT. Your drafts are retained; contact support.');
    }
    const minimum = this.store.setting<Data>('minimumVersion', { version: 1, date: '' });
    if (doctorRoles.includes(actor.role) && text(minimum, 'date') <= this.store.now().slice(0, 10) && actor.appVersion < num(minimum, 'version', 1)) {
      throw new DomainError(426, 'UPDATE_NEEDED', 'This app version needs an update. Local drafts are kept.');
    }
    const policy = this.store.setting<Data>('policy', {});
    const idle = (new Date(this.store.now()).getTime() - new Date(session.lastAt).getTime()) / 60000;
    if (doctorRoles.includes(actor.role) && idle >= num(policy, 'doctorIdle', 5)) session.locked = true;
    if (!doctorRoles.includes(actor.role) && idle >= (actor.role === 'patient' ? 10 : num(policy, 'portalIdle', 15))) {
      this.revokeKey(key);
      throw new DomainError(401, 'SESSION_EXPIRED', 'Your session expired after inactivity. Sign in again; your draft is kept for the same account.');
    }
    if (session.locked && !allowLocked) throw new DomainError(423, 'LOCKED', 'App locked. Enter your demo PIN to continue.');
    if (!allowRestricted && (session.restricted || actor.temporary || !actor.profileConfirmed)) throw new DomainError(403, 'ONBOARDING_REQUIRED', 'Set your password and confirm your profile before opening work.');
    if (req.method !== 'GET' || req.headers['x-user-action'] === '1') session.lastAt = this.store.now();
    this.saveSession(key, session);
    return { actor, session };
  }
  challenge(actor: Actor, deviceId: string, temporary: boolean): Data {
    const id = randomUUID();
    const code = String(randomInt(100000, 1000000));
    const challenge = { actorId: actor.id, codeHash: hash(code), deviceId, temporary, expires: Date.now() + 300000, failures: 0 };
    this.store.db.prepare('INSERT INTO auth_challenges VALUES(?,?)').run(id, JSON.stringify(challenge));
    return { challengeId: id, simulatedCode: code, message: 'Simulated second check: use the code shown here. No SMS or authenticator provider was contacted.', expiresIn: 300 };
  }
  start(login: string, password: string, deviceId: string): Data {
    const actor = this.store.people().find(p => [p.login, p.mobile, text(this.store.get(p.id, 'account').data, 'email') || `${p.login}@sample.invalid`].some(x => x.toLowerCase() === login.toLowerCase()));
    if (!actor || actor.role === 'patient') throw new DomainError(401, 'SIGN_IN_FAILED', 'Login or password was not accepted. Check it or contact IT.');
    const cred = this.store.credential(actor.id);
    if (!['Active', 'Invited'].includes(actor.state)) throw new DomainError(401, 'ACCOUNT_BLOCKED', `Account ${actor.state.toLowerCase()}. Contact IT for recovery.`);
    if (!matches(password, text(cred, 'hash'))) {
      cred.failures = num(cred, 'failures') + 1;
      if (num(cred, 'failures') >= num(this.store.setting<Data>('policy', {}), 'attempts', 5)) {
        actor.state = 'Locked';
        const account = this.store.get(actor.id, 'account');
        this.store.update(account, 'System', {}, 'Locked');
      }
      this.store.savePerson(actor, cred);
      this.store.audit(actor.id, actor.role, 'auth.failure', actor.id, null, { deviceId, attempts: cred.failures }, '', 'Rejected');
      throw new DomainError(401, 'SIGN_IN_FAILED', actor.state === 'Locked' ? 'Account locked after repeated failed attempts. Contact IT.' : 'Login or password was not accepted. Check it or contact IT.');
    }
    if (cred.temporary && (text(cred, 'expires') < this.store.now() || cred.consumed)) throw new DomainError(401, 'TEMPORARY_EXPIRED', 'The temporary password expired or was used. Ask IT for a new one.');
    return this.challenge(actor, deviceId, Boolean(cred.temporary));
  }
  patientStart(mobile: string, captchaId: string, answer: string, deviceId: string): Data {
    const challenge = this.store.setting<Data>(`captcha:${captchaId}`, {});
    requireThat(text(challenge, 'answer') === answer && num(challenge, 'expires') > Date.now(), 'Captcha did not match or expired. Refresh the challenge.');
    this.store.set(`captcha:${captchaId}`, {});
    const locked = this.store.setting<number>(`patientLock:${mobile}`, 0);
    if (locked > Date.now()) throw new DomainError(429, 'OTP_LOCKED', 'Sign-in is locked for 30 minutes after three wrong codes.');
    const actor = this.store.people().find(p => p.role === 'patient' && p.mobile === mobile);
    if (!actor) throw new DomainError(401, 'MOBILE_NOT_REGISTERED', 'No sample family is linked to that mobile. Ask the front desk.');
    return this.challenge(actor, deviceId, false);
  }
  complete(challengeId: string, code: string, req: Request, res: Response): Actor {
    const row = this.store.db.prepare('SELECT body FROM auth_challenges WHERE id=?').get(challengeId);
    if (!row) throw new DomainError(401, 'CODE_EXPIRED', 'This check expired. Start sign-in again.');
    const challenge = JSON.parse(String(row.body)) as Data;
    const actor = this.store.person(text(challenge, 'actorId'));
    if (num(challenge, 'expires') < Date.now()) throw new DomainError(401, 'CODE_EXPIRED', 'Code expired. Start sign-in again.');
    if (hash(code) !== text(challenge, 'codeHash')) {
      challenge.failures = num(challenge, 'failures') + 1;
      this.store.db.prepare('UPDATE auth_challenges SET body=? WHERE id=?').run(JSON.stringify(challenge), challengeId);
      if (num(challenge, 'failures') >= (actor.role === 'patient' ? 3 : 5)) {
        this.store.db.prepare('DELETE FROM auth_challenges WHERE id=?').run(challengeId);
        if (actor.role === 'patient') this.store.set(`patientLock:${actor.mobile}`, Date.now() + 1800000);
        else {
          actor.state = 'Locked'; this.store.savePerson(actor);
          this.store.update(this.store.get(actor.id), 'System', {}, 'Locked');
        }
      }
      this.store.audit(actor.id, actor.role, 'auth.codeFailure', actor.id, null, null, '', 'Rejected');
      throw new DomainError(401, 'WRONG_CODE', 'That code was not accepted. Check the simulated code or start again.');
    }
    requireThat(['Active', 'Invited'].includes(actor.state), 'Account access changed. Contact IT.');
    const cred = this.store.credential(actor.id);
    if (challenge.temporary) {
      requireThat(!cred.consumed, 'This temporary password has already been used.');
      cred.consumed = true;
    }
    cred.failures = 0;
    this.store.savePerson(actor, cred);
    this.store.db.prepare('DELETE FROM auth_challenges WHERE id=?').run(challengeId);
    const key = randomBytes(32).toString('base64url');
    const now = this.store.now();
    const session: Session = { actorId: actor.id, createdAt: now, lastAt: now, restricted: Boolean(challenge.temporary), locked: false, deviceId: text(challenge, 'deviceId'), role: actor.role, key };
    this.saveSession(key, session);
    setCookie(req, res, 'samford_actor', key);
    const device = this.store.all('device').find(e => text(e.data, 'actorId') === actor.id && text(e.data, 'deviceId') === session.deviceId);
    const data = { name: `${actor.name} - demo browser`, actorId: actor.id, deviceId: session.deviceId, appVersion: actor.appVersion, lastSync: now, unsent: 0 };
    if (device) this.store.update(device, actor.id, data, 'Active');
    else this.store.create('device', data, actor.id, { status: 'Active', department: actor.department });
    this.store.create('signin', { actorId: actor.id, deviceId: session.deviceId, method: adminRoles.includes(actor.role) ? 'Password + simulated authenticator' : actor.role === 'patient' ? 'Simulated mobile OTP' : 'Password + simulated OTP', name: actor.name }, actor.id, { department: actor.department, doctorId: doctorRoles.includes(actor.role) ? actor.id : undefined });
    this.store.audit(actor.id, actor.role, 'auth.signin', actor.id, null, { deviceId: session.deviceId });
    return actor;
  }
  changePassword(req: Request, password: string) {
    const { actor, session } = this.get(req, true);
    const cred = this.store.credential(actor.id);
    const policy = this.store.setting<Data>('policy', {});
    requireThat(password.length >= num(policy, 'minPassword', 10) && password.length <= 128, 'Use a password of at least the policy minimum length (10 by default).');
    requireThat(!password.toLowerCase().includes(actor.login.toLowerCase()) && !password.toLowerCase().includes(actor.staffId.toLowerCase()), 'Do not include the login ID or staff ID in your password.');
    const history = Array.isArray(cred.history) ? cred.history.filter((x): x is string => typeof x === 'string') : [];
    requireThat(![text(cred, 'hash'), ...history].some(h => matches(password, h)), 'Choose a password not used in the last five passwords.');
    const next = { ...cred, hash: hashPassword(password), temporary: false, consumed: false, expires: '', history: [text(cred, 'hash'), ...history].slice(0, num(policy, 'history', 5)) };
    actor.temporary = false; actor.state = 'Active';
    this.store.savePerson(actor, next);
    this.store.update(this.store.get(actor.id), actor.id, {}, 'Active');
    session.restricted = false;
    this.saveSession(session.key, session);
    this.store.audit(actor.id, actor.role, 'auth.passwordChanged', actor.id, null, { personalPasswordSet: true });
  }
  confirm(req: Request) {
    const { actor, session } = this.get(req, true);
    requireThat(!session.restricted && !actor.temporary, 'Set your personal password first.');
    actor.profileConfirmed = true;
    this.store.savePerson(actor);
    this.store.audit(actor.id, actor.role, 'auth.profileConfirmed', actor.id, null, { confirmed: true });
  }
  lock(req: Request, locked: boolean, pin?: string) {
    const { session } = this.get(req, true, true);
    if (!locked) requireThat(pin === '2468', 'That demo PIN was not accepted.');
    session.locked = locked; session.lastAt = this.store.now();
    this.saveSession(session.key, session);
  }
  revokeKey(key: string) { this.store.db.prepare('DELETE FROM sessions WHERE token=?').run(hash(key)); }
  revokeActor(actorId: string) {
    for (const row of this.store.db.prepare('SELECT token,body FROM sessions').all()) {
      if ((JSON.parse(String(row.body)) as Session).actorId === actorId) this.store.db.prepare('DELETE FROM sessions WHERE token=?').run(String(row.token));
    }
  }
}
