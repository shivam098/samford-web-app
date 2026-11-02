import { doctorRoles, staffRoles, type CommandDef, type Field, type Role } from './model.js';
const d = doctorRoles;
const a: Role[] = ['superadmin', 'admin'];
const it: Role[] = [...a, 'it'];
const desk: Role[] = ['desk', 'manager'];
const cash: Role[] = ['cashier', 'manager'];
const f = (key: string, label: string, kind: Field['kind'] = 'text', extra: Partial<Field> = {}): Field => ({ key, label, kind, required: true, ...extra });
const opt = (key: string, label: string, kind: Field['kind'] = 'text', extra: Partial<Field> = {}): Field => f(key, label, kind, { required: false, ...extra });
const select = (key: string, label: string, options: string[], extra: Partial<Field> = {}): Field => f(key, label, 'select', { options, ...extra });
const entity = (key: string, label: string, source: string, extra: Partial<Field> = {}): Field => f(key, label, 'entity', { source, ...extra });
const yes = (key: string, label: string, required = true): Field => f(key, label, 'boolean', { required });
const reason = f('reason', 'Reason', 'textarea');
const patient = entity('patientId', 'Patient', 'patient');
const visit = entity('visitId', 'Visit', 'visit');
const admission = entity('admissionId', 'Admission', 'admission', { states: ['Admitted'] });
const doctor = entity('doctorId', 'Consultant', 'doctor');
const department = entity('departmentId', 'Department', 'department');
const date = f('date', 'Date', 'date');
const amount = f('amount', 'Amount (INR)', 'number', { min: 0 });
const medicines = f('lines', 'Medicines to review', 'medicines');
const tests = f('tests', 'Tests to order', 'tests');
const clinicalReview = yes('reviewed', 'I reviewed this synthetic clinical content');
const c = (name: string, label: string, journeys: string[], roles: Role[], fields: Field[], help: string, target?: string, from?: string[], extra: Partial<CommandDef> = {}): CommandDef =>
  ({ name, label, journeys, roles, fields, help, target, from, ...extra });

