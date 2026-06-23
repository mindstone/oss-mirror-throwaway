---
description: "How Rebel migrates a user's full setup from one computer to another — the export/import bundle, the classification SSOT, the safety model, and what deliberately does not transfer."
last_updated: "2026-06-10"
---

# Migrating Rebel Between Machines

How a user moves their entire Rebel setup (conversations, settings, memories, automations, inbox, spaces) from one computer to another via a portable **transfer file** (`.rebeltransfer`). This is the **assisted** path; the manual copy procedure still exists as a fallback (`rebel-system/help-for-humans/moving-rebel-to-a-new-computer.md`).

## See also

- [ELECTRON_STORAGE_REFERENCE](./ELECTRON_STORAGE_REFERENCE.md) — what lives in `userData` (human companion to the classification SSOT below)
- [SPACES](./SPACES.md) — the workspace/space model (drives the pointer-only-vs-copy decision for cloud-backed spaces)
- `docs/plans/260609_migrate-rebel-between-machines/PLAN.md` — full design history, the cross-family review record, and Amendments A1–A13 (the *why* behind each safety decision)
- `rebel-system/help-for-humans/moving-rebel-to-a-new-computer.md` — the user-facing guide
- [MOVING_REBEL_BETWEEN_COMPUTERS](./MOVING_REBEL_BETWEEN_COMPUTERS.md) — the manual file-copy fallback (dev guide), for cases the assisted flow doesn't cover

## Intent & the core safety bar

Users replacing a computer want their Rebel to come with them without a fragile manual file-copy. The **overriding constraint** (stated repeatedly by the product owner): migration must **never put an existing/live Rebel installation at risk**. Two design rules fall out of that and are enforced by construction:

1. **Export is read-only on the source.** It only ever `lstat`/`reads` the source `userData`; all writes go to the bundle. (Proven by a before/after byte+mtime test.)
2. **Import never mutates a live install.** It stages into a sibling dir, validates, and **publishes only onto a *fresh* profile via a same-volume rename — always moving any pre-existing profile aside to a recoverable backup, never deleting.** A refused import is proven to leave the target byte-identical.

`re-auth is accepted for v1`: connectors, AI provider keys, and cloud pairing do **not** travel (they're OS-keychain-bound and/or sensitive). The new machine surfaces a "Finish settling in" checklist. This is deliberate, not a gap.

## Architecture

The migration code is platform-agnostic core (`src/core/services/migration/`) called from the desktop main process via IPC. Key pieces:

- **`migrationClassification.ts` — the SSOT.** Every persistent `userData` store/path carries exactly one verdict: `copy | exclude-derived | exclude-keychain | exclude-cloud | exclude-transient | special`. A CI gate (`scripts/check-migration-classification.ts`, wired into `validate:fast`) fails if any `ALL_STORE_VERSIONS` key or live `createStore({name})` call-site is unclassified — so a future store **cannot silently leak or be lost**. This is the kill-by-construction backbone.
- **`migrationPolicy.ts` — shared export/import policy.** Derives copy-roots + exclusions from the SSOT. **Both export and import consume it**, so import can't drift from export's exclusions (the symmetry that closes the tampered-bundle hole — see below).
- **`migrationManifest.ts` — the bundle contract** (Zod). Strict schema; relative-path entries reject absolute/`..`/Windows-drive paths at parse.
- **`appSettingsMigrationSanitizer.ts` — field-level secret allowlist.** Produces a migration-safe `app-settings.json` keeping only non-secret preference keys; a `stripSecretsInPlace` backstop guarantees no secret-named field survives even as `AppSettings` grows. Records dropped fields → the re-auth checklist.
- **`migrationExportService.ts` + `safeSnapshotCopy.ts`** — read-only snapshot/hash/atomic-copy; classifies each space via `detectCloudStorage` on the **resolved physical path** (`cloudStorageUtils.ts`) and copies workspace bytes **only for `internal-local` spaces** (cloud-backed/Drive spaces are pointer-only — avoids the REBEL-62A duplicate-files hazard).
- **`migrationImportService.ts`** — untrusted-bundle validation (zip-slip, NTFS-ADS, reserved names, case-fold, size/count caps, checksums, epoch compat) **plus import-side SSOT-policy enforcement** (rejects any entry outside the allowed set even with valid checksums), staging, path repair, and the `adoptPreparedMigrationImportSync` publish/rollback.
- **`src/main/startup/ensureMigrationImport.ts`** — boot-time adoption. Mirrors `ensureDemoModeUserData.ts`: a flag in `os.tmpdir()` (read before stores construct) points at the staged dir; adoption runs **last** in the bootstrap import block so it reads the *final* userData path (the staging-must-be-sibling guard then refuses a stray flag under demo/test instead of touching the real profile).
- **`migrationObservability.ts`** — PII-redacted Sentry breadcrumbs + scoped captures (synthetic-error so raw path-bearing messages never leak) + support-log artifacts for remote debugging.
- **UX:** onboarding branch (`src/renderer/features/onboarding/steps/MigrationImportStep.tsx`), Settings export (`src/renderer/features/settings/components/MigrationTransferSection.tsx`), post-restart checklist (`src/renderer/features/migration/MigrationReAuthChecklist.tsx`). IPC: `src/shared/ipc/channels/migration.ts` + `src/main/ipc/migrationHandlers.ts`.

## The tampered-bundle threat (why import enforces the SSOT)

A `.rebeltransfer` is untrusted (the user carries it between machines; it could be modified). Export excluding secrets is necessary but **not sufficient** — a hand-crafted bundle with valid checksums could otherwise smuggle `auth-tokens.json` / `mcp/super-mcp-router.json` / `cloud-service-client-id.json` into staging, and boot adoption would make staging live. Import therefore re-derives the allowed set from `migrationPolicy.ts` and rejects anything outside it (`entry-not-in-import-policy`), and the IPC handler bounds the zip before extraction. Symmetric enforcement, shared source.

## Deliberately out of scope (v1)

- **Cloud-token → OS keychain move** — spun out (orthogonal cloud-pairing refactor; v1 is already safe because the token store is `exclude-keychain` and `cloudInstance` is stripped). See PLAN.md Decision Log.
- **Pointer-only space reconnect affordance (F5)** — minor UX follow-up: surface "reconnect these spaces" when a cloud/external space can't be auto-rebound.
- **Provider keys / connectors transfer** — intentionally re-auth (see Intent).
