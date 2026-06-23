/**
 * Memory Write Hook
 *
 * PreToolUse hook that intercepts file write operations (Edit, Create) during
 * memory update turns. Shows user the destination and summary before allowing writes.
 *
 * Part of Phase 2: Memory Approval with Destination Visibility
 */

import fs from 'node:fs/promises';
import { realpathSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPlatformConfig } from '@core/platform';
import { getBroadcastService } from '@core/broadcastService';
import { broadcastTypedPayload } from '@shared/ipc/broadcasts';
import { evaluateSafetyPrompt, shouldAllow } from '@core/safetyPromptLogic';
import { resolveFileLocation, FileLocationResolverError } from '@core/services/fileLocation';
import {
  TOOL_SAFETY_EVALUATING_CHANNEL,
  TOOL_SAFETY_EVALUATING_COMPLETE_CHANNEL,
  type ToolSafetyEvaluatingPayload,
  type ToolSafetyEvaluatingCompletePayload,
} from '@shared/ipc/channels/safety';
import { getSafetyPrompt, getSafetyPromptVersion, isMigrationComplete } from '@core/safetyPromptStore';
import type { ActionContext, ActionContextSessionIntent, ActionContextSpaceSharing } from '@core/safetyPromptTypes';
import { addEvaluationEntry } from '@core/safetyActivityLogStore';
import type { HookJSONOutput } from '@core/agentRuntimeTypes';
import type { SafetyLevel } from './types';
import type { AutoApproveReason, SpaceConfig } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import { toPortablePath } from '@core/utils/portablePath';
import { normalizeSafetyPath } from '@core/services/safety/bashTargetSpace';
import { classifyUnmatchedPath as classifyUnmatchedPathShared } from '@core/services/safety/classifyUnmatchedPath';
import { getCurrentUserProvider } from '@core/currentUserProvider';
import type { SpaceInfo as ResolverSpaceInfo } from '@shared/ipc/schemas/library';
import {
  scanSpaces,
  readSpaceReadmeBody,
  readSpaceReadmeFrontmatter,
  getSpaceDisplayName,
  type SpaceInfo,
} from '../spaceService';
import { callBehindTheScenesWithAuth } from '../behindTheScenesClient';
import { getSettings } from '@core/services/settingsStore';
import {
  addPendingMemoryApproval,
  removePendingMemoryApproval,
  getPendingMemoryApprovals,
  type PersistedMemoryApprovalRequest,
} from './pendingApprovalsStore';
import { storeSingleUseApproval, consumeSingleUseApproval } from './sessionApprovals';
import { addApprovedMemoryEntry } from '../memoryHistoryStore';
import { agentTurnRegistry } from '../agentTurnRegistry';
import { getAutomationContext } from './automationContextLookup';
import { sharedSkillMutationService } from '../sharedSkillMutationService';
import { markChiefOfStaffHygieneNeeded } from '@core/services/chiefOfStaffHygieneBackupService';

import { FILE_WRITE_TOOLS, isProtectedSystemPath } from './constants';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import {
  extractBashWriteContent,
  extractBashCopySource,
  extractBashHeredocContent,
  extractBashWriteTargets,
} from './bashContentExtractor';
// Re-export the bash analyzers (extracted to bashContentExtractor) to preserve
// existing import paths for tests and any downstream consumers.
export { extractBashHeredocContent, extractBashWriteTargets } from './bashContentExtractor';
import {
  isVerifiedChiefOfStaff,
  shouldSkipSecretGateForPermissive,
  resolveMemorySafetyLevel,
} from './memorySafetyLevels';
// Re-export the memory safety-level resolvers (extracted to memorySafetyLevels)
// to preserve existing import paths for tests and consumers (e.g.
// transcriptSensitivityGuard) plus their whole-module vi.mock targets.
export {
  isStricter,
  isVerifiedChiefOfStaff,
  shouldSkipSecretGateForPermissive,
  resolveMemorySafetyLevel,
} from './memorySafetyLevels';
import {
  writeToPending,
  getPendingFileByDestination,
  type PendingFile,
  type PendingFileLookupResult,
  type WriteToPendingOptions,
} from './cosPendingService';
import { trackItem } from './automationPendingItemsTracker';
import { containsCredentialPatterns } from '@core/utils/logRedaction';
import type { BlockSource, FileLocation } from '@rebel/shared';
import crypto from 'node:crypto';
import { classifySessionKind } from '@shared/sessionKind';
import { buildEvalErrorAgentReason, buildEvalErrorUserReason } from '@shared/safety/evalErrorCopy';

const log = createScopedLogger({ service: 'memoryWriteHook' });
const getCurrentUserSnapshot = () => getCurrentUserProvider().getCurrentUser();

type LegacyPendingLookupResult = { file: PendingFile; content: string } | null | undefined;

function normalizePendingLookupResult(
  result: PendingFileLookupResult | LegacyPendingLookupResult,
): PendingFileLookupResult {
  if (!result) {
    return { kind: 'none' };
  }

  if ('kind' in result) {
    return result;
  }

  if ('file' in result) {
    const legacyContent = typeof (result as { content?: unknown }).content === 'string'
      ? (result as { content: string }).content
      : '';
    return {
      kind: 'found',
      file: result.file,
      content: legacyContent,
    };
  }

  return { kind: 'none' };
}

/**
 * Automation ID for the source-capture system automation.
 *
 * Source capture is a security boundary: writes MUST go to Chief-of-Staff only
 * (Plan `docs/plans/260418_source_capture_chief_of_staff_only.md`, Phase A3).
 * Kept in sync with automationScheduler.ts::SOURCE_CAPTURE_AUTOMATION_ID.
 */
const SOURCE_CAPTURE_AUTOMATION_ID = 'system-source-capture';

function buildEvalErrorMemoryDenyOutput(): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: buildEvalErrorUserReason(),
    },
  };
}

function buildMemoryEvalErrorCoalesceKey(spaceName: string, filePath: string): string {
  return `eval_error:${spaceName}:${toPortablePath(filePath).toLowerCase()}`;
}

// Metadata for pending approvals (non-blocking pattern)
// Key: toolUseId, Value: metadata needed for retry
const pendingApprovalMetadata = new Map<string, {
  turnId: string;
  sessionId: string;
  originalSessionId: string;
  filePath: string;
  spaceName: string;
  approvalIdentifier: string;
}>();

type CliMemoryApprovalRoutingResult = {
  approved: boolean;
  output: HookJSONOutput;
};

async function routeMemoryApprovalHandler(params: {
  turnId: string;
  target: string;
  summary: string;
  signal: AbortSignal;
}): Promise<CliMemoryApprovalRoutingResult | null> {
  const approvalHandler = typeof agentTurnRegistry.getApprovalHandler === 'function'
    ? agentTurnRegistry.getApprovalHandler(params.turnId)
    : undefined;
  if (!approvalHandler) return null;

  let decision: { approved: boolean; reason?: string };
  try {
    decision = await approvalHandler(
      { kind: 'memory_write', target: params.target, summary: params.summary },
      params.signal,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn(
      { turnId: params.turnId, target: params.target, err: errMsg },
      'Memory write approval handler threw; failing closed (deny)',
    );
    agentTurnRegistry.recordSecurityDenial(params.turnId, 'memory_write', `approval_handler_error: ${errMsg}`);
    return {
      approved: false,
      output: {
        continue: false,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: `Approval handler error: ${errMsg}`,
        },
      },
    };
  }
  if (decision.approved) {
    log.info({ turnId: params.turnId, target: params.target }, 'Memory write approved in-place by headless approval handler');
    return { approved: true, output: {} };
  }

  const denyReason = decision.reason ?? 'denied';
  log.info(
    { turnId: params.turnId, target: params.target, reason: denyReason },
    'Memory write denied by headless approval handler',
  );
  agentTurnRegistry.recordSecurityDenial(params.turnId, 'memory_write', denyReason);
  return {
    approved: false,
    output: {
      continue: false,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: denyReason,
      },
    },
  };
}

/**
 * Broadcast helpers for safety-eval progress on memory-write paths. Mirror
 * the pattern used in toolSafetyService so cloud/mobile renderers attached to
 * a session can clear the "Checking this is safe…" subline regardless of
 * which evaluator layer (tool safety vs memory write) actually ran the LLM.
 */
function broadcastMemorySafetyEvaluating(payload: ToolSafetyEvaluatingPayload): void {
  try {
    getBroadcastService().sendToAllWindows(TOOL_SAFETY_EVALUATING_CHANNEL, payload);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), toolUseId: payload.toolUseId }, 'Failed to broadcast tool-safety:evaluating (memory)');
  }
}

function broadcastMemorySafetyEvaluatingComplete(payload: ToolSafetyEvaluatingCompletePayload): void {
  try {
    getBroadcastService().sendToAllWindows(TOOL_SAFETY_EVALUATING_COMPLETE_CHANNEL, payload);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), toolUseId: payload.toolUseId }, 'Failed to broadcast tool-safety:evaluating-complete (memory)');
  }
}

// ── Plugin source-file detector ─────────────────────────────────────────
//
// Matches paths like `<anything>/plugins/<plugin-id>/index.tsx` where a sibling
// `manifest.json` exists. Returns the plugin id, or null. The manifest.json
// sibling check distinguishes a real installed plugin (which must be updated
// via rebel_plugins_create) from any user folder that happens to contain a
// `plugins/` subdirectory with an `index.tsx`. See
// docs/plans/260527_plugin_agent_experience_overhaul.md — Stage 1.
//
// Plugin-id pattern intentionally mirrors the bridge's PLUGIN_ID_PATTERN
// (`^[a-z0-9]+(?:-[a-z0-9]+)*$` — see inboxBridgeStateMachine.ts). Drift would
// allow digit-leading plugin ids (e.g. `2026-dashboard`) to slip past the
// hook while the bridge still accepts them.
const PLUGIN_INDEX_PATTERN = /\/plugins\/([a-z0-9]+(?:-[a-z0-9]+)*)\/index\.tsx$/;

/**
 * Detect whether `filePath` targets a plugin source file that must be updated
 * via the `rebel_plugins_create` MCP tool rather than a direct filesystem write.
 *
 * @returns
 *   - `{ pluginId: string }` if this is a real installed plugin (intercept fires)
 *   - `{ pluginId: null }` if path doesn't look like a plugin source (allow)
 *   - `{ pluginId: null, denyReason: string }` if path looks like a plugin but
 *     the manifest probe failed with an unexpected error — fail closed.
 */
type DetectPluginResult =
  | { pluginId: string; denyReason?: undefined }
  | { pluginId: null; denyReason?: string };

async function detectPluginSourceFile(
  filePath: string,
  coreDirectory: string,
): Promise<DetectPluginResult> {
  // normalizeSafetyPath collapses `.`/`..`/`//` BEFORE the regex match so a raw
  // write target like `…/plugins/demo/../demo/index.tsx` (bash extraction returns
  // it un-normalized) cannot evade the plugin-source intercept. toPortablePath
  // alone only swaps separators — it does NOT collapse segments, which let the
  // path slip past PLUGIN_INDEX_PATTERN while still resolving into a plugin dir.
  const normalized = normalizeSafetyPath(filePath);
  const match = normalized.match(PLUGIN_INDEX_PATTERN);
  if (!match) return { pluginId: null };
  const pluginId = match[1];

  // Resolve relative paths against coreDirectory before probing the manifest.
  // The hook accepts both relative (`work/foo/plugins/<id>/index.tsx`) and
  // absolute paths; without this, relative paths would silently fall through.
  const absoluteFilePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(coreDirectory, filePath);
  const manifestPath = path.join(path.dirname(absoluteFilePath), 'manifest.json');

  try {
    await fs.access(manifestPath);
    return { pluginId };
  } catch (error) {
    // ENOENT (manifest missing) → path looks like a plugin but isn't a real
    // installed plugin. Allow normal flow.
    //
    // Anything else (permission denied, transient I/O, etc.) → fail closed.
    // We can't safely conclude this is not a plugin, and the agent should be
    // told why rather than have the write silently succeed under conditions
    // where the guardrail can't run.
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      ignoreBestEffortCleanup(error, {
        operation: 'memoryWriteHook.detectPluginSourceFile',
        reason: 'Plugin manifest.json absent — treat path as non-plugin and allow normal write path.',
      });
      return { pluginId: null };
    }
    log.warn(
      { event: 'PLUGIN_MANIFEST_PROBE_ERROR', filePath: absoluteFilePath, manifestPath, errno: code, err: error },
      '[AUDIT] Plugin manifest probe failed with unexpected error — failing closed',
    );
    return {
      pluginId: null,
      denyReason:
        `Could not verify whether this is a plugin source file (manifest probe failed: ${code ?? 'unknown'}). ` +
        `Refusing the write to avoid bypassing plugin validation. If this is legitimately not a plugin, ` +
        `retry once the underlying filesystem issue is resolved; if it is a plugin, update it via rebel_plugins_create instead.`,
    };
  }
}

// ── Checkpoint Lock State (Layers 1 + 3) ────────────────────────────────
//
// When a shared skill checkpoint denies a write, the file path is recorded here.
// Layer 1 (PreToolUse): Bash commands referencing a locked path are denied.
// Layer 3 (PostToolUse): Locked files are hash-verified after every tool execution.
// Keyed by turnId to prevent cross-turn leakage.

interface CheckpointLockEntry {
  lockedPaths: Set<string>;
  fileHashes: Map<string, string>;
}
const checkpointLockedState = new Map<string, CheckpointLockEntry>();

function getOrCreateCheckpointEntry(turnId: string): CheckpointLockEntry {
  let entry = checkpointLockedState.get(turnId);
  if (!entry) {
    entry = { lockedPaths: new Set(), fileHashes: new Map() };
    checkpointLockedState.set(turnId, entry);
  }
  return entry;
}

async function lockPathForCheckpoint(turnId: string, filePath: string, coreDirectory: string): Promise<void> {
  const entry = getOrCreateCheckpointEntry(turnId);
  // normalizeSafetyPath collapses `.`/`..`/`//` and strips trailing `/` so the
  // stored locked path is canonical — a later Bash command spelling the same path
  // with a `/./` cannot dodge the substring/target match in
  // bashCommandTargetsLockedPath. (Previously toPortablePath only swapped
  // separators, leaving `.`/`..`/`//` evadable.) An absolute leading `/` is
  // preserved, so createCheckpointIntegrityHook's path.isAbsolute/path.resolve
  // reuse of this key is unaffected.
  const normalizedPath = normalizeSafetyPath(filePath).toLowerCase();
  entry.lockedPaths.add(normalizedPath);

  try {
    const resolvedPath = (!path.isAbsolute(filePath) && coreDirectory)
      ? path.resolve(coreDirectory, filePath)
      : filePath;
    const content = await fs.readFile(resolvedPath, 'utf-8');
    entry.fileHashes.set(normalizedPath, crypto.createHash('sha256').update(content).digest('hex'));
  } catch {
    entry.fileHashes.set(normalizedPath, '__absent__');
  }

  log.info(
    { event: 'CHECKPOINT_PATH_LOCKED', turnId, filePath: normalizedPath, totalLocked: entry.lockedPaths.size },
    '[AUDIT] File locked by shared skill checkpoint'
  );
}

/**
 * Check if a Bash command references any checkpoint-locked file path.
 *
 * Two layers, both canonicalization-hardened so a `/./`, `//`, `..`-segment or
 * trailing-slash spelling inside the command cannot evade the match (the locked
 * paths are already stored canonical by lockPathForCheckpoint):
 *
 *   1. Path-aware: parse the command's write targets via the shared
 *      `extractBashWriteTargets`, `normalizeSafetyPath` each, and compare against
 *      the (canonical) locked paths — precise, low false-positive.
 *   2. Substring backstop: also scan a `normalizeSafetyPath`-collapsed copy of the
 *      whole command. This retains the heuristic catch for scripting bypasses the
 *      target extractor cannot parse (`python path.write_text()`, perl), while the
 *      collapse closes the lexical-evasion hole the raw scan had.
 *
 * A miss here fails OPEN into the normal approval ladder (isProtectedSystemPath /
 * space-resolution / shared-skill checkpoint still apply) — this is a backstop,
 * not a sole gate.
 */
