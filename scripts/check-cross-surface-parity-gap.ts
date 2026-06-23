#!/usr/bin/env npx tsx
/**
 * CI validation: cross-surface parity-gap gate.
 *
 * The gate is intentionally read-only: every invocation reads fresh from disk,
 * shells out only to git diff / git ls-files, and keeps no state across runs.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitCapture } from './lib/git-exec.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HUNK_HEADER_REGEX = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
export const EXEMPT_REGEX = /\/\/\s*CROSS_SURFACE_PARITY_EXEMPT:\s*(\S.*)$/u;
export const MIN_STRONG_RATIONALE_LENGTH = 30;
export const WEAK_RATIONALE_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bTODO\b/iu, label: 'TODO' },
  { pattern: /\bFIXME\b/iu, label: 'FIXME' },
  { pattern: /\bXXX\b/iu, label: 'XXX' },
  { pattern: /\bWIP\b/iu, label: 'WIP' },
  { pattern: /\btemp(orary)?\b/iu, label: 'temp/temporary' },
  { pattern: /\blater\b/iu, label: 'later' },
];
const WARNING_PREFIX = '[cross-surface-parity-gap] WARNING:';
const INFO_PREFIX = '[cross-surface-parity-gap] INFO:';
const FATAL_PREFIX = '[cross-surface-parity-gap] FATAL:';
const SHORT_SHA_LENGTH = 7;
const ZERO_SHA_REGEX = /^0+$/u;
const DEFAULT_SETTINGS_FILE = 'src/shared/types/settings.ts';
const DEFAULT_CLOUD_SETTINGS_POLICY_FILE = 'src/shared/cloudSettingsPolicy.ts';
const DEFAULT_DESKTOP_REGISTRANT_FILES = ['src/main/index.ts', 'src/main/bootstrap.ts'] as const;
const DEFAULT_CLOUD_REGISTRANT_FILES = ['cloud-service/src/bootstrap.ts', 'cloud-service/src/platformInit.ts'] as const;
const CAPABILITY_SETTING_NAME_REGEX = /(provider|auth|token|client|service)/iu;
const NULL_SENTINEL_REGEX = /\bNULL_[A-Z_]+\b/u;
// A registrant whose entire body is a CONSTANT stub — `() => false`,
// `() => null`, `() => undefined`, `() => true`, or the braced equivalents
// (`() => { return false; }`). This is exactly how `registerManagedKeyAvailability(() => false)`
// silently passed parity on cloud while the managed-subscription feature was
// unserviceable for ~27 days (260623 postmortem). A constant stub asserts "this
// surface can never provide the capability", which is a real cross-surface gap —
// it must be acknowledged via an explicit CROSS_SURFACE_PARITY_EXEMPT comment,
// not silently accepted as parity. The optional whitespace + optional
// `async`/parens-around-body handling keeps the common formatting variants
// matched; richer bodies (anything that reads state) are NOT constant stubs.
export const CONSTANT_STUB_REGEX = /^\(\s*\)\s*=>\s*(?:\{\s*return\s+)?\(?\s*(?:false|true|null|undefined)\s*\)?\s*;?\s*\}?\s*$/u;
// Discovery regex for core boundary setters. The suffix alternation MUST cover
// every shape present in KNOWN_BOUNDARY_SETTERS so the inventory is
// self-rediscoverable — otherwise a new sibling of an inventoried shape (e.g.
// a second `set*Coordinator`/`set*Lease`/`set*Resolver`/`set*Factory`) ships
// undiscovered, which is the cross-surface-parity drift hole this guard closes.
// When you add an inventory entry with a new suffix, add that suffix here too.
// Two discovery shapes: `set*` with a boundary suffix (Provider|…|Tracker), and
// the `register*` prefix (registration hooks have varied suffixes, so matched on
// prefix alone). The `(?=[A-Z])` lookahead requires an uppercase char right after
// the prefix so camelCase setters/hooks match while lowercase `setup*` helpers
// (e.g. setupPromptService) do NOT — avoiding a false-positive class.
export const BOUNDARY_SETTER_EXPORT_REGEX = /\bexport\s+function\s+((?:set(?=[A-Z])[A-Za-z0-9_]*(?:Provider|Service|Reporter|Coordinator|Lease|Resolver|Transport|Factory|Registry|Config|Tracker))|(?:register(?=[A-Z])[A-Za-z0-9_]+))\s*\(/gu;

export interface BoundarySetterInventoryEntry {
  name: string;
  decl: string;
  nullSentinel?: string;
  /**
   * Extra desktop registrant file(s) to scan for this boundary's registration,
   * IN ADDITION to the default desktop registrant files (src/main/index.ts,
   * src/main/bootstrap.ts). For category-B seams whose desktop registration
   * lives outside the default registrant-file model — e.g.
   * `registerManagedKeyAvailability` is wired in
   * src/main/services/behindTheScenesClient.ts — so they can be parity-checked
   * (incl. the constant-stub check) without false-positiving "desktop missing".
   */
  extraDesktopRegistrantFiles?: readonly string[];
}

export const KNOWN_BOUNDARY_SETTERS = [
  { name: 'setPlatformConfig', decl: 'src/core/platform.ts' },
  { name: 'setStoreFactory', decl: 'src/core/storeFactory.ts' },
  { name: 'setHandlerRegistry', decl: 'src/core/handlerRegistry.ts' },
  { name: 'setBroadcastService', decl: 'src/core/broadcastService.ts' },
  { name: 'setErrorReporter', decl: 'src/core/errorReporter.ts' },
  { name: 'setFeedbackReporter', decl: 'src/core/feedbackReporter.ts' },
  { name: 'setTracker', decl: 'src/core/tracking.ts' },
  { name: 'setCodexAuthProvider', decl: 'src/core/codexAuth.ts', nullSentinel: 'NULL_CODEX_AUTH_PROVIDER' },
  { name: 'setRebelAuthProvider', decl: 'src/core/rebelAuth.ts', nullSentinel: 'NULL_REBEL_AUTH_PROVIDER' },
  { name: 'setTokenSyncCoordinator', decl: 'src/core/setTokenSyncCoordinator.ts', nullSentinel: 'NULL_TOKEN_SYNC_COORDINATOR' },
  { name: 'setTokenSyncTransport', decl: 'src/core/setTokenSyncTransport.ts', nullSentinel: 'NULL_TOKEN_SYNC_TRANSPORT' },
  { name: 'setCrossProcessLease', decl: 'src/core/setCrossProcessLease.ts', nullSentinel: 'NULL_CROSS_PROCESS_LEASE' },
  { name: 'setOAuthToolResolver', decl: 'src/core/setOAuthToolResolver.ts', nullSentinel: 'NULL_OAUTH_TOOL_RESOLVER' },
  { name: 'setSafetyEvaluationService', decl: 'src/core/safetyEvaluationService.ts' },
  { name: 'setScreenshotCaptureService', decl: 'src/core/screenshotCaptureService.ts' },
  { name: 'setAppNavigationService', decl: 'src/core/appNavigationService.ts' },
  // Classified 260607 (Phase 6): registration-shape boundary seams wired on BOTH
  // desktop (src/main/index.ts) and cloud (cloud-service/src/bootstrap.ts) — they
  // pass Rule A parity and must be parity-checked, not grandfathered.
  { name: 'setCurrentUserProviderFactory', decl: 'src/core/currentUserProvider.ts' },
  { name: 'setDesktopNotificationSinkFactory', decl: 'src/core/desktopNotificationSink.ts' },
  { name: 'setDockBadgeFactory', decl: 'src/core/dockBadge.ts' },
  { name: 'setEmbeddingGeneratorFactory', decl: 'src/core/embeddingGenerator.ts' },
  { name: 'setPowerSaveBlockerFactory', decl: 'src/core/powerSaveBlocker.ts' },
  { name: 'setPreTurnWorkerFactory', decl: 'src/core/preTurnWorker.ts' },
  { name: 'setProcessSpawnerFactory', decl: 'src/core/processSpawner.ts' },
  { name: 'setPushNotificationSinkFactory', decl: 'src/core/pushNotificationSink.ts' },
  { name: 'setSchedulerFactory', decl: 'src/core/scheduler.ts' },
  { name: 'setSecureTokenStoreFactory', decl: 'src/core/secureTokenStore.ts' },
  { name: 'setWorkspaceFileSystemFactory', decl: 'src/core/workspaceFileSystem/index.ts' },
  // Classified 260607 (Stage 5): register* hooks wired on BOTH desktop + cloud
  // standard registrant files — parity-checked, not grandfathered.
  // 260609 (proxy-resolution-seam): the two split registers collapsed into one
  // atomic registration. Still wired on both desktop (src/main/index.ts) + cloud
  // (cloud-service/src/bootstrap.ts) → parity-checked.
  { name: 'registerBtsProxyProviders', decl: 'src/core/services/bts/transports/shared.ts' },
  // Promoted 260623 from GRANDFATHERED (category B) → parity-checked: this is the
  // exact seam whose cloud `() => false` constant stub silently passed parity
  // while the managed Mindstone subscription was unserviceable on cloud/mobile
  // for ~27 days (see docs-private/postmortems/260623_mobile_managed_subscription_cloud_parity_silent_noresponse_postmortem.md).
  // Desktop wires `() => hasManagedOpenRouterKey()` in behindTheScenesClient.ts
  // (outside the default desktop registrant files), so it carries an explicit
  // extraDesktopRegistrantFiles. The cloud `() => false` stub is now a tracked
  // CROSS_SURFACE_PARITY_EXEMPT (loud, not silent) until Layer-3 parity lands.
  {
    name: 'registerManagedKeyAvailability',
    decl: 'src/core/rebelCore/managedKeyAvailability.ts',
    extraDesktopRegistrantFiles: ['src/main/services/behindTheScenesClient.ts'],
  },
] as const satisfies readonly BoundarySetterInventoryEntry[];

