import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { testHospital, type HospitalHarness } from './harness.js';
import { synthesizePage, pagesToPdf, placeholderInk } from '../server/fixtures.js';
import { text, type Data } from '../shared/model.js';

let browser: Browser;
const evidence: { journeys: string[]; behavior: string }[] = [];
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => {
  await browser?.close();
  writeFileSync('test-artifacts\\handwriting-browser-evidence.json', JSON.stringify({ generatedAt: new Date().toISOString(), behavioralEvidence: evidence }, null, 2));
});
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Tablet = { token: string; device: string; call: (method: string, path: string, json?: unknown, raw?: { bytes: Buffer; type: string }) => Promise<{ status: number; body: any }> };
async function tablet(h: HospitalHarness, personaId = 'doctor-a'): Promise<Tablet> {
  const device = `browser-tablet-${randomUUID()}`;
  const call = async (method: string, path: string, json?: unknown, raw?: { bytes: Buffer; type: string }, token = '') => {
    const headers: Record<string, string> = { 'X-Device-Id': device, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(method === 'POST' ? { 'Idempotency-Key': json && typeof json === 'object' && 'bundleId' in json ? String((json as Data).bundleId) : json && typeof json === 'object' && 'clientAddendumId' in json ? String((json as Data).clientAddendumId) : randomUUID() } : {}) };
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    if (raw) headers['Content-Type'] = raw.type;
    const response = await fetch(`${h.url}/api/mobile/v1${path}`, { method, headers, body: raw ? raw.bytes as unknown as BodyInit : json === undefined ? undefined : JSON.stringify(json) });
    const content = (response.headers.get('content-type') ?? '').includes('json') ? await response.json() : undefined;
    return { status: response.status, body: content };
  };
  const session = await call('POST', '/doctor/sessions', { personaId, deviceId: device, deviceName: 'Browser-test tablet' });
  assert.equal(session.status, 201, JSON.stringify(session.body));
  return { token: session.body.token, device, call: (method, path, json, raw) => call(method, path, json, raw, session.body.token) };
}
function handwritten(seed: string, kind: 'summary' | 'prescription' | 'investigations', type: string, title: string, pageCount: number, routing: Data) {
  const pages = Array.from({ length: pageCount }, (_, index) => synthesizePage(seed, kind, index, 600, 848));
  const pdf = pagesToPdf(pages, title); const ink = placeholderInk(pages);
  return {
    blobs: [...pages.map(page => ({ bytes: page.png, type: 'image/png' })), { bytes: pdf, type: 'application/pdf' }, { bytes: ink, type: 'application/vnd.samford.ink+json' }],
    doc: { clientDocId: randomUUID(), type, title, pages: pages.map((page, index) => ({ index, pngSha256: sha(page.png), widthPx: page.width, heightPx: page.height })), pdfSha256: sha(pdf),
      inkSha256: sha(ink), inkFormat: 'samford-ink-placeholder/0', routing, signedAt: new Date().toISOString() } as Data
  };
}
async function completeOnTablet(device: Tablet) {
  assert.equal((await device.call('POST', '/doctor/queue/visit-a/start', { identityConfirmed: true })).status, 200);
  const docs = [handwritten('browser-summary', 'summary', 'VISIT_SUMMARY', 'Visit summary', 2, { pharmacy: false, labs: [], patient: true }),
    handwritten('browser-rx', 'prescription', 'PRESCRIPTION', 'Prescription', 1, { pharmacy: true, labs: [], patient: true }),
    handwritten('browser-tests', 'investigations', 'INVESTIGATIONS', 'Investigations', 1, { pharmacy: false, labs: ['central-lab', 'radiology'], patient: true })];
  for (const blob of docs.flatMap(doc => doc.blobs)) assert.ok([200, 201].includes((await device.call('PUT', `/blobs/${sha(blob.bytes)}`, undefined, blob)).status));
  const bundleId = randomUUID();
  const done = await device.call('POST', '/doctor/visits/visit-a/complete', { bundleId, completedAt: new Date().toISOString(), documents: docs.map(doc => doc.doc) });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  const [summaryId, rxId, testsId] = done.body.documents.map((doc: Data) => text(doc, 'documentId'));
  return { summaryId, rxId, testsId };
}
async function select(page: Page, h: HospitalHarness, journey: string, recordId: string) {
  await page.goto(`${h.url}/#journey/${journey}`); await expect(page.locator(`[data-journey-id="${journey}"]`)).toBeVisible();
  await page.locator(`[data-record-id="${recordId}"]`).click();
  await expect(page.locator('.handwriting-viewer')).toBeVisible();
}
async function openCopy(page: Page) {
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/commands/handwriting.view') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Open handwritten copy', exact: true }).click();
  assert.equal((await accepted).status(), 200);
  await expectImageLoaded(page);
}
async function expectImageLoaded(page: Page) {
  const image = page.locator('.handwriting-page img');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
}
async function delivery(device: Tablet, documentId: string) {
  const reply = await device.call('GET', '/doctor/visits/visit-a/delivery');
  return (reply.body.documents.find((doc: Data) => doc.documentId === documentId).recipients as Data[]).map(item => `${item.kind}:${item.labId ?? ''}:${item.state}`).sort();
}