function bashCommandTargetsLockedPath(
  turnId: string,
  command: string,
): { locked: true; matchedPath: string } | { locked: false } {
  const entry = checkpointLockedState.get(turnId);
  if (!entry || entry.lockedPaths.size === 0) return { locked: false };

  // Layer 1 — path-aware: canonicalize each parsed write target and match.
  const writeTargets = extractBashWriteTargets(command) ?? [];
  const normalizedTargets = writeTargets.map((t) => normalizeSafetyPath(t).toLowerCase());

  // Layer 2 — substring backstop on a collapsed copy of the whole command so a
  // `/./` etc. inside the command can't dodge `.includes`. We lowercase first
  // (matches the stored locked-path casing), strip the common shell-quoting /
  // backslash-escaping spellings of a path (`foo/"skill.md"`, `skill\.md`) that
  // the target extractor doesn't unquote (Codex BLOCKER #2 — partial close for
  // THIS backstop; full shell-tokenization of extractBashWriteTargets is spun
  // out, see PLAN Residual), then collapse segments.
  const dequotedCommand = command
    .toLowerCase()
    .replace(/["']/g, '')      // drop quote chars: foo/"skill.md" -> foo/skill.md
    .replace(/\\(?=\S)/g, ''); // drop backslash-escapes: skill\.md -> skill.md
  const collapsedCommand = normalizeSafetyPath(dequotedCommand);

  for (const lockedPath of entry.lockedPaths) {
    // Path-aware exact/suffix match against parsed targets. (Suffix, not
    // substring: `target.includes(lockedPath)` would over-block `skill.md.bak`
    // and similar — Runtime-Safety NOTE / Codex NOTE.)
    for (const target of normalizedTargets) {
      if (target === lockedPath || target.endsWith('/' + lockedPath)) {
        return { locked: true, matchedPath: lockedPath };
      }
    }

    if (collapsedCommand.includes(lockedPath)) {
      return { locked: true, matchedPath: lockedPath };
    }
    const segments = lockedPath.split('/');
    for (let i = Math.max(0, segments.length - 4); i < segments.length - 1; i++) {
      const partial = segments.slice(i).join('/');
      if (partial.length > 10 && collapsedCommand.includes(partial)) {
        return { locked: true, matchedPath: lockedPath };
      }
    }
  }
  return { locked: false };
}

export function clearCheckpointLockedState(turnId: string): void {
  checkpointLockedState.delete(turnId);
}

/**
 * Release a single file from checkpoint lock.
 * Used when staging fails and we need to undo the lock for one file
 * without clearing locks for other files in the same turn.
 */
function unlockPathForCheckpoint(turnId: string, filePath: string): void {
  const entry = checkpointLockedState.get(turnId);
  if (!entry) return;
  // Must match the canonical form used by lockPathForCheckpoint so unlock removes
  // the same key that lock added.
  const normalizedPath = normalizeSafetyPath(filePath).toLowerCase();
  entry.lockedPaths.delete(normalizedPath);
  entry.fileHashes.delete(normalizedPath);
  log.info(
    { event: 'CHECKPOINT_PATH_UNLOCKED', turnId, filePath: normalizedPath, remainingLocked: entry.lockedPaths.size },
    '[AUDIT] Single file unlocked from checkpoint'
  );
  // Clean up entry if no more locked paths
  if (entry.lockedPaths.size === 0) {
    checkpointLockedState.delete(turnId);
  }
}

/**
 * PostToolUse hook: verify checkpoint-locked files were not modified.
 */
export function createCheckpointIntegrityHook(turnId: string, coreDirectory: string) {
  return async (input: {
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_use_id?: string;
  }): Promise<Record<string, never>> => {
    const entry = checkpointLockedState.get(turnId);
    if (!entry || entry.fileHashes.size === 0) return {};

    for (const [normalizedPath, expectedHash] of entry.fileHashes) {
      try {
        const resolvedPath = path.isAbsolute(normalizedPath)
          ? normalizedPath
          : path.resolve(coreDirectory, normalizedPath);

        let currentHash: string;
        try {
          const content = await fs.readFile(resolvedPath, 'utf-8');
          currentHash = crypto.createHash('sha256').update(content).digest('hex');
        } catch {
          currentHash = '__absent__';
        }

        if (currentHash !== expectedHash) {
          log.warn(
            {
              event: 'CHECKPOINT_INTEGRITY_VIOLATION',
              turnId,
              filePath: normalizedPath,
              toolName: input.tool_name,
              toolUseId: input.tool_use_id,
              expectedHash: expectedHash.slice(0, 8),
              actualHash: currentHash.slice(0, 8),
            },
            '[AUDIT] Checkpoint-locked file was modified — possible shared skill checkpoint bypass'
          );

          getBroadcastService().sendToAllWindows('memory:checkpoint-integrity-violation', {
            filePath: normalizedPath,
            toolName: input.tool_name,
            turnId,
            timestamp: Date.now(),
          });

          entry.fileHashes.set(normalizedPath, currentHash);
        }
      } catch (error) {
        log.debug({ err: error, filePath: normalizedPath }, 'Checkpoint integrity check failed for path');
      }
    }
    return {};
  };
}

const isFileWriteTool = (toolName: string): toolName is typeof FILE_WRITE_TOOLS[number] =>
  FILE_WRITE_TOOLS.includes(toolName as typeof FILE_WRITE_TOOLS[number]);

function getProtectedPathDenyReason(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();

  if (normalizedPath.includes('/.rebel/') || normalizedPath.endsWith('/.rebel')) {
    return `BLOCKED — .rebel is managed by Rebel

The target path "${filePath}" is inside .rebel/, which stores managed collaboration data for shared skills.

Do not edit these files directly. Write to the live skill file instead and Rebel will manage history and notifications for you.`;
  }

  return `BLOCKED — rebel-system is read-only

The target path "${filePath}" is inside rebel-system/, which contains bundled system files and must not be modified.

Save your files to a writable space instead (e.g. Chief-of-Staff/skills/ for custom skills, or the appropriate space for other content).

If you are trying to personalize a built-in skill, use the customise-and-extend-skill workflow (rebel-system/skills/system/customise-and-extend-skill/SKILL.md) to create a layered extension.`;
}

// The env var REBEL_DISABLE_STAGED_WRITES=1 can be used to force the old blocking behavior
// for debugging purposes only.
function isStagedWritesDisabled(): boolean {
  return process.env.REBEL_DISABLE_STAGED_WRITES === '1';
}

// ── stageOrDeny: Unified staging entry point ──────────────────────────
//
// Single entry point for all staging decisions. Internalizes the full
// staging gate (env-var + CoS availability), content extraction, pending
// write, and broadcast. Returns HookJSONOutput with staging message on
// success, or null when staging is impossible (caller falls through to
// blocking denial).
//
// By checking `isStagedWritesDisabled()` + `coreDirectory` internally,
// callers cannot forget the gate check (Failure Mode #6).

interface StageOrDenyParams {
  toolName: string;
  toolInput: Record<string, unknown>;
  filePath: string;
  coreDirectory: string;
  sessionId: string;             // background turn session
  originalSessionId: string;     // main conversation session
  turnId: string;
  spaceName: string;
  blockedBy: BlockSource;
  blockReason: string;
  /** Pre-computed summary — when set, skips the LLM summarizeContent() call.
   *  Used by the secret gate to avoid leaking detected credentials to the LLM. */
  summary?: string;
  /** Pre-computed full content — when set, skips extractFullContent(). */
  content?: string;
  /** Sharing level of the target space at staging time */
  sharing?: 'private' | 'restricted' | 'company-wide' | 'public';
  /** Distinguishes normal memory approvals from shared-skill confirmation checkpoints. */
  approvalKind?: 'memory_write' | 'shared_skill_checkpoint';
  /** For shared_skill_checkpoint: the name of the person who owns/authored the skill. */
  authorLabel?: string;
  /** Stable identifier for dedup between approval events and staged files. */
  toolUseId?: string;
  /** Optional first-wins coalesce key for rate-limited outage staging. */
  coalesceKey?: string;
  /** toolUseId of a previous same-session staged write being superseded. */
  supersededToolUseId?: string;
}

interface StageOrDenyResult {
  output: HookJSONOutput;
  coalesced: boolean;
}

async function stageOrDeny(params: StageOrDenyParams): Promise<StageOrDenyResult | null> {
  const {
    toolName, toolInput, filePath, coreDirectory, originalSessionId,
    blockedBy, spaceName,
  } = params;

  // ── Gate: env-var + CoS availability ──
  if (isStagedWritesDisabled()) {
    log.info({ toolName, filePath }, 'stageOrDeny: staged writes disabled via env var');
    return null;
  }

  if (!coreDirectory) {
    log.info({ toolName, filePath }, 'stageOrDeny: no coreDirectory — staging impossible');
    return null;
  }

  // ── Content: use pre-provided or extract ──
  let content: string | null = params.content ?? null;
  if (content === null) {
    if (typeof toolInput.content === 'string') {
      // Create operation — content is directly available
      content = toolInput.content;
    } else {
      content = await extractFullContent(toolName, toolInput, filePath, coreDirectory, originalSessionId);
    }
  }
  if (content === null) {
    log.info({ toolName, filePath }, 'stageOrDeny: could not extract content — staging impossible');
    return null;
  }

  // ── Summary: use pre-provided or generate via LLM ──
  const summary = params.summary ?? await summarizeContent(content);

  // ── Write to CoS pending ──
  const pendingOptions: WriteToPendingOptions = {
    destinationPath: filePath,
    content,
    sessionId: originalSessionId,
    summary,
    spaceName,
    blockedBy,
    sharing: params.sharing,
    approvalKind: params.approvalKind,
    authorLabel: params.authorLabel,
    toolUseId: params.toolUseId,
    coalesceKey: params.coalesceKey,
  };

  const pendingFile = await writeToPending(pendingOptions);
  if (!pendingFile) {
    log.info({ toolName, filePath }, 'stageOrDeny: writeToPending returned null — staging impossible');
    return null;
  }

  const output: HookJSONOutput = {
    continue: false,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      replaceResult: {
        output: `Content staged for review — awaiting user approval before publishing to "${spaceName}".

You do not need to retry this write. It will be published automatically when the user approves.
Continue with your other work. If you need to read this file, the staged version will be returned.`,
        isError: false,
      },
    },
  };

  if (pendingFile.coalesced) {
    log.info(
      { toolName, filePath, pendingFile: pendingFile.filename, coalesceKey: params.coalesceKey },
      'stageOrDeny: coalesced into existing pending write',
    );
    return { output, coalesced: true };
  }

  // Clean up superseded approval record so the user sees only one approval card
  if (params.supersededToolUseId) {
    removePendingMemoryApproval(params.supersededToolUseId);
    pendingApprovalMetadata.delete(params.supersededToolUseId);
    broadcastTypedPayload(getBroadcastService(), 'memory:write-approval-resolved', {
      toolUseId: params.supersededToolUseId,
      originalSessionId,
      approved: false,
    });
    log.info(
      { supersededToolUseId: params.supersededToolUseId, newToolUseId: params.toolUseId },
      'Cleaned up superseded approval record (same-session replacement)'
    );
  }

  log.info(
    { toolName, filePath, pendingFile: pendingFile.filename },
    'stageOrDeny: staged write to CoS pending'
  );

  // ── Broadcast staging events ──
  const broadcast = getBroadcastService();
  broadcastTypedPayload(broadcast, 'memory:file-staged', {
    id: pendingFile.id,
    realPath: filePath,
    spaceName,
    summary,
    stagedAt: Date.now(),
  });
  broadcast.sendToAllWindows('memory:staged-files-changed');

  // ── Return replaceResult so agent sees a successful tool result ──
  return { output, coalesced: false };
}

/**
 * Classification for files not matched to any space.
 */
type UnmatchedFileClassification = 
  | 'temp'           // OS temp directory
  | 'system'         // rebel-system directory
  | 'inbox'          // Electron userData inbox directory
  | 'mcp_servers'    // ~/mcp-servers/ directory (custom connector builds)
  | 'outside'        // Outside workspace entirely
  | 'workspace_root' // Inside workspace but not in any space
  | 'unknown';       // Fallback

/**
 * Case-fold a path for containment comparison ONLY on case-insensitive
 * filesystems (Windows). On macOS/Linux returns the path unchanged so we do not
 * introduce a case-insensitivity regression in the symlink-realpath comparison.
 *
 * NOTE: the older lexical containment guards in this file `.toLowerCase()`
 * unconditionally (de-facto case-insensitive on every platform). That historical
 * behavior is intentionally left untouched here; this helper governs only the
 * NEW realpath-based second gate (`isPathContainedWithin`).
 */
function caseFoldPath(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Resolve a path through symlinks AS FAR AS IT EXISTS: realpath the nearest
 * existing ancestor, then lexically join the not-yet-created remainder. This is
 * how we handle write targets (and trusted dirs) that don't exist on disk yet —
 * `realpath` of a non-existent leaf throws, so we resolve what exists and append
 * the rest. Returns null only if NO ancestor up to the filesystem root resolves.
 */
function resolveExistingAncestor(inputPath: string): string | null {
  let existing = path.resolve(inputPath);
  const trailing: string[] = [];
  for (let i = 0; i < 4096; i++) {
    try {
      existing = realpathSync(existing);
      return trailing.length > 0 ? path.join(existing, ...trailing) : existing;
    } catch (error) {
      // realpathSync failed for `existing`. Distinguish the SAFE case (the
      // component is genuinely absent — walk up to the nearest existing ancestor)
      // from the DANGEROUS case (the component EXISTS as a symlink whose target
      // can't be resolved — a broken/dangling symlink). A broken symlink leaf
      // under a trusted dir must NOT be treated as a plain not-yet-created file:
      // the eventual write follows the link and lands OUTSIDE the trusted dir.
      // lstat (does not follow the final link) tells us whether `existing` is
      // itself present — if so, realpath only failed because it's an
      // unresolvable symlink, so we FAIL CLOSED (return null → not contained).
      let lexists = false;
      try {
        lstatSync(existing);
        lexists = true;
      } catch (lstatError) {
        ignoreBestEffortCleanup(lstatError, {
          operation: 'resolveExistingAncestor.lstat',
          reason: 'component absent; safe to walk up to nearest existing ancestor',
        });
      }
      if (lexists) {
        // Component exists (e.g. a dangling symlink) but realpath could not
        // resolve it — fail closed rather than lexically rejoin past it.
        ignoreBestEffortCleanup(error, {
          operation: 'resolveExistingAncestor.realpath',
          reason: 'component exists but is an unresolvable symlink; failing closed',
        });
        return null;
      }
      // Genuinely absent component (the common case — write-target leaf not yet
      // created). Step up one segment and retry.
      ignoreBestEffortCleanup(error, {
        operation: 'resolveExistingAncestor.realpath',
        reason: 'path component not yet on disk; walking up to nearest existing ancestor',
      });
      const parent = path.dirname(existing);
      if (parent === existing) return null; // reached root without an existing ancestor
      trailing.unshift(path.basename(existing));
      existing = parent;
    }
  }
  return null;
}

/**
 * Symlink-aware containment check: is `childPath` inside `parentDir` AFTER
 * resolving symlinks?
 *
 * Lexical containment (`startsWith`) is evadable when a directory component of
 * the child is a symlink pointing OUTSIDE the parent (e.g. `<inbox>/escape/x`
 * where `escape` -> `../trusted-tools`). We resolve real paths to close that.
 *
 * Both sides are resolved via `resolveExistingAncestor` so a not-yet-created
 * write target (the common case) AND a not-yet-created trusted dir (fresh
 * install, inbox not provisioned) are handled. When the trusted dir doesn't exist
 * yet there is no symlink to traverse, so the lexically-equal forms still compare
 * equal (no spurious rejection of a legitimate path).
 *
 * Comparison is case-folded ONLY on Windows (see caseFoldPath).
 *
 * Returns `false` (the safe answer) if the child cannot be resolved to an
 * existing ancestor — fail-closed.
 *
 * TOCTOU: this is a point-in-time check. A symlink swapped between this check and
 * the later write is a classic TOCTOU window we cannot close here (the write
 * happens in a separate tool call). The check raises the bar from "trivially
 * lexically evadable" to "requires a live symlink race."
 */
function isPathContainedWithin(childPath: string, parentDir: string): boolean {
  const resolvedChild = resolveExistingAncestor(childPath);
  if (resolvedChild === null) return false;
  // The trusted dir's nearest-existing-ancestor; if it doesn't exist at all, fall
  // back to its lexical absolute form (nothing to traverse).
  const resolvedParent = resolveExistingAncestor(parentDir) ?? path.resolve(parentDir);

  const foldedParent = caseFoldPath(resolvedParent);
  const foldedChild = caseFoldPath(resolvedChild);
  return foldedChild === foldedParent || foldedChild.startsWith(foldedParent + path.sep);
}

/**
 * Classify a file path that couldn't be matched to any space, applying this
 * module's realpath-based symlink containment as the SECOND gate on the
 * auto-approvable branches (temp / inbox / mcp_servers).
 *
 * The precedence ladder itself lives in the shared core implementation
 * (`@core/services/safety/classifyUnmatchedPath`) so the auto-approve decision
 * here and the display-label resolver in `fileLocation.ts` can never drift. We
 * inject {@link isPathContainedWithin} so a symlinked subdir escape — e.g.
 * `<inbox>/escape/x` where `escape` -> `../trusted-tools` — is not classified
 * `inbox` (and therefore not auto-approved) even though it lexically matches.
 */
function classifyUnmatchedPath(
  filePath: string,
  coreDirectory: string
): { classification: UnmatchedFileClassification; displayLabel: string } {
  return classifyUnmatchedPathShared(filePath, coreDirectory, {
    isContained: isPathContainedWithin,
  });
}

/**
 * Dedup file-location warnings per destination path for this process.
 * Stage 2b intentionally keeps this in-perpetuity.
 */
const fileLocationWarned = new Map<string, boolean>();

export interface MemoryWriteApprovalRequest {
  toolUseId: string;
  originalTurnId: string;
  originalSessionId: string; // Main conversation session (for sidebar indicator)
  destination: {
    path: string;
    spaceName: string;
    /** Workspace-relative path (POSIX-normalized for override matching) */
    spacePath: string;
    location?: FileLocation;
    /** Sharing level from frontmatter (undefined = legacy, treat as 'restricted') */
    sharing?: 'private' | 'restricted' | 'company-wide' | 'public';
    isNew: boolean;
  };
  summary: string;
  contentPreview?: string;
  /** Reason for flagging as sensitive (from Haiku evaluation) */
  sensitivityReason?: string;
  /** Whether a Tier 3 space override was used in resolution */
  hasSpaceOverride: boolean;
  /** Whether session is in Private Mode */
  privateMode: boolean;
  /** Which evaluation path blocked this write */
  blockedBy: BlockSource;
  /** Optional override for the single-use approval identifier consumed on retry */
  approvalIdentifier?: string;
  /** Distinguishes normal memory approvals from shared-skill confirmation checkpoints */
  approvalKind?: 'memory_write' | 'shared_skill_checkpoint';
  /** For shared_skill_checkpoint: the name of the person who owns/authored the skill */
  authorLabel?: string;
  /** True when the content has been staged to CoS pending — approval is informational */
  staged?: boolean;
  timestamp: number;
}

export interface MemoryWriteHookOptions {
  turnId: string;
  sessionId: string;
  originalTurnId: string;
  originalSessionId: string; // Main conversation session (for UI filtering)
  coreDirectory: string;
  /** Private mode from original session (forces cautious) */
  privateMode?: boolean;
  /**
   * Stage 2 (260529_memory_write_intent_context_parity.md) — the user message
   * that triggered this turn. Mirrors `createToolSafetyHook`'s closure
   * `userMessage` so the memory-write evaluator sees the same authorising
   * intent the tool-safety path already sees. Untrusted; the eval prompt
   * fences it. Optional: when absent, the ActionContext omits the field —
   * additive-only, behaviour identical to today.
   *
   * Security invariant (do not weaken): informs the evaluator, never
   * auto-authorises a write; sensitive-content blocks must still survive
   * even when the user "asked for" the write.
   */
  userMessage?: string;
  /**
   * Stage 2 — lazy supplier of recent session-level user intent. Mirrors
   * `ToolSafetyHookOptions.getSessionIntent`. Suppliers must never throw
   * (we defensively coerce thrown errors to `null` and log a warn). Within
   * a single hook lifetime (= one turn), the resolved result is memoized
   * per `(turnId, sessionId)` to avoid duplicate session-store reads.
   *
   * IMPORTANT: callers must resolve session intent against the **user
   * conversation** session id (`originalSessionId`), NOT the hook's
   * `sessionId` (which is `turnId` for interactive turns and therefore has
   * no user messages of its own). The hook itself enforces this internally.
   */
  getSessionIntent?: (
    sessionId: string | undefined,
  ) => Promise<ActionContextSessionIntent | null>;
}

/**
 * Extract file path from tool input based on tool type.
 */
function extractFilePath(toolName: string, toolInput: Record<string, unknown>): string | null {
  // Handle different tool input formats
  if (typeof toolInput.file_path === 'string') return toolInput.file_path;
  if (typeof toolInput.path === 'string') return toolInput.path;
  if (typeof toolInput.filePath === 'string') return toolInput.filePath;
  
  // str_replace_editor format
  if (typeof toolInput.command === 'string' && typeof toolInput.path === 'string') {
    return toolInput.path;
  }
  
  log.warn({ toolName, inputKeys: Object.keys(toolInput) }, 'Could not extract file path from tool input');
  return null;
}

/**
 * Returns true when a write target points inside any space's memory/pending/ folder.
 * Staging is managed by the hook; direct writes to pending are not allowed.
 */
function isMemoryPendingPath(filePath: string): boolean {
  // normalizeSafetyPath collapses `.`/`..`/`//` so a raw write target like
  // `…/memory/./pending/x.md` (which bash write-target extraction returns
  // un-normalized) cannot evade this deny gate. toPortablePath alone only swaps
  // separators — it does NOT collapse segments.
  const normalizedPath = normalizeSafetyPath(filePath);
  // Boundary-aware: catch the `memory/pending/` segment whether it appears
  // mid-path (`…/memory/pending/x`), at the start of a relative target
  // (`memory/pending/x`, which `.includes('/memory/pending/')` would miss), or
  // as the directory itself.
  return (
    normalizedPath.includes('/memory/pending/')
    || normalizedPath.startsWith('memory/pending/')
    || normalizedPath.endsWith('/memory/pending')
    || normalizedPath === 'memory/pending'
  );
}

/**
 * Extract content being written from tool input.
 * For Edit operations, this returns just the new_str (not full file).
 * Use extractFullContent for staging which needs the complete file.
 */
function extractContent(toolName: string, toolInput: Record<string, unknown>): string {
  // For Bash, the command itself is the relevant content
  // Note: We can't see the actual data being written, only the command
  if (toolName === 'Bash') {
    const command = toolInput.command as string | undefined;
    return command ? `Bash command: ${command}` : 'Bash command (no content)';
  }
  
  // Create/Write tool - full content
  if (typeof toolInput.content === 'string') return toolInput.content;
  
  // Edit tool - new_str or new_string (different runtime versions use different names)
  if (typeof toolInput.new_str === 'string') return toolInput.new_str;
  if (typeof toolInput.new_string === 'string') return toolInput.new_string;
  
  // str_replace_editor format
  if (typeof toolInput.insert === 'string') return toolInput.insert;
  
  // Fallback: stringify the input (truncated)
  log.warn({ toolName, inputKeys: Object.keys(toolInput) }, 'Could not extract content, falling back to JSON');
  return JSON.stringify(toolInput, null, 2).slice(0, 2000);
}

/**
 * Check if a Bash write command has non-inspectable content.
 * Non-inspectable means we can't extract the actual bytes being written
 * (e.g., piped writes, cp/mv, env var expansion), so the secret gate
 * cannot verify safety and must fail-closed to approval.
 */
function isNonInspectableBashWrite(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName !== 'Bash') return false;
  const command = (toolInput as { command?: string })?.command;
  if (!command) return true; // No command = can't inspect
  return extractBashHeredocContent(command) === null
    && extractBashWriteContent(command) === null
    && extractBashCopySource(command) === null;
}

/**
 * Extract the FULL content that will result from this write operation.
 * For Create: returns the new content
 * For Edit: reads current file, applies the edit, returns full result
 * For Bash heredocs: extracts the heredoc content
 * This is needed for staging so the diff view shows the complete picture.
 * 
 * Returns null if the content cannot be determined (e.g., old_str not found,
 * file unreadable, or Bash command without a heredoc pattern).
 * Caller should fall back to traditional approval flow in this case.
 */
async function extractFullContent(
  toolName: string,
  toolInput: Record<string, unknown>,
  filePath: string,
  coreDirectory?: string,
  sessionId?: string
): Promise<string | null> {
  // Create/Write tool - already have full content
  if (typeof toolInput.content === 'string') {
    return toolInput.content;
  }

  // Bash tool - try to extract content from heredoc, echo/printf redirect, or cp source
  if (toolName === 'Bash') {
    const command = (toolInput as { command?: string })?.command;
    if (!command) return null;
    const heredocContent = extractBashHeredocContent(command);
    if (heredocContent !== null) return heredocContent;
    const writeContent = extractBashWriteContent(command);
    if (writeContent !== null) return writeContent;
    // cp: read the source file to get content for credential checking
    const copySource = extractBashCopySource(command);
    if (copySource !== null) {
      try {
        const resolvedSource = (!path.isAbsolute(copySource) && coreDirectory)
          ? path.resolve(coreDirectory, copySource)
          : copySource;
        return await fs.readFile(resolvedSource, 'utf-8');
      } catch {
        return null; // Source unreadable, caller falls back to approval
      }
    }
    return null;
  }
  
  // Edit / str_replace_editor - need to apply the edit to get full result
  if (toolName === 'Edit' || toolName === 'str_replace_editor') {
    const oldStr = typeof toolInput.old_str === 'string'
      ? toolInput.old_str
      : typeof toolInput.old_string === 'string'
        ? toolInput.old_string
        : null;
    const newStr = typeof toolInput.new_str === 'string'
      ? toolInput.new_str
      : typeof toolInput.new_string === 'string'
        ? toolInput.new_string
        : null;

    if (oldStr === null || newStr === null) {
      log.warn(
        {
          toolName,
          filePath,
          hasOld: oldStr !== null,
          hasNew: newStr !== null,
        },
        'Edit input missing required old_str/new_str — failing extractFullContent',
      );
      return null;
    }

    // Resolve relative paths against coreDirectory (workspace root) so that
    // symlinked spaces (e.g. Google Drive) are reachable. Without this,
    // fs.readFile on a relative workspace path like "work/mindstone/General/..."
    // fails with ENOENT because the process CWD is not the workspace root.
    const resolvedPath = (!path.isAbsolute(filePath) && coreDirectory)
      ? path.resolve(coreDirectory, filePath)
      : filePath;

    if (oldStr.length === 0) {
      log.warn({ filePath }, 'Edit old_str is empty, cannot stage');
      return null;
    }

    // Prefer same-session pending content over disk (enables Edit-after-Create and Edit-after-Edit)
    let currentContent: string;
    const pendingLookup = sessionId
      ? normalizePendingLookupResult(await getPendingFileByDestination(filePath, sessionId))
      : ({ kind: 'none' } as const);
    if (pendingLookup.kind === 'found') {
      log.info({ filePath }, 'Using pending content as Edit base (same-session staged write exists)');
      currentContent = pendingLookup.content;
    } else if (pendingLookup.kind === 'candidate_unreadable') {
      log.warn(
        { filePath, pendingFilePath: pendingLookup.filePath, reason: pendingLookup.reason },
        'Pending candidate unreadable while preparing Edit base'
      );
      return null;
    } else {
      try {
        currentContent = await fs.readFile(resolvedPath, 'utf-8');
      } catch {
        log.warn({ filePath }, 'Could not read file for Edit and no pending content available');
        return null;
      }
    }

    // Apply the replacement
    // Note: Edit tool typically replaces first occurrence only
    const changeAll = toolInput.change_all === true;
    let resultContent: string;

    if (changeAll) {
      resultContent = currentContent.split(oldStr).join(newStr);
    } else {
      const firstIndex = currentContent.indexOf(oldStr);
      if (firstIndex === -1) {
        // old_str not found - cannot safely stage this edit
        // Return null to fall back to traditional approval flow
        log.warn({ filePath, oldStrPreview: oldStr.slice(0, 100) }, 'Edit old_str not found in file, cannot stage');
        return null;
      }
      const secondIndex = currentContent.indexOf(oldStr, firstIndex + oldStr.length);
      if (secondIndex !== -1) {
        log.warn(
          { filePath, oldStrPreview: oldStr.slice(0, 100) },
          'Edit old_str appears multiple times in base content, cannot stage'
        );
        return null;
      }
      resultContent = currentContent.slice(0, firstIndex) + newStr + currentContent.slice(firstIndex + oldStr.length);
    }

    return resultContent;
  }
  
  // str_replace_editor format
  if (typeof toolInput.insert === 'string') {
    return toolInput.insert;
  }
  
  // Fallback to basic extraction
  return extractContent(toolName, toolInput);
}

// Imported from spacePathMatcher (extracted to break spaceService↔memoryWriteHook cycle).
// Re-exported to preserve existing import paths in tests.
import { matchPathToSpace, tryCorrectAgentSpacePath } from '../spacePathMatcher';
export { matchPathToSpace };

// Expanded return type for space resolution
interface ResolvedSpace {
  spaceName: string;
  /** Absolute space root path (used for README enrichment in safety eval context) */
  absolutePath: string;
  /** Workspace-relative path (POSIX-normalized for override matching) */
  spacePath: string;
  /** Space type from SpaceInfo - used for Chief-of-Staff detection */
  spaceType?: import('@shared/types').SpaceType;
  /** Sharing level - used for safety floor enforcement */
  sharing?: 'private' | 'restricted' | 'company-wide' | 'public';
  /** Raw sharing from settings (used for safety-eval trust hierarchy context) */
  settingsSharing?: 'private' | 'restricted' | 'company-wide' | 'public';
  /** Raw sharing from README frontmatter (used for mismatch detection) */
  frontmatterSharing?: 'private' | 'restricted' | 'company-wide' | 'public';
  /** @deprecated Use sharing + spaceSafetyLevels instead. Kept for backward compat migration. */
  memoryTrust?: 'always_ask' | 'balanced' | 'always_write';
  /** @deprecated Haiku evaluates content at runtime. Kept for backward compat. */
  sensitivity?: 'standard' | 'confidential' | 'restricted';
  description?: string;
  /**
   * Set when the agent used a bare space name (e.g., "General/file.md") instead
   * of the full workspace-relative path (e.g., "work/Mindstone/General/file.md").
   * Callers should use this as the effective file path for staging/writes.
   */
  correctedFilePath?: string;
}

/**
 * Compute workspace-relative path (POSIX-normalized) for override matching.
 */
function getSpacePath(space: SpaceInfo, coreDirectory: string): string {
  return toPortablePath(path.relative(coreDirectory, space.absolutePath));
}

/**
 * Normalize sharing value ('team' -> 'restricted').
 */
export function normalizeSharing(sharing: string | undefined): 'private' | 'restricted' | 'company-wide' | 'public' | undefined {
  if (sharing === 'team') return 'restricted';
  if (sharing === 'private' || sharing === 'restricted' || sharing === 'company-wide' || sharing === 'public') {
    return sharing;
  }
  return undefined;
}

function toActionContextSharingClass(
  sharing: string | undefined,
): ActionContextSpaceSharing['effective'] {
  const normalized = normalizeSharing(sharing);
  if (normalized === 'private') return 'private';
  if (normalized === 'restricted') return 'team';
  if (normalized === 'company-wide') return 'shared';
  if (normalized === 'public') return 'public';
  return 'unknown';
}

function buildActionContextSpaceSharing(spaceInfo: ResolvedSpace | null | undefined): ActionContextSpaceSharing | undefined {
  if (!spaceInfo) return undefined;

  const hasSettingsValue = spaceInfo.settingsSharing !== undefined;
  const hasFrontmatterValue = spaceInfo.frontmatterSharing !== undefined;
  const settingsValue = hasSettingsValue ? toActionContextSharingClass(spaceInfo.settingsSharing) : undefined;
  const frontmatterValue = hasFrontmatterValue ? toActionContextSharingClass(spaceInfo.frontmatterSharing) : undefined;
  const mismatch = Boolean(settingsValue && frontmatterValue && settingsValue !== frontmatterValue);

  if (settingsValue) {
    return {
      effective: settingsValue,
      source: 'settings',
      settingsValue,
      frontmatterValue,
      mismatch,
    };
  }

  if (frontmatterValue) {
    return {
      effective: frontmatterValue,
      source: 'frontmatter',
      settingsValue,
      frontmatterValue,
      mismatch,
    };
  }

  return {
    effective: 'unknown',
    source: 'default',
    settingsValue,
    frontmatterValue,
    mismatch,
  };
}

async function getSpaceReadmePreview(spaceInfo: ResolvedSpace | null | undefined): Promise<string | undefined> {
  if (!spaceInfo?.absolutePath) return undefined;
  const body = await readSpaceReadmeBody(spaceInfo.absolutePath);
  if (typeof body !== 'string' || body.trim().length === 0) {
    return undefined;
  }
  return body;
}

function normalizeSpacePath(spacePath: string): string {
  return toPortablePath(spacePath)
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/$/, '');
}

