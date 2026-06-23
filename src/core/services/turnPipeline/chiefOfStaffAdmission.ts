/**
 * Chief-of-Staff turn-admission gate (260622 Stage 3).
 *
 * The user's Chief-of-Staff README is the bedrock of the system prompt. If Rebel
 * can't read it on a USER-INITIATED DESKTOP INTERACTIVE turn, it must NOT silently
 * run on the template (the old behaviour) — that's a fatally-blocking error the
 * user can act on (reconnect a drive, recreate from template). This module bounds
 * that read via the killable {@link readSpaceReadmeBounded} pool and maps the
 * distinguished outcome to an admission verdict.
 *
 * --- Desktop user-initiated only, by deliberate cross-surface design (DA-F3 / GPT-F1) ---
 * The gate ONLY blocks on a user-initiated desktop interactive turn. The CALLER
 * (`turnAdmission.admit`) decides that via `getPlatformConfig().surface === 'desktop'`
 * AND an interactivity predicate (manual/interactive policy, conversation session
 * kind, not a system continuation / non-interactive turn) — NOT via window presence
 * (`win` is non-null on cloud's virtual window and on desktop background turns, so
 * it is a leaky gate; see Decision Log 2026-06-22 14:10). Cloud / mobile / headless
 * and desktop background/proactive/system turns run the same pipeline but the no-op
 * cloud fs executor returns `reconnecting` for EVERY cloud read — blocking there
 * would be a FLEET OUTAGE, and there is no user at a drive to reconnect. Those turns
 * ADMIT and emit a structured WARN (observable, never silent). This module computes
 * the verdict only for the turns the caller admits to the gate.
 *
 * Pure `@core` (Node `path` + `workspaceFs` + `readSpaceReadmeBounded`, no `electron`).
 */
import path from 'node:path';
import type { AppSettings } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { workspaceFs, cloudLaneOptionForPath } from '@core/services/boundedWorkspaceFs';
import {
  readSpaceReadmeBounded,
  type SpaceReadmeOutcome,
} from '@core/services/boundedSpaceReadmeReader';

const log = createScopedLogger({ service: 'chiefOfStaffAdmission' });

/**
 * Cloud-lane budget for the admission CoS read (ms). The turn is latency-critical:
 * a dead Drive must degrade to a block FAST rather than stall admission. The
 * killable executor reclaims the wedged child at its own internal timeout
 * independent of this; local reads ignore it.
 */
export const CHIEF_OF_STAFF_ADMISSION_TIMEOUT_MS = 3_000;

/** The cause of a `chief-of-staff-unavailable` block. */
export type ChiefOfStaffUnavailableReason = 'reconnecting' | 'unreadable' | 'missing-after-setup';

/**
 * The admission verdict for the Chief-of-Staff read.
 *  - `admit` — the turn proceeds. When `content` is present (an `ok` read), it is
 *    threaded forward so `resolveSystemPrompt` does NOT re-read (F2 convergence).
 *  - `block` — terminal admission block; `reason` is the cause carried onto the
 *    dispatched `chief-of-staff-unavailable` error event.
 */
export type ChiefOfStaffAdmissionVerdict =
  | { readonly decision: 'admit'; readonly content?: string; readonly outcome: SpaceReadmeOutcome['status'] }
  | { readonly decision: 'block'; readonly reason: ChiefOfStaffUnavailableReason };

/** Whether `settings.spaces` carries a Chief-of-Staff entry (its on-disk name). */
function findCosSpace(settings: AppSettings): { path: string } | undefined {
  return settings.spaces?.find(
    (s) => s.type === 'chief-of-staff' || s.path.toLowerCase().replace(/\/$/, '') === 'chief-of-staff',
  );
}

/**
 * The canonical Chief-of-Staff directory join for a workspace root (the default
 * casing). Pure string derivation; no I/O.
 */
function canonicalCosDir(baseDir: string): string {
  return path.join(baseDir, 'Chief-of-Staff');
}

/**
 * A resolved Chief-of-Staff directory plus the evidence the subsequent README read
 * needs to pick a hang-safe lane.
 *
 *  - `forceCloud` — TRUE when the dir was discovered by the bounded workspace-root
 *    SCAN (i.e. OUTSIDE the containment map's knowledge) AND the discovered dirent is
 *    a SYMLINK. Containment is built from `settings.spaces`; a `chief-of-staff`
 *    symlink that dropped out of `settings.spaces` (the real dead-Drive case) is NOT
 *    in that map and its workspace path is pattern-LOCAL, so `readSpaceReadmeBounded`
 *    would otherwise classify the README read as LOCAL → bare `fs.readFile` → HANG on
 *    the dead cloud symlink target. We carry the scan-discovered-symlink evidence
 *    forward so the read is FORCED through the killable cloud lane (rd4 review F1).
 */
