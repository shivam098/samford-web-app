import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { text, type Actor, type Data } from '../shared/model.js';
import { otpLimits, tokenLifetimes } from '../shared/mobile-contract.js';
import { Store } from './store.js';
import { ApiError, fail } from './api-error.js';
import { ensurePatientFamily } from './auth.js';
import { patientSummary } from './handwriting.js';

export type Principal = { kind: 'DOCTOR' | 'PATIENT'; actor: Actor; tokenHash: string; deviceId: string; expiresAt: string; mobile: string };
export const devicePattern = /^[A-Za-z0-9._:-]{8,128}$/;
export const tokenHashOf = (token: string) => createHash('sha256').update(token).digest('hex');
export const deviceEntityId = (actorId: string, deviceId: string) => `device-tablet-${createHash('sha256').update(`${actorId}\n${deviceId}`).digest('hex').slice(0, 24)}`;
const nowMs = (store: Store) => Date.parse(store.now());

export function issueToken(store: Store, kind: Principal['kind'], actor: Actor, deviceId: string, mobile: string) {
  const token = `smp_${randomBytes(32).toString('base64url')}`;
  const now = store.now();
  const expiresAt = new Date(Date.parse(now) + (kind === 'DOCTOR' ? tokenLifetimes.doctorDays : tokenLifetimes.patientDays) * 86400000).toISOString();
  store.db.prepare('INSERT INTO mobile_tokens(token_hash, kind, actor_id, device_id, mobile, created_at, expires_at, last_used_at, revoked_at) VALUES(?,?,?,?,?,?,?,?,NULL)')
    .run(tokenHashOf(token), kind, actor.id, deviceId, mobile, now, expiresAt, now);
  return { token, expiresAt };
}
export function bearerToken(req: Request): string {
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{10,256})$/i.exec(String(req.headers.authorization ?? ''));
  return match ? match[1] : '';
}
export function requestDeviceId(req: Request): string {
  const deviceId = String(req.headers['x-device-id'] ?? '');
  if (!devicePattern.test(deviceId)) fail(400, 'DEVICE_ID_REQUIRED', 'Send the X-Device-Id header that was used at sign-in.');
  return deviceId;
}
export function authenticate(store: Store, req: Request): Principal {
  const token = bearerToken(req);
  if (!token) fail(401, 'AUTH_REQUIRED', 'Sign in on this device first.');
  const deviceId = requestDeviceId(req);
  const row = store.db.prepare('SELECT kind, actor_id, device_id, mobile, created_at, expires_at, last_used_at, revoked_at FROM mobile_tokens WHERE token_hash=?').get(tokenHashOf(token));
  if (!row) fail(401, 'TOKEN_INVALID', 'This sign-in is no longer valid. Sign in again; unsent work stays on the device.');
  if (String(row.device_id) !== deviceId) fail(401, 'DEVICE_MISMATCH', 'This token belongs to another device. Sign in again on this device.');
  const actor = findActor(store, String(row.actor_id));
  if (!actor || actor.state !== 'Active') fail(401, 'ACCESS_REVOKED', 'This account was suspended or deactivated. Unsent work stays on the device; contact the hospital.');
  if (row.revoked_at) fail(401, 'TOKEN_INVALID', 'This sign-in is no longer valid. Sign in again; unsent work stays on the device.');
  if (String(row.expires_at) <= store.now()) fail(401, 'TOKEN_EXPIRED', 'Your sign-in expired. Sign in again; unsent work stays on the device.');
  const kind = String(row.kind) as Principal['kind'];
  if (kind === 'DOCTOR') {
    const device = store.maybe(deviceEntityId(actor.id, deviceId));
    const signedOutAt = device ? text(device.data, 'requestedAt') : '';
    if (!device || device.status !== 'Active' || (signedOutAt && signedOutAt > String(row.created_at))) {
      fail(401, 'DEVICE_SIGNED_OUT', 'Hospital IT signed out this tablet. Unsent work stays on the device; sign in again or contact IT.');
    }
  }
  const hash = tokenHashOf(token);
  if (nowMs(store) - Date.parse(String(row.last_used_at)) > 60000) store.db.prepare('UPDATE mobile_tokens SET last_used_at=? WHERE token_hash=?').run(store.now(), hash);
  return { kind, actor, tokenHash: hash, deviceId, expiresAt: String(row.expires_at), mobile: String(row.mobile) };
}
function findActor(store: Store, id: string): Actor | undefined {
  const row = store.db.prepare('SELECT body FROM users WHERE id=?').get(id);
  return row ? JSON.parse(String(row.body)) as Actor : undefined;
}
// DELETE /session is idempotent: an already revoked or expired token on the same device still gets 204.
export function revokeSession(store: Store, req: Request) {
  const token = bearerToken(req);
  if (!token) fail(401, 'AUTH_REQUIRED', 'Sign in on this device first.');
  const deviceId = requestDeviceId(req);
  const row = store.db.prepare('SELECT device_id, actor_id, kind FROM mobile_tokens WHERE token_hash=?').get(tokenHashOf(token));
  if (!row) fail(401, 'TOKEN_INVALID', 'This sign-in is not known.');
  if (String(row.device_id) !== deviceId) fail(401, 'DEVICE_MISMATCH', 'This token belongs to another device.');
  const changed = store.db.prepare('UPDATE mobile_tokens SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL').run(store.now(), tokenHashOf(token));
  if (Number(changed.changes)) store.audit(String(row.actor_id), String(row.kind) === 'DOCTOR' ? 'doctor' : 'patient', 'auth.mobileSignOut', String(row.actor_id), null, { deviceRecorded: true });
}
export function personaDto(store: Store, actor: Actor) {
  const account = store.maybe(actor.id)?.data ?? {};
  return { personaId: actor.id, doctorId: actor.id, name: actor.name, qualification: text(account, 'qualification') || 'Sample qualification',
    registrationNo: text(account, 'registration') || `SAMPLE-REG-${actor.id}`, department: text(store.maybe(actor.department)?.data ?? {}, 'name') || actor.department, departmentId: actor.department };
}
export function doctorSignIn(store: Store, demoIds: string[], personaId: string, deviceId: string, deviceName: string | undefined, appVersion: number): Data {
  const actor = demoIds.includes(personaId) ? findActor(store, personaId) : undefined;
  if (!actor || actor.role !== 'doctor' || actor.state !== 'Active') fail(404, 'UNKNOWN_PERSONA', 'Choose an active persona from GET /doctor/personas.');
  const now = store.now(); const id = deviceEntityId(actor.id, deviceId);
  const data = { name: `${actor.name} - ${deviceName?.trim() || 'Samford doctor tablet'}`, actorId: actor.id, deviceId, appVersion, lastSync: now, unsent: 0, kind: 'Doctor tablet (Android)' };
  const device = store.maybe(id);
  if (device) store.update(device, actor.id, data, 'Active');
  else store.put({ id, type: 'device', version: 1, status: 'Active', createdAt: now, updatedAt: now, createdBy: actor.id, updatedBy: actor.id, department: actor.department, data });
  store.create('signin', { actorId: actor.id, deviceId, method: 'Demo persona on doctor tablet (mobile API)', name: actor.name }, actor.id, { department: actor.department, doctorId: actor.id });
  store.audit(actor.id, actor.role, 'auth.signin', actor.id, null, { deviceId, channel: 'Doctor tablet', publicSyntheticDemo: true });
  const { token, expiresAt } = issueToken(store, 'DOCTOR', actor, deviceId, actor.mobile);
  return { token, tokenType: 'Bearer', expiresAt, deviceId, doctor: personaDto(store, actor) };
}

