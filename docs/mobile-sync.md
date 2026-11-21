# Samford mobile sync contract v1

This document defines the behaviour behind [`mobile-api-v1.yaml`](mobile-api-v1.yaml) for the **Samford doctor tablet app** and the **Samford patient app**. The OpenAPI file is generated from `shared/mobile-contract.ts`; the server validates request bodies against the same schemas.

> **Public synthetic demo.** No real patient data, SMS, push, payment, insurer, ABDM, clinical signing or production authentication exists. Demo OTP codes are returned in API responses because there is no SMS provider. Never enter real patient information.

## 1. The paperless OPD journey

1. The front desk registers the patient, books a slot and checks the patient in on the web app. The visit appears in the doctor's tablet queue (`GET /doctor/queue`, `QUEUE_UPDATED` events). A returning patient is flagged.
2. The doctor confirms the patient (`POST /doctor/queue/{queueEntryId}/start`) and may open the longitudinal record of a patient in active care (`GET /doctor/patients/{patientId}/record`): earlier visits, every signed handwritten document version, lab results and allergies.
3. The doctor writes on the tablet. Nothing is sent while writing. Each document (visit summary, prescription, investigations, advice/referral, other) becomes page PNGs, one PDF containing exactly those pixels, and optional vector ink (`samford-ink/1`, defined by the doctor app repository).
4. When the doctor marks the visit completed, the tablet uploads missing blobs and commits one **bundle** (`POST /doctor/visits/{visitId}/complete`). The bundle, routing, deliveries and visit completion commit atomically.
5. Routed copies appear immediately: the pharmacy sees the exact handwritten prescription, each chosen lab sees the investigations, and the patient app sees every document routed to the patient.
6. Pharmacy and lab staff act on the web desks. States flow back to the doctor (`GET /doctor/visits/{visitId}/delivery`, `DOCUMENT_STATE_CHANGED`, `LAB_RESULT_READY`) and to the patient (feed and notifications).
7. Corrections are **addenda**: a new immutable version with a reason. Nothing is overwritten.

## 2. Discovery and environments

Discovery URL (public gist, no secrets; bake it into both APKs):

`https://gist.githubusercontent.com/shivam098/a4237b7aa37de0c876d5c08a3c250d52/raw/samford-endpoint.json`

The apps read this file and fall back to their last known good URL or a manually entered URL when it is unreachable or `status` is not `online`:

```json
{
  "schema": "samford-endpoint/1",
  "status": "online",
  "apiBaseUrl": "https://<random>.trycloudflare.com/api/mobile/v1",
  "webUrl": "https://<random>.trycloudflare.com/",
  "updatedAt": "2026-11-21T04:00:00.000Z",
  "minDoctorAppVersion": 1,
  "minPatientAppVersion": 1,
  "synthetic": true,
  "message": "Public synthetic demo."
}
```

- `apiBaseUrl` is the **complete** mobile base including `/api/mobile/v1`. Append operation paths such as `/doctor/queue`. It is `null` when `status` is `offline`.
- `status` is `online`, `offline` or `maintenance`. GitHub caches raw gist content for a few minutes; always validate a candidate URL with `GET {apiBaseUrl}/meta` before switching.
- The Quick Tunnel URL changes whenever the tunnel restarts. The tunnel start script updates the gist automatically.

### Isolated backend for development and CI

Every run gets its own port and a throwaway SQLite database seeded with the same synthetic personas, patients and returning-patient history. It never touches the shared demo database.

Windows (PowerShell):

```powershell
git clone https://github.com/shivam098/samford-web-app.git samford-backend
cd samford-backend
npm ci
npm run mobile:isolated -- --port 4320 --data "$env:TEMP\samford-ci-4320" --reset --relaxed-limits --test-support
```

Linux (GitHub Actions):

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 24 }
- name: Start isolated Samford backend
  run: |
    git clone https://github.com/shivam098/samford-web-app.git "$RUNNER_TEMP/samford-backend"
    cd "$RUNNER_TEMP/samford-backend"
    git checkout <pinned commit SHA>
    npm ci
    nohup npm run mobile:isolated -- --port 4320 --data "$RUNNER_TEMP/samford-db" --reset --relaxed-limits --test-support > "$RUNNER_TEMP/samford.log" 2>&1 &
    for i in $(seq 1 60); do curl -fsS http://127.0.0.1:4320/api/mobile/v1/meta && break; sleep 1; done