interface ResolvedChiefOfStaffDir {
  readonly dir: string;
  readonly forceCloud: boolean;
}

/**
 * Synchronous, no-I/O derivation of the Chief-of-Staff directory from settings:
 * prefer the on-disk name recorded in `settings.spaces` (case-exact), else fall
 * back to the canonical `Chief-of-Staff` join. Returns `null` without a core
 * directory.
 *
 * NOTE: the static-join fallback can MISS a case-mismatched on-disk dir on a
 * case-sensitive filesystem (e.g. a lowercase `chief-of-staff/` with no
 * `settings.spaces` entry). {@link resolveChiefOfStaffDirBounded} closes that gap
 * with a hang-bounded disk scan; this sync form is kept for callers/tests that
 * only need the settings-derived path and for the fast path when a spaces entry
 * is present.
 */
export function resolveChiefOfStaffDir(settings: AppSettings): string | null {
  const baseDir = settings.coreDirectory;
  if (!baseDir) return null;
  const cosSpace = findCosSpace(settings);
  return cosSpace
    ? path.join(baseDir, cosSpace.path.replace(/\/$/, ''))
    : canonicalCosDir(baseDir);
}

/**
 * Resolve the Chief-of-Staff directory the SAME robust way `resolveSystemPrompt`
 * does (mcpService `findChiefOfStaffDir`): prefer the `settings.spaces` CoS entry
 * (case-exact), else fall back to a BOUNDED case-insensitive disk scan of the
 * workspace root for a `chief-of-staff` directory/symlink (handles a lowercased
 * dir on a case-sensitive FS that has no settings entry — e.g. a dead-mount space
 * that dropped out of `settings.spaces`). Only when the scan finds nothing do we
 * fall back to the canonical join.
 *
 * The scan is hang-bounded BY CONSTRUCTION: it goes through the killable
 * `workspaceFs.readdirWithFileTypes` boundary (cloud root → killable child pool;
 * local root → bare-fs fast path). A `reconnecting` or `error` readdir falls back
 * to the canonical join — the subsequent {@link readSpaceReadmeBounded} read at
 * that path then classifies the cause (`reconnecting` / `absent`) for the verdict.
 * Pure `@core`, never throws, never hangs.
 *
 * When the scan discovers a `chief-of-staff` SYMLINK (the real dead-Drive case — a
 * dead mount drops the CoS entry from `settings.spaces`, leaving only a lowercased
 * symlink on disk that containment never learned about), the returned
 * {@link ResolvedChiefOfStaffDir.forceCloud} is TRUE so the README read is forced
 * through the killable cloud lane instead of being mis-classified LOCAL (rd4 F1).
 */
export async function resolveChiefOfStaffDirBounded(
  settings: AppSettings,
  timeoutMs?: number,
): Promise<ResolvedChiefOfStaffDir | null> {
  const baseDir = settings.coreDirectory;
  if (!baseDir) return null;

  const cosSpace = findCosSpace(settings);
  if (cosSpace) {
    // From settings.spaces — a cloud symlink space is already in the containment map
    // (built from settings.spaces), so the README read classifies cloud correctly.
    return { dir: path.join(baseDir, cosSpace.path.replace(/\/$/, '')), forceCloud: false };
  }

  // No settings entry — scan the workspace root for a case-mismatched dir,
  // mirroring mcpService.findChiefOfStaffDir but through the killable boundary.
  const options =
    timeoutMs !== undefined
      ? { ...cloudLaneOptionForPath(baseDir), timeoutMs }
      : cloudLaneOptionForPath(baseDir);
  const outcome = await workspaceFs.readdirWithFileTypes(baseDir, options);
  if (outcome.status === 'ok') {
    for (const entry of outcome.value) {
      if (
        (entry.isDirectory || entry.isSymbolicLink) &&
        entry.name.toLowerCase() === 'chief-of-staff'
      ) {
        // A scan-discovered SYMLINK is the dead-Drive hang vector: containment
        // (built from settings.spaces) doesn't know about it, and its workspace
        // path is pattern-LOCAL, so the README read would otherwise take the LOCAL
        // bare-fs lane and HANG on a dead cloud target. Force the killable cloud
        // lane for it (rd4 F1). A real directory entry stays on the local fast path.
        return { dir: path.join(baseDir, entry.name), forceCloud: entry.isSymbolicLink };
      }
    }
  } else if (outcome.status === 'reconnecting') {
    // Dead/slow cloud root — don't treat as absence. Fall back to the canonical
    // join; the README read there will resolve to `reconnecting` and block.
    log.warn('workspace-root scan for Chief-of-Staff is reconnecting; using canonical join');
  }
  return { dir: canonicalCosDir(baseDir), forceCloud: false };
}