function getNormalizedSpacePathKey(spacePath: string): string {
  return normalizeSpacePath(spacePath).toLowerCase();
}

function spaceConfigToFallbackSpaceInfo(spaceConfig: SpaceConfig, coreDirectory: string): SpaceInfo {
  const normalizedPath = normalizeSpacePath(spaceConfig.path);
  const nameFromPath = normalizedPath.split('/').filter(Boolean).at(-1) ?? normalizedPath;

  return {
    name: nameFromPath || spaceConfig.name,
    path: normalizedPath,
    absolutePath: path.join(coreDirectory, normalizedPath),
    type: spaceConfig.type,
    isSymlink: spaceConfig.isSymlink,
    hasReadme: spaceConfig.hasReadme ?? false,
    sourcePath: spaceConfig.sourcePath,
    description: spaceConfig.description,
    displayName: spaceConfig.name,
    sharing: spaceConfig.sharing,
  };
}

/**
 * Get space info including spaceType and sharing level from frontmatter.
 */
async function resolveSpaceFromPath(
  filePath: string,
  coreDirectory: string
): Promise<ResolvedSpace | null> {
  try {
    // Read-only: memory-write safety classification must not mutate frontmatter.
    // See docs/plans/260411_shared_space_maintenance.md Stage 3 Refinement.
    const scannedSpaces = await scanSpaces(coreDirectory, { skipAutoFix: true });
    const settings = getSettings();

    // Merge spaces by normalized path (case-insensitive): scanned entries win, settings fill gaps.
    const mergedSpacesByPath = new Map<string, SpaceInfo>();
    const configuredSpacesByPath = new Map<string, SpaceConfig>();
    for (const scannedSpace of scannedSpaces) {
      mergedSpacesByPath.set(getNormalizedSpacePathKey(scannedSpace.path), scannedSpace);
    }

    for (const configuredSpace of settings.spaces ?? []) {
      const fallbackSpace = spaceConfigToFallbackSpaceInfo(configuredSpace, coreDirectory);
      const fallbackKey = getNormalizedSpacePathKey(fallbackSpace.path);
      configuredSpacesByPath.set(fallbackKey, configuredSpace);
      const existing = mergedSpacesByPath.get(fallbackKey);
      if (existing === undefined) {
        mergedSpacesByPath.set(fallbackKey, fallbackSpace);
      } else {
        // Enrich scanned entry with settings fallbacks for fields that can be undefined from disk.
        // Settings-authoritative when scan/frontmatter returns undefined/empty.
        // Same precedence as reconcileSpacesWithSettings: disk wins when present, settings preserved when missing.
        mergedSpacesByPath.set(fallbackKey, {
          ...existing,
          sharing: existing.sharing ?? configuredSpace.sharing,
          description: existing.description || configuredSpace.description,
        });
      }
    }

    const spaces = Array.from(mergedSpacesByPath.values());
    let space = matchPathToSpace(filePath, spaces, coreDirectory);
    let correctedFilePath: string | undefined;

    if (!space) {
      // Name-based correction: agent may have used a bare space name
      // (e.g., "General/file.md") instead of the full workspace-relative path
      // (e.g., "work/Mindstone/General/file.md"). Only fires when exactly one
      // space matches the first path segment — fail-closed on ambiguity.
      const correction = tryCorrectAgentSpacePath(filePath, spaces, coreDirectory);
      if (correction) {
        space = correction.matchedSpace;
        correctedFilePath = correction.correctedPath;
        log.info(
          { originalPath: filePath, correctedPath: correctedFilePath, spaceName: space.name },
          'Corrected agent path via space name match',
        );
      }
    }

    if (!space) {
      return null;
    }

    const scannedSpacePathKeys = new Set(scannedSpaces.map(({ path: scannedPath }) => getNormalizedSpacePathKey(scannedPath)));
    const isSettingsFallbackMatch = !scannedSpacePathKeys.has(getNormalizedSpacePathKey(space.path));
    const configuredSpace = configuredSpacesByPath.get(getNormalizedSpacePathKey(space.path));

    // Read frontmatter for sharing, description, and legacy fields
    let frontmatter: Awaited<ReturnType<typeof readSpaceReadmeFrontmatter>>;
    try {
      frontmatter = await readSpaceReadmeFrontmatter(space.absolutePath);
    } catch (error) {
      if (!isSettingsFallbackMatch) {
        throw error;
      }

      log.warn(
        { err: error, filePath, spacePath: space.path },
        'Failed to read frontmatter for fallback space; using settings metadata'
      );
      frontmatter = undefined;
    }

    const frontmatterSharing = normalizeSharing(frontmatter?.sharing);
    const settingsSharing = normalizeSharing(configuredSpace?.sharing);

    return {
      spaceName: getSpaceDisplayName(space),
      absolutePath: space.absolutePath,
      spacePath: getSpacePath(space, coreDirectory),
      spaceType: space.type, // From SpaceInfo - used for Chief-of-Staff detection
      sharing: frontmatterSharing ?? normalizeSharing(space.sharing),
      settingsSharing,
      frontmatterSharing,
      memoryTrust: frontmatter?.memoryTrust, // Legacy, for migration
      sensitivity: frontmatter?.sensitivity, // Legacy, for logging only
      description: frontmatter?.rebel_space_description || space.description,
      correctedFilePath,
    };
  } catch (error) {
    log.warn({ err: error, filePath }, 'Failed to resolve space from path');
    return null;
  }
}

// Prompt externalized to rebel-system/prompts/safety/memory-content-summary.md

/**
 * Generate a human-readable summary of the content using Haiku.
 * The summary should be written for non-technical users, focusing on
 * purpose and content rather than implementation details.
 */
export async function summarizeContent(content: string): Promise<string> {
  try {
    const settings = getSettings();
    const response = await callBehindTheScenesWithAuth(settings, {
      messages: [
        { role: 'user', content: `${getPrompt(PROMPT_IDS.SAFETY_MEMORY_CONTENT_SUMMARY)}\n\nContent being saved:\n\n${content.slice(0, 2000)}` }
      ],
      maxTokens: 1024,
    }, { category: 'memoryWrite' });
    
    // Extract text from response content array
    const textContent = response.content
      ?.filter(block => block.type === 'text')
      .map(block => block.text)
      .join('') || '';
    return textContent || 'Memory update';
  } catch (error) {
    log.warn({ err: error }, 'Failed to generate content summary, using fallback');
    // Fallback: extract meaningful text, skip JSON/code blocks
    const lines = content.split('\n').filter(line => {
      const trimmed = line.trim();
      // Skip empty lines, JSON brackets, markdown code fences
      return trimmed && trimmed !== '{' && trimmed !== '}' && trimmed !== '```' && !trimmed.startsWith('```');
    });
    const firstMeaningfulLine = lines[0]?.trim() || '';
    if (firstMeaningfulLine.length > 100) {
      return `${firstMeaningfulLine.slice(0, 97)}...`;
    }
    return firstMeaningfulLine || 'Memory update';
  }
}



/**
 * Track a memory write in history (fire-and-forget).
 */
function trackMemoryWrite(
  filePath: string,
  spaceName: string,
  summary: string,
  sessionId: string,
  isNew: boolean,
  workspacePath?: string,
  autoApproveReason?: AutoApproveReason,
  sharing?: string
): void {
  addApprovedMemoryEntry({
    filePath,
    spaceName,
    summary,
    sessionId,
    isNew,
    workspacePath,
    autoApproveReason,
    sharing: sharing as 'private' | 'restricted' | 'company-wide' | 'public' | undefined,
  });
  log.info({ filePath, spaceName, sessionId, autoApproveReason }, 'Tracked memory write');
  markChiefOfStaffHygieneIfChiefReadme(filePath, workspacePath).catch((err) => {
    log.warn({ err, filePath }, 'Failed to mark Chief-of-Staff hygiene needed after README write');
  });
}

async function markChiefOfStaffHygieneIfChiefReadme(
  filePath: string,
  workspacePath: string | undefined,
): Promise<void> {
  if (!workspacePath) {
    return;
  }
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(workspacePath, filePath);
  const relativePath = toPortablePath(path.relative(workspacePath, absolutePath));
  if (!relativePath.toLowerCase().endsWith('/readme.md') && relativePath.toLowerCase() !== 'readme.md') {
    return;
  }
  if (!await isChiefOfStaffRootReadme(relativePath, workspacePath)) {
    return;
  }
  await markChiefOfStaffHygieneNeeded(workspacePath, {
    createdAt: new Date().toISOString(),
    reason: 'chief_of_staff_readme_memory_write',
    readmePath: relativePath,
  });
}

async function isChiefOfStaffRootReadme(
  relativePath: string,
  workspacePath: string,
): Promise<boolean> {
  const normalizedRelativePath = normalizeSpacePath(relativePath).toLowerCase();
  if (normalizedRelativePath === 'chief-of-staff/readme.md') {
    return true;
  }

  const resolvedSpace = await resolveSpaceFromPath(relativePath, workspacePath);
  if (resolvedSpace?.spaceType !== 'chief-of-staff') {
    return false;
  }
  const normalizedSpacePath = normalizeSpacePath(resolvedSpace.spacePath).toLowerCase();
  return normalizedRelativePath === `${normalizedSpacePath}/readme.md`;
}

