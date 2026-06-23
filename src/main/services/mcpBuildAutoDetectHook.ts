/**
 * MCP Build Auto-Detect Hook (PostToolUse)
 *
 * Three detection paths that auto-create contribution records for MCPBuildCard:
 *
 * 1. **File-write detection**: Watches Write/Create/Edit tool calls for file paths
 *    under ~/mcp-servers/ OR in any mcp-servers repo clone (detected via
 *    connectors/<name>/package.json structure). Creates contribution at
 *    `testing` status on first write.
 *
 * 2. **Server registration detection**: Watches `rebel_mcp_add_server` tool calls.
 *    Creates or promotes contribution to `ready_to_submit` status.
 *
 * 3. **Connector repo clone detection** (fallback): Recognizes connector builds
 *    at arbitrary paths by looking for the `connectors/<name>/package.json`
 *    structure with @mindstone-engineering or @mindstone-ai package names.
 *    Handles forks/clones at any location (e.g. ~/development/mcp-servers-fork/).
 *
 * Together: file writes create `testing` → add_server promotes to `ready_to_submit`.
 *
 * Classification logic (for rebel_mcp_add_server):
 *   1. catalog install (catalogId present) → skip
 *   2. custom build (path under ~/mcp-servers/ or recognized connector repo) → create contribution
 *   3. third-party server (path NOT under ~/mcp-servers/) → skip
 *
 * Error handling: rebel_mcp_add_server commonly returns isError due to
 * Super-MCP restart severing the HTTP connection (timeout/connection-lost),
 * even though the upsert succeeded. We treat these as likely-success and
 * still create the contribution record. Only hard rejections (tool blocked
 * by safety) are skipped — but those never reach PostToolUse because
 * PreToolUse blocks execution and returns early.
 *
 * This is an observe-only hook — always returns {} and never modifies tool output.
 *
 * @see docs/plans/260414_deterministic_mcp_build_card.md
 * @see docs/plans/260414_file_write_auto_detect_contribution.md
 */

import path from 'node:path';
import fs from 'node:fs';
import { createScopedLogger } from '@core/logger';
import { getPlatformConfig } from '@core/platform';
import { getSettings } from '@core/services/settingsStore';
import { toPortablePath } from '@core/utils/portablePath';
import { FILE_WRITE_TOOLS } from '@core/services/safety/constants';
import {
  getActiveContributionBySession,
  getContributionById,
  getContributionByPath,
  addLinkedSession,
  createContribution,
  updateContribution,
  listContributions,
  getContributionsBySession,
  markStuckRegistrationNudgeFired,
} from '@core/services/contributionStore';
import { canonicalizeConnectorPath } from '@core/utils/canonicalConnectorPath';
import {
  observeContribution,
  buildMissingSeEvidenceTransitionError,
  isMissingSeEvidenceTransitionError,
  withCanonicalPathMutex,
} from '@core/services/contributionObservationService';
import type {
  ConnectorContribution,
  SoftwareEngineerEvidenceInvalidatedReason,
} from '@core/services/contributionTypes';
import type { AgentEvent } from '@shared/types';
import { deriveSoftwareEngineerRecoveryGuidance } from '@shared/contribution/decisionEnvelope';
import {
  detectSoftwareEngineerTaskCompletion,
  extractTaskEventsFromConversationShape,
  extractTaskEventsFromPersistedEvents,
} from '@core/services/seTaskDetection';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import { getIncrementalSessionStore } from '@core/services/incrementalSessionStore';
import { getMcpServerNames, readMcpServerDetails } from '@core/services/mcpConfigManager';
import {
  classifyContributionPath,
  type ContributionPathClass,
  extractConnectorFromConnectorsSegment,
  expandLeadingTildePath,
  pathStartsUnderHomeMcpServers,
  tryParseNonCanonicalError,
} from '@shared/utils/contributionPathClassifier';
import { hasSessionWriteInDirectory } from './fileConversationStore';
import { verifyConnectorRegistration } from './mcpRegistrationVerifier';
import { resolveMcpConfigPath } from './mcpService';


const log = createScopedLogger({ service: 'mcpBuildAutoDetect' });

let previousEnforceSoftwareEngineerEvidence: boolean | undefined;

function getEnforceSoftwareEngineerEvidenceFlag(): boolean {
  return getSettings().enforceSoftwareEngineerEvidence ?? false;
}

function consumeReadyToSubmitReconciliationTrigger(currentFlag: boolean): boolean {
  const shouldReconcile = previousEnforceSoftwareEngineerEvidence === false && currentFlag === true;
  previousEnforceSoftwareEngineerEvidence = currentFlag;
  return shouldReconcile;
}

function maybeWriteMissingSeEvidenceTransitionError(args: {
  contributionId: string | undefined;
  invalidationReason?: SoftwareEngineerEvidenceInvalidatedReason;
}): void {
  if (!args.contributionId) return;
  const contribution = getContributionById(args.contributionId);
  if (!contribution) return;
  // Idempotency: preserve timestamp/UI stability when the synthetic gate error
  // is already present with the same reason + nextAction payload.
  if (isMissingSeEvidenceTransitionError(contribution.lastTransitionError)) return;

  const recovery = deriveSoftwareEngineerRecoveryGuidance({
    invalidationReason:
      contribution.lastSoftwareEngineerEvidenceInvalidatedReason
      ?? args.invalidationReason,
  });
  updateContribution(contribution.id, {
    lastTransitionError: buildMissingSeEvidenceTransitionError({
      chatSafeGuidance: recovery.chatSafe,
    }),
  });
}

export function _resetSeEvidenceFlagTrackingForTest(): void {
  previousEnforceSoftwareEngineerEvidence = undefined;
}

// ─── Options ────────────────────────────────────────────────────────

export interface McpBuildAutoDetectHookOptions {
  sessionId: string;
}

// ─── Path Detection ─────────────────────────────────────────────────

/**
 * Check if a file path is under ~/mcp-servers/ and derive the connector directory.
 *
 * Follows the same tilde-expansion + path.resolve pattern from memoryWriteHook.ts
 * to handle both absolute paths and ~/... shorthand safely.
 */