/**
 * Setters/hooks whose NAME SHAPE matches BOUNDARY_SETTER_EXPORT_REGEX but which
 * are NOT parity-checkable by this guard, for one of two verified reasons (260607):
 *
 *   (A) genuinely SINGLE-SURFACE or no production desktop↔cloud pair, so a
 *       parity check would be a false positive:
 *         - setCodexVoiceConfig — desktop-only (voice); src/main/index.ts.
 *         - registerLocalTranscriber — desktop-only; src/main/index.ts:6605.
 *         - registerAutomationScript — no production registrant in main/cloud.
 *         - registerCloudApprovalMetadata — desktop/main only;
 *           src/main/services/cloud/cloudRouter.ts:737.
 *         - registerSpaceScanCacheInvalidationListener — desktop-only;
 *           src/main/ipc/libraryHandlers.ts:1322.
 *
 *   (B) wired on BOTH surfaces but the registration lives OUTSIDE the guard's
 *       registrant-file model (it only scans src/main/index.ts +
 *       src/main/bootstrap.ts and cloud-service/src/{bootstrap,platformInit}.ts),
 *       so inventorying would false-positive as one-surface-missing. Verified
 *       both-surface (call sites below) 260607:
 *         - setUserQuestionProvenanceResolver — desktop src/main/ipc/agentHandlers.ts:524,
 *           cloud cloud-service/src/bootstrap.ts:1441.
 *         - (registerManagedKeyAvailability was category B here until 260623; it is
 *           now in KNOWN_BOUNDARY_SETTERS with an extraDesktopRegistrantFiles
 *           override pointing at behindTheScenesClient.ts, so it is parity-checked.)
 *         - registerUserQuestionResponseHandler — desktop src/main/ipc/agentHandlers.ts:529,
 *           cloud cloud-service/src/bootstrap.ts:1440.
 *         - registerPreOAuthCallHook — registered in the shared
 *           src/core/services/headlessRuntime.ts:370, invoked by BOTH desktop
 *           (src/main/index.ts) and cloud (cloud-service/src/bootstrap.ts).
 *
 * (A future per-boundary `extraDesktopRegistrantFiles` model could promote the
 * category-B entries to real parity checks; out of scope here.)
 *
 * This list is a RATCHET, enforced by a snapshot test: it must not GROW silently.
 * When you add a new core setter/hook whose name matches the discovery regex,
 * do NOT reflexively add it here — first decide:
 *   - desktop/cloud boundary seam wired on BOTH (in the standard registrant
 *     files) → add to KNOWN_BOUNDARY_SETTERS so it is parity-checked.
 *   - genuinely single-surface or registered outside the registrant-file model
 *     → rename/move it out of the matched shape, or add it here WITH which
 *     category (A/B) and why.
 */
export const GRANDFATHERED_UNCLASSIFIED_SETTERS = [
  // (A) single-surface / no production desktop↔cloud pair
  { name: 'setCodexVoiceConfig', decl: 'src/core/services/audioService.ts' },
  { name: 'registerLocalTranscriber', decl: 'src/core/services/audioService.ts' },
  { name: 'registerAutomationScript', decl: 'src/core/services/automations/scriptRegistry.ts' },
  { name: 'registerCloudApprovalMetadata', decl: 'src/core/services/safety/toolSafetyService.ts' },
  { name: 'registerSpaceScanCacheInvalidationListener', decl: 'src/core/services/space/spaceService.ts' },
  // NOTE (260609 proxy-resolution-seam): the explicit "no BTS proxy" declaration is
  // named `declareNoBtsProxy` (NOT register*/set*) precisely so it stays OUT of the
  // boundary-setter discovery shape — it's a sentinel used by evals/tests, not a
  // desktop↔cloud capability pair, so it needs no inventory/grandfather entry.
  // (A) registerContributionRelayExtension — desktop-only (260607 B3 carve-out S7).
  // Contribution submission is a desktop feature; cloud-service has NO relay
  // registrant (grep confirms zero references). The public dispatcher's relay
  // branch is supplied ONLY by the desktop private-mindstone bootstrap (real
  // mode); OSS/stub leaves it unregistered → getContributionRelayExtension()
  // returns null → RELAY_UNAVAILABLE_OSS_BUILD. The real-vs-OSS-stub split is a
  // build-mode concern, NOT a desktop↔cloud parity pair, so this guard's
  // desktop/cloud model does not apply.
  { name: 'registerContributionRelayExtension', decl: 'src/core/services/contributionRelayExtension.ts' },
  // (A) setOAuthCredentialsProvider — desktop-only (260608 commercial OAuth restore).
  // Injects the commercial OAuth client-credentials fallback into the env-only core
  // resolver. Registered ONLY on desktop (src/main/index.ts, from @private/mindstone);
  // cloud-service has its OWN env-only path (managedSlackClientCredentials) and never
  // calls this setter (grep confirms zero cloud references), mobile has zero references.
  // The real-vs-OSS-stub split (commercial provider vs empty stub) is a build-mode
  // concern, NOT a desktop↔cloud parity pair — same shape as registerContributionRelayExtension
  // above — so this guard's desktop/cloud parity model does not apply.
  { name: 'setOAuthCredentialsProvider', decl: 'src/core/services/oauthCredentials.ts' },
  // (A) setMeetingBotBackendConfigProvider — desktop-only (260622 meeting bot secret leak).
  // Injects the commercial meeting-bot backend fallback into the env-first core
  // resolver. Registered ONLY on desktop (src/main/index.ts, from @private/mindstone);
  // cloud-service has its OWN env-only path (resolveMeetingBotBackendConfig) and never
  // calls this setter (grep confirms zero cloud references), mobile has zero references.
  // The real-vs-OSS-stub split (commercial provider vs empty stub) is a build-mode
  // concern, NOT a desktop↔cloud parity pair — same shape as registerContributionRelayExtension
  // above — so this guard's desktop/cloud parity model does not apply.
  { name: 'setMeetingBotBackendConfigProvider', decl: 'src/core/services/meetingBotBackendConfig.ts' },
  // (B) both-surface, but registered outside the guard's registrant-file model
  { name: 'setUserQuestionProvenanceResolver', decl: 'src/core/services/userQuestionResponseHandler.ts' },
  // registerManagedKeyAvailability was promoted out of this list 260623 → it is
  // now parity-checked via KNOWN_BOUNDARY_SETTERS with an extraDesktopRegistrantFiles
  // override (its desktop registrant lives in behindTheScenesClient.ts). See the
  // inventory entry + the 260623 managed-subscription cloud-parity postmortem.
  { name: 'registerUserQuestionResponseHandler', decl: 'src/core/services/userQuestionResponseHandler.ts' },
  { name: 'registerPreOAuthCallHook', decl: 'src/core/services/bts/transports/shared.ts' },
] as const satisfies readonly BoundarySetterInventoryEntry[];

type FatalPhase = 'parse' | 'discovery' | 'diff';

export interface Violation {
  file: string;
  line: number;
  ruleId: string;
  message: string;
  suggestedFix: string;
}

export interface ChangedLine {
  file: string;
  line: number;
  text: string;
}

export interface ExemptComment {
  file: string;
  line: number;
  reason: string;
}

export interface AcknowledgedExemptionManifestEntry {
  file: string;
  target: string;
}

export interface AcknowledgedExemption extends ExemptComment {
  target: string;
}

interface UnresolvedAcknowledgedExemption {
  exemption: ExemptComment;
  explanation: string;
}

interface WeakAcknowledgedExemptionRationale {
  exemption: ExemptComment;
  explanation: string;
}

export interface AcknowledgedExemptionBaselineCheck {
  actual: AcknowledgedExemption[];
  missing: AcknowledgedExemptionManifestEntry[];
  unexpected: AcknowledgedExemption[];
  unresolved: UnresolvedAcknowledgedExemption[];
  weakRationales: WeakAcknowledgedExemptionRationale[];
  duplicateKeys: string[];
  ok: boolean;
}

export const EXPECTED_ACKNOWLEDGED_EXEMPTIONS = [
  // 260623 (Layer 3 / DI-05): the `registerManagedKeyAvailability` exemption was
  // REMOVED — cloud now wires a real registrant `() => hasManagedOpenRouterKey()`
  // (cloud-service/src/bootstrap.ts), the same live-store read as desktop, so the
  // seam is genuine cross-surface parity, not a constant `() => false` stub. See
  // docs/plans/260622_mobile-record-recreated-session/PLAN.md Stage L3a.
  { file: 'src/core/appNavigationService.ts', target: 'setAppNavigationService' },
  { file: 'src/core/rebelAuth.ts', target: 'setRebelAuthProvider' },
  { file: 'src/core/screenshotCaptureService.ts', target: 'setScreenshotCaptureService' },
  { file: 'src/shared/types/settings.ts', target: 'field:activeProvider' },
  { file: 'src/shared/types/settings.ts', target: 'field:enabledProviders' },
  { file: 'src/shared/types/settings.ts', target: 'field:managedProviderDeactivated' },
] as const satisfies readonly AcknowledgedExemptionManifestEntry[];

export interface CrossSurfaceParityGapResult {
  violations: Violation[];
  warnings: string[];
  scannedBoundaryCount: number;
  scannedSettingsCount: number;
  exemptedCount: number;
  exemptions: ExemptComment[];
  acknowledgedExemptionBaseline?: AcknowledgedExemptionBaselineCheck;
}

type DiffQuery =
  | { mode: 'name-only'; staged: boolean; baseRef?: string }
  | { mode: 'file-diff'; staged: boolean; baseRef?: string; file: string };

export type DiffProvider = (query: DiffQuery, cwd: string) => string;
export type FileReader = (absolutePath: string) => string;

export interface FindCrossSurfaceParityGapOptions {
  allFiles?: boolean;
  warnOnRuleBDiffScopeInAllFiles?: boolean;
  staged?: boolean;
  baseRef?: string;
  registryPath?: string;
  repoRoot?: string;
  diffProvider?: DiffProvider;
  fileReader?: FileReader;
  trackedFilesProvider?: (cwd: string) => string[];
}

interface CrossSurfaceParityGapRegistry {
  boundarySetters?: BoundarySetterInventoryEntry[];
  settingsFile?: string;
  cloudSettingsPolicyFile?: string;
  desktopRegistrantFiles?: string[];
  cloudRegistrantFiles?: string[];
}

interface CliArgs {
  allFiles: boolean;
  staged: boolean;
  listExemptions: boolean;
  updateAcknowledgedExemptions: boolean;
  baseRef?: string;
  registryPath?: string;
  help: boolean;
}

interface TextWriter {
  write(chunk: string): unknown;
}

interface CliStreams {
  stdout: TextWriter;
  stderr: TextWriter;
}

interface DiffBaseSelection {
  baseRef?: string;
  infoMessage?: string;
  warningMessage?: string;
}

class CrossSurfaceParityGapFatalError extends Error {
  readonly phase: FatalPhase;
  readonly hint: string;

  constructor(message: string, phase: FatalPhase, hint: string) {
    super(message);
    this.name = 'CrossSurfaceParityGapFatalError';
    this.phase = phase;
    this.hint = hint;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function defaultDiffProvider(query: DiffQuery, cwd: string): string {
  if (query.mode === 'name-only') {
    const args = query.baseRef
      ? ['diff', '--name-only', `${query.baseRef}...HEAD`]
      : query.staged
      ? ['diff', '--cached', '--name-only']
      : ['diff', '--name-only', 'HEAD'];
    return gitCapture(args, { cwd });
  }

  const args = query.baseRef
    ? ['diff', '-U0', `${query.baseRef}...HEAD`, '--', query.file]
    : query.staged
    ? ['diff', '--cached', '-U0', '--', query.file]
    : ['diff', '-U0', 'HEAD', '--', query.file];
  return gitCapture(args, { cwd });
}

function defaultTrackedFilesProvider(cwd: string): string[] {
  const output = gitCapture(['ls-files'], { cwd });
  return output
    .split('\n')
    .map((file) => normalizePath(file.trim()))
    .filter(isScannableSourceFile);
}

function parsePatchPath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === '/dev/null') return null;
  if (trimmed.startsWith('a/') || trimmed.startsWith('b/')) {
    return normalizePath(trimmed.slice(2));
  }
  return normalizePath(trimmed);
}

