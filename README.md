# Samford workflow lab

A working **public synthetic hospital prototype**, not the earlier PRD viewer. Responsive doctor, administration, staff and patient workspaces share a persistent SQLite mock hospital.

**Version 0.2 is a prepared candidate, not an automatic live upgrade.** Builds write `dist-candidate` only. The existing port-4317 demo and its `dist` assets/database are deliberately left alone until a coordinated restart.

**No tester password is required.** The landing page explicitly signs into a named synthetic persona. Anyone with the temporary public URL can use those personas and change the shared sample records. Do not enter real patient information, real credentials or original hospital media.

## Run on Windows

Requires Node.js 24+ and npm. The API uses Node's built-in SQLite; no database service is needed.

```powershell
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4318** for the isolated candidate (`data-candidate\samford.sqlite`). The built frontend and API are served from one origin, bound only to loopback. This is not a publicly bound development server.

Alternatively:

```powershell
.\Start-Candidate.ps1 -Build
```

Stop a foreground run with Ctrl+C. Restarting preserves the selected data. `Start-Candidate.ps1 -Port <port>` refuses live port 4317. Tests use disposable databases and ephemeral ports.

### Prepare an immutable release; do not silently switch testers

```powershell
npm run check
npm run package:candidate
.\Start-Release.ps1 -ReleaseDirectory 'data\releases\<printed-release-folder>'
```

Packaging freezes the backend bundle, built assets and licensed fonts in a new checksummed directory. It does not restart anything. The release launcher defaults to **4318 and isolated candidate data**, refuses modified artifacts, and does not kill a process occupying the port. Later builds cannot replace this release's served frontend.

For an explicitly agreed live upgrade:

1. Ask testers to sync/review pending work and close their tabs. Retain the old release and browser profiles; do not clear encrypted drafts.
2. Stop only the known live server process, not all Node processes. The existing Cloudflare tunnel may keep running against 4317 during the brief outage.
3. Run `npm run backup:shared`. It takes a consistent SQLite online backup and checks integrity. Do **not** copy only a WAL-active `.sqlite` file.
4. Run `.\Start-Release.ps1 -ReleaseDirectory 'data\releases\<verified-release-folder>' -Port 4317 -UseSharedData`. This is the explicit shared-data switch. Port binding and frontend-version checks occur before database initialization.
5. Confirm `/api/health` reports `0.2.0`; reopen/reload the browser and verify the intended persona/worklist. Recheck the existing public HTTPS URL before announcing the switch.

Schema v2 adds staff role metadata, a dual-role sample identity, a canonical synthetic scheme package and missing payer tariffs. Existing clinical/financial records, credentials, receipts, old versions and audit entries are retained. Earlier claims without a canonical package need the explicit **Reconcile an earlier package reference** action and fresh simulated approval; paid bills are not silently repriced. Pending admin account edits may encounter an honest version conflict after metadata migration.

The migration is transactionally idempotent and refuses unsupported/newer schemas. Its tests include an opt-in **read-only online backup of the running v1 database**, migration of that copy, byte-for-byte preservation checks and live-asset fingerprints:

```powershell
$env:SAMFORD_LIVE_PROOF = '1'
npm run test:migration
Remove-Item Env:\SAMFORD_LIVE_PROOF
```

This opt-in check is only for the original local v1 deployment. Ordinary cloned-project tests skip it explicitly. Results stay in ignored `test-artifacts\migration-live-proof.json`.

Rollback before accepting v2 writes can restore the verified pre-upgrade backup and old frozen runtime. **Do not run the old backend on a database with new v2 writes or overwrite new work to roll back.** After new writes, preserve that database and reconcile/migrate forward instead.

### Temporary public link

With the intentionally selected live app already running on 4317 and `cloudflared` installed:

```powershell
.\Start-Tunnel.ps1
```

Cloudflare prints the actual random `https://....trycloudflare.com` address. It changes when a new Quick Tunnel is started. The computer must remain awake and **both the app and tunnel processes must remain running**. No Cloudflare account or named tunnel is configured.

