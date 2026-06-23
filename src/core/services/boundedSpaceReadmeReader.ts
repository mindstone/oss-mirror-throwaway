/**
 * boundedSpaceReadmeReader — a hang-bounded, DISTINGUISHED-outcome reader for a
 * space's README.md (with legacy AGENTS.md fallback), routed through the ONE
 * classified workspace-fs boundary (`boundedWorkspaceFs` / `workspaceFs`).
 *
 * --- Why this exists ---
 * `mcpService.ts`'s MA1 `readSpaceReadmeTextBounded` bounds the SAME read, but with
 * `runWithTimeout` — which ABANDONS (parks) a libuv worker per timed-out read on a
 * dead cloud FUSE mount. The killable `workspaceFs` pool RECLAIMS the wedged worker
 * by killing the child, so it is the right bounder once retry is in scope (PLAN.md
 * Stage 1; converge OFF `runWithTimeout` for the turn path). This reader returns a
 * DISCRIMINATED {@link SpaceReadmeOutcome} so a caller (the Stage-3 turn-admission
 * gate) can act on the CAUSE — distinguish a dead/slow mount (`reconnecting`) from a
 * present-but-unreadable file (`unreadable`) from a genuinely-absent one (`absent`).
 *
 * --- README → legacy fallback (preserved from MA1) ---
 * README is preferred; the legacy `AGENTS.md` is tried ONLY when the README is
 * genuinely ABSENT (ENOENT/ENOTDIR). It is NEVER tried on `unreadable` (the old
 * outer-catch returned null for a present-but-unreadable README — GPT F2) nor on
 * `reconnecting` (a second read would queue/park ANOTHER cloud op on the same dead
 * mount — GPT F5). The whole read aborts at the first non-absent outcome.
 *
 * --- The `absent` vs `unreadable` distinction comes from the boundary ---
 * `WorkspaceFsOutcome`'s `error` variant carries `error: NodeJS.ErrnoException`, so
 * `error.code` lets us split ENOENT/ENOTDIR (`absent`) from everything else
 * (`unreadable`). No contract addition was needed (PLAN Stage-1 "CRITICAL" check).
 *
 * Pure `@core` (Node `path` + `workspaceFs`, no `electron`), so the Stage-3
 * `turnAdmission` gate (also `@core`) can reuse it.
 */
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import {
  cloudLaneOptionForPath,
  workspaceFs,
  type WorkspaceFsOptions,
} from '@core/services/boundedWorkspaceFs';

const log = createScopedLogger({ service: 'boundedSpaceReadmeReader' });

/**
 * The distinguished outcome of a bounded space-README read.
 *  - `ok`           — content read; `source` says which file (`readme` | `legacy`).
 *  - `reconnecting` — a CLOUD read exceeded its budget or no executor is wired (dead/
 *                     slow mount). The file is PRESUMED present; the caller must NOT
 *                     treat it as absence (never recreate-from-template), and must NOT
 *                     issue a second read (parks/queues another cloud op).
 *  - `unreadable`   — the file exists but a non-absence fs error blocked the read
 *                     (EACCES/EISDIR/corrupt). Legacy fallback is NOT tried.
 *  - `absent`       — neither README nor (on a genuinely-absent README) legacy exists
 *                     (ENOENT/ENOTDIR).
 */
export type SpaceReadmeOutcome =
  | { readonly status: 'ok'; readonly content: string; readonly source: 'readme' | 'legacy' }
  | { readonly status: 'reconnecting' }
  | { readonly status: 'unreadable' }
  | { readonly status: 'absent' };

/** Result of ONE bounded file read attempt (before fallback composition). */
type SingleReadOutcome =
  | { readonly kind: 'content'; readonly value: string }
  | { readonly kind: 'reconnecting' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'absent' };

/** ENOENT/ENOTDIR → genuinely absent; everything else → present-but-unreadable. */
function classifyErrorCode(code: string | undefined): 'absent' | 'unreadable' {
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unreadable';
}

/**
 * Read one file's text through the boundary, mapping the `WorkspaceFsOutcome` to a
 * {@link SingleReadOutcome}. The boundary classifies the path FS-free (containment)
 * and routes a cloud path to the killable pool; `cloudLaneOptionForPath` additionally
 * forces the cloud lane for an explicitly-named cloud-root path OUTSIDE any configured
 * space (e.g. a cloud `coreDirectory`) that containment alone would mis-classify as
 * local (GPT F2 / boundary R-MUST-2). `forceCloud` lets the CALLER force the killable
 * lane when IT holds cloud/symlink evidence the boundary can't derive from the path —
 * specifically a scan-discovered CoS symlink outside the containment map (rd4 F1).
 * Never throws, never hangs.
 */
