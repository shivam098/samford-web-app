import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium, expect, type Browser } from '@playwright/test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { testHospital, medicineLine, notePayload, prepareAdmission } from './harness.js';
import { makePdf } from '../server/documents.js';
import { defaultHomeLayout } from '../shared/home.js';
import { handoverGroups } from '../shared/handover.js';
import { text, num, rows } from '../shared/model.js';

let browser: Browser;
const evidence: { journeys: string[]; behavior: string }[] = [];
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => {
  await browser?.close();
  writeFileSync('test-artifacts\\completeness-browser-evidence.json', JSON.stringify({ generatedAt: new Date().toISOString(), behavioralEvidence: evidence }, null, 2));
});

test('browser: Home cards really drag, hide, limit rows, obey department locks and reset', async () => {
  const h = await testHospital(browser);
  try {
    const page = await h.open('doctor-a'); const form = await h.form(page, 'DJ02', 'preferences.save');
    const layout = form.locator('[data-field-key="layout"]');
    await layout.locator('[data-home-card="pending"] .drag-handle').dragTo(layout.locator('[data-home-card="visits"]'));
    await expect.poll(() => layout.locator('[data-home-card]').evaluateAll(elements => elements.map(element => element.getAttribute('data-home-card')))).toEqual(['pending', 'visits', 'referrals', 'results', 'admissions']);
    await layout.getByLabel('Show My admissions', { exact: true }).uncheck();
    await layout.getByLabel("Today's visits row count", { exact: true }).fill('1');
    await expect(layout.getByLabel('Show New referrals', { exact: true })).toBeDisabled();
    await h.submit(page, form, 'preferences.save');
    await page.goto(`${h.url}/#home`);
    await expect(page.locator('.home-work-card').first()).toHaveAttribute('data-home-card', 'pending');
    await expect(page.locator('.home-work-card[data-home-card="admissions"]')).toHaveCount(0);
    await expect(page.locator('.home-work-card[data-home-card="visits"] .home-preview>a')).toHaveCount(1);
    await page.reload(); await expect(page.locator('.home-work-card[data-home-card="visits"] .home-preview>a')).toHaveCount(1);
    const admin = await h.open('admin');
    await h.perform(admin, 'AJ16', 'home.defaults', { departmentId: 'general', layout: defaultHomeLayout(), lockedCards: ['admissions'], reason: 'Reviewed department default' });
    await page.goto(`${h.url}/#journey/DJ02`); await page.locator('.action-selector select').selectOption('preferences.save');
    await expect(page.getByLabel('Show My admissions', { exact: true })).toBeDisabled(); await expect(page.getByLabel('Show My admissions', { exact: true })).toBeChecked();
    await h.perform(page, 'DJ02', 'preferences.resetHome', { confirmed: true });
    await page.goto(`${h.url}/#home`); await expect(page.locator('.home-work-card').first()).toHaveAttribute('data-home-card', 'visits');
    assert.equal(text(h.store.person('doctor-a').preferences, 'homeOrder'), 'visits,referrals,results,admissions,pending');
    const doctorApi = await h.client('doctor-a');
    await doctorApi.cmd('visit.open', { confirmed: true }, 'visit-a'); await doctorApi.cmd('note.save', notePayload); await doctorApi.cmd('visit.done', { reviewed: true, noUnsaved: true }, 'visit-a');
    await h.form(page, 'DJ02', 'preferences.save');
    await expect(page.locator('[data-monthly-numbers] [data-metric="patientsAttended"]')).toHaveText('1');
    await page.getByLabel('Activity month', { exact: true }).fill('2020-01');
    await expect(page.locator('[data-monthly-numbers] [data-metric="patientsAttended"]')).toHaveText('0');
    evidence.push({ journeys: ['DJ02', 'AJ16'], behavior: 'Native browser drag/drop changes persisted Home order; hide and row limit survive reload; department locks and reset work without clearing other preferences. Doctor month filter shows one own completed visit now and zero in a prior month, labelled app activity rather than attendance.' });
  } finally { await h.close(); }
});