```

- Base URL from the host: `http://127.0.0.1:4320/api/mobile/v1`. From an Android emulator on the same machine: `http://10.0.2.2:4320/api/mobile/v1`.
- The server binds `127.0.0.1` only. `--host 0.0.0.0` is available for a physical device on a trusted test network and prints a warning.
- `--reset` deletes only the database files inside a directory previously created by this script. Directories it did not create are refused.
- `--relaxed-limits` raises rate and OTP limits for repeated automated logins. Do not use it to test limits.
- `--test-support` enables `POST /api/test-support/*` shortcuts for E2E tests (section 13). They are never enabled on the shared demo.
- A `ready.json` file with the URLs is written to the data directory once the server listens. Stop it with Ctrl+C or by stopping that process ID.
- `npm run build` is needed only if you also want the web desks from the same isolated server.

## 3. Conventions

- JSON in UTF-8. Timestamps are ISO-8601 UTC (`2026-11-21T04:05:06.000Z`). Hospital dates (`date`) are calendar dates in Asia/Kolkata (IST).
- IDs are opaque strings. `queueEntryId` equals `visitId` in this backend; `profileId` equals `patientId`; `personaId` equals `doctorId`.
- Enumerations are UPPER_SNAKE. **Clients must ignore unknown fields, unknown event types and display unknown states verbatim.**
- Every response carries `X-Request-Id`. Quote it when reporting a problem.
- Send `X-Samford-App: doctor-android` or `patient-android` and `X-Samford-App-Version: <versionCode>`. When present, a version below the minimum gets `426 APP_UPDATE_REQUIRED`.

## 4. Authentication and device binding

| | Doctor tablet | Patient app |
|---|---|---|
| Sign-in | `GET /doctor/personas`, then `POST /doctor/sessions {personaId, deviceId, deviceName}` | `POST /patient/otp/request {mobile, deviceId}`, then `POST /patient/otp/verify {challengeId, code, deviceId}` |
| Token lifetime | 7 days | 90 days |
| Identity | Same synthetic consultants as the web app | All active patients registered with the mobile are the account's profiles |

- Send `Authorization: Bearer <token>` **and** `X-Device-Id: <deviceId>` on every authenticated request. The device ID must equal the one used at sign-in, otherwise `401 DEVICE_MISMATCH`. Generate a random device ID once per installation and keep it.
- Cookies are never accepted on mobile routes. Tokens are opaque; store them in Android Keystore-backed storage and never log them.
- `GET /session` validates a token. `DELETE /session` revokes it.
- `401` codes: `AUTH_REQUIRED`, `TOKEN_INVALID`, `TOKEN_EXPIRED`, `DEVICE_MISMATCH`, `ACCESS_REVOKED` (account suspended or deactivated by an administrator), `DEVICE_SIGNED_OUT` (IT signed out this device on the web admin portal). After any 401, keep local unsent work and ask the user to sign in again; never discard it. Suspension also revokes existing tokens, so after reactivation an old token returns `TOKEN_INVALID`; a token issued before an IT sign-out stays `DEVICE_SIGNED_OUT` even after the doctor signs in again.
- Doctor sign-ins appear on the web admin device list and as app activity, not attendance.
- OTP: 6 digits, valid 5 minutes. One request per 30 seconds per mobile, 3 per 10 minutes, 10 per day; 20 per 10 minutes per IP (`429 OTP_RATE_LIMITED` with `Retry-After`). Three wrong codes invalidate the challenge and lock the mobile for 30 minutes (`429 OTP_LOCKED`), shared with the web patient portal. An unregistered mobile returns `404 MOBILE_NOT_REGISTERED`.

## 5. Idempotency

- **Every POST requires `Idempotency-Key`** (8-128 characters `[A-Za-z0-9_-]`; use a UUID). Missing: `400 IDEMPOTENCY_KEY_REQUIRED`.
- Keys are scoped to the authenticated doctor or patient account, or to `deviceId` for sign-in calls.
- The server fingerprints method, path and canonical JSON body. A repeat with the same key and fingerprint returns the **original status and body** with `Idempotent-Replayed: true`. The same key with a different request returns `422 IDEMPOTENCY_KEY_REUSED`.
- Only successful (2xx) responses are stored. After `409 MISSING_BLOBS`, upload the listed blobs and retry **the same request with the same key**.
- Visit completion: `Idempotency-Key` must equal `bundleId`. Addendum: it must equal `clientAddendumId`. These are kept permanently, so a tablet that was offline for days can safely retry. Other keys are kept for at least 7 days.
- Sign-in responses are replayable for 24 hours; they are encrypted at rest because they contain tokens or demo codes.
- `PUT /blobs/{sha256}` is naturally idempotent; `Idempotency-Key` is optional there. `DELETE /session` is idempotent.