test('handwriting browser: pharmacy opens the exact signed Rx, zooms, dispenses, and the tablet sees each state', { timeout: 180000 }, async () => {
  const h = await testHospital(browser);
  try {
    const device = await tablet(h); const { rxId } = await completeOnTablet(device);
    const page = await h.open('pharmacy');
    const copy = `${rxId}-v1-pharmacy`;
    await select(page, h, 'SJ10', copy);
    await expect(page.locator('.handwriting-page img')).toHaveCount(0);
    await openCopy(page);
    await expect.poll(() => h.store.get(copy).status).toBe('Viewed');
    await expect.poll(async () => delivery(device, rxId)).toEqual(['PATIENT::AVAILABLE', 'PHARMACY::VIEWED']);
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(page.locator('[data-zoom]')).toHaveText('100%');
    await expect.poll(() => page.locator('.handwriting-page img').evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(600);
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect.poll(() => page.locator('.handwriting-page img').evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(900);
    await page.getByRole('button', { name: 'Fit width', exact: true }).click(); await expect(page.locator('[data-zoom]')).toHaveText('Fit');
    const pdf = await page.request.get(`${h.url}${await page.getByRole('link', { name: 'Open PDF', exact: true }).getAttribute('href') ?? ''}`);
    assert.equal(pdf.status(), 200); assert.equal(pdf.headers()['content-type'], 'application/pdf');
    await h.perform(page, 'SJ10', 'handwriting.dispense', { outcome: 'Partially dispensed', note: 'Synthetic: one medicine out of stock' }, copy);
    await expect.poll(async () => delivery(device, rxId)).toEqual(['PATIENT::AVAILABLE', 'PHARMACY::PARTIALLY_DISPENSED']);
    await h.perform(page, 'SJ10', 'handwriting.dispense', { outcome: 'Dispensed' }, copy);
    const events = (await device.call('GET', '/doctor/events?limit=500')).body.events as Data[];
    assert.ok(events.some(event => event.type === 'DOCUMENT_STATE_CHANGED' && (event.data as Data).state === 'DISPENSED' && event.documentId === rxId));
    await expect(page.locator(`[data-record-id="${copy}"]`)).toBeVisible();
    evidence.push({ journeys: ['SJ10'], behavior: 'Pharmacist opens the routed handwritten prescription (recorded Viewed), zooms the exact page, opens the signed PDF, records partial then full dispensing; the doctor tablet delivery feed shows each state.' });
  } finally { await h.close(); }
});

test('handwriting browser: lab sees only its routed copy, records sample and result, a different verifier releases it to the tablet', { timeout: 180000 }, async () => {
  const h = await testHospital(browser);
  try {
    const device = await tablet(h); const { testsId } = await completeOnTablet(device);
    const lab = await h.open('lab');
    const copy = `${testsId}-v1-lab-central-lab`;
    await select(lab, h, 'SJ14', copy);
    await expect(lab.locator(`[data-record-id="${testsId}-v1-lab-radiology"]`)).toHaveCount(0);
    await openCopy(lab);
    await h.perform(lab, 'SJ14', 'handwriting.sample', { confirmed: true, note: 'Synthetic sample collected' }, copy);
    await h.perform(lab, 'SJ15', 'handwriting.result', { testName: 'Serum potassium', value: '6.9', unit: 'mmol/L', refRange: '3.5-5.1', flag: 'Critical', summary: 'Synthetic critical value' }, copy);
    await expect.poll(async () => delivery(device, testsId)).toContain('LAB:central-lab:SAMPLE_COLLECTED');
    const verifier = await h.open('verifier');
    await h.perform(verifier, 'SJ15', 'handwriting.verify', { confirmed: true }, copy);
    await expect.poll(async () => delivery(device, testsId)).toContain('LAB:central-lab:RESULT_READY');
    const events = (await device.call('GET', '/doctor/events?limit=500')).body.events as Data[];
    assert.ok(events.some(event => event.type === 'LAB_RESULT_READY' && (event.data as Data).flag === 'CRITICAL'));
    const radiology = await h.open('radiology');
    await select(radiology, h, 'SJ14', `${testsId}-v1-lab-radiology`);
    await expect(radiology.locator(`[data-record-id="${copy}"]`)).toHaveCount(0);
    evidence.push({ journeys: ['SJ14', 'SJ15'], behavior: 'Each lab sees only its routed handwritten investigations; sample collection and result entry reach the tablet only after a different verifier releases the result, with the critical flag.' });
  } finally { await h.close(); }
});

test('handwriting browser: patient portal and doctor web show the same signed pages, viewing and addenda stay versioned', { timeout: 180000 }, async () => {
  const h = await testHospital(browser);
  try {
    const device = await tablet(h); const { summaryId, rxId } = await completeOnTablet(device);
    const family = await h.open('family');
    await select(family, h, 'SJ36', `${rxId}-v1`);
    await openCopy(family);
    await expect.poll(async () => delivery(device, rxId)).toContain('PATIENT::VIEWED');
    await expect(family.locator('[data-recipient="PHARMACY:"]')).toBeVisible();
    const doctor = await h.open('doctor-a');
    await doctor.goto(`${h.url}/#visit/visit-a`);
    await doctor.locator(`[data-handwritten-open="${summaryId}"]`).click();
    const viewer = doctor.locator('dialog[open] .handwriting-viewer');
    await expect(viewer).toBeVisible(); await expectImageLoaded(doctor);
    await expect(viewer.locator('[data-page-indicator]')).toHaveText('Page 1 / 2');
    await viewer.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(viewer.locator('[data-page-indicator]')).toHaveText('Page 2 / 2');
    await expect.poll(() => viewer.locator('.handwriting-page img').getAttribute('src')).toContain((h.store.get(`${summaryId}-v1`).data.pages as Data[])[1].pngSha256 as string);
    await doctor.locator('dialog[open] > header button').click();
    const amended = handwritten('browser-rx-v2', 'prescription', 'PRESCRIPTION', 'Prescription', 1, { pharmacy: true, labs: [], patient: true });
    for (const blob of amended.blobs) await device.call('PUT', `/blobs/${sha(blob.bytes)}`, undefined, blob);
    const addendum = await device.call('POST', `/doctor/documents/${rxId}/addenda`, { clientAddendumId: randomUUID(), baseVersion: 1, reason: 'Synthetic browser dose correction', pages: amended.doc.pages,
      pdfSha256: amended.doc.pdfSha256, inkSha256: amended.doc.inkSha256, inkFormat: amended.doc.inkFormat, signedAt: new Date().toISOString() });
    assert.equal(addendum.status, 201, JSON.stringify(addendum.body));
    await select(doctor, h, 'DJ07', `${rxId}-v2`);
    const versions = doctor.getByRole('combobox', { name: 'Signed version', exact: true });
    await expect(versions).toHaveValue('2'); await expect(doctor.locator('.handwriting-viewer')).toContainText('Synthetic browser dose correction');
    await versions.selectOption('1');
    await expect(doctor.locator('.handwriting-viewer')).toContainText('A newer signed version replaced this one');
    await select(family, h, 'SJ36', `${rxId}-v2`);
    await openCopy(family);
    await expect.poll(async () => (await device.call('GET', `/doctor/documents/${rxId}`)).body.recipients.find((item: Data) => item.kind === 'PATIENT').state).toBe('VIEWED');
    const other = await h.open('other-family');
    await other.goto(`${h.url}/#journey/SJ36`); await expect(other.locator(`[data-record-id="${rxId}-v1"]`)).toHaveCount(0);
    const denied = await other.request.get(`${h.url}/api/handwriting/blobs/${(amended.doc.pages as Data[])[0].pngSha256}`);
    assert.equal(denied.status(), 404);
    evidence.push({ journeys: ['SJ36', 'DJ07'], behavior: 'Patient portal and doctor web render the exact signed pages; patient opening records Viewed on the tablet; an addendum keeps v1 readable as replaced; another family cannot list or fetch the pages.' });
  } finally { await h.close(); }
});

test('handwriting browser: front-desk check-in feeds the doctor tablet queue with a token', { timeout: 120000 }, async () => {
  const h = await testHospital(browser);
  try {
    const device = await tablet(h);
    const before = (await device.call('GET', '/doctor/queue')).body.entries.find((entry: Data) => entry.visitId === 'visit-video');
    assert.equal(before.status, 'BOOKED'); assert.equal(before.token, null);
    const desk = await h.open('desk');
    await h.perform(desk, 'SJ04', 'visit.checkin', { clearance: 'Collect at billing' }, 'visit-video');
    const after = (await device.call('GET', '/doctor/queue')).body.entries.find((entry: Data) => entry.visitId === 'visit-video');
    assert.equal(after.status, 'WAITING'); assert.ok(after.token > 0); assert.ok(after.checkedInAt);
    const events = (await device.call('GET', '/doctor/events?limit=500')).body.events as Data[];
    assert.ok(events.some(event => event.type === 'QUEUE_UPDATED' && event.visitId === 'visit-video' && (event.data as Data).status === 'WAITING'));
    evidence.push({ journeys: ['SJ04', 'DJ06'], behavior: 'A front-desk browser check-in issues a token and the doctor tablet queue and events show the visit as WAITING.' });
  } finally { await h.close(); }
});
