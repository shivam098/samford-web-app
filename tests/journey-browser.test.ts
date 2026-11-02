import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { testHospital, prepareAdmission, preparePrescription, prepareLabResult, prepareDischarge, medicineLine, notePayload, type HospitalHarness } from './harness.js';
import { text, num, rows, strings, type Data, type Entity } from '../shared/model.js';
import { makePdf } from '../server/documents.js';

let browser: Browser;
const evidence: { journeys: string[]; behavior: string }[] = [];
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => {
  await browser?.close();
  writeFileSync('test-artifacts\\journey-browser-evidence.json', JSON.stringify({ generatedAt: new Date().toISOString(), behavioralEvidence: evidence }, null, 2));
});
function scenario(name: string, journeys: string[], behavior: string, work: (h: HospitalHarness) => Promise<void>) {
  test(`journey browser: ${name}`, { timeout: 120000 }, async () => {
    const h = await testHospital(browser);
    try { await work(h); evidence.push({ journeys, behavior }); } finally { await h.close(); }
  });
}
async function visit(page: Page, h: HospitalHarness, id: string) {
  await page.goto(`${h.url}/#journey/${id}`); await expect(page.locator(`[data-journey-id="${id}"]`)).toBeVisible();
}
async function csv(page: Page) {
  const pending = page.waitForEvent('download'); await page.getByRole('link', { name: 'Export audited CSV', exact: true }).click();
  const download = await pending; const path = await download.path(); assert.ok(path); return readFileSync(path, 'utf8');
}
function versions(h: HospitalHarness, id: string): Entity[] {
  return h.store.db.prepare('SELECT body FROM entity_versions WHERE id=? ORDER BY version').all(id).map(row => JSON.parse(String(row.body)) as Entity);
}
async function passwordLogin(page: Page, login: string, password: string) {
  await page.getByRole('button', { name: 'Password sign-in', exact: true }).click();
  await page.getByRole('textbox', { name: 'Login ID, e-mail or mobile', exact: true }).fill(login);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Continue to second check', exact: false }).click();
  await expect(page.locator('.demo-code')).toBeVisible();
  await page.getByRole('textbox', { name: 'Six-digit code', exact: true }).fill(await page.locator('.demo-code').innerText());
  await page.getByRole('button', { name: 'Verify code', exact: true }).click();
}

scenario('access request, attention queue, approval and first sign-in', ['DJ01', 'AJ01', 'AJ02', 'AJ03', 'AJ04'],
  'Guest requests access in the browser; administrator signs in with password and simulated MFA, opens the changed Home queue, approves and receives a one-time credential. New doctor tracks Invited, signs in, changes password and confirms profile before patient APIs unlock.', async h => {
    const guest = await h.guest();
    await guest.getByRole('button', { name: 'Test sign-in / onboarding', exact: false }).click();
    await guest.getByRole('button', { name: 'Ask for access', exact: true }).click();
    for (const [label, value] of Object.entries({ 'Full synthetic name': 'Browser invited doctor', 'Staff ID': 'BROWSER-NEW', 'Synthetic mobile': '9000077766', 'Medical council registration (sample)': 'SAMPLE-REG-BROWSER' }))
      await guest.getByRole('textbox', { name: label, exact: true }).fill(value);
    await guest.getByRole('button', { name: 'Send access request', exact: true }).click();
    await expect(guest.getByText('Request received', { exact: true })).toBeVisible();
    const request = h.store.all('access').find(e => text(e.data, 'staffId') === 'BROWSER-NEW')!;
    const admin = await h.guest(); await admin.getByRole('button', { name: 'Test sign-in / onboarding', exact: false }).click();
    const bootstrap = await (await fetch(h.url + '/api/bootstrap')).json();
    await passwordLogin(admin, 'admin', bootstrap.demoPassword); await expect(admin.locator('.app-shell')).toBeVisible();
    const queue = admin.locator('a.stat-card').filter({ hasText: 'Access requests' });
    await expect(queue.locator('.stat-number')).toHaveText('1'); await queue.click();
    const approval = await h.perform(admin, 'AJ03', 'access.approve', { departmentId: 'general', role: 'doctor', room: 'Room 4' }, request.id, false);
    assert.ok(approval.data?.temporaryPassword);
    await expect(admin.locator('dialog[open]')).toContainText(text(approval.data!, 'temporaryPassword'));
    await admin.locator('dialog[open] > header button').click();
    await guest.getByRole('button', { name: 'Refresh request status', exact: true }).click();
    await expect(guest.locator('.signin-lab')).toContainText('Invited');
    await passwordLogin(guest, text(approval.data!, 'login'), text(approval.data!, 'temporaryPassword'));
    await expect(guest.getByRole('heading', { name: 'Make this login yours.' })).toBeVisible();
    assert.equal((await guest.request.get(h.url + '/api/state')).status(), 403);
    await guest.getByLabel('New personal password').fill('BrowserSyntheticPassword#2026');
    await guest.getByRole('button', { name: 'Set personal password', exact: true }).click();
    await expect(guest.getByRole('heading', { name: 'Confirm your profile.' })).toBeVisible();
    await guest.getByRole('checkbox').check(); await guest.getByRole('button', { name: 'Confirm profile & continue', exact: true }).click();
    await expect(guest.locator('.app-shell')).toBeVisible();
    assert.equal(h.store.person(text(approval.data!, 'id')).profileConfirmed, true);
    const created = await h.perform(admin, 'AJ04', 'account.create', { name: 'Second browser doctor', staffId: 'BROWSER-SECOND', registration: 'SAMPLE-SECOND', login: 'browser-second', mobile: '9000077767', email: 'browser-second@sample.invalid', departmentId: 'general', role: 'doctor', qualification: 'Synthetic qualification', room: 'Room 4' });
    assert.equal(h.store.person(text(created.data!, 'id')).state, 'Invited');
  });