The public demo has no access password **by explicit product-owner choice**. Persona sessions, server-side role checks, same-origin mutation checks, body/rate limits and private document routes still apply. The SQLite database, filesystem, source files, original PRDs, logs and test artifacts are not HTTP-served. Only built frontend assets and intentionally exposed API/profile/board routes are served.

## Try a complete handoff

1. Choose **Front desk** under Staff. Register a synthetic patient, book a shared slot and check in. A bill and token appear; repeated check-in is refused.
2. Switch to **Demo doctor A**. Open Patients, confirm the patient, save a note, review a prescription and send test orders. Use the six-tab visit workspace and its action grid.
3. Switch to **Cashier** or the linked **Patient** to pay the synthetic bill. A failed payment leaves it unpaid. Paid/covered tests reach collection.
4. Choose **Pharmacist** to receive and dispense the approved prescription. Try an expired batch or a substitute request; the doctor must answer the exact prescription version.
5. Choose **Lab entry** to collect, accept and enter a result, then **Lab verifier** to verify/release it. Entry authors cannot verify their own result.
6. Return to the doctor to review the report, answer a referral, plan follow-up, request admission/OT, round on the ward, and approve a discharge. Nursing and billing complete their own handoffs before a gate pass frees the bed.

Use separate browser profiles/incognito contexts to keep multiple personas signed in simultaneously. Normal tabs share the same session cookie; switching in another tab blocks old-author submission rather than reattributing it.

Other journeys include insurance, refunds and counter close, purchases/GRNs/stock transfers, inventory/expiry, day care, consents and certificates, health packages, transport, diet, mortuary, facility requests, coding, hospital documents, MIS, feedback, staff/admin identities, policies, devices, rosters, templates and support.

## Sign-in journey versus public demo shortcut

The landing page's **Test sign-in / onboarding** opens the full synthetic authentication flow:

- Seeded login IDs include `doctor-a`, `doctor-b`, `resident`, `super`, `super-two`, `admin`, `it`, `head`, `auditor`, `desk`, `cashier`, `pharmacy`, `store`, `nurse`, `lab`, `verifier`, `ot`, `mrd`, `services`, `services-two`, `manager`, `manager-two`.
- `desk-cashier` demonstrates multiple staff roles on one named identity. AJ22 can assign staff-role combinations; the action's effective role is recorded without changing the person. Changing roles invalidates old sessions. Switching roles never permits self-approval or self-verification.
- Seeded demonstration password: `SamplePass2026!`. This is a deliberately public fixture, not a secret.
- OTP/authenticator/captcha are explicitly simulated. The generated code is shown so success, expiry and failure/lockout can be tested.
- Family mobile `9000000001` links only Demo patient A and Demo child A. Another sample family uses `9000000003`.
- Invited/reset accounts receive a generated one-time temporary password. It is returned once and never persisted in plaintext in users, audit or command receipts. Set a new **synthetic** password, then confirm the profile before accessing records.
- Five wrong passwords lock the default policy; patient OTP locks after three wrong codes. IT must verify identity before resetting/unlocking.
- Demo app-lock/discharge PIN: `2468`. It records synthetic attestation, **not** a legal signature or production biometric check.

## Persistence, retries and recovery

- Server: `data\samford.sqlite`, including records, immutable versions, credentials as salted scrypt hashes, sessions, command receipts and append-only audit. SQLite WAL/shm files are part of the live database. These files are Git-ignored.
- Browser: persona-isolated **AES-GCM encrypted IndexedDB** contains the authorized snapshot, form drafts and ordered outbox. Non-extractable Web Crypto keys are origin-local. This is not a claim of hardware-backed or production clinical-device security.
- Work is marked saved only after browser persistence completes. Form drafts and queued actions survive reload. A failed local write displays an error rather than reporting success.
- A command binds `actorId`, `deviceId`, `operationId`, expected record version, reviewed context versions, payload and local event time. The server transaction atomically changes state, records audit and stores its receipt.
- Retry the **identical operation** after an uncertain/lost response. Reusing an operation ID with different content fails. Record/context conflicts retain both versions and require an explicit reviewed replacement or abandonment.
- Rejections remain per-item, while independent ready work can continue. Hospital acceptance does not imply pharmacy/lab receipt, clinical acknowledgement, payment or completion.
- Role revocation and remote sign-out block the next server check. Browser wipe remains pending until this app reports its own cache removal and unsent recovery/loss count. It cannot wipe personal files or an unreachable device.
- Browser caches are origin-specific. Prefer the stable localhost URL for offline/restart testing; a replacement Quick Tunnel URL is a different browser origin.
- Do not run competing copies of the app against different replicas of the OneDrive data directory. This is a single local mock server, not a distributed database.