## 6. Completing a visit offline-first

1. While the doctor writes, keep everything on the tablet. Commit locally first.
2. On **Completed**, freeze the bundle: final page PNGs, the PDF, the ink JSON, routing, optional hints and an optional follow-up. Generate `bundleId` (UUID) and `clientDocId`s once and persist them with the bundle.
3. Compute SHA-256 for every blob. Optionally `HEAD /blobs/{sha256}` to skip existing ones. `PUT` the others with the correct `Content-Type` (`image/png`, `application/pdf`, `application/vnd.samford.ink+json`).
4. `POST /doctor/visits/{visitId}/complete` with `Idempotency-Key: <bundleId>`.
   - `201`: synced. Store `documentId`s, versions and `recordHash`, then mark the local bundle synced. Keep the local copy until then.
   - `409 MISSING_BLOBS`: `error.details.missing` lists `{sha256, mediaType, role: PAGE|PDF|INK, clientDocId, pageIndex}`. Upload them and retry the same request.
   - `409 VISIT_NOT_STARTED` / `NOT_CHECKED_IN` / `VISIT_CLOSED`: show the conflict; do not discard the bundle.
   - `409 VISIT_ALREADY_COMPLETED` (a different bundle completed it): keep the bundle and offer to sign it as addenda.
   - `5xx`, `429`, timeouts or lost responses: retry the identical request with backoff. Replay returns the original result.
5. Sync bundles strictly in the order they were completed per visit. Independent visits may sync in parallel.

Validation on completion: 1-20 documents, 1-60 pages per document, at most 150 pages per bundle; page indexes `0..n-1`; each page's `widthPx`/`heightPx` must equal the PNG header (`422 PAGE_DIMENSIONS_MISMATCH`); blobs must exist with the declared role type (`422 BLOB_TYPE_MISMATCH`); hints at most 32 KiB.

Routing rules (`422 ROUTING_INVALID`): `pharmacy: true` only for `PRESCRIPTION`; `labs` only for `INVESTIGATIONS` and each ID must come from `GET /doctor/labs` (`422 UNKNOWN_LAB`); `patient` controls the patient app copy. A follow-up with `requestBooking` (default `true`) appears on the front desk's follow-up list.

## 7. Immutable documents, versions and record hashes

- `documentId` is stable across versions; version 1 is created by completion. `POST /doctor/documents/{documentId}/addenda` signs version n+1 with a reason (author only, `baseVersion` must equal the latest version or `409 NOT_LATEST_VERSION`). The new version carries its complete page set; unchanged pages reuse their hashes. Earlier versions remain readable forever.
- `recordHash` is the lowercase hex SHA-256 of the UTF-8 **canonical JSON** (object keys sorted by code unit, no whitespace, arrays in order) of:
  `{schema:"samford-record/1", documentId, version, visitId, patientId, doctorId, type, title, pages:[{index,pngSha256,widthPx,heightPx}], pdfSha256, inkSha256, inkFormat, routing:{pharmacy,labs,patient}, hints (or null), signedAt, receivedAt, reason (or null), previousRecordHash (or null)}`.
  The bundle `recordHash` hashes `{schema:"samford-bundle/1", bundleId, visitId, recordHashes:[... in request order]}`.
- Blobs are content-addressed and immutable, so a document's hashes identify its exact pixels and ink.

## 8. Delivery states

| Recipient | States |
|---|---|
| `PHARMACY` | `AVAILABLE` -> `VIEWED` -> `DISPENSED`, `PARTIALLY_DISPENSED` (-> `DISPENSED`) or `NOT_DISPENSED` |
| `LAB` (per lab) | `AVAILABLE` -> `VIEWED` -> `SAMPLE_COLLECTED` -> `RESULT_READY` |
| `PATIENT` | `AVAILABLE` -> `VIEWED` |

Any recipient of an earlier version becomes `SUPERSEDED` when an addendum is signed, and the new version is delivered as `AVAILABLE`. `PENDING` may be used by the tablet locally before upload but is never sent by the server. Dispensing and result entry are recorded by pharmacy and lab staff on the web desks; pharmacy stock and billing for handwritten prescriptions are outside this mock.

Lab results for a handwritten request follow the hospital's independent-verification rule (SJ15): a lab technician of the routed lab enters each result, and the copy becomes `RESULT_READY` (and the result visible to the doctor and patient) only when a **different** lab user with verifier rights releases it. The handwritten-request lab path has no barcode or billing step in this mock. A partially dispensed prescription can later become `DISPENSED`; `NOT_DISPENSED` needs a note for the doctor and patient.