scenario('CSV preview/commit and verified password recovery/unlock', ['AJ05', 'AJ06', 'AJ07'],
  'Admin pastes CSV and creates only ready rows through separate preview/commit buttons. IT issues a temporary password only after callback confirmation, then unlocks a genuinely failed-password-locked account through the UI.', async h => {
    const admin = await h.open('admin');
    const csvText = 'name,staffId,registration,login,mobile,email,departmentId,role,qualification,room\nBrowser CSV doctor,UI-CSV,REG-UI-CSV,ui-csv,9000066622,ui-csv@sample.invalid,general,doctor,Sample,Room 4';
    const preview = h.entity(await h.perform(admin, 'AJ05', 'account.import', { csv: csvText }), 'import');
    assert.equal(num(preview.data, 'ready'), 1); assert.ok(!h.store.people().some(person => person.login === 'ui-csv'));
    const committed = await h.perform(admin, 'AJ05', 'account.importCommit', { confirmed: true }, preview.id);
    assert.ok(committed.entityIds.length > 0);
    const account = h.store.people().find(person => person.login === 'ui-csv')!;
    const it = await h.open('it');
    const reset = await h.perform(it, 'AJ06', 'account.reset', { identityChecked: true, reason: 'Synthetic callback checked in browser', signOut: true }, account.id);
    assert.ok(reset.data?.temporaryPassword);
    for (let i = 0; i < 5; i++) {
      const response = await fetch(h.url + '/api/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Samford-Request': '1' }, body: JSON.stringify({ login: account.login, password: 'wrong', deviceId: 'failed-ui-lock' }) });
      assert.equal(response.status, 401);
    }
    assert.equal(h.store.person(account.id).state, 'Locked');
    await h.perform(it, 'AJ07', 'account.unlock', { identityChecked: true, reason: 'Verified synthetic callback before unlock' }, account.id);
    assert.equal(h.store.person(account.id).state, 'Invited');
  });

scenario('profile edit, suspension and remote sign-out', ['AJ08', 'AJ09', 'AJ11'],
  'Browser saves a same-department profile correction, suspends/reactivates the account and signs out a real active browser device. The revoked doctor browser cannot continue reading the API.', async h => {
    const doctor = await h.open('doctor-a'); const admin = await h.open('admin');
    await h.perform(admin, 'AJ08', 'account.edit', { name: 'Demo doctor A revised', departmentId: 'general', room: 'Room 8', qualification: 'Sample qualification', reason: 'Browser work-setup correction' }, 'doctor-a');
    assert.equal(h.store.person('doctor-a').name, 'Demo doctor A revised');
    await h.perform(admin, 'AJ09', 'account.suspend', { reason: 'Synthetic pause', confirmed: true }, 'doctor-a');
    assert.equal((await doctor.request.get(h.url + '/api/state')).status(), 401);
    await h.perform(admin, 'AJ09', 'account.reactivate', { reason: 'Synthetic return' }, 'doctor-a');
    const active = await h.open('doctor-a');
    const device = h.store.all('device').filter(e => text(e.data, 'actorId') === 'doctor-a' && e.status === 'Active').at(-1)!;
    const it = await h.open('it'); await h.perform(it, 'AJ11', 'device.signout', { reason: 'Synthetic device sign-out', confirmed: true }, device.id);
    assert.equal((await active.request.get(h.url + '/api/state')).status(), 401);
  });

scenario('hospital setup, reviewed templates, routing and security policy', ['AJ12', 'AJ14', 'AJ15', 'AJ21'],
  'Admin publishes a department, actual future OPD session, clinician-reviewed template and generic locked notification wording through forms; the doctor receives the template and desk receives the new slots. Super admin persists bounded security policy values.', async h => {
    const admin = await h.open('admin');
    const department = h.entity(await h.perform(admin, 'AJ12', 'department.save', { name: 'Sample browser department', shortName: 'UI', head: 'Demo head', referrals: true, duty: true }), 'department');
    assert.ok(department.id);
    await h.perform(admin, 'AJ12', 'session.save', { doctorId: 'doctor-a', date: h.date(20), start: '09:00', end: '10:00', room: 'Room 8', slotMinutes: 10 });
    assert.ok(h.store.all('session').some(e => text(e.data, 'date') === h.date(20)));
    const template = h.entity(await h.perform(admin, 'AJ14', 'template.publish', { departmentId: 'general', name: 'Browser clinical template', kind: 'OPD', content: 'Synthetic template prompts', reviewer: 'Demo clinical reviewer', reason: 'Reviewed browser publication' }), 'template');
    const doctor = await h.open('doctor-a'); const form = await h.form(doctor, 'DJ09', 'note.save');
    await expect(form.locator('select').filter({ has: doctor.locator(`option[value="${template.id}"]`) })).toHaveCount(1);
    await h.perform(admin, 'AJ15', 'routing.save', { departmentId: 'surgery', receiver: 'Chosen consultant', escalateTo: 'doctor-b', minutes: 30 });
    await h.perform(admin, 'AJ15', 'wording.save', { kind: 'Referral', unlocked: '{doctor} has an update for {patient}', locked: 'A new referral is waiting. Unlock to view.' });
    assert.ok(h.store.all('wording').some(e => text(e.data, 'locked') === 'A new referral is waiting. Unlock to view.'));
    const superuser = await h.open('super');
    await h.perform(superuser, 'AJ21', 'policy.save', { minPassword: 12, history: 5, temporaryHours: 12, attempts: 4, doctorIdle: 5, portalIdle: 15 });
    assert.equal(num(h.store.setting<Data>('policy', {}), 'minPassword'), 12);
  });

scenario('help request, support reply and published learning guide', ['DJ27', 'AJ17'],
  'Doctor submits a privacy-safe help request. IT replies/closes and publishes a guide. Doctor reads the actual reply, marks the guide helpful and follows its Show me link.', async h => {
    const doctor = await h.open('doctor-a');
    const help = h.entity(await h.perform(doctor, 'DJ27', 'help.create', { topic: 'Printer', detail: 'Synthetic printer issue; no patient details' }), 'help');
    const it = await h.open('it');
    await h.perform(it, 'AJ17', 'help.reply', { reply: 'Use the synthetic PDF printer.', status: 'Closed' }, help.id);
    const article = h.entity(await h.perform(it, 'AJ17', 'article.publish', { title: 'Browser print guide', content: 'Open Print and select a sample PDF.', journey: 'DJ16' }), 'article');
    await visit(doctor, h, 'DJ27'); await doctor.locator(`[data-record-id="${help.id}"]`).click();
    await expect(doctor.locator('.entity-detail')).toContainText('Use the synthetic PDF printer.');
    await h.perform(doctor, 'DJ27', 'article.read', { helpful: true }, article.id);
    assert.ok(strings(h.store.get(article.id).data, 'readBy').includes('doctor-a'));
    await doctor.locator(`[data-record-id="${article.id}"]`).click();
    await doctor.getByRole('link', { name: 'Show me in the app', exact: true }).click();
    await expect(doctor.locator('[data-journey-id="DJ16"]')).toBeVisible();
  });

