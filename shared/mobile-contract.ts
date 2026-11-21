// Source of truth for the mobile API contract. `npm run contract` regenerates docs/mobile-api-v1.yaml.
export const mobileApiVersion = '1.0.0';
export const mobileBasePath = '/api/mobile/v1';
export const documentTypes = ['VISIT_SUMMARY', 'PRESCRIPTION', 'INVESTIGATIONS', 'ADVICE_REFERRAL', 'OTHER'] as const;
export const deliveryStates = ['AVAILABLE', 'VIEWED', 'DISPENSED', 'PARTIALLY_DISPENSED', 'NOT_DISPENSED', 'SAMPLE_COLLECTED', 'RESULT_READY', 'SUPERSEDED'] as const;
export const queueStatuses = ['BOOKED', 'WAITING', 'CALLED', 'IN_CONSULTATION', 'ON_HOLD', 'COMPLETED', 'MISSED', 'CANCELLED'] as const;
export const recipientKinds = ['PHARMACY', 'LAB', 'PATIENT'] as const;
export const doctorEventTypes = ['QUEUE_UPDATED', 'DOCUMENT_SIGNED', 'DOCUMENT_STATE_CHANGED', 'LAB_RESULT_READY'] as const;
export const patientEventTypes = ['VISIT_UPDATED', 'DOCUMENT_AVAILABLE', 'DOCUMENT_AMENDED', 'DOCUMENT_STATE_CHANGED', 'LAB_RESULT_READY'] as const;
export const blobLimits = { png: 10 * 1024 * 1024, pdf: 25 * 1024 * 1024, ink: 16 * 1024 * 1024, minSide: 200, maxSide: 8192 } as const;
export const bundleLimits = { documents: 20, pagesPerDocument: 60, pagesPerBundle: 150, hintsBytes: 32 * 1024 } as const;
export const otpLimits = { cooldownSeconds: 30, perMobileTenMinutes: 3, perMobileDay: 10, perIpTenMinutes: 20, wrongCodesBeforeLock: 3, lockMinutes: 30, ttlSeconds: 300 } as const;
export const tokenLifetimes = { doctorDays: 7, patientDays: 90 } as const;

type Schema = Record<string, unknown>;
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const str = (extra: Schema = {}): Schema => ({ type: 'string', ...extra });
const int = (extra: Schema = {}): Schema => ({ type: 'integer', ...extra });
const bool = (extra: Schema = {}): Schema => ({ type: 'boolean', ...extra });
const arr = (items: Schema, extra: Schema = {}): Schema => ({ type: 'array', items, ...extra });
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
const obj = (properties: Record<string, Schema>, required: string[] = Object.keys(properties), extra: Schema = {}): Schema => ({ type: 'object', properties, required, ...extra });
const closed = (properties: Record<string, Schema>, required: string[] = Object.keys(properties), extra: Schema = {}): Schema => obj(properties, required, { additionalProperties: false, ...extra });
const id = (description: string): Schema => str({ pattern: '^[A-Za-z0-9._:-]{1,120}$', description });
const uuid = (description: string): Schema => str({ format: 'uuid', description });