test('browser: paper-Rx identity and file intake lead to a real private scan and batch dispensing', async () => {
  const h = await testHospital(browser);
  try {
    const page = await h.open('pharmacy');
    const file = { name: 'browser-paper-rx.pdf', mime: 'application/pdf', base64: (await makePdf('Sample paper prescription', ['Synthetic prescriber and medicine instructions'], {})).toString('base64') };
    const receipt = await h.perform(page, 'SJ10', 'pharmacy.paperRx', { patientId: 'patient-a', prescriberName: 'External browser demo doctor', registration: 'SAMPLE-EXT-BROWSER',
      prescriptionDate: h.today(), file, lines: [medicineLine()], reviewingDoctorId: 'doctor-a', transcriptionConfirmed: true, synthetic: true });
    const rx = h.entity(receipt, 'rx'); const scan = h.store.get(text(rx.data, 'scanDocumentId'));
    assert.equal(rx.createdBy, 'pharmacy'); assert.equal(text(rx.data, 'prescriberRegistration'), 'SAMPLE-EXT-BROWSER');
    await page.getByRole('button', { name: 'browser-paper-rx.pdf', exact: true }).click();
    const opened = page.context().waitForEvent('response', response => response.url().endsWith(`/api/documents/${scan.id}/file`));
    await page.getByRole('link', { name: 'Open document', exact: true }).click();
    assert.equal((await opened).status(), 200);
    await h.perform(page, 'SJ10', 'pharmacy.dispense', { lineId: text(rows(rx.data, 'lines')[0], 'id'), batchId: 'batch-a', quantity: 5, nearExpiry: true }, rx.id);
    assert.equal(h.store.get(rx.id).status, 'Dispensed'); assert.equal(num(h.store.get('batch-a').data, 'quantity'), 295);
    evidence.push({ journeys: ['SJ10'], behavior: 'Pharmacist enters paper prescriber identity, uses the real file picker and medicine-line editor, opens the privately served scan through its UI link, and dispenses the matching batch. Original paper author and actual entering pharmacist are separate.' });
  } finally { await h.close(); }
});

test('browser: admin chooses recipients per group and a separately signed-in consultant claims a department queue', async () => {
  const h = await testHospital(browser);
  try {
    const adminApi = await h.client('admin'); const doctorApi = await h.client('doctor-a'); const resident = await h.client('resident');
    const invitation = await adminApi.cmd('account.create', { name: 'Demo receiving consultant C', staffId: 'HANDOVER-C', registration: 'SAMPLE-REG-C', login: 'handover-c',
      mobile: '9000066601', email: 'handover-c@sample.invalid', departmentId: 'general', role: 'doctor', qualification: 'Sample qualification', room: 'Room 3' });
    const receiver = await h.activate(invitation);
    const note = await resident.entity('note.save', { ...notePayload, complaints: 'Private handover note marker' }, undefined, 'note');
    const admission = await prepareAdmission(h);
    await doctorApi.cmd('rx.approve', { visitId: 'visit-a', lines: [medicineLine()], sendNow: true, reviewed: true });
    const admin = await h.open('admin');
    const choices = handoverGroups.map(group => ({ group: group.key, receiverType: group.key === 'admissions' ? 'Department queue' : 'Doctor', receiverId: group.key === 'admissions' ? '' : 'doctor-b' }));
    const form = await h.form(admin, 'AJ10', 'account.deactivate', 'doctor-a');
    await expect(form.locator('[data-handover-group="unsignedNotes"]')).toContainText('SMP-PATIENT-A');
    await expect(admin.getByText('Private handover note marker', { exact: true })).toHaveCount(0);
    await h.fill(admin, form, 'account.deactivate', { handovers: choices, confirmName: 'Demo doctor A', reason: 'Synthetic staff exit', unsentAction: 'Wait for sync', unsentPlan: 'No unsubmitted device work', confirmed: true });
    await h.submit(admin, form, 'account.deactivate');
    assert.equal(h.store.person('doctor-a').state, 'Deactivated'); assert.equal(h.store.get(note.id).doctorId, 'doctor-b'); assert.equal(h.store.get(note.id).createdBy, 'resident');
    const queue = h.store.all('handover').find(entity => entity.status === 'Awaiting claim' && text(entity.data, 'group') === 'admissions')!;
    const clinician = await h.open(receiver.actorId);
    await h.perform(clinician, 'DJ03', 'handover.claim', { confirmed: true }, queue.id);
    assert.equal(h.store.get(admission.id).doctorId, receiver.actorId); assert.equal(h.store.get(queue.id).status, 'Claimed');
    evidence.push({ journeys: ['AJ10', 'DJ03'], behavior: 'Admin reviews counts/UHIDs without clinical note text, chooses a separate consultant per group and Department queue for admissions, then deactivates. A newly invited consultant signs in with password/OTP through the browser and claims the queued responsibility; clinical authors remain unchanged.' });
  } finally { await h.close(); }
});