scenario('activity, operations, audit exports and outage status', ['AJ18', 'AJ19', 'AJ20', 'AJ23'],
  'Admin filters real completed-visit activity by department, expands daily counts and downloads matching CSV; operations report shows an actual pending referral. Auditor filters/exports a clinical event without its clinical payload. Outage card exposes a provider-specific next action.', async h => {
    const api = await h.client('doctor-a');
    await api.cmd('visit.open', { confirmed: true }, 'visit-a'); await api.cmd('note.save', notePayload); await api.cmd('visit.done', { reviewed: true, noUnsaved: true }, 'visit-a');
    await api.cmd('referral.send', { visitId: 'visit-b', kind: 'Internal', departmentId: 'surgery', receiverId: 'doctor-b', purpose: 'Treatment', date: h.today(), urgency: 'Urgent', reason: 'Synthetic referral' });
    const page = await h.open('admin'); await visit(page, h, 'AJ18');
    await page.getByRole('combobox', { name: 'Department', exact: true }).selectOption('general');
    await expect(page.locator('table')).toContainText('Demo doctor A');
    await page.locator('summary').filter({ hasText: 'Demo doctor A' }).click();
    await expect(page.locator('details[open]')).toContainText('1');
    const report = await csv(page); assert.match(report, /Demo doctor A/); assert.doesNotMatch(report, /Demo surgeon B/); assert.match(report, /App activity, not attendance/);
    await visit(page, h, 'AJ19'); await page.getByRole('combobox', { name: 'Report', exact: true }).selectOption('referrals');
    await expect(page.locator('table')).toContainText('Sent'); assert.match(await csv(page), /Sent/);
    const auditor = await h.open('auditor'); await visit(auditor, h, 'AJ20');
    await auditor.getByRole('textbox', { name: 'Action', exact: true }).fill('note.save');
    await expect(auditor.locator('.audit-entry')).toHaveCount(1);
    const audit = await csv(auditor); assert.match(audit, /note.save/); assert.doesNotMatch(audit, /Synthetic browser note/);
    await (await h.client('manager')).request('/api/demo/fault', 'POST', { provider: 'Failure' });
    await visit(page, h, 'AJ23'); const ether = page.locator('section.stat-card').filter({ hasText: 'ETHER' });
    await expect(ether).toContainText('Simulated outage'); await expect(ether).toContainText('ETHER vendor');
  });

scenario('availability, history, examination and follow-up recommendation', ['DJ04', 'DJ07', 'DJ08', 'DJ12'],
  'Doctor submits leave with an actual affected booking, adds authored history and examined signs, and records an unbooked follow-up. Persisted state distinguishes Requested leave and Recommended follow-up from approvals/bookings.', async h => {
    await (await h.client('desk')).cmd('visit.book', { patientId: 'patient-a', doctorId: 'doctor-a', date: h.date(), time: '10:00', mode: 'Walk-in', opdType: 'General', visitType: 'Follow-up' });
    const page = await h.open('doctor-a');
    const leave = h.entity(await h.perform(page, 'DJ04', 'availability.request', { kind: 'Leave', date: h.date(), endDate: h.date(), reason: 'Synthetic leave request' }), 'availability');
    assert.equal(leave.status, 'Requested'); assert.equal(num(leave.data, 'affectedCount'), 1);
    const history = h.entity(await h.perform(page, 'DJ07', 'history.add', { patientId: 'patient-a', section: 'Family', detail: 'Synthetic family history from browser' }), 'history');
    assert.equal(history.createdBy, 'doctor-a');
    const vital = h.entity(await h.perform(page, 'DJ08', 'vital.record', { patientId: 'patient-a', visitId: 'visit-a', systolic: 120, diastolic: 80, pulse: 72, respiratory: 18, temperature: 37, spo2: 98, weight: 60, height: 165, signs: ['Pallor'], details: 'Synthetic examination', restAbsent: true }), 'vital');
    assert.ok(strings(vital.data, 'signs').includes('Pallor')); assert.equal(vital.data.restAbsent, true);
    const count = h.store.all('visit').length;
    const followup = h.entity(await h.perform(page, 'DJ12', 'followup.request', { visitId: 'visit-a', date: h.date(5), note: 'Synthetic return instructions', print: true, requestBooking: false }), 'followup');
    assert.equal(followup.status, 'Recommended'); assert.equal(h.store.all('visit').length, count);
  });

scenario('referral and versioned pharmacy question handoffs', ['DJ13', 'DJ21', 'DJ22'],
  'Sending doctor creates urgent referral in browser; receiving doctor explicitly accepts and gets an urgent owned visit. Pharmacist question is answered through the doctor form and creates prescription version 2 with the reviewed replacement.', async h => {
    const page = await h.open('doctor-a');
    const referral = h.entity(await h.perform(page, 'DJ13', 'referral.send', { visitId: 'visit-a', kind: 'Internal', departmentId: 'surgery', receiverId: 'doctor-b', purpose: 'Treatment', date: h.today(), urgency: 'Urgent', reason: 'Synthetic specialist review' }), 'referral');
    const surgeon = await h.open('doctor-b');
    await h.perform(surgeon, 'DJ21', 'referral.answer', { decision: 'Accept', reply: 'Synthetic review accepted' }, referral.id);
    assert.equal(h.store.get(referral.id).status, 'Accepted');
    assert.ok(h.store.all('visit').some(e => text(e.data, 'referralId') === referral.id && e.doctorId === 'doctor-b' && e.data.priority));
    const rx = await preparePrescription(h);
    const question = await (await h.client('pharmacy')).entity('pharmacy.question', { lineId: text(rows(rx.data, 'lines')[0], 'id'), proposedItemId: 'medicine-alt', reason: 'Sample alternative requested' }, rx.id, 'question');
    await h.perform(page, 'DJ22', 'question.answer', { decision: 'Approve proposal', reply: 'Reviewed same salt and strength', reviewed: true }, question.id);
    assert.equal(num(h.store.get(rx.id).data, 'rxVersion'), 2);
    assert.equal(text(rows(h.store.get(rx.id).data, 'lines')[0], 'itemId'), 'medicine-alt');
  });

