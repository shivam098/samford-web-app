export const handoverGroups = [
  { key: 'referralsSent', label: 'Pending referrals sent' },
  { key: 'referralsReceived', label: 'Pending referrals received' },
  { key: 'unsignedNotes', label: 'Unsigned notes' },
  { key: 'admissions', label: 'Admissions and ward responsibility' },
  { key: 'followups', label: 'Visits and follow-up bookings' },
  { key: 'questions', label: 'Unanswered clinical questions' },
  { key: 'pendingCare', label: 'Pending prescriptions, tests and result reviews' }
] as const;
export type HandoverGroupKey = typeof handoverGroups[number]['key'];