export function parseUnifiedDiff(diffOutput: string): ChangedLine[] {
  const changedLines: ChangedLine[] = [];
  const lines = diffOutput.split('\n');

  let currentFile: string | null = null;
  let currentLineNumber = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      currentFile = parsePatchPath(line.slice(4));
      inHunk = false;
      continue;
    }

    if (line.startsWith('@@ ')) {
      const match = line.match(HUNK_HEADER_REGEX);
      if (!match) {
        inHunk = false;
        continue;
      }
      currentLineNumber = Number.parseInt(match[1], 10);
      inHunk = true;
      continue;
    }

    if (!inHunk || !currentFile) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      changedLines.push({
        file: currentFile,
        line: currentLineNumber,
        text: line.slice(1),
      });
      currentLineNumber += 1;
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) continue;

    if (line.startsWith(' ')) currentLineNumber += 1;
  }

  return changedLines;
}

function parseNameOnlyOutput(output: string): string[] {
  return output
    .split('\n')
    .map((line) => normalizePath(line.trim()))
    .filter(isScannableSourceFile);
}

function isScannableSourceFile(file: string): boolean {
  if (!file) return false;
  const extension = extname(file);
  if (!['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].includes(extension)) {
    return false;
  }
  return !file.includes('/node_modules/')
    && !file.includes('/dist/')
    && !file.includes('/build/')
    && !file.includes('/__fixtures__/')
    && !file.startsWith('storybook-static/');
}

function readLinesForFile(
  relativeFile: string,
  cwd: string,
  fileReader: (absolutePath: string) => string,
): ChangedLine[] {
  const absolutePath = resolve(cwd, relativeFile);
  if (!existsSync(absolutePath)) return [];
  const source = fileReader(absolutePath);
  return source.split(/\r?\n/).map((text, index) => ({
    file: relativeFile,
    line: index + 1,
    text,
  }));
}

function getCandidateFiles(params: {
  allFiles: boolean;
  staged: boolean;
  baseRef?: string;
  cwd: string;
  diffProvider: DiffProvider;
  trackedFilesProvider: (cwd: string) => string[];
}): string[] {
  const rawFiles = params.allFiles
    ? params.trackedFilesProvider(params.cwd)
    : parseNameOnlyOutput(params.diffProvider(
      { mode: 'name-only', staged: params.staged, baseRef: params.baseRef },
      params.cwd,
    ));

  return [...new Set(rawFiles.map(normalizePath).filter((file) => (
    isScannableSourceFile(file) && existsSync(resolve(params.cwd, file))
  )))].sort();
}

function getAllScannableFiles(
  cwd: string,
  trackedFilesProvider: (cwd: string) => string[],
): string[] {
  return [...new Set(trackedFilesProvider(cwd).map(normalizePath).filter((file) => (
    isScannableSourceFile(file) && existsSync(resolve(cwd, file))
  )))].sort();
}

function getChangedLines(params: {
  allFiles: boolean;
  staged: boolean;
  baseRef?: string;
  cwd: string;
  file: string;
  diffProvider: DiffProvider;
  fileReader: (absolutePath: string) => string;
}): ChangedLine[] {
  if (params.allFiles) {
    return readLinesForFile(params.file, params.cwd, params.fileReader);
  }

  return parseUnifiedDiff(
    params.diffProvider(
      { mode: 'file-diff', staged: params.staged, baseRef: params.baseRef, file: params.file },
      params.cwd,
    ),
  ).filter((line) => normalizePath(line.file) === params.file);
}

type CommentRange = readonly [startInclusive: number, endExclusive: number];
type SourceRange = readonly [startInclusive: number, endExclusive: number];

function getBlockCommentRangesByLine(
  lines: string[],
  opts: { file: string; warnings?: string[] } | undefined = undefined,
): CommentRange[][] {
  const rangesByLine: CommentRange[][] = [];
  let inBlockComment = false;
  let blockCommentStartLine: number | null = null;
  let stringQuote: '"' | "'" | '`' | null = null;

  for (const [lineIndex, line] of lines.entries()) {
    const lineNumber = lineIndex + 1;
    const ranges: CommentRange[] = [];
    let index = 0;

    while (index < line.length) {
      const char = line[index];
      const next = line[index + 1];

      if (inBlockComment) {
        const end = line.indexOf('*/', index);
        if (end === -1) {
          ranges.push([index, line.length]);
          index = line.length;
          continue;
        }
        ranges.push([index, end + 2]);
        inBlockComment = false;
        blockCommentStartLine = null;
        index = end + 2;
        continue;
      }

      if (stringQuote) {
        if (char === '\\') {
          index += 2;
          continue;
        }
        if (char === stringQuote) {
          stringQuote = null;
        }
        index += 1;
        continue;
      }

      if (char === '"' || char === "'" || char === '`') {
        stringQuote = char;
        index += 1;
        continue;
      }

      if (char === '/' && next === '/') {
        break;
      }

      if (char !== '/' || next !== '*') {
        index += 1;
        continue;
      }

      const blockEnd = line.indexOf('*/', index + 2);
      if (blockEnd === -1) {
        ranges.push([index, line.length]);
        inBlockComment = true;
        blockCommentStartLine = lineNumber;
        index = line.length;
        continue;
      }

      ranges.push([index, blockEnd + 2]);
      index = blockEnd + 2;
    }

    if (stringQuote !== '`') {
      stringQuote = null;
    }
    rangesByLine.push(ranges);
  }

  if (inBlockComment && blockCommentStartLine !== null) {
    opts?.warnings?.push(
      `Unclosed /* block comment in ${opts.file} starting at line ${blockCommentStartLine}; subsequent escape-hatch comments in this file may be unreachable.`,
    );
  }

  return rangesByLine;
}

function indexIsInsideRanges(index: number, ranges: readonly CommentRange[]): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function getCommentOrStringRanges(source: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      const newlineIndex = source.indexOf('\n', index + 2);
      const end = newlineIndex === -1 ? source.length : newlineIndex;
      ranges.push([index, end]);
      index = end;
      continue;
    }

    if (char === '/' && next === '*') {
      const closeIndex = source.indexOf('*/', index + 2);
      const end = closeIndex === -1 ? source.length : closeIndex + 2;
      ranges.push([index, end]);
      index = end;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      const start = index;
      index += 1;

      while (index < source.length) {
        const current = source[index];
        if (current === '\\') {
          index += 2;
          continue;
        }
        index += 1;
        if (current === quote) break;
      }

      ranges.push([start, index]);
      continue;
    }

    index += 1;
  }

  return ranges;
}

function indexIsInsideSourceRanges(index: number, ranges: readonly SourceRange[]): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function previousNonWhitespaceCharacter(source: string, index: number): string | null {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = source[cursor];
    if (char === undefined) continue;
    if (char === '\n' || char === '\r') return null;
    if (!/\s/u.test(char)) return char;
  }
  return null;
}

function findLineCommentStartOutsideRanges(lineText: string, ranges: readonly CommentRange[]): number {
  let stringQuote: '"' | "'" | '`' | null = null;

  for (let index = 0; index < lineText.length - 1; index += 1) {
    if (indexIsInsideRanges(index, ranges)) continue;

    const char = lineText[index];
    const next = lineText[index + 1];
    if (stringQuote) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === stringQuote) stringQuote = null;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      stringQuote = char;
      continue;
    }
    if (char === '/' && next === '/') {
      return index;
    }
  }

  return -1;
}

function parseExemptCommentFromLine(params: {
  file: string;
  lineNumber: number;
  lineText: string;
  blockCommentRanges: readonly CommentRange[];
}): ExemptComment | null {
  const commentStart = findLineCommentStartOutsideRanges(params.lineText, params.blockCommentRanges);
  if (commentStart < 0) return null;

  const match = params.lineText.slice(commentStart).match(EXEMPT_REGEX);
  if (!match) return null;

  const [, reason] = match;
  const trimmedReason = reason.trim();
  if (trimmedReason.length < 5) return null;

  return {
    file: params.file,
    line: params.lineNumber,
    reason: trimmedReason,
  };
}

export function findExemptCommentNear(file: string, line: number, windowAbove = 1): ExemptComment | null {
  if (line < 1) return null;
  const source = readFileSync(file, 'utf8');
  const lines = source.split(/\r?\n/);
  const blockRanges = getBlockCommentRangesByLine(lines, { file });
  const startLine = Math.max(1, line - windowAbove);
  const endLine = Math.min(line, lines.length);

  for (let lineNumber = endLine; lineNumber >= startLine; lineNumber -= 1) {
    const exempt = parseExemptCommentFromLine({
      file,
      lineNumber,
      lineText: lines[lineNumber - 1] ?? '',
      blockCommentRanges: blockRanges[lineNumber - 1] ?? [],
    });
    if (exempt) return exempt;
  }

  return null;
}

function scanExemptions(params: {
  files: readonly string[];
  cwd: string;
  fileReader: FileReader;
  warnings: string[];
}): ExemptComment[] {
  const exemptions: ExemptComment[] = [];

  for (const file of params.files) {
    const absolutePath = resolve(params.cwd, file);
    if (!existsSync(absolutePath)) continue;

    const lines = params.fileReader(absolutePath).split(/\r?\n/);
    const blockRanges = getBlockCommentRangesByLine(lines, {
      file,
      warnings: params.warnings,
    });
    lines.forEach((lineText, index) => {
      const exempt = parseExemptCommentFromLine({
        file,
        lineNumber: index + 1,
        lineText,
        blockCommentRanges: blockRanges[index] ?? [],
      });
      if (exempt) exemptions.push(exempt);
    });
  }

  return exemptions.sort(compareExemptions);
}

function compareExemptions(a: ExemptComment, b: ExemptComment): number {
  return a.file.localeCompare(b.file) || a.line - b.line || a.reason.localeCompare(b.reason);
}

interface RuleCheckOptions {
  changedLinesByFile: Map<string, ReadonlySet<number>>;
  candidateFiles: readonly string[];
  allScannableFiles: readonly string[];
  repoRoot: string;
  fileReader: FileReader;
  allFiles: boolean;
  warnings: string[];
  registry: ResolvedRegistry;
}

interface ResolvedRegistry {
  boundarySetters: readonly BoundarySetterInventoryEntry[];
  settingsFile: string;
  cloudSettingsPolicyFile: string;
  desktopRegistrantFiles: readonly string[];
  cloudRegistrantFiles: readonly string[];
}