const schemas: Record<string, Schema> = {
  Error: obj({
    error: obj({
      code: str({ description: 'Stable machine-readable code. See docs/mobile-sync.md.' }),
      message: str({ description: 'Plain-language message suitable for display.' }),
      retryable: bool({ description: 'True when retrying the identical request later may succeed.' }),
      details: { type: 'object', description: 'Code-specific structured details, for example MISSING_BLOBS.details.missing.' },
      requestId: str({ description: 'Correlates with the X-Request-Id response header and server audit.' })
    }, ['code', 'message', 'retryable'])
  }),
  Sha256: str({ pattern: '^[0-9a-f]{64}$', description: 'Lowercase hexadecimal SHA-256 of the exact blob bytes.' }),
  Timestamp: str({ format: 'date-time', description: 'ISO-8601 instant in UTC, for example 2026-11-21T04:05:06.000Z.' }),
  LocalDate: str({ format: 'date', description: 'Hospital calendar date in Asia/Kolkata, YYYY-MM-DD.' }),
  Sex: str({ enum: ['Female', 'Male', 'Other'] }),
  DocumentType: str({ enum: [...documentTypes] }),
  DeliveryState: str({ enum: [...deliveryStates], description: 'Server delivery state. Clients may additionally show their own local PENDING state before upload.' }),
  QueueStatus: str({ enum: [...queueStatuses] }),
  RecipientKind: str({ enum: [...recipientKinds] }),
  Meta: obj({
    apiVersion: str({ description: 'Semantic version of this v1 contract. Minor and patch versions only add fields.' }),
    serverVersion: str(), synthetic: { const: true },
    minDoctorAppVersion: int({ minimum: 1, description: 'Minimum doctor-android versionCode.' }),
    minPatientAppVersion: int({ minimum: 1, description: 'Minimum patient-android versionCode.' }),
    serverTime: ref('Timestamp'), docsUrl: str()
  }),
  Persona: obj({
    personaId: id('Doctor persona ID. Identical to doctorId everywhere else.'), doctorId: id('Same value as personaId.'),
    name: str(), qualification: str(), registrationNo: str(), department: str(), departmentId: id('Department ID.')
  }),
  PersonaList: obj({ personas: arr(ref('Persona')) }),
  DoctorSessionRequest: closed({ personaId: id('A persona from GET /doctor/personas.'), deviceId: str({ pattern: '^[A-Za-z0-9._:-]{8,128}$' }), deviceName: str({ maxLength: 80 }) }, ['personaId', 'deviceId']),
  DoctorSession: obj({ token: str({ description: 'Opaque bearer token. Store securely; never log it.' }), tokenType: { const: 'Bearer' }, expiresAt: ref('Timestamp'), deviceId: str(), doctor: ref('Persona') }),
  PatientAccount: obj({ accountId: id('Patient-app account linked to the mobile number.'), mobileMasked: str({ description: 'For example ******0001.' }) }),
  SessionInfo: obj({ kind: str({ enum: ['DOCTOR', 'PATIENT'] }), deviceId: str(), expiresAt: ref('Timestamp'), doctor: ref('Persona'), account: ref('PatientAccount') }, ['kind', 'deviceId', 'expiresAt']),
  Lab: obj({ labId: id('Lab identifier used in routing.labs.'), name: str(), kind: str({ enum: ['PATHOLOGY', 'IMAGING', 'OTHER'] }) }),
  LabList: obj({ labs: arr(ref('Lab')) }),
  Allergy: obj({ substance: str(), reaction: str(), certainty: str() }),
  Vitals: obj({ bp: nullable(str({ description: 'Systolic/diastolic mmHg, for example 120/80.' })), pulse: nullable(int()), tempC: nullable({ type: 'number' }), spo2: nullable(int()), weightKg: nullable({ type: 'number' }), recordedAt: ref('Timestamp') }),
  PatientSummary: obj({ patientId: id('Patient ID; equals profileId in the patient app.'), uhid: str(), name: str(), age: int(), sex: ref('Sex'), mobileMasked: str() }),
  QueuePatient: obj({ patientId: id('Patient ID.'), uhid: str(), name: str(), age: int(), sex: ref('Sex'), mobileMasked: str(), allergies: arr(ref('Allergy')) }),
  QueueEntry: obj({
    queueEntryId: id('Queue entry ID. In this backend it is always equal to visitId.'), visitId: id('Visit ID.'),
    token: nullable(int({ description: 'Front-desk token; null until checked in.' })), status: ref('QueueStatus'), date: ref('LocalDate'),
    time: str({ description: 'Booked slot time HH:mm (IST).' }), mode: str({ description: 'Walk-in, Video or Telephone.' }), priority: bool(),
    checkedInAt: nullable(ref('Timestamp')), startedAt: nullable(ref('Timestamp')), completedAt: nullable(ref('Timestamp')),
    returning: bool({ description: 'True if the patient has an earlier completed visit or signed document at this hospital.' }),
    lastVisitAt: nullable(ref('Timestamp')), priorDocumentCount: int({ minimum: 0 }), patient: ref('QueuePatient'), vitals: nullable(ref('Vitals')),
    demoWalkIn: bool({ description: 'Created by the demo-only walk-in shortcut instead of the front desk.' })
  }),
  Queue: obj({ date: ref('LocalDate'), doctorId: id('Doctor ID.'), entries: arr(ref('QueueEntry')), serverTime: ref('Timestamp') }),
  StartVisitRequest: closed({ identityConfirmed: { const: true, description: 'The doctor confirmed name, UHID and allergy status with the patient.' } }),
  StartVisitResponse: obj({ queueEntryId: id('Queue entry ID.'), visitId: id('Visit ID.'), status: ref('QueueStatus'), startedAt: ref('Timestamp') }),
  WalkInRequest: closed({
    patientId: id('Existing patient to add to today\'s queue.'), name: str({ minLength: 1, maxLength: 80 }), age: int({ minimum: 0, maximum: 120 }), sex: ref('Sex'),
    mobile: str({ pattern: '^[0-9]{10}$', description: 'Synthetic 10-digit mobile. Needed for the patient app.' })
  }, [], { anyOf: [{ required: ['patientId'] }, { required: ['name', 'age', 'sex'] }] }),
  PageInput: closed({ index: int({ minimum: 0 }), pngSha256: ref('Sha256'), widthPx: int({ minimum: blobLimits.minSide, maximum: blobLimits.maxSide }), heightPx: int({ minimum: blobLimits.minSide, maximum: blobLimits.maxSide }) }),
  Routing: closed({
    pharmacy: bool({ description: 'Deliver to the hospital pharmacy. Allowed only for PRESCRIPTION.' }),
    labs: arr(id('Lab ID from GET /doctor/labs.'), { maxItems: 10, uniqueItems: true, description: 'Allowed only for INVESTIGATIONS.' }),
    patient: bool({ description: 'Show in the patient app.' })
  }),
  Hints: closed({
    medicines: arr(closed({ name: str({ minLength: 1, maxLength: 120 }), strength: str({ maxLength: 60 }), dose: str({ maxLength: 60 }), frequency: str({ maxLength: 60 }), durationDays: int({ minimum: 0, maximum: 3650 }), notes: str({ maxLength: 300 }) }, ['name']), { maxItems: 50 }),
    tests: arr(closed({ name: str({ minLength: 1, maxLength: 120 }), code: str({ maxLength: 40 }) }, ['name']), { maxItems: 50 }),
    diagnosis: str({ maxLength: 500 }), notes: str({ maxLength: 2000 })
  }, [], { description: 'Optional typed hints. The signed handwriting remains authoritative; recipients see hints as unverified.' }),
  DocumentInput: closed({
    clientDocId: uuid('Client-generated document ID, unique within the bundle.'), type: ref('DocumentType'), title: str({ minLength: 1, maxLength: 120 }),
    pages: arr(ref('PageInput'), { minItems: 1, maxItems: bundleLimits.pagesPerDocument, description: 'Pages with indexes 0..n-1 in order.' }),
    pdfSha256: ref('Sha256'), inkSha256: nullable(ref('Sha256')),
    inkFormat: nullable(str({ pattern: '^samford-ink(-placeholder)?/[0-9]+$', description: 'samford-ink/1 is defined by the doctor app repository.' })),
    routing: ref('Routing'), hints: ref('Hints'), signedAt: ref('Timestamp')
  }, ['clientDocId', 'type', 'title', 'pages', 'pdfSha256', 'inkSha256', 'inkFormat', 'routing', 'signedAt']),
  FollowUpInput: closed({ date: ref('LocalDate'), note: str({ maxLength: 500 }), requestBooking: bool({ description: 'Default true: ask the front desk to book the follow-up.' }) }, ['date']),
  CompleteVisitRequest: closed({
    bundleId: uuid('Client bundle UUID. Must equal the Idempotency-Key header.'), completedAt: ref('Timestamp'),
    documents: arr(ref('DocumentInput'), { minItems: 1, maxItems: bundleLimits.documents }), followUp: ref('FollowUpInput')
  }, ['bundleId', 'completedAt', 'documents']),
  CompletedDocument: obj({ clientDocId: uuid('Client document ID.'), documentId: id('Stable server document ID across versions.'), version: { const: 1 }, type: ref('DocumentType'), title: str(), recordHash: ref('Sha256') }),
  CompleteVisitResponse: obj({
    bundleId: uuid('Bundle UUID.'), visitId: id('Visit ID.'), visitStatus: { const: 'COMPLETED' }, receivedAt: ref('Timestamp'),
    recordHash: ref('Sha256'), documents: arr(ref('CompletedDocument')), followUpId: nullable(id('Front-desk follow-up request ID.'))
  }),
  AddendumRequest: closed({
    clientAddendumId: uuid('Must equal the Idempotency-Key header.'), baseVersion: int({ minimum: 1, description: 'The latest version the doctor reviewed.' }),
    reason: str({ minLength: 5, maxLength: 500 }), title: str({ minLength: 1, maxLength: 120 }),
    pages: arr(ref('PageInput'), { minItems: 1, maxItems: bundleLimits.pagesPerDocument, description: 'The complete page set of the new version. Unchanged pages reuse their existing hashes.' }),
    pdfSha256: ref('Sha256'), inkSha256: nullable(ref('Sha256')), inkFormat: nullable(str({ pattern: '^samford-ink(-placeholder)?/[0-9]+$' })),
    routing: ref('Routing'), hints: ref('Hints'), signedAt: ref('Timestamp')
  }, ['clientAddendumId', 'baseVersion', 'reason', 'pages', 'pdfSha256', 'inkSha256', 'inkFormat', 'signedAt']),
  AddendumResponse: obj({ documentId: id('Document ID.'), version: int({ minimum: 2 }), previousVersion: int({ minimum: 1 }), recordHash: ref('Sha256'), createdAt: ref('Timestamp') }),
  PageRef: obj({ index: int(), pngSha256: ref('Sha256'), widthPx: int(), heightPx: int(), url: str({ description: 'Short-lived signed absolute URL; no Authorization header needed.' }) }),
  DocumentVersion: obj({
    version: int({ minimum: 1 }), createdAt: ref('Timestamp'), signedAt: ref('Timestamp'), reason: nullable(str({ description: 'Addendum reason; null for version 1.' })),
    authorName: str(), title: str(), pages: arr(ref('PageRef')), pdfSha256: ref('Sha256'), pdfUrl: str(), inkSha256: nullable(ref('Sha256')), inkFormat: nullable(str()),
    inkUrl: nullable(str()), recordHash: ref('Sha256'), urlsExpireAt: ref('Timestamp')
  }),
  Recipient: obj({ kind: ref('RecipientKind'), labId: nullable(id('Lab ID for LAB recipients.')), name: str(), state: ref('DeliveryState'), version: int({ minimum: 1 }), updatedAt: ref('Timestamp'), note: nullable(str()) }),
  ClinicalDocument: obj({
    documentId: id('Stable document ID.'), visitId: id('Visit ID.'), patientId: id('Patient ID.'), type: ref('DocumentType'), title: str(),
    author: obj({ doctorId: id('Author doctor ID.'), name: str() }), latestVersion: int({ minimum: 1 }), routing: ref('Routing'), hints: nullable(ref('Hints')),
    versions: arr(ref('DocumentVersion'), { description: 'Oldest first. Every version is immutable.' }), recipients: arr(ref('Recipient'), { description: 'Recipients of the latest version.' })
  }),
  LabResult: obj({
    resultId: id('Result ID.'), documentId: nullable(id('Investigations document this answers.')), labId: nullable(id('Lab ID.')), testName: str(), value: str(), unit: nullable(str()),
    refRange: nullable(str()), flag: nullable(str({ enum: ['NORMAL', 'ABNORMAL', 'CRITICAL'] })), reportedAt: ref('Timestamp'), summary: nullable(str()),
    reportPdfSha256: nullable(ref('Sha256')), reportUrl: nullable(str())
  }),
  RecordVisit: obj({ visitId: id('Visit ID.'), date: ref('LocalDate'), doctorId: id('Doctor ID.'), doctorName: str(), department: str(), status: ref('QueueStatus'), completedAt: nullable(ref('Timestamp')), documents: arr(ref('ClinicalDocument')) }),
  PatientRecord: obj({ patient: ref('PatientSummary'), allergies: arr(ref('Allergy')), visits: arr(ref('RecordVisit'), { description: 'Newest first.' }), labResults: arr(ref('LabResult')), generatedAt: ref('Timestamp') }),
  VisitDelivery: obj({ visitId: id('Visit ID.'), documents: arr(obj({ documentId: id('Document ID.'), version: int(), type: ref('DocumentType'), title: str(), recipients: arr(ref('Recipient')) })) }),
  Event: obj({
    eventId: str({ pattern: '^[0-9]+$', description: 'Monotonic per server; compare numerically.' }), type: str({ description: 'Ignore unknown types.' }), at: ref('Timestamp'),
    message: str({ description: 'Display text. Patient-facing text contains no diagnosis or result values.' }), visitId: nullable(id('Visit ID.')), documentId: nullable(id('Document ID.')),
    patientId: nullable(id('Patient ID.')), data: { type: 'object' }
  }),
  EventPage: obj({ events: arr(ref('Event')), nextCursor: str({ description: 'Opaque. Send it unchanged as cursor.' }), hasMore: bool(), serverTime: ref('Timestamp') }),
  BlobReceipt: obj({ sha256: ref('Sha256'), size: int(), mediaType: str(), widthPx: nullable(int()), heightPx: nullable(int()), createdAt: ref('Timestamp'), created: bool({ description: 'False when the identical blob already existed.' }) }),
  OtpRequest: closed({ mobile: str({ pattern: '^[0-9]{10}$' }), deviceId: str({ pattern: '^[A-Za-z0-9._:-]{8,128}$' }) }),
  OtpChallenge: obj({
    challengeId: id('Challenge ID.'), expiresAt: ref('Timestamp'), resendAfterSeconds: int(),
    demoCode: str({ pattern: '^[0-9]{6}$', description: 'SYNTHETIC DEMO ONLY: no SMS provider exists, so the code is returned here.' }), demoNotice: str()
  }),
  OtpVerify: closed({ challengeId: id('Challenge ID.'), code: str({ pattern: '^[0-9]{6}$' }), deviceId: str({ pattern: '^[A-Za-z0-9._:-]{8,128}$' }), deviceName: str({ maxLength: 80 }) }, ['challengeId', 'code', 'deviceId']),
  Profile: obj({ profileId: id('Equals patientId.'), uhid: str(), name: str(), age: int(), sex: ref('Sex') }),
  ProfileList: obj({ profiles: arr(ref('Profile')) }),
  PatientSession: obj({ token: str(), tokenType: { const: 'Bearer' }, expiresAt: ref('Timestamp'), deviceId: str(), account: ref('PatientAccount'), profiles: arr(ref('Profile')) }),
  ViewedRequest: closed({ version: int({ minimum: 1 }) }),
  ViewedResponse: obj({ documentId: id('Document ID.'), version: int(), state: ref('DeliveryState'), viewedAt: ref('Timestamp') }),
  Notification: obj({
    notificationId: str({ pattern: '^[0-9]+$' }), profileId: id('Profile ID.'), type: str(), title: str(), body: str({ description: 'Generic text without diagnoses or result values.' }), at: ref('Timestamp'),
    documentId: nullable(id('Document ID.')), visitId: nullable(id('Visit ID.'))
  }),
  NotificationPage: obj({ notifications: arr(ref('Notification')), nextCursor: str(), hasMore: bool(), serverTime: ref('Timestamp') })
};