export const otpCodeHash = (challengeId: string, code: string) => createHash('sha256').update(`${challengeId}:${code}`).digest('hex');
const retryAfter = (until: number, now: number) => Math.max(1, Math.ceil((until - now) / 1000));
export function profilesFor(store: Store, mobile: string): Data[] {
  return store.query('patient', 'mobile', mobile).filter(patient => patient.status === 'Active')
    .map(patient => { const summary = patientSummary(patient); return { profileId: summary.patientId, uhid: summary.uhid, name: summary.name, age: summary.age, sex: summary.sex }; })
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function otpRequest(store: Store, mobile: string, deviceId: string, ip: string, relaxed: boolean): Data {
  const now = nowMs(store); const tenMinutes = 600000; const day = 86400000;
  const limits = relaxed ? { cooldown: 0, perTen: 10000, perDay: 100000, perIp: 1000000 } : { cooldown: otpLimits.cooldownSeconds * 1000, perTen: otpLimits.perMobileTenMinutes, perDay: otpLimits.perMobileDay, perIp: otpLimits.perIpTenMinutes };
  store.db.prepare('DELETE FROM mobile_otp WHERE created_at < ?').run(now - 2 * day);
  const lock = store.setting<number>(`patientLock:${mobile}`, 0);
  if (lock > now) fail(429, 'OTP_LOCKED', 'Sign-in for this mobile is locked for 30 minutes after three wrong codes.', { retryAfterSeconds: retryAfter(lock, now) });
  const byIp = store.db.prepare('SELECT created_at FROM mobile_otp WHERE ip=? AND created_at > ? ORDER BY created_at').all(ip, now - tenMinutes).map(row => Number(row.created_at));
  if (byIp.length >= limits.perIp) fail(429, 'OTP_RATE_LIMITED', 'Too many sign-in codes were requested from this network. Wait and try again.', { retryAfterSeconds: retryAfter(byIp[0] + tenMinutes, now) });
  if (!profilesFor(store, mobile).length) fail(404, 'MOBILE_NOT_REGISTERED', 'No synthetic patient is registered with this mobile. Ask the front desk.');
  const recent = store.db.prepare('SELECT created_at FROM mobile_otp WHERE mobile=? AND created_at > ? ORDER BY created_at DESC').all(mobile, now - day).map(row => Number(row.created_at));
  if (recent.length && now - recent[0] < limits.cooldown) fail(429, 'OTP_RATE_LIMITED', `Wait ${retryAfter(recent[0] + limits.cooldown, now)} seconds before requesting another code.`, { retryAfterSeconds: retryAfter(recent[0] + limits.cooldown, now) });
  const lastTen = recent.filter(at => at > now - tenMinutes);
  if (lastTen.length >= limits.perTen) fail(429, 'OTP_RATE_LIMITED', 'Too many codes were requested for this mobile in 10 minutes.', { retryAfterSeconds: retryAfter(Math.min(...lastTen) + tenMinutes, now) });
  if (recent.length >= limits.perDay) fail(429, 'OTP_RATE_LIMITED', 'The daily limit of sign-in codes for this mobile was reached.', { retryAfterSeconds: retryAfter(Math.min(...recent) + day, now) });
  const challengeId = `otp-${randomUUID()}`; const code = String(randomInt(100000, 1000000));
  store.db.prepare('INSERT INTO mobile_otp(id, mobile, ip, device_id, code_hash, created_at, expires_at, failures, consumed) VALUES(?,?,?,?,?,?,?,0,0)')
    .run(challengeId, mobile, ip, deviceId, otpCodeHash(challengeId, code), now, now + otpLimits.ttlSeconds * 1000);
  store.audit('System', 'system', 'patient.mobileOtpRequested', `mobile:${mobile.slice(-4)}`, null, { simulated: true, smsSent: false });
  return { challengeId, expiresAt: new Date(now + otpLimits.ttlSeconds * 1000).toISOString(), resendAfterSeconds: limits.cooldown / 1000, demoCode: code,
    demoNotice: 'SYNTHETIC DEMO ONLY: no SMS was sent. Enter this code to continue. A real deployment must never return the code.' };
}
// Returned instead of thrown when a failed attempt must still be committed (wrong-code counters and locks).
export class CommitThenFail { constructor(public error: ApiError) {} }
export function otpVerify(store: Store, body: { challengeId: string; code: string; deviceId: string; deviceName?: string }): Data | CommitThenFail {
  const now = nowMs(store);
  const row = store.db.prepare('SELECT mobile, device_id, code_hash, expires_at, failures, consumed FROM mobile_otp WHERE id=?').get(body.challengeId);
  if (!row || Number(row.consumed)) fail(401, 'OTP_EXPIRED', 'This code is no longer valid. Request a new code.');
  const mobile = String(row.mobile);
  if (String(row.device_id) !== body.deviceId) fail(401, 'DEVICE_MISMATCH', 'Enter the code on the device that requested it.');
  const lock = store.setting<number>(`patientLock:${mobile}`, 0);
  if (lock > now) fail(429, 'OTP_LOCKED', 'Sign-in for this mobile is locked for 30 minutes after three wrong codes.', { retryAfterSeconds: retryAfter(lock, now) });
  if (Number(row.expires_at) < now) fail(401, 'OTP_EXPIRED', 'This code expired. Request a new code.');
  if (otpCodeHash(body.challengeId, body.code) !== String(row.code_hash)) {
    const failures = Number(row.failures) + 1;
    if (failures >= otpLimits.wrongCodesBeforeLock) {
      store.db.prepare('UPDATE mobile_otp SET failures=?, consumed=1 WHERE id=?').run(failures, body.challengeId);
      store.set(`patientLock:${mobile}`, now + otpLimits.lockMinutes * 60000);
      store.audit('System', 'system', 'patient.mobileOtpLocked', `mobile:${mobile.slice(-4)}`, null, { lockMinutes: otpLimits.lockMinutes }, '', 'Rejected');
      return new CommitThenFail(new ApiError(429, 'OTP_LOCKED', 'Three wrong codes. Sign-in for this mobile is locked for 30 minutes.', { retryAfterSeconds: otpLimits.lockMinutes * 60 }));
    }
    store.db.prepare('UPDATE mobile_otp SET failures=? WHERE id=?').run(failures, body.challengeId);
    return new CommitThenFail(new ApiError(401, 'OTP_INVALID', 'That code was not accepted. Check the code and try again.', { attemptsRemaining: otpLimits.wrongCodesBeforeLock - failures }));
  }
  const profiles = profilesFor(store, mobile);
  if (!profiles.length) fail(401, 'ACCESS_REVOKED', 'No active synthetic patient is registered with this mobile any more.');
  store.db.prepare('UPDATE mobile_otp SET consumed=1 WHERE id=?').run(body.challengeId);
  const account = ensurePatientFamily(store, mobile, profiles.map(profile => text(profile, 'profileId')));
  if (account.state !== 'Active') fail(401, 'ACCESS_REVOKED', 'This patient account was suspended. Contact the hospital.');
  const { token, expiresAt } = issueToken(store, 'PATIENT', account, body.deviceId, mobile);
  store.audit(account.id, 'patient', 'auth.signin', account.id, null, { method: 'Simulated mobile OTP (patient app)', deviceRecorded: true });
  return { token, tokenType: 'Bearer', expiresAt, deviceId: body.deviceId, account: { accountId: account.id, mobileMasked: `******${mobile.slice(-4)}` }, profiles };
}