async function readOneFileBounded(
  filePath: string,
  timeoutMs: number | undefined,
  forceCloud: boolean,
): Promise<SingleReadOutcome> {
  // The caller's `forceCloud` OR the path's own cloud-pattern evidence forces the
  // killable lane (`cloudLaneOptionForPath` returns `{ forceCloud: true }` for a
  // pattern-cloud path; merge so neither source is lost).
  const patternOption = cloudLaneOptionForPath(filePath);
  const options: WorkspaceFsOptions | undefined =
    forceCloud || patternOption || timeoutMs !== undefined
      ? {
          ...patternOption,
          ...(forceCloud ? { forceCloud: true } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        }
      : undefined;
  const outcome = await workspaceFs.readFile(filePath, 'utf8', options);
  if (outcome.status === 'ok') {
    return { kind: 'content', value: outcome.value };
  }
  if (outcome.status === 'reconnecting') {
    return { kind: 'reconnecting' };
  }
  // status === 'error' — split absent vs unreadable from the errno.
  return { kind: classifyErrorCode(outcome.error.code) };
}

export interface ReadSpaceReadmeOptions {
  /**
   * Cloud-lane caller budget (ms). A latency-critical caller (the turn-admission
   * gate) should pass a TIGHT budget (e.g. 3s) so a dead Drive degrades fast instead
   * of stalling the turn; the killable executor still reclaims the wedged child at
   * its own internal timeout independent of this. Ignored on the local lane.
   */
  readonly timeoutMs?: number;
  /**
   * Force the killable CLOUD lane for both the README and the legacy read, even when
   * the boundary's containment + pattern classifiers would say `'local'`. For a caller
   * that holds cloud/symlink evidence the boundary can't derive from the path string —
   * specifically the turn-admission gate's scan-discovered CoS SYMLINK that dropped out
   * of `settings.spaces` (so it is NOT in the containment map) and whose workspace path
   * is pattern-LOCAL. Without this the read takes the bare-fs LOCAL lane and HANGS on a
   * dead cloud symlink target (rd4 review F1). Leave UNSET (`false`) for a provably-local
   * non-symlink CoS so the common case keeps the bare-fs fast path (no pool overhead).
   */
  readonly forceCloud?: boolean;
}

/**
 * Read a space's README.md (or, only when the README is genuinely absent, the legacy
 * AGENTS.md), hang-bounded via the killable `workspaceFs` pool, returning a
 * distinguished {@link SpaceReadmeOutcome}.
 *
 * @param spaceDir absolute path to the space directory.
 */
export async function readSpaceReadmeBounded(
  spaceDir: string,
  options: ReadSpaceReadmeOptions = {},
): Promise<SpaceReadmeOutcome> {
  const readmePath = path.join(spaceDir, 'README.md');
  const legacyPath = path.join(spaceDir, 'AGENTS.md');
  const forceCloud = options.forceCloud === true;

  const readme = await readOneFileBounded(readmePath, options.timeoutMs, forceCloud);
  if (readme.kind === 'content') {
    return { status: 'ok', content: readme.value, source: 'readme' };
  }
  // Only a genuinely-ABSENT README falls through to legacy. A present-but-unreadable
  // README or a reconnecting cloud mount aborts here — never retry legacy (a second
  // read parks/queues another cloud op on the same dead mount — GPT F5).
  if (readme.kind === 'reconnecting') {
    log.warn(
      'space README read is reconnecting (dead/slow cloud mount); not falling back to legacy',
    );
    return { status: 'reconnecting' };
  }
  if (readme.kind === 'unreadable') {
    return { status: 'unreadable' };
  }

  // README genuinely absent → try legacy AGENTS.md (same forced lane).
  const legacy = await readOneFileBounded(legacyPath, options.timeoutMs, forceCloud);
  if (legacy.kind === 'content') {
    return { status: 'ok', content: legacy.value, source: 'legacy' };
  }
  if (legacy.kind === 'reconnecting') {
    log.warn('legacy space AGENTS.md read is reconnecting (dead/slow cloud mount)');
    return { status: 'reconnecting' };
  }
  if (legacy.kind === 'unreadable') {
    return { status: 'unreadable' };
  }
  return { status: 'absent' };
}