function isUnderMcpServers(filePath: string): { match: boolean; connectorDir?: string } {
  try {
    const homePath = getPlatformConfig().homePath;
    const mcpServersDir = toPortablePath(path.join(homePath, 'mcp-servers')).toLowerCase();

    // Expand tilde shorthand: agents may pass literal ~/mcp-servers/...
    // path.resolve does NOT expand ~ — it becomes <cwd>/~/...
    const expandedPath = expandLeadingTildePath(filePath, homePath);

    // Use path.resolve to prevent traversal attacks (../../.ssh/keys).
    // Keep both cased and lowercased forms so the connectors-nested detection
    // can preserve the real connector name casing while the under-mcp-servers
    // prefix check stays case-insensitive.
    const resolvedCased = toPortablePath(path.resolve(expandedPath));
    if (!pathStartsUnderHomeMcpServers(resolvedCased, homePath)) {
      // Stage 5 observability near-miss log. DEBUG level — high-volume
      // diagnostic for card-doesn't-appear investigations.
      log.debug(
        { reason: 'path-not-under-mcp-servers' },
        'mcpBuildAutoDetect: candidate path not under ~/mcp-servers/',
      );
      return { match: false };
    }
    const resolvedLower = resolvedCased.toLowerCase();

    // Fix 1 (Stage 4b): prefer connector-aware detection when the path
    // contains `connectors/<name>/...` anywhere in its tail. Previously this
    // function always took the first segment under ~/mcp-servers/, producing
    // bogus identities like `connectorName:"connectors"` for paths like
    // `~/mcp-servers/connectors/fathom/` or `connectorName:"mcp-servers-repo"`
    // for fork-clone paths like `~/mcp-servers/mcp-servers-repo/connectors/fathom/`.
    //
    // See docs-private/investigations/260420_stage_4a_card_appearance_findings.md
    // finding #1.
    const connectorsMatch = extractConnectorFromConnectorsSegment(resolvedCased);
    if (connectorsMatch) {
      const connectorDir = path.join(
        connectorsMatch.repoRoot,
        'connectors',
        connectorsMatch.connectorName,
      );
      return { match: true, connectorDir };
    }

    // Fallback: first dir segment under mcp-servers/ (existing behavior for
    // top-level connector directories like `~/mcp-servers/foo-mcp/`).
    const relative = resolvedLower.slice(mcpServersDir.length + 1);
    const firstSegment = relative.split('/')[0];
    if (!firstSegment) return { match: false };

    const connectorDir = path.join(homePath, 'mcp-servers', firstSegment);
    return { match: true, connectorDir };
  } catch {
    // getPlatformConfig may throw if called before bootstrap — skip check
    return { match: false };
  }
}

/**
 * Detect if a file path is inside an mcp-servers repo clone at any location.
 *
 * Looks for the `connectors/<name>/` directory structure and validates that
 * the connector has a package.json with a recognized @mindstone-engineering
 * or @mindstone-ai package name. This handles forks/clones at arbitrary paths
 * (e.g. ~/development/mcp-servers-fork/connectors/humaans/).
 *
 * Falls back from isUnderMcpServers() which only handles ~/mcp-servers/.
 */
