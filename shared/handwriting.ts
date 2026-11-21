// Shared vocabulary for tablet handwritten records, used by the mock backend and the web desks.
export const visitStatusCodes: Record<string, string> = {
  Booked: 'BOOKED', Waiting: 'WAITING', Called: 'CALLED', 'In consultation': 'IN_CONSULTATION', Held: 'ON_HOLD',
  Done: 'COMPLETED', Missed: 'MISSED', Cancelled: 'CANCELLED'
};
export function visitStatusCode(status: string): string {
  return visitStatusCodes[status] ?? status.toUpperCase().replace(/[^A-Z]+/g, '_');
}
export function patientVisitMessage(status: string, token: number | null, date: string, time: string): string {
  switch (status) {
    case 'BOOKED': return `Appointment booked for ${date}${time ? ` at ${time}` : ''}.`;
    case 'WAITING': return token ? `Checked in. Your token is ${token}.` : 'Checked in.';
    case 'CALLED': return token ? `Token ${token} is being called. Please go to the doctor's room.` : 'You are being called.';
    case 'IN_CONSULTATION': return 'Your consultation has started.';
    case 'COMPLETED': return 'Your visit is complete. Documents appear here when the doctor shares them.';
    case 'CANCELLED': return 'Your appointment was cancelled. Contact the front desk if this is unexpected.';
    case 'MISSED': return token ? `Token ${token} was missed. Please see the front desk.` : 'Your appointment was missed.';
    default: return 'Your visit was updated.';
  }
}
export const documentTypeLabels: Record<string, string> = {
  VISIT_SUMMARY: 'Visit summary', PRESCRIPTION: 'Prescription', INVESTIGATIONS: 'Investigations', ADVICE_REFERRAL: 'Advice / referral', OTHER: 'Other document'
};
export const deliveryStateLabels: Record<string, string> = {
  AVAILABLE: 'Available', VIEWED: 'Viewed', DISPENSED: 'Dispensed', PARTIALLY_DISPENSED: 'Partially dispensed', NOT_DISPENSED: 'Not dispensed',
  SAMPLE_COLLECTED: 'Sample collected', RESULT_READY: 'Result ready', SUPERSEDED: 'Superseded'
};
export const deliveryStateByLabel: Record<string, string> = Object.fromEntries(Object.entries(deliveryStateLabels).map(([code, label]) => [label, code]));
export const recipientKindLabels: Record<string, string> = { PHARMACY: 'Hospital pharmacy', LAB: 'Lab', PATIENT: 'Patient app' };
export const resultFlagCodes: Record<string, string> = { Normal: 'NORMAL', Abnormal: 'ABNORMAL', Critical: 'CRITICAL' };
export const resultFlagLabels: Record<string, string> = { NORMAL: 'Normal', ABNORMAL: 'Abnormal', CRITICAL: 'Critical' };
export const handwritingTypes = ['handwrittenDocument', 'handwritingDelivery', 'investigationResult'] as const;
export const mainLabId = 'central-lab';
// Demo assumption: lab staff without an explicit lab assignment work in the main pathology lab.
export function actorLabIds(actor: { labIds?: string[] }): string[] {
  return actor.labIds?.length ? actor.labIds : [mainLabId];
}
export type Routing = { pharmacy: boolean; labs: string[]; patient: boolean };
export function routingFrom(value: unknown): Routing {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return { pharmacy: data.pharmacy === true, labs: Array.isArray(data.labs) ? data.labs.filter((lab): lab is string => typeof lab === 'string') : [], patient: data.patient === true };
}