const header = (description: string, schema: Schema = str()) => ({ description, schema });
const headers = {
  ETag: header('Entity tag of this representation. Send it back as If-None-Match.'),
  'X-Request-Id': header('Request correlation ID.'),
  'Idempotent-Replayed': header('Present with value true when the stored original response was replayed.', { const: 'true' }),
  'Retry-After': header('Seconds to wait before retrying.', int())
};
const json = (schema: Schema) => ({ 'application/json': { schema } });
const ok = (description: string, schema: Schema, etag = false) => ({ description, headers: etag ? { ETag: headers.ETag, 'X-Request-Id': headers['X-Request-Id'] } : { 'X-Request-Id': headers['X-Request-Id'] }, content: json(schema) });
const created = (description: string, schema: Schema) => ({ description, headers: { 'X-Request-Id': headers['X-Request-Id'], 'Idempotent-Replayed': headers['Idempotent-Replayed'] }, content: json(schema) });
const errorResponse = (description: string) => ({ description, headers: { 'X-Request-Id': headers['X-Request-Id'], 'Retry-After': headers['Retry-After'] }, content: json(ref('Error')) });
const errs = (...codes: number[]) => Object.fromEntries(codes.map(code => [String(code), { $ref: `#/components/responses/E${code}` }]));
const p = (name: string) => ({ $ref: `#/components/parameters/${name}` });
const body = (schemaName: string) => ({ required: true, content: json(ref(schemaName)) });
const bearer = [{ bearerAuth: [] }];
const pub: unknown[] = [];
const notModified = { '304': { description: 'Not modified: the If-None-Match tag still matches.' } };