## 9. Feeds, polling and caching

- `GET /doctor/events` and `GET /patient/profiles/{profileId}/feed` return events oldest first. Omit `cursor` to start from the beginning; then always send `nextCursor`. `limit` is 1-500 (default 100). `hasMore: true` means fetch again immediately.
- Event fields: `eventId` (numeric string), `type`, `at`, `message`, optional `visitId`, `documentId`, `patientId` and type-specific `data`.
  - Doctor: `QUEUE_UPDATED`, `DOCUMENT_SIGNED`, `DOCUMENT_STATE_CHANGED`, `LAB_RESULT_READY`.
  - Patient: `VISIT_UPDATED`, `DOCUMENT_AVAILABLE`, `DOCUMENT_AMENDED`, `DOCUMENT_STATE_CHANGED`, `LAB_RESULT_READY`.
- Events are hints: after an event, fetch the authoritative resource (queue, record, document or delivery).
- Every JSON `GET` returns an `ETag`. Send it as `If-None-Match`; an unchanged representation returns `304` without a body. For feeds, an unchanged tag means no new events.
- Suggested polling: doctor queue and events every 10-15 seconds while visible; patient notifications every 60 seconds in the foreground and through periodic background work (at most every 15 minutes). Push is out of scope.
- `GET /patient/notifications` merges notification-worthy events across all profiles: document available or amended, result ready, prescription dispensed and token called. Notification text never contains diagnoses or result values.

## 10. Blobs

- `PUT /blobs/{sha256}`: doctors only. The server verifies the SHA-256 (`422 HASH_MISMATCH`), the size (PNG 10 MiB, PDF 25 MiB, ink 16 MiB; `413 PAYLOAD_TOO_LARGE`), the media type (`415 UNSUPPORTED_MEDIA_TYPE`), and the real structure: PNG signature, chunk CRCs, IHDR and IEND with each side 200-8192 pixels; PDF header and EOF marker; ink as a JSON object (`422 BLOB_INVALID`). `201` stores, `200` means identical bytes already exist.
- `GET /blobs/{sha256}` with a bearer token, or the signed `url`, `pdfUrl` and `inkUrl` values in document responses (valid 15 minutes, no headers needed, suitable for image loaders). Blob responses are immutable: `Cache-Control: private, max-age=31536000, immutable` and `ETag: "<sha256>"`.
- Unknown or unauthorized blobs return `404`, so existence is not disclosed.

## 11. Authorization

| Caller | Can read |
|---|---|
| Doctor (author) | Own signed documents, their versions, delivery states and lab results, always |
| Doctor (treating) | The full record of a patient with a care relationship: a waiting, called, in-consultation or on-hold visit, or one completed in the last 7 days, with that doctor. Every record read is audited. Otherwise `403 CARE_RELATIONSHIP_REQUIRED`. |
| Pharmacy (web) | Prescriptions routed to the pharmacy only |
| Lab (web) | Investigations routed to that lab only; results it entered |
| Medical records (web) | Visit summaries, for coding the visit |
| Patient | Documents routed to the patient for profiles registered with the account's mobile, released results and own visits |

Blob access is derived from the documents that reference the blob. Doctors can also read blobs they uploaded but have not yet committed. Administrators, the front desk and other staff cannot read handwritten clinical documents.

## 12. Errors

```json
{ "error": { "code": "MISSING_BLOBS", "message": "Upload the listed files, then retry the same bundle.", "retryable": true,
  "details": { "missing": [{ "sha256": "...", "mediaType": "image/png", "role": "PAGE", "clientDocId": "...", "pageIndex": 0 }] },
  "requestId": "..." } }
```

| HTTP | Codes |
|---|---|
| 400 | `BAD_REQUEST`, `IDEMPOTENCY_KEY_REQUIRED`, `DEVICE_ID_REQUIRED`, `INVALID_CURSOR` |
| 401 | `AUTH_REQUIRED`, `TOKEN_INVALID`, `TOKEN_EXPIRED`, `DEVICE_MISMATCH`, `ACCESS_REVOKED`, `DEVICE_SIGNED_OUT`, `OTP_INVALID`, `OTP_EXPIRED` |
| 403 | `FORBIDDEN`, `CARE_RELATIONSHIP_REQUIRED`, `NOT_AUTHOR`, `SIGNATURE_INVALID` |
| 404 | `NOT_FOUND`, `MOBILE_NOT_REGISTERED`, `UNKNOWN_PERSONA` |
| 409 | `MISSING_BLOBS`, `NOT_CHECKED_IN`, `VISIT_NOT_STARTED`, `VISIT_CLOSED`, `VISIT_ALREADY_COMPLETED`, `NOT_LATEST_VERSION`, `INVALID_STATE` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 422 | `VALIDATION_FAILED` (`details.errors[]`), `HASH_MISMATCH`, `BLOB_INVALID`, `BLOB_TYPE_MISMATCH`, `PAGE_DIMENSIONS_MISMATCH`, `ROUTING_INVALID`, `UNKNOWN_LAB`, `IDEMPOTENCY_KEY_REUSED` |
| 426 | `APP_UPDATE_REQUIRED` |
| 429 | `RATE_LIMITED`, `OTP_RATE_LIMITED`, `OTP_LOCKED` (with `Retry-After`) |
| 500/503 | `INTERNAL_ERROR`, `UNAVAILABLE` (retryable) |