export const commands: CommandDef[] = [
  c('profile.correction', 'Report a profile correction', ['DJ01'], d, [reason], 'Sends the correction to administration without changing your identity.'),
  c('preferences.save', 'Save my preferences', ['DJ02'], d, [
    select('theme', 'Theme', ['Light', 'Dark']), select('textSize', 'Text size', ['100%', '125%', '150%', '200%']),
    select('language', 'Navigation language', ['English', 'Hindi']), select('printLanguage', 'Print language', ['English', 'Hindi']),
    f('quietFrom', 'Quiet hours start', 'time', { default: '21:00' }), f('quietTo', 'Quiet hours end', 'time', { default: '07:00' }),
    yes('sound', 'Sound for routine alerts', false), yes('vibration', 'Vibration', false),
    f('homeOrder', 'Home cards (comma-separated)', 'text', { default: 'visits,referrals,results,admissions,pending' }),
    opt('hiddenCards', 'Hidden cards (comma-separated)', 'text', { help: 'referrals and results cannot be hidden' }),
    f('rows', 'Rows per card', 'number', { min: 1, max: 20, default: 5 }),
    opt('shortcuts', 'Shortcut journey IDs (up to six, comma-separated)'),
    select('sort', 'Visit sort', ['Token', 'Time', 'Urgency'])
  ], 'Preferences follow your account; critical alerts and mandatory Home cards cannot be disabled.'),
  c('presence.set', 'Tell the team where I am', ['DJ03'], d, [
    select('status', 'Presence', ['In OPD', 'On ward round', 'In OT', 'Away', 'Offline']), opt('room', 'Room'), opt('minutes', 'Away for minutes', 'number', { default: 30, min: 1, max: 240 })
  ], 'Local save is not desk receipt. The board updates only after acceptance.', undefined, undefined, { local: true }),
  c('availability.request', 'Request an availability change', ['DJ04'], d, [
    select('kind', 'Change', ['Leave', 'Late start', 'Early finish', 'Extra session']), date, f('endDate', 'Through date', 'date'),
    opt('start', 'New start time', 'time'), opt('end', 'New end time', 'time'), reason
  ], 'The affected booking count is computed from shared visits. No appointments move until the desk responds.'),
  c('visit.call', 'Call this token', ['DJ06'], d, [], 'Updates the token-only board; three unanswered recalls mark the visit Missed.', 'visit', ['Waiting', 'Called', 'Missed']),
  c('visit.skip', 'Skip this call for five minutes', ['DJ06'], d, [reason], 'Keeps the original token and place; Call next temporarily skips it. You can still call it explicitly.', 'visit', ['Called']),
  c('visit.open', 'Patient confirmed: open visit', ['DJ06'], d, [yes('confirmed', 'I checked name, UHID and allergy status')], 'Only a confirmed patient moves into consultation.', 'visit', ['Waiting', 'Called', 'Held', 'Missed']),
  c('history.add', 'Record history', ['DJ07'], d, [patient, select('section', 'History section', ['Medical', 'Family', 'Surgical', 'Social', 'Ocular', 'Dental', 'Obstetric']), f('detail', 'History', 'textarea')], 'Every entry retains its author; specialty sections must be enabled for your department.'),
  c('allergy.add', 'Record allergy status', ['DJ07'], d, [patient,
    select('substance', 'Substance', ['Penicillin', 'Paracetamol', 'Peanut', 'Other', 'No known allergies']),
    opt('reaction', 'Reaction'), select('certainty', 'Certainty', ['Confirmed', 'Suspected', 'No known allergies'])
  ], 'Allergy changes increment the patient context version used for prescription checks.'),
  c('allergy.void', 'Mark allergy entered in error', ['DJ07'], d, [reason], 'Keeps the original entry and correction history.', 'allergy', ['Active']),
  c('vital.record', 'Save vitals & examination', ['DJ08', 'SJ18'], [...d, 'nurse'], [
    patient, opt('visitId', 'Visit', 'entity', { source: 'visit' }), opt('admissionId', 'Admission', 'entity', { source: 'admission' }),
    f('systolic', 'Systolic BP (mmHg)', 'number', { min: 20, max: 400, default: 120 }),
    f('diastolic', 'Diastolic BP (mmHg)', 'number', { min: 10, max: 300, default: 80 }),
    f('pulse', 'Pulse /min', 'number', { min: 10, max: 300, default: 76 }),
    f('respiratory', 'Respiratory rate /min', 'number', { min: 1, max: 100, default: 18 }),
    f('temperature', 'Temperature (C)', 'number', { min: 25, max: 50, default: 37 }),
    f('spo2', 'SpO2 (%)', 'number', { min: 1, max: 100, default: 98 }),
    f('weight', 'Weight (kg)', 'number', { min: 0.1, max: 500, default: 60 }),
    f('height', 'Height (cm)', 'number', { min: 20, max: 250, default: 165 }),
    opt('ofc', 'Head circumference (under 5 only, cm)', 'number', { min: 10, max: 80 }),
    opt('pain', 'Pain score (0-10)', 'number', { min: 0, max: 10 }),
    opt('intake', 'Intake (mL)', 'number', { min: 0 }), opt('output', 'Output (mL)', 'number', { min: 0 }),
    opt('signs', 'Present examination signs', 'checklist', { options: ['Pallor', 'Icterus', 'Cyanosis', 'Clubbing', 'Koilonychia', 'Oedema', 'Dehydration', 'Neck glands'] }),
    opt('details', 'Examination details', 'textarea'), yes('restAbsent', 'Mark the remaining signs absent', false),
    yes('extremeConfirmed', 'I rechecked any extreme measurements', false), yes('doctorTold', 'Doctor told about danger-range readings', false)
  ], 'Extreme readings require confirmation. SpO2 below 90 creates a durable consultant alert.', undefined, undefined, { local: true }),
  c('vital.acknowledge', 'Acknowledge ward danger reading', ['DJ18'], ['doctor'], [f('action', 'Action taken', 'textarea')], 'A read alone is not acknowledgement. Records the treating doctor and action.', 'vital', ['Recorded']),
  c('note.save', 'Review & save note version', ['DJ09'], d, [visit,
    select('mode', 'Writing mode', ['Type', 'Template', 'Dictation simulation', 'Pen simulation']),
    f('complaints', 'Chief complaints', 'textarea'), f('illness', 'Present illness', 'textarea'),
    opt('systems', 'Review of systems', 'textarea'), f('diagnosis', 'Diagnosis (synthetic text)'),
    opt('icd', 'ICD-10 code'), select('certainty', 'Diagnosis status', ['Provisional', 'Final']),
    opt('labAdvice', 'Lab advice', 'textarea'), opt('advice', 'Advice', 'textarea'),
    opt('followupNote', 'Follow-up note'), opt('labFindings', 'Lab findings', 'textarea'),
    opt('handwriting', 'Reviewed handwriting image (optional)', 'file'), clinicalReview
  ], 'Saving again adds a new immutable version. A missing ICD code creates a coder request.', undefined, undefined, { local: true }),
  c('note.countersign', 'Countersign resident note', ['DJ09'], ['doctor'], [clinicalReview], 'The consultant reviews the latest resident draft before the visit can be finished.', 'note', ['Draft']),
  c('rx.approve', 'Approve prescription version', ['DJ10'], d, [visit, medicines,
    opt('warningReason', 'Reason to proceed despite an allergy/duplicate warning', 'textarea'),
    yes('sendNow', 'Send to pharmacy now', false), clinicalReview
  ], 'Resident prescriptions remain drafts until a consultant countersigns. Stock shown is not a reservation.', undefined, undefined, { local: true }),
  c('rx.countersign', 'Countersign resident prescription', ['DJ10', 'DJ18'], ['doctor'], [clinicalReview], 'Approve only a prescription in your care scope.', 'rx', ['Draft']),
  c('rx.send', 'Send approved prescription', ['DJ10'], ['doctor'], [], 'Routing is separate from approval; the pharmacist must acknowledge/dispense.', 'rx', ['Approved']),
  c('set.personal', 'Save a personal set', ['DJ10', 'DJ11'], d, [
    f('name', 'Set name'), select('kind', 'Set type', ['Medicines', 'Tests']), opt('lines', 'Medicine lines', 'medicines'), opt('tests', 'Tests', 'tests'),
    yes('offerDepartment', 'Offer for department review', false)
  ], 'Department publication still requires a clinical reviewer.'),
  c('catalog.request', 'Request a missing item', ['DJ10'], d, [f('name', 'Requested medicine'), reason], 'Creates a pharmacy/master-data request; never silently substitutes.'),
  c('order.send', 'Send test order', ['DJ11'], d, [visit, tests,
    select('reference', 'Reference type', ['OPD', 'IPD', 'Day care']),
    select('priority', 'Priority', ['Routine', 'Urgent', 'STAT']), f('history', 'Clinical history', 'textarea'),
    f('diagnosis', 'Related diagnosis'), opt('remarks', 'Lab remarks')
  ], 'Each test gets its own order, charge and fulfillment state; cash orders wait for payment.', undefined, undefined, { local: true }),
  c('order.cancel', 'Cancel uncollected test', ['DJ11'], ['doctor'], [reason], 'Preserves the original order; paid tests create a refund approval request.', 'order', ['Payment pending', 'Cleared', 'Recollection needed', 'Collection held']),
  c('followup.request', 'Save follow-up plan', ['DJ12'], d, [visit, date, f('note', 'Patient instructions', 'textarea'),
    yes('print', 'Include on prescription', false), yes('requestBooking', 'Ask desk to book', false), opt('doctorId', 'Requested doctor', 'entity', { source: 'doctor' }), opt('time', 'Preferred time', 'time')
  ], 'A recommendation remains even when no booking is requested or the request is declined.', undefined, undefined, { local: true }),
  c('followup.acknowledge', 'Acknowledge booking response', ['DJ12'], d, [], 'Clears the booking notification without changing the recommendation or confirmed appointment.', 'followup', ['Booked', 'Declined']),
  c('referral.send', 'Send referral', ['DJ13'], d, [visit, select('kind', 'Referral type', ['Internal', 'External']), department,
    opt('receiverId', 'Receiving consultant', 'entity', { source: 'doctor' }), opt('hospital', 'External hospital'),
    select('purpose', 'Purpose', ['Investigation', 'Treatment', 'Follow-up']), date,
    select('urgency', 'Urgency', ['Routine', 'Urgent', 'Emergency']), reason
  ], 'A duty-doctor route uses the published roster. No names are put in public notifications.', undefined, undefined, { local: true }),
  c('referral.see', 'Mark referral seen', ['DJ21'], ['doctor'], [], 'Seen is not accepted and does not remove the Home task.', 'referral', ['Sent']),
  c('referral.answer', 'Answer referral', ['DJ21'], ['doctor'], [
    select('decision', 'Decision', ['Accept', 'Decline', 'Suggest another doctor']), f('reply', 'Reply / reason', 'textarea'),
    opt('receiverId', 'Suggested doctor', 'entity', { source: 'doctor' })
  ], 'Only the receiving or covering doctor can answer. Accepted urgent referrals create a visit.', 'referral', ['Sent', 'Seen']),
  c('admission.request', 'Request admission', ['DJ14'], ['doctor'], [visit, doctor,
    select('category', 'Ward category', ['General', 'Private', 'ICU']), date, f('diagnosis', 'Provisional diagnosis'), f('expectedDays', 'Expected stay (days)', 'number', { min: 1, max: 365, default: 3 })
  ], 'Creates a request, not a bed reservation.'),
  c('operation.request', 'Request an operation', ['DJ14'], ['doctor'], [patient, opt('admissionId', 'Admission', 'entity', { source: 'admission' }),
    f('procedure', 'Synthetic procedure'), date, f('duration', 'Expected duration (minutes)', 'number', { min: 15, max: 720, default: 60 }),
    select('anaesthesia', 'Anaesthesia', ['General', 'Regional', 'Local']), doctor, opt('assistant', 'Assistant'),
    yes('consentExplained', 'Consent explained', false), yes('fitness', 'Anaesthetist fitness received', false)
  ], 'OT offers a slot. Missing fitness remains pending.'),
  c('operation.respond', 'Respond to the offered OT slot', ['DJ14'], ['doctor'], [select('decision', 'Slot decision', ['Accept', 'Request another']), reason], 'Doctor acceptance does not bypass the pre-operative checklist.', 'operation', ['Offered']),
  c('visit.hold', 'Hold visit', ['DJ15'], d, [reason], 'Preserves all notes and orders.', 'visit', ['Waiting', 'Called', 'In consultation']),
  c('visit.resume', 'Resume held visit', ['DJ15'], d, [], 'Returns a held visit to the waiting list.', 'visit', ['Held']),
  c('visit.cancel', 'Cancel visit', ['DJ15', 'SJ03', 'SJ35'], [...d, ...desk, 'patient'], [reason], 'Preserves clinical history and creates a refund request for eligible paid cancellations.', 'visit', ['Booked', 'Waiting', 'Held', 'Called', 'In consultation']),
  c('visit.move', 'Move visit', ['DJ15', 'SJ03'], [...d, ...desk], [doctor, date, f('time', 'Time', 'time'), reason, yes('agreed', 'Patient agreed to the move')], 'The new slot is checked atomically; the original visit and its history survive.', 'visit', ['Booked', 'Waiting', 'Held', 'Called', 'In consultation', 'Missed']),
  c('document.generate', 'Create sample PDF', ['DJ16', 'SJ04', 'SJ07', 'SJ10', 'SJ11', 'SJ14', 'SJ16', 'SJ19', 'SJ36'], [...d, 'desk', 'cashier', 'patient', 'nurse', 'manager', 'lab', 'pharmacist'], [patient,
    select('kind', 'Document', ['Prescription', 'OPD slip', 'ID card', 'OPD summary', 'Casesheet', 'Bill', 'Receipt', 'Result', 'Discharge summary', 'Referral letter', 'Admission form', 'Wristband', 'Gate pass', 'Sample label', 'Dispatch manifest']),
    opt('sourceId', 'Source record ID (or leave blank for latest)'), opt('sections', 'Included note sections', 'checklist', { options: ['complaints', 'illness', 'systems', 'diagnosis', 'advice', 'followupNote', 'labFindings'] })
  ], 'Generates an actual watermarked PDF from an authorized immutable snapshot. Reprints say Duplicate.'),
  c('document.share', 'Send document (simulated)', ['DJ16'], d, [select('channel', 'Channel', ['SMS', 'WhatsApp', 'OPD printer'])], 'Destination is the registered mobile or OPD printer; no typed recipient is accepted.', 'document', ['Available']),
  c('certificate.issue', 'Issue a sample certificate', ['DJ16'], ['doctor'], [patient, f('title', 'Certificate type'), f('content', 'Reviewed certificate text', 'textarea'), clinicalReview], 'Creates a numbered synthetic certificate that desk staff may print, never edit.'),
  c('visit.done', 'Finish & call next', ['DJ17'], d, [yes('reviewed', 'Note, prescription, tests and follow-up reviewed'), yes('noUnsaved', 'No unsaved note remains')], 'Completes once and calls the next token in the same doctor/day/mode/type queue.', 'visit', ['In consultation', 'Held']),
  c('round.save', 'Save ward round note', ['DJ18'], d, [admission, f('findings', 'Findings', 'textarea'), select('condition', 'Condition', ['Improving', 'Same', 'Worse']), f('plan', 'Plan', 'textarea'), clinicalReview], 'Preserves each round and its author.', undefined, undefined, { local: true }),
  c('ward.order', 'Write a ward order', ['DJ18'], d, [admission,
    select('kind', 'Order type', ['Medicine', 'Diet', 'ICU transfer']), opt('itemId', 'Medicine', 'entity', { source: 'item' }),
    f('instruction', 'Instruction'), opt('dose', 'Dose'), opt('schedule', 'Dose times (comma-separated)', 'text', { default: '08:00,20:00' }),
    select('diet', 'Diet (for diet orders)', ['Normal', 'Diabetic', 'Soft', 'Liquid', 'Nil by mouth']), clinicalReview
  ], 'Resident orders require consultant countersignature before nursing can act.'),
  c('ward.countersign', 'Countersign ward order', ['DJ18'], ['doctor'], [clinicalReview], 'Makes a resident draft actionable by the ward.', 'wardOrder', ['Draft']),
  c('ward.stop', 'Stop ward order', ['DJ18'], ['doctor'], [reason], 'Previous administrations remain; new doses are blocked.', 'wardOrder', ['Active']),
  c('discharge.draft', 'Draft discharge summary', ['DJ19'], d, [admission, f('diagnosis', 'Diagnosis'), f('course', 'Course in hospital', 'textarea'),
    f('procedures', 'Procedures', 'textarea'), f('condition', 'Condition at discharge'), medicines, f('followup', 'Follow-up'), clinicalReview
  ], 'Draft is not approval and does not start billing clearance.'),
  c('discharge.approve', 'Approve discharge', ['DJ19'], ['doctor'], [
    f('pin', 'Demo signing PIN', 'password', { help: 'Synthetic attestation PIN: 2468. Not a legal clinical signature.' }),
    f('pendingPlan', 'Plan / ownership for pending work', 'textarea'), clinicalReview
  ], 'Queues both nursing and billing handoffs. Actual bed release is a separate gate-pass command.', 'discharge', ['Draft']),
  c('result.review', 'Record report review', ['DJ20'], ['doctor'], [
    select('decision', 'Review', ['Seen with action', 'Seen without action', 'Repeat test']), f('action', 'Action or reason', 'textarea')
  ], 'Records review of this exact released version; corrections require another review.', 'result', ['Released']),
  c('question.answer', 'Answer clinical question', ['DJ22'], ['doctor'], [
    select('decision', 'Answer', ['Approve proposal', 'Keep original', 'Yes', 'No']), f('reply', 'Reply and reason', 'textarea'), clinicalReview
  ], 'A stale prescription question is refused. Approved substitutions create a new reviewed version.', 'question', ['Open']),
  c('video.start', 'Complete video precheck', ['DJ23'], ['doctor'], [visit,
    yes('privateRoom', 'Private room checked'), yes('equipment', 'Simulated camera and microphone checked'), yes('guardian', 'Guardian present if under 18')
  ], 'Creates a simulated waiting room. No real media permission or transmission.'),
  c('video.transition', 'Update simulated call', ['DJ23'], ['doctor'], [
    select('next', 'Call action', ['Patient joined', 'Connect', 'Mute', 'Camera off', 'Drop connection', 'Reconnect', 'Switch to phone', 'Running late', 'End', 'No show'])
  ], 'Only valid call transitions are accepted; duration and note linkage survive a dropped connection.', 'video'),
  c('abha.request', 'Request simulated ABHA OTP', ['DJ26', 'SJ02'], [...d, ...desk], [patient, f('address', 'Synthetic ABHA address', 'text', { default: 'demo.patient@abdm' }), yes('present', 'Patient is present'), yes('consent', 'Patient consents to linking')], 'Returns a synthetic OTP with expiry. No request goes to ABDM.'),
  c('abha.verify', 'Verify ABHA OTP', ['DJ26'], [...d, ...desk], [f('otp', 'Simulated six-digit OTP')], 'Wrong or expired OTP cannot link records.', 'abha', ['OTP sent']),
  c('abha.withdraw', 'Withdraw ABHA sharing consent', ['DJ26'], [...d, 'patient'], [reason], 'Keeps the consent audit history; stops simulated sharing.', 'abha', ['Linked']),
  c('help.create', 'Ask the help desk', ['DJ27'], d, [select('topic', 'Topic', ['App problem', 'Wrong data', 'Access', 'Printer']), f('detail', 'Privacy-safe description (no patient details)', 'textarea')], 'Support receives account and device metadata only. Screenshots are deliberately not uploaded.'),
  c('article.read', 'Mark guide read / helpful', ['DJ27'], [...d, ...staffRoles], [yes('helpful', 'This guide was helpful', false)], 'Read status is per account.', 'article', ['Published']),

  c('account.create', 'Create doctor account', ['AJ04'], a, [
    f('name', 'Full synthetic name'), f('staffId', 'Unique staff ID'), f('registration', 'Synthetic council registration'),
    f('login', 'Login ID'), f('mobile', 'Synthetic mobile'), f('email', 'Work e-mail'), department,
    select('role', 'Clinical role', ['doctor', 'resident']), f('qualification', 'Qualification'), f('room', 'OPD room'),
    opt('copyFrom', 'Copy work setup from', 'entity', { source: 'doctor' })
  ], 'The server generates a temporary password, shown only in the action receipt.'),
  c('access.approve', 'Approve access request', ['AJ03'], a, [department, select('role', 'Approved role', ['doctor', 'resident']), f('room', 'OPD room')], 'Checks unique staff ID and registration before creating an invited login.', 'access', ['Requested']),
  c('access.reject', 'Reject access request', ['AJ03'], a, [reason], 'The requesting doctor can see the reason through the request tracking code.', 'access', ['Requested']),
  c('account.import', 'Preview doctor CSV', ['AJ05'], a, [
    f('csv', 'CSV: name,staffId,registration,login,mobile,email,departmentId,role,qualification,room', 'csv')
  ], 'Nothing is created in preview. Errors and duplicates remain editable in the CSV.'),
  c('account.importCommit', 'Create ready CSV rows', ['AJ05'], a, [yes('confirmed', 'Create ready rows; skip errors and duplicates')], 'Rechecks uniqueness at commit. Temporary passwords are shown once.', 'import', ['Preview']),
  c('account.reset', 'Issue temporary password', ['AJ06'], it, [
    yes('identityChecked', 'Callback and staff ID checked'), reason, yes('signOut', 'Sign out other devices', false)
  ], 'Old credentials stop working immediately; own-account and deactivated resets are prohibited.', 'account'),
  c('account.unlock', 'Unlock account', ['AJ07'], it, [yes('identityChecked', 'Identity checked'), reason], 'Retains the failed-attempt audit.', 'account', ['Locked']),
  c('account.edit', 'Save profile changes', ['AJ08'], a, [
    f('name', 'Full synthetic name'), department, f('room', 'Room'), f('qualification', 'Qualification'), reason,
    opt('receiverId', 'Handover receiver if changing department', 'entity', { source: 'doctor' })
  ], 'Before/after appears in the audit. Department transfers require a receiver for open work.', 'account'),
  c('account.suspend', 'Pause account', ['AJ09'], a, [reason, opt('endDate', 'Automatic return date', 'date'), yes('confirmed', 'I confirm this removes access')], 'Existing sessions stop accessing records; encrypted local drafts remain recoverable.', 'account', ['Active']),
  c('account.reactivate', 'Reactivate account', ['AJ09', 'AJ10'], a, [reason], 'Only a super admin may restore Deactivated accounts.', 'account', ['Suspended', 'Deactivated']),
  c('account.deactivate', 'Deactivate & hand over', ['AJ10'], a, [
    entity('receiverId', 'Receiving consultant', 'doctor'), f('confirmName', 'Type the account name'), reason,
    f('unsentPlan', 'Unsent-work recovery / accepted loss plan', 'textarea'), yes('confirmed', 'I confirm access removal')
  ], 'Transfers open responsibility, not authorship; ends sessions and keeps all records.', 'account'),
  c('account.scheduleExit', 'Schedule last-day deactivation', ['AJ10'], a, [
    f('lastWorkingDay', 'Last working day', 'date'), entity('receiverId', 'Receiving consultant', 'doctor'),
    f('confirmName', 'Type the account name'), reason, f('unsentPlan', 'Unsent-work recovery / accepted loss plan', 'textarea'), yes('confirmed', 'I confirm scheduled access removal')
  ], 'Schedules the checked handover for 23:59 IST on the last working day. No HR integration is connected.', 'account', ['Active']),
  c('device.signout', 'Sign out device', ['AJ11'], it, [reason, yes('confirmed', 'Confirm sign-out')], 'Device is rejected on its next request. Local drafts stay encrypted.', 'device'),
  c('device.wipe', 'Request browser-app wipe', ['AJ11'], ['superadmin', 'it'], [reason, f('lossPlan', 'Unsent work recovery or acknowledged loss'), yes('confirmed', 'Remove only Samford data at next check-in')], 'The device remains Wipe pending until its next check-in reports a wipe result.', 'device'),
  c('device.minimum', 'Set minimum app version', ['AJ11'], ['superadmin', 'it'], [f('version', 'Minimum version', 'number', { min: 1, max: 100, default: 1 }), date, reason], 'Older clients keep drafts but cannot submit after the start date.'),
  c('department.save', 'Add department', ['AJ12'], a, [f('name', 'Name'), f('shortName', 'Short name'), opt('head', 'Head'), yes('referrals', 'Accept referrals', false), yes('duty', 'Has duty doctor', false)], 'A new department becomes available to the referral picker.'),
  c('room.save', 'Add room', ['AJ12'], a, [f('name', 'Room'), department, f('floor', 'Floor')], 'Rooms are shared with booking and patient slips.'),
  c('session.save', 'Publish OPD session', ['AJ12'], a, [doctor, date, f('start', 'Start', 'time'), f('end', 'End', 'time'), f('room', 'Room'), f('slotMinutes', 'Slot minutes', 'number', { default: 10, min: 5, max: 60 })], 'Sessions cannot overlap for a doctor; holidays block new slots.'),
  c('holiday.save', 'Add hospital holiday', ['AJ12'], a, [date, reason], 'No new appointments on the holiday; existing bookings require front-desk moves.'),
  c('roster.save', 'Publish duty / swap', ['AJ13'], a, [department, doctor, date, select('shift', 'Shift', ['Day', 'Night', 'On call']), reason], 'Inactive doctors cannot be assigned. One roster cell per department/date/shift.'),
  c('roster.import', 'Import duty CSV', ['AJ13'], a, [f('csv', 'CSV: departmentId,doctorId,date,shift,reason', 'csv')], 'Every row is validated before any roster entry changes.'),
  c('job.presence', 'Run 22:00 presence reset', ['AJ13', 'DJ24'], ['superadmin'], [date], 'An idempotent demo run at 22:00 IST skips on-call/night duty and does not sign users out.'),
  c('set.publish', 'Publish department set', ['AJ14'], a, [
    department, f('name', 'Set name'), select('kind', 'Type', ['Medicines', 'Tests']),
    opt('lines', 'Medicines', 'medicines'), opt('tests', 'Tests', 'tests'), f('reviewer', 'Clinically reviewed by'), reason
  ], 'Adds a version and checks active catalog identities.'),
  c('template.publish', 'Publish note template', ['AJ14'], a, [department, f('name', 'Name'), select('kind', 'Type', ['OPD', 'Round', 'Discharge']), f('content', 'Template text', 'textarea'), f('reviewer', 'Clinical reviewer'), reason], 'The doctor can load this template without replacing a saved note.'),
  c('letterhead.publish', 'Publish letterhead', ['AJ14'], a, [f('name', 'Hospital name'), f('address', 'Address'), f('phone', 'Phone'), f('footer', 'Footer'), reason], 'All future sample PDFs use this version; prior PDFs remain unchanged.'),
  c('routing.save', 'Set referral routing', ['AJ15'], a, [department, select('receiver', 'Receiver', ['Chosen consultant', 'Duty doctor', 'Department queue']),
    opt('escalateTo', 'Escalation consultant', 'entity', { source: 'doctor' }), f('minutes', 'Urgent reminder minutes', 'number', { min: 1, max: 1440, default: 30 })
  ], 'Applied to future referrals and durable escalation checks.'),
  c('wording.save', 'Save notification wording', ['AJ15'], a, [
    select('kind', 'Message type', ['Referral', 'Critical result', 'Question', 'Announcement']),
    f('unlocked', 'Unlocked text', 'text', { default: '{doctor} has an update for {patient}' }),
    f('locked', 'Lock-screen text', 'text', { default: 'A new update is waiting. Unlock to view.' })
  ], 'Lock-screen text must be generic: no identity placeholders, names or identifiers.'),
  c('feature.save', 'Set department feature', ['AJ16'], a, [department,
    select('feature', 'Feature', ['Video', 'Dictation', 'WhatsApp', 'Ocular', 'Dental', 'Obstetric']), select('state', 'Availability', ['On', 'Off', 'Pilot']),
    opt('pilotDoctors', 'Pilot doctor IDs (comma-separated)')
  ], 'API and UI enforce availability; drafts remain encrypted locally.'),
  c('announcement.publish', 'Publish announcement', ['AJ16'], a, [f('title', 'Title'), f('content', 'Message', 'textarea'),
    select('audience', 'Audience', ['All', 'Doctors', 'Staff']), opt('departmentId', 'Department (optional)', 'entity', { source: 'department' }),
    f('start', 'Starts', 'datetime'), f('end', 'Ends', 'datetime')
  ], 'Filtered by audience and effective time; not a clinical task.'),
  c('announcement.dismiss', 'Dismiss announcement for me', ['DJ03'], d, [], 'Does not dismiss any clinical task or hide the announcement for another person.', 'announcement', ['Published']),
  c('help.reply', 'Reply & update help request', ['AJ17'], it, [f('reply', 'Reply', 'textarea'), select('status', 'Status', ['In progress', 'Closed'])], 'Only support/account metadata is available to the admin.', 'help', ['Open', 'In progress']),
  c('article.publish', 'Publish how-to article', ['AJ17'], it, [f('title', 'Title'), f('content', 'Steps', 'textarea'), f('journey', 'Show me: journey ID')], 'A new article is marked New until the actor opens it.'),
  c('policy.save', 'Save security policy', ['AJ21'], ['superadmin'], [
    f('minPassword', 'Minimum password length', 'number', { min: 8, max: 64, default: 10 }),
    f('history', 'Password history', 'number', { min: 5, max: 20, default: 5 }),
    f('temporaryHours', 'Temporary password hours', 'number', { min: 1, max: 24, default: 24 }),
    f('attempts', 'Failed attempts before lock', 'number', { min: 3, max: 5, default: 5 }),
    f('doctorIdle', 'Doctor idle lock minutes', 'number', { min: 1, max: 5, default: 5 }),
    f('portalIdle', 'Portal idle sign-out minutes', 'number', { min: 1, max: 15, default: 15 })
  ], 'Administrative second check cannot be disabled. Policy values are proposed demo settings.'),
  c('staff.create', 'Create admin or staff account', ['AJ22'], ['superadmin'], [
    f('name', 'Full synthetic name'), f('staffId', 'Staff ID'), f('login', 'Login ID'), f('mobile', 'Synthetic mobile'),
    department, select('role', 'Role', ['admin', 'head', 'it', 'auditor', ...staffRoles]),
    yes('verifier', 'Lab verifier rights', false)
  ], 'Staff identity management here is an explicit SO02 demo assumption.'),
  c('account.role', 'Request role change', ['AJ22'], ['superadmin'], [
    select('role', 'New role', ['superadmin', 'admin', 'head', 'it', 'auditor', ...staffRoles]), department, reason,
    yes('confirmed', 'I reviewed the access impact')
  ], 'Own-role changes are refused; elevation waits for a second super admin.', 'account'),
  c('role.approve', 'Approve super-admin elevation', ['AJ22'], ['superadmin'], [reason], 'The requester cannot approve. Writes only the approved target role.', 'roleApproval', ['Pending']),
  c('account.remove', 'Remove administrative / staff access', ['AJ22'], ['superadmin'], [reason, f('confirmName', 'Type account name'), yes('confirmed', 'Confirm removal')], 'Cannot remove self or the last active super admin.', 'account'),

  c('counter.choose', 'Choose my counter', ['SJ01'], staffRoles, [select('counter', 'Counter', ['OPD 1', 'OPD 2', 'Pharmacy', 'IPD', 'Laboratory', 'Services']), f('printer', 'Printer', 'text', { default: 'Sample PDF printer' })], 'Counter name is captured in receipts, rather than read from a later preference.'),
  c('patient.register', 'Register patient', ['SJ02'], desk, [
    f('name', 'Synthetic patient name'), f('age', 'Age (years)', 'number', { min: 0, max: 120 }),
    select('sex', 'Sex', ['Female', 'Male', 'Other']), f('mobile', 'Synthetic mobile'),
    f('address', 'Synthetic address / district'), select('category', 'Category', ['General', 'Staff', 'Senior citizen', 'VIP']),
    opt('bloodGroup', 'Blood group'), opt('aadhaarLast4', 'Aadhaar last 4 digits ONLY', 'text', { help: 'Never type a full Aadhaar number.' }),
    select('payer', 'Payer', ['Self', 'Ayushman', 'CGHS', 'TPA', 'Corporate']),
    yes('unknown', 'Unknown patient', false), yes('mlc', 'Medico-legal case', false),
    opt('policeStation', 'MLC police station'), opt('broughtBy', 'Brought by'), opt('duplicateReason', 'Reason to register despite a possible duplicate')
  ], 'Search first. Possible duplicate name/mobile/age matches block creation until reviewed with a reason.'),
  c('patient.merge', 'Merge an unknown record', ['SJ02'], ['manager'], [entity('intoId', 'Verified patient record', 'patient'), reason, yes('confirmed', 'I verified both identities')], 'Moves linked work by stable ID and preserves the alias record.', 'patient', ['Active']),
  c('patient.mlc', 'Correct MLC flag', ['SJ02'], ['manager'], [yes('mlc', 'MLC applies', false), reason], 'Only operations may remove an MLC flag; history stays.', 'patient'),
  c('visit.book', 'Book appointment', ['SJ03', 'SJ35'], [...desk, 'patient'], [patient, doctor, date, f('time', 'Free slot time', 'time'),
    select('mode', 'Mode', ['Walk-in', 'Video', 'Telephone']), select('opdType', 'OPD type', ['General', 'Private']),
    select('visitType', 'Visit type', ['New', 'Follow-up']), opt('extraReason', 'Extra booking reason (desk only)')
  ], 'Online bookings close one hour before the slot; up to three desk extras require a reason.'),
  c('availability.decide', 'Decide availability request', ['SJ03'], desk, [
    select('decision', 'Decision', ['Approve', 'Decline']), reason
  ], 'Approval marks affected visits Needs move; none silently disappear.', 'availability', ['Requested']),
  c('followup.book', 'Book follow-up request', ['SJ03'], desk, [doctor, date, f('time', 'Time', 'time')], 'Creates the booking atomically and updates the originating doctor’s request.', 'followup', ['Requested']),
  c('followup.decline', 'Decline follow-up booking', ['SJ03'], desk, [reason], 'Preserves the recommendation and patient note.', 'followup', ['Requested']),
  c('visit.checkin', 'Check patient in', ['SJ04'], desk, [
    select('clearance', 'Consultation fee', ['Collect at billing', 'Covered', 'Free follow-up']), opt('priorityReason', 'Priority reason'),
    yes('priority', 'Priority arrival', false)
  ], 'Issues one per-doctor/day token. Free follow-up must be within seven days of a completed visit.', 'visit', ['Booked']),
  c('board.save', 'Configure waiting-room screen', ['SJ05'], desk, [f('name', 'Screen name'),
    opt('doctorId', 'Doctor (blank for all)', 'entity', { source: 'doctor' }), select('view', 'View', ['OPD status', 'Room', 'Current OPDs']), yes('enabled', 'Board active', false)
  ], 'The board is tester-gated but requires no clinical persona. It receives tokens, rooms and doctor names only.'),
  c('board.toggle', 'Switch board on/off', ['SJ05'], desk, [yes('enabled', 'Active', false)], 'Disabling takes effect on the next board refresh.', 'board'),
  c('document.upload', 'Upload synthetic patient document', ['SJ06', 'SJ36', 'DJ07'], [...d, 'desk', 'cashier', 'nurse', 'mrd', 'manager', 'patient'], [
    patient, select('kind', 'File type', ['Old report', 'Referral letter', 'Photo', 'ID proof (not Aadhaar)', 'Scheme card', 'Consent', 'Other']),
    f('file', 'Sample PDF, PNG or JPEG (up to 10 MB)', 'file'), yes('synthetic', 'This contains synthetic data only and is not an Aadhaar image')
  ], 'Files are stored privately and served through authorized endpoints. ID proofs and scheme cards are desk-only.'),
  c('document.void', 'Mark filed by mistake', ['SJ06'], ['desk', 'cashier', 'nurse', 'mrd', 'manager'], [reason], 'Keeps the file history but hides it from clinical/patient views.', 'document', ['Available']),
  c('bill.service', 'Add a tariff service', ['SJ07'], ['desk', 'cashier', 'manager'], [patient, entity('tariffId', 'Service', 'tariff'), f('quantity', 'Quantity', 'number', { min: 1, max: 100, default: 1 }), yes('emergency', 'Emergency extra', false)], 'The server selects the effective payer rate; a caller cannot type a price.'),
  c('bill.discount', 'Request discount', ['SJ07'], cash, [f('percent', 'Discount (%)', 'number', { min: 0.01, max: 100 }), reason], 'Above the role limit, payment and printing wait for an independent approval.', 'bill', ['Unpaid']),
  c('bill.pay', 'Receive payment (simulated)', ['SJ07', 'SJ37'], ['desk', 'cashier', 'pharmacist', 'manager', 'patient'], [
    f('payments', 'Payment split', 'payments'), select('outcome', 'Provider outcome', ['Success', 'Failure'])
  ], 'No real money. Failure records an attempt without marking the bill paid; successful total must match due.', 'bill', ['Unpaid', 'Part paid']),
  c('claim.create', 'Check eligibility / draft claim', ['SJ08'], cash, [patient, admission,
    select('payer', 'Payer', ['Ayushman', 'CGHS', 'TPA', 'Corporate']), f('policy', 'Synthetic policy / beneficiary ID'), amount,
    f('cover', 'Available cover (INR)', 'number', { min: 0 }), f('packageId', 'Package / plan reference')
  ], 'Simulated eligibility; no scheme portal contact.'),
  c('claim.send', 'Send claim / pre-authorisation', ['SJ08'], cash, [f('documents', 'Attached document references / query reply', 'textarea')], 'Records each submission and query response.', 'claim', ['Draft', 'Query raised']),
  c('claim.question', 'Ask consultant about insurer query', ['SJ08'], cash, [f('question', 'Question to the consultant', 'textarea')], 'Creates a clinical clarification on the consultant’s bell, not a generic inbox.', 'claim', ['Query raised']),
  c('claim.response', 'Simulate insurer response', ['SJ08'], cash, [
    select('decision', 'Response', ['Query raised', 'Approved', 'Rejected']), f('response', 'Insurer reply', 'textarea'),
    opt('approvedAmount', 'Approved amount (INR)', 'number', { min: 0 }), opt('validUntil', 'Approval valid until', 'date')
  ], 'A labelled external response, not real approval.', 'claim', ['Sent']),
  c('claim.settle', 'Record settlement', ['SJ08'], cash, [
    f('settled', 'Settled amount (INR)', 'number', { min: 0 }), select('deductionOwner', 'Deduction owner', ['Patient', 'Hospital']), reason
  ], 'A deduction creates an approval request; settlement is not final until approved.', 'claim', ['Approved', 'Claim sent']),
  c('claim.final', 'Submit discharge claim', ['SJ08'], cash, [], 'Requires actual discharge and approved summary plus final bill.', 'claim', ['Approved']),
  c('refund.request', 'Request refund / credit', ['SJ09'], [...cash, 'pharmacist'], [
    entity('billId', 'Paid bill', 'bill', { states: ['Paid'] }), f('lineId', 'Bill line ID'), amount, reason
  ], 'Cannot exceed the line’s discounted paid amount less earlier refunds. Refunds use the original mode.'),
  c('counter.close', 'Reconcile & close counter', ['SJ09'], ['cashier', 'desk', 'pharmacist', 'manager'], [
    f('countedCash', 'Counted cash (INR)', 'number', { min: 0 }), f('denominations', 'Note-count breakdown', 'textarea'), opt('reason', 'Difference reason')
  ], 'A difference above INR 100 needs independent approval. Closed counters cannot collect again that day.'),
  c('pharmacy.receive', 'Acknowledge prescription', ['SJ10'], ['pharmacist'], [], 'Acknowledged means received, not dispensed.', 'rx', ['Sent']),
  c('pharmacy.question', 'Ask about substitution', ['SJ10'], ['pharmacist'], [
    f('lineId', 'Prescription line ID'), entity('proposedItemId', 'Same-salt / strength alternative', 'item'), reason
  ], 'Creates a question against the current prescription version. No substitution occurs yet.', 'rx', ['Sent', 'Received', 'Part dispensed']),
  c('pharmacy.dispense', 'Dispense prescription line', ['SJ10'], ['pharmacist'], [
    f('lineId', 'Prescription line ID'), entity('batchId', 'Batch', 'batch'), f('quantity', 'Quantity', 'number', { min: 1, max: 10000 }),
    yes('nearExpiry', 'I checked any near-expiry warning', false)
  ], 'Only unexpired matching stock can be issued; creates batch/GST charges and per-line fulfillment.', 'rx', ['Sent', 'Received', 'Part dispensed']),
  c('pharmacy.return', 'Return dispensed medicine', ['SJ11'], ['pharmacist'], [
    f('quantity', 'Return quantity', 'number', { min: 1, max: 10000 }), select('condition', 'Condition', ['Unopened', 'Damaged']), reason
  ], 'Enforces seven-day window, issued quantity and no cold-chain resale. Credit/stock changes are atomic.', 'dispense', ['Issued']),
  c('ward.request', 'Request ward medicine', ['SJ18'], ['nurse'], [
    admission, entity('orderId', 'Signed medicine order', 'wardOrder', { states: ['Active'] }), f('quantity', 'Quantity', 'number', { min: 1, max: 1000 })
  ], 'Requires an active admission and a signed order.'),
  c('ward.issue', 'Issue medicines to ward', ['SJ11'], ['pharmacist'], [
    entity('batchId', 'Batch', 'batch'), f('quantity', 'Quantity', 'number', { min: 1, max: 1000 })
  ], 'Charges the active IPD bill with no counter payment.', 'wardRequest', ['Requested', 'Part issued']),
  c('requisition.create', 'Raise stock requisition', ['SJ12', 'SJ13'], ['pharmacist', 'store', 'manager'], [
    entity('itemId', 'Item', 'item'), f('quantity', 'Quantity', 'number', { min: 1, max: 100000 }), reason
  ], 'Uses item identity; later transfers are accepted by the receiving pharmacy.'),
  c('purchase.create', 'Create purchase order', ['SJ12'], ['store', 'manager'], [
    entity('requisitionId', 'Requisition', 'requisition'), entity('vendorId', 'Vendor', 'vendor'), f('quantity', 'Quantity', 'number', { min: 1, max: 100000 }),
    f('unitCost', 'Agreed unit cost (INR)', 'number', { min: 0.01 }), reason
  ], 'Blocked vendors are refused; orders above INR 50,000 wait for another manager.'),
  c('purchase.send', 'Send PO to vendor (simulated)', ['SJ12'], ['store', 'manager'], [], 'Only an approved PO can be sent.', 'purchase', ['Approved']),
  c('grn.receive', 'Receive goods', ['SJ12'], ['store'], [
    f('invoice', 'Vendor invoice'), f('quantity', 'Received good quantity', 'number', { min: 1, max: 100000 }),
    f('damaged', 'Damaged / short quantity', 'number', { min: 0, default: 0 }), f('batch', 'Batch number'), f('expiry', 'Expiry', 'date'),
    f('mrp', 'MRP (INR)', 'number', { min: 0.01 }), yes('shortExpiry', 'Accept less than six months to expiry', false), opt('reason', 'Short-expiry reason')
  ], 'Cannot exceed remaining PO quantity. MRP mismatch creates a Held GRN without adding stock.', 'purchase', ['Sent', 'Part received']),
  c('stock.issue', 'Issue stock to pharmacy', ['SJ12'], ['store'], [
    entity('requisitionId', 'Requisition', 'requisition'), entity('batchId', 'Central-store batch', 'batch'), f('quantity', 'Quantity', 'number', { min: 1, max: 100000 })
  ], 'Central stock is reserved/removed; pharmacy stock rises only on acceptance.'),
  c('stock.accept', 'Accept store transfer', ['SJ12'], ['pharmacist'], [], 'Adds exactly the transferred quantity once to the receiving store.', 'stockTransfer', ['In transit']),
  c('stock.writeoff', 'Request stock write-off', ['SJ13'], ['store', 'manager'], [
    entity('batchId', 'Batch', 'batch'), f('quantity', 'Quantity', 'number', { min: 1, max: 100000 }), reason
  ], 'Expired stock is excluded from dispensing even before independent write-off approval.'),
  c('stock.reconcile', 'Reconcile counted stock', ['SJ13'], ['store'], [f('counted', 'Physically counted quantity', 'number', { min: 0 }), reason], 'Differences valued over INR 1,000 wait for an independent approval; original movement history remains.', 'batch'),
  c('vendor.save', 'Add vendor', ['SJ13', 'SJ32'], ['store', 'manager'], [
    f('name', 'Synthetic vendor'), f('gstin', 'Synthetic GSTIN'), f('licence', 'Drug licence'), f('contact', 'Contact'), f('terms', 'Payment / rate terms')
  ], 'Vendor identity is shared with purchasing.'),
  c('vendor.block', 'Block vendor', ['SJ13'], ['store', 'manager'], [reason], 'Existing POs stay in history; new orders are prohibited.', 'vendor', ['Active']),
  c('asset.save', 'Register asset', ['SJ13'], ['store', 'manager'], [
    f('name', 'Equipment'), f('number', 'Asset number'), f('location', 'Location'), f('warranty', 'Warranty end', 'date'), f('serviceDue', 'AMC / service due', 'date')
  ], 'Due assets appear in attention lists.'),
  c('asset.service', 'Record asset service', ['SJ13'], ['store', 'services'], [
    select('status', 'Status', ['Under maintenance', 'Available']), f('note', 'Service note', 'textarea'), f('serviceDue', 'Next service due', 'date')
  ], 'Unavailable equipment cannot be assigned to OT.', 'asset'),
  c('sample.collect', 'Collect / recollect sample', ['SJ14'], ['lab'], [
    f('container', 'Container'), f('fasting', 'Fasting / preparation checked'), yes('confirmed', 'Patient and test confirmed')
  ], 'Payment/coverage clearance is checked server-side; one unique barcode per container.', 'order', ['Cleared', 'Recollection needed']),
  c('sample.defer', 'Record collection not possible', ['SJ14'], ['lab'], [reason], 'Keeps a collection hold visible to the ordering doctor.', 'order', ['Cleared', 'Recollection needed']),
  c('sample.resume', 'Resume held collection', ['SJ14'], ['lab'], [reason], 'Returns a cleared held order to the collection queue.', 'order', ['Collection held']),
  c('sample.accept', 'Accept sample', ['SJ14'], ['lab'], [f('barcode', 'Scan / enter sample barcode')], 'The scanned barcode must match this sample.', 'sample', ['Collected']),
  c('sample.reject', 'Reject sample', ['SJ14'], ['lab'], [reason], 'Preserves sample history and creates a recollection state visible to the doctor.', 'sample', ['Collected']),
  c('sample.dispatch', 'Dispatch to outside lab', ['SJ14'], ['lab'], [f('lab', 'Outside lab (synthetic)'), f('courier', 'Courier')], 'Records a dispatch manifest and timestamps.', 'sample', ['Accepted']),
  c('lab.question', 'Ask ordering doctor', ['SJ14'], ['lab'], [f('question', 'Question', 'textarea')], 'Only the ordering/covering doctor can answer.', 'order'),
  c('result.enter', 'Enter result', ['SJ15'], ['lab'], [
    opt('value', 'Value (required for laboratory tests)', 'number'), opt('unit', 'Unit'), opt('low', 'Reference low', 'number'), opt('high', 'Reference high', 'number'),
    opt('narrative', 'Radiology / interpretation text', 'textarea')
  ], 'Entry is not release. A separate verifier is mandatory. Potassium above 6.5 is Critical.', 'sample', ['Accepted', 'Dispatched']),
  c('result.verify', 'Verify result', ['SJ15'], ['lab'], [yes('confirmed', 'I checked the sample, value, units and range')], 'Requires verifier rights and a different person from the entry author.', 'result', ['Entered']),
  c('result.release', 'Release verified report', ['SJ15'], ['lab'], [], 'Creates doctor review obligations and patient-visible report; critical alerts remain until reviewed.', 'result', ['Verified']),
  c('result.amend', 'Create amended result', ['SJ15'], ['lab'], [
    f('value', 'Corrected value', 'number'), opt('narrative', 'Corrected narrative', 'textarea'), reason
  ], 'Preserves old release/review and requires a fresh independent verification.', 'result', ['Released']),
  c('result.call', 'Record critical-result call', ['SJ15'], ['lab'], [f('contact', 'Doctor / ward contacted'), f('note', 'Call outcome', 'textarea')], 'Does not impersonate a doctor review.', 'result', ['Released']),
  c('admission.emergency', 'Register emergency admission', ['SJ16'], ['desk', 'nurse', 'manager'], [
    patient, doctor, select('category', 'Ward category', ['General', 'Private', 'ICU']), f('diagnosis', 'Doctor / emergency request'),
    f('relative', 'Synthetic relative'), f('relativeMobile', 'Synthetic relative mobile')
  ], 'Emergency does not wait for payment; advance due remains visible.'),
  c('bed.reserve', 'Reserve a clean bed', ['SJ16'], ['desk', 'nurse', 'manager'], [patient], 'Two-hour reservation; expired reservations are released by scheduled checks.', 'bed', ['Free']),
  c('admission.admit', 'Allot bed & admit', ['SJ16'], ['desk', 'nurse', 'manager'], [
    entity('bedId', 'Clean available bed', 'bed'), f('relative', 'Relative / contact'), f('advance', 'Advance already received (INR)', 'number', { min: 0, default: 0 })
  ], 'Only matching free/own-reserved beds. Advance requires a recorded payment, not a typed claim.', 'admission', ['Requested']),
  c('admission.advance', 'Request admission advance', ['SJ07', 'SJ16'], cash, [amount], 'Creates a separate deposit bill. Actual payment is recorded through billing and adjusted on the final bill.', 'admission', ['Requested', 'Admitted']),
  c('bed.transfer', 'Transfer patient', ['SJ17'], ['nurse'], [
    entity('bedId', 'New bed', 'bed', { states: ['Free'] }), reason
  ], 'ICU transfer requires a signed order; previous bed moves to Cleaning and rate intervals are retained.', 'admission', ['Admitted']),
  c('bed.clean', 'Mark cleaning complete', ['SJ17'], ['services'], [f('note', 'Cleaning checklist / note')], 'Frees the bed for a later admission.', 'bed', ['Cleaning']),
  c('nursing.note', 'Save nursing handover', ['SJ18'], ['nurse'], [admission, f('note', 'Notes and handover', 'textarea')], 'Visible to the treating doctor with nurse attribution.'),
  c('dose.record', 'Record medicine administration', ['SJ18'], ['nurse'], [
    f('scheduled', 'Scheduled dose time', 'datetime'), select('outcome', 'Outcome', ['Given', 'Held', 'Not given']),
    opt('reason', 'Reason (required for late / not given)')
  ], 'Only signed active medicine orders; a scheduled dose cannot be recorded twice.', 'wardOrder', ['Active']),
  c('discharge.clear', 'Complete nursing clearance', ['SJ19'], ['nurse'], [
    yes('returns', 'Unused medicines returned'), yes('results', 'Pending results have an owner'),
    yes('medicines', 'Discharge medicines supplied'), yes('insurance', 'Insurance ready or not applicable'), f('note', 'Handover note')
  ], 'Nursing clearance is separate from consultant approval and bill settlement.', 'discharge', ['Approved']),
  c('discharge.bill', 'Prepare final bill', ['SJ19'], cash, [], 'Requires approved discharge; adds unbilled bed intervals and adjusts recorded advances.', 'discharge', ['Approved', 'Nursing cleared']),
  c('discharge.credit', 'Request discharge credit', ['SJ19'], cash, [reason], 'Only independent approval can waive the payment gate.', 'admission', ['Admitted']),
  c('discharge.release', 'Issue gate pass & release bed', ['SJ19'], ['nurse', 'cashier', 'manager'], [yes('confirmed', 'Identity, summary, clearance and final bill checked')], 'Requires approved summary, nursing clearance, final bill and payment/approved credit.', 'admission', ['Admitted']),
  c('operation.schedule', 'Offer theatre slot', ['SJ20'], ['ot'], [
    select('theatre', 'Theatre', ['OT 1', 'OT 2']), f('start', 'Start', 'datetime'),
    f('anaesthetist', 'Anaesthetist'), f('scrubNurse', 'Scrub nurse'), opt('assetId', 'Equipment', 'entity', { source: 'asset' }), opt('implants', 'Implants')
  ], 'Checks interval overlap for theatre and surgeon, plus equipment availability.', 'operation', ['Requested', 'Reschedule requested']),
  c('operation.checklist', 'Complete pre-operation checklist', ['SJ20'], ['ot', 'nurse'], [
    entity('consentId', 'Signed consent', 'consent', { states: ['Signed'] }), yes('fasting', 'Fasting checked'), yes('blood', 'Blood arranged / not required'),
    yes('fitness', 'Anaesthetist fitness complete'), yes('authorisation', 'Insurance approved / not applicable')
  ], 'Patient identity on consent must match the operation.', 'operation', ['Scheduled']),
  c('operation.advance', 'Advance theatre stage', ['SJ20'], ['ot'], [
    select('next', 'Next stage', ['In theatre', 'Recovery', 'Shifted to ward'])
  ], 'Pre-op checks gate entry. Procedure charges are applied once.', 'operation', ['Scheduled', 'In theatre', 'Recovery']),
  c('daycare.start', 'Start day-care session', ['SJ21'], ['nurse'], [
    patient, doctor, entity('bedId', 'Day-care bed', 'bed', { states: ['Free'] }), entity('packageId', 'Package', 'package')
  ], 'Keeps an active clinical encounter for nursing charts.'),
  c('daycare.finish', 'Finish / convert day care', ['SJ21'], ['nurse'], [
    select('decision', 'Outcome', ['Finish', 'Convert to IPD']), opt('bedId', 'IPD bed for conversion', 'entity', { source: 'bed' }), reason
  ], 'Conversion retains charts and charges under the same patient; package billing happens once.', 'daycare', ['Active']),
  c('register.record', 'Record vaccine / infection', ['SJ22'], ['nurse'], [
    patient, select('kind', 'Register', ['Immunisation', 'Infection']), f('detail', 'Vaccine or infection details'),
    opt('batch', 'Vaccine batch'), opt('expiry', 'Vaccine expiry', 'date'), opt('nextDue', 'Next vaccine due', 'date'), f('action', 'Action / culture result', 'textarea')
  ], 'A vaccine needs a valid batch and next due date.'),
  c('consent.sign', 'File signed consent', ['SJ22'], ['desk', 'nurse'], [
    patient, select('kind', 'Consent', ['Surgery', 'Anaesthesia', 'Blood', 'High risk', 'Against medical advice']),
    select('language', 'Language', ['English', 'Hindi']), f('signer', 'Synthetic patient / relative signature name'),
    f('witness', 'Witness'), f('signedAt', 'Signed at', 'datetime'), yes('signed', 'Synthetic signed form checked')
  ], 'No real signing. Consent is a persisted simulated evidence record with witness and time.'),
  c('certificate.print', 'Print issued certificate', ['SJ22'], ['desk', 'nurse'], [], 'Cannot create or alter certificate text; only a doctor-issued serial is printable.', 'certificate', ['Issued']),
  c('package.sell', 'Sell health package', ['SJ23'], ['desk', 'cashier'], [patient, doctor, entity('packageId', 'Package', 'package')], 'Bills the package once and creates its linked orders.'),
  c('package.skip', 'Skip package item with reason', ['SJ23'], ['desk'], [
    f('orderId', 'Package order ID'), reason
  ], 'Skipped items remain in the pack checklist.', 'packageRun', ['In progress']),
  c('package.release', 'Release complete report pack', ['SJ23'], ['desk'], [
    f('summary', 'Consultant summary reference'), yes('reviewed', 'Consultant reviewed the completed pack')
  ], 'Every item must be released or explicitly skipped.', 'packageRun', ['In progress']),
  c('trip.request', 'Request transport', ['SJ24'], ['desk', 'nurse', 'services'], [
    patient, select('kind', 'Vehicle type', ['Basic ambulance', 'Advanced ambulance', 'Car']),
    f('from', 'From'), f('to', 'To'), f('time', 'Pickup time', 'datetime'), yes('emergency', 'Emergency', false)
  ], 'No real dispatch; only synthetic notifications.'),
  c('trip.assign', 'Assign vehicle & driver', ['SJ24'], ['services'], [
    entity('vehicleId', 'Available vehicle', 'vehicle'), f('driver', 'Synthetic driver')
  ], 'Blocks already assigned, wrong-type or service-overdue vehicles.', 'trip', ['Requested']),
  c('trip.advance', 'Update trip', ['SJ24'], ['services'], [
    select('next', 'Trip status', ['On the way', 'Arrived', 'Completed']), opt('km', 'Kilometres (at completion)', 'number', { min: 0 }), opt('fuel', 'Fuel used (litres)', 'number', { min: 0 })
  ], 'Completion charges the effective per-km tariff and frees the vehicle once.', 'trip', ['Booked', 'On the way', 'Arrived']),
  c('diet.order', 'Create meal order', ['SJ25'], ['nurse'], [
    admission, entity('orderId', 'Signed doctor diet order', 'wardOrder', { states: ['Active'] }),
    select('meal', 'Meal', ['Breakfast', 'Lunch', 'Dinner']), f('mealAt', 'Meal time', 'datetime'), opt('allergies', 'Food allergies')
  ], 'Orders within two hours roll to the next meal; nil-by-mouth creates no deliverable tray.'),
  c('diet.deliver', 'Deliver tray', ['SJ25'], ['services'], [yes('checked', 'Bed, diet and food allergies checked')], 'Rechecks active diet, nil-by-mouth and admission immediately before delivery.', 'diet', ['Ordered']),
  c('mortuary.receive', 'Receive synthetic mortuary record', ['SJ26'], ['services'], [
    f('name', 'Synthetic identity'), f('deathRecord', 'Death record number'), entity('cabinetId', 'Free cabinet', 'cabinet'), yes('mlc', 'MLC', false)
  ], 'Names stay in the restricted mortuary register.'),
  c('mortuary.release', 'Release from mortuary', ['SJ26'], ['services'], [
    f('certificate', 'Death certificate reference'), yes('police', 'Police clearance entered (MLC)', false),
    f('receiverLast4', 'Receiver ID last 4 digits'), yes('settled', 'Bill settled or waived'),
    entity('secondStaffId', 'Second support staff member', 'staff'), yes('confirmed', 'Both staff checked identity')
  ], 'Requires a second distinct support actor, MLC clearance and a certificate; frees cabinet.', 'mortuary', ['Received']),
  c('facility.raise', 'Raise facility request', ['SJ27'], staffRoles, [
    select('category', 'Category', ['Electrical', 'Plumbing', 'Biomedical', 'Housekeeping', 'IT']), f('location', 'Location'),
    select('urgency', 'Urgency', ['Routine', 'Urgent']), f('description', 'Problem', 'textarea'), opt('assetId', 'Asset', 'entity', { source: 'asset' })
  ], 'Urgent patient-area work has a demo one-hour target.'),
  c('facility.assign', 'Assign service team', ['SJ27'], ['services'], [f('team', 'Assigned team')], 'Requester can see the actual assignment.', 'facility', ['Open', 'Reopened']),
  c('facility.close', 'Close facility request', ['SJ27'], ['services'], [f('note', 'Work done', 'textarea')], 'A closing note is mandatory.', 'facility', ['In progress']),
  c('facility.reopen', 'Reopen facility request', ['SJ27'], staffRoles, [reason], 'Only requester within 24 hours of closure.', 'facility', ['Closed']),
  c('coding.finish', 'Code & file record', ['SJ28'], ['mrd'], [
    f('icd', 'Main ICD-10 code'), opt('otherCodes', 'Other diagnosis / procedure codes'), yes('complete', 'Notes, summary and required consents complete', false),
    f('detail', 'Shelf location or missing-document list'), reason
  ], 'Doctor text is retained. A coded MLC file cannot be edited.', 'coding', ['Requested', 'Incomplete']),
  c('coding.question', 'Ask doctor about coding', ['SJ28'], ['mrd'], [f('question', 'Coding question', 'textarea')], 'Routes to the clinical author without changing their words.', 'coding', ['Requested', 'Incomplete']),
  c('hospitalDocument.publish', 'Publish hospital document', ['SJ29'], ['mrd', 'manager'], [
    f('title', 'Document name'), select('kind', 'Type', ['Policy', 'SOP', 'Licence', 'Certificate', 'Agreement']),
    f('content', 'Synthetic document content', 'textarea'), f('expiry', 'Expiry date', 'date')
  ], 'Owner or operations only; publishing retains immutable prior versions.'),
  c('enquiry.save', 'Record enquiry', ['SJ31'], ['desk'], [
    f('question', 'Question'), f('answer', 'Answer given', 'textarea'), opt('callback', 'Callback time', 'datetime')
  ], 'A real persisted service record, not a sent message.'),
  c('feedback.save', 'Record patient feedback', ['SJ31'], ['desk', 'manager', 'patient'], [
    patient, department, f('rating', 'Rating (1-5)', 'number', { min: 1, max: 5 }), f('comment', 'Feedback', 'textarea'),
    yes('complaint', 'Complaint needs action', false)
  ], 'Complaints retain a seven-day due date and route to the department.'),
  c('feedback.close', 'Close complaint', ['SJ31'], ['manager'], [f('action', 'Action taken', 'textarea')], 'Keeps the original feedback and response.', 'feedback', ['Open']),
  c('message.retry', 'Retry failed message', ['SJ31', 'DJ16'], ['desk', 'manager', ...d], [], 'Adds a new attempt to the same simulated message; never claims a real send.', 'message', ['Failed']),
  c('tariff.propose', 'Propose future tariff', ['SJ32'], ['manager'], [
    entity('tariffId', 'Service', 'tariff'), select('payer', 'Payer', ['Self', 'Ayushman', 'CGHS', 'TPA', 'Corporate']),
    f('rate', 'New rate (INR)', 'number', { min: 0 }), f('effective', 'Effective date', 'date'), reason
  ], 'Independent approval and a future date are mandatory; existing bill snapshots never change.'),
  c('item.create', 'Add catalog item', ['SJ32'], ['manager'], [
    f('name', 'Synthetic medicine / consumable'), f('salt', 'Salt'), f('strength', 'Strength'), f('form', 'Form'),
    f('hsn', 'HSN'), f('gst', 'GST (%)', 'number', { min: 0, max: 28 }), f('mrp', 'MRP (INR)', 'number', { min: 0.01 }),
    f('reorder', 'Reorder level', 'number', { min: 0 }), select('schedule', 'Schedule', ['Normal', 'H1']), yes('coldChain', 'Cold-chain item', false)
  ], 'Creates a synthetic active catalog identity; no automatic prescription change.'),
  c('item.retire', 'Retire catalog item', ['SJ32'], ['manager'], [reason], 'Old prescriptions keep the snapshot; new orders and sets refuse this item.', 'item', ['Active']),
  c('item.price', 'Propose item MRP correction', ['SJ32'], ['manager'], [f('mrp', 'Corrected MRP (INR)', 'number', { min: 0.01 }), f('effective', 'Effective date', 'date'), reason], 'Independent approval and a future date are required. Held receipts can be retried after the approved correction takes effect.', 'item', ['Active']),
  c('payer.create', 'Add payer', ['SJ32'], ['manager'], [f('name', 'Payer'), f('terms', 'Credit terms'), f('packages', 'Scheme / package references')], 'No live eligibility exchange.'),
  c('bed.create', 'Add bed', ['SJ32'], ['manager'], [
    f('name', 'Bed number'), f('ward', 'Ward'), select('category', 'Category', ['General', 'Private', 'ICU', 'Day care']), f('dailyRate', 'Daily rate (INR)', 'number', { min: 0 })
  ], 'Creates a clean free bed in the shared bed board.'),
  c('package.create', 'Add health package', ['SJ32'], ['manager'], [
    f('name', 'Package name'), tests, f('price', 'Fixed price (INR)', 'number', { min: 0 })
  ], 'Bundle identity and price are snapshotted at sale.'),
  c('approval.decide', 'Decide approval request', ['SJ33'], ['manager'], [
    select('decision', 'Decision', ['Approve', 'Decline']), reason
  ], 'Requester cannot approve their own request. Applies the specified effect only once.', 'approval', ['Pending']),
  c('rules.save', 'Set demo approval limits', ['SJ33'], ['manager'], [
    f('discount', 'Cashier discount limit (%)', 'number', { min: 0, max: 10, default: 10 }),
    f('purchase', 'PO approval threshold (INR)', 'number', { min: 0, max: 50000, default: 50000 }),
    f('cashDifference', 'Cash difference threshold (INR)', 'number', { min: 0, max: 100, default: 100 })
  ], 'These thresholds are configurable demo assumptions, not hospital approval.'),
  c('job.run', 'Run scheduled job now', ['SJ33'], ['manager'], [
    select('outcome', 'Simulated outcome', ['Success', 'Failure'])
  ], 'Records run history and visible failure. Reminders respect patient opt-out.', 'job'),
  c('patient.updates', 'Save WhatsApp choices', ['SJ37'], ['patient'], [
    yes('appointments', 'Appointment reminders', false), yes('reports', 'Report-ready notices', false), yes('bills', 'Bill messages', false)
  ], 'Optional reminders stop at the provider boundary. Message bodies contain no diagnoses or result values.')
];
export const commandByName = Object.fromEntries(commands.map(command => [command.name, command]));