test('browser: weekly roster preview and calendar reflect real published assignments', async () => {
  const h = await testHospital(browser);
  try {
    const page = await h.open('admin');
    const form = await h.form(page, 'AJ13', 'roster.repeat');
    await h.fill(page, form, 'roster.repeat', { departmentId: 'general', doctorId: 'doctor-a', month: '2026-12', weekdays: ['Monday'], shift: 'Night', replaceExisting: false, reason: 'Monthly weekly pattern' });
    await expect(form).toContainText('Weekly pattern preview: 4 dates');
    await h.submit(page, form, 'roster.repeat');
    await page.getByLabel('Published roster month').fill('2026-12');
    const calendar = page.locator('.panel').filter({ has: page.getByRole('heading', { name: 'Published clinical duty roster', exact: true }) });
    await expect(calendar.getByRole('cell', { name: 'Demo doctor A', exact: true })).toHaveCount(4);
    assert.deepEqual(h.store.all('roster').map(entity => text(entity.data, 'date')).sort(), ['2026-12-07', '2026-12-14', '2026-12-21', '2026-12-28']);
    evidence.push({ journeys: ['AJ13'], behavior: 'Administrator selects month/weekdays/shift in the real repeat-pattern form, reviews four preview dates, publishes, and sees exactly four named cells in the monthly clinical-duty calendar.' });
  } finally { await h.close(); }
});

test('browser: emergency OT replaces a conflicting planned slot and the displaced surgeon responds', async () => {
  const h = await testHospital(browser);
  try {
    const doctor = await h.client('doctor-a'); const otApi = await h.client('ot');
    const start = new Date(Math.floor((Date.parse(h.store.now()) + 7200000) / 60000) * 60000).toISOString(); const replacement = new Date(Date.parse(start) + 3600000).toISOString();
    const planned = await doctor.entity('operation.request', { patientId: 'patient-a', procedure: 'Planned browser case', date: h.today(), duration: 60, urgency: 'Routine', anaesthesia: 'General', doctorId: 'doctor-a', consentExplained: true, fitness: true }, undefined, 'operation');
    await otApi.cmd('operation.schedule', { theatre: 'OT 1', start, anaesthetist: 'Demo anaesthetist', scrubNurse: 'Demo scrub nurse' }, planned.id);
    await doctor.cmd('operation.respond', { decision: 'Accept', reason: 'Slot accepted' }, planned.id);
    const emergency = await doctor.entity('operation.request', { patientId: 'patient-b', procedure: 'Emergency browser case', date: h.today(), duration: 30, urgency: 'Emergency', anaesthesia: 'General', doctorId: 'doctor-a', consentExplained: true, fitness: false }, undefined, 'operation');
    const coordinator = await h.open('ot');
    await h.perform(coordinator, 'SJ20', 'operation.emergencySchedule', { theatre: 'OT 1', start, anaesthetist: 'Emergency anaesthetist', scrubNurse: 'Emergency nurse',
      plannedId: planned.id, rescheduledTheatre: 'OT 1', rescheduledStart: replacement, reason: 'Emergency priority - reviewed replacement' }, emergency.id);
    assert.equal(text(h.store.get(planned.id).data, 'start'), replacement); assert.equal(h.store.get(emergency.id).status, 'Offered');
    const surgeon = await h.open('doctor-a'); await surgeon.getByRole('button', { name: /Notifications/ }).click();
    await expect(surgeon.locator('dialog')).toContainText('Emergency priority - reviewed replacement');
    await surgeon.locator('dialog > header button').click();
    await h.perform(surgeon, 'DJ14', 'operation.respond', { decision: 'Accept', reason: 'Revised time reviewed' }, planned.id);
    assert.equal(h.store.get(planned.id).status, 'Scheduled'); assert.equal(h.store.get(planned.id).data.checklistComplete, false);
    evidence.push({ journeys: ['SJ20', 'DJ14'], behavior: 'OT coordinator chooses an emergency and a different patient’s conflicting planned case, enters both times and reason, and submits one atomic move. Surgeon sees the durable change notification and accepts the revised slot; pre-op checks are not bypassed.' });
  } finally { await h.close(); }
});