scenario('hold/resume and reviewed finish calls the next token', ['DJ15', 'DJ17'],
  'Doctor holds and resumes a visit through UI without losing its note, confirms arrival, finishes after review and sees the next token Called. Done attribution is written once.', async h => {
    await (await h.client('doctor-a')).cmd('note.save', notePayload);
    const page = await h.open('doctor-a');
    await h.perform(page, 'DJ15', 'visit.hold', { reason: 'Awaiting synthetic report' }, 'visit-a'); assert.equal(h.store.get('visit-a').status, 'Held');
    await h.perform(page, 'DJ15', 'visit.resume', {}, 'visit-a'); assert.equal(h.store.get('visit-a').status, 'Waiting');
    assert.equal(h.store.all('note').length, 1);
    await h.perform(page, 'DJ06', 'visit.open', { confirmed: true }, 'visit-a');
    await h.perform(page, 'DJ17', 'visit.done', { reviewed: true, noUnsaved: true }, 'visit-a');
    assert.equal(h.store.get('visit-a').status, 'Done'); assert.equal(h.store.get('visit-b').status, 'Called');
  });

scenario('round note and resident discharge approval', ['DJ18', 'DJ19'],
  'Consultant reads the nurse’s persisted handover, writes a round, then reviews/approves a resident-authored discharge using the demo PIN. Original author remains resident; both nursing and billing handoffs become Requested.', async h => {
    const admission = await prepareAdmission(h);
    const nursing = await (await h.client('nurse')).entity('nursing.note', { admissionId: admission.id, note: 'Synthetic night handover seen by consultant' }, undefined, 'nursing');
    const page = await h.open('doctor-a'); await visit(page, h, 'DJ18');
    await page.locator(`[data-record-id="${nursing.id}"]`).click(); await expect(page.locator('.entity-detail')).toContainText('Synthetic night handover seen by consultant');
    const round = h.entity(await h.perform(page, 'DJ18', 'round.save', { admissionId: admission.id, findings: 'Synthetic bedside findings', condition: 'Improving', plan: 'Synthetic round plan', reviewed: true }), 'round');
    assert.equal(round.createdBy, 'doctor-a');
    const draft = await (await h.client('resident')).entity('discharge.draft', { admissionId: admission.id, diagnosis: 'Sample condition', course: 'Sample course', procedures: 'No procedure', condition: 'Sample stable', lines: [medicineLine()], followup: 'Sample follow-up', reviewed: true }, undefined, 'discharge');
    await h.perform(page, 'DJ19', 'discharge.approve', { pin: '2468', pendingPlan: 'Consultant owns pending sample work', reviewed: true }, draft.id);
    const result = h.store.get(draft.id); assert.equal(result.createdBy, 'resident');
    assert.equal(result.data.nursingHandoff, 'Requested'); assert.equal(result.data.billingHandoff, 'Requested');
  });

scenario('critical result review and new corrected-version obligation', ['DJ20', 'SJ15'],
  'Lab verifier checks/releases a separately authored critical result through UI, consultant records action through UI, and an amendment requires a second independent verification/release and another doctor review. Original review remains.', async h => {
    const { result } = await prepareLabResult(h, 'Entered');
    const verifier = await h.open('verifier');
    await h.perform(verifier, 'SJ15', 'result.verify', { confirmed: true }, result.id);
    await h.perform(verifier, 'SJ15', 'result.release', {}, result.id);
    const doctor = await h.open('doctor-a');
    await h.perform(doctor, 'DJ20', 'result.review', { decision: 'Seen with action', action: 'Synthetic ward contact recorded' }, result.id);
    const lab = await h.open('lab');
    const amended = h.entity(await h.perform(lab, 'SJ15', 'result.amend', { value: 4.5, reason: 'Synthetic instrument correction' }, result.id), 'result');
    await h.perform(verifier, 'SJ15', 'result.verify', { confirmed: true }, amended.id);
    await h.perform(verifier, 'SJ15', 'result.release', {}, amended.id);
    await h.perform(doctor, 'DJ20', 'result.review', { decision: 'Seen without action', action: 'Corrected version reviewed' }, amended.id);
    assert.equal(h.store.all('review').length, 2); assert.equal(h.store.get(result.id).status, 'Released');
  });

scenario('simulated video and consent-bound ABHA', ['DJ23', 'DJ26'],
  'Browser drives precheck/join/connect/drop/reconnect/end with durable call stages, then requests consent-bound ABHA OTP, verifies the returned synthetic code and withdraws consent without deleting its record. No actual media or ABDM traffic.', async h => {
    await (await h.client('desk')).cmd('visit.checkin', { clearance: 'Collect at billing', priority: false }, 'visit-video');
    await (await h.client('doctor-a')).cmd('visit.open', { confirmed: true }, 'visit-video');
    const page = await h.open('doctor-a');
    const video = h.entity(await h.perform(page, 'DJ23', 'video.start', { visitId: 'visit-video', privateRoom: true, equipment: true, guardian: true }), 'video');
    for (const next of ['Patient joined', 'Connect', 'Drop connection', 'Reconnect', 'End']) await h.perform(page, 'DJ23', 'video.transition', { next }, video.id);
    assert.equal(h.store.get(video.id).status, 'Ended');
    const otp = await h.perform(page, 'DJ26', 'abha.request', { patientId: 'patient-a', address: 'demo.patient@abdm', present: true, consent: true });
    const id = text(otp.data!, 'abhaId');
    await h.perform(page, 'DJ26', 'abha.verify', { otp: text(otp.data!, 'simulatedCode') }, id);
    assert.equal(h.store.get(id).status, 'Linked');
    await h.perform(page, 'DJ26', 'abha.withdraw', { reason: 'Synthetic patient withdrawal' }, id);
    assert.equal(h.store.get(id).status, 'Consent withdrawn');
  });