const paths: Record<string, unknown> = {
  '/meta': { get: { operationId: 'getMeta', tags: ['Common'], security: pub, summary: 'Server metadata and minimum app versions', description: 'Unauthenticated. Use it to validate a discovered or manually entered base URL.', responses: { '200': ok('Metadata', ref('Meta')), ...errs(429, 500) } } },
  '/session': {
    get: { operationId: 'getSession', tags: ['Common'], security: bearer, parameters: [p('DeviceId')], summary: 'Validate the current token', responses: { '200': ok('Session', ref('SessionInfo')), ...errs(400, 401, 426, 429) } },
    delete: { operationId: 'deleteSession', tags: ['Common'], security: bearer, parameters: [p('DeviceId')], summary: 'Sign out and revoke this token', description: 'Idempotent; a second call with the already revoked token returns 204.', responses: { '204': { description: 'Revoked' }, ...errs(400, 401) } }
  },
  '/doctor/personas': { get: { operationId: 'listDoctorPersonas', tags: ['Doctor'], security: pub, summary: 'Synthetic consultant personas', description: 'Public demo personas only, the same identities as the web app. Not production authentication.', responses: { '200': ok('Personas', ref('PersonaList'), true), ...notModified, ...errs(429) } } },
  '/doctor/sessions': { post: {
    operationId: 'createDoctorSession', tags: ['Doctor'], security: pub, parameters: [p('IdempotencyKey')], summary: 'Sign in as a demo consultant on this device',
    description: 'Issues a device-bound bearer token. Replaying the same Idempotency-Key and body returns the same token.', requestBody: body('DoctorSessionRequest'),
    responses: { '201': created('Signed in', ref('DoctorSession')), ...errs(400, 404, 422, 426, 429) }
  } },
  '/doctor/labs': { get: { operationId: 'listLabs', tags: ['Doctor'], security: bearer, parameters: [p('DeviceId'), p('IfNoneMatch')], summary: 'Labs available for INVESTIGATIONS routing', responses: { '200': ok('Labs', ref('LabList'), true), ...notModified, ...errs(400, 401, 403, 426, 429) } } },
  '/doctor/queue': { get: {
    operationId: 'getDoctorQueue', tags: ['Doctor'], security: bearer, parameters: [p('DeviceId'), p('IfNoneMatch'), { name: 'date', in: 'query', required: false, schema: ref('LocalDate'), description: 'Defaults to today in IST.' }],
    summary: 'The doctor\'s queue for a day', description: 'Includes booked, checked-in, active and completed visits. Poll with If-None-Match, or watch QUEUE_UPDATED events.',
    responses: { '200': ok('Queue', ref('Queue'), true), ...notModified, ...errs(400, 401, 403, 422, 426, 429) }
  } },
  '/doctor/queue/{queueEntryId}/start': { post: {
    operationId: 'startVisit', tags: ['Doctor'], security: bearer, parameters: [p('DeviceId'), p('IdempotencyKey'), p('QueueEntryId')], summary: 'Confirm the patient and start the consultation',
    description: 'Allowed from WAITING, CALLED, ON_HOLD or MISSED. Starting an already IN_CONSULTATION visit returns 200. BOOKED returns 409 NOT_CHECKED_IN.', requestBody: body('StartVisitRequest'),
    responses: { '200': created('Started', ref('StartVisitResponse')), ...errs(400, 401, 403, 404, 409, 422, 426, 429) }
  } },
  '/doctor/walk-ins': { post: {
    operationId: 'createWalkIn', tags: ['Doctor'], security: bearer, parameters: [p('DeviceId'), p('IdempotencyKey')], summary: 'DEMO ONLY: add a checked-in walk-in to today\'s queue',
    description: 'Bypasses the front desk and billing for testing. Reuses an existing patient with the same mobile and name. The production flow is front-desk registration and check-in.', requestBody: body('WalkInRequest'),
    responses: { '201': created('Queue entry', ref('QueueEntry')), ...errs(400, 401, 403, 404, 422, 426, 429) }
  } },
  '/doctor/patients/{patientId}/record': { get: {
    operationId: 'getPatientRecordForDoctor', tags: ['Doctor'], security: bearer, parameters: [p('DeviceId'), p('IfNoneMatch'), p('PatientId'), { name: 'visitId', in: 'query', required: false, schema: id('Visit justifying access.'), description: 'Optional. If omitted the server uses the doctor\'s active or recent visit with this patient.' }],
    summary: 'Longitudinal record of a patient in active care', description: 'Requires a care relationship: a visit with this doctor dated within the last 7 days (IST) that is WAITING, CALLED, IN_CONSULTATION, ON_HOLD or COMPLETED. Every read is audited. Includes all doctors\' signed documents.',
    responses: { '200': ok('Record', ref('PatientRecord'), true), ...notModified, ...errs(400, 401, 403, 404, 426, 429) }
  } },
  '/doctor/visits/{visitId}/complete': { post: {
    operationId: 'completeVisit', tags: ['Doctor'], security: bearer, parameters: [p('DeviceId'), p('IdempotencyKey'), p('VisitId')], summary: 'Atomically sign the visit bundle and mark the visit completed',
    description: 'Upload every referenced blob first. All documents, routing, deliveries and the visit status change commit together or not at all. Idempotency-Key must equal bundleId. Replay returns the original 201 response. A different bundle for an already completed visit returns 409 VISIT_ALREADY_COMPLETED; use addenda instead.',
    requestBody: body('CompleteVisitRequest'), responses: { '201': created('Signed and delivered', ref('CompleteVisitResponse')), ...errs(400, 401, 403, 404, 409, 413, 422, 426, 429) }
  } },
  '/doctor/visits/{visitId}/delivery': { get: {
    operationId: 'getVisitDelivery', tags: ['Doctor'], security: bearer, parameters: [p('DeviceId'), p('IfNoneMatch'), p('VisitId')], summary: 'Recipient states of the documents signed for a visit',
    responses: { '200': ok('Delivery', ref('VisitDelivery'), true), ...notModified, ...errs(400, 401, 403, 404, 426, 429) }
  } },
  '/doctor/documents/{documentId}': { get: {
    operationId: 'getDocumentForDoctor', tags: ['Doctor'], security: bearer, parameters: [p('DeviceId'), p('IfNoneMatch'), p('DocumentId')], summary: 'Document with every immutable version and current recipient states',
    description: 'Allowed for the author, or for a doctor with a care relationship with the patient.', responses: { '200': ok('Document', ref('ClinicalDocument'), true), ...notModified, ...errs(400, 401, 404, 426, 429) }
  } },
  '/doctor/documents/{documentId}/addenda': { post: {
    operationId: 'createAddendum', tags: ['Doctor'], security: bearer, parameters: [p('DeviceId'), p('IdempotencyKey'), p('DocumentId')], summary: 'Sign a new immutable version with a reason',
    description: 'Author only. Earlier versions stay readable and are never overwritten. Recipients of the previous version move to SUPERSEDED and the new version is delivered. Idempotency-Key must equal clientAddendumId.',
    requestBody: body('AddendumRequest'), responses: { '201': created('Version signed', ref('AddendumResponse')), ...errs(400, 401, 403, 404, 409, 413, 422, 426, 429) }
  } },
  '/doctor/events': { get: {
    operationId: 'getDoctorEvents', tags: ['Doctor'], security: bearer, parameters: [p('DeviceId'), p('IfNoneMatch'), p('Cursor'), p('Limit')], summary: 'Delta feed: queue changes, deliveries and lab results',
    description: `Event types: ${doctorEventTypes.join(', ')}. Ignore unknown types.`, responses: { '200': ok('Events', ref('EventPage'), true), ...notModified, ...errs(400, 401, 403, 426, 429) }
  } },
  '/patient/otp/request': { post: {
    operationId: 'requestPatientOtp', tags: ['Patient'], security: pub, parameters: [p('IdempotencyKey')], summary: 'Start mobile sign-in',
    description: `SYNTHETIC: no SMS is sent and demoCode is returned. Limits: one per ${otpLimits.cooldownSeconds}s, ${otpLimits.perMobileTenMinutes} per 10 minutes and ${otpLimits.perMobileDay} per day per mobile; ${otpLimits.perIpTenMinutes} per 10 minutes per IP.`,
    requestBody: body('OtpRequest'), responses: { '201': created('Challenge', ref('OtpChallenge')), ...errs(400, 404, 422, 426, 429) }
  } },
  '/patient/otp/verify': { post: {
    operationId: 'verifyPatientOtp', tags: ['Patient'], security: pub, parameters: [p('IdempotencyKey')], summary: 'Verify the code and receive a device-bound token',
    description: `${otpLimits.wrongCodesBeforeLock} wrong codes invalidate the challenge and lock the mobile for ${otpLimits.lockMinutes} minutes.`,
    requestBody: body('OtpVerify'), responses: { '201': created('Signed in', ref('PatientSession')), ...errs(400, 401, 422, 426, 429) }
  } },
  '/patient/profiles': { get: { operationId: 'listProfiles', tags: ['Patient'], security: bearer, parameters: [p('DeviceId'), p('IfNoneMatch')], summary: 'Family profiles registered with this mobile', responses: { '200': ok('Profiles', ref('ProfileList'), true), ...notModified, ...errs(400, 401, 403, 426, 429) } } },
  '/patient/profiles/{profileId}/record': { get: {
    operationId: 'getProfileRecord', tags: ['Patient'], security: bearer, parameters: [p('DeviceId'), p('IfNoneMatch'), p('ProfileId')], summary: 'Complete current record for one profile',
    description: 'Visits, every document routed to the patient with all versions, recipient states and released results.', responses: { '200': ok('Record', ref('PatientRecord'), true), ...notModified, ...errs(400, 401, 403, 426, 429) }
  } },
  '/patient/profiles/{profileId}/feed': { get: {
    operationId: 'getProfileFeed', tags: ['Patient'], security: bearer, parameters: [p('DeviceId'), p('IfNoneMatch'), p('ProfileId'), p('Cursor'), p('Limit')], summary: 'Delta feed for one profile',
    description: `Event types: ${patientEventTypes.join(', ')}. No cursor starts from the beginning of the profile history.`, responses: { '200': ok('Events', ref('EventPage'), true), ...notModified, ...errs(400, 401, 403, 426, 429) }
  } },
  '/patient/documents/{documentId}': { get: {
    operationId: 'getDocumentForPatient', tags: ['Patient'], security: bearer, parameters: [p('DeviceId'), p('IfNoneMatch'), p('DocumentId')], summary: 'Document detail with every version',
    responses: { '200': ok('Document', ref('ClinicalDocument'), true), ...notModified, ...errs(400, 401, 404, 426, 429) }
  } },
  '/patient/documents/{documentId}/viewed': { post: {
    operationId: 'markDocumentViewed', tags: ['Patient'], security: bearer, parameters: [p('DeviceId'), p('IdempotencyKey'), p('DocumentId')], summary: 'Acknowledge that the patient opened a document version',
    description: 'The doctor sees the PATIENT recipient move to VIEWED. Repeating it is harmless.', requestBody: body('ViewedRequest'),
    responses: { '200': created('Recorded', ref('ViewedResponse')), ...errs(400, 401, 404, 409, 422, 426, 429) }
  } },
  '/patient/notifications': { get: {
    operationId: 'pollNotifications', tags: ['Patient'], security: bearer, parameters: [p('DeviceId'), p('IfNoneMatch'), p('Cursor'), p('Limit')], summary: 'Poll notifications across all linked profiles',
    description: 'Push (FCM) is out of scope. Poll in the foreground and with periodic background work; 304 means nothing new.', responses: { '200': ok('Notifications', ref('NotificationPage'), true), ...notModified, ...errs(400, 401, 403, 426, 429) }
  } },
  '/blobs/{sha256}': {
    put: {
      operationId: 'putBlob', tags: ['Blobs'], security: bearer, parameters: [p('DeviceId'), p('Sha256'), { name: 'Content-Type', in: 'header', required: true, schema: str({ enum: ['image/png', 'application/pdf', 'application/vnd.samford.ink+json'] }) }],
      summary: 'Upload an immutable content-addressed blob (doctor only)',
      description: `The server verifies the SHA-256, size (PNG ${blobLimits.png / 1048576} MiB, PDF ${blobLimits.pdf / 1048576} MiB, ink ${blobLimits.ink / 1048576} MiB), and the real PNG, PDF or JSON structure. Uploading identical bytes again returns 200. Idempotency-Key is optional here.`,
      requestBody: { required: true, content: { 'image/png': { schema: str({ format: 'binary' }) }, 'application/pdf': { schema: str({ format: 'binary' }) }, 'application/vnd.samford.ink+json': { schema: { type: 'object' } } } },
      responses: { '200': ok('Already stored', ref('BlobReceipt')), '201': ok('Stored', ref('BlobReceipt')), ...errs(400, 401, 403, 413, 415, 422, 426, 429) }
    },
    head: { operationId: 'headBlob', tags: ['Blobs'], security: bearer, parameters: [p('DeviceId'), p('Sha256')], summary: 'Check whether a blob is already stored (doctor only)', responses: { '200': { description: 'Stored' }, '404': { description: 'Not stored' }, ...errs(400, 401, 403) } },
    get: {
      operationId: 'getBlob', tags: ['Blobs'], security: bearer, parameters: [p('DeviceId'), p('Sha256'), p('IfNoneMatch')], summary: 'Read a blob you are authorized to see',
      description: 'Pharmacy, lab, patient and doctor access is derived from the documents that reference the blob. Responses are immutable and cacheable.',
      responses: { '200': { description: 'Bytes', headers: { ETag: headers.ETag }, content: { 'image/png': { schema: str({ format: 'binary' }) }, 'application/pdf': { schema: str({ format: 'binary' }) }, 'application/vnd.samford.ink+json': { schema: { type: 'object' } } } }, ...notModified, ...errs(400, 401, 404, 426, 429) }
    }
  },
  '/files/{sha256}': { get: {
    operationId: 'getSignedFile', tags: ['Blobs'], security: pub, parameters: [p('Sha256'), { name: 'exp', in: 'query', required: true, schema: int() }, { name: 'sig', in: 'query', required: true, schema: str() }],
    summary: 'Read a blob through a short-lived signed URL', description: 'URLs come from document responses (pages[].url, pdfUrl, inkUrl). They expire after 15 minutes.',
    responses: { '200': { description: 'Bytes' }, '403': { $ref: '#/components/responses/E403' }, '404': { $ref: '#/components/responses/E404' } }
  } }
};