interface SourceFile {
  file: string;
  absolutePath: string;
  source: string;
  lines: string[];
  blockRanges: CommentRange[][];
  nonCodeRanges: SourceRange[];
}

interface BoundarySetter {
  name: string;
  decl: string;
  declLine: number;
  nullSentinel?: string;
  extraDesktopRegistrantFiles?: readonly string[];
}

interface CallExpression {
  file: string;
  line: number;
  argument: string;
  containsNullSentinel: boolean;
  isConstantStub: boolean;
}

interface AppSettingsKey {
  name: string;
  declLine: number;
  valueEndLine: number;
  typeRhs: string;
}

interface AppSettingsParseResult {
  keys: AppSettingsKey[];
  aliases: Map<string, string>;
}

function resolveRegistry(params: {
  cwd: string;
  registryPath: string | undefined;
  fileReader: FileReader;
}): ResolvedRegistry {
  if (params.registryPath === undefined) {
    return {
      boundarySetters: KNOWN_BOUNDARY_SETTERS,
      settingsFile: DEFAULT_SETTINGS_FILE,
      cloudSettingsPolicyFile: DEFAULT_CLOUD_SETTINGS_POLICY_FILE,
      desktopRegistrantFiles: DEFAULT_DESKTOP_REGISTRANT_FILES,
      cloudRegistrantFiles: DEFAULT_CLOUD_REGISTRANT_FILES,
    };
  }

  const absolutePath = resolve(params.cwd, params.registryPath);
  let parsed: CrossSurfaceParityGapRegistry;
  try {
    parsed = JSON.parse(params.fileReader(absolutePath)) as CrossSurfaceParityGapRegistry;
  } catch (error) {
    throw new CrossSurfaceParityGapFatalError(
      `Unable to parse --registry-path JSON: ${params.registryPath}: ${errorMessage(error)}`,
      'parse',
      'Use a JSON object with optional boundarySetters/settingsFile/cloudSettingsPolicyFile registrant override fields.',
    );
  }

  return {
    boundarySetters: parsed.boundarySetters ?? KNOWN_BOUNDARY_SETTERS,
    settingsFile: normalizePath(parsed.settingsFile ?? DEFAULT_SETTINGS_FILE),
    cloudSettingsPolicyFile: normalizePath(parsed.cloudSettingsPolicyFile ?? DEFAULT_CLOUD_SETTINGS_POLICY_FILE),
    desktopRegistrantFiles: (parsed.desktopRegistrantFiles ?? DEFAULT_DESKTOP_REGISTRANT_FILES).map(normalizePath),
    cloudRegistrantFiles: (parsed.cloudRegistrantFiles ?? DEFAULT_CLOUD_REGISTRANT_FILES).map(normalizePath),
  };
}

function readSourceFile(params: {
  cwd: string;
  file: string;
  fileReader: FileReader;
  warnings?: string[];
}): SourceFile {
  const file = normalizePath(params.file);
  const absolutePath = resolve(params.cwd, file);
  if (!existsSync(absolutePath)) {
    throw new CrossSurfaceParityGapFatalError(
      `Required file does not exist: ${file}`,
      'discovery',
      'Update the cross-surface parity-gap registry or restore the expected source file.',
    );
  }

  const source = params.fileReader(absolutePath);
  const lines = source.split(/\r?\n/);
  return {
    file,
    absolutePath,
    source,
    lines,
    blockRanges: getBlockCommentRangesByLine(lines, { file, warnings: params.warnings }),
    nonCodeRanges: getCommentOrStringRanges(source),
  };
}

function lineNumberAtIndex(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findExemptCommentNearSource(sourceFile: SourceFile, line: number, windowAbove = 1): ExemptComment | null {
  if (line < 1) return null;
  const startLine = Math.max(1, line - windowAbove);
  const endLine = Math.min(line, sourceFile.lines.length);

  for (let lineNumber = endLine; lineNumber >= startLine; lineNumber -= 1) {
    const exempt = parseExemptCommentFromLine({
      file: sourceFile.file,
      lineNumber,
      lineText: sourceFile.lines[lineNumber - 1] ?? '',
      blockCommentRanges: sourceFile.blockRanges[lineNumber - 1] ?? [],
    });
    if (exempt) return exempt;
  }

  return null;
}

export type ExemptionRationaleVerdict = { strong: true } | { strong: false; explanation: string };

export function validateExemptionRationale(rationale: string): ExemptionRationaleVerdict {
  const trimmed = rationale.trim();
  if (trimmed.length < MIN_STRONG_RATIONALE_LENGTH) {
    return {
      strong: false,
      explanation: `rationale is ${trimmed.length} characters; minimum ${MIN_STRONG_RATIONALE_LENGTH} required — state the specific desktop API or constraint that justifies the exemption`,
    };
  }
  for (const { pattern, label } of WEAK_RATIONALE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        strong: false,
        explanation: `rationale contains weak marker "${label}" — explain the actual constraint instead of deferring`,
      };
    }
  }
  return { strong: true };
}

function acknowledgedExemptionKey(entry: AcknowledgedExemptionManifestEntry): string {
  return `${entry.file}\t${entry.target}`;
}

function compareAcknowledgedManifestEntries(
  a: AcknowledgedExemptionManifestEntry,
  b: AcknowledgedExemptionManifestEntry,
): number {
  return a.file.localeCompare(b.file) || a.target.localeCompare(b.target);
}

function compareAcknowledgedExemptions(a: AcknowledgedExemption, b: AcknowledgedExemption): number {
  return compareAcknowledgedManifestEntries(a, b) || a.line - b.line || a.reason.localeCompare(b.reason);
}

function resolveAcknowledgedExemptionTarget(params: {
  exemption: ExemptComment;
  cwd: string;
  fileReader: FileReader;
}): { target: string } | { explanation: string } {
  const absolutePath = resolve(params.cwd, params.exemption.file);
  if (!existsSync(absolutePath)) {
    return { explanation: `source file does not exist: ${params.exemption.file}` };
  }

  const sourceLines = params.fileReader(absolutePath).split(/\r?\n/);
  const sameLine = sourceLines[params.exemption.line - 1] ?? '';
  const nextLine = sourceLines[params.exemption.line] ?? '';
  const candidateLines = [sameLine, nextLine];

  for (const lineText of candidateLines) {
    const functionMatch = lineText.match(/\bexport function ((?:set|register)[A-Za-z0-9_]+)\s*\(/u);
    if (functionMatch?.[1]) return { target: functionMatch[1] };
  }

  // Call-site exemption (e.g. a constant-stub registrant in a cloud bootstrap:
  // `registerManagedKeyAvailability(() => false)`). The exemption sits on/above
  // the call, not a declaration — resolve its target to the invoked setter name
  // so the acknowledged-exemption baseline can track it like a declaration target.
  for (const lineText of candidateLines) {
    const callMatch = lineText.match(/(?:^|[^.\w])((?:set|register)[A-Za-z0-9_]+)\s*\(/u);
    if (callMatch?.[1]) return { target: callMatch[1] };
  }

  for (const lineText of candidateLines) {
    const fieldMatch = lineText.match(/^\s*([a-zA-Z_][A-Za-z0-9_]*)\??:/u);
    if (fieldMatch?.[1]) return { target: `field:${fieldMatch[1]}` };
  }

  return {
    explanation: 'exemption must sit immediately above, or on the same line as, an exported boundary setter or settings field',
  };
}

function scanAcknowledgedExemptionBaseline(params: {
  files: readonly string[];
  cwd: string;
  fileReader: FileReader;
  warnings: string[];
  expected?: readonly AcknowledgedExemptionManifestEntry[];
}): AcknowledgedExemptionBaselineCheck {
  const expected = params.expected ?? EXPECTED_ACKNOWLEDGED_EXEMPTIONS;
  const rawExemptions = scanExemptions({
    files: params.files,
    cwd: params.cwd,
    fileReader: params.fileReader,
    warnings: params.warnings,
  });
  const actual: AcknowledgedExemption[] = [];
  const unresolved: UnresolvedAcknowledgedExemption[] = [];
  const weakRationales: WeakAcknowledgedExemptionRationale[] = [];

  for (const exemption of rawExemptions) {
    const rationaleVerdict = validateExemptionRationale(exemption.reason);
    if (!rationaleVerdict.strong) {
      weakRationales.push({ exemption, explanation: rationaleVerdict.explanation });
    }

    const resolved = resolveAcknowledgedExemptionTarget({
      exemption,
      cwd: params.cwd,
      fileReader: params.fileReader,
    });
    if ('explanation' in resolved) {
      unresolved.push({ exemption, explanation: resolved.explanation });
      continue;
    }
    actual.push({ ...exemption, target: resolved.target });
  }

  const actualKeyCounts = new Map<string, number>();
  for (const exemption of actual) {
    const key = acknowledgedExemptionKey(exemption);
    actualKeyCounts.set(key, (actualKeyCounts.get(key) ?? 0) + 1);
  }

  const expectedKeys = new Set(expected.map(acknowledgedExemptionKey));
  const actualKeys = new Set(actual.map(acknowledgedExemptionKey));
  const missing = expected
    .filter((entry) => !actualKeys.has(acknowledgedExemptionKey(entry)))
    .sort(compareAcknowledgedManifestEntries);
  const unexpected = actual
    .filter((entry) => !expectedKeys.has(acknowledgedExemptionKey(entry)))
    .sort(compareAcknowledgedExemptions);
  const duplicateKeys = [...actualKeyCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort();

  return {
    actual: actual.sort(compareAcknowledgedExemptions),
    missing,
    unexpected,
    unresolved,
    weakRationales,
    duplicateKeys,
    ok: missing.length === 0
      && unexpected.length === 0
      && unresolved.length === 0
      && weakRationales.length === 0
      && duplicateKeys.length === 0,
  };
}

function findStrongExemptionFromSource(
  sourceFile: SourceFile,
  line: number,
  warnings: string[],
): ExemptComment | null {
  const exempt = findExemptCommentNearSource(sourceFile, line);
  if (exempt === null) return null;
  const verdict = validateExemptionRationale(exempt.reason);
  if (verdict.strong) return exempt;
  warnings.push(
    `Exemption rationale rejected at ${exempt.file}:${exempt.line} — ${verdict.explanation}. The exemption will not suppress this violation. See docs/project/CROSS_SURFACE_PARITY_TRAP_CATALOGUE.md for the strict-template rationale convention.`,
  );
  return null;
}

function findMatchingDelimiter(source: string, openIndex: number, openChar: string, closeChar: string): number {
  let depth = 0;
  let stringQuote: '"' | "'" | '`' | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (stringQuote) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === stringQuote) stringQuote = null;
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      stringQuote = char;
      continue;
    }

    if (char === openChar) {
      depth += 1;
      continue;
    }
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function findTopLevelTerminator(source: string, startIndex: number, terminator: string): number {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let stringQuote: '"' | "'" | '`' | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (stringQuote) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === stringQuote) stringQuote = null;
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      stringQuote = char;
      continue;
    }

    if (char === '{') braceDepth += 1;
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (char === '[') bracketDepth += 1;
    else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === '(') parenDepth += 1;
    else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (char === terminator && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      return index;
    }
  }

  return -1;
}

