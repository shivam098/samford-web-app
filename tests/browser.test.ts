import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, expect, type Page, type Locator } from '@playwright/test';
import type { Server } from 'node:http';
import { createApplication } from '../server/app.js';
import { journeys } from '../shared/journeys.js';
import { commands } from '../shared/commands.js';
import { text, num, rows, type Data, type Role } from '../shared/model.js';

mkdirSync('test-artifacts', { recursive: true });
const evidence: { journeys: string[]; behavior: string }[] = [];
const rendered = new Set<string>();
after(() => writeFileSync('test-artifacts\\browser-evidence.json', JSON.stringify({ generatedAt: new Date().toISOString(), behavioralEvidence: evidence, renderedJourneys: [...rendered].sort(), note: 'Rendered journeys are UI smoke evidence only; do not treat them as behavioral workflow proof.' }, null, 2)));
async function fixture() {
  const dir = mkdtempSync(join(resolve('test-artifacts'), 'browser-'));
  const runtime = createApplication({ database: join(dir, 'test.sqlite'), test: true });
  const server: Server = await new Promise(resolve => { const server = runtime.app.listen(0, '127.0.0.1', () => resolve(server)); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const failures: string[] = [];
  async function page(persona?: string, viewport = { width: 1440, height: 1000 }) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.on('pageerror', e => failures.push(e.message));
    page.on('console', message => { if (/Content Security Policy|Refused to/.test(message.text())) failures.push(message.text()); });
    await page.goto(url); await expect(page.getByRole('heading', { name: 'Step into a demo role.' })).toBeVisible();
    if (persona) {
      const actor = runtime.store.person(persona);
      const portal = ['doctor', 'resident'].includes(actor.role) ? 'Doctor' : ['superadmin', 'admin', 'head', 'it', 'auditor'].includes(actor.role) ? 'Administration' : actor.role === 'patient' ? 'Patient' : 'Staff';
      await page.getByRole('button', { name: portal, exact: true }).click();
      await page.getByRole('button', { name: new RegExp(actor.name) }).click();
      await expect(page.locator('.app-shell')).toBeVisible();
    }
    return { page, context };
  }
  async function go(page: Page, journey: string, command: string, target?: string): Promise<Locator> {
    await page.goto(`${url}/#journey/${journey}`);
    await expect(page.getByRole('heading', { name: journeys.find(j => j.id === journey)!.title, exact: true }).first()).toBeVisible();
    const picker = page.locator('.action-selector select');
    await picker.selectOption(command);
    const form = page.locator(`form[data-command="${command}"]`);
    await expect(form).toBeVisible();
    if (target) await form.getByLabel('Work item', { exact: true }).selectOption(target);
    return form;
  }
  async function fill(form: Locator, command: string, values: Data) {
    for (const [key, value] of Object.entries(values)) {
      const control = form.locator(`[id="${command}-${key}"]`);
      if (key === 'time' && ['visit.book', 'visit.move', 'followup.book'].includes(command)) await form.locator(`select[id="${command}-${key}"]`).waitFor();
      const tag = await control.evaluate(el => el.tagName.toLowerCase());
      if (typeof value === 'boolean') await control.setChecked(value);
      else if (tag === 'select') await control.selectOption(String(value));
      else await control.fill(String(value));
    }
  }
  async function send(page: Page, form: Locator, command: string, expected = 200) {
    const response = page.waitForResponse(response => response.url().endsWith(`/api/commands/${command}`) && response.request().method() === 'POST');
    await form.getByRole('button', { name: commands.find(c => c.name === command)!.label, exact: true }).click();
    const result = await response;
    const body = await result.json();
    assert.equal(result.status(), expected, `${command}: ${JSON.stringify(body)}`);
    if (expected === 200) await expect.poll(async () => page.locator('.sync-pill').innerText()).toContain('Hospital connected');
    return body;
  }
  return { ...runtime, browser, url, page, go, fill, send, failures,
    async close() {
      await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); runtime.store.close();
      for (const suffix of ['', '-wal', '-shm']) rmSync(join(dir, 'test.sqlite') + suffix, { force: true });
      rmdirSync(dir);
      assert.deepEqual(failures, [], 'Browser runtime/CSP errors');
    }
  };
}
test('browser: responsive doctor workspace, real consultation forms and pharmacy handoff', async () => {
  const f = await fixture();
  try {
    const landing = await f.page();
    await landing.page.screenshot({ path: 'test-artifacts\\landing-desktop.png', fullPage: true });
    const { page } = await f.page('doctor-a');
    await page.screenshot({ path: 'test-artifacts\\doctor-home-desktop.png', fullPage: true });
    await page.goto(`${f.url}/#patients`);
    await expect(page.getByText('Demo patient C', { exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: /Demo patient A/ }).click();
    await page.getByRole('button', { name: 'Patient has arrived · confirm' }).click();
    let form = page.locator('form[data-command="visit.open"]');
    await form.getByLabel('I checked name, UHID and allergy status', { exact: false }).check();
    await f.send(page, form, 'visit.open');
    assert.equal(f.store.get('visit-a').status, 'In consultation');
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    form = page.locator('form[data-command="note.save"]');
    await f.fill(form, 'note.save', { complaints: 'Browser-tested synthetic complaint', illness: 'Browser-entered synthetic present illness', diagnosis: 'Sample condition', icd: 'R50.9', reviewed: true });
    await f.send(page, form, 'note.save');
    assert.equal(f.store.all('note').length, 1); assert.equal(text(f.store.all('note')[0].data, 'complaints'), 'Browser-tested synthetic complaint');
    await page.getByRole('button', { name: 'Medicines', exact: true }).click();
    form = page.locator('form[data-command="rx.approve"]');
    await form.getByRole('button', { name: 'Add medicine', exact: true }).click();
    await form.getByLabel('Medicine 1', { exact: true }).selectOption('medicine-a');
    await form.getByLabel('Reviewed medicine 1', { exact: true }).check();
    await form.locator('[id="rx.approve-sendNow"]').check();
    await form.locator('[id="rx.approve-reviewed"]').check();
    await f.send(page, form, 'rx.approve');
    const rx = f.store.all('rx')[0]; assert.equal(rx.status, 'Sent');
    const pharmacist = await f.page('pharmacy');
    form = await f.go(pharmacist.page, 'SJ10', 'pharmacy.receive', rx.id);
    await f.send(pharmacist.page, form, 'pharmacy.receive');
    form = await f.go(pharmacist.page, 'SJ10', 'pharmacy.dispense', rx.id);
    await f.fill(form, 'pharmacy.dispense', { lineId: text(rows(f.store.get(rx.id).data, 'lines')[0], 'id'), batchId: 'batch-a', quantity: 5, nearExpiry: true });
    await f.send(pharmacist.page, form, 'pharmacy.dispense');
    assert.equal(f.store.get(rx.id).status, 'Dispensed'); assert.equal(num(f.store.get('batch-a').data, 'quantity'), 295);
    await page.goto(`${f.url}/#visit/visit-a`); await page.getByRole('button', { name: 'Medicines', exact: true }).click();
    await expect(page.locator('.record-details').filter({ hasText: 'Dispensed' })).toBeVisible();
    evidence.push({ journeys: ['DJ05', 'DJ06', 'DJ09', 'DJ10', 'SJ10'], behavior: 'Browser users scoped-search/open patient, confirm identity, type/review/save note, review medicine and send Rx; independent pharmacy browser acknowledges and dispenses; doctor sees fulfillment.' });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${f.url}/#home`);
      await expect(page.getByRole('navigation', { name: 'Doctor bottom tabs' })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      assert.equal(overflow, false, `Home horizontal overflow at ${width}`);
      await expect.poll(async () => page.locator('.sidebar').evaluate(el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
      if (width === 390) await page.screenshot({ path: 'test-artifacts\\doctor-home-mobile.png', fullPage: true, animations: 'disabled' });
      await page.goto(`${f.url}/#visit/visit-a`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `Visit horizontal overflow at ${width}`);
    }
    await page.getByRole('button', { name: 'Lock workspace', exact: false }).click();
    await expect(page.getByRole('heading', { name: 'Workspace locked' })).toBeVisible();
    await expect(page.getByText('Demo patient A', { exact: true })).toHaveCount(0);
    await page.getByLabel('Demo unlock PIN').fill('2468'); await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
    await expect(page.locator('.app-shell')).toBeVisible();
    evidence.push({ journeys: ['DJ03', 'DJ24'], behavior: '390px/320px doctor layout has no document overflow, preserves Home/Patients/Calendar/More bottom tabs; locking removes patient content and PIN unlock restores workspace.' });
  } finally { await f.close(); }
});

test('browser: offline draft and outbox survive reload, retry once, and conflicts require an explicit reviewed replacement', async () => {
  const f = await fixture();
  try {
    const { page, context } = await f.page('doctor-a');
    await page.goto(`${f.url}/#sync`);
    await page.getByLabel('Simulate no network for this persona').check();
    let form = await f.go(page, 'DJ09', 'note.save');
    await f.fill(form, 'note.save', { visitId: 'visit-a', complaints: 'Offline browser complaint', illness: 'This draft must survive browser restart', diagnosis: 'Sample diagnosis', icd: 'R50.9', reviewed: true });
    await expect(form.getByRole('status')).toContainText('Draft saved');
    await page.reload(); form = page.locator('form[data-command="note.save"]');
    await expect(form.locator('[id="note.save-illness"]')).toHaveValue('This draft must survive browser restart');
    await form.getByRole('button', { name: 'Review & save note version', exact: true }).click();
    await expect(page.locator('.sync-pill')).toContainText('Offline simulation');
    await page.goto(`${f.url}/#sync`);
    await expect(page.getByText('Queued', { exact: true })).toBeVisible();
    assert.equal(f.store.all('note').length, 0);
    await page.reload(); await expect(page.getByText('Queued', { exact: true })).toBeVisible();
    const sent = page.waitForResponse(response => response.url().endsWith('/api/commands/note.save') && response.status() === 200);
    await page.getByLabel('Simulate no network for this persona').uncheck();
    await sent; await expect(page.getByText('Accepted', { exact: true })).toBeVisible();
    assert.equal(f.store.all('note').length, 1);
    await page.reload(); await expect(page.getByText('Accepted', { exact: true })).toBeVisible(); assert.equal(f.store.all('note').length, 1);
    await page.getByLabel('Next send fault').selectOption('Lose reply after acceptance');
    form = await f.go(page, 'DJ09', 'note.save');
    await f.fill(form, 'note.save', { visitId: 'visit-a', complaints: 'Lost reply browser note', illness: 'Only one accepted effect', diagnosis: 'Sample diagnosis', icd: 'R50.9', reviewed: true });
    await f.send(page, form, 'note.save', 503);
    await page.goto(`${f.url}/#sync`);
    await expect.poll(() => f.store.all('note').filter(e => text(e.data, 'complaints') === 'Lost reply browser note').length).toBe(1);
    await expect(page.locator('.sync-row').filter({ hasText: 'Review & save note version' }).filter({ hasText: 'Retryable' })).toBeVisible();
    await expect.poll(async () => page.locator('.sync-row').filter({ hasText: 'Accepted' }).count(), { timeout: 20000 }).toBe(2);
    assert.equal(f.store.all('note').length, 2);
    await page.getByLabel('Next send fault').selectOption('Conflict');
    form = await f.go(page, 'DJ09', 'note.save');
    await f.fill(form, 'note.save', { visitId: 'visit-a', complaints: 'Conflict browser note', illness: 'Preserved local content to review', diagnosis: 'Sample diagnosis', icd: 'R50.9', reviewed: true });
    await f.send(page, form, 'note.save', 409);
    await page.goto(`${f.url}/#sync`);
    const row = page.locator('.sync-row').filter({ hasText: 'Conflict' });
    await row.getByRole('button', { name: 'Inspect' }).click();
    await expect(page.getByRole('heading', { name: 'Your saved action' })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Hospital’s current record' })).toBeVisible();
    await page.getByRole('button', { name: 'Review in form as a new action' }).click();
    form = page.locator('dialog form[data-command="note.save"]');
    await expect(form.locator('[id="note.save-illness"]')).toHaveValue('Preserved local content to review');
    await expect(form.locator('[id="note.save-reviewed"]')).not.toBeChecked();
    await form.locator('[id="note.save-reviewed"]').check();
    await f.send(page, form, 'note.save');
    assert.equal(f.store.all('note').length, 3);
    assert.equal(f.store.all('note').filter(e => text(e.data, 'complaints') === 'Conflict browser note').length, 1);
    evidence.push({ journeys: ['DJ25', 'DJ09'], behavior: 'Encrypted form draft and queued command survive reload while offline simulation is active; reconnect applies once; lost reply retries to one effect; conflict shows both versions and requires a newly reviewed action.' });
    await page.goto(`${f.url}/#sync`);
    await page.getByLabel('Next send fault').selectOption('Reject');
    await page.getByLabel('Simulate no network for this persona').check();
    form = await f.go(page, 'DJ09', 'note.save');
    await f.fill(form, 'note.save', { visitId: 'visit-a', complaints: 'Intentionally rejected note', illness: 'Keep for correction', diagnosis: 'Sample diagnosis', icd: 'R50.9', reviewed: true });
    await form.getByRole('button', { name: 'Review & save note version', exact: true }).click();
    form = await f.go(page, 'DJ11', 'order.send');
    await f.fill(form, 'order.send', { visitId: 'visit-a', reference: 'OPD', priority: 'Urgent', history: 'Independent test history', diagnosis: 'Synthetic diagnosis' });
    await form.locator('.test-option').filter({ hasText: 'Complete blood count' }).getByRole('checkbox').check();
    await form.getByRole('button', { name: 'Send test order', exact: true }).click();
    await page.goto(`${f.url}/#sync`);
    const independent = page.waitForResponse(response => response.url().endsWith('/api/commands/order.send') && response.status() === 200);
    await page.getByLabel('Simulate no network for this persona').uncheck();
    await independent;
    assert.equal(f.store.all('note').length, 3);
    assert.ok(f.store.all('order').some(order => text(order.data, 'history') === 'Independent test history'));
    await expect(page.getByText('Rejected', { exact: true })).toBeVisible();
    evidence.push({ journeys: ['DJ25', 'DJ11'], behavior: 'When an earlier note is rejected, a separately finalized test order still reaches the hospital; the rejected note remains visible for correction rather than falsely marking the whole visit synced.' });
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Saved first. Sent with confidence.' })).toBeVisible();
    await context.setOffline(false);
  } finally { await f.close(); }
});

test('browser: front-desk registration/booking/check-in and patient payment through validated forms', async () => {
  const f = await fixture();
  try {
    const desk = await f.page('desk');
    let form = await f.go(desk.page, 'SJ02', 'patient.register');
    await f.fill(form, 'patient.register', { name: 'Browser demo patient', age: 32, sex: 'Female', mobile: '9000066666', address: 'Synthetic district', category: 'General', aadhaarLast4: '9876', payer: 'Self', unknown: false, mlc: false });
    await f.send(desk.page, form, 'patient.register');
    const patient = f.store.all('patient').find(e => text(e.data, 'name') === 'Browser demo patient')!; assert.ok(patient);
    form = await f.go(desk.page, 'SJ03', 'visit.book');
    await f.fill(form, 'visit.book', { patientId: patient.id, doctorId: 'doctor-a', date: new Date(new Date(f.store.now()).getTime() + 330 * 60000).toISOString().slice(0, 10), time: '14:00', mode: 'Walk-in', opdType: 'General', visitType: 'New' });
    await f.send(desk.page, form, 'visit.book');
    const visit = f.store.all('visit').find(e => e.patientId === patient.id)!;
    form = await f.go(desk.page, 'SJ04', 'visit.checkin', visit.id);
    await f.fill(form, 'visit.checkin', { clearance: 'Collect at billing', priority: false });
    await f.send(desk.page, form, 'visit.checkin'); assert.equal(f.store.get(visit.id).status, 'Waiting');
    const doctor = await f.page('doctor-a');
    await doctor.page.goto(`${f.url}/#patients`); await expect(doctor.page.getByText('Browser demo patient', { exact: true })).toBeVisible();
    const cashier = await f.page('cashier');
    const bill = f.store.all('bill').find(e => text(e.data, 'sourceId') === visit.id)!;
    form = await f.go(cashier.page, 'SJ07', 'bill.pay', bill.id);
    await form.locator('[id="bill.pay-outcome"]').selectOption('Success');
    await expect(form.getByLabel('Payment amount 1')).toHaveValue('500');
    await f.send(cashier.page, form, 'bill.pay'); assert.equal(f.store.get(bill.id).status, 'Paid');
    evidence.push({ journeys: ['SJ02', 'SJ03', 'SJ04', 'SJ07', 'DJ05'], behavior: 'Front desk types a synthetic registration, books and checks in using actual browser forms; doctor independently sees the new patient; cashier payment form defaults exact due and changes bill to Paid.' });
    const family = await f.page('family');
    await family.page.goto(`${f.url}/#journey/SJ36`);
    await expect(family.page.getByText('Browser demo patient', { exact: true })).toHaveCount(0);
    await expect(family.page.getByText('Demo patient C', { exact: true })).toHaveCount(0);
    evidence.push({ journeys: ['SJ34', 'SJ36'], behavior: 'Patient browser remains isolated to its linked sample family; an unrelated newly registered patient and other-family record are absent.' });
  } finally { await f.close(); }
});

test('browser: all journey surfaces render under authorized personas without pretending route coverage is behavior evidence', async () => {
  const f = await fixture();
  try {
    const actors: Record<Role, string> = { doctor: 'doctor-a', resident: 'resident', superadmin: 'super', admin: 'admin', head: 'head', it: 'it', auditor: 'auditor', desk: 'desk', cashier: 'cashier', pharmacist: 'pharmacy', store: 'store', nurse: 'nurse', lab: 'lab', ot: 'ot', mrd: 'mrd', services: 'services', manager: 'manager', patient: 'family' };
    const pages = new Map<string, Page>();
    for (const journey of journeys) {
      const role = journey.roles[0]; const actor = actors[role]; let page = pages.get(actor);
      if (!page) { page = (await f.page(actor)).page; pages.set(actor, page); }
      await page.goto(`${f.url}/#journey/${journey.id}`);
      const heading = journey.id === 'DJ25' ? 'Saved first. Sent with confidence.' : journey.title;
      await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
      assert.equal(await page.locator('.fatal').count(), 0, `Unexpected failure surface ${journey.id}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false, `Page overflow ${journey.id}`);
      rendered.add(journey.id);
    }
    assert.equal(rendered.size, 87);
  } finally { await f.close(); }
});

test('browser: reviewed pen image is persisted privately and preferences support enlarged Hindi navigation', async () => {
  const f = await fixture();
  try {
    const { page } = await f.page('doctor-a');
    let form = await f.go(page, 'DJ09', 'note.save');
    await f.fill(form, 'note.save', { visitId: 'visit-a', mode: 'Pen simulation', complaints: 'Synthetic handwritten note', illness: 'Reviewed manual transcription', diagnosis: 'Sample condition', icd: 'R50.9', reviewed: true });
    const canvas = form.getByLabel('Synthetic handwriting pad'); await canvas.scrollIntoViewIfNeeded(); const bounds = await canvas.boundingBox(); assert.ok(bounds);
    await page.mouse.move(bounds.x + 25, bounds.y + 35); await page.mouse.down(); await page.mouse.move(bounds.x + 90, bounds.y + 65, { steps: 5 }); await page.mouse.move(bounds.x + 145, bounds.y + 30, { steps: 5 }); await page.mouse.up();
    await form.getByRole('button', { name: 'Reviewed: attach handwriting image' }).click();
    await f.send(page, form, 'note.save');
    const note = f.store.all('note')[0]; const attachment = f.store.get(text(note.data, 'handwritingDocumentId'), 'document');
    assert.equal(text(attachment.data, 'mime'), 'image/png'); assert.ok(text(attachment.data, 'file').length > 100);
    form = await f.go(page, 'DJ02', 'preferences.save');
    await f.fill(form, 'preferences.save', { language: 'Hindi', textSize: '200%' });
    await f.send(page, form, 'preferences.save');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('32px');
    await expect(page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'मरीज़', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${f.url}/#home`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false);
    evidence.push({ journeys: ['DJ09', 'DJ02'], behavior: 'Pointer-drawn pen image is reviewed and saved as a private patient document linked to the immutable note; 200% root text size and Hindi doctor navigation apply from persisted preferences.' });
  } finally { await f.close(); }
});