export const mobileOpenApi = {
  openapi: '3.1.0',
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  info: {
    title: 'Samford paperless OPD mobile API (synthetic mock backend)',
    version: mobileApiVersion,
    description: 'Contract for the Samford doctor tablet and patient Android apps. PUBLIC SYNTHETIC DEMO: no real patient data, SMS, payment, clinical signing or production authentication. See docs/mobile-sync.md for synchronization, idempotency, authorization and limits.'
  },
  servers: [{ url: 'https://{tunnelHost}/api/mobile/v1', variables: { tunnelHost: { default: 'example.trycloudflare.com', description: 'Read the current apiBaseUrl from the discovery gist.' } } }, { url: 'http://10.0.2.2:4320/api/mobile/v1', description: 'Isolated backend reached from an Android emulator.' }],
  tags: [
    { name: 'Common', description: 'Metadata and token lifecycle shared by both apps.' },
    { name: 'Doctor', description: 'Doctor tablet: personas, queue, record review, visit completion, addenda and events.' },
    { name: 'Patient', description: 'Patient app: OTP sign-in, family profiles, records, feeds and notifications.' },
    { name: 'Blobs', description: 'Immutable content-addressed page PNGs, PDFs and ink.' }
  ],
  security: bearer,
  paths,
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Device-bound opaque token. Every authenticated request must also send X-Device-Id.' } },
    parameters: {
      DeviceId: { name: 'X-Device-Id', in: 'header', required: true, schema: str({ pattern: '^[A-Za-z0-9._:-]{8,128}$' }), description: 'Must equal the deviceId used when the token was issued.' },
      IdempotencyKey: { name: 'Idempotency-Key', in: 'header', required: true, schema: str({ pattern: '^[A-Za-z0-9_-]{8,128}$' }), description: 'Required on every POST. UUID recommended. See docs/mobile-sync.md.' },
      IfNoneMatch: { name: 'If-None-Match', in: 'header', required: false, schema: str() },
      Cursor: { name: 'cursor', in: 'query', required: false, schema: str({ maxLength: 64 }), description: 'Opaque nextCursor from the previous page. Omit to start from the beginning.' },
      Limit: { name: 'limit', in: 'query', required: false, schema: int({ minimum: 1, maximum: 500, default: 100 }) },
      Sha256: { name: 'sha256', in: 'path', required: true, schema: ref('Sha256') },
      QueueEntryId: { name: 'queueEntryId', in: 'path', required: true, schema: id('Queue entry ID.') },
      VisitId: { name: 'visitId', in: 'path', required: true, schema: id('Visit ID.') },
      PatientId: { name: 'patientId', in: 'path', required: true, schema: id('Patient ID.') },
      ProfileId: { name: 'profileId', in: 'path', required: true, schema: id('Profile ID.') },
      DocumentId: { name: 'documentId', in: 'path', required: true, schema: id('Document ID.') }
    },
    responses: {
      E400: errorResponse('Malformed request, missing Idempotency-Key or X-Device-Id, or invalid cursor.'),
      E401: errorResponse('Missing, invalid, expired or revoked token; device mismatch; wrong OTP.'),
      E403: errorResponse('Authenticated but not permitted, for example no care relationship.'),
      E404: errorResponse('Not found or outside your scope.'),
      E409: errorResponse('State conflict, for example MISSING_BLOBS, VISIT_ALREADY_COMPLETED or NOT_LATEST_VERSION.'),
      E413: errorResponse('Payload too large.'),
      E415: errorResponse('Unsupported media type.'),
      E422: errorResponse('Validation failed, hash mismatch or Idempotency-Key reused with a different request.'),
      E426: errorResponse('This app version is below the minimum. Update the app.'),
      E429: errorResponse('Rate limited; see Retry-After.'),
      E500: errorResponse('Unexpected server error; retry later.')
    },
    schemas
  }
};