function isCoreBoundarySetterCandidateFile(file: string): boolean {
  const normalized = normalizePath(file);
  return normalized.startsWith('src/core/')
    && normalized.endsWith('.ts')
    && !normalized.endsWith('.test.ts')
    && !normalized.endsWith('.spec.ts')
    && !normalized.includes('/__tests__/')
    && !normalized.includes('/__fixtures__/');
}

// bounded-walker-exempt: validation-time sentinel bounded to src/core and excludes tests/fixtures/spec files.
function discoverCoreBoundarySetterCandidateFiles(opts: RuleCheckOptions): string[] {
  const files = new Set(opts.allScannableFiles.filter(isCoreBoundarySetterCandidateFile));
  const coreRoot = resolve(opts.repoRoot, 'src/core');
  if (!existsSync(coreRoot)) return [...files].sort();

  const pendingDirectories = [coreRoot];
  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop();
    if (!currentDirectory) continue;

    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const absolutePath = resolve(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === '__fixtures__') continue;
        pendingDirectories.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;

      const relativePath = normalizePath(relative(opts.repoRoot, absolutePath));
      if (isCoreBoundarySetterCandidateFile(relativePath)) files.add(relativePath);
    }
  }

  return [...files].sort();
}

function validateBoundarySetterInventoryCompleteness(opts: RuleCheckOptions): void {
  const inventoriedSetters = new Set(
    opts.registry.boundarySetters.map((entry) => `${normalizePath(entry.decl)}\0${entry.name}`),
  );
  const grandfatheredSetters = new Set(
    GRANDFATHERED_UNCLASSIFIED_SETTERS.map(
      (entry) => `${normalizePath(entry.decl)}\0${entry.name}`,
    ),
  );
  const candidateFiles = discoverCoreBoundarySetterCandidateFiles(opts);

  for (const file of candidateFiles) {
    const sourceFile = readSourceFile({
      cwd: opts.repoRoot,
      file,
      fileReader: opts.fileReader,
      warnings: opts.warnings,
    });

    let match: RegExpExecArray | null;
    BOUNDARY_SETTER_EXPORT_REGEX.lastIndex = 0;
    while ((match = BOUNDARY_SETTER_EXPORT_REGEX.exec(sourceFile.source)) !== null) {
      if (indexIsInsideSourceRanges(match.index, sourceFile.nonCodeRanges)) continue;

      const setterName = match[1];
      if (!setterName) continue;
      if (inventoriedSetters.has(`${sourceFile.file}\0${setterName}`)) continue;
      if (grandfatheredSetters.has(`${sourceFile.file}\0${setterName}`)) continue;

      throw new CrossSurfaceParityGapFatalError(
        `Boundary inventory drift: ${sourceFile.file} exports ${setterName} but it is not classified.`,
        'discovery',
        `Classify ${setterName}: if it is a desktop/cloud boundary seam, add { name: '${setterName}', decl: '${sourceFile.file}', nullSentinel: '<NULL_SENTINEL>' } to KNOWN_BOUNDARY_SETTERS in scripts/check-cross-surface-parity-gap.ts so it is parity-checked. If it is genuinely NOT a cross-surface parity concern (e.g. a single-surface DI factory, test helper, internal mutator), prefer renaming/moving it out of the discovery shape; only if it must keep the name, add it to GRANDFATHERED_UNCLASSIFIED_SETTERS with justification (that list must shrink, not grow).`,
      );
    }
  }
}

function validateAndLoadBoundarySetters(opts: RuleCheckOptions): BoundarySetter[] {
  validateBoundarySetterInventoryCompleteness(opts);

  const setters: BoundarySetter[] = [];

  for (const entry of opts.registry.boundarySetters) {
    const sourceFile = readSourceFile({
      cwd: opts.repoRoot,
      file: entry.decl,
      fileReader: opts.fileReader,
      warnings: opts.warnings,
    });
    const exportRegex = new RegExp(`export\\s+function\\s+${escapeRegExp(entry.name)}\\s*\\(`, 'u');
    const match = sourceFile.source.match(exportRegex);
    if (!match || match.index === undefined) {
      throw new CrossSurfaceParityGapFatalError(
        `Boundary inventory drift: ${entry.decl} does not export function ${entry.name}()`,
        'discovery',
        'Update KNOWN_BOUNDARY_SETTERS so each entry points at the file that declares the exported setter.',
      );
    }

    setters.push({
      name: entry.name,
      decl: normalizePath(entry.decl),
      declLine: lineNumberAtIndex(sourceFile.source, match.index),
      nullSentinel: entry.nullSentinel,
      extraDesktopRegistrantFiles: entry.extraDesktopRegistrantFiles?.map(normalizePath),
    });
  }

  return setters;
}

function scanCallsInFile(params: {
  sourceFile: SourceFile;
  setterName: string;
  nullSentinel?: string;
}): CallExpression[] {
  const calls: CallExpression[] = [];
  const callRegex = new RegExp(`\\b${escapeRegExp(params.setterName)}\\s*\\(`, 'gu');
  let match: RegExpExecArray | null;

  while ((match = callRegex.exec(params.sourceFile.source)) !== null) {
    if (indexIsInsideSourceRanges(match.index, params.sourceFile.nonCodeRanges)) continue;
    if (previousNonWhitespaceCharacter(params.sourceFile.source, match.index) === '.') continue;

    const openParen = params.sourceFile.source.indexOf('(', match.index);
    if (openParen < 0) continue;

    const closeParen = findMatchingDelimiter(params.sourceFile.source, openParen, '(', ')');
    if (closeParen < 0) continue;

    const argument = params.sourceFile.source.slice(openParen + 1, closeParen);
    const nullTokens = argument.match(NULL_SENTINEL_REGEX) ?? [];
    const containsNullSentinel = nullTokens.length > 0;
    const isConstantStub = CONSTANT_STUB_REGEX.test(argument.trim());

    calls.push({
      file: params.sourceFile.file,
      line: lineNumberAtIndex(params.sourceFile.source, match.index),
      argument,
      containsNullSentinel,
      isConstantStub,
    });
    callRegex.lastIndex = closeParen + 1;
  }

  return calls;
}

function scanCalls(params: {
  files: readonly string[];
  repoRoot: string;
  fileReader: FileReader;
  warnings: string[];
  setter: BoundarySetter;
}): CallExpression[] {
  const calls: CallExpression[] = [];

  for (const file of params.files) {
    const absolutePath = resolve(params.repoRoot, file);
    if (!existsSync(absolutePath)) continue;
    const sourceFile = readSourceFile({
      cwd: params.repoRoot,
      file,
      fileReader: params.fileReader,
      warnings: params.warnings,
    });
    calls.push(...scanCallsInFile({
      sourceFile,
      setterName: params.setter.name,
      nullSentinel: params.setter.nullSentinel,
    }));
  }

  return calls;
}

function hasChangedFile(changedLinesByFile: Map<string, ReadonlySet<number>>, file: string): boolean {
  return changedLinesByFile.has(normalizePath(file));
}

function desktopRegistrantFilesFor(setter: BoundarySetter, registry: ResolvedRegistry): string[] {
  return [...registry.desktopRegistrantFiles, ...(setter.extraDesktopRegistrantFiles ?? [])];
}

function boundaryRelatedFiles(setter: BoundarySetter, registry: ResolvedRegistry): string[] {
  return [
    setter.decl,
    ...desktopRegistrantFilesFor(setter, registry),
    ...registry.cloudRegistrantFiles,
  ];
}

function makeBoundaryViolation(setter: BoundarySetter, message: string): Violation {
  return {
    file: setter.decl,
    line: setter.declLine,
    ruleId: 'BIRP-cloud-missing',
    message,
    suggestedFix: `Register ${setter.name}() in the cloud bootstrap site (cloud-service/src/bootstrap.ts or cloud-service/src/platformInit.ts), or add // CROSS_SURFACE_PARITY_EXEMPT: <reason> if this capability is intentionally desktop-only.`,
  };
}

function checkRuleABoundaryViolations(opts: RuleCheckOptions): { violations: Violation[]; scannedBoundaryCount: number } {
  const setters = validateAndLoadBoundarySetters(opts);
  const violations: Violation[] = [];

  for (const setter of setters) {
    const relatedFiles = boundaryRelatedFiles(setter, opts.registry);
    if (!opts.allFiles && !relatedFiles.some((file) => hasChangedFile(opts.changedLinesByFile, file))) {
      continue;
    }

    const declSource = readSourceFile({
      cwd: opts.repoRoot,
      file: setter.decl,
      fileReader: opts.fileReader,
      warnings: opts.warnings,
    });
    const desktopCalls = scanCalls({
      files: desktopRegistrantFilesFor(setter, opts.registry),
      repoRoot: opts.repoRoot,
      fileReader: opts.fileReader,
      warnings: opts.warnings,
      setter,
    });
    const cloudCalls = scanCalls({
      files: opts.registry.cloudRegistrantFiles,
      repoRoot: opts.repoRoot,
      fileReader: opts.fileReader,
      warnings: opts.warnings,
      setter,
    });

    // A NULL_* sentinel OR a constant-stub body (`() => false`/`null`/`undefined`)
    // both mean "this surface cannot really provide the capability" — neither
    // counts as a real registration. The constant-stub arm is the 260623
    // class-killer: `registerManagedKeyAvailability(() => false)` on cloud used
    // to pass parity silently.
    const isRealRegistration = (call: CallExpression): boolean =>
      !call.containsNullSentinel && !call.isConstantStub;
    const desktopRegistered = desktopCalls.some(isRealRegistration);
    const cloudRegistered = cloudCalls.some(isRealRegistration);
    const declarationExempt = findStrongExemptionFromSource(declSource, setter.declLine, opts.warnings);
    const cloudCallExempt = cloudCalls.some((call) => {
      const sourceFile = readSourceFile({
        cwd: opts.repoRoot,
        file: call.file,
        fileReader: opts.fileReader,
        warnings: opts.warnings,
      });
      return findStrongExemptionFromSource(sourceFile, call.line, opts.warnings) !== null;
    });
    if (declarationExempt || cloudCallExempt) continue;

    if (desktopRegistered && !cloudRegistered) {
      const nullQualifier = cloudCalls.some((call) => call.containsNullSentinel)
        ? ' Cloud registration passes a NULL_* sentinel, so it is treated as missing.'
        : cloudCalls.some((call) => call.isConstantStub)
        ? ' Cloud registration is a constant stub (e.g. () => false), so it cannot serve the capability and is treated as missing — add // CROSS_SURFACE_PARITY_EXEMPT: <reason> at the call site if this surface is intentionally unserviceable.'
        : '';
      violations.push(makeBoundaryViolation(
        setter,
        `Boundary "${setter.name}" is registered on desktop but not on cloud. ${setter.decl}:${setter.declLine}${nullQualifier}`,
      ));
      continue;
    }

    if (!desktopRegistered && !cloudRegistered) {
      violations.push(makeBoundaryViolation(
        setter,
        `Boundary "${setter.name}" is registered on neither desktop nor cloud. ${setter.decl}:${setter.declLine}`,
      ));
    }
  }

  return { violations, scannedBoundaryCount: setters.length };
}