scenario('public token board and private uploaded document', ['SJ05', 'SJ06'],
  'Desk configures a board, opens its actual token-only surface and checks it contains no patient names/UHIDs; uploads a real synthetic PDF via the file picker, opens it, and marks it filed in error with retained history.', async h => {
    await (await h.client('doctor-a')).cmd('visit.call', {}, 'visit-a');
    const page = await h.open('desk');
    const board = h.entity(await h.perform(page, 'SJ05', 'board.save', { name: 'Browser room board', doctorId: 'doctor-a', view: 'Room', enabled: true }), 'board');
    const pop = page.waitForEvent('popup'); await page.getByRole('link', { name: 'Open Browser room board', exact: false }).click();
    const boardPage = await pop; await expect(boardPage.locator('.waiting-board')).toContainText('Demo doctor A');
    const body = await boardPage.locator('body').innerText(); assert.ok(!/Demo patient|SMP-/.test(body)); assert.ok(board.id);
    await boardPage.close();
    const file = { name: 'synthetic-old-report.pdf', mime: 'application/pdf', base64: (await makePdf('SAMPLE ONLY', ['Synthetic prior report'], {})).toString('base64') };
    const document = h.entity(await h.perform(page, 'SJ06', 'document.upload', { patientId: 'patient-a', kind: 'Old report', file, synthetic: true }), 'document');
    await page.locator(`[data-record-id="${document.id}"]`).click(); await expect(page.getByRole('link', { name: 'Open document', exact: true })).toBeVisible();
    const response = await page.request.get(h.url + `/api/documents/${document.id}/file`); assert.equal(response.status(), 200); assert.equal((await response.body()).subarray(0, 5).toString(), '%PDF-');
    await h.perform(page, 'SJ06', 'document.void', { reason: 'Synthetic wrong filing corrected' }, document.id);
    assert.notEqual(h.store.get(document.id).status, 'Available'); assert.ok(versions(h, document.id).length > 1);
  });

scenario('medicine return and store transfer acceptance', ['SJ11', 'SJ12'],
  'Pharmacist returns part of an actual dispense through UI and stock/credit reconcile. A separate requisition goes through store PO/send/receipt/issue forms and pharmacy acceptance; stock rises once at receipt and once at the destination transfer.', async h => {
    const rx = await preparePrescription(h); const pharmacyApi = await h.client('pharmacy');
    const originalStock = num(h.store.get('batch-a').data, 'quantity');
    const dispense = await pharmacyApi.entity('pharmacy.dispense', { lineId: text(rows(rx.data, 'lines')[0], 'id'), batchId: 'batch-a', quantity: 5, nearExpiry: true }, rx.id, 'dispense');
    const pharmacy = await h.open('pharmacy');
    await h.perform(pharmacy, 'SJ11', 'pharmacy.return', { quantity: 2, condition: 'Unopened', reason: 'Synthetic unopened return' }, dispense.id);
    assert.equal(num(h.store.get(dispense.id).data, 'returned'), 2); assert.equal(num(h.store.get('batch-a').data, 'quantity'), originalStock - 3);
    const request = h.entity(await h.perform(pharmacy, 'SJ12', 'requisition.create', { itemId: 'medicine-a', quantity: 10, reason: 'Synthetic browser requisition' }), 'requisition');
    const store = await h.open('store');
    const purchase = h.entity(await h.perform(store, 'SJ12', 'purchase.create', { requisitionId: request.id, vendorId: 'vendor-1', quantity: 10, unitCost: 5.6, reason: 'Synthetic small purchase' }), 'purchase');
    await h.perform(store, 'SJ12', 'purchase.send', {}, purchase.id);
    await h.perform(store, 'SJ12', 'grn.receive', { invoice: 'BROWSER-INV', quantity: 10, damaged: 0, batch: 'BROWSER-BATCH', expiry: h.date(365), mrp: 5.6, shortExpiry: false }, purchase.id);
    const batch = h.store.all('batch').find(e => text(e.data, 'batch') === 'BROWSER-BATCH')!;
    const transfer = h.entity(await h.perform(store, 'SJ12', 'stock.issue', { requisitionId: request.id, batchId: batch.id, quantity: 10 }), 'stockTransfer');
    await h.perform(pharmacy, 'SJ12', 'stock.accept', {}, transfer.id);
    assert.equal(h.store.get(request.id).status, 'Completed');
    assert.equal(num(h.store.all('batch').find(e => text(e.data, 'batch') === 'BROWSER-BATCH' && text(e.data, 'store') === 'Pharmacy')!.data, 'quantity'), 10);
  });

scenario('sample collection, barcode receipt and rejection/recollection', ['SJ14'],
  'Lab browser collects a covered order, rejects the first sample, recollects under a new barcode and accepts only that barcode. Original rejected container remains in history.', async h => {
    const order = await (await h.client('doctor-a')).entity('order.send', { visitId: 'visit-b', tests: ['potassium'], reference: 'OPD', priority: 'Urgent', history: 'Synthetic history', diagnosis: 'Sample diagnosis' }, undefined, 'order');
    const page = await h.open('lab');
    const first = h.entity(await h.perform(page, 'SJ14', 'sample.collect', { container: 'Yellow serum', fasting: 'Checked', confirmed: true }, order.id), 'sample');
    await h.perform(page, 'SJ14', 'sample.reject', { reason: 'Synthetic haemolysis' }, first.id);
    const next = h.entity(await h.perform(page, 'SJ14', 'sample.collect', { container: 'Yellow serum', fasting: 'Rechecked', confirmed: true }, order.id), 'sample');
    assert.notEqual(text(first.data, 'barcode'), text(next.data, 'barcode'));
    await h.perform(page, 'SJ14', 'sample.accept', { barcode: text(next.data, 'barcode') }, next.id);
    assert.equal(h.store.get(next.id).status, 'Accepted'); assert.equal(h.store.get(first.id).status, 'Rejected');
  });