`retryable` is true for 5xx, 429 after `Retry-After`, and `MISSING_BLOBS` after uploading.

## 13. Isolated test support (never on the shared demo)

With `--test-support`, these unauthenticated shortcuts help E2E tests drive the web roles:

- `POST /api/test-support/visits` `{doctorId, patientId?, patient?: {name, age, sex, mobile}}` books and checks in a visit for today through the normal front-desk rules. Returns `{visitId, patientId, token}`.
- `POST /api/test-support/deliveries` `{documentId, recipient: "PHARMACY"|"LAB"|"PATIENT", labId?, state, note?, result?: {testName, value, unit?, refRange?, flag?}}` performs the pharmacy, lab or patient action through the same web commands and rules as the desks, on the latest version. Intermediate steps are performed as needed: `RESULT_READY` views, records sample collection, enters the result as that lab's technician and releases it as the seeded independent verifier. Returns `{documentId, delivery}`.
- `POST /api/test-support/clock` `{minutes}` advances the synthetic clock (token expiry, OTP lock, 7-day care window).

## 14. Limits

- Bearer tokens: 600 requests per minute per token (`429 RATE_LIMITED`). Unauthenticated requests: 120 per minute per IP.
- JSON bodies: 1 MiB for completion and addenda, 64 KiB otherwise.
- These are single-node mock limits. See [scale-design.md](scale-design.md) for the production design for 1 lakh patient users and 50 doctors.

## 15. Versioning

- The major version is in the path (`/api/mobile/v1`). Within v1 the server only adds optional fields, endpoints, event types and enum values. Breaking changes require `/api/mobile/v2` and a coordinated app release.
- `GET /meta` returns `apiVersion` (semantic) and the minimum app versions also published in discovery. Minimum versions are integer Android `versionCode`s.
- Change log: 1.0.0 (2026-11-21) initial contract; server 0.3.0 implements every v1 operation.

## 16. Seeded synthetic data

Every fresh or reset database contains the same synthetic records. Dates are relative to when the database was created.

| Item | Seeded value |
|---|---|
| Doctor personas | `doctor-a` (General medicine), `doctor-b` (Surgery), `doctor-c` (General medicine; author of the seeded history) |
| doctor-a's queue today | `visit-a`: patient-a, token 1, `WAITING`, returning, Penicillin allergy. `visit-b`: patient-b, token 2, `WAITING`, returning. `visit-video`: patient-child, `BOOKED` (not checked in) |
| doctor-b's queue today | `visit-c`: patient-c, token 1, `WAITING` |
| Labs | `central-lab` (Central pathology lab, `PATHOLOGY`), `radiology` (Radiology, `IMAGING`) |
| Patient mobiles | `9000000001`: patient-a and patient-child. `9000000002`: patient-b. `9000000003`: patient-c |
| History, 21 days ago | `visit-history-a` (doctor-c, patient-a): 2-page visit summary; prescription dispensed and viewed; investigations to central-lab with a released, verified CBC result flagged `ABNORMAL` |
| History, 14 days ago | `visit-history-b` (doctor-c, patient-b): visit summary; prescription version 1 superseded by a version 2 addendum ("Corrected dose and duration"), version 2 dispensed and not yet viewed by the patient |
| Web desk personas | `pharmacy` (pharmacist), `lab` (central-lab technician), `radiology` (radiology technician), `verifier` (verifier for both labs), `desk`, `mrd` |

Seeded pages are deterministic 1500x2121 PNGs with a visible "SYNTHETIC SAMPLE - NOT FOR CLINICAL USE" banner, the PDFs embed exactly those pixels, and the ink uses the placeholder format `samford-ink-placeholder/0` until fixtures in `samford-ink/1` replace them. The server never modifies uploaded blobs, so the doctor app must draw the same visible synthetic banner on its own pages and PDFs.