/**
 * Broadcast approval request to all windows and persist metadata.
 * Resolves FileLocation best-effort before persisting + broadcasting.
 */
async function broadcastApprovalRequest(
  request: MemoryWriteApprovalRequest,
  metadata: {
    turnId: string;
    sessionId: string;
    originalSessionId: string;
    filePath: string;
    content: string;
  }
): Promise<void> {
  const approvalIdentifier = request.approvalIdentifier ?? metadata.filePath;
  const coreDirectory = getSettings()?.coreDirectory ?? undefined;
  let resolvedLocation: FileLocation | undefined;
  let legacySpacePath: string | undefined;

  try {
    const scannedSpaces = coreDirectory
      ? await scanSpaces(coreDirectory, { skipAutoFix: true })
      : [];
    const resolverSpaces: ResolverSpaceInfo[] = scannedSpaces.map((space) => ({
      ...space,
      status: space.status ?? 'ok',
    }));
    resolvedLocation = await resolveFileLocation(
      request.destination.path,
      resolverSpaces,
      { coreDirectory },
    );

    if (resolvedLocation.kind === 'outside-workspace') {
      const key = `fallback:${request.destination.path}`;
      if (!fileLocationWarned.get(key)) {
        fileLocationWarned.set(key, true);
        log.warn(
          {
            pendingDestination: request.destination.path,
            originalSpace: request.destination.spaceName,
            coreDirectory,
            handler: 'broadcastApprovalRequest',
          },
          'FileLocation fell back to outside-workspace',
        );
      }
    }
    legacySpacePath = resolvedLocation.kind === 'in-space'
      ? resolvedLocation.workspaceRelativePath
      : resolvedLocation.kind === 'outside-workspace'
        ? resolvedLocation.absolutePath
        : request.destination.spacePath;
    if (typeof legacySpacePath === 'string' && legacySpacePath.trim().length === 0) {
      legacySpacePath = undefined;
    }
    // Invariant #14 carve-out. Unlike other main-side producers
    // (memoryHandlers, skillChangeNotificationService, cloudStagingBridge)
    // which MUST fail closed on FileLocationResolverError, broadcastApprovalRequest
    // MUST fail OPEN here: a safety-critical memory-write approval reaching the
    // user in degraded state (no location badge) is strictly better than the user
    // never seeing the approval at all. Legacy spacePath/spaceName fields remain
    // populated, so the renderer's consumer-side legacyMissingLocation() shim
    // produces a labeled degraded badge. See Invariants #14 and this exception
    // in docs/plans/260419_file_location_centralisation.md.
  } catch (error) {
    if (error instanceof FileLocationResolverError) {
      const key = `resolver-error:${request.destination.path}`;
      if (!fileLocationWarned.get(key)) {
        fileLocationWarned.set(key, true);
        log.warn(
          {
            err: error,
            pendingDestination: request.destination.path,
            originalSpace: request.destination.spaceName,
            coreDirectory,
            handler: 'broadcastApprovalRequest',
          },
          'FileLocation resolution failed; broadcasting memory approval request without location',
        );
      }
    } else {
      throw error;
    }
  }

  const requestWithLocation: MemoryWriteApprovalRequest = resolvedLocation
    ? {
      ...request,
      destination: {
        ...request.destination,
        ...(legacySpacePath ? { spacePath: legacySpacePath } : {}),
        location: resolvedLocation,
      },
    }
    : request;

  // Store metadata for retry lookup (in-memory)
  // Include originalSessionId so approval storage doesn't depend solely on persisted store (FOX-2245)
  pendingApprovalMetadata.set(request.toolUseId, {
    turnId: metadata.turnId,
    sessionId: metadata.sessionId,
    originalSessionId: metadata.originalSessionId,
    filePath: metadata.filePath,
    spaceName: requestWithLocation.destination.spaceName,
    approvalIdentifier,
  });
  
  // Persist metadata for app restart recovery (including full content and rich fields)
  const persistedRequest: PersistedMemoryApprovalRequest = {
    toolUseId: requestWithLocation.toolUseId,
    originalTurnId: requestWithLocation.originalTurnId,
    originalSessionId: metadata.originalSessionId,
    turnId: metadata.turnId,
    sessionId: metadata.sessionId,
    filePath: metadata.filePath,
    spaceName: requestWithLocation.destination.spaceName,
    summary: requestWithLocation.summary,
    content: metadata.content,
    timestamp: requestWithLocation.timestamp,
    // Rich fields for UI consistency after restart
    sensitivityReason: requestWithLocation.sensitivityReason,
    hasSpaceOverride: requestWithLocation.hasSpaceOverride,
    privateMode: requestWithLocation.privateMode,
    blockedBy: requestWithLocation.blockedBy,
    spacePath: legacySpacePath ?? requestWithLocation.destination.spacePath,
    location: requestWithLocation.destination.location,
    sharing: requestWithLocation.destination.sharing,
    contentPreview: requestWithLocation.contentPreview,
    approvalIdentifier,
    approvalKind: requestWithLocation.approvalKind,
    authorLabel: requestWithLocation.authorLabel,
    staged: requestWithLocation.staged,
    isNewFile: requestWithLocation.destination.isNew,
  };
  addPendingMemoryApproval(persistedRequest);
  
  // Broadcast to renderer (fire-and-forget, no blocking)
  broadcastTypedPayload(getBroadcastService(), 'memory:write-approval-request', requestWithLocation);
  
  log.info(
    { toolUseId: requestWithLocation.toolUseId, destination: requestWithLocation.destination.spaceName, filePath: metadata.filePath },
    'Broadcast memory write approval request (non-blocking)'
  );
}

/**
 * Handle user response to approval request.
 * Non-blocking design: stores approval, returns metadata for continuation message.
 * The renderer sends a continuation to the main session with full content.
 */
export function handleMemoryWriteApprovalResponse(
  toolUseId: string,
  approved: boolean,
): { success: boolean; sessionId?: string; originalSessionId?: string; filePath?: string; spaceName?: string; content?: string } {
  const metadata = pendingApprovalMetadata.get(toolUseId);
  
  // Also check persisted store for app restart recovery
  const persistedRequests = getPendingMemoryApprovals();
  const persistedRequest = persistedRequests.find(r => r.toolUseId === toolUseId);
  
  const filePath = metadata?.filePath ?? persistedRequest?.filePath;
  const sessionId = metadata?.sessionId ?? persistedRequest?.sessionId;
  const spaceName = metadata?.spaceName ?? persistedRequest?.spaceName;
  const content = persistedRequest?.content;
  const approvalIdentifier = metadata?.approvalIdentifier ?? persistedRequest?.approvalIdentifier ?? filePath;
  const approvalKind = persistedRequest?.approvalKind ?? 'memory_write';
  // Get originalSessionId for broadcast (main conversation session, not background memory turn)
  const resolvedOriginalSessionId = (metadata as { originalSessionId?: string })?.originalSessionId ?? persistedRequest?.originalSessionId;
  
  if (!approved) {
    log.info({ toolUseId, spaceName }, 'User denied memory write');
    pendingApprovalMetadata.delete(toolUseId);
    removePendingMemoryApproval(toolUseId);
    return { success: true, sessionId, originalSessionId: resolvedOriginalSessionId, filePath, spaceName, content };
  }
  
  // Store single-use approval so retry works (using shared sessionApprovals with 'memory' domain)
  // CRITICAL for FOX-2245: The continuation message triggers a write in the main session,
  // not the background session, so we need the approval to be valid in the main session.
  // Single-use: store ONLY for originalSessionId where retry actually happens, to ensure
  // "single-use" means exactly one use (not one per session)
  const targetSessionId = resolvedOriginalSessionId ?? sessionId;
  if (approvalIdentifier && targetSessionId) {
    // expectExecution: legacy (non-staged) approvals rely on a model-mediated
    // "re-run the write" continuation — opt into the approval-execution guard
    // so an ignored continuation is force-retried once then surfaced.
    // Staged items already have their content in CoS pending (no continuation
    // is sent, nothing re-executes) — never expect consumption for them.
    const expectExecution = persistedRequest?.staged !== true;
    storeSingleUseApproval('memory', targetSessionId, approvalIdentifier, { expectExecution });
    log.info(
      { toolUseId, filePath, approvalIdentifier, targetSessionId, spaceName, expectExecution },
      'Stored single-use file approval'
    );
  }
  
  // Track this write in memory history so it shows in "What Rebel Knows"
  // even though the actual write happens via the main session continuation
  const summary = persistedRequest?.summary;
  if (approvalKind === 'memory_write' && filePath && spaceName && summary && resolvedOriginalSessionId) {
    // Get workspace path for normalization
    const settings = getSettings();
    const workspacePath = settings?.coreDirectory;
    
    addApprovedMemoryEntry({
      filePath,
      spaceName,
      summary,
      sessionId: resolvedOriginalSessionId, // Use main session ID for history tracking
      isNew: false, // Default to 'updated' - we don't persist the Create vs Edit distinction
      workspacePath: workspacePath ?? undefined,
    });
  }
  
  // Clean up pending request
  pendingApprovalMetadata.delete(toolUseId);
  removePendingMemoryApproval(toolUseId);
  
  // Return metadata so renderer can send continuation message
  return { success: true, sessionId, originalSessionId: resolvedOriginalSessionId, filePath, spaceName, content };
}

function buildSharedSkillCheckpointSummary(skillName: string, authorLabel: string): string {
  return `"${skillName}" was created by ${authorLabel} and is shared with others. Confirm before updating the shared version.`;
}

/**
 * Stage an automation memory write for user review (fail-closed).
 *
 * Delegates core staging logic to `stageOrDeny()`, wrapping with
 * automation-specific side effects: circuit breaker increment, automation
 * tracker item, security denial recording.
 *
 * Returns null if staging couldn't be done (caller should fall back to hard-deny).
 */
async function stageAutomationMemoryWriteBlock(params: {
  toolName: string;
  toolInput: Record<string, unknown>;
  sessionId: string;
  turnId: string;
  originalSessionId: string;
  coreDirectory: string;
  blockReason: string;
  blockedBy: BlockSource;
  automationId: string;
  /** Pre-computed summary — when provided, skips the LLM summarizeContent() call.
   *  Used by the secret gate to avoid leaking detected credentials to the LLM. */
  summary?: string;
  /** Optional override when the target path cannot be derived from toolInput
   *  (e.g. Bash writes where the destination is inside a shell command).
   *  When omitted, the path is extracted from toolInput via `extractFilePath`. */
  filePathOverride?: string;
  /** Sharing level of the target space at staging time */
  sharing?: 'private' | 'restricted' | 'company-wide' | 'public';
  /** Optional first-wins coalesce key for outage fan-out staging dedup. */
  coalesceKey?: string;
  /** Skip automation safety block increment (FOX-3231 parity for eval_error). */
  skipCircuitBreaker?: boolean;
}): Promise<HookJSONOutput | null> {
  const { toolName, toolInput, sessionId, turnId, originalSessionId, coreDirectory, blockReason, blockedBy, automationId } = params;

  // Extract file path — needed for staging and automation side effects
  let filePath = params.filePathOverride ?? extractFilePath(toolName, toolInput);
  if (!filePath) {
    log.warn({ toolName, automationId }, 'Automation memory staging: could not extract file path');
    return null;
  }

  // Resolve space name for display (needed for stageOrDeny params).
  // If the agent used a bare space name, correctedFilePath rewrites the destination.
  const spaceInfo = await resolveSpaceFromPath(filePath, coreDirectory);
  if (spaceInfo?.correctedFilePath) {
    filePath = spaceInfo.correctedFilePath;
  }
  const spaceName = spaceInfo?.spaceName
    ?? classifyUnmatchedPath(filePath, coreDirectory).displayLabel;

  // Delegate core staging to stageOrDeny()
  const stagingResult = await stageOrDeny({
    toolName, toolInput, filePath, coreDirectory, sessionId,
    originalSessionId, turnId, spaceName, blockedBy, blockReason,
    summary: params.summary,
    sharing: params.sharing ?? spaceInfo?.sharing,
    coalesceKey: params.coalesceKey,
    supersededToolUseId: undefined,
  });

  if (stagingResult === null) {
    // Staging impossible (env-var disabled, no content, CoS unavailable)
    // Return null for caller fallback — callers own their own denial recording
    // and circuit-breaker side effects (do NOT record here to avoid double-counting)
    log.info({ toolName, filePath, automationId }, 'Automation memory staging: stageOrDeny returned null, falling back to caller');
    return null;
  }

  // Staging succeeded — apply automation-specific side effects

  // Track in automation pending items tracker for auto-update rules flow
  // (The pending file ID is not directly available from stageOrDeny result,
  //  so we look it up from the pending service by destination path)
  const pendingFileLookup = normalizePendingLookupResult(
    await getPendingFileByDestination(filePath),
  );
  if (pendingFileLookup.kind === 'found') {
    trackItem(automationId, pendingFileLookup.file.id, 'memory-write', {
      toolName: 'memory_write',
      inputSummary: filePath,
    });
  } else if (pendingFileLookup.kind === 'candidate_unreadable') {
    log.warn(
      { filePath, pendingFilePath: pendingFileLookup.filePath, reason: pendingFileLookup.reason, automationId },
      'Automation staging completed but pending lookup was unreadable'
    );
  }

  // Record denial and increment circuit breaker
  if (turnId) {
    const denialReason = params.skipCircuitBreaker
      ? `Safety evaluator unavailable — staged memory write for approval: ${blockReason}`
      : `Safety rules blocked memory write: ${blockReason}`;
    agentTurnRegistry.recordSecurityDenial(turnId, toolName, denialReason);
    agentTurnRegistry.recordToolCall(turnId, toolName, toolInput);
  }
  if (!params.skipCircuitBreaker) {
    agentTurnRegistry.incrementAutomationSafetyBlock(sessionId);
  }

  // Pass through stageOrDeny's replaceResult — agent sees a successful tool result
  return stagingResult.output;
}

function isInboxPath(filePath: string): boolean {
  try {
    const rawInboxDir = path.join(getPlatformConfig().userDataPath, 'inbox');
    // Layer 1 — lexical: normalizeSafetyPath collapses `.`/`..`/`//` so a
    // traversal spelling like `<userData>/inbox/../trusted-tools/x` cannot be
    // classified as inbox and auto-approved (lines ~1805 / ~2099) while resolving
    // OUTSIDE inbox. toPortablePath alone only swaps separators and does NOT
    // collapse segments.
    const inboxDir = normalizeSafetyPath(rawInboxDir).toLowerCase();
    const normalizedPath = normalizeSafetyPath(filePath).toLowerCase();
    if (!(normalizedPath.startsWith(inboxDir + '/') || normalizedPath === inboxDir)) {
      return false;
    }
    // Layer 2 — symlink-aware: reject a lexically-inside path whose parent
    // resolves (via symlink) OUTSIDE inbox. Fail-closed on realpath error.
    return isPathContainedWithin(filePath, rawInboxDir);
  } catch {
    // getPlatformConfig may throw before bootstrap
    return false;
  }
}

function buildFileAlreadyPendingReviewOutput(params: {
  filePath: string;
  spaceName: string;
  pendingFile: string;
}): HookJSONOutput {
  const { filePath, spaceName, pendingFile } = params;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `FILE ALREADY PENDING REVIEW

A previous write to this file is already staged and awaiting user approval:
- File: ${filePath}
- Space: ${spaceName}
- Staged file: ${pendingFile}

DO NOT RETRY: The user must first review the pending changes before any new writes to this file can proceed.

The user will see this in their "Pending Changes" panel. Once they approve or discard the pending version, you can write to this file again.`,
    },
  };
}

interface ExistingPendingPreflightParams {
  filePath: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  sessionId: string;
  originalSessionId: string;
  turnId: string;
  coreDirectory: string;
  toolUseId?: string;
  spaceName?: string;
  sharing?: 'private' | 'restricted' | 'company-wide' | 'public';
  dryRun?: boolean;
}

async function checkExistingPendingPreflight(
  params: ExistingPendingPreflightParams,
): Promise<HookJSONOutput | null> {
  const {
    filePath,
    toolName,
    toolInput,
    sessionId,
    originalSessionId,
    turnId,
    coreDirectory,
    toolUseId,
    spaceName: providedSpaceName,
    sharing: providedSharing,
    dryRun = false,
  } = params;

  // Inbox writes never stage through CoS pending and must remain auto-approved.
  if (isInboxPath(filePath)) {
    return null;
  }

  const existingPendingLookup = normalizePendingLookupResult(
    await getPendingFileByDestination(filePath),
  );
  if (existingPendingLookup.kind === 'none') {
    return null;
  }

  const pendingFileLabel = existingPendingLookup.kind === 'found'
    ? existingPendingLookup.file.filename
    : path.basename(existingPendingLookup.filePath);

  if (existingPendingLookup.kind === 'candidate_unreadable') {
    const safeSummary = 'Possible credentials detected — review before saving';
    const effectiveSpaceName = providedSpaceName
      ?? classifyUnmatchedPath(filePath, coreDirectory).displayLabel;

    log.warn(
      {
        filePath,
        pendingFilePath: existingPendingLookup.filePath,
        reason: existingPendingLookup.reason,
        dryRun,
      },
      'Unreadable pending candidate detected during preflight; staging defensively'
    );

    if (dryRun) {
      return buildFileAlreadyPendingReviewOutput({
        filePath,
        spaceName: effectiveSpaceName,
        pendingFile: pendingFileLabel,
      });
    }

    try {
      const stagingResult = await stageOrDeny({
        toolName,
        toolInput,
        filePath,
        coreDirectory,
        sessionId,
        originalSessionId,
        turnId,
        spaceName: effectiveSpaceName,
        blockedBy: 'structural_policy',
        blockReason: safeSummary,
        summary: safeSummary,
        sharing: providedSharing,
        toolUseId,
        supersededToolUseId: undefined,
      });

      if (stagingResult) {
        return stagingResult.output;
      }
    } catch (stagingErr) {
      log.warn(
        {
          err: stagingErr,
          filePath,
          pendingFilePath: existingPendingLookup.filePath,
          reason: existingPendingLookup.reason,
        },
        'Defensive staging failed for unreadable pending candidate — denying'
      );
    }

    return buildFileAlreadyPendingReviewOutput({
      filePath,
      spaceName: effectiveSpaceName,
      pendingFile: pendingFileLabel,
    });
  }

  const existingPending = existingPendingLookup;
  const pendingSessionId = existingPending.file.frontmatter.session_id;
  const effectiveSpaceName = providedSpaceName
    ?? existingPending.file.frontmatter.original_space
    ?? classifyUnmatchedPath(filePath, coreDirectory).displayLabel;

  if (pendingSessionId && pendingSessionId === originalSessionId) {
    const existingBlockedBy = existingPending.file.frontmatter.blocked_by ?? 'structural_policy';
    const nonInspectable = isNonInspectableBashWrite(toolName, toolInput);
    const newContent = extractContent(toolName, toolInput);
    const newContentSecretCheck = containsCredentialPatterns(newContent);
    const effectiveBlockedBy = (
      nonInspectable
      || newContentSecretCheck.detected
      || existingBlockedBy === 'structural_policy'
    )
      ? 'structural_policy'
      : existingBlockedBy;
    const safeSummary = effectiveBlockedBy === 'structural_policy'
      ? 'Possible credentials detected — review before saving'
      : undefined;

    log.info(
      {
        filePath,
        spaceName: effectiveSpaceName,
        pendingFile: existingPending.file.filename,
        sessionId: originalSessionId,
        dryRun,
        existingBlockedBy,
        effectiveBlockedBy,
        nonInspectable,
        detectedCredentialsInNewContent: newContentSecretCheck.detected,
      },
      'Same-session pending write detected during preflight'
    );

    if (dryRun) {
      return buildFileAlreadyPendingReviewOutput({
        filePath,
        spaceName: effectiveSpaceName,
        pendingFile: existingPending.file.filename,
      });
    }

    try {
      const stagingResult = await stageOrDeny({
        toolName,
        toolInput,
        filePath,
        coreDirectory,
        sessionId,
        originalSessionId,
        turnId,
        spaceName: effectiveSpaceName,
        blockedBy: effectiveBlockedBy,
        blockReason: safeSummary
          ?? existingPending.file.frontmatter.summary
          ?? 'Memory write requires approval',
        summary: safeSummary,
        sharing: providedSharing ?? existingPending.file.frontmatter.sharing,
        toolUseId,
        supersededToolUseId: existingPending.file.frontmatter.tool_use_id,
      });

      if (stagingResult) {
        return stagingResult.output;
      }
    } catch (stagingErr) {
      log.warn(
        {
          err: stagingErr,
          filePath,
          spaceName: effectiveSpaceName,
          pendingFile: existingPending.file.filename,
        },
        'Sticky preflight staging failed — denying while pending review remains'
      );
    }
  } else {
    log.info(
      { filePath, spaceName: effectiveSpaceName, pendingFile: existingPending.file.filename },
      'File already has pending staged write - blocking duplicate'
    );
  }

  return buildFileAlreadyPendingReviewOutput({
    filePath,
    spaceName: effectiveSpaceName,
    pendingFile: pendingFileLabel,
  });
}