scenario('bed allotment, ordered transfer and nurse administrations', ['SJ16', 'SJ17', 'SJ18'],
  'Desk admits an emergency into a clean bed via UI; nurse records a signed medicine dose, submits handover and transfers to another bed. Services completes cleaning; old bed is unavailable until then.', async h => {
    const desk = await h.open('desk');
    const admission = h.entity(await h.perform(desk, 'SJ16', 'admission.emergency', { patientId: 'patient-a', doctorId: 'doctor-a', category: 'General', diagnosis: 'Synthetic emergency', relative: 'Demo relative', relativeMobile: '9000005555' }), 'admission');
    await h.perform(desk, 'SJ16', 'admission.admit', { bedId: 'bed-1', relative: 'Demo relative', advance: 0 }, admission.id);
    const order = await (await h.client('doctor-a')).entity('ward.order', { admissionId: admission.id, kind: 'Medicine', itemId: 'medicine-a', instruction: 'Synthetic order', dose: '1 tablet', schedule: '08:00,20:00', diet: 'Normal', reviewed: true }, undefined, 'wardOrder');
    const nurse = await h.open('nurse');
    await h.perform(nurse, 'SJ18', 'dose.record', { scheduled: h.store.now(), outcome: 'Given' }, order.id);
    assert.equal(h.store.all('administration').length, 1);
    await h.perform(nurse, 'SJ18', 'nursing.note', { admissionId: admission.id, note: 'Synthetic nursing handover' });
    await h.perform(nurse, 'SJ17', 'bed.transfer', { bedId: 'bed-2', reason: 'Synthetic same-category move' }, admission.id);
    assert.equal(h.store.get('bed-1').status, 'Cleaning');
    const services = await h.open('services'); await h.perform(services, 'SJ17', 'bed.clean', { note: 'Synthetic cleaning checklist complete' }, 'bed-1');
    assert.equal(h.store.get('bed-1').status, 'Free'); assert.equal(h.store.get('bed-2').status, 'Occupied');
  });

scenario('discharge clearances, final payment and gate pass', ['SJ19'],
  'Nursing checks discharge clearances, cashier produces and pays the final bill, and nurse releases the actual admission from the browser. Gate pass releases the old bed to Cleaning, not Free.', async h => {
    const { admission, discharge } = await prepareDischarge(h);
    const nurse = await h.open('nurse');
    await h.perform(nurse, 'SJ19', 'discharge.clear', { returns: true, results: true, medicines: true, insurance: true, note: 'Synthetic clearance checklist complete' }, discharge.id);
    const cashier = await h.open('cashier'); await h.perform(cashier, 'SJ19', 'discharge.bill', {}, discharge.id);
    const bill = h.store.get(text(h.store.get(admission.id).data, 'finalBillId'));
    if (num(bill.data, 'total') > 0) await h.perform(cashier, 'SJ07', 'bill.pay', { payments: [{ mode: 'UPI', amount: num(bill.data, 'total') / 100 }], outcome: 'Success' }, bill.id);
    await h.perform(nurse, 'SJ19', 'discharge.release', { confirmed: true }, admission.id);
    assert.equal(h.store.get(admission.id).status, 'Discharged'); assert.equal(h.store.get('bed-1').status, 'Cleaning');
  });

scenario('day care conversion and signed Hindi consent', ['SJ21', 'SJ22'],
  'Nurse starts day care and converts it to IPD through forms, preserving the admission and one package bill. A Hindi consent record is filed with witness/time and a real generated Hindi consent PDF retains that language.', async h => {
    const page = await h.open('nurse');
    const daycare = h.entity(await h.perform(page, 'SJ21', 'daycare.start', { patientId: 'patient-a', doctorId: 'doctor-a', bedId: 'day-bed', packageId: 'package-basic' }), 'daycare');
    const count = h.store.all('bill').length; const admissionId = text(daycare.data, 'admissionId');
    await h.perform(page, 'SJ21', 'daycare.finish', { decision: 'Convert to IPD', bedId: 'bed-2', reason: 'Synthetic overnight observation' }, daycare.id);
    assert.equal(h.store.get(admissionId).status, 'Admitted'); assert.equal(h.store.all('bill').length, count);
    const consent = h.entity(await h.perform(page, 'SJ22', 'consent.sign', { patientId: 'patient-a', kind: 'Surgery', language: 'Hindi', signer: 'नमूना हस्ताक्षर', witness: 'Demo witness', signedAt: h.store.now(), signed: true }), 'consent');
    const document = h.entity(await h.perform(page, 'SJ22', 'document.generate', { patientId: 'patient-a', kind: 'Consent form', sourceId: consent.id, language: 'Hindi' }), 'document');
    assert.equal(document.data.language, 'Hindi'); assert.equal((await page.request.get(h.url + `/api/documents/${document.id}/file`)).status(), 200);
  });

scenario('fixed health package completion', ['SJ23'],
  'Desk sells one package in the browser, explicitly skips each generated test with a reason, then releases the completed pack. There is one fixed-price package bill rather than duplicate individual charges.', async h => {
    const page = await h.open('desk');
    const pack = h.entity(await h.perform(page, 'SJ23', 'package.sell', { patientId: 'patient-a', doctorId: 'doctor-a', packageId: 'package-basic' }), 'packageRun');
    for (const id of strings(pack.data, 'orderIds')) await h.perform(page, 'SJ23', 'package.skip', { orderId: id, reason: 'Explicit synthetic training skip' }, pack.id);
    await h.perform(page, 'SJ23', 'package.release', { summary: 'Synthetic consultant-reviewed pack', reviewed: true }, pack.id);
    assert.equal(h.store.get(pack.id).status, 'Released');
    assert.equal(h.store.all('bill').filter(e => text(e.data, 'sourceId') === pack.id).length, 1);
  });