## Training controls

**Sync & recovery:** disconnect this persona's simulated link, fail before acceptance, lose the reply after acceptance, inject a real remote version change, reject the next action, inspect the outbox and retry/review conflicts.

**Demo controls:** operations/super admin can simulate provider outages and advance the shared clock. Scheduled checks perform missed 22:00 IST presence resets, exclude on-call/night duty, reactivate timed suspensions, process checked scheduled exits, expire bed reservations, apply approved future MRP changes, surface urgent/critical deadlines and run reminder jobs. A failed job stays visible.

**Reset:** only a super-admin persona can reset, after typing `RESET SHARED SYNTHETIC DATA`. It resets shared sample records and sessions, retains the audit, and does not silently erase browser drafts. Other testers are affected. Refresh/review old local actions after a reset.

## APIs and traceability

After choosing a persona, open **APIs & coverage**:

- `GET /api/contracts`: generated **OpenAPI 3.1** reference with every command, field, role and valid starting state.
- `GET /api/traceability`: all 87 journey IDs mapped to UI routes, authentication/read endpoints and command endpoints.
- `docs\traceability.json`: persisted, machine-readable behavioral evidence from the latest completed API/browser test runs.
- `GET /api/state`: authorized projection only. Admins do not get patient notes/results/prescriptions. Patient search and IDs never widen access.
- `POST /api/commands/<name>`: explicit domain commands, not arbitrary CRUD or writable status fields.
- `GET /api/receipts/<operationId>`: original actor's accepted outcome.
- `GET /api/history/<id>`: authorized immutable record versions.
- `GET /api/slots?doctorId=...&date=...`: shared availability states without other patients' identities.
- `GET /api/documents/<id>/file`: authorized real PDF/image bytes.
- Reports, audited CSV exports and token-only board endpoints are included in the contract.
- Group handover summaries, package quotes, admission estimates, counter reconciliation, claims and day-end exports are in the contract as well.

Mutations require JSON and `X-Samford-Request: 1`, with a same-origin session cookie. An `Origin` from another host is rejected. Error responses include a stable code, plain-language next step and retriable/conflict metadata; database exceptions are not returned.

User-entered amounts are INR; persisted financial values are integer paise. Snapshotted bill rates do not change when a future tariff is approved. MRP/GST, stock, bed state, result entry/verification/release, report review and discharge gates are separately validated.

### Required variants added in 0.2

- **Paper Rx:** prescriber name/registration/date, readable private scan, reviewed transcription, pharmacist attribution, original-batch dispensing and explicit doctor-controlled substitutions.
- **Home:** real drag ordering, show/hide, per-card rows, six shortcuts, hospital reset, department locks and own monthly activity numbers. Reset does not erase language or alert preferences.
- **Handover:** separate consultant/department queue for each open-work group, counts/UHIDs without clinical text, blocked incomplete/unsynced exits and explicit queue claim. Scheduled exits revalidate recipients, new work groups and unsent work at execution.
- **Roster/OT:** repeat weekly patterns with conflict preview/replacement; emergency displacement atomically validates both slots, preserves the old slot/reason, notifies the displaced surgeon and requires renewed acceptance/checks.
- **Finance:** explicit payer/package rates, scheme coverage and expiry, visible patient share, independent deduction ownership, original-mode discounted refunds, GST reconciliation, protected applied advances, counted denominations and retryable accounts exports. **The accounting ledger is a PRD non-goal**, not a missing implementation.
- **Hindi:** doctor/patient action/field/choice labels, key workspace controls and actual Hindi PDFs with an embedded licensed Noto Devanagari font. Authored text is preserved, not translated. Signed consents retain their recorded language. Logical Unicode is included in tagged PDF `ActualText`; naive PDF text extraction may still return shaped visual glyph order.

## Validation

```powershell
npm run check
```