function parseExportedTypeAliases(sourceFile: SourceFile): Map<string, string> {
  const aliases = new Map<string, string>();
  const aliasRegex = /export\s+type\s+([A-Za-z_$][\w$]*)\s*=/gu;
  let match: RegExpExecArray | null;

  while ((match = aliasRegex.exec(sourceFile.source)) !== null) {
    if (indexIsInsideSourceRanges(match.index, sourceFile.nonCodeRanges)) continue;

    const name = match[1];
    if (!name) continue;
    const rhsStart = aliasRegex.lastIndex;
    const terminator = findTopLevelTerminator(sourceFile.source, rhsStart, ';');
    if (terminator < 0) continue;
    aliases.set(name, sourceFile.source.slice(rhsStart, terminator).trim());
    aliasRegex.lastIndex = terminator + 1;
  }

  return aliases;
}

function parseAppSettings(sourceFile: SourceFile): AppSettingsParseResult {
  const declarationMatch = /export\s+(?:type|interface)\s+AppSettings\b/gu.exec(sourceFile.source);
  if (!declarationMatch || declarationMatch.index === undefined) {
    throw new CrossSurfaceParityGapFatalError(
      `Unable to locate AppSettings declaration in ${sourceFile.file}`,
      'parse',
      'Expected export type AppSettings = { ... } or export interface AppSettings { ... }.',
    );
  }

  const openBrace = sourceFile.source.indexOf('{', declarationMatch.index);
  if (openBrace < 0) {
    throw new CrossSurfaceParityGapFatalError(
      `Unable to locate AppSettings body in ${sourceFile.file}`,
      'parse',
      'Expected AppSettings to use a brace-delimited object/interface body.',
    );
  }
  const closeBrace = findMatchingDelimiter(sourceFile.source, openBrace, '{', '}');
  if (closeBrace < 0) {
    throw new CrossSurfaceParityGapFatalError(
      `Unable to find closing brace for AppSettings in ${sourceFile.file}`,
      'parse',
      'Check AppSettings syntax and rerun the gate.',
    );
  }

  const body = sourceFile.source.slice(openBrace + 1, closeBrace);
  const bodyStart = openBrace + 1;
  const keys: AppSettingsKey[] = [];
  let segmentStart = 0;
  let depth = 1;
  let stringQuote: '"' | "'" | '`' | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  function consumeSegment(segmentEnd: number): void {
    const segment = body.slice(segmentStart, segmentEnd);
    const propertyMatch = /(?:^|\n)\s*(?:readonly\s+)?([A-Za-z_$][\w$]*|'[^']+'|"[^"]+")\??\s*:/u.exec(segment);
    if (!propertyMatch || propertyMatch.index === undefined) return;
    const rawName = propertyMatch[1];
    if (!rawName) return;
    const colonIndex = segment.indexOf(':', propertyMatch.index);
    if (colonIndex < 0) return;
    const rawNameIndex = segment.indexOf(rawName, propertyMatch.index);
    const segmentEndIndex = bodyStart + segmentStart + segmentEnd;
    const name = rawName.replace(/^['"]|['"]$/g, '');
    keys.push({
      name,
      declLine: lineNumberAtIndex(
        sourceFile.source,
        bodyStart + segmentStart + (rawNameIndex >= 0 ? rawNameIndex : propertyMatch.index),
      ),
      valueEndLine: lineNumberAtIndex(sourceFile.source, segmentEndIndex),
      typeRhs: segment.slice(colonIndex + 1).trim(),
    });
  }

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    const next = body[index + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (stringQuote) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === stringQuote) stringQuote = null;
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      stringQuote = char;
      continue;
    }

    if (char === '{' || char === '(' || char === '[') {
      depth += 1;
      continue;
    }
    if (char === '}' || char === ')' || char === ']') {
      depth = Math.max(1, depth - 1);
      continue;
    }
    if (depth === 1 && (char === ';' || char === ',')) {
      consumeSegment(index);
      segmentStart = index + 1;
    }
  }
  consumeSegment(body.length);

  return { keys, aliases: parseExportedTypeAliases(sourceFile) };
}