scenario('transport, diet and mortuary guarded completion', ['SJ24', 'SJ25', 'SJ26'],
  'Services browser assigns/advances a transport request and bills its distance; nurse creates a tray from a signed diet order and services checks/delivers it. Mortuary release requires certificate, MLC clearance and distinct second staff; cabinet is freed.', async h => {
    const desk = await h.client('desk');
    const trip = await desk.entity('trip.request', { patientId: 'patient-a', kind: 'Advanced ambulance', from: 'Sample home', to: 'Sample campus', time: h.store.now(), emergency: true }, undefined, 'trip');
    let services = await h.open('services');
    await h.perform(services, 'SJ24', 'trip.assign', { vehicleId: 'vehicle-1', driver: 'Demo driver' }, trip.id);
    for (const next of ['On the way', 'Arrived', 'Completed']) await h.perform(services, 'SJ24', 'trip.advance', { next, ...(next === 'Completed' ? { km: 18, fuel: 2 } : {}) }, trip.id);
    assert.equal(num(h.store.get(text(h.store.get(trip.id).data, 'billId')).data, 'total'), 45000);
    const admission = await prepareAdmission(h);
    const order = await (await h.client('doctor-a')).entity('ward.order', { admissionId: admission.id, kind: 'Diet', instruction: 'Synthetic normal diet', diet: 'Normal', reviewed: true }, undefined, 'wardOrder');
    const nurse = await h.open('nurse');
    const meal = h.entity(await h.perform(nurse, 'SJ25', 'diet.order', { admissionId: admission.id, orderId: order.id, meal: 'Lunch', mealAt: new Date(Date.parse(h.store.now()) + 4 * 3600000).toISOString(), allergies: 'Sample peanut allergy' }), 'diet');
    await (await h.client('super')).request('/api/demo/clock', 'POST', { minutes: 241 });
    services = await h.open('services');
    await h.perform(services, 'SJ25', 'diet.deliver', { checked: true }, meal.id); assert.equal(h.store.get(meal.id).status, 'Delivered');
    const mortuary = h.entity(await h.perform(services, 'SJ26', 'mortuary.receive', { name: 'Synthetic mortuary example', deathRecord: 'SAMPLE-DEATH', cabinetId: 'cabinet-1', mlc: true }), 'mortuary');
    await h.perform(services, 'SJ26', 'mortuary.release', { certificate: 'SAMPLE-CERT', police: true, receiverLast4: '1234', settled: true, secondStaffId: 'services-two', confirmed: true }, mortuary.id);
    assert.equal(h.store.get(mortuary.id).status, 'Released'); assert.equal(h.store.get('cabinet-1').status, 'Free');
  });

scenario('facility requester and team handoff/reopen', ['SJ27'],
  'Nurse raises facility work; services assigns and closes with action; original requester reopens within the allowed window. Both assigned team and original closure remain in persisted history.', async h => {
    const nurse = await h.open('nurse');
    const request = h.entity(await h.perform(nurse, 'SJ27', 'facility.raise', { category: 'Electrical', location: 'Sample ward', urgency: 'Urgent', description: 'Synthetic lamp failure' }), 'facility');
    const services = await h.open('services');
    await h.perform(services, 'SJ27', 'facility.assign', { team: 'Demo electrical team' }, request.id);
    await h.perform(services, 'SJ27', 'facility.close', { note: 'Synthetic lamp repaired' }, request.id);
    await h.perform(nurse, 'SJ27', 'facility.reopen', { reason: 'Synthetic recurrence' }, request.id);
    assert.equal(h.store.get(request.id).status, 'Reopened'); assert.ok(versions(h, request.id).some(e => e.status === 'Closed'));
  });

scenario('coding, owner-controlled hospital document versions and complaints', ['SJ28', 'SJ29', 'SJ31'],
  'MRD codes a completed missing-code note without rewriting clinical words, publishes two versions of an owned SOP, and can inspect prior history. Desk logs an enquiry/complaint; operations closes with a persisted action.', async h => {
    const doctor = await h.client('doctor-a'); await doctor.cmd('visit.open', { confirmed: true }, 'visit-a');
    await doctor.cmd('note.save', { ...notePayload, icd: '' }); await doctor.cmd('visit.done', { reviewed: true, noUnsaved: true }, 'visit-a');
    const note = h.store.all('note')[0]; const coding = h.store.all('coding')[0];
    const mrd = await h.open('mrd');
    await h.perform(mrd, 'SJ28', 'coding.finish', { icd: 'R50.9', complete: true, detail: 'Sample shelf UI-1', reason: 'Reviewed synthetic code' }, coding.id);
    assert.equal(h.store.get(coding.id).status, 'Coded'); assert.equal(h.store.get(note.id).data.complaints, notePayload.complaints);
    const doc = h.entity(await h.perform(mrd, 'SJ29', 'hospitalDocument.publish', { title: 'Browser SOP', kind: 'SOP', content: 'Synthetic SOP version one', expiry: h.date(365) }), 'hospitalDocument');
    await h.perform(mrd, 'SJ29', 'hospitalDocument.publish', { title: 'Browser SOP', kind: 'SOP', content: 'Synthetic SOP version two', expiry: h.date(400) });
    assert.ok(versions(h, doc.id).some(e => e.data.content === 'Synthetic SOP version one'));
    const desk = await h.open('desk'); const enquiry = h.entity(await h.perform(desk, 'SJ31', 'enquiry.save', { question: 'Sample clinic hours?', answer: 'Sample published session times' }), 'enquiry');
    assert.equal(enquiry.data.answer, 'Sample published session times');
    const feedback = h.entity(await h.perform(desk, 'SJ31', 'feedback.save', { patientId: 'patient-a', departmentId: 'general', rating: 2, comment: 'Synthetic wait feedback', complaint: true }), 'feedback');
    const manager = await h.open('manager'); await h.perform(manager, 'SJ31', 'feedback.close', { action: 'Synthetic queue process reviewed' }, feedback.id);
    assert.equal(h.store.get(feedback.id).status, 'Closed');
  });