/**
 * The set-once durable "user finished onboarding" signal. We gate the
 * `absent → block` decision on this (NOT the resettable `onboardingCompleted`,
 * NOT the disk-derived `settings.spaces` CoS entry which drops on a dead mount).
 */
function hasCompletedOnboarding(settings: AppSettings): boolean {
  return settings.onboardingFirstCompletedAt != null;
}

/**
 * Evaluate the Chief-of-Staff admission gate. The caller (`turnAdmission.admit`)
 * guarantees this is only reached for a USER-INITIATED DESKTOP INTERACTIVE turn
 * (surface + interactivity predicate — see Decision Log 2026-06-22 14:10, and the
 * module header for why window presence is NOT the gate). Returns the verdict;
 * never throws, never hangs (both the dir scan and the README read are bounded).
 *
 * The CoS directory is resolved the SAME robust way `resolveSystemPrompt` does
 * (settings entry → bounded case-insensitive disk scan → canonical join) so a
 * genuinely-missing post-onboarding CoS BLOCKS while a lowercased on-disk dir that
 * dropped out of `settings.spaces` still RESOLVES and reads (no false block).
 *
 * Branch table (PLAN Stage 3):
 *  - `ok`                 → admit (+ content forward, F2).
 *  - `reconnecting`       → block `reconnecting` (STRICTLY outranks the onboarding
 *                           gate — a live-but-unreachable CoS is never `missing`).
 *  - `unreadable`         → block `unreadable`.
 *  - `absent` + onboarded → block `missing-after-setup` (genuinely missing after
 *                           setup, even with no `settings.spaces` entry — the
 *                           bounded disk scan already had its chance to find a
 *                           case-mismatched dir, so absence here is real).
 *  - `absent` + NOT onboarded → admit (legit first-run; template path unchanged).
 */
export async function evaluateChiefOfStaffAdmission(
  settings: AppSettings,
): Promise<ChiefOfStaffAdmissionVerdict> {
  const resolved = await resolveChiefOfStaffDirBounded(
    settings,
    CHIEF_OF_STAFF_ADMISSION_TIMEOUT_MS,
  );
  if (!resolved) {
    // No core directory — the missing-core-directory precondition (a sibling gate)
    // already terminalizes this; treat as admit here so we never double-block.
    return { decision: 'admit', outcome: 'absent' };
  }

  const outcome = await readSpaceReadmeBounded(resolved.dir, {
    timeoutMs: CHIEF_OF_STAFF_ADMISSION_TIMEOUT_MS,
    // A scan-discovered CoS symlink (dead-Drive case) is outside the containment
    // map and pattern-LOCAL → force the killable cloud lane so a dead target
    // resolves `reconnecting` (→ block) instead of hanging on bare fs (rd4 F1).
    forceCloud: resolved.forceCloud,
  });

  switch (outcome.status) {
    case 'ok':
      return { decision: 'admit', content: outcome.content, outcome: 'ok' };
    case 'reconnecting':
      // Outranks the onboarding gate by construction: a reconnecting outcome is
      // returned BEFORE we ever consult onboarding state.
      return { decision: 'block', reason: 'reconnecting' };
    case 'unreadable':
      return { decision: 'block', reason: 'unreadable' };
    case 'absent':
      // Genuinely absent at the resolved dir. The bounded disk scan in
      // `resolveChiefOfStaffDirBounded` already had its chance to find a
      // case-mismatched on-disk dir, so a post-onboarding absence here is REAL —
      // block (don't silently degrade to the template). NOT-onboarded absence is
      // a legit first-run → admit (template path unchanged).
      return hasCompletedOnboarding(settings)
        ? { decision: 'block', reason: 'missing-after-setup' }
        : { decision: 'admit', outcome: 'absent' };
    default: {
      const _exhaustive: never = outcome;
      void _exhaustive;
      return { decision: 'admit', outcome: 'absent' };
    }
  }
}

/** Calm, on-brand block copy per reason (Stage 4 refines actions/resolution). */
export function chiefOfStaffBlockCopy(reason: ChiefOfStaffUnavailableReason): string {
  switch (reason) {
    case 'reconnecting':
      return "Reconnecting to your drive — Rebel can't reach your Chief-of-Staff instructions right now. Your message is safe.";
    case 'unreadable':
      return "Rebel can't read your Chief-of-Staff instructions. Your message is safe.";
    case 'missing-after-setup':
      return 'Your Chief-of-Staff instructions are missing. Recreate them from the template to continue. Your message is safe.';
    default: {
      const _exhaustive: never = reason;
      void _exhaustive;
      return "Rebel can't read your Chief-of-Staff instructions.";
    }
  }
}
