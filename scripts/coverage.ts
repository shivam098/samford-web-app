import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { traceability } from '../shared/traceability.js';
type ApiEvidence = { generatedAt: string; journeys: { id: string; status: string; evidence: string[] }[] };
type BrowserEvidence = { generatedAt: string; behavioralEvidence: { journeys: string[]; behavior: string }[]; renderedJourneys: string[] };
const api = JSON.parse(readFileSync('test-artifacts\\journey-evidence.json', 'utf8')) as ApiEvidence;
const browser = JSON.parse(readFileSync('test-artifacts\\browser-evidence.json', 'utf8')) as BrowserEvidence;
const entries = traceability.map(journey => {
  const verified = api.journeys.find(row => row.id === journey.id);
  return { ...journey, primaryApiStatus: verified?.status ?? 'NOT_VERIFIED', apiEvidence: verified?.evidence ?? [],
    browserBehavior: browser.behavioralEvidence.filter(row => row.journeys.includes(journey.id)).map(row => row.behavior),
    browserRendered: browser.renderedJourneys.includes(journey.id) };
});
if (entries.some(entry => entry.primaryApiStatus !== 'primary_api_behavior_verified')) throw new Error('Some journeys lack primary API evidence. Do not publish a complete-primary-path claim.');
mkdirSync('docs', { recursive: true });
writeFileSync('docs\\traceability.json', JSON.stringify({
  generatedAt: new Date().toISOString(), apiRunAt: api.generatedAt, browserRunAt: browser.generatedAt,
  scope: '87 implemented journey workspaces and verified primary API paths. Browser behavior is evidence only for the interactions explicitly listed; all-route rendering is reported separately.',
  limitations: [
    'Public synthetic personas, OTP, captcha and signing PIN are demonstrations, not production authentication or legal clinical signatures.',
    'No live ETHER, ABDM, messaging, payment, insurance, video, audio or laboratory-provider integrations.',
    'Native device encryption/biometric unlock/screenshot blocking/remote OS wipe are not implemented by a web page. Browser data uses persona-isolated encrypted IndexedDB.',
    'Hindi doctor navigation is implemented; comprehensive Hindi field/content/PDF localization is not complete. Generated PDFs use English labels.',
    'Pen drawing and reviewed image attachment work; speech/handwriting text recognition use explicitly labelled transcript simulations.',
    'One active role per named demo persona. Production multi-role identities, network restrictions, recovery-code enrollment, clinical interaction knowledge and hospital-specific authorization policy remain unvalidated.',
    'Physical scanners, webcam capture, printers and signature capture are exercised through file/PDF/reference simulations, not hardware integrations.',
    'All primary journey flows are tested, not all 349 illustrated PRD screen states or every optional administrative/financial branch. No scale, accessibility certification or production-readiness claim.'
  ],
  journeys: entries
}, null, 2));
console.log(`Persisted ${entries.length} journey mappings; ${entries.filter(entry => entry.browserBehavior.length).length} have substantive browser interaction evidence; ${entries.filter(entry => entry.browserRendered).length} rendered.`);
