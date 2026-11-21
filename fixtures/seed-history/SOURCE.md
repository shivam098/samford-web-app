# Seeded handwritten history fixtures

Synthetic `samford-ink/1` fixtures for the two seeded returning-patient visits (patient-a on 2026-11-07 and patient-b on 2026-10-22, both authored by the synthetic persona doctor-c). patient-b's prescription also has a signed addendum (version 2, 10:40 IST: "Corrected dose and duration (synthetic sample)"; page 1 is the unchanged version-1 page, page 2 is new). Every page carries a visible "SYNTHETIC SAMPLE - not for clinical use" banner. No real patient data.

- Produced by the Samford doctor tablet app: https://github.com/shivam098/samford-doctor-android/tree/ee125dd228944f2ff912cac52b0c06d673bfa78c/fixtures/seed-history (the version-1 blobs are byte-identical to the earlier 2cbc7a5 set).
- Regenerate there with `SAMFORD_IT_API_BASE=<isolated backend base URL> SAMFORD_SEED_OUT=<dir> ./gradlew :app:testDebugUnitTest --tests "com.samford.doctor.integration.BackendIntegrationTest.generateSeedFixtures"`.
- `blobs/<sha256>.png|.pdf|.json` are content-addressed; the server verifies every hash and structure before seeding. If this folder is missing or invalid, the server falls back to procedurally generated placeholder pages and records that in the migration audit.
- Set `SAMFORD_FIXTURE_DIR` to load fixtures from another folder. Releases copy this folder next to `server.mjs`.
