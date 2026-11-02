import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { traceability } from '../shared/traceability.js';
import { applicationVersion } from '../shared/version.js';
type ApiEvidence = { generatedAt: string; journeys: { id: string; status: string; evidence: string[] }[] };
type BrowserEvidence = { generatedAt: string; behavioralEvidence: { journeys: string[]; behavior: string }[]; renderedJourneys: string[] };
const api = JSON.parse(readFileSync('test-artifacts\\journey-evidence.json', 'utf8')) as ApiEvidence;
const browser = JSON.parse(readFileSync('test-artifacts\\browser-evidence.json', 'utf8')) as BrowserEvidence;
const variants = JSON.parse(readFileSync('test-artifacts\\completeness-browser-evidence.json', 'utf8')) as BrowserEvidence;
const remaining = JSON.parse(readFileSync('test-artifacts\\journey-browser-evidence.json', 'utf8')) as BrowserEvidence;
const behavioralEvidence = [...browser.behavioralEvidence, ...variants.behavioralEvidence, ...remaining.behavioralEvidence];
const entries = traceability.map(journey => {
  const verified = api.journeys.find(row => row.id === journey.id);
  return { ...journey, primaryApiStatus: verified?.status ?? 'NOT_VERIFIED', apiEvidence: verified?.evidence ?? [],
    browserBehavior: behavioralEvidence.filter(row => row.journeys.includes(journey.id)).map(row => row.behavior),
    browserRendered: browser.renderedJourneys.includes(journey.id) };
});
if (entries.some(entry => entry.primaryApiStatus !== 'primary_api_behavior_verified')) throw new Error('Some journeys lack primary API evidence. Do not publish a complete-primary-path claim.');
const missing = entries.filter(entry => !entry.browserBehavior.length);
if (missing.length) throw new Error(`Missing substantive browser evidence: ${missing.map(entry => entry.id).join(', ')}`);
mkdirSync('docs', { recursive: true });
writeFileSync('docs\\traceability.json', JSON.stringify({
  version: applicationVersion, generatedAt: new Date().toISOString(), apiRunAt: api.generatedAt, browserRunAt: [browser.generatedAt, variants.generatedAt, remaining.generatedAt],
  scope: 'All 87 named journeys have primary API and substantive browser evidence. Each row describes exactly what was exercised; rendering is a separate smoke-test dimension, not proof of every optional state.',
  limitations: [
    'Public synthetic personas, OTP, captcha and signing PIN are demonstrations, not production authentication or legal clinical signatures.',
    'No live ETHER, ABDM, messaging, payment, insurance, video, audio or laboratory-provider integrations.',
    'Native device encryption/biometric unlock/screenshot blocking/remote OS wipe are not implemented by a web page. Browser data uses persona-isolated encrypted IndexedDB.',
    'Doctor/patient action labels, declared form fields/options and PDF labels support Hindi. Authored clinical text is preserved, not translated. Technical record keys, developer diagnostics and some explanatory copy remain English; no complete human linguistic review or PDF/UA certification is claimed.',
    'Pen drawing and reviewed image attachment work; speech/handwriting text recognition use explicitly labelled transcript simulations.',
    'Multiple staff roles share one identity and independent-approver checks. Clinical/admin/staff role blending is prohibited. Network restrictions, recovery-code enrollment, clinical interaction knowledge and hospital production authorization policy remain unvalidated.',
    'Physical scanners, webcam capture, printers and signature capture are exercised through file/PDF/reference simulations, not hardware integrations.',
    'The accounting ledger, payroll, HR, live schemes and real data migration are explicitly excluded by the staff PRD. Day-end and claim exports do not constitute a ledger.',
    'All primary journey flows and the named completeness variants are tested, not all 349 illustrated PRD screen states or every optional branch. No scale, accessibility certification or production-readiness claim.'
  ],
  journeys: entries
}, null, 2));
console.log(`Persisted ${entries.length} journey mappings; ${entries.filter(entry => entry.browserBehavior.length).length} have substantive browser interaction evidence; ${entries.filter(entry => entry.browserRendered).length} rendered.`);
