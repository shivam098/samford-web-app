import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Server } from 'node:http';
import { expect, type Browser, type BrowserContext, type Page, type Locator } from '@playwright/test';
import { createApplication } from '../server/app.js';
import { anchorFor } from '../server/engine.js';
import { commands } from '../shared/commands.js';
import { text, num, rows, strings, istDate, label, type Data, type Entity, type CommandRequest, type Receipt, type Role } from '../shared/model.js';
import { translate } from '../shared/i18n.js';

export async function testHospital(browser?: Browser) {
  mkdirSync('test-artifacts', { recursive: true });
  const directory = mkdtempSync(join(resolve('test-artifacts'), 'next-'));
  const database = join(directory, 'test.sqlite');
  const runtime = createApplication({ database, dist: 'dist-candidate', test: true });
  const server: Server = await new Promise(resolve => { const server = runtime.app.listen(0, '127.0.0.1', () => resolve(server)); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const contexts: BrowserContext[] = [];
  const clients = new Map<string, Client>();
  const errors: string[] = [];
  const personalPasswords = new Map<string, string>();
  class Client {
    actorId: string; deviceId = `next-test-${randomUUID()}`; cookies = new Map<string, string>();
    constructor(actorId: string) { this.actorId = actorId; }
    async request(path: string, method = 'GET', body?: unknown, expected = 200) {
      const response = await fetch(url + path, { method, headers: { Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
        ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-Samford-Request': '1' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const cookie of response.headers.getSetCookie()) { const entry = cookie.split(';')[0]; const i = entry.indexOf('='); this.cookies.set(entry.slice(0, i), entry.slice(i + 1)); }
      const result = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
      assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result).slice(0, 1000)}`);
      return result;
    }
    async login() { await this.request('/api/auth/demo', 'POST', { actorId: this.actorId, deviceId: this.deviceId }); return this; }
    envelope(name: string, payload: Data = {}, targetId?: string, actingRole?: Role): CommandRequest {
      const request: CommandRequest = { operationId: randomUUID(), actorId: this.actorId, deviceId: this.deviceId, payload, createdAt: runtime.store.now(), ...(targetId ? { targetId } : {}), ...(actingRole ? { actingRole } : {}) };
      const anchor = anchorFor(runtime.store, name, request); if (anchor) request.expectedVersion = anchor.version;
      if (name === 'rx.approve' && anchor?.patientId) {
        request.contextVersions = { [anchor.patientId]: runtime.store.get(anchor.patientId).version };
        const rx = runtime.store.all('rx').find(entity => text(entity.data, 'visitId') === anchor.id);
        if (rx) request.contextVersions[rx.id] = rx.version;
      }
      if (name === 'operation.emergencySchedule') request.contextVersions = { [text(payload, 'plannedId')]: runtime.store.get(text(payload, 'plannedId')).version };
      return request;
    }
    async cmd(name: string, payload: Data = {}, targetId?: string, expected = 200, actingRole?: Role): Promise<Receipt> {
      return this.request(`/api/commands/${name}`, 'POST', this.envelope(name, payload, targetId, actingRole), expected);
    }
    async entity(name: string, payload: Data = {}, targetId?: string, type?: string) {
      const receipt = await this.cmd(name, payload, targetId);
      const entity = receipt.entityIds.map(id => runtime.store.get(id)).find(entity => !type || entity.type === type);
      assert.ok(entity, `${name} did not return ${type ?? 'a record'}`); return entity;
    }
  }
  async function client(id: string) {
    if (clients.has(id)) return clients.get(id)!;
    const client = await new Client(id).login(); clients.set(id, client); return client;
  }
  async function activate(receipt: Receipt) {
    const id = text(receipt.data ?? {}, 'id'); const login = text(receipt.data ?? {}, 'login'); const temporary = text(receipt.data ?? {}, 'temporaryPassword');
    assert.ok(id && login && temporary, 'An invitation receipt is required.');
    const client = new Client(id);
    const challenge = await client.request('/api/auth/start', 'POST', { login, password: temporary, deviceId: client.deviceId });
    await client.request('/api/auth/otp', 'POST', { challengeId: challenge.challengeId, code: challenge.simulatedCode });
    const password = 'CandidateSyntheticPassword#2026';
    await client.request('/api/auth/password', 'POST', { password }); await client.request('/api/auth/confirm', 'POST', { confirmed: true });
    clients.set(id, client); personalPasswords.set(id, password); return client;
  }
  async function guest(viewport = { width: 1440, height: 1000 }): Promise<Page> {
    assert.ok(browser, 'This harness needs a browser for UI work.');
    const context = await browser.newContext({ viewport }); contexts.push(context);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (/Content Security Policy|Refused to/.test(message.text())) errors.push(message.text()); });
    await page.goto(url);
    return page;
  }
  async function open(id: string, viewport = { width: 1440, height: 1000 }): Promise<Page> {
    const page = await guest(viewport);
    const person = runtime.store.person(id);
    const portal = ['doctor', 'resident'].includes(person.role) ? 'Doctor' : ['superadmin', 'admin', 'head', 'it', 'auditor'].includes(person.role) ? 'Administration' : person.role === 'patient' ? 'Patient' : 'Staff';
    if (personalPasswords.has(id)) {
      await page.getByRole('button', { name: 'Test sign-in / onboarding', exact: false }).click();
      await page.getByLabel('Login ID, e-mail or mobile').fill(person.login);
      await page.getByLabel('Password', { exact: true }).fill(personalPasswords.get(id)!);
      await page.getByRole('button', { name: 'Continue to second check', exact: false }).click();
      await expect(page.locator('.demo-code')).toBeVisible();
      const code = await page.locator('.demo-code').innerText();
      await page.getByLabel('Six-digit code').fill(code);
      await page.getByRole('button', { name: 'Verify code', exact: true }).click();
    } else {
      await page.getByRole('button', { name: portal, exact: true }).click();
      await page.locator(`[data-persona-id="${id}"]`).click();
    }
    await expect(page.locator('.app-shell')).toBeVisible();
    return page;
  }
  async function form(page: Page, journey: string, name: string, targetId?: string) {
    await page.goto(`${url}/#journey/${journey}`);
    await expect(page.locator(`[data-journey-id="${journey}"]`)).toBeVisible();
    const refreshed = page.waitForResponse(response => response.url().endsWith('/api/state') && response.status() === 200);
    await page.locator(`[data-journey-id="${journey}"]`).getByRole('button').click();
    const snapshot = await (await refreshed).json();
    await expect(page.locator('.app-shell')).toHaveAttribute('data-revision', String(snapshot.revision));
    await page.locator('.action-selector select').selectOption(name);
    const form = page.locator(`form[data-command="${name}"]`); await expect(form).toBeVisible();
    if (targetId) await form.locator('select[aria-label="Work item"],select[aria-label="कार्य"]').selectOption(targetId);
    return form;
  }
  async function fill(page: Page, form: Locator, name: string, payload: Data) {
    const definition = commands.find(command => command.name === name)!;
    const language = await page.locator('html').getAttribute('lang') === 'hi' ? 'Hindi' : 'English';
    const t = (value: string) => translate(value, language);
    for (const field of definition.fields) {
      if (field.hidden || payload[field.key] === undefined) continue;
      const value = payload[field.key]; const control = form.locator(`[id="${name}-${field.key}"]`);
      const section = form.locator(`[data-field-key="${field.key}"]`);
      if (field.kind === 'medicines') {
        const lines = rows(payload, field.key);
        for (let index = 0; index < lines.length; index++) {
          await section.getByRole('button', { name: t('Add medicine'), exact: true }).click();
          const row = section.locator('.medicine-line').nth(index); const line = lines[index];
          await row.locator('select').nth(0).selectOption(text(line, 'itemId'));
          await row.getByLabel(`${t('Dose')} ${index + 1}`, { exact: true }).fill(text(line, 'dose', '1 tablet'));
          if (text(line, 'frequency')) await row.locator('select').nth(1).selectOption(text(line, 'frequency'));
          if (text(line, 'route')) await row.locator('select').nth(2).selectOption(text(line, 'route'));
          if (text(line, 'food')) await row.locator('select').nth(3).selectOption(text(line, 'food'));
          await row.locator('input[type="number"]').nth(0).fill(String(num(line, 'days', 5)));
          await row.locator('input[type="number"]').nth(1).fill(String(num(line, 'quantity', 5)));
          if (text(line, 'start')) await row.locator('input[type="date"]').fill(text(line, 'start'));
          if (text(line, 'remark')) await row.getByLabel(t('Remark / taper schedule'), { exact: true }).fill(text(line, 'remark'));
          await row.locator('input[type="checkbox"]').setChecked(line.reviewed === true);
        }
      } else if (field.kind === 'tests') {
        for (const id of strings(payload, field.key)) await section.locator('.test-option').filter({ hasText: label(runtime.store.get(id)) }).getByRole('checkbox').check();
      } else if (field.kind === 'payments') {
        const payments = rows(payload, field.key);
        while (await section.locator('.payment-line').count() < payments.length) await section.getByRole('button', { name: t('Add split'), exact: true }).click();
        for (let i = 0; i < payments.length; i++) {
          const row = section.locator('.payment-line').nth(i);
          await row.locator('select').selectOption(text(payments[i], 'mode'));
          await row.locator('input[type="number"]').fill(String(num(payments[i], 'amount')));
        }
      } else if (field.kind === 'file') {
        assert.ok(value && typeof value === 'object' && !Array.isArray(value));
        await control.setInputFiles({ name: text(value, 'name'), mimeType: text(value, 'mime'), buffer: Buffer.from(text(value, 'base64'), 'base64') });
        await expect(section.locator('.micro')).toContainText(text(value, 'name'));
      } else if (field.kind === 'checklist') {
        for (const checkbox of await section.locator('input[type="checkbox"]').all()) if (!await checkbox.isDisabled()) await checkbox.uncheck();
        for (const selected of strings(payload, field.key)) {
          const index = field.options!.indexOf(selected); assert.ok(index >= 0);
          await section.locator('input[type="checkbox"]').nth(index).check();
        }
      } else if (field.kind === 'handovers') {
        for (const choice of rows(payload, field.key)) {
          const group = section.locator(`[data-handover-group="${text(choice, 'group')}"]`);
          await group.locator('select').nth(0).selectOption(text(choice, 'receiverType'));
          if (choice.receiverType === 'Doctor') await group.locator('select').nth(1).selectOption(text(choice, 'receiverId'));
        }
      } else if (field.kind === 'homeLayout') {
        assert.ok(value && typeof value === 'object' && !Array.isArray(value));
        const cards = rows(value, 'cards');
        for (let index = 0; index < cards.length; index++) {
          const id = text(cards[index], 'id'); const row = section.locator(`[data-home-card="${id}"]`);
          let current = (await section.locator('[data-home-card]').evaluateAll(elements => elements.map(element => element.getAttribute('data-home-card')))).indexOf(id);
          while (current > index) { await row.getByRole('button').nth(0).click(); current--; }
          const checkbox = row.locator('input[type="checkbox"]');
          if (!await checkbox.isDisabled()) await checkbox.setChecked(cards[index].visible === true);
          else assert.equal(cards[index].visible, true);
          await row.locator('input[type="number"]').fill(String(num(cards[index], 'rows', 5)));
        }
      } else if (field.kind === 'payerRates' || field.kind === 'denominations') {
        assert.ok(value && typeof value === 'object' && !Array.isArray(value));
        for (const [key, number] of Object.entries(value)) await section.getByLabel(field.kind === 'payerRates' ? `${key} package rate` : `INR ${key} count`, { exact: true }).fill(String(number));
      } else if (field.kind === 'boolean') await control.setChecked(value === true);
      else {
        if (field.key === 'time' && ['visit.book', 'visit.move', 'followup.book'].includes(name)) await form.locator(`select[id="${name}-${field.key}"]`).waitFor();
        const tag = await control.evaluate(element => element.tagName.toLowerCase());
        if (tag === 'select' && await control.isDisabled()) await expect(control).toHaveValue(String(value));
        else if (tag === 'select') await control.selectOption(String(value));
        else if (field.kind === 'datetime') await control.fill(new Date(Date.parse(String(value)) + 330 * 60000).toISOString().slice(0, 16));
        else if (await control.isEditable()) await control.fill(String(value));
        else await expect(control).toHaveValue(String(value));
      }
    }
  }
  async function submit(page: Page, form: Locator, name: string, closeReceipt = true): Promise<Receipt> {
    const invalid = await form.locator(':invalid').evaluateAll(elements => elements.map(element => ({ id: element.id, message: (element as HTMLInputElement).validationMessage })));
    assert.deepEqual(invalid, [], `${name} has invalid browser controls`);
    const response = page.waitForResponse(response => response.url().endsWith(`/api/commands/${name}`) && response.request().method() === 'POST', { timeout: 15000 });
    await form.locator('.form-footer').getByRole('button').click();
    const result = await response; const body = await result.json();
    assert.equal(result.status(), 200, `${name} browser result: ${JSON.stringify(body).slice(0, 1000)}`);
    await expect.poll(async () => page.locator('.sync-pill').innerText()).toMatch(/Hospital connected|अस्पताल से जुड़ा/);
    if (closeReceipt && await page.locator('dialog[open]').count()) await page.locator('dialog[open] > header button').click();
    return body as Receipt;
  }
  async function perform(page: Page, journey: string, name: string, payload: Data = {}, targetId?: string, closeReceipt = true) {
    const active = await form(page, journey, name, targetId); await fill(page, active, name, payload);
    return submit(page, active, name, closeReceipt);
  }
  return { ...runtime, url, directory, database, client, activate, guest, open, form, fill, submit, perform, errors,
    entity(receipt: Receipt, type: string): Entity { const entity = receipt.entityIds.map(id => runtime.store.get(id)).find(entity => entity.type === type); assert.ok(entity, `Missing ${type}`); return entity; },
    today() { return istDate(runtime.store.now()); },
    date(days = 1) { return istDate(new Date(Date.parse(runtime.store.now()) + days * 86400000).toISOString()); },
    async close() {
      for (const context of contexts) await context.close();
      await new Promise<void>(resolve => server.close(() => resolve())); runtime.store.close();
      for (const suffix of ['', '-wal', '-shm']) rmSync(database + suffix, { force: true });
      rmdirSync(directory); assert.deepEqual(errors, [], 'Browser runtime/CSP failures');
    }
  };
}
export type HospitalHarness = Awaited<ReturnType<typeof testHospital>>;
export const medicineLine = (itemId = 'medicine-a', quantity = 5): Data => ({ itemId, dose: '1 tablet', frequency: 'Once daily', route: 'Oral', food: 'After food', days: 5, quantity, reviewed: true, remark: 'Synthetic testing only' });
export const notePayload: Data = { visitId: 'visit-a', mode: 'Type', complaints: 'Synthetic browser note', illness: 'Synthetic history', diagnosis: 'Sample diagnosis', icd: 'R50.9', certainty: 'Provisional', reviewed: true };
export async function prepareAdmission(h: HospitalHarness, patientId = 'patient-a') {
  const desk = await h.client('desk');
  const admission = await desk.entity('admission.emergency', { patientId, doctorId: 'doctor-a', category: 'General', diagnosis: 'Synthetic admission for workflow test', relative: 'Demo relative', relativeMobile: '9000005555' }, undefined, 'admission');
  await desk.cmd('admission.admit', { bedId: 'bed-1', relative: 'Demo relative', advance: 0 }, admission.id);
  return h.store.get(admission.id);
}
export async function preparePrescription(h: HospitalHarness) {
  const doctor = await h.client('doctor-a');
  return doctor.entity('rx.approve', { visitId: 'visit-a', lines: [medicineLine()], sendNow: true, reviewed: true }, undefined, 'rx');
}
export async function prepareLabResult(h: HospitalHarness, state: 'Entered' | 'Verified' | 'Released' = 'Released') {
  const doctor = await h.client('doctor-a'); const lab = await h.client('lab'); const verifier = await h.client('verifier');
  const receipt = await doctor.cmd('order.send', { visitId: 'visit-b', tests: ['potassium'], reference: 'OPD', priority: 'Urgent', history: 'Synthetic history', diagnosis: 'Sample diagnosis' });
  const order = h.entity(receipt, 'order');
  const sample = await lab.entity('sample.collect', { container: 'Yellow serum', fasting: 'Checked', confirmed: true }, order.id, 'sample');
  await lab.cmd('sample.accept', { barcode: text(sample.data, 'barcode') }, sample.id);
  const result = await lab.entity('result.enter', { value: 6.9, unit: 'mmol/L', low: 3.5, high: 5.1 }, sample.id, 'result');
  if (state !== 'Entered') await verifier.cmd('result.verify', { confirmed: true }, result.id);
  if (state === 'Released') await verifier.cmd('result.release', {}, result.id);
  return { order: h.store.get(order.id), sample: h.store.get(sample.id), result: h.store.get(result.id) };
}
export async function prepareDischarge(h: HospitalHarness, nursingCleared = false) {
  const admission = await prepareAdmission(h); const doctor = await h.client('doctor-a');
  const discharge = await doctor.entity('discharge.draft', { admissionId: admission.id, diagnosis: 'Sample condition', course: 'Sample stay', procedures: 'No procedure', condition: 'Sample stable', lines: [medicineLine()], followup: 'Sample follow-up', reviewed: true }, undefined, 'discharge');
  await doctor.cmd('discharge.approve', { pin: '2468', pendingPlan: 'No unowned work', reviewed: true }, discharge.id);
  if (nursingCleared) await (await h.client('nurse')).cmd('discharge.clear', { returns: true, results: true, medicines: true, insurance: true, note: 'Synthetic clearance' }, discharge.id);
  return { admission: h.store.get(admission.id), discharge: h.store.get(discharge.id) };
}