/**
 * Create the memory write hook for PreToolUse.
 * 
 * Non-blocking design (like tool safety):
 * - Returns DENY immediately when approval needed
 * - User clicks "Save" in UI to store approval + trigger continuation
 * - Retry works because approval is now stored
 */
export function createMemoryWriteHook(options: MemoryWriteHookOptions) {
  const {
    turnId,
    sessionId,
    originalTurnId,
    originalSessionId,
    coreDirectory,
    privateMode,
    userMessage,
    getSessionIntent: sessionIntentSupplier,
  } = options;

  // Stage 2 (260529_memory_write_intent_context_parity.md) — within-turn
  // memoization of session-intent reads, mirroring `createToolSafetyHook`
  // (~lines 2270-2304). The hook is constructed once per turn, so this cache
  // bounds the cost to **at most one** session-store read per turn even when
  // multiple memory writes evaluate sequentially.
  //
  // Gate read once at hook-creation time (mirrors the tool path's
  // `settings.safetyEvalSessionIntent !== false` capture). The hook already
  // imports `getSettings` (~line 42); this adds no new dependency.
  // Only read settings when a supplier is actually wired, so background /
  // un-wired callers (no `getSessionIntent`) stay fully side-effect-free —
  // they never reach the resolver anyway (early-return below).
  const sessionIntentEnabled = sessionIntentSupplier
    ? getSettings()?.safetyEvalSessionIntent !== false
    : false;
  const sessionIntentCache = new Map<string, Promise<ActionContextSessionIntent | null>>();
  const resolveSessionIntent = (
    sid: string | undefined,
  ): Promise<ActionContextSessionIntent | null> => {
    if (!sessionIntentEnabled || !sessionIntentSupplier) return Promise.resolve(null);
    const key = `${turnId ?? '_'}::${sid ?? '_'}`;
    const existing = sessionIntentCache.get(key);
    if (existing) return existing;
    const pending = (async () => {
      try {
        return await sessionIntentSupplier(sid);
      } catch (err) {
        // Fail-closed-soft: supplier promised never to throw, but we treat any
        // thrown error as `null` so the eval still proceeds (parity with the
        // tool hook's behaviour at ~lines 2285-2300).
        log.warn(
          {
            event: 'safety.session_intent_provider_error',
            err: err instanceof Error ? err.message : String(err),
            sessionId: sid,
          },
          'Memory-hook session intent supplier threw — proceeding without sessionIntent',
        );
        ignoreBestEffortCleanup(err, {
          operation: 'safety.session_intent.supplier.memoryHook',
          reason: 'Session intent supplier failed; memory-write safety eval continues without sessionIntent.',
          severity: 'warn',
        });
        return null;
      }
    })();
    sessionIntentCache.set(key, pending);
    return pending;
  };

  return async (
    input: { tool_name?: string; tool_input?: Record<string, unknown>; tool_use_id?: string },
    _toolUseID: string | undefined,
    hookOptions: { signal: AbortSignal }
  ): Promise<HookJSONOutput> => {
    const toolName = input.tool_name;
    const toolInput = input.tool_input as Record<string, unknown> | undefined;
    const toolUseId = input.tool_use_id;
    // Forward the runtime-provided abort signal to every `evaluateSafetyPrompt`
    // call below so Stop-during-memory-eval can cancel the in-flight LLM call
    // within ms instead of waiting for the next retry boundary. Previously
    // the parameter was underscore-prefixed and never consumed, so the signal
    // was silently discarded for the memory-write path.
    const { signal: evalSignal } = hookOptions;
    
    // Early return if no tool name
    if (!toolName) {
      return {};
    }
    
    if (!toolInput || !toolUseId) {
      log.warn({ toolName }, 'Missing tool input or tool_use_id');
      return {};
    }

    const sessionKind = classifySessionKind(sessionId);
    const isAutomationSession = sessionKind === 'automation' || sessionKind === 'automation-insight';
    const isBackgroundMemoryUpdateTurn = sessionKind === 'memory-update';
    const isMcpServerMode = process.env.REBEL_MCP_SERVER_MODE === '1';

    // INBOX STORAGE: Auto-approve writes to the inbox subdirectory of Electron
    // userData. The inbox is managed by Rebel's own MCP tools (rebel_inbox_add)
    // and only stores proposal items the user must explicitly act on.
    // Scoped to inbox/ only — other userData paths (settings, trusted tools, etc.)
    // are security-sensitive and must NOT be auto-approved.
    if (isFileWriteTool(toolName)) {
      const earlyFilePath = extractFilePath(toolName, toolInput);
      if (earlyFilePath) {
        const preflightBeforeInbox = await checkExistingPendingPreflight({
          filePath: earlyFilePath,
          toolName,
          toolInput,
          sessionId,
          originalSessionId,
          turnId,
          coreDirectory,
          toolUseId,
          dryRun: isMcpServerMode,
        });
        if (!isMcpServerMode && preflightBeforeInbox) {
          return preflightBeforeInbox;
        }

        if (isInboxPath(earlyFilePath)) {
          log.info({ filePath: earlyFilePath, toolName }, 'Auto-approving inbox storage write');
          return {};
        }

        const currentUser = getCurrentUserSnapshot();
        const sharedSkillProtection = await sharedSkillMutationService.getNonAuthorSharedSkillProtectionContext(
          earlyFilePath,
          coreDirectory,
          currentUser,
        );
        if (sharedSkillProtection) {
          const preflightBeforeSharedSkillCheckpoint = await checkExistingPendingPreflight({
            filePath: earlyFilePath,
            toolName,
            toolInput,
            sessionId,
            originalSessionId,
            turnId,
            coreDirectory,
            toolUseId,
            spaceName: sharedSkillProtection.target.spaceName,
            sharing: sharedSkillProtection.target.sharing,
            dryRun: isMcpServerMode,
          });
          if (!isMcpServerMode && preflightBeforeSharedSkillCheckpoint) {
            return preflightBeforeSharedSkillCheckpoint;
          }
        }

        const hasSharedSkillCheckpointApproval = sharedSkillProtection && (
          consumeSingleUseApproval('memory', sessionId, sharedSkillProtection.approvalIdentifier)
          || (
            originalSessionId !== sessionId
              && consumeSingleUseApproval('memory', originalSessionId, sharedSkillProtection.approvalIdentifier)
          )
        );

        if (sharedSkillProtection && !hasSharedSkillCheckpointApproval) {
          const summary = buildSharedSkillCheckpointSummary(
            sharedSkillProtection.skillName,
            sharedSkillProtection.authorLabel,
          );

          // Lock-before-stage: acquire lock first to prevent Bash bypass race (challenger finding)
          await lockPathForCheckpoint(turnId, earlyFilePath, coreDirectory);

          // Clone toolInput to avoid mutating the original during enrichment
          const clonedInput = structuredClone(toolInput);

          // Enrich with collaboration metadata (suppress pendingWrites registration — will register at publish time)
          const currentUser = getCurrentUserSnapshot();
          const managedResult = await sharedSkillMutationService.prepareManagedToolInput(
            toolName,
            clonedInput,
            coreDirectory,
            { kind: 'agent', user: currentUser },
            { suppressRegistration: true },
          );

          // If enrichment returns denyReason, hard-deny (per FM #20: non-normalizable writes must NOT be approvable)
          if (managedResult && 'denyReason' in managedResult) {
            unlockPathForCheckpoint(turnId, earlyFilePath);
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: managedResult.denyReason,
              },
            };
          }

          // Extract enriched content for staging
          let enrichedContent: string | null = null;
          if (managedResult) {
            const ui = managedResult.updatedInput;
            enrichedContent = typeof ui.content === 'string'
              ? ui.content
              : typeof ui.new_string === 'string'
                ? ui.new_string
                : typeof ui.new_str === 'string'
                  ? ui.new_str
                  : null;
          }

          // Attempt staging with enriched content
          if (enrichedContent) {
            try {
              const stagingResult = await stageOrDeny({
                toolName,
                toolInput,
                filePath: earlyFilePath,
                coreDirectory,
                sessionId,
                originalSessionId,
                turnId,
                spaceName: sharedSkillProtection.target.spaceName,
                blockedBy: 'structural_policy',
                blockReason: summary,
                summary,
                content: enrichedContent,
                sharing: sharedSkillProtection.target.sharing,
                approvalKind: 'shared_skill_checkpoint',
                authorLabel: sharedSkillProtection.authorLabel,
                toolUseId,
                supersededToolUseId: undefined,
              });

              if (stagingResult) {
                // Staging succeeded — dual-broadcast approval for cross-surface parity (cloud/mobile)
                await broadcastApprovalRequest(
                  {
                    toolUseId,
                    originalTurnId,
                    originalSessionId,
                    destination: {
                      path: earlyFilePath,
                      spaceName: sharedSkillProtection.target.spaceName,
                      spacePath: sharedSkillProtection.target.spacePath,
                      sharing: sharedSkillProtection.target.sharing,
                      isNew: false,
                    },
                    summary,
                    contentPreview: summary,
                    hasSpaceOverride: false,
                    privateMode: privateMode ?? false,
                    blockedBy: 'structural_policy',
                    approvalIdentifier: sharedSkillProtection.approvalIdentifier,
                    approvalKind: 'shared_skill_checkpoint',
                    authorLabel: sharedSkillProtection.authorLabel,
                    staged: true,
                    timestamp: Date.now(),
                  },
                  {
                    turnId,
                    sessionId,
                    originalSessionId,
                    filePath: earlyFilePath,
                    content: enrichedContent,
                  },
                );

                return stagingResult.output;
              }
            } catch (error) {
              log.error(
                { err: error, filePath: earlyFilePath },
                'Failed to stage shared skill checkpoint, falling back to blocking approval'
              );
            }
          }

          // Staging failed or enrichment produced no content — fall back to blocking approval.
          // Lock stays held (acquired above) for the blocking path.
          const content = extractContent(toolName, toolInput);

          await broadcastApprovalRequest(
            {
              toolUseId,
              originalTurnId,
              originalSessionId,
              destination: {
                path: earlyFilePath,
                spaceName: sharedSkillProtection.target.spaceName,
                spacePath: sharedSkillProtection.target.spacePath,
                sharing: sharedSkillProtection.target.sharing,
                isNew: false,
              },
              summary,
              contentPreview: summary,
              hasSpaceOverride: false,
              privateMode: privateMode ?? false,
              blockedBy: 'structural_policy',
              approvalIdentifier: sharedSkillProtection.approvalIdentifier,
              approvalKind: 'shared_skill_checkpoint',
              authorLabel: sharedSkillProtection.authorLabel,
              timestamp: Date.now(),
            },
            {
              turnId,
              sessionId,
              originalSessionId,
              filePath: earlyFilePath,
              content,
            },
          );

          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `SHARED SKILL CHECKPOINT - WAITING FOR USER CONFIRMATION

"${sharedSkillProtection.skillName}" was created by ${sharedSkillProtection.authorLabel}. This is a shared skill — other people use it. Rebel is pausing before updating it.

The write has NOT happened yet.

Do NOT retry this write or work around it with other tools.

If the user confirms, you will receive a continuation message telling you to re-run the operation once.
If they decline, offer to create their own version instead.`,
            },
          };
        }
      }
    }

    // Layer 1: Block Bash commands that reference checkpoint-locked file paths.
    // This catches scripting bypasses (Python path.write_text(), perl, etc.)
    // that extractBashWriteTargets cannot parse.
    if (toolName === 'Bash') {
      const command = (toolInput as { command?: string })?.command;
      if (command) {
        const lockCheck = bashCommandTargetsLockedPath(turnId, command);
        if (lockCheck.locked) {
          log.warn(
            { event: 'CHECKPOINT_BASH_BLOCKED', turnId, matchedPath: lockCheck.matchedPath, toolUseId },
            '[AUDIT] Bash command blocked — references a checkpoint-locked shared skill file'
          );
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `BLOCKED — This file is pending a shared skill checkpoint.

The Bash command references "${lockCheck.matchedPath}", which is locked by a shared skill checkpoint awaiting user confirmation.

Do NOT attempt to write to this file through any tool until the checkpoint is resolved.`,
            },
          };
        }
      }
    }

    // AUTOMATION MEMORY WRITE SAFETY: For automation sessions, memory writes
    // go through the structural pre-filter (resolveMemorySafetyLevel) first,
    // then Safety Prompt evaluation for balanced levels. Cautious always stages.
    // Permissive (CoS) auto-approves. Blocked writes are staged for user review.
    if (isAutomationSession && isFileWriteTool(toolName)) {
      const automationContext = getAutomationContext(sessionId);
      const automationId = automationContext?.automationId ?? 'unknown';

      // rebel-system protection — unconditionally read-only
      let automationFilePath = extractFilePath(toolName, toolInput);
      if (automationFilePath && isProtectedSystemPath(automationFilePath, coreDirectory)) {
        log.warn(
          { event: 'SYSTEM_PATH_BLOCKED', filePath: automationFilePath, toolName, automationId },
          '[AUDIT] Automation write to rebel-system blocked — directory is read-only'
        );
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `BLOCKED — rebel-system is read-only

The target path "${automationFilePath}" is inside rebel-system/, which contains bundled system files and must not be modified.

Save your files to a writable space instead (e.g. Chief-of-Staff/skills/ for custom skills, or the appropriate space for other content).

If you are trying to personalize a built-in skill, use the customise-and-extend-skill workflow (rebel-system/skills/system/customise-and-extend-skill/SKILL.md) to create a layered extension.`,
          },
        };
      }

      // Extract file path — fail-closed if extraction fails
      if (!automationFilePath) {
        log.warn({ toolName, automationId }, 'Automation memory: could not extract file path');
        if (turnId) agentTurnRegistry.recordSecurityDenial(turnId, toolName, 'Could not determine file destination');
        agentTurnRegistry.incrementAutomationSafetyBlock(sessionId);
        return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const,
          permissionDecisionReason: 'BLOCKED — Could not determine file destination.' } };
      }

      // Block direct writes to memory/pending/ — staging is handled by this hook.
      if (isMemoryPendingPath(automationFilePath)) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              'Do not write directly to memory/pending/. Write to the intended destination space and the system will handle staging automatically if approval is needed.',
          },
        };
      }

      // Migration gate FIRST (before any bypasses — consistent with toolSafetyService)
      if (!isMigrationComplete()) {
        log.warn({ toolName, sessionId }, 'Safety Prompt migration not complete — blocking');
        const migrationStagingResult = await stageAutomationMemoryWriteBlock({
          toolName, toolInput, sessionId, turnId, originalSessionId,
          coreDirectory, blockReason: 'Safety system initializing — please try again shortly',
          blockedBy: 'structural_policy',
          automationId,
        });
        if (migrationStagingResult) return migrationStagingResult;
        // Staging failed — hard-deny + circuit breaker
        if (turnId) agentTurnRegistry.recordSecurityDenial(turnId, toolName, 'Safety system initializing — staging failed');
        agentTurnRegistry.incrementAutomationSafetyBlock(sessionId);
        return { continue: false, hookSpecificOutput: { hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const, permissionDecisionReason: 'Safety system initializing' } };
      }

      // Resolve space info (needed for structural pre-filter and context).
      // If the agent used a bare space name (e.g., "General/file.md"), the resolver
      // corrects it to the full workspace-relative path and we use that downstream.
      const automationSpaceInfo = await resolveSpaceFromPath(automationFilePath, coreDirectory);
      if (automationSpaceInfo?.correctedFilePath) {
        log.info(
          { originalPath: automationFilePath, correctedPath: automationSpaceInfo.correctedFilePath, spaceName: automationSpaceInfo.spaceName },
          'Automation: using corrected file path for staging',
        );
        automationFilePath = automationSpaceInfo.correctedFilePath;
        // Propagate to tool input so auto-approved writes land at the correct path
        if (typeof toolInput.file_path === 'string') toolInput.file_path = automationFilePath;
        else if (typeof toolInput.path === 'string') toolInput.path = automationFilePath;
        else if (typeof toolInput.filePath === 'string') toolInput.filePath = automationFilePath;
      }
      let automationSpaceName: string;
      if (automationSpaceInfo) {
        automationSpaceName = automationSpaceInfo.spaceName;
      } else {
        const { displayLabel } = classifyUnmatchedPath(automationFilePath, coreDirectory);
        automationSpaceName = displayLabel;
      }
      const automationSpacePath = automationSpaceInfo?.spacePath || null;
      const automationSharing = automationSpaceInfo?.sharing;

      // Structural pre-filter via resolveMemorySafetyLevel()
      const automationSettings = getSettings();

      // ── SOURCE CAPTURE SAFETY GATE ────────────────────────────────────
      // Source-capture automations must write ONLY to Chief-of-Staff.
      // This is a deterministic code gate — prompts handle quality,
      // code handles security. The gate fires BEFORE the Safety Prompt
      // evaluation so source-capture writes never reach the LLM backstop.
      // See docs/plans/260418_source_capture_chief_of_staff_only.md (A3).
      if (automationContext?.automationId === SOURCE_CAPTURE_AUTOMATION_ID) {
        try {
          const isCoS = isVerifiedChiefOfStaff(automationSpacePath, automationSettings);
          if (!isCoS) {
            log.warn(
              {
                event: 'SOURCE_CAPTURE_SHARED_SPACE_BLOCKED',
                originalSpace: automationSpaceName,
                originalPath: automationFilePath,
                sessionId,
                turnId,
                automationId: SOURCE_CAPTURE_AUTOMATION_ID,
              },
              '[AUDIT] Source capture write to non-CoS space blocked — hard deny'
            );

            // Hard deny (not staging). Staging would preserve the shared-space
            // destination and let the user approve it there, defeating the gate.
            // The agent receives a clear error and should retry to CoS.
            if (turnId) {
              agentTurnRegistry.recordSecurityDenial(
                turnId,
                toolName,
                'Source capture: shared-space write blocked by structural policy'
              );
            }
            agentTurnRegistry.incrementAutomationSafetyBlock(sessionId);
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason:
                  'Source capture is restricted to Chief-of-Staff. Write to Chief-of-Staff/memory/sources/ instead.',
              },
            };
          }
        } catch (gateError) {
          // FAIL-CLOSED: if the gate itself errors, deny the write.
          log.error(
            {
              err: gateError,
              event: 'SOURCE_CAPTURE_GATE_ERROR',
              filePath: automationFilePath,
              sessionId,
              turnId,
            },
            '[AUDIT] Source capture safety gate error — denying write (fail-closed)'
          );
          if (turnId) {
            agentTurnRegistry.recordSecurityDenial(
              turnId,
              toolName,
              'Source capture safety gate error — fail-closed deny'
            );
          }
          agentTurnRegistry.incrementAutomationSafetyBlock(sessionId);
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason:
                'Source capture safety check failed — write to Chief-of-Staff/memory/sources/ instead.',
            },
          };
        }
      }

      const { level: automationResolvedLevel } = resolveMemorySafetyLevel(
        automationSpacePath, automationSharing, automationSettings, privateMode ?? false
      );

      // Check for existing pending staged write (prevent overwrite conflicts)
      const automationExistingPending = normalizePendingLookupResult(
        await getPendingFileByDestination(automationFilePath),
      );
      if (automationExistingPending.kind !== 'none') {
        const pendingFileLabel = automationExistingPending.kind === 'found'
          ? automationExistingPending.file.filename
          : path.basename(automationExistingPending.filePath);
        if (automationExistingPending.kind === 'candidate_unreadable') {
          log.warn(
            {
              automationFilePath,
              spaceName: automationSpaceName,
              pendingFilePath: automationExistingPending.filePath,
              reason: automationExistingPending.reason,
            },
            'Automation: unreadable pending candidate detected — blocking duplicate defensively'
          );
        } else {
          log.info(
            { automationFilePath, spaceName: automationSpaceName, pendingFile: automationExistingPending.file.filename },
            'Automation: file already has pending staged write — blocking duplicate'
          );
        }
        return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const,
          permissionDecisionReason: `FILE ALREADY PENDING REVIEW\nA previous write to this file is already staged.\n- Staged file: ${pendingFileLabel}` } };
      }

      // Permissive (e.g., Chief-of-Staff, private spaces) → auto-approve + track
      if (automationResolvedLevel === 'permissive') {
        // Private spaces and verified CoS skip the secret gate (same rationale as interactive path).
        // Shared helper ensures identical authority semantics across both branches (FOX-3072).
        if (shouldSkipSecretGateForPermissive(automationSpacePath, automationSettings, automationSharing)) {
          log.debug({ filePath: automationFilePath, spaceName: automationSpaceName, toolName },
            'Automation: auto-approving write (permissive private/CoS space, secret gate skipped)');
          const { hasSpaceOverride: automationHasSpaceOverride } = resolveMemorySafetyLevel(
            automationSpacePath, automationSharing, automationSettings, privateMode ?? false);
          const automationIsCoS = automationSpaceInfo?.spaceType === 'chief-of-staff' || isVerifiedChiefOfStaff(automationSpacePath, automationSettings);
          const autoReason: AutoApproveReason = automationIsCoS
            ? 'private_space'
            : automationHasSpaceOverride
              ? 'space_override_permissive'
              : 'private_space';
          summarizeContent(extractContent(toolName, toolInput))
            .then(summary => trackMemoryWrite(automationFilePath, automationSpaceName, summary, originalSessionId, toolName === 'Create', coreDirectory, autoReason, automationSharing))
            .catch(err => log.warn({ err, filePath: automationFilePath }, 'Failed to track automation private space write'));
          return {};
        }

        // SECRET GATE: Non-private permissive (user explicitly set `permissive` on a shared
        // space). Falls through to LLM-eval branch after the credential check.
        const automationNonInspectable = isNonInspectableBashWrite(toolName, toolInput);
        const secretGateTriggered = (() => {
          if (automationNonInspectable) return { triggered: true, reason: 'non_inspectable_bash' };
          const contentForCheck = extractContent(toolName, toolInput);
          const result = containsCredentialPatterns(contentForCheck);
          if (result.detected) return { triggered: true, reason: result.reasons[0] };
          return { triggered: false, reason: undefined };
        })();

        if (secretGateTriggered.triggered) {
          log.info(
            { toolName, filePath: automationFilePath, spaceName: automationSpaceName, reason: secretGateTriggered.reason },
            'Secret gate: credentials/non-inspectable content detected in automation permissive write, staging for approval'
          );
          const secretStagingResult = await stageAutomationMemoryWriteBlock({
            toolName, toolInput, sessionId, turnId, originalSessionId,
            coreDirectory,
            blockReason: 'Possible credentials detected — review before saving',
            blockedBy: 'structural_policy',
            automationId,
            summary: 'Possible credentials detected — review before saving',
            sharing: automationSharing,
          });
          if (secretStagingResult) return secretStagingResult;
          // Staging failed — hard-deny
          if (turnId) agentTurnRegistry.recordSecurityDenial(turnId, toolName, 'Secret gate: staging failed for automation write');
          agentTurnRegistry.incrementAutomationSafetyBlock(sessionId);
          return { continue: false, hookSpecificOutput: { hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const, permissionDecisionReason: 'Possible credentials detected — write blocked for review' } };
        }

        // Non-private permissive: fall through to the Safety Prompt evaluation below.
        // Bypassing the LLM here would let HR / legal / PII content auto-approve based
        // only on the credential gate. (260525_approval_overasking_diagnostic.md.)
        log.debug({ toolName, automationFilePath, spaceName: automationSpaceName }, 'Automation permissive shared space: deferring to LLM eval');
      }

      // Cautious (private mode, unknown path) → ALWAYS stage, Safety Prompt cannot override
      if (automationResolvedLevel === 'cautious') {
        log.info({ toolName, automationFilePath, spaceName: automationSpaceName }, 'Cautious level — staging without eval');
        const cautiousStagingResult = await stageAutomationMemoryWriteBlock({
          toolName, toolInput, sessionId, turnId, originalSessionId,
          coreDirectory, blockReason: 'Memory write requires approval (cautious level)',
          blockedBy: 'structural_policy',
          automationId,
          sharing: automationSharing,
        });
        if (cautiousStagingResult) return cautiousStagingResult;
        // Staging failed — hard-deny + circuit breaker
        if (turnId) agentTurnRegistry.recordSecurityDenial(turnId, toolName, 'Cautious: automation memory write blocked');
        agentTurnRegistry.incrementAutomationSafetyBlock(sessionId);
        return { continue: false, hookSpecificOutput: { hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const, permissionDecisionReason: 'Memory write requires approval' } };
      }

      // Balanced → run Safety Prompt evaluation
      const safetyPrompt = getSafetyPrompt();
      const promptVersion = getSafetyPromptVersion();
      const evalToolInput: Record<string, unknown> = { ...toolInput };
      if (typeof evalToolInput.content === 'string' && evalToolInput.content.length > 2000) {
        evalToolInput.content = evalToolInput.content.slice(0, 2000) + '... [truncated]';
      }
      const automationSpaceReadmePreview = await getSpaceReadmePreview(automationSpaceInfo);
      const automationSpaceSharingContext = buildActionContextSpaceSharing(automationSpaceInfo);
      // Stage 2 (260529_memory_write_intent_context_parity.md) — resolve
      // session intent against the **user conversation** session id
      // (`originalSessionId`), NOT the hook's `sessionId` (which is `turnId`
      // for interactive turns and therefore has no user messages).
      // userIntentExplicit is intentionally deferred per the plan.
      const automationMemorySessionIntentRaw = await resolveSessionIntent(originalSessionId);
      const automationMemorySessionIntent = automationMemorySessionIntentRaw
        && automationMemorySessionIntentRaw.recentUserMessages.length > 0
          ? automationMemorySessionIntentRaw
          : undefined;
      const actionContext: ActionContext = {
        toolName,
        toolInput: evalToolInput,
        sessionType: 'automation',
        automationName: automationContext?.automationName,
        spaceDescription: automationSpaceInfo?.description,
        spaceLabel: automationSpaceInfo?.spaceName,
        spaceSharing: automationSpaceSharingContext,
        spaceReadmePreview: automationSpaceReadmePreview,
        // Inline spread (a shared assembly helper was considered but descoped —
        // see plan 260529; drift between this and the tool path is guarded by a
        // cross-path test instead of a hot-path refactor).
        // userMessage is structurally optional on the memory hook (the tool path
        // sets it unconditionally), so we truthy-guard here. The two are
        // equivalent at the rendered-prompt layer — buildEvalUserMessage skips an
        // empty userMessage. sessionIntent null/empty → undefined (additive-only).
        ...(userMessage ? { userMessage } : {}),
        ...(automationMemorySessionIntent ? { sessionIntent: automationMemorySessionIntent } : {}),
      };
      if (automationMemorySessionIntent) {
        log.info(
          {
            event: 'safety.session_intent_injected',
            sessionId: originalSessionId,
            toolName,
            messageCount: automationMemorySessionIntent.recentUserMessages.length,
            totalChars: automationMemorySessionIntent.totalChars,
          },
          'Session intent attached to automation memory-write safety eval',
        );
      }

      // Safety-eval progress (automation memory-write path).
      const automationMemStartedAt = Date.now();
      let automationMemOutcomeBroadcast = false;
      const emitAutomationMemComplete = (outcome: ToolSafetyEvaluatingCompletePayload['outcome']) => {
        if (automationMemOutcomeBroadcast) return;
        automationMemOutcomeBroadcast = true;
        broadcastMemorySafetyEvaluatingComplete({
          toolUseId,
          sessionId,
          turnId: turnId ?? '',
          outcome,
        });
      };
      broadcastMemorySafetyEvaluating({
        toolUseId,
        sessionId,
        turnId: turnId ?? '',
        toolName,
        attempt: 1,
        startedAt: automationMemStartedAt,
      });

      try {
        const evalResult = await evaluateSafetyPrompt(safetyPrompt, promptVersion, actionContext, {
          signal: evalSignal,
          onAttempt: (attempt) => {
            if (attempt <= 1) return;
            broadcastMemorySafetyEvaluating({
              toolUseId,
              sessionId,
              turnId: turnId ?? '',
              toolName,
              attempt,
              startedAt: automationMemStartedAt,
            });
          },
        });
        // Permissive on a non-private shared space → relax the side-effect
        // floor to medium so routine writes auto-allow without surfacing an
        // approval card. (260525_approval_overasking_diagnostic.md.)
        const allowed = shouldAllow(evalResult, toolName, {
          confidenceFloor: automationResolvedLevel === 'permissive' ? 'medium' : 'high',
        });

        // Activity log entry + broadcast
        addEvaluationEntry({
          toolDisplayName: `Memory: ${toolName}`,
          toolId: toolName,
          actionSummary: `${toolName} → ${automationSpaceName}: ${automationFilePath}`,
          decision: allowed ? 'allowed' : 'blocked',
          reason: evalResult.reason || '',
          sessionType: 'automation',
          automationName: automationContext?.automationName,
          flagged: false,
        });
        getBroadcastService().sendToAllWindows('safety-activity-log:updated', { timestamp: Date.now() });

        // If allowed → permit the write + track
        if (allowed) {
          log.info({ toolName, filePath: automationFilePath, spaceName: automationSpaceName, reason: evalResult.reason },
            'Safety Prompt: allowed automation memory write');
          if (turnId) agentTurnRegistry.recordToolCall(turnId, toolName, toolInput);
          summarizeContent(extractContent(toolName, toolInput))
            .then(summary => {
              trackMemoryWrite(automationFilePath, automationSpaceName, summary, originalSessionId,
                toolName === 'Create', coreDirectory, 'safety_prompt_allowed', automationSharing);
            })
            .catch(err => log.warn({ err }, 'Failed to track allowed automation write'));
          emitAutomationMemComplete('allowed');
          return {};
        }

        // If blocked due to fail-closed evaluator outage → stage with honest eval_error copy.
        if (evalResult.failClosed) {
          log.warn(
            { toolName, automationId, turnId, sessionId, failClosedReason: evalResult.failClosedReason },
            'Safety eval fail-closed — staging automation memory write as eval_error',
          );
          try {
            const evalErrorStageResult = await stageAutomationMemoryWriteBlock({
              toolName, toolInput, sessionId, turnId, originalSessionId,
              coreDirectory, blockReason: buildEvalErrorAgentReason(toolName),
              blockedBy: 'eval_error',
              automationId,
              sharing: automationSharing,
              coalesceKey: buildMemoryEvalErrorCoalesceKey(automationSpaceName, automationFilePath),
              skipCircuitBreaker: true,
            });
            if (evalErrorStageResult) {
              emitAutomationMemComplete('staged');
              return evalErrorStageResult;
            }
          } catch (stageErr) {
            log.warn(
              { toolName, automationId, turnId, sessionId, stageErr },
              'Safety eval fail-closed staging failed for automation memory write',
            );
          }
          // Staging unavailable → honest deny. Record the denial exactly once here
          // (the staging-success path records inside stageAutomationMemoryWriteBlock).
          // NO circuit-breaker increment — FOX-3231: a transient eval outage must not
          // trip the automation kill switch.
          if (turnId) {
            agentTurnRegistry.recordSecurityDenial(turnId, toolName, 'Safety eval fail-closed — staging unavailable, blocked for approval');
          }
          emitAutomationMemComplete('error');
          return buildEvalErrorMemoryDenyOutput();
        }

        // If blocked by policy → stage with the actual eval reason
        log.info({ toolName, filePath: automationFilePath, spaceName: automationSpaceName, reason: evalResult.reason },
          'Safety Prompt: blocked automation memory write');
        const evalStagingResult = await stageAutomationMemoryWriteBlock({
          toolName, toolInput, sessionId, turnId, originalSessionId,
          coreDirectory, blockReason: evalResult.reason,
          blockedBy: 'safety_prompt',
          automationId,
          sharing: automationSharing,
        });
        if (evalStagingResult) {
          emitAutomationMemComplete('staged');
          return evalStagingResult;
        }

        // Hard-deny fallback if staging fails
        if (turnId) agentTurnRegistry.recordSecurityDenial(turnId, toolName, `Safety Rules blocked: ${evalResult.reason}`);
        agentTurnRegistry.incrementAutomationSafetyBlock(sessionId);
        emitAutomationMemComplete('blocked');
        return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const,
          permissionDecisionReason: `Memory write blocked: ${evalResult.reason}` } };

      } catch (err) {
        // AbortError → allow (turn is being cancelled — same as toolSafetyService)
        if (err instanceof Error && err.name === 'AbortError') {
          log.debug({ toolName }, 'Safety Prompt evaluation aborted — allowing (turn cancelling)');
          emitAutomationMemComplete('aborted');
          return {};
        }
        // Other errors → fail-closed eval_error stage; fallback to honest deny.
        log.warn(
          { toolName, automationId, turnId, sessionId, err },
          'Safety eval error — staging automation memory write as eval_error',
        );
        try {
          const evalErrorStageResult = await stageAutomationMemoryWriteBlock({
            toolName, toolInput, sessionId, turnId, originalSessionId,
            coreDirectory, blockReason: buildEvalErrorAgentReason(toolName),
            blockedBy: 'eval_error',
            automationId,
            sharing: automationSharing,
            coalesceKey: buildMemoryEvalErrorCoalesceKey(automationSpaceName, automationFilePath),
            skipCircuitBreaker: true,
          });
          if (evalErrorStageResult) {
            emitAutomationMemComplete('staged');
            return evalErrorStageResult;
          }
        } catch (stageErr) {
          log.warn(
            { toolName, automationId, turnId, sessionId, stageErr },
            'Safety eval error staging failed for automation memory write',
          );
        }
        // Staging unavailable → honest deny. Record the denial exactly once here
        // (the staging-success path records inside stageAutomationMemoryWriteBlock).
        // NO circuit-breaker increment — FOX-3231: a transient eval outage must not
        // trip the automation kill switch.
        if (turnId) {
          agentTurnRegistry.recordSecurityDenial(turnId, toolName, 'Safety eval error — staging unavailable, blocked for approval');
        }
        emitAutomationMemComplete('error');
        return buildEvalErrorMemoryDenyOutput();
      }
    }

    // Handle Bash commands that may write files to memory spaces
    // This catches writes via redirection (> file), tee, cp, mv that bypass FILE_WRITE_TOOLS
    // Security context: User may have trusted Bash for read-only operations (e.g., BigQuery queries)
    // but subagents can use Bash to write files, bypassing Memory Safety
    let isBashWrite = false;
    if (toolName === 'Bash') {
      const command = (toolInput as { command?: string })?.command;
      const writeTargets = extractBashWriteTargets(command ?? '');
      
      if (!writeTargets || writeTargets.length === 0) {
        // No write operation detected, allow Bash command
        return {};
      }
      
      // Bash write detected - evaluate all targets, find most restrictive space
      // Note: We intentionally don't log the full command to avoid leaking secrets
      // (curl with tokens, SQL with credentials, etc.)
      log.info(
        { 
          event: 'BASH_WRITE_DETECTED',
          targetCount: writeTargets.length,
          targets: writeTargets,
          turnId,
          sessionId,
        },
        '[AUDIT] Bash command with file write targets detected'
      );
      
      // Find the most restrictive space among all targets
      let mostRestrictiveSpace: ResolvedSpace | null = null;
      let mostRestrictivePath: string | null = null;
      const sharingOrder = ['private', 'restricted', 'company-wide', 'public'] as const;
      
      for (const target of writeTargets) {
        // Hard-block writes to rebel-system — it's read-only, no exceptions
        if (isProtectedSystemPath(target, coreDirectory)) {
          log.warn(
            { event: 'SYSTEM_PATH_BLOCKED', target, toolName },
            '[AUDIT] Bash write to rebel-system blocked — directory is read-only'
          );
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: getProtectedPathDenyReason(target),
            },
          };
        }

        // Layer 2: Bash write targets go through the same shared skill checkpoint
        // as Edit/Write instead of a blanket "use managed tools" denial.
        const currentUser = getCurrentUserSnapshot();
        const bashSharedSkillProtection = await sharedSkillMutationService.getNonAuthorSharedSkillProtectionContext(
          target,
          coreDirectory,
          currentUser,
        );
        if (bashSharedSkillProtection) {
          const preflightBeforeBashSharedSkillApproval = await checkExistingPendingPreflight({
            filePath: target,
            toolName,
            toolInput,
            sessionId,
            originalSessionId,
            turnId,
            coreDirectory,
            toolUseId,
            spaceName: bashSharedSkillProtection.target.spaceName,
            sharing: bashSharedSkillProtection.target.sharing,
            dryRun: isMcpServerMode,
          });
          if (!isMcpServerMode && preflightBeforeBashSharedSkillApproval) {
            return preflightBeforeBashSharedSkillApproval;
          }

          const bashHasApproval = consumeSingleUseApproval('memory', sessionId, bashSharedSkillProtection.approvalIdentifier)
            || (originalSessionId !== sessionId && consumeSingleUseApproval('memory', originalSessionId, bashSharedSkillProtection.approvalIdentifier));
          if (!bashHasApproval) {
            const bashSummary = buildSharedSkillCheckpointSummary(
              bashSharedSkillProtection.skillName,
              bashSharedSkillProtection.authorLabel,
            );
            await broadcastApprovalRequest(
              {
                toolUseId: toolUseId ?? `bash-${Date.now()}`,
                originalTurnId,
                originalSessionId,
                destination: {
                  path: target,
                  spaceName: bashSharedSkillProtection.target.spaceName,
                  spacePath: bashSharedSkillProtection.target.spacePath,
                  sharing: bashSharedSkillProtection.target.sharing,
                  isNew: false,
                },
                summary: bashSummary,
                contentPreview: bashSummary,
                hasSpaceOverride: false,
                privateMode: privateMode ?? false,
                blockedBy: 'structural_policy',
                approvalIdentifier: bashSharedSkillProtection.approvalIdentifier,
                approvalKind: 'shared_skill_checkpoint',
                authorLabel: bashSharedSkillProtection.authorLabel,
                timestamp: Date.now(),
              },
              {
                turnId,
                sessionId,
                originalSessionId,
                filePath: target,
                content: `Bash command targeting shared skill: ${target}`,
              },
            );
            await lockPathForCheckpoint(turnId, target, coreDirectory);
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: `SHARED SKILL CHECKPOINT - WAITING FOR USER CONFIRMATION

"${bashSharedSkillProtection.skillName}" was created by ${bashSharedSkillProtection.authorLabel}. This is a shared skill — other people use it. Rebel is pausing before updating it.

The Bash command targets "${bashSharedSkillProtection.target.relativePath}".

The write has NOT happened yet.

Do NOT retry this write or work around it with other tools.
Use Create, Write, or Edit on the skill file directly so Rebel can preserve collaboration metadata and version history.`,
              },
            };
          }
        }
        // Also block Bash writes to shared skills that the user IS the author of —
        // collaboration metadata can't be maintained through Bash writes.
        const sharedSkillTarget = await sharedSkillMutationService.classifySharedSkillPath(target, coreDirectory);
        if (sharedSkillTarget) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `Shared skills must be edited through Rebel's managed file-write tools.

The Bash command targets "${sharedSkillTarget.relativePath}", which is a shared skill file.

Use Create, Write, or Edit on the skill file directly so Rebel can preserve collaboration metadata and version history.`,
            },
          };
        }

        const targetSpaceInfo = await resolveSpaceFromPath(target, coreDirectory);
        if (targetSpaceInfo) {
          // SECURITY: Treat undefined sharing as 'public' (most restrictive)
          // Unknown/legacy spaces should be treated conservatively so that
          // the most restrictive space wins when resolving safety level
          const currentIndex = sharingOrder.indexOf(targetSpaceInfo.sharing ?? 'public');
          const bestIndex = mostRestrictiveSpace 
            ? sharingOrder.indexOf(mostRestrictiveSpace.sharing ?? 'public')
            : -1;
          
          // Higher index = more shared = more restrictive for approval purposes
          if (currentIndex > bestIndex) {
            mostRestrictiveSpace = targetSpaceInfo;
            mostRestrictivePath = target;
          }
        }
      }
      
      if (!mostRestrictiveSpace) {
        // No targets match any space - not writing to memory, allow
        log.debug({ writeTargets }, 'Bash write targets not in any memory space, allowing');
        return {};
      }
      
      // Cache the resolved space info for use in the rest of the hook
      (toolInput as Record<string, unknown>).__bashTargetPath = mostRestrictivePath;
      (toolInput as Record<string, unknown>).__bashSpaceInfo = mostRestrictiveSpace;
      isBashWrite = true;
      
      log.debug(
        { 
          mostRestrictivePath, 
          spaceName: mostRestrictiveSpace.spaceName,
          sharing: mostRestrictiveSpace.sharing,
        },
        'Using most restrictive space for Bash write evaluation'
      );

      // ── SOURCE CAPTURE SAFETY GATE (Bash write path) ─────────────────
      // Mirrors the file-write gate above. Bash commands that target a
      // non-CoS space from a source-capture automation session are blocked
      // deterministically — we do not let prompts decide security.
      // See docs/plans/260418_source_capture_chief_of_staff_only.md (A3).
      if (isAutomationSession) {
        const bashAutomationContext = getAutomationContext(sessionId);
        if (bashAutomationContext?.automationId === SOURCE_CAPTURE_AUTOMATION_ID) {
          try {
            const bashSettings = getSettings();
            const bashSpacePath = mostRestrictiveSpace.spacePath || null;
            const bashIsCoS = isVerifiedChiefOfStaff(bashSpacePath, bashSettings);
            if (!bashIsCoS) {
              log.warn(
                {
                  event: 'SOURCE_CAPTURE_SHARED_SPACE_BLOCKED',
                  originalSpace: mostRestrictiveSpace.spaceName,
                  originalPath: mostRestrictivePath,
                  sessionId,
                  turnId,
                  automationId: SOURCE_CAPTURE_AUTOMATION_ID,
                  toolName,
                },
                '[AUDIT] Source capture Bash write to non-CoS space blocked — hard deny'
              );

              // Hard deny (not staging) — same rationale as Gate 1.
              if (turnId) {
                agentTurnRegistry.recordSecurityDenial(
                  turnId,
                  toolName,
                  'Source capture: shared-space Bash write blocked by structural policy'
                );
              }
              agentTurnRegistry.incrementAutomationSafetyBlock(sessionId);
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                  permissionDecisionReason:
                    'Source capture is restricted to Chief-of-Staff. Write to Chief-of-Staff/memory/sources/ instead.',
                },
              };
            }
          } catch (gateError) {
            // FAIL-CLOSED: deny if the gate itself errors.
            log.error(
              {
                err: gateError,
                event: 'SOURCE_CAPTURE_GATE_ERROR',
                filePath: mostRestrictivePath,
                sessionId,
                turnId,
              },
              '[AUDIT] Source capture safety gate error (Bash path) — denying write (fail-closed)'
            );
            if (turnId) {
              agentTurnRegistry.recordSecurityDenial(
                turnId,
                toolName,
                'Source capture safety gate error (Bash) — fail-closed deny'
              );
            }
            agentTurnRegistry.incrementAutomationSafetyBlock(sessionId);
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason:
                  'Source capture safety check failed — write to Chief-of-Staff/memory/sources/ instead.',
              },
            };
          }
        }
      }
    }
    
    // Only intercept file write tools (or Bash writes detected above)
    if (!isBashWrite && !isFileWriteTool(toolName)) {
      return {};
    }

    // Extract file path - use cached Bash target if available
    let filePath = (toolInput as Record<string, unknown>).__bashTargetPath as string | undefined
      ?? extractFilePath(toolName, toolInput);
    if (!filePath) {
      log.warn({ toolName }, 'Could not extract file path, allowing write');
      return {};
    }

    // Block direct writes to memory/pending/ — staging is handled by this hook.
    if (isMemoryPendingPath(filePath)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            'Do not write directly to memory/pending/. Write to the intended destination space and the system will handle staging automatically if approval is needed.',
        },
      };
    }
    
    // Hard-block writes to rebel-system — read-only, no exceptions.
    // This check runs before ALL bypass paths (MCP server mode, safety rules, etc.)
    // so rebel-system is always protected. Bash writes are also checked earlier
    // in the per-target loop above.
    if (isProtectedSystemPath(filePath, coreDirectory)) {
      log.warn(
        { event: 'SYSTEM_PATH_BLOCKED', filePath, toolName },
        '[AUDIT] Write to rebel-system blocked — directory is read-only'
      );
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: getProtectedPathDenyReason(filePath),
        },
      };
    }

    // Plugin source files must be updated via rebel_plugins_create, not filesystem
    // edits. Direct Edit/Write would otherwise route through the space-safety
    // approval ladder (one approval per write) AND bypass the AST/compile
    // validation that rebel_plugins_create performs server-side.
    // See docs/plans/260527_plugin_agent_experience_overhaul.md — Stage 1.
    const pluginDetection = await detectPluginSourceFile(filePath, coreDirectory);
    if (pluginDetection.denyReason) {
      // Manifest probe failed with an unexpected error — fail closed.
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: pluginDetection.denyReason,
        },
      };
    }
    if (pluginDetection.pluginId) {
      const pluginId = pluginDetection.pluginId;
      log.warn(
        { event: 'PLUGIN_FILE_WRITE_BLOCKED', filePath, pluginId, toolName },
        '[AUDIT] Direct filesystem write to plugin source blocked — redirecting agent to rebel_plugins_create',
      );
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: [
            `Direct filesystem writes to plugin source files are not supported.`,
            ``,
            `Plugin "${pluginId}" must be updated via the rebel_plugins_create MCP tool:`,
            ``,
            `  rebel_plugins_create({ id: "${pluginId}", name: "...", source: "<full updated TSX>" })`,
            ``,
            `This is a single tool call with a single approval. The write, AST validation,`,
            `compile, and live-reload happen atomically. Using Edit/Write instead bypasses`,
            `compile validation and triggers a separate approval prompt per write.`,
            ``,
            `If you need the current source, call rebel_plugins_get_source({ id: "${pluginId}" }) first.`,
          ].join('\n'),
        },
      };
    }

    if (!isBashWrite) {
      const currentUser = getCurrentUserSnapshot();
      const managedToolInput = await sharedSkillMutationService.prepareManagedToolInput(
        toolName,
        toolInput,
        coreDirectory,
        {
          kind: 'agent',
          user: currentUser,
        },
      );

      if (managedToolInput && 'denyReason' in managedToolInput) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: managedToolInput.denyReason,
          },
        };
      }

      if (managedToolInput) {
        for (const key of Object.keys(toolInput)) {
          delete toolInput[key];
        }
        Object.assign(toolInput, managedToolInput.updatedInput);
      }
    }

    const preflightBeforeMcpMode = await checkExistingPendingPreflight({
      filePath,
      toolName,
      toolInput,
      sessionId,
      originalSessionId,
      turnId,
      coreDirectory,
      toolUseId,
      dryRun: isMcpServerMode,
    });

    // MCP server mode: auto-approve all memory writes
    // User has opted in by enabling MCP server mode, and there's no UI for approval prompts.
    // Explicit override: even pending-review stickiness is bypassed in this mode.
    if (isMcpServerMode) {
      if (preflightBeforeMcpMode) {
        log.warn(
          {
            event: 'SECURITY_BYPASS',
            reason: 'MCP_SERVER_MODE_STICKINESS_OVERRIDE',
            toolName,
            filePath,
          },
          '[SECURITY] Existing pending-review stickiness bypassed because MCP server mode is active'
        );
      }
      log.warn(
        {
          event: 'SECURITY_BYPASS',
          reason: 'MCP_SERVER_MODE',
          toolName,
          timestamp: new Date().toISOString(),
        },
        '[AUDIT] Memory write safety bypassed - MCP server mode active'
      );
      return {};
    }

    if (preflightBeforeMcpMode) {
      return preflightBeforeMcpMode;
    }

    // Resolve space and get sharing config - use cached Bash space info if available
    const spaceInfo = (toolInput as Record<string, unknown>).__bashSpaceInfo as ResolvedSpace | undefined
      ?? await resolveSpaceFromPath(filePath, coreDirectory);
    if (spaceInfo?.correctedFilePath) {
      filePath = spaceInfo.correctedFilePath;
      // Propagate corrected path into tool input so the actual tool execution
      // writes to the correct location (not just the local variable for display).
      if (typeof toolInput.file_path === 'string') toolInput.file_path = filePath;
      else if (typeof toolInput.path === 'string') toolInput.path = filePath;
      else if (typeof toolInput.filePath === 'string') toolInput.filePath = filePath;
    }
    let spaceName: string;
    const spacePath = spaceInfo?.spacePath || '';
    const sharing = spaceInfo?.sharing;
    
    // If space resolution failed, classify the path and provide a better label
    let unmatchedClassification: UnmatchedFileClassification | null = null;
    if (!spaceInfo) {
      const { classification, displayLabel } = classifyUnmatchedPath(filePath, coreDirectory);
      unmatchedClassification = classification;
      spaceName = displayLabel;
      
      // Log at appropriate level based on classification
      // workspace_root is unexpected (likely misconfiguration), others are normal
      if (classification === 'workspace_root') {
        log.warn(
          { filePath, coreDirectory, classification },
          'File under workspace but not in any configured space - check space configuration'
        );
      } else {
        log.debug(
          { filePath, classification, displayLabel },
          'File not in a space (expected for this location)'
        );
      }
    } else {
      spaceName = spaceInfo.spaceName;
    }

    // Auto-approve temp directory writes — ephemeral files, no persistence risk.
    // Guard: if coreDirectory is under a temp path (demo mode), don't auto-approve
    // to prevent bypassing workspace safety. Also skip in private mode.
    if (unmatchedClassification === 'temp' && !privateMode) {
      // normalizeSafetyPath (collapse `.`/`..`/`//`) so this demo-mode suppressor
      // robustly detects a coreDirectory that lives under a temp path — consistent
      // with classifyUnmatchedPath's now-normalized temp containment check.
      const normalizedCore = normalizeSafetyPath(coreDirectory).toLowerCase();
      const tempDir = normalizeSafetyPath(os.tmpdir()).toLowerCase();
      const tempPaths = [tempDir, '/tmp', '/private/tmp', '/var/folders'];
      const coreUnderTemp = tempPaths.some(tp =>
        normalizedCore === tp || normalizedCore.startsWith(tp + '/'));
      if (!coreUnderTemp) {
        log.info(
          { filePath, spaceName, toolName },
          'Auto-approving temp directory write - ephemeral, no persistence risk'
        );
        return {};
      }
    }

    // Auto-approve inbox writes — managed by Rebel's own MCP tools,
    // only stores proposal items the user must explicitly act on.
    if (unmatchedClassification === 'inbox') {
      log.info(
        { filePath, spaceName, toolName },
        'Auto-approving inbox storage write'
      );
      return {};
    }

    // Get settings for memory safety resolution
    const settings = getSettings();

    // Determine effective trust level using simplified resolution
    // Resolution order: privateMode → unknown path → Chief-of-Staff → spaceSafetyLevels → default balanced
    const { level: resolvedLevel, hasSpaceOverride } = resolveMemorySafetyLevel(
      spacePath || null,
      sharing,
      settings,
      privateMode ?? false
    );

    const effectiveTrust: SafetyLevel = resolvedLevel;

    // Bash writes: effectiveTrust stays at resolvedLevel (typically 'balanced').
    // Safety Prompt evaluation runs on the Bash command string, enabling
    // the "Allow & choose rule update..." button in the approval UI.
    // CoS (permissive) auto-approves. Private mode / unknown path → cautious.
    if (isBashWrite && resolvedLevel === 'balanced') {
      log.info({ spaceName, sharing, toolName }, 'Bash write to balanced space — evaluating via Safety Prompt');
    }

    log.debug(
      { toolName, filePath, spaceName, spacePath, sharing, resolvedLevel, hasSpaceOverride, effectiveTrust, privateMode, isBashWrite },
      'Evaluating memory write'
    );

    const supersededToolUseId: string | undefined = undefined;

    // Check if this file has a single-use approval (via "Save" / "Allow once" click)
    // Uses shared sessionApprovals infrastructure with 'memory' domain
    // IMPORTANT: Check BOTH sessionId and originalSessionId because:
    // - Single-use approvals are stored against originalSessionId (main conversation)
    // - But retry may happen in a background turn with a different sessionId
    const hasSingleUseApproval = consumeSingleUseApproval('memory', sessionId, filePath)
      || (originalSessionId !== sessionId && consumeSingleUseApproval('memory', originalSessionId, filePath));
    if (hasSingleUseApproval) {
      log.info({ toolName, filePath, sessionId, originalSessionId }, 'Consumed single-use approval - allowing write');
      // Track this write with 'pre_approved' reason (fire-and-forget)
      // Skip tracking for background memory update turns (sessionId starts with 'memory-update-')
      // because they're tracked via broadcastMemoryUpdateStatus → addMemoryHistoryEntries
      // with better summaries from the skill output.
      const isMemoryUpdateTurn = isBackgroundMemoryUpdateTurn;
      if (!isMemoryUpdateTurn) {
        summarizeContent(extractContent(toolName, toolInput))
          .then(summary => {
            trackMemoryWrite(filePath, spaceName, summary, originalSessionId, toolName === 'Create', coreDirectory, 'pre_approved', sharing);
          })
          .catch(err => log.warn({ err, filePath }, 'Failed to track pre-approved write'));
      }
      return {};
    }
    
    // Auto-approve MCP server project writes (~/mcp-servers/).
    // User-initiated custom connector builds via build-custom-mcp-server skill.
    // Guards: skip in private mode, skip if workspace is under ~/mcp-servers.
    // Position: AFTER pending-file check to prevent bypassing pending reviews.
    if (unmatchedClassification === 'mcp_servers' && !privateMode) {
      try {
        const mcpDir = toPortablePath(
          path.join(getPlatformConfig().homePath, 'mcp-servers')
        ).toLowerCase();
        const normalizedCore = toPortablePath(coreDirectory).toLowerCase();
        const coreUnderMcpServers = normalizedCore === mcpDir ||
          normalizedCore.startsWith(mcpDir + '/');
        if (!coreUnderMcpServers) {
          const mcpContent = extractContent(toolName, toolInput);
          const mcpSecretResult = containsCredentialPatterns(mcpContent);
          if (mcpSecretResult.detected) {
            log.info(
              { filePath, reason: mcpSecretResult.reasons[0], toolName },
              'MCP servers: credentials detected, falling through to approval'
            );
            // Fall through to normal cautious path — credentials need review
          } else {
            log.info(
              { filePath, toolName },
              'Auto-approving MCP server project write'
            );
            return {};
          }
        }
      } catch {
        // getPlatformConfig may throw before bootstrap — fall through
      }
    }

    // Permissive mode:
    //   - Private / verified-CoS: auto-approve and track (no sensitivity evaluation).
    //   - Non-private (user explicitly set `permissive` on a shared space): run the
    //     credential gate, then fall through to the LLM-eval branch below so HR / PII
    //     content is still flagged. (260525_approval_overasking_diagnostic.md.)
    if (effectiveTrust === 'permissive') {
      // Private spaces and verified Chief-of-Staff skip the secret gate entirely.
      // Settings-first authority (FOX-3072): a verified CoS with missing/drifted frontmatter
      // `sharing` still bypasses the gate; `shouldSkipSecretGateForPermissive()` is the
      // single source of truth for this decision across interactive + automation paths.
      // The secret gate exists to prevent credential leaks to shared spaces; for
      // private/CoS spaces, the user owns both content and destination.
      if (shouldSkipSecretGateForPermissive(spacePath, settings, sharing)) {
        log.debug({ filePath, spaceName, toolName }, 'Auto-approving write (permissive private/CoS space, secret gate skipped)');
        const isMemoryUpdateTurn = isBackgroundMemoryUpdateTurn;
        if (!isMemoryUpdateTurn) {
          const isChiefOfStaff = spaceInfo?.spaceType === 'chief-of-staff' || isVerifiedChiefOfStaff(spacePath, settings);
          const reason: AutoApproveReason = isChiefOfStaff
            ? 'private_space'
            : hasSpaceOverride
              ? 'space_override_permissive'
              : 'private_space';
          summarizeContent(extractContent(toolName, toolInput))
            .then(summary => {
              trackMemoryWrite(filePath, spaceName, summary, originalSessionId, toolName === 'Create', coreDirectory, reason, sharing);
            })
            .catch(err => log.warn({ err, filePath }, 'Failed to track private space write'));
        }
        return {};
      }

      // SECRET GATE: Non-private permissive writes (user explicitly set `permissive`
      // on a shared space). Check for credential patterns; non-inspectable Bash writes
      // fail-closed to approval. After this gate, control falls through to the LLM-eval
      // branch below.
      const nonInspectable = isNonInspectableBashWrite(toolName, toolInput);
      if (!nonInspectable) {
        const contentForSecretCheck = extractContent(toolName, toolInput);
        const secretResult = containsCredentialPatterns(contentForSecretCheck);
        if (secretResult.detected) {
          log.info(
            { toolName, filePath, spaceName, reason: secretResult.reasons[0] },
            'Secret gate: credentials detected in permissive write, staging for review'
          );

          // STAGING-FIRST: Stage with fixed summary (NEVER send secret content to LLM — FM #5)
          const secretSummary = 'Possible credentials detected — review before saving';
          let stagingResult: Awaited<ReturnType<typeof stageOrDeny>> = null;
          try {
            stagingResult = await stageOrDeny({
              toolName,
              toolInput,
              filePath,
              coreDirectory,
              sessionId,
              originalSessionId,
              turnId,
              spaceName,
              blockedBy: 'structural_policy',
              blockReason: secretSummary,
              summary: secretSummary,  // Pre-computed: skips summarizeContent()
              sharing,
              toolUseId,
              supersededToolUseId,
            });
          } catch (stagingErr) {
            log.warn({ err: stagingErr, toolName, filePath }, 'Secret gate staging threw — falling through to blocking approval');
          }

          if (stagingResult) {
            // Dual-broadcast with staged: true for cross-surface parity (cloud/mobile)
            // SECURITY: Do NOT include content in metadata for secret-gate staged items.
            // Content is already safely in the CoS pending file; persisting it in the
            // approval store / IPC / cloud-sync would leak secrets across trust boundaries.
            await broadcastApprovalRequest(
              {
                toolUseId,
                originalTurnId,
                originalSessionId,
                destination: { path: filePath, spaceName, spacePath, sharing, isNew: toolName === 'Create' },
                summary: secretSummary,
                // NO contentPreview — never expose secret content in any event
                sensitivityReason: secretResult.reasons[0],
                hasSpaceOverride,
                privateMode: privateMode ?? false,
                blockedBy: 'structural_policy',
                staged: true,
                timestamp: Date.now(),
              },
              {
                turnId,
                sessionId,
                originalSessionId,
                filePath,
                content: '', // Empty: secret content must not be persisted in approval metadata
              },
            );
            return stagingResult.output;
          }

          // Staging failed — fall through to blocking approval (GEN-FALLBACK)
          log.info(
            { toolName, filePath, spaceName },
            'Secret gate: staging failed, falling back to blocking approval'
          );
          const secretRequest: MemoryWriteApprovalRequest = {
            toolUseId,
            originalTurnId,
            originalSessionId,
            destination: { path: filePath, spaceName, spacePath, sharing, isNew: toolName === 'Create' },
            summary: secretSummary,
            contentPreview: undefined, // Omit to avoid exposing secret in UI
            sensitivityReason: secretResult.reasons[0],
            hasSpaceOverride,
            privateMode: privateMode ?? false,
            blockedBy: 'structural_policy',
            timestamp: Date.now(),
          };
          await broadcastApprovalRequest(secretRequest, { turnId, sessionId, originalSessionId, filePath, content: contentForSecretCheck });
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `WRITE QUEUED — POSSIBLE CREDENTIALS DETECTED

Writing to "${spaceName}" has been queued for user review because the content may contain credentials or secrets.

The user is seeing an approval prompt: "Possible credentials detected — review before saving"

IMPORTANT:
- The write has NOT been executed yet — it is queued pending user review
- Do NOT retry this write or attempt alternative methods — it is already queued
- This is NOT a permanent failure — the user can approve it after reviewing`,
            },
          };
        }
      } else {
        // Non-inspectable Bash write: fail-closed to approval
        log.info(
          { toolName, filePath, spaceName },
          'Secret gate: non-inspectable Bash write in permissive mode, requiring approval'
        );
        const bashRequest: MemoryWriteApprovalRequest = {
          toolUseId,
          originalTurnId,
          originalSessionId,
          destination: { path: filePath, spaceName, spacePath, sharing, isNew: false },
          summary: 'Bash write with non-inspectable content — review before saving',
          contentPreview: undefined,
          sensitivityReason: 'non_inspectable_bash',
          hasSpaceOverride,
          privateMode: privateMode ?? false,
          blockedBy: 'structural_policy',
          timestamp: Date.now(),
        };
        await broadcastApprovalRequest(bashRequest, { turnId, sessionId, originalSessionId, filePath, content: extractContent(toolName, toolInput) });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `WRITE QUEUED — NON-INSPECTABLE CONTENT

Writing to "${spaceName}" has been queued for user review because the actual content being written could not be determined from the Bash command.

The user is seeing an approval prompt to review this write.

IMPORTANT:
- The write has NOT been executed yet — it is queued pending user review
- Do NOT retry this write or attempt alternative methods — it is already queued`,
          },
        };
      }

      // Non-private permissive: fall through to the LLM-eval path below.
      // The auto-approve fast path is scoped to private/CoS only (above);
      // bypassing the LLM here would let HR / legal / PII content
      // auto-approve based only on the structural credential gate, which
      // only catches API keys / passwords / connection strings. The LLM
      // evaluator runs against the user's safety rules and can still flag
      // genuinely sensitive content while letting routine writes through.
      // (260525_approval_overasking_diagnostic.md.)
      log.debug({ filePath, spaceName }, 'Permissive shared space: deferring to LLM eval');
    }

    let blockedBySource: BlockSource = 'structural_policy';

    // Balanced mode (and non-private permissive): evaluate via Safety Prompt
    if (effectiveTrust === 'balanced' || effectiveTrust === 'permissive') {
      const migrationComplete = isMigrationComplete();
      log.info({
        filePath,
        spaceName,
        sharing,
        effectiveTrust,
        migrationComplete,
      }, 'Balanced mode: evaluating memory write path selection');

      if (migrationComplete) {
        // Safety-eval progress (interactive memory path). Declared outside the
        // try so the catch block can still clear the subline on abort/error.
        const interactiveMemStartedAt = Date.now();
        let interactiveMemOutcomeBroadcast = false;
        const emitInteractiveMemComplete = (outcome: ToolSafetyEvaluatingCompletePayload['outcome']) => {
          if (interactiveMemOutcomeBroadcast) return;
          interactiveMemOutcomeBroadcast = true;
          broadcastMemorySafetyEvaluatingComplete({
            toolUseId,
            sessionId: sessionId ?? '',
            turnId: turnId ?? '',
            outcome,
          });
        };

        // SAFETY PROMPT PATH: Evaluate against user's Safety Prompt.
        try {
          const safetyPrompt = getSafetyPrompt();
          const promptVersion = getSafetyPromptVersion();
          const content = extractContent(toolName, toolInput);
          const automationCtx = isAutomationSession ? getAutomationContext(sessionId) : null;
          const evalToolInput: Record<string, unknown> = { ...(toolInput as Record<string, unknown>) };
          // Truncate inline content to avoid giant payloads
          if (typeof evalToolInput.content === 'string' && evalToolInput.content.length > 2000) {
            evalToolInput.content = evalToolInput.content.slice(0, 2000) + '... [truncated]';
          }
          // For Bash cp/cat: extract actual source file content for Safety Prompt visibility
          if (toolName === 'Bash') {
            try {
              const sourceContent = await extractFullContent(toolName, toolInput, filePath, coreDirectory, sessionId);
              if (sourceContent) {
                evalToolInput._contentPreview = sourceContent.slice(0, 8000);
              }
            } catch (err) {
              log.warn({ err, filePath }, 'Failed to extract Bash source content for balanced eval — falling back to command-only');
            }
          }
          const interactiveSpaceReadmePreview = await getSpaceReadmePreview(spaceInfo);
          const interactiveSpaceSharingContext = buildActionContextSpaceSharing(spaceInfo);
          // Stage 2 (260529_memory_write_intent_context_parity.md) — resolve
          // session intent against the **user conversation** session id
          // (`originalSessionId`), NOT the hook's `sessionId` (which is `turnId`
          // for interactive turns and therefore has no user messages).
          // userIntentExplicit is intentionally deferred per the plan.
          const interactiveMemorySessionIntentRaw = await resolveSessionIntent(originalSessionId);
          const interactiveMemorySessionIntent = interactiveMemorySessionIntentRaw
            && interactiveMemorySessionIntentRaw.recentUserMessages.length > 0
              ? interactiveMemorySessionIntentRaw
              : undefined;
          const actionContext: ActionContext = {
            toolName: toolName,
            toolInput: evalToolInput,
            toolDescription: `Memory write to "${spaceName}" space (${sharing ?? 'unknown'} sharing)`,
            sessionType: isAutomationSession ? 'automation' : 'interactive',
            automationName: automationCtx?.automationName,
            spaceDescription: spaceInfo?.description,
            spaceLabel: spaceInfo?.spaceName,
            spaceSharing: interactiveSpaceSharingContext,
            spaceReadmePreview: interactiveSpaceReadmePreview,
            // Inline spread (a shared assembly helper was considered but descoped —
            // see plan 260529; drift between this and the tool path is guarded by a
            // cross-path test instead of a hot-path refactor).
            // userMessage is structurally optional on the memory hook (the tool path
            // sets it unconditionally), so we truthy-guard here. The two are
            // equivalent at the rendered-prompt layer — buildEvalUserMessage skips an
            // empty userMessage. sessionIntent null/empty → undefined (additive-only).
            ...(userMessage ? { userMessage } : {}),
            ...(interactiveMemorySessionIntent ? { sessionIntent: interactiveMemorySessionIntent } : {}),
          };
          if (interactiveMemorySessionIntent) {
            log.info(
              {
                event: 'safety.session_intent_injected',
                sessionId: originalSessionId,
                toolName,
                messageCount: interactiveMemorySessionIntent.recentUserMessages.length,
                totalChars: interactiveMemorySessionIntent.totalChars,
              },
              'Session intent attached to interactive memory-write safety eval',
            );
          }

          log.info({ toolName, spaceName, sharing, promptVersion, safetyPromptLength: safetyPrompt.length }, 'Safety Prompt (interactive memory): starting evaluation');

          broadcastMemorySafetyEvaluating({
            toolUseId,
            sessionId: sessionId ?? '',
            turnId: turnId ?? '',
            toolName,
            attempt: 1,
            startedAt: interactiveMemStartedAt,
          });

          const evalResult = await evaluateSafetyPrompt(safetyPrompt, promptVersion, actionContext, {
            signal: evalSignal,
            onAttempt: (attempt) => {
              if (attempt <= 1) return;
              broadcastMemorySafetyEvaluating({
                toolUseId,
                sessionId: sessionId ?? '',
                turnId: turnId ?? '',
                toolName,
                attempt,
                startedAt: interactiveMemStartedAt,
              });
            },
          });
          // Permissive on a non-private shared space → relax the side-effect
          // floor to medium so routine writes auto-allow without surfacing an
          // approval card. (260525_approval_overasking_diagnostic.md.)
          const allowed = shouldAllow(evalResult, toolName, {
            confidenceFloor: effectiveTrust === 'permissive' ? 'medium' : 'high',
          });
          log.info({ toolName, spaceName, decision: evalResult.decision, confidence: evalResult.confidence, reason: evalResult.reason }, 'Safety Prompt (interactive memory): evaluation complete');

          addEvaluationEntry({
            toolDisplayName: `memory:${spaceName}/${filePath.split('/').pop() ?? filePath}`,
            toolId: toolName,
            actionSummary: `Write to ${spaceName}`,
            decision: allowed ? 'allowed' : 'blocked',
            reason: evalResult.reason || '',
            sessionType: isAutomationSession ? 'automation' : 'interactive',
            automationName: automationCtx?.automationName,
            flagged: false,
          });
          getBroadcastService().sendToAllWindows('safety-activity-log:updated', { timestamp: Date.now() });

          if (allowed) {
            log.info({ filePath, spaceName, decision: evalResult.decision }, 'Safety Prompt (interactive memory): allowed');
            const isMemoryUpdateTurn = isBackgroundMemoryUpdateTurn;
            if (!isMemoryUpdateTurn) {
              summarizeContent(content)
                .then(summary => {
                  trackMemoryWrite(filePath, spaceName, summary, originalSessionId, toolName === 'Create', coreDirectory, 'low_sensitivity', sharing);
                })
                .catch(err => log.warn({ err, filePath }, 'Failed to track Safety Prompt-approved write'));
            }
            emitInteractiveMemComplete('allowed');
            return {};
          }

          // Blocked: fall through to cautious staging path. The write has not
          // actually been staged yet at this point — downstream code decides
          // staging vs deny — but from the safety-eval progress angle the
          // subline can clear now.
          if (evalResult.failClosed) {
            log.warn(
              { filePath, spaceName, toolName, reason: evalResult.reason, failClosedReason: evalResult.failClosedReason },
              'Safety Prompt (interactive memory): evaluator unavailable — staging as eval_error',
            );
            if (turnId) {
              agentTurnRegistry.recordSecurityDenial(
                turnId,
                toolName,
                'Safety evaluator unavailable — staging for approval',
              );
            }
            blockedBySource = 'eval_error';
            emitInteractiveMemComplete('blocked');
          } else {
            log.info({ filePath, spaceName, reason: evalResult.reason }, 'Safety Prompt (interactive memory): blocked — staging for approval');
            blockedBySource = 'safety_prompt';
            emitInteractiveMemComplete('blocked');
          }
          (toolInput as Record<string, unknown>).__cachedSensitivityReason = evalResult.reason;
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            log.debug({ toolName, filePath }, 'Safety Prompt memory evaluation aborted — allowing');
            emitInteractiveMemComplete('aborted');
            return {};
          }
          log.warn({ toolName, filePath, err }, 'Safety Prompt memory evaluation failed — staging as eval_error');
          if (turnId) {
            agentTurnRegistry.recordSecurityDenial(
              turnId,
              toolName,
              'Safety evaluator unavailable — staging for approval',
            );
          }
          emitInteractiveMemComplete('blocked');
          try {
            const stagedEvalErrorResult = await stageOrDeny({
              toolName, toolInput, filePath, coreDirectory, sessionId,
              originalSessionId, turnId, spaceName,
              blockedBy: 'eval_error',
              blockReason: buildEvalErrorAgentReason(toolName),
              sharing,
              toolUseId,
              coalesceKey: buildMemoryEvalErrorCoalesceKey(spaceName, filePath),
              supersededToolUseId,
            });
            if (stagedEvalErrorResult) {
              return stagedEvalErrorResult.output;
            }
          } catch (stageErr) {
            log.warn({ toolName, filePath, stageErr }, 'Safety Prompt memory eval_error staging failed in catch path');
          }
          return buildEvalErrorMemoryDenyOutput();
        }
      } else {
        // Migration incomplete: stage all shared-space writes (conservative, non-blocking)
        log.info({ filePath, spaceName, migrationComplete }, 'Migration incomplete — staging write for approval');
        blockedBySource = 'structural_policy';
      }
    }
    
    // Cautious mode (or balanced mode with HIGH sensitivity): either stage or prompt user
    const content = extractContent(toolName, toolInput);
    
    // Use cached summary if available (from balanced mode sensitivity evaluation), otherwise generate
    const cachedSummary = (toolInput as Record<string, unknown>).__cachedSummary as string | undefined;
    const cachedSensitivityReason = (toolInput as Record<string, unknown>).__cachedSensitivityReason as string | undefined;
    const summary = cachedSummary ?? await summarizeContent(content);

    const cliApprovalResult = await routeMemoryApprovalHandler({
      turnId,
      target: filePath,
      summary,
      signal: evalSignal,
    });
    if (cliApprovalResult) {
      return cliApprovalResult.output;
    }
    
    // STAGED WRITES: Stage the file instead of blocking
    // Agent can continue working, user reviews at their leisure
    // For Bash writes, extractFullContent returns null when content can't be
    // determined (e.g., piped/redirected), causing a natural fallback to the
    // traditional approval flow below.
    // stageOrDeny() internalizes the REBEL_DISABLE_STAGED_WRITES + CoS checks.
    {
      log.info({ toolName, filePath, spaceName, toolUseId }, 'Attempting to stage write for later review');
      try {
        const stagingResult = await stageOrDeny({
          toolName, toolInput, filePath, coreDirectory, sessionId,
          originalSessionId, turnId, spaceName,
          blockedBy: blockedBySource,
          blockReason: blockedBySource === 'eval_error'
            ? buildEvalErrorAgentReason(toolName)
            : (cachedSensitivityReason ?? 'Memory write requires approval'),
          summary,
          sharing,
          toolUseId,
          coalesceKey: blockedBySource === 'eval_error'
            ? buildMemoryEvalErrorCoalesceKey(spaceName, filePath)
            : undefined,
          supersededToolUseId,
        });
        if (stagingResult) {
          return stagingResult.output;
        }
        // stageOrDeny returned null — staging impossible, fall through to blocking approval
        log.info({ toolName, filePath }, 'stageOrDeny returned null, falling back to blocking approval');
        if (blockedBySource === 'eval_error') {
          return buildEvalErrorMemoryDenyOutput();
        }
      } catch (error) {
        log.error({ err: error, filePath }, 'Failed to stage file, falling back to approval flow');
        if (blockedBySource === 'eval_error') {
          return buildEvalErrorMemoryDenyOutput();
        }
        // Fall through to approval flow on staging error
      }
    }
    
    // APPROVAL FLOW: Traditional blocking approval (default behavior)
    log.info({ toolName, filePath, spaceName, toolUseId }, 'Memory write requires approval - denying and notifying UI');
    
    const isNew = toolName === 'Create';
    
    const request: MemoryWriteApprovalRequest = {
      toolUseId,
      originalTurnId,
      originalSessionId,
      destination: {
        path: filePath,
        spaceName,
        spacePath,
        sharing,
        isNew,
      },
      summary,
      contentPreview: content.slice(0, 500),
      sensitivityReason: cachedSensitivityReason,
      hasSpaceOverride,
      privateMode: privateMode ?? false,
      blockedBy: blockedBySource,
      timestamp: Date.now(),
    };
    
    // Broadcast approval request (fire-and-forget, no blocking)
    await broadcastApprovalRequest(request, {
      turnId,
      sessionId,
      originalSessionId,
      filePath,
      content,
    });
    
    // Note: Automation memory writes are now caught earlier by the fail-closed
    // staging block and never reach this point.

    // Return DENY immediately - no blocking!
    // User can click "Save" in UI to store approval and trigger continuation
    // CRITICAL: The reason message tells Claude this is a temporary pause, not a permanent block
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `WRITE QUEUED — PENDING USER REVIEW
Writing to "${spaceName}" requires permission. The write has NOT been executed yet.

The user is seeing an approval prompt for: "${summary}"

Do NOT retry this write or try alternative methods — it is already queued.
When the user approves, you will receive a message to re-execute the operation.
If you can continue with other work, go ahead.`,
      },
    };
  };
}

/**
 * Check if there are any pending approvals (in-memory).
 */
export function hasPendingWriteApprovals(): boolean {
  return pendingApprovalMetadata.size > 0;
}

/**
 * Clear all pending approval metadata (e.g., on app shutdown).
 */
export function clearAllPendingWriteApprovals(): void {
  pendingApprovalMetadata.clear();
  log.info('Cancelled all pending memory write approvals');
}

/**
 * Internal path-classification guards exported ONLY for regression testing of the
 * raw-string-guard evasion fix (normalize before matching). Do not import these
 * outside tests — they are not part of the module's public surface.
 *
 * @internal Exported for testing
 * See docs/plans/260614_investigate-bashwritetargets/PLAN.md.
 */
export const testingGuards = {
  isMemoryPendingPath,
  isInboxPath,
  classifyUnmatchedPath,
  detectPluginSourceFile,
  bashCommandTargetsLockedPath,
  lockPathForCheckpoint,
  clearCheckpointLockedState,
  isPathContainedWithin,
};
