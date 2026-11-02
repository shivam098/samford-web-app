import { journeys } from './journeys.js';
import { commands } from './commands.js';
const reads: Record<string, string[]> = {
  DJ01: ['/api/access', '/api/access/track', '/api/auth/start', '/api/auth/otp', '/api/auth/password', '/api/auth/confirm'],
  DJ02: ['/api/profile/{doctorId}/qr', '/profile/{doctorId}', '/api/reports/activity'], DJ03: ['/api/state', '/api/auth/lock', '/api/auth/unlock'],
  DJ04: ['/api/slots'], DJ05: ['/api/entities?type=visit'], DJ06: ['/api/board/{id}'],
  DJ07: ['/api/history/{id}', '/api/documents/{id}/file'], DJ16: ['/api/documents/{id}/file'],
  DJ24: ['/api/auth/logout', '/api/auth/lock'], DJ25: ['/api/receipts/{operationId}', '/api/sync/device', '/api/demo/fault'],
  AJ01: ['/api/auth/start', '/api/auth/otp', '/api/auth/logout'], AJ02: ['/api/state'],
  AJ08: ['/api/accounts/{id}/handover'], AJ09: ['/api/accounts/{id}/handover'], AJ10: ['/api/accounts/{id}/handover'],
  AJ11: ['/api/device/wipe-ack'], AJ18: ['/api/reports/activity'], AJ19: ['/api/reports/{kind}'],
  AJ20: ['/api/audit'], AJ23: ['/api/entities?type=integration'],
  SJ01: ['/api/auth/demo', '/api/auth/start', '/api/auth/otp'], SJ03: ['/api/slots'], SJ05: ['/api/board/{id}'],
  SJ06: ['/api/documents/{id}/file'], SJ08: ['/api/packages/{id}/quote', '/api/admissions/{id}/estimate', '/api/reports/claims'],
  SJ09: ['/api/counters/summary', '/api/reports/day-end'], SJ19: ['/api/admissions/{id}/estimate'], SJ30: ['/api/reports/{kind}'],
  SJ34: ['/api/auth/captcha', '/api/auth/patient', '/api/auth/otp'], SJ35: ['/api/slots'], SJ36: ['/api/documents/{id}/file']
};
export const traceability = journeys.map(journey => ({
  ...journey, ui: `/#journey/${journey.id}`,
  apis: [...(reads[journey.id] ?? []), ...commands.filter(command => command.journeys.includes(journey.id)).map(command => `/api/commands/${command.name}`)],
  workflowCommands: commands.filter(command => command.journeys.includes(journey.id)).map(command => ({ name: command.name, roles: command.roles, allowedFrom: command.from ?? [], target: command.target ?? null })),
  evidenceFile: 'docs/traceability.json',
  verificationScope: 'Primary substantive API journey behavior, plus explicitly listed browser interactions. A rendered route is not behavioral evidence for every substep.'
}));