This performs TypeScript/build, behavioral HTTP API and migration cases, installed-Microsoft-Edge browser cases, then writes `docs\traceability.json`. Coverage generation fails unless **every one of the 87 journeys has substantive browser evidence**, separate from rendering. Browser tests use Playwright's `msedge` channel. Test databases, screenshots and raw evidence stay in the Git-ignored `test-artifacts` directory; shared data is not reset by tests.

The API tests cover **primary substantive behavior for all 87 named journeys**, cross-role handoffs, role denials, invalid transitions, idempotency, conflicts, corrections, payment failures, independent approvals and SQLite restart persistence.

Browser tests **actually operate primary actions/read interactions across all 87 named journeys**, including password/OTP onboarding, cross-role clinical/financial handoffs, the completeness variants, report filters/downloads and offline/reload/replay/conflict/partial-failure recovery. Every evidence row describes the exact interaction and resulting assertion. All 87 surfaces also receive a separate render/overflow check: **a route rendering is not behavioral proof for all of its substeps**.

This is not a claim that every one of the 349 illustrated PRD states, every optional branch, five-lakh-patient scale or a certified accessibility/privacy/financial standard has been reproduced and validated.

## Explicit boundaries and remaining limitations

- **Entirely simulated providers:** ETHER, ABDM/ABHA, SMS, WhatsApp, payments, insurers/schemes, LIS/RIS/PACS, video/telephone and signing. Requests, responses, failed attempts, follow-ups and relevant statuses are real persisted demo records; no external effects occur.
- Dictation and voice search use reviewed transcript simulators. Pen drawing and saved handwriting images work; handwriting-to-text recognition is simulated.
- Technical record keys, developer diagnostics, server validation messages and some explanatory copy remain English. Hindi field/PDF support is not a claim of complete human linguistic review or PDF/UA certification.
- Staff identities can hold several staff roles; clinical/admin identities cannot be blended into them. Authenticator enrollment/recovery codes, allowed-network policies, offline access leases, encryption/key recovery and device-management guarantees are not implemented as production security.
- No clinical drug-interaction knowledge base, diagnosis engine or treatment recommendations. The synthetic allergy/duplicate and sample critical-value guards are test fixtures, not a clinical safety system.
- Camera/scanner/printer hardware and real signatures use explicit upload/PDF/reference boundaries. Browsers cannot guarantee OS screenshot prevention, private gallery behavior, native biometric unlock or remote OS wipe.
- The listed completeness fixes are implemented and covered by dedicated API/browser cases. Other optional branches and all 349 illustrated states are **not** claimed exhaustively verified. The exact required/excluded scope is in `docs\prd-completeness.json`.
- Staff-owned synthetic billing reconciles AD08/SD06 for this demo only. AJ22 staff administration is the SO02 demo assumption. ETHER authority/migration, clinical policy and production rollout remain open; no real records are migrated.

## Code map

| Area | Files |
|---|---|
| Journey/command contracts | `shared\journeys.ts`, `shared\commands.ts`, `shared\model.ts`, `shared\traceability.ts` |
| HTTP, sessions, persistence | `server\app.ts`, `server\auth.ts`, `server\store.ts`, `server\seed.ts` |
| Scoped workflow transactions | `server\engine.ts`, `server\context.ts`, `server\clinical.ts`, `server\admin.ts`, `server\commerce.ts`, `server\care.ts`, `server\services.ts` |
| PDFs and reporting | `server\documents.ts`, `server\reporting.ts` |
| Frontend and local outbox | `src\main.tsx`, `src\pages.tsx`, `src\forms.tsx`, `src\storage.ts`, `src\sw.js`, `src\styles.css` |
| Behavior, browser and migration evidence | `tests\api.test.ts`, `tests\completeness-api.test.ts`, `tests\browser.test.ts`, `tests\completeness-browser.test.ts`, `tests\journey-browser.test.ts`, `tests\migration.test.ts`, `scripts\coverage.ts` |
| Release isolation | `scripts\release.mjs`, `scripts\backup.mjs`, `Start-Candidate.ps1`, `Start-Release.ps1` |

Original PRDs/session archives are read-only source references outside this project. They, their media, actual records and any real credentials were not copied here.