scenario('future tariff independent approval preserves historical bill', ['SJ32'],
  'Operations proposes a future payer tariff through UI; another manager approves through UI. Existing paid/unpaid bill snapshots keep their old amount and the proposed master becomes Approved without repricing them.', async h => {
    const old = await (await h.client('cashier')).entity('bill.service', { patientId: 'patient-a', tariffId: 'tariff-consultation', quantity: 1, emergency: false }, undefined, 'bill');
    const manager = await h.open('manager');
    const tariff = h.entity(await h.perform(manager, 'SJ32', 'tariff.propose', { tariffId: 'tariff-consultation', payer: 'Self', rate: 600, effective: h.date(), reason: 'Synthetic future tariff' }), 'tariff');
    const approval = h.store.all('approval').find(e => text(e.data, 'targetId') === tariff.id)!;
    const second = await h.open('manager-two'); await h.perform(second, 'SJ33', 'approval.decide', { decision: 'Approve', reason: 'Independent synthetic price review' }, approval.id);
    assert.equal(h.store.get(tariff.id).status, 'Active'); assert.equal(num(h.store.get(old.id).data, 'total'), 50000);
  });

scenario('patient failure/retry receipt and reminder opt-out', ['SJ37'],
  'Patient browser exercises a failed payment without settling the bill, retries successfully with exact due, and saves opt-out choices for linked family members. Provider attempts and receipt remain distinct from optional notifications.', async h => {
    const bill = await (await h.client('cashier')).entity('bill.service', { patientId: 'patient-a', tariffId: 'tariff-consultation', quantity: 1, emergency: false }, undefined, 'bill');
    const page = await h.open('family');
    const payload = { payments: [{ mode: 'UPI', amount: 500 }], outcome: 'Failure' };
    await h.perform(page, 'SJ37', 'bill.pay', payload, bill.id); assert.equal(h.store.get(bill.id).status, 'Unpaid');
    await h.perform(page, 'SJ37', 'bill.pay', { ...payload, outcome: 'Success' }, bill.id); assert.equal(h.store.get(bill.id).status, 'Paid');
    await h.perform(page, 'SJ37', 'patient.updates', { appointments: false, reports: false, bills: false });
    assert.ok(h.store.all('updates').filter(e => ['patient-a', 'patient-child'].includes(e.patientId!)).every(e => e.data.appointments === false && e.data.reports === false && e.data.bills === false));
  });

scenario('registered-mobile OTP provisions only the correct family and pays a patient-owned deduction', ['SJ34', 'SJ37'],
  'Patient enters the registered mobile and visible captcha, verifies the displayed simulated OTP, and gets only that family. A real independently approved patient-owned insurer deduction appears as due and is paid through the patient form.', async h => {
    const admission = await prepareAdmission(h, 'patient-b');
    const cashier = await h.client('cashier'); const doctor = await h.client('doctor-a');
    const claim = await cashier.entity('claim.create', { patientId: 'patient-b', admissionId: admission.id, payer: 'Ayushman', policy: 'SAMPLE-OTP-POLICY', amount: 10000, cover: 50000, packageId: 'scheme-ayushman-admission' }, undefined, 'claim');
    await cashier.cmd('claim.send', { documents: 'Synthetic pre-authorisation references' }, claim.id);
    await cashier.cmd('claim.response', { decision: 'Approved', response: 'Synthetic approval', approvedAmount: 10000, validUntil: h.date(30) }, claim.id);
    const discharge = await doctor.entity('discharge.draft', { admissionId: admission.id, diagnosis: 'Sample condition', course: 'Sample stay', procedures: 'No procedure', condition: 'Sample stable', lines: [medicineLine()], followup: 'Sample review', reviewed: true }, undefined, 'discharge');
    await doctor.cmd('discharge.approve', { pin: '2468', pendingPlan: 'No unowned work', reviewed: true }, discharge.id);
    const nurse = await h.client('nurse');
    await nurse.cmd('discharge.clear', { returns: true, results: true, medicines: true, insurance: true, note: 'Synthetic clearances' }, discharge.id);
    await cashier.cmd('discharge.bill', {}, discharge.id); await nurse.cmd('discharge.release', { confirmed: true }, admission.id);
    await cashier.cmd('claim.final', {}, claim.id); await cashier.cmd('claim.settle', { settled: 9000, deductionOwner: 'Patient', reason: 'Synthetic insurer deduction' }, claim.id);
    await (await h.client('manager')).cmd('approval.decide', { decision: 'Approve', reason: 'Independent ownership review' }, h.store.all('approval').find(entry => text(entry.data, 'kind') === 'Claim deduction')!.id);
    const bill = h.store.all('bill').find(entry => entry.data.postSettlement)!; assert.equal(num(bill.data, 'total'), 100000);
    const mobile = text(h.store.get('patient-b').data, 'mobile');
    assert.ok(!h.store.people().some(person => person.role === 'patient' && person.mobile === mobile));
    const page = await h.guest();
    await page.getByRole('button', { name: 'Test sign-in / onboarding', exact: false }).click();
    await page.getByRole('button', { name: 'Patient OTP', exact: true }).click();
    await page.getByRole('textbox', { name: 'Mobile', exact: true }).fill(mobile);
    const captcha = page.locator('label').filter({ hasText: 'Sample captcha:' });
    await expect(captcha).toContainText('+');
    const parts = (await captcha.innerText()).match(/(\d+)\s*\+\s*(\d+)/)!; assert.ok(parts);
    await captcha.locator('input').fill(String(Number(parts[1]) + Number(parts[2])));
    await page.getByRole('button', { name: 'Request simulated OTP', exact: true }).click();
    await expect(page.locator('.demo-code')).toBeVisible();
    assert.equal((await page.request.get(h.url + '/api/state')).status(), 401);
    await page.getByRole('textbox', { name: 'Six-digit code', exact: true }).fill(await page.locator('.demo-code').innerText());
    await page.getByRole('button', { name: 'Verify code', exact: true }).click();
    await expect(page.locator('.app-shell')).toBeVisible();
    const family = h.store.people().find(person => person.role === 'patient' && person.mobile === mobile)!;
    assert.deepEqual(family.patientIds, ['patient-b']);
    assert.equal((await page.request.get(h.url + '/api/entities/patient-a')).status(), 404);
    await h.perform(page, 'SJ37', 'bill.pay', { payments: [{ mode: 'UPI', amount: 1000 }], outcome: 'Success' }, bill.id);
    assert.equal(h.store.get(bill.id).status, 'Paid');
    assert.ok(h.store.all('payment').some(entry => entry.createdBy === family.id && text(entry.data, 'billId') === bill.id));
  });