function parseLocalOnlySettingsKeys(sourceFile: SourceFile): Set<string> {
  const arrayStartPatterns = [
    /LOCAL_ONLY_SETTINGS_KEYS_ARRAY\s*=\s*\[/u,
    /LOCAL_ONLY_SETTINGS_KEYS\s*=\s*new\s+Set[^(]*\(\s*\[/u,
  ];
  let openBracket = -1;

  for (const pattern of arrayStartPatterns) {
    const match = pattern.exec(sourceFile.source);
    if (!match || match.index === undefined) continue;
    openBracket = sourceFile.source.indexOf('[', match.index);
    if (openBracket >= 0) break;
  }

  if (openBracket < 0) {
    throw new CrossSurfaceParityGapFatalError(
      `Unable to locate LOCAL_ONLY_SETTINGS_KEYS array in ${sourceFile.file}`,
      'parse',
      'Expected LOCAL_ONLY_SETTINGS_KEYS_ARRAY = [...] or new Set([...]).',
    );
  }
  const closeBracket = findMatchingDelimiter(sourceFile.source, openBracket, '[', ']');
  if (closeBracket < 0) {
    throw new CrossSurfaceParityGapFatalError(
      `Unable to find closing bracket for LOCAL_ONLY_SETTINGS_KEYS in ${sourceFile.file}`,
      'parse',
      'Check cloudSettingsPolicy.ts syntax and rerun the gate.',
    );
  }

  const body = sourceFile.source.slice(openBracket + 1, closeBracket);
  const keys = new Set<string>();
  const stringRegex = /(['"])(.*?)\1/gu;
  let match: RegExpExecArray | null;
  while ((match = stringRegex.exec(body)) !== null) {
    const key = match[2]?.trim();
    if (key) keys.add(key);
  }
  return keys;
}

const IDENTIFIER_TYPE_REGEX = /^[A-Za-z_$][\w$]*$/u;

function resolveEffectiveType(typeRhs: string, aliases: ReadonlyMap<string, string>): string {
  const normalized = typeRhs.trim().replace(/[;,]\s*$/u, '');
  if (IDENTIFIER_TYPE_REGEX.test(normalized)) {
    return aliases.get(normalized) ?? normalized;
  }
  return normalized;
}

function isStringLiteralUnion(typeRhs: string): boolean {
  if (!typeRhs.includes('|')) return false;
  const literalMatches = typeRhs.match(/(['"])(?:\\.|(?!\1).)*\1/gu) ?? [];
  return literalMatches.length >= 2;
}

function isBooleanOrOptionalBoolean(typeRhs: string): boolean {
  const parts = typeRhs
    .split('|')
    .map((part) => part.trim().replace(/[()]/g, ''))
    .filter(Boolean);
  if (parts.length === 0) return false;
  return parts.includes('boolean') && parts.every((part) => part === 'boolean' || part === 'undefined');
}

function isLineInRange(lines: ReadonlySet<number>, startLine: number, endLine: number): boolean {
  for (let line = startLine; line <= endLine; line += 1) {
    if (lines.has(line)) return true;
  }
  return false;
}

function checkRuleBSettingsViolations(opts: RuleCheckOptions): { violations: Violation[]; scannedSettingsCount: number } {
  const settingsSource = readSourceFile({
    cwd: opts.repoRoot,
    file: opts.registry.settingsFile,
    fileReader: opts.fileReader,
    warnings: opts.warnings,
  });
  const localOnlySource = readSourceFile({
    cwd: opts.repoRoot,
    file: opts.registry.cloudSettingsPolicyFile,
    fileReader: opts.fileReader,
    warnings: opts.warnings,
  });

  const parsedSettings = parseAppSettings(settingsSource);
  if (parsedSettings.keys.length === 0) {
    throw new CrossSurfaceParityGapFatalError(
      `AppSettings parse returned 0 keys in ${settingsSource.file}`,
      'parse',
      'Update the brace-depth parser or verify AppSettings still has top-level fields.',
    );
  }

  const parsedKeyNames = new Set(parsedSettings.keys.map((key) => key.name));
  const missingSentinelKeys = ['activeProvider', 'cloudInstance', 'coreDirectory']
    .filter((key) => !parsedKeyNames.has(key));
  if (missingSentinelKeys.length > 0) {
    throw new CrossSurfaceParityGapFatalError(
      `AppSettings parse missing sentinel keys: ${missingSentinelKeys.join(', ')}`,
      'parse',
      'Verify src/shared/types/settings.ts still declares AppSettings with expected top-level settings keys.',
    );
  }

  const localOnlyKeys = parseLocalOnlySettingsKeys(localOnlySource);
  if (localOnlyKeys.size === 0) {
    throw new CrossSurfaceParityGapFatalError(
      `LOCAL_ONLY_SETTINGS_KEYS parse returned 0 entries in ${localOnlySource.file}`,
      'parse',
      'Update the parser for cloudSettingsPolicy.ts or restore LOCAL_ONLY_SETTINGS_KEYS_ARRAY entries.',
    );
  }

  const changedSettingsLines = opts.changedLinesByFile.get(opts.registry.settingsFile) ?? new Set<number>();
  const violations: Violation[] = [];
  for (const key of parsedSettings.keys) {
    if (!isLineInRange(changedSettingsLines, key.declLine, key.valueEndLine)) continue;
    if (localOnlyKeys.has(key.name)) continue;
    if (findStrongExemptionFromSource(settingsSource, key.declLine, opts.warnings) !== null) continue;
    if (!CAPABILITY_SETTING_NAME_REGEX.test(key.name)) continue;

    const effectiveType = resolveEffectiveType(key.typeRhs, parsedSettings.aliases);
    if (IDENTIFIER_TYPE_REGEX.test(effectiveType)) {
      opts.warnings.push(
        `Setting "${key.name}" uses type "${effectiveType}" which Rule B cannot classify (chained alias / generic / imported type). Cross-file and chained alias resolution is out of scope for this gate. Consider adding "${key.name}" to LOCAL_ONLY_SETTINGS_KEYS if desktop-only, or // CROSS_SURFACE_PARITY_EXEMPT: <reason> if intentionally cloud-synced.`,
      );
      continue;
    }
    if (!isStringLiteralUnion(effectiveType) && !isBooleanOrOptionalBoolean(effectiveType)) continue;

    violations.push({
      file: opts.registry.settingsFile,
      line: key.declLine,
      ruleId: 'CSACG-capability-flag',
      message: `Setting "${key.name}" looks like a capability-gating flag and will sync to cloud (it is not in LOCAL_ONLY_SETTINGS_KEYS).`,
      suggestedFix: 'If this flag gates a capability that requires a cloud-side service or token, ensure the cloud surface has a backing boundary-interface registration. If not, add to LOCAL_ONLY_SETTINGS_KEYS in cloudSettingsPolicy.ts. See docs/project/CROSS_SURFACE_PARITY_TRAP_CATALOGUE.md.',
    });
  }

  return { violations, scannedSettingsCount: parsedSettings.keys.length };
}

function validateRegistryPath(cwd: string, registryPath: string | undefined): void {
  if (registryPath === undefined) return;
  const resolved = resolve(cwd, registryPath);
  if (!existsSync(resolved)) {
    throw new CrossSurfaceParityGapFatalError(
      `--registry-path does not exist: ${registryPath}`,
      'parse',
      'Pass an existing path or omit --registry-path outside fixture tests.',
    );
  }
  statSync(resolved);
}

export async function findCrossSurfaceParityGapViolations(
  opts: FindCrossSurfaceParityGapOptions = {},
): Promise<CrossSurfaceParityGapResult> {
  const cwd = opts.repoRoot ?? repoRoot;
  const staged = opts.staged ?? false;
  const baseRef = opts.baseRef?.trim() || undefined;
  const requestedAllFiles = opts.allFiles ?? false;
  let effectiveAllFiles = requestedAllFiles;
  const warnOnRuleBDiffScopeInAllFiles = opts.warnOnRuleBDiffScopeInAllFiles ?? requestedAllFiles;
  const diffProvider = opts.diffProvider ?? defaultDiffProvider;
  const fileReader = opts.fileReader ?? ((absolutePath) => readFileSync(absolutePath, 'utf8'));
  const trackedFilesProvider = opts.trackedFilesProvider ?? defaultTrackedFilesProvider;
  const warnings: string[] = [];

  if (warnOnRuleBDiffScopeInAllFiles) {
    warnings.push(
      '--all-files mode requested but Rule B (CSACG) remains diff-scoped. Pre-existing AppSettings fields `activeProvider` and `exposeProviderKeysInShell` were investigated and confirmed safe under sync-with-policy (dual-write via `settings:update`; cloud-side backing impl present); see docs/plans/260516_rule_b_baseline_disposition_followup.md for the full disposition. Rule B remains diff-scoped under --all-files to avoid spuriously flagging these confirmed-safe legacy fields; new fields are fully enforced in diff-scope mode. Long-term, a positive `CLOUD_SYNCED_CAPABILITY_SETTINGS` manifest (§23 structural eliminator) would let Rule B distinguish confirmed-synced from unconfirmed fields.',
    );
  }

  validateRegistryPath(cwd, opts.registryPath);
  const registry = resolveRegistry({
    cwd,
    registryPath: opts.registryPath,
    fileReader,
  });

  let allScannableFiles: string[];
  try {
    allScannableFiles = getAllScannableFiles(cwd, trackedFilesProvider);
  } catch (error) {
    throw new CrossSurfaceParityGapFatalError(
      `Unable to discover tracked source files: ${errorMessage(error)}`,
      'discovery',
      'Verify the repository root is readable and git ls-files succeeds.',
    );
  }

  let candidateFiles: string[];
  try {
    candidateFiles = getCandidateFiles({
      allFiles: effectiveAllFiles,
      staged,
      baseRef,
      cwd,
      diffProvider,
      trackedFilesProvider,
    });
  } catch (error) {
    if (effectiveAllFiles) {
      throw new CrossSurfaceParityGapFatalError(
        `Unable to discover candidate files: ${errorMessage(error)}`,
        'discovery',
        'Verify the repository root is readable and git ls-files succeeds.',
      );
    }
    warnings.push(`git diff failed; scanning all files: ${errorMessage(error)}`);
    effectiveAllFiles = true;
    try {
      candidateFiles = getCandidateFiles({
        allFiles: true,
        staged,
        baseRef,
        cwd,
        diffProvider,
        trackedFilesProvider,
      });
    } catch (fallbackError) {
      throw new CrossSurfaceParityGapFatalError(
        `Unable to discover candidate files after git diff fallback: ${errorMessage(fallbackError)}`,
        'discovery',
        'Verify the repository root is readable and git ls-files succeeds.',
      );
    }
  }

  const changedLineDetailsByFile = new Map<string, ChangedLine[]>();
  for (const file of candidateFiles) {
    if (effectiveAllFiles && requestedAllFiles) {
      changedLineDetailsByFile.set(file, []);
      continue;
    }
    try {
      changedLineDetailsByFile.set(
        file,
        getChangedLines({ allFiles: effectiveAllFiles, staged, baseRef, cwd, file, diffProvider, fileReader }),
      );
    } catch (error) {
      if (effectiveAllFiles) {
        throw new CrossSurfaceParityGapFatalError(
          `Unable to read changed lines for ${file}: ${errorMessage(error)}`,
          'discovery',
          'Check file readability and rerun the gate.',
        );
      }
      warnings.push(`git diff failed for ${file}; scanning the full file: ${errorMessage(error)}`);
      changedLineDetailsByFile.set(
        file,
        getChangedLines({ allFiles: true, staged, baseRef, cwd, file, diffProvider, fileReader }),
      );
    }
  }

  const changedLinesByFile = new Map<string, ReadonlySet<number>>();
  for (const [file, changedLines] of changedLineDetailsByFile) {
    changedLinesByFile.set(file, new Set(changedLines.map((line) => line.line)));
  }

  const ruleCheckOptions: RuleCheckOptions = {
    changedLinesByFile,
    candidateFiles,
    allScannableFiles,
    repoRoot: cwd,
    fileReader,
    allFiles: effectiveAllFiles,
    warnings,
    registry,
  };
  const ruleAResult = checkRuleABoundaryViolations(ruleCheckOptions);
  const ruleBResult = checkRuleBSettingsViolations(ruleCheckOptions);
  const violations = [
    ...ruleAResult.violations,
    ...ruleBResult.violations,
  ].sort(compareViolations);
  const exemptions = scanExemptions({
    files: [...changedLineDetailsByFile.keys()],
    cwd,
    fileReader,
    warnings,
  });
  const acknowledgedExemptionBaseline = opts.registryPath === undefined
    ? scanAcknowledgedExemptionBaseline({
      files: allScannableFiles,
      cwd,
      fileReader,
      warnings,
    })
    : undefined;

  return {
    violations,
    warnings,
    scannedBoundaryCount: ruleAResult.scannedBoundaryCount,
    scannedSettingsCount: ruleBResult.scannedSettingsCount,
    exemptedCount: exemptions.length,
    exemptions,
    acknowledgedExemptionBaseline,
  };
}

function compareViolations(a: Violation, b: Violation): number {
  return a.file.localeCompare(b.file) || a.line - b.line || a.ruleId.localeCompare(b.ruleId);
}

export function formatViolationReport(violations: readonly Violation[]): string {
  const lines = [`[cross-surface-parity-gap] FAIL: Cross-surface parity gap check failed (${violations.length} violations).`];
  for (const violation of [...violations].sort(compareViolations)) {
    lines.push(`  - ${violation.file}:${violation.line} [${violation.ruleId}] ${violation.message}`);
    lines.push(`    suggested fix: ${violation.suggestedFix}`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatSuccessSummary(result: CrossSurfaceParityGapResult): string {
  return `Cross-surface parity gap check passed (${result.scannedBoundaryCount} boundaries, ${result.scannedSettingsCount} settings, ${result.exemptedCount} exemptions).\n`;
}

function formatExemptionsTable(exemptions: readonly ExemptComment[]): string {
  const lines = ['file\tline\treason'];
  for (const exemption of [...exemptions].sort(compareExemptions)) {
    lines.push(`${exemption.file}\t${exemption.line}\t${exemption.reason}`);
  }
  return `${lines.join('\n')}\n`;
}

function formatExpectedAcknowledgedExemptionsManifest(
  entries: readonly AcknowledgedExemptionManifestEntry[],
): string {
  const lines = ['export const EXPECTED_ACKNOWLEDGED_EXEMPTIONS = ['];
  for (const entry of [...entries].sort(compareAcknowledgedManifestEntries)) {
    lines.push(`  { file: '${entry.file}', target: '${entry.target}' },`);
  }
  lines.push('] as const satisfies readonly AcknowledgedExemptionManifestEntry[];');
  return lines.join('\n');
}

function updateAcknowledgedExemptionsManifest(params: {
  cwd: string;
  registryPath: string | undefined;
  fileReader: FileReader;
  trackedFilesProvider: (cwd: string) => string[];
  warnings: string[];
}): AcknowledgedExemptionBaselineCheck {
  if (params.registryPath !== undefined) {
    throw new CrossSurfaceParityGapFatalError(
      '--update-acknowledged-exemptions is only supported for the default repository registry',
      'parse',
      'Omit --registry-path; fixture registries do not own the production acknowledged-exemption manifest.',
    );
  }

  let allScannableFiles: string[];
  try {
    allScannableFiles = getAllScannableFiles(params.cwd, params.trackedFilesProvider);
  } catch (error) {
    throw new CrossSurfaceParityGapFatalError(
      `Unable to discover tracked source files: ${errorMessage(error)}`,
      'discovery',
      'Verify the repository root is readable and git ls-files succeeds.',
    );
  }

  const check = scanAcknowledgedExemptionBaseline({
    files: allScannableFiles,
    cwd: params.cwd,
    fileReader: params.fileReader,
    warnings: params.warnings,
    expected: [],
  });

  if (check.unresolved.length > 0 || check.weakRationales.length > 0 || check.duplicateKeys.length > 0) {
    throw new CrossSurfaceParityGapFatalError(
      'Unable to regenerate EXPECTED_ACKNOWLEDGED_EXEMPTIONS because live exemptions are malformed',
      'parse',
      formatAcknowledgedExemptionBaselineFailure({ ...check, missing: [], unexpected: [] }),
    );
  }

  const currentSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const manifestRegex = /export const EXPECTED_ACKNOWLEDGED_EXEMPTIONS = \[\n[\s\S]*?\] as const satisfies readonly AcknowledgedExemptionManifestEntry\[\];/u;
  const nextManifest = formatExpectedAcknowledgedExemptionsManifest(check.actual);
  if (!manifestRegex.test(currentSource)) {
    throw new CrossSurfaceParityGapFatalError(
      'Unable to find EXPECTED_ACKNOWLEDGED_EXEMPTIONS manifest block for regeneration',
      'parse',
      'Update the detector manually, preserving the manifest declaration shape.',
    );
  }
  writeFileSync(fileURLToPath(import.meta.url), currentSource.replace(manifestRegex, nextManifest));

  return check;
}

export function formatAcknowledgedExemptionBaselineFailure(check: AcknowledgedExemptionBaselineCheck): string {
  const lines = [
    '[cross-surface-parity-gap] FAIL: Acknowledged CROSS_SURFACE_PARITY_EXEMPT baseline drifted.',
    'Update EXPECTED_ACKNOWLEDGED_EXEMPTIONS in scripts/check-cross-surface-parity-gap.ts only after justifying the exemption in docs/project/CROSS_SURFACE_PARITY_TRAP_CATALOGUE.md.',
    'Regenerate the manifest with: npx tsx scripts/check-cross-surface-parity-gap.ts --update-acknowledged-exemptions',
    'Invariant: the source-side rationale explains why safe; the detector manifest is the team acknowledgment. A long comment alone is not accepted.',
  ];

  if (check.unexpected.length > 0) {
    lines.push('Unexpected live exemptions:');
    for (const exemption of check.unexpected) {
      lines.push(`  - ${exemption.file}:${exemption.line} ${exemption.target} — ${exemption.reason}`);
    }
  }

  if (check.missing.length > 0) {
    lines.push('Expected exemptions missing or moved:');
    for (const entry of check.missing) {
      lines.push(`  - ${entry.file} ${entry.target}`);
    }
  }

  if (check.weakRationales.length > 0) {
    lines.push('Weak exemption rationales:');
    for (const { exemption, explanation } of check.weakRationales) {
      lines.push(`  - ${exemption.file}:${exemption.line} — ${explanation}`);
    }
  }

  if (check.unresolved.length > 0) {
    lines.push('Unresolved exemption targets:');
    for (const { exemption, explanation } of check.unresolved) {
      lines.push(`  - ${exemption.file}:${exemption.line} — ${explanation}`);
    }
  }

  if (check.duplicateKeys.length > 0) {
    lines.push('Duplicate acknowledged exemption targets:');
    for (const key of check.duplicateKeys) {
      lines.push(`  - ${key}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function printUsage(stdout: TextWriter): void {
  stdout.write([
    'Usage: npx tsx scripts/check-cross-surface-parity-gap.ts [--all-files] [--staged] [--base-ref <ref>] [--list-exemptions] [--update-acknowledged-exemptions] [--registry-path <path>] [--help]',
    '',
    'Options:',
    '  --all-files        Scan all tracked source files instead of changed files.',
    '  --staged           Use staged changes for diff-scoped mode.',
    '  --base-ref <ref>   Compare <ref>...HEAD in diff-scoped mode.',
    '  --list-exemptions  Print valid CROSS_SURFACE_PARITY_EXEMPT annotations.',
    '  --update-acknowledged-exemptions',
    '                     Regenerate the detector-owned EXPECTED_ACKNOWLEDGED_EXEMPTIONS manifest from live source after trap-catalogue review.',
    '  --registry-path    Test injection path; validated when provided.',
    '  --help, -h         Show this help text.',
    '',
    'Diff-source precedence: --all-files/--list-exemptions ignore diff refs; otherwise --base-ref <ref>, then CI=true with GITHUB_BASE_REF (origin/<ref>...HEAD), then CI=true with push event.before (<before>...HEAD), then git diff HEAD.',
    '',
  ].join('\n'));
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    allFiles: false,
    staged: false,
    listExemptions: false,
    updateAcknowledgedExemptions: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all-files') {
      args.allFiles = true;
      continue;
    }
    if (arg === '--staged') {
      args.staged = true;
      continue;
    }
    if (arg === '--list-exemptions') {
      args.listExemptions = true;
      continue;
    }
    if (arg === '--update-acknowledged-exemptions') {
      args.updateAcknowledgedExemptions = true;
      continue;
    }
    if (arg === '--base-ref') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('--base-ref requires a ref value');
      }
      args.baseRef = next;
      i += 1;
      continue;
    }
    if (arg === '--registry-path') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('--registry-path requires a path value');
      }
      args.registryPath = next;
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.registryPath !== undefined && !args.registryPath.trim()) {
    throw new Error('--registry-path requires a non-empty path');
  }
  if (args.baseRef !== undefined && !args.baseRef.trim()) {
    throw new Error('--base-ref requires a non-empty ref');
  }

  return args;
}

function readPushEventBeforeSha(eventPath: string): { beforeSha?: string; warningMessage?: string } {
  try {
    const rawEvent = readFileSync(eventPath, 'utf8');
    const event: unknown = JSON.parse(rawEvent);

    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      return {
        warningMessage: 'GITHUB_EVENT_PATH JSON is malformed; expected an object with optional event.before. Falling back to default diff source.',
      };
    }

    if (!('before' in event)) return {};

    const before = (event as { before?: unknown }).before;
    if (before === undefined || before === null) return {};
    if (typeof before !== 'string') {
      return {
        warningMessage: 'GITHUB_EVENT_PATH JSON is malformed; event.before must be a string. Falling back to default diff source.',
      };
    }

    const beforeSha = before.trim();
    if (!beforeSha || ZERO_SHA_REGEX.test(beforeSha)) return {};
    return { beforeSha };
  } catch (error) {
    return {
      warningMessage: `Unable to read or parse GITHUB_EVENT_PATH (${eventPath}): ${errorMessage(error)}. Falling back to default diff source.`,
    };
  }
}

function selectDiffBaseRef(
  args: CliArgs,
  env: Record<string, string | undefined>,
): DiffBaseSelection {
  if (args.allFiles || args.listExemptions) return {};

  const explicitBaseRef = args.baseRef?.trim();
  if (explicitBaseRef) {
    return {
      baseRef: explicitBaseRef,
      infoMessage: `Comparing against base-ref ${explicitBaseRef}`,
    };
  }

  const githubBaseRef = env.GITHUB_BASE_REF?.trim();
  if (env.CI === 'true' && githubBaseRef) {
    const baseRef = `origin/${githubBaseRef}`;
    return {
      baseRef,
      infoMessage: `CI base-ref auto-detected; comparing against ${baseRef}`,
    };
  }

  const githubEventPath = env.GITHUB_EVENT_PATH?.trim();
  if (env.CI === 'true' && env.GITHUB_EVENT_NAME === 'push' && githubEventPath) {
    const { beforeSha, warningMessage } = readPushEventBeforeSha(githubEventPath);
    if (warningMessage) return { warningMessage };
    if (beforeSha) {
      return {
        baseRef: beforeSha,
        infoMessage: `CI push-event base-ref auto-detected from GITHUB_EVENT_PATH; comparing against ${beforeSha.slice(0, SHORT_SHA_LENGTH)}`,
      };
    }
  }

  return {};
}

export async function runCli(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  streams: CliStreams = { stdout: process.stdout, stderr: process.stderr },
  deps: FindCrossSurfaceParityGapOptions = {},
): Promise<number> {
  try {
    const args = parseCliArgs(argv);

    if (args.help) {
      printUsage(streams.stdout);
      return 0;
    }

    if (env.SKIP_CROSS_SURFACE_PARITY_GAP === '1') {
      streams.stderr.write(
        `${WARNING_PREFIX} SKIP_CROSS_SURFACE_PARITY_GAP=1 set; gate bypassed. This should only be used during emergency rollback.\n`,
      );
      return 0;
    }

    const { baseRef, infoMessage, warningMessage } = selectDiffBaseRef(args, env);
    if (infoMessage) {
      streams.stderr.write(`${INFO_PREFIX} ${infoMessage}\n`);
    }
    if (warningMessage) {
      streams.stderr.write(`${WARNING_PREFIX} ${warningMessage}\n`);
    }

    const cwd = deps.repoRoot ?? repoRoot;
    const fileReader = deps.fileReader ?? ((absolutePath) => readFileSync(absolutePath, 'utf8'));
    const trackedFilesProvider = deps.trackedFilesProvider ?? defaultTrackedFilesProvider;
    const effectiveRegistryPath = args.registryPath ?? deps.registryPath;

    if (args.updateAcknowledgedExemptions) {
      const warnings: string[] = [];
      const check = updateAcknowledgedExemptionsManifest({
        cwd,
        registryPath: effectiveRegistryPath,
        fileReader,
        trackedFilesProvider,
        warnings,
      });
      for (const warning of warnings) {
        streams.stderr.write(`${WARNING_PREFIX} ${warning}\n`);
      }
      streams.stdout.write(
        `Updated EXPECTED_ACKNOWLEDGED_EXEMPTIONS (${check.actual.length} exemptions). Confirm docs/project/CROSS_SURFACE_PARITY_TRAP_CATALOGUE.md justifies every new or moved exemption before committing.\n`,
      );
      return 0;
    }

    const result = await findCrossSurfaceParityGapViolations({
      ...deps,
      allFiles: args.allFiles || args.listExemptions,
      warnOnRuleBDiffScopeInAllFiles: args.allFiles,
      staged: args.staged,
      baseRef: baseRef ?? deps.baseRef,
      registryPath: effectiveRegistryPath,
    });

    for (const warning of result.warnings) {
      streams.stderr.write(`${WARNING_PREFIX} ${warning}\n`);
    }

    if (args.listExemptions) {
      streams.stdout.write(formatExemptionsTable(result.exemptions));
      return 0;
    }

    if (result.acknowledgedExemptionBaseline && !result.acknowledgedExemptionBaseline.ok) {
      streams.stderr.write(formatAcknowledgedExemptionBaselineFailure(result.acknowledgedExemptionBaseline));
      return 1;
    }

    if (result.violations.length > 0) {
      streams.stderr.write(formatViolationReport(result.violations));
      return 1;
    }

    streams.stdout.write(formatSuccessSummary(result));
    return 0;
  } catch (error) {
    const fatalError = error instanceof CrossSurfaceParityGapFatalError
      ? error
      : new CrossSurfaceParityGapFatalError(
        errorMessage(error),
        'parse',
        'Check CLI flags and repository paths, then rerun the gate.',
      );
    streams.stderr.write(`${FATAL_PREFIX} ${fatalError.message}\n`);
    streams.stderr.write(`  phase: ${fatalError.phase}\n`);
    streams.stderr.write(`  hint: ${fatalError.hint}\n`);
    return 2;
  }
}

const invokedAsScript = (() => {
  if (!process.argv[1]) return false;
  try {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  runCli(process.argv.slice(2)).then((exitCode) => {
    process.exit(exitCode);
  }).catch((error) => {
    process.stderr.write(`${FATAL_PREFIX} ${errorMessage(error)}\n`);
    process.stderr.write('  phase: parse\n');
    process.stderr.write('  hint: Check CLI flags and repository paths, then rerun the gate.\n');
    process.exit(2);
  });
}