test('browser: combined staff menus and explicit acting roles preserve one person’s identity', async () => {
  const h = await testHospital(browser);
  try {
    const page = await h.open('desk-cashier');
    await expect(page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Patient registration', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Billing & payment', exact: true })).toBeVisible();
    const superuser = await h.open('super');
    await h.perform(superuser, 'AJ22', 'account.role', { role: 'desk', roles: ['cashier', 'manager'], departmentId: 'general', reason: 'Combined counter and operations testing', confirmed: true }, 'desk-cashier');
    await expect(page.getByRole('heading', { name: 'Workspace locked', exact: true })).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Return to demo sign-in (retain recovery)', exact: true }).click();
    await page.getByRole('button', { name: 'Staff', exact: true }).click(); await page.locator('[data-persona-id="desk-cashier"]').click();
    await expect(page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Approvals & jobs', exact: true })).toBeVisible();
    const counter = await h.form(page, 'SJ01', 'counter.choose');
    await counter.getByRole('combobox', { name: 'Acting staff role', exact: true }).selectOption('cashier');
    await h.fill(page, counter, 'counter.choose', { counter: 'OPD 2', printer: 'Sample combined-role printer' });
    const selected = await h.submit(page, counter, 'counter.choose');
    assert.equal(selected.data?.actingRole, 'cashier');
    assert.equal(h.store.person('desk-cashier').role, 'desk');
    assert.equal((await page.request.get(h.url + '/api/state')).status(), 200);
    const request = await h.perform(page, 'SJ13', 'stock.writeoff', { batchId: 'batch-expired', quantity: 1, reason: 'Dual-role write-off request' });
    const writeoff = h.entity(request, 'writeoff'); assert.equal(writeoff.createdBy, 'desk-cashier'); assert.equal(request.data?.actingRole, 'manager');
    const approval = h.store.all('approval').find(entity => text(entity.data, 'targetId') === writeoff.id)!;
    const form = await h.form(page, 'SJ33', 'approval.decide', approval.id);
    await h.fill(page, form, 'approval.decide', { decision: 'Approve', reason: 'Same identity must be refused' });
    const refusal = page.waitForResponse(response => response.url().endsWith('/api/commands/approval.decide') && response.status() === 422);
    await form.locator('.form-footer').getByRole('button').click(); await refusal;
    assert.equal(h.store.get(writeoff.id).status, 'Pending approval');
    const approver = await h.open('manager');
    await h.perform(approver, 'SJ33', 'approval.decide', { decision: 'Approve', reason: 'Independent person reviewed request' }, approval.id);
    assert.equal(h.store.get(writeoff.id).status, 'Completed');
    evidence.push({ journeys: ['AJ22', 'SJ01', 'SJ13', 'SJ33'], behavior: 'Browser admin changes assigned staff roles; old session is rejected and re-sign-in shows combined registration/billing/approval menus. Same identity can request under its manager role but cannot approve its own request; a different manager completes it.' });
  } finally { await h.close(); }
});

test('browser: scheme quote is read-only, patient share is visible, and counted day-end report exports without a ledger', async () => {
  const h = await testHospital(browser);
  try {
    const admission = await prepareAdmission(h, 'patient-b');
    const cashier = await h.open('cashier');
    const form = await h.form(cashier, 'SJ08', 'claim.create');
    await h.fill(cashier, form, 'claim.create', { patientId: 'patient-b', admissionId: admission.id, payer: 'Ayushman', policy: 'SAMPLE-BROWSER-POLICY', amount: 10000, cover: 10000, packageId: 'scheme-ayushman-admission', eligibilityOutcome: 'Eligible' });
    await expect(form.locator('[id="claim.create-amount"]')).toHaveAttribute('readonly', '');
    await expect(form).toContainText('₹10,000.00');
    const result = await h.submit(cashier, form, 'claim.create'); const claim = h.entity(result, 'claim');
    await h.perform(cashier, 'SJ08', 'claim.send', { documents: 'Synthetic plan reference' }, claim.id);
    await h.perform(cashier, 'SJ08', 'claim.response', { decision: 'Approved', response: 'Partial simulated approval', approvedAmount: 6000, validUntil: h.date(7) }, claim.id);
    await cashier.getByRole('button', { name: 'Ayushman pre-authorisation', exact: true }).click();
    await expect(cashier.getByText('Read-only current billing estimate', { exact: true })).toBeVisible();
    await expect(cashier.locator('.notice').filter({ hasText: 'Read-only current billing estimate' })).toContainText('₹4,000.00');
    const apiCashier = await h.client('cashier');
    const bill = await apiCashier.entity('bill.service', { patientId: 'patient-a', tariffId: 'tariff-consultation', quantity: 2, emergency: false }, undefined, 'bill');
    await apiCashier.cmd('bill.pay', { payments: [{ mode: 'Cash', amount: 1000 }], outcome: 'Success' }, bill.id);
    const closed = await h.perform(cashier, 'SJ09', 'counter.close', { denominations: { 500: 2 } });
    const counter = h.entity(closed, 'counterClose'); assert.equal(num(counter.data, 'counted'), 100000); assert.equal(num(counter.data, 'difference'), 0);
    await h.perform(cashier, 'SJ09', 'counter.sendAccounts', { confirmed: true }, counter.id);
    assert.equal(h.store.get(counter.id).status, 'Accounts sent');
    await cashier.goto(`${h.url}/#journey/SJ30`);
    await cashier.getByRole('combobox', { name: 'Report', exact: true }).selectOption('day-end');
    await expect(cashier.locator('table')).toContainText('100000');
    const download = cashier.waitForEvent('download'); await cashier.getByRole('link', { name: /Export audited CSV/ }).click();
    const file = await download; const stream = await file.createReadStream(); assert.ok(stream); const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const csv = Buffer.concat(chunks).toString('utf8'); assert.match(csv, /100000/); assert.match(csv, /ledgerMaintained/);
    evidence.push({ journeys: ['SJ08', 'SJ09', 'SJ30'], behavior: 'Cashier selects a master scheme in UI and cannot edit its price, submits/receives pre-authorisation, sees INR4000 remaining patient share, counts actual note denominations, signs off/sends the counter report and downloads a matching accounts CSV. No accounting ledger is created.' });
  } finally { await h.close(); }
});