function detectConnectorRepoPath(filePath: string): { match: boolean; connectorDir?: string } {
  try {
    const homePath = getPlatformConfig().homePath;
    const expandedPath = expandLeadingTildePath(filePath, homePath);

    const resolvedPath = path.resolve(expandedPath);
    // Reuse the shared connectors/<name> extractor so this path stays in sync
    // with the Fix 1 nested-path detection in `isUnderMcpServers()`.
    const extracted = extractConnectorFromConnectorsSegment(resolvedPath);
    if (!extracted) {
      // Stage 5 observability near-miss log.
      log.debug(
        { reason: 'no-connectors-segment' },
        'mcpBuildAutoDetect: candidate path has no connectors/<name>/ pattern',
      );
      return { match: false };
    }

    const { connectorName, repoRoot } = extracted;
    const connectorDir = path.join(repoRoot, 'connectors', connectorName);

    // Validate: connector must have package.json with a recognized package name
    const pkgPath = path.join(connectorDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return { match: false };

    const pkgContent = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(pkgContent);
    const pkgName: string = pkg.name || '';
    if (
      !pkgName.startsWith('@mindstone-engineering/mcp-server-') &&
      !pkgName.startsWith('@mindstone-ai/mcp-server-') &&
      !pkgName.startsWith('@mindstone/mcp-server-')
    ) {
      return { match: false };
    }

    return { match: true, connectorDir };
  } catch {
    return { match: false };
  }
}

/**
 * Unified path detection: tries ~/mcp-servers/ first, then falls back to
 * connector repo clone detection at arbitrary paths.
 */
function detectMcpServerPath(filePath: string): { match: boolean; connectorDir?: string } {
  const mcpResult = isUnderMcpServers(filePath);
  if (mcpResult.match) return mcpResult;
  return detectConnectorRepoPath(filePath);
}

/**
 * Find the first path in args.args that is under ~/mcp-servers/ or
 * in a recognized connector repo clone.
 * Returns the connector directory if found.
 *
 * `sessionId` is optional; when supplied the silent no-match branch emits a
 * DEBUG-level near-miss log so Stage 5 observability can diagnose
 * card-doesn't-appear cases.
 */
function findMcpServerPath(
  args: Record<string, unknown>,
  sessionId?: string,
): { connectorDir: string } | null {
  // Scan args.args (primary case: path lives in the command-arguments array).
  const argsList = args.args;
  if (Array.isArray(argsList)) {
    for (const arg of argsList) {
      if (typeof arg !== 'string') continue;
      const result = detectMcpServerPath(arg);
      if (result.match && result.connectorDir) {
        return { connectorDir: result.connectorDir };
      }
    }
  }

  // Fix 2 (Stage 4b): also scan args.command. Agents sometimes pass the
  // connector path through the primary `command` string (e.g.
  // `node /path/to/server/index.js`) rather than placing it in args. Split on
  // whitespace to get individual path-like tokens, then run the same unified
  // detection. See docs-private/investigations/260420_stage_4a_card_appearance_findings.md
  // finding #2 / Stage 4b Fix 2.
  const command = args.command;
  if (typeof command === 'string' && command.length > 0) {
    for (const token of command.split(/\s+/)) {
      if (!token) continue;
      const result = detectMcpServerPath(token);
      if (result.match && result.connectorDir) {
        return { connectorDir: result.connectorDir };
      }
    }
  }

  // Stage 5 observability: near-miss log. High-volume diagnostic only —
  // debug-level so production logs stay quiet. Payload is intentionally
  // lean; path-like tokens are NOT logged to avoid leaking user home dirs
  // through aggregation.
  log.debug(
    {
      sessionId,
      reason: 'no-path-in-args-or-command',
      argsListHasStringEntries: Array.isArray(argsList)
        ? argsList.some((a) => typeof a === 'string')
        : false,
      hasCommandString: typeof command === 'string' && command.length > 0,
    },
    'mcpBuildAutoDetect: no MCP-server path found in rebel_mcp_add_server args',
  );
  return null;
}

// ─── Non-canonical Add-Server Fallback Heuristics ──────────────────

const ABSOLUTE_PATH_TOKEN_REGEX = /^(?:\/|~[\\/]|[A-Za-z]:[\\/])/;
const SCRIPT_FILE_EXTENSION_REGEX = /\.(?:js|ts|mjs|cjs|py)$/i;
const NON_CANONICAL_EXPECTED_PATH_PREFIX = '~/mcp-servers/<api-name>-mcp/';
const NON_CANONICAL_GUIDANCE =
  'The connector was built outside the canonical ~/mcp-servers/ directory. To submit this connector to the community, move all source files to ~/mcp-servers/<api-name>-mcp/, update the MCP config registration (rebel_mcp_add_server with the new path), then call rebel_mcp_report_contribution_state({status: "ready_to_submit", localServerPath: "~/mcp-servers/<api-name>-mcp/", ...}). See rebel-system/skills/coding/build-custom-mcp-server/SKILL.md for the full build contract.';

function stripWrappingQuotes(raw: string): string {
  return raw.trim().replace(/^['"`]+|['"`]+$/g, '');
}

function splitCommandTokens(command: string): string[] {
  return command.match(/"[^"]+"|'[^']+'|`[^`]+`|\S+/g) ?? [];
}

function normalizePathToken(rawToken: string): string {
  const stripped = stripWrappingQuotes(rawToken);
  const equalsIndex = stripped.indexOf('=');
  if (equalsIndex > 0) {
    const rhs = stripWrappingQuotes(stripped.slice(equalsIndex + 1));
    if (ABSOLUTE_PATH_TOKEN_REGEX.test(rhs)) return rhs;
  }
  return stripped;
}

function resolveAbsolutePathToken(rawToken: string): string | null {
  const token = normalizePathToken(rawToken);
  if (!ABSOLUTE_PATH_TOKEN_REGEX.test(token)) return null;

  try {
    const homePath = getPlatformConfig().homePath;
    const expanded = expandLeadingTildePath(token, homePath);
    if (/^[A-Za-z]:[\\/]/.test(expanded)) {
      return toPortablePath(expanded);
    }
    return toPortablePath(path.resolve(expanded));
  } catch {
    return null;
  }
}

function redactPathTail(pathValue: string | null | undefined): string | null {
  if (!pathValue) return null;
  const parts = toPortablePath(pathValue).split('/').filter(Boolean);
  if (parts.length === 0) return null;
  return parts.slice(-2).join('/');
}

function createNonCanonicalPathTransitionError(observedPath: string): string {
  return JSON.stringify({
    reason: 'non-canonical-path',
    observedPath,
    expectedPathPrefix: NON_CANONICAL_EXPECTED_PATH_PREFIX,
    guidance: NON_CANONICAL_GUIDANCE,
  });
}

function isAllowedContributionPathClass(pathClass: ContributionPathClass): boolean {
  return pathClass === 'canonical' || pathClass === 'connectors-repo';
}

function logContributionPathContractViolation(params: {
  gate:
    | 'add-server-observer'
    | 'runPromotionSweep-case1'
    | 'runPromotionSweep-case2';
  sessionId: string;
  contributionId?: string;
  connectorName?: string;
  path: string | null | undefined;
  classification: ContributionPathClass;
}): void {
  log.warn(
    {
      reason: 'contribution-path-non-canonical',
      gate: params.gate,
      sessionId: params.sessionId,
      contributionId: params.contributionId,
      connectorName: params.connectorName,
      pathClassRedacted: redactPathTail(params.path),
      classification: params.classification,
    },
    'Non-canonical contribution path — SKILL.md contract violation',
  );
}

function extractAnyPathFromAddServerArgs(
  args: Record<string, unknown>,
  _sessionId: string,
): string | null {
  const candidates: string[] = [];

  const argsList = args.args;
  if (Array.isArray(argsList)) {
    for (const arg of argsList) {
      if (typeof arg === 'string') candidates.push(arg);
    }
  }

  const command = args.command;
  if (typeof command === 'string' && command.trim()) {
    candidates.push(...splitCommandTokens(command));
  }

  let firstDirectoryCandidate: string | null = null;
  for (const candidate of candidates) {
    const resolved = resolveAbsolutePathToken(candidate);
    if (!resolved) continue;

    const normalizedToken = toPortablePath(normalizePathToken(candidate)).toLowerCase();
    if (SCRIPT_FILE_EXTENSION_REGEX.test(normalizedToken)) {
      return toPortablePath(path.dirname(resolved));
    }

    if (!firstDirectoryCandidate) {
      firstDirectoryCandidate = resolved;
    }
  }

  return firstDirectoryCandidate;
}

function hasAgentAuthoredFilesUnder(sessionId: string, dirPath: string): boolean {
  try {
    const settings = getSettings();
    const coreDirectory = typeof settings.coreDirectory === 'string'
      ? settings.coreDirectory
      : undefined;
    return hasSessionWriteInDirectory(sessionId, dirPath, coreDirectory);
  } catch (error) {
    log.warn(
      { err: error, sessionId, pathClassRedacted: redactPathTail(dirPath) },
      'Failed to evaluate authorship heuristic for non-canonical add_server path',
    );
    return false;
  }
}

// ─── File Path Extraction ───────────────────────────────────────────

/**
 * Check if a tool name is a file-write tool (Write, Create, Edit, etc.).
 */
function isFileWriteTool(toolName: string): boolean {
  return (FILE_WRITE_TOOLS as readonly string[]).includes(toolName);
}

/**
 * Extract candidate file paths from a Bash command string.
 * Looks for path-like tokens that contain `/connectors/` — the distinctive
 * directory structure of mcp-servers repo clones.
 */
function extractPathsFromBashCommand(command: string): string[] {
  // Match path-like tokens containing /connectors/ (absolute or ~/...)
  const pathRegex = /(?:~\/|\/)[^\s;|&"']+\/connectors\/[^\s;|&"']+/g;
  const matches = command.match(pathRegex);
  return matches ?? [];
}

/** Pattern for Bash commands that run tests. */
const TEST_COMMAND_PATTERN = /\b(?:npm\s+test|npm\s+run\s+test|vitest|jest|mocha)\b/;

/** Pattern for Bash commands that indicate a successful build (compilation complete).
 * Only these should create a `testing` contribution — scaffolding commands
 * (mkdir, npm install) and file writes should not trigger the MCPBuildCard. */
const BUILD_SUCCESS_PATTERN = /\b(?:npm\s+run\s+build|npx\s+tsc|tsc|pnpm\s+(?:run\s+)?build|yarn\s+(?:run\s+)?build)\b/;

// ─── Shared Detection Logic ─────────────────────────────────────────

/**
 * Handle detection of a file path in a recognized mcp-servers location.
 * Checks ~/mcp-servers/ first, then falls back to connector repo clone detection.
 * Creates a contribution at `testing` status if none exists for this session.
 * Returns {} always (observe-only).
 *
 * Stage 4: ALWAYS emits a `file-detection` evidence signal (both for new and
 * existing contributions). This is critical for the build→add_server flow:
 * when the agent builds a connector and then registers it, the predicate
 * needs to see file-detection evidence + add-server-observer operational
 * to fire the promotion. Without seeding evidence at create-time, the next
 * `add-server-observer` signal would defer indefinitely.
 *
 * Reviewer-driven fix (Stage 4 GPT-5.5 CRITICAL #1): the original implementation
 * fired the signal only for existing contributions, breaking the most common
 * flow (build then add). Now we record the signal in both paths.
 */
async function handleMcpServerFileDetection(sessionId: string, filePath: string): Promise<Record<string, never>> {
  const pathResult = detectMcpServerPath(filePath);
  if (!pathResult.match || !pathResult.connectorDir) return {};

  // Stage 3.E (260426): route through `observeContribution`. The reducer
  // creates a `draft` (not `testing`) when no record exists — Stage 3 plan
  // matrix #22 realignment. Path-first / session-fallback lookup +
  // cross-session linking happen inside `observeContribution`.
  const connectorName = path.basename(pathResult.connectorDir);
  await observeContribution({
    kind: 'build_detected',
    sessionId,
    localServerPath: pathResult.connectorDir,
    connectorName,
    source: 'post-tool-bash',
  });
  return {};
}

/**
 * Handle detection of a successful test run in a recognized connector directory.
 * Emits a `test-pass` evidence signal to the promotion service; the service's
 * composition predicate decides whether to promote.
 *
 * This covers the "extend existing connector" flow where rebel_mcp_add_server
 * is never called (the connector is already registered). The path still
 * updates `localServerPath` on the record out-of-band because the service
 * only handles the status transition — side-data fixes stay with the caller.
 *
 * Stage 3.E (260426): routes through `observeContribution` with
 * `kind: 'test_passed'`. The reducer's predicate evaluates whether the
 * accumulated readiness timestamps satisfy promotion.
 */
async function handleTestPassPromotion(sessionId: string, connectorDir: string): Promise<Record<string, never>> {
  // Stage 3.E (260426): route through `observeContribution`. Test-pass on
  // its own does NOT create a record (matrix #22 protection); the reducer
  // emits noop when no record exists. Side-data updates (localServerPath)
  // happen out-of-band only when an existing record's path is stale.
  const canonicalPath = canonicalizeConnectorPath(connectorDir);
  const existing = canonicalPath ? getContributionByPath(canonicalPath) : undefined;
  if (existing && (!existing.localServerPath || existing.localServerPath !== connectorDir)) {
    const updates: Parameters<typeof updateContribution>[1] = { localServerPath: connectorDir };
    const pathClass = classifyContributionPath(connectorDir);
    if (
      isAllowedContributionPathClass(pathClass) &&
      tryParseNonCanonicalError(existing.lastTransitionError) !== null
    ) {
      updates.lastTransitionError = undefined;
    }
    updateContribution(existing.id, updates);
  }

  await observeContribution({
    kind: 'test_passed',
    sessionId,
    localServerPath: connectorDir,
    source: 'post-tool-bash',
  });
  return {};
}

// ─── Hook Factory ───────────────────────────────────────────────────
//
// Stage 3.E (260426): the legacy synthetic evidence-only recovery hook
// (extend-flow recovery) was deleted. The Stage 3 reducer makes the
// predicate explicit (`lastReadyRequestedAt + (lastTestPassedAt ||
// lastRegisteredAt) + fingerprintMatches`), so the synthetic recovery
// path is structurally unnecessary. Matrix #9 closure.

/**
 * Create the MCP build auto-detect hook for PostToolUse.
 *
 * Three detection paths:
 * 1. File writes under ~/mcp-servers/ or recognized connector repo clones → create at `testing`
 * 2. Bash commands referencing mcp-servers/ or connectors/<name>/ paths → create at `testing`
 * 3. rebel_mcp_add_server calls → create/promote contribution to `ready_to_submit`
 *
 * Note: Hooks MUST return an object (even empty {}), not void/undefined.
 * Returning undefined causes ZodError in the hook output parsing.
 */
export function createMcpBuildAutoDetectHook(options: McpBuildAutoDetectHookOptions) {
  const { sessionId } = options;

  return async (input: {
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_response?: { output?: string; isError?: boolean };
    tool_use_id?: string;
  }): Promise<Record<string, never>> => {
    try {
      const toolName = input.tool_name;
      if (!toolName) return {};

      // ─── Path 1: File-write detection ───────────────────────────
      // File writes alone do NOT create contributions — they fire too early
      // (template scaffolding). Only build-success (Path 1b) or server
      // registration (Path 2) should create contributions.
      if (isFileWriteTool(toolName)) {
        return {};
      }

      // ─── Path 1b: Bash command detection ────────────────────────
      // Watch Bash tool for commands that reference mcp-servers paths or
      // connector repo clone paths (connectors/<name>/).
      // Also detects successful test runs and promotes testing → ready_to_submit.
      if (toolName === 'Bash') {
        if (input.tool_response?.isError) return {};

        const toolInput = input.tool_input as Record<string, unknown> | undefined;
        if (!toolInput) return {};

        const command = typeof toolInput.command === 'string' ? toolInput.command : '';
        if (!command) return {};

        const isTestCommand = TEST_COMMAND_PATTERN.test(command);
        const isBuildSuccess = BUILD_SUCCESS_PATTERN.test(command);

        // Strategy 1: Extract mcp-servers/<connector-name> from the command string.
        // Matches ~/mcp-servers/, $HOME/mcp-servers/, absolute, or relative paths.
        const mcpPathMatch = command.match(/mcp-servers\/([a-zA-Z0-9_.-]+)/);
        if (mcpPathMatch) {
          const connectorDirName = mcpPathMatch[1];
          try {
            const homePath = getPlatformConfig().homePath;
            const connectorDir = path.join(homePath, 'mcp-servers', connectorDirName);
            // Only create contribution on build-success commands (npm run build, tsc).
            // Scaffolding (mkdir, npm install) should NOT trigger the MCPBuildCard.
            if (isBuildSuccess) await handleMcpServerFileDetection(sessionId, path.join(connectorDir, 'detected-via-bash'));
            if (isTestCommand) await handleTestPassPromotion(sessionId, connectorDir);
            return {};
          } catch (err) {
            // A failure here silently drops the MCPBuildCard contribution for a
            // detected connector — surface it so a broken detection is visible
            // (the no-op fallback is preserved; the hook must not break the tool).
            log.warn({ err, sessionId, connectorDirName }, 'MCP build auto-detect failed to record connector contribution — skipping');
            return {};
          }
        }

        // Strategy 2: Extract file paths from the command and check if any
        // are inside a recognized connector repo clone (connectors/<name>/ pattern).
        // Handles forks at arbitrary paths like ~/development/mcp-servers-fork/connectors/humaans/.
        const pathCandidates = extractPathsFromBashCommand(command);
        for (const candidate of pathCandidates) {
          const repoResult = detectConnectorRepoPath(candidate);
          if (repoResult.match && repoResult.connectorDir) {
            if (isBuildSuccess) await handleMcpServerFileDetection(sessionId, path.join(repoResult.connectorDir, 'detected-via-bash'));
            if (isTestCommand) await handleTestPassPromotion(sessionId, repoResult.connectorDir);
            return {};
          }
        }

        // Strategy 3 (Fix 3, Stage 4b): inspect tool_input.cwd as a fallback.
        // Some agents run `npm run build` with only `cwd` set (no path in
        // the command string), which Strategy 1 and 2 both miss. Use the
        // same unified detection (isUnderMcpServers + connector repo clone)
        // against cwd. See docs-private/investigations/260420_stage_4a_card_appearance_findings.md
        // finding #4 / Stage 4b Fix 3.
        const cwd = typeof toolInput.cwd === 'string' ? toolInput.cwd : null;
        if (cwd) {
          const cwdResult = detectMcpServerPath(cwd);
          if (cwdResult.match && cwdResult.connectorDir) {
            if (isBuildSuccess) await handleMcpServerFileDetection(sessionId, cwdResult.connectorDir);
            if (isTestCommand) await handleTestPassPromotion(sessionId, cwdResult.connectorDir);
            return {};
          }
        }

        // Stage 5 observability: we saw a Bash build/test signal but
        // couldn't locate a recognizable MCP-server path via command, file
        // arguments, or cwd. This is the most common "card didn't appear"
        // near-miss. Only log when there's an actual build/test signal to
        // diagnose — don't spam on every ls/cat/etc.
        if (isBuildSuccess || isTestCommand) {
          log.debug(
            {
              sessionId,
              reason: 'bash-build-or-test-but-no-path-source',
              isBuildSuccess,
              isTestCommand,
              hasCwd: cwd !== null,
            },
            'mcpBuildAutoDetect: Bash build/test command observed but no path source matched',
          );
        }
        return {};
      }

      // ─── Path 2: Server registration detection ─────────────────
      // Watch rebel_mcp_add_server calls (via MCP router use_tool).
      if (!toolName.endsWith('use_tool')) return {};

      const toolInput = input.tool_input as Record<string, unknown> | undefined;
      if (!toolInput) return {};

      const toolId = typeof toolInput.tool_id === 'string' ? toolInput.tool_id : '';

      // ─── Stage 3.E: use_tool PostToolUse observer ─────────────────
      // When a `use_tool` is observed against a tool whose name matches a
      // connector currently under tracking (any record for this session),
      // fire `kind: 'test_passed'` from `source: 'post-tool-use-tool'`.
      // This widens test-pass evidence beyond Bash test runners — a
      // connector that exists primarily to expose MCP tools can now reach
      // ready_to_submit by being exercised via `use_tool` directly.
      //
      // Substring-match heuristic (per Stage 3 plan § "Hidden gotchas →
      // G8"): connectorName is a substring of tool_id (or vice versa) AND
      // args are non-empty (signals real exercise, not a no-op probe).
      // The directional check + args guard mitigates false positives for
      // built-in tools like `Read` which happen to overlap with hypothetical
      // connector names.
      if (
        toolId !== 'rebel_mcp_add_server' &&
        !toolId.endsWith('__rebel_mcp_add_server')
      ) {
        if (input.tool_response?.isError) return {};
        const useToolArgs = toolInput.args;
        const argsNonEmpty =
          (Array.isArray(useToolArgs) && useToolArgs.length > 0) ||
          (typeof useToolArgs === 'object' &&
            useToolArgs !== null &&
            Object.keys(useToolArgs as Record<string, unknown>).length > 0);
        if (!argsNonEmpty || !toolId) return {};

        const sessionContributions = listContributions().filter(
          (c) =>
            c.linkedSessionIds.includes(sessionId) &&
            (c.status === 'testing' || c.status === 'draft') &&
            !!c.localServerPath,
        );
        if (sessionContributions.length === 0) return {};

        const toolIdLower = toolId.toLowerCase();
        const matched = sessionContributions.find((c) => {
          const nameLower = c.connectorName.toLowerCase();
          // Directional substring match: connector name appears in tool id.
          // We deliberately do NOT do the reverse (tool id in connector
          // name) — that would let `Read` falsely match a `text-extractor`
          // record. The match is scoped to MCP-router compound ids
          // (containing `__`), which Bash + filesystem tools do not have.
          return toolIdLower.includes(nameLower);
        });
        if (!matched || !matched.localServerPath) return {};

        await observeContribution({
          kind: 'test_passed',
          sessionId,
          localServerPath: matched.localServerPath,
          source: 'post-tool-use-tool',
        });
        return {};
      }

      // Skip non-execution errors (except timeout/connection-lost, known Super-MCP restart pattern)
      const toolResponse = input.tool_response;
      if (toolResponse?.isError) {
        const output = typeof toolResponse.output === 'string' ? toolResponse.output : '';
        const isTimeoutOrConnectionLost =
          output.includes('timed out') ||
          output.includes('Request timed out') ||
          output.includes('connection was lost') ||
          output.includes('Tool connection was lost');
        if (!isTimeoutOrConnectionLost) return {};
        log.debug({ sessionId, output: output.slice(0, 200) }, 'Treating timeout/connection-lost as likely-success for rebel_mcp_add_server');
      }

      const args = toolInput.args as Record<string, unknown> | undefined;
      if (!args) return {};

      // Catalog install → skip
      if (args.catalogId) return {};

      // Find server path under ~/mcp-servers/
      const pathResult = findMcpServerPath(args, sessionId);
      if (!pathResult) {
        const fallbackPath = extractAnyPathFromAddServerArgs(args, sessionId);
        if (!fallbackPath) {
          log.warn(
            { sessionId, reason: 'add-server-no-resolvable-path' },
            'rebel_mcp_add_server: no resolvable path and existing detection failed',
          );
          return {};
        }

        const pathClass = classifyContributionPath(fallbackPath);
        if (isAllowedContributionPathClass(pathClass)) {
          log.warn(
            {
              sessionId,
              pathClass,
              reason: 'classifier-vs-detector-divergence',
            },
            'Classifier matched where findMcpServerPath did not — investigate',
          );
          return {};
        }

        if (pathClass === 'unknown') {
          log.warn(
            { sessionId, reason: 'add-server-unclassifiable-path' },
            'rebel_mcp_add_server: extracted fallback path is unclassifiable',
          );
          return {};
        }

        const connectorName = typeof args.name === 'string' ? args.name.trim() : '';
        if (!connectorName) {
          log.warn(
            { sessionId, reason: 'add-server-missing-name' },
            'rebel_mcp_add_server: cannot synthesize contribution without args.name',
          );
          return {};
        }

        // Stage 2.D (260426): path-first / session-fallback. fallbackPath is
        // the agent-supplied path; if a record already exists at that
        // canonical path or for the active session, we don't synthesize a
        // duplicate.
        const fallbackCanonical = canonicalizeConnectorPath(fallbackPath);
        let existing = fallbackCanonical
          ? getContributionByPath(fallbackCanonical)
          : undefined;
        if (!existing) {
          existing = getActiveContributionBySession(sessionId);
        }
        if (existing) {
          if (!existing.linkedSessionIds.includes(sessionId)) {
            addLinkedSession(existing.id, sessionId);
          }
          return {};
        }

        const authored = hasAgentAuthoredFilesUnder(sessionId, fallbackPath);
        if (!authored) {
          log.debug(
            { sessionId, reason: 'add-server-third-party-skip', connectorName },
            'rebel_mcp_add_server: non-canonical path with no agent authorship — skipping',
          );
          return {};
        }

        const synthesized = createContribution({
          sessionId,
          connectorName,
          status: 'testing',
          attributionMode: 'anonymous',
          localServerPath: fallbackPath,
        });
        updateContribution(synthesized.id, {
          lastTransitionError: createNonCanonicalPathTransitionError(fallbackPath),
        });
        logContributionPathContractViolation({
          gate: 'add-server-observer',
          sessionId,
          contributionId: synthesized.id,
          connectorName,
          path: fallbackPath,
          classification: pathClass,
        });
        return {};
      }

      const connectorDir = pathResult.connectorDir;
      const connectorName = typeof args.name === 'string' ? args.name : 'Unknown Connector';

      // Stage 3.E (260426): keep side-data updates direct (connectorName,
      // localServerPath) but route the promotion signal through
      // `observeContribution`. The reducer decides whether the predicate
      // is satisfied based on accumulated readiness timestamps.
      const canonicalConnectorDir = canonicalizeConnectorPath(connectorDir);
      const existing = canonicalConnectorDir
        ? getContributionByPath(canonicalConnectorDir)
        : undefined;
      if (existing) {
        if (existing.status === 'testing' || existing.status === 'draft') {
          // Keep side-data in sync before observing.
          const updates: Parameters<typeof updateContribution>[1] = {};
          if (existing.connectorName !== connectorName) {
            updates.connectorName = connectorName;
          }
          if (existing.localServerPath !== connectorDir) {
            updates.localServerPath = connectorDir;
            const pathClass = classifyContributionPath(connectorDir);
            if (
              isAllowedContributionPathClass(pathClass) &&
              tryParseNonCanonicalError(existing.lastTransitionError) !== null
            ) {
              updates.lastTransitionError = undefined;
            }
          }
          if (Object.keys(updates).length > 0) {
            updateContribution(existing.id, updates);
          }
        }
        // For all other statuses (ready_to_submit, submitted, etc.) — leave as is.
      }

      const enforceSoftwareEngineerEvidence = getEnforceSoftwareEngineerEvidenceFlag();
      const shouldAttemptReadyPromotion =
        existing === undefined || existing.status === 'testing' || existing.status === 'draft';
      let targetContributionId = existing?.id;

      if (!existing) {
        const created = createContribution({
          sessionId,
          connectorName,
          status: 'testing',
          attributionMode: 'anonymous',
          localServerPath: connectorDir,
        });
        targetContributionId = created?.id ?? targetContributionId;
        log.info({ sessionId, connectorName }, 'Created testing contribution via add_server auto-detect');
      }

      // Always observe server registration so the reducer stamps durable
      // `lastRegisteredAt` evidence on the target contribution.
      await observeContribution({
        kind: 'server_registered',
        sessionId,
        localServerPath: connectorDir,
        connectorName,
        source: 'post-tool-add-server',
      });

      if (shouldAttemptReadyPromotion) {
        const readyResult = await observeContribution({
          kind: 'ready_requested',
          sessionId,
          localServerPath: connectorDir,
          connectorName,
          source: 'bridge-report-state',
        }, {
          enforceSoftwareEngineerEvidence,
        });
        if (readyResult.reason === 'missing_se_evidence') {
          maybeWriteMissingSeEvidenceTransitionError({
            contributionId: readyResult.contributionId ?? targetContributionId,
          });
        }
      }
    } catch (error) {
      log.warn({ err: error, sessionId }, 'Failed to auto-detect MCP build');
    }

    return {};
  };
}

// ─── Post-Turn Promotion & Auto-Creation ────────────────────────────

/** Recency window: only consider server directories modified within this window. */
const RECENCY_WINDOW_MS = 30 * 60 * 1000; // 30 minutes — generous to cover full build turns

/**
 * Check if a directory was recently modified (within RECENCY_WINDOW_MS).
 * Uses mtime of the directory itself or its package.json as a proxy
 * for "was this server just built?"
 */
function isRecentlyModified(dirPath: string): boolean {
  const cutoff = Date.now() - RECENCY_WINDOW_MS;
  try {
    // Prefer package.json mtime (more reliable signal of a build)
    const pkgPath = path.join(dirPath, 'package.json');
    const stat = fs.statSync(pkgPath);
    return stat.mtimeMs > cutoff;
  } catch {
    // No package.json — fall back to directory mtime
    try {
      const stat = fs.statSync(dirPath);
      return stat.mtimeMs > cutoff;
    } catch {
      return false;
    }
  }
}

/**
 * Find registered MCP servers whose args reference paths under ~/mcp-servers/
 * or in recognized connector repo clones (connectors/<name>/ structure).
 * Returns server details for custom-built connectors (excludes catalog installs).
 *
 * When `recentOnly` is true (default), filters to directories modified within
 * RECENCY_WINDOW_MS to avoid false attribution of pre-existing servers.
 */
async function findCustomMcpServers(
  configPath: string,
  options?: { recentOnly?: boolean },
): Promise<Array<{ name: string; serverPath: string }>> {
  const recentOnly = options?.recentOnly ?? true;
  const serverNames = await getMcpServerNames(configPath);
  const results: Array<{ name: string; serverPath: string }> = [];

  for (const name of serverNames) {
    try {
      const details = await readMcpServerDetails(configPath, name);
      if (details.catalogId) continue;
      if (!details.args) continue;

      for (const arg of details.args) {
        if (typeof arg !== 'string') continue;
        // Use unified detection: ~/mcp-servers/ first, then connector repo clone fallback
        const detected = detectMcpServerPath(arg);
        if (detected.match && detected.connectorDir) {
          if (!recentOnly || isRecentlyModified(detected.connectorDir)) {
            results.push({ name, serverPath: detected.connectorDir });
          }
          break;
        }
      }
    } catch {
      // Skip servers that can't be read
    }
  }
  return results;
}

/**
 * Post-turn check: ensures a contribution record exists for any custom-built
 * MCP server registered during this session.
 *
 * Handles two cases:
 * 1. **Promotion**: contribution exists at `testing` → promote to `ready_to_submit`
 * 2. **Auto-creation**: NO contribution exists but a custom MCP server under
 *    ~/mcp-servers/ or in a recognized connector repo clone was registered
 *    → create at `testing`, stamp registration evidence, then route through
 *      the same `ready_requested` predicate gate for promotion.
 *
 * Auto-creation solves the "subagent gap": when the agent delegates building to
 * a subagent, the subagent's tool calls don't trigger the parent's PostToolUse
 * hooks, so file-write and registration detection never fire. This post-turn
 * sweep catches those builds by checking what's actually in the MCP config.
 *
 * Called after each agent turn completes.
 *
 * @see docs-private/investigations/260414_contribution_state_not_called.md
 */
// Tracks in-flight post-turn promotion sweeps so callers (notably the eval
// harness and Stage 4 tests) can wait for quiescence before reading the
// contribution store. Keyed by sessionId; entry cleared when the sweep settles.
const inflightPromotions = new Map<string, Promise<void>>();

/**
 * Waits for any in-flight `promoteTestingContributionIfRegistered` call for the
 * given session to settle. Used by evals and tests that need to read the
 * contribution store AFTER post-turn promotion has had a chance to fire.
 *
 * Production callers do NOT need to await — turn completion is intentionally
 * decoupled from promotion. This helper is purely for deterministic test
 * observation.
 */
export async function waitForPendingPromotion(sessionId: string): Promise<void> {
  const pending = inflightPromotions.get(sessionId);
  if (pending) await pending;
}

export function promoteTestingContributionIfRegistered(sessionId: string): Promise<void> {
  // Register the in-flight promise so `waitForPendingPromotion` can observe it.
  // Work happens inside `runPromotionSweep`; we clear in `finally`.
  const work = runPromotionSweep(sessionId).finally(() => {
    if (inflightPromotions.get(sessionId) === work) {
      inflightPromotions.delete(sessionId);
    }
  });
  inflightPromotions.set(sessionId, work);
  return work;
}

async function maybeObserveSoftwareEngineerTaskCompletion(
  contribution: ConnectorContribution,
): Promise<void> {
  if (!contribution.turnIndexWindow) return;

  // Idempotency guard: once SE completion is present and not invalidated,
  // sweeps needn't re-write the same observation every cycle.
  if (
    contribution.lastSoftwareEngineerTaskCompletedAt
    && !contribution.lastSoftwareEngineerEvidenceInvalidatedReason
  ) {
    return;
  }

  const activeTurnId = agentTurnRegistry.getActiveTurnForSession(contribution.sessionId);
  const conversationShape = activeTurnId
    ? agentTurnRegistry.getContextAccumulator(activeTurnId)
    : undefined;

  let persistedEvents: Record<string, AgentEvent[]> | undefined;
  if (!conversationShape) {
    try {
      const persistedSession = await getIncrementalSessionStore().getSession(contribution.sessionId);
      persistedEvents = persistedSession?.eventsByTurn;
    } catch (error) {
      log.warn(
        {
          contributionId: contribution.id,
          sessionId: contribution.sessionId,
          err: error instanceof Error ? error.message : String(error),
        },
        'SE Task detection: failed to load persisted session for fallback source',
      );
    }
  }

  const taskEvents = conversationShape
    ? extractTaskEventsFromConversationShape(conversationShape)
    : extractTaskEventsFromPersistedEvents(persistedEvents);

  const detection = detectSoftwareEngineerTaskCompletion({
    taskEvents,
    contributionSessionId: contribution.sessionId,
    contributionTurnIndexWindow: contribution.turnIndexWindow,
  });

  if (!detection.found) {
    return;
  }

  await observeContribution({
    kind: 'software_engineer_task_completed',
    sessionId: contribution.sessionId,
    contributionId: contribution.id,
    taskSubagentTypes: detection.taskSubagentTypes,
    observedAt: detection.observedAt,
    source: 'post-turn-sweep',
  });

  log.info(
    {
      contributionId: contribution.id,
      taskSubagentTypes: detection.taskSubagentTypes,
      taskSource: conversationShape ? 'active-turn-accumulator' : 'persisted-events',
    },
    'SE Task completion observed',
  );
}

async function runPromotionSweep(sessionId: string): Promise<void> {
  try {
    // Self-block follow-on (260427) — sub-stage C. Stuck-registration
    // backstop: detect "agent built and tested but never registered"
    // records and stamp the one-shot `stuckRegistrationNudgeFiredAt`
    // flag. The next-turn system-reminder injection
    // (`buildStuckRegistrationReminder`) reads this flag and emits a
    // one-line nudge into the agent's prompt so the agent recovers
    // from the self-block. This branch fires BEFORE Case 1/Case 2
    // because it's purely an observability side-effect — the existing
    // promotion logic (Case 1) and subagent-gap recovery (Case 2)
    // still run for the same record on the same sweep when applicable.
    await maybeFireStuckRegistrationNudge(sessionId);

    // Stage 2.D (260426): use active-session lookup so a session that has
    // touched multiple builds gets its most-recently-updated record (not
    // first-match by sessionId). The plan keeps Case 1 session-only —
    // path-first lookup happens at the bridge ingress; Case 2 separately
    // covers the no-record path with a path-uniqueness guard.
    const contribution = getActiveContributionBySession(sessionId);

    if (contribution?.turnIndexWindow) {
      await maybeObserveSoftwareEngineerTaskCompletion(contribution);
    }

    const settings = getSettings();
    const enforceSoftwareEngineerEvidence = settings.enforceSoftwareEngineerEvidence ?? false;
    const shouldReconcileReadyToSubmit =
      consumeReadyToSubmitReconciliationTrigger(enforceSoftwareEngineerEvidence);
    const configPath = resolveMcpConfigPath(settings);
    if (!configPath) return;

    if (shouldReconcileReadyToSubmit) {
      for (const readyContribution of listContributions()) {
        if (readyContribution.status !== 'ready_to_submit') continue;
        if (readyContribution.lastSoftwareEngineerTaskCompletedAt) continue;
        maybeWriteMissingSeEvidenceTransitionError({
          contributionId: readyContribution.id,
          invalidationReason: readyContribution.lastSoftwareEngineerEvidenceInvalidatedReason,
        });
      }
    }

    // Case 1: Existing contribution at `testing` — try to promote via the
    // Stage 3 observation pipeline. Stage 3.E (260426): routes through
    // `observeContribution({ kind: 'server_registered', source:
    // 'post-turn-sweep' })`. The reducer's predicate decides whether the
    // record promotes based on accumulated readiness timestamps. Side-data
    // (connectorName) is updated directly on path-match because
    // observeContribution doesn't take a name.
    if (
      contribution &&
      (contribution.status === 'testing' || contribution.status === 'draft')
    ) {
      // Canonical-path gate applies ONLY to path-backed records. Pathless
      // testing records (created by the bridge when the agent reports state
      // without localServerPath) must still be reachable via the name-only
      // fallback in `verifyConnectorRegistration` — otherwise they become
      // unrecoverable via this sweep.
      if (contribution.localServerPath) {
        const pathClass = classifyContributionPath(contribution.localServerPath);
        if (!isAllowedContributionPathClass(pathClass)) {
          logContributionPathContractViolation({
            gate: 'runPromotionSweep-case1',
            sessionId,
            contributionId: contribution.id,
            connectorName: contribution.connectorName,
            path: contribution.localServerPath,
            classification: pathClass,
          });
          return;
        }
      }

      const registration = await verifyConnectorRegistration(
        configPath,
        contribution.connectorName,
        contribution.localServerPath,
        { log },
      );
      if (!registration.matched) return;

      if (
        registration.matchKind === 'path' &&
        registration.matchedName !== contribution.connectorName
      ) {
        // Side-data update: connectorName from path-resolved name.
        updateContribution(contribution.id, { connectorName: registration.matchedName });
      }

      // Pathless records can't observe (observation requires a path); skip
      // gracefully — the bridge ingress is the only path that touches
      // pathless records and a future report will route through the
      // `ready_requested` observation against a path.
      if (contribution.localServerPath) {
        await observeContribution({
          kind: 'server_registered',
          sessionId,
          localServerPath: contribution.localServerPath,
          connectorName: registration.matchedName ?? contribution.connectorName,
          source: 'post-turn-sweep',
        });
        const readyResult = await observeContribution({
          kind: 'ready_requested',
          sessionId,
          localServerPath: contribution.localServerPath,
          connectorName: registration.matchedName ?? contribution.connectorName,
          source: 'bridge-report-state',
        }, {
          enforceSoftwareEngineerEvidence,
        });
        if (readyResult.reason === 'missing_se_evidence') {
          maybeWriteMissingSeEvidenceTransitionError({
            contributionId: readyResult.contributionId ?? contribution.id,
            invalidationReason: contribution.lastSoftwareEngineerEvidenceInvalidatedReason,
          });
        }
      }
      return;
    }

    // Case 2: No contribution exists — check if a custom MCP server was registered
    // This catches the "subagent gap" where the agent delegated building to a
    // subagent and the PostToolUse auto-detect hook never fired.
    if (contribution) return; // Contribution exists at a non-testing/draft status — leave it alone

    const customServers = await findCustomMcpServers(configPath);
    if (customServers.length === 0) return;

    // Filter out servers already tracked by contributions from other sessions.
    // Without this guard, every post-turn check would try to create contributions
    // for pre-existing custom servers that were built in different sessions.
    //
    // Stage 2.D (260426): replace `toPortablePath().toLowerCase()` with
    // `canonicalizeConnectorPath` so the filter and the downstream
    // path-uniqueness guard converge on the same NFC + Linux-case-preserving
    // semantics (matrix #21).
    const allContributions = listContributions();
    const trackedNames = new Set(allContributions.map(c => c.connectorName.toLowerCase()));
    const trackedPaths = new Set(
      allContributions
        .filter((c): c is typeof c & { localServerPath: string } => !!c.localServerPath)
        .map(c => canonicalizeConnectorPath(c.localServerPath))
        .filter((p): p is string => p.length > 0),
    );

    const untrackedServers = customServers.filter(s =>
      !trackedNames.has(s.name.toLowerCase()) &&
      !trackedPaths.has(canonicalizeConnectorPath(s.serverPath)),
    );
    if (untrackedServers.length === 0) return;

    // Stage 2.D (260426): closes failure-matrix #5 (multi-connector hijack).
    // Process EVERY untracked server (no `break`); guard against in-batch
    // duplicates via `seenCanonicalPaths` and against concurrent ingress via
    // `getContributionByPath`. Two MCP-config entries that resolve to the
    // same canonical path produce ONE contribution, not two; an entry whose
    // path was created mid-sweep by another ingress site is also skipped.
    const seenCanonicalPaths = new Set<string>();
    for (const server of untrackedServers) {
      const pathClass = classifyContributionPath(server.serverPath);
      if (!isAllowedContributionPathClass(pathClass)) {
        logContributionPathContractViolation({
          gate: 'runPromotionSweep-case2',
          sessionId,
          connectorName: server.name,
          path: server.serverPath,
          classification: pathClass,
        });
        continue;
      }

      const canonical = canonicalizeConnectorPath(server.serverPath);
      // Pathless or duplicate-within-batch: skip (no NEW path-keyed identity
      // can be created). The filter above already excluded paths tracked at
      // sweep-start; this set guards against in-batch duplicates AND the
      // pathless / empty-canonical case.
      if (!canonical || seenCanonicalPaths.has(canonical)) continue;
      // Defence in depth: re-check against the live store. A concurrent
      // ingress (bridge `/contribution/report-state`, file-write hook) may
      // have created a record after `customServers` was built. Without this
      // guard a multi-connector race could double-create.
      if (getContributionByPath(canonical)) continue;

      const created = createContribution({
        sessionId,
        connectorName: server.name,
        status: 'testing',
        attributionMode: 'anonymous',
        localServerPath: server.serverPath,
      });
      const createdContributionId = (created as ConnectorContribution | undefined)?.id;
      await observeContribution({
        kind: 'server_registered',
        sessionId,
        localServerPath: server.serverPath,
        connectorName: server.name,
        source: 'post-turn-sweep',
      });
      const readyResult = await observeContribution({
        kind: 'ready_requested',
        sessionId,
        localServerPath: server.serverPath,
        connectorName: server.name,
        source: 'bridge-report-state',
      }, {
        enforceSoftwareEngineerEvidence,
      });
      if (readyResult.reason === 'missing_se_evidence') {
        maybeWriteMissingSeEvidenceTransitionError({
          contributionId: readyResult.contributionId ?? createdContributionId,
        });
      }
      seenCanonicalPaths.add(canonical);
      log.info(
        { sessionId, connectorName: server.name, serverPath: server.serverPath },
        'Auto-created contribution via post-turn MCP config scan (subagent gap recovery)',
      );
      // NO `break` — continue processing remaining untracked servers so
      // multi-connector sweeps create one record per untracked server.
    }
  } catch (error) {
    log.warn(
      {
        sessionId,
        err: error instanceof Error ? error.message : String(error),
      },
      'runPromotionSweep failed (non-critical)',
    );
  }
}

// ─── Self-block follow-on (260427) — stuck-registration backstop ────
//
// Sub-stage C of the contribution-flow self-block fix tranche. Detects
// records where the agent built+tested a connector but never called
// `rebel_mcp_add_server`, stamps a one-shot flag, and exposes a
// system-reminder builder that the agent-turn pipeline reads to inject
// a nudge into the next turn's prompt.
//
// See docs/plans/260427_contribution_flow_followon_self_block_at_registration.md § C

/**
 * Predicate: record is "stuck at registration" for THIS session.
 * Mirrors the plan § C Decision 2 predicate. The session-scope check
 * uses `linkedSessionIds.includes(sessionId)`; the freshness/turn-recency
 * is implicit because the readiness timestamps are populated only by
 * the current session's reducer (`contributionObservationService`).
 */
function isStuckAtRegistration(
  contribution: ConnectorContribution,
  sessionId: string,
): boolean {
  if (contribution.status !== 'draft' && contribution.status !== 'testing') return false;
  if (!contribution.lastBuildDetectedAt) return false;
  if (!contribution.lastTestPassedAt) return false;
  if (contribution.lastRegisteredAt) return false; // already registered — not stuck.
  if (contribution.stuckRegistrationNudgeFiredAt) return false; // idempotent.
  if (!(contribution.linkedSessionIds ?? []).includes(sessionId)) return false;
  return true;
}

/**
 * Walks every contribution linked to this session, finds any that match
 * the stuck-registration predicate, and stamps the one-shot
 * `stuckRegistrationNudgeFiredAt` flag under the per-canonical-path
 * mutex (G8). The flag is read by `buildStuckRegistrationReminder` on
 * the next turn.
 */
async function maybeFireStuckRegistrationNudge(sessionId: string): Promise<void> {
  let candidates: ReturnType<typeof getContributionsBySession>;
  try {
    candidates = getContributionsBySession(sessionId);
  } catch (err) {
    log.warn({ err, sessionId }, 'Stuck-registration sweep: failed to enumerate session contributions');
    return;
  }

  for (const contribution of candidates) {
    if (!isStuckAtRegistration(contribution, sessionId)) continue;

    const canonical = contribution.canonicalConnectorPath
      ?? (contribution.localServerPath
        ? canonicalizeConnectorPath(contribution.localServerPath)
        : '');

    const writeFlag = (): void => {
      // Re-read inside the critical section: a concurrent observation
      // may have populated `lastRegisteredAt` (e.g. add-server
      // PostToolUse fired between enumeration and the flag-write) and
      // racing the write would re-stamp a record that no longer needs
      // the nudge.
      const fresh = contribution.canonicalConnectorPath
        ? getContributionByPath(contribution.canonicalConnectorPath)
        : undefined;
      const target = fresh ?? contribution;
      if (!isStuckAtRegistration(target, sessionId)) return;
      const now = new Date().toISOString();
      markStuckRegistrationNudgeFired(target.id, now);
      log.warn(
        {
          sessionId,
          contributionId: target.id,
          connectorName: target.connectorName,
          firedAt: now,
          breadcrumb: 'stuck-registration-nudge-fired',
        },
        'Stuck-registration backstop: agent built and tested without registering — flagged for next-turn nudge',
      );
    };

    if (canonical) {
      // Per-record serialisation; loop length bounded by session contribution count.
      // Awaiting in the loop is intentional — flag-writes for different
      // canonical paths must not interleave with one another.
      await withCanonicalPathMutex(canonical, async () => {
        writeFlag();
      });
    } else {
      // Pathless record: write directly without mutex (no canonical key
      // to serialise on; pathless records are not touched by the
      // observation reducer).
      writeFlag();
    }
  }
}

/**
 * Builds the next-turn system-reminder text for any stuck-registration
 * records linked to this session. Returns `undefined` when nothing
 * needs nudging (no flag set, or `lastRegisteredAt` already became set
 * since the flag fired).
 *
 * The agent-turn pipeline (`agentTurnExecutor`) calls this just before
 * assembling the user message and prepends the result to the effective
 * prompt. Wrapped in a `<system-reminder>...</system-reminder>` block
 * so the agent recognises it as a reminder rather than user content.
 *
 * Plan § C Variant C.B — keep it simple, no IPC plumbing, no renderer
 * affordance.
 */
export function buildStuckRegistrationReminder(
  sessionId: string | undefined,
): string | undefined {
  if (!sessionId) return undefined;
  let candidates: ReturnType<typeof getContributionsBySession>;
  try {
    candidates = getContributionsBySession(sessionId);
  } catch {
    return undefined;
  }

  const stuck = candidates.filter(
    (c) =>
      !!c.stuckRegistrationNudgeFiredAt
      && !c.lastRegisteredAt
      && (c.status === 'draft' || c.status === 'testing'),
  );
  if (stuck.length === 0) return undefined;

  const lines = stuck.map((c) => {
    const name = c.connectorName || 'this connector';
    return `You built and tested ${name} but haven't registered it yet. Per build-custom-mcp-server SKILL.md § 6.4, register it now via rebel_mcp_add_server — skill invocation is consent.`;
  });

  return `<system-reminder>\n${lines.join('\n')}\n</system-reminder>`;
}