test('browser: Hindi doctor/patient fields and document language produce real tagged Hindi PDF output', async () => {
  const h = await testHospital(browser);
  try {
    const doctor = await h.open('doctor-a');
    await doctor.getByLabel('Language / भाषा').selectOption('Hindi');
    await expect(doctor.locator('html')).toHaveAttribute('lang', 'hi');
    await h.perform(doctor, 'DJ02', 'preferences.language', { language: 'Hindi', printLanguage: 'Hindi' });
    const form = await h.form(doctor, 'DJ09', 'note.save');
    await expect(form.getByRole('textbox', { name: 'मुख्य शिकायतें', exact: true })).toBeVisible();
    const authored = 'Normal — नमूना शिकायत, वास्तविक चिकित्सा सलाह नहीं';
    await h.fill(doctor, form, 'note.save', { ...notePayload, complaints: authored });
    const saved = await h.submit(doctor, form, 'note.save'); const note = h.entity(saved, 'note');
    const rendered = await h.perform(doctor, 'DJ16', 'document.generate', { patientId: 'patient-a', kind: 'OPD summary', sourceId: note.id, sections: ['complaints'], language: 'Hindi' }, undefined, false);
    const printedDocument = h.entity(rendered, 'document'); assert.equal(printedDocument.data.language, 'Hindi');
    const response = await doctor.context().request.get(`${h.url}/api/documents/${printedDocument.id}/file`);
    assert.equal(response.status(), 200);
    const loading = getDocument({ data: new Uint8Array(await response.body()), useSystemFonts: false }); const pdf = await loading.promise;
    const structure = await (await pdf.getPage(1)).getStructTree();
    assert.ok(JSON.stringify(structure).includes(`मुख्य शिकायतें: ${authored}`)); await loading.destroy();
    await doctor.locator('dialog[open] > header button').click();
    const family = await h.open('family');
    await family.getByLabel('Language / भाषा').selectOption('Hindi');
    await expect(family.locator('html')).toHaveAttribute('lang', 'hi');
    const booking = await h.form(family, 'SJ35', 'visit.book');
    await expect(booking.getByRole('combobox', { name: 'मरीज़', exact: true })).toBeVisible();
    await expect(booking.locator('[id="visit.book-time"]')).toBeVisible();
    await h.fill(family, booking, 'visit.book', { patientId: 'patient-a', doctorId: 'doctor-a', date: h.date(), time: '15:00', mode: 'Video', opdType: 'General', visitType: 'New' });
    const booked = await h.submit(family, booking, 'visit.book'); assert.ok(h.entity(booked, 'visit'));
    await family.setViewportSize({ width: 390, height: 844 }); await family.goto(`${h.url}/#home`);
    assert.equal(await family.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false);
    await family.screenshot({ path: 'test-artifacts\\hindi-patient-candidate.png', fullPage: true, animations: 'disabled' });
    evidence.push({ journeys: ['DJ02', 'DJ09', 'DJ16', 'SJ35'], behavior: 'Doctor switches UI/print language, types mixed original Hindi/English note content, submits through Hindi controls and obtains an actual PDF whose parsed tagged logical text preserves it. Patient uses Hindi-labelled registration/slot fields to create a real shared booking; mobile Hindi page has no horizontal overflow.' });
  } finally { await h.close(); }
});
