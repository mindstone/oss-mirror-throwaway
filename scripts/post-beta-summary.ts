#!/usr/bin/env -S npx tsx

import Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const INTERNAL_CHANGELOG_RELATIVE_PATH = 'INTERNAL_CHANGELOG.md';
const INTERNAL_CHANGELOG_PATH = path.join(REPO_ROOT, INTERNAL_CHANGELOG_RELATIVE_PATH);

const DEFAULT_MODEL = 'claude-sonnet-4-5';
const DEFAULT_FALLBACK_DAYS = 30;
const MAX_BUCKET_LINES = 7;
const MAX_SLACK_SECTION_CHARS = 2_900;
const MAX_MARKER_WALK_HOPS = 20;
const MAX_LLM_ATTEMPTS = 3;
const SECTION_UI_CHANGES = "What you'll see";
const SECTION_DEMO_SUPPORT = 'What we fixed';
const SECTION_OTHER_FIXES = 'Worth a look';
const ANNOUNCED_SECTION_HEADINGS = new Set([
  SECTION_UI_CHANGES,
  SECTION_DEMO_SUPPORT,
  SECTION_OTHER_FIXES,
  'UI/UX changes to know',
  'What this means in demos and support',
  'Other fixes worth knowing',
]);

const VISIBLE_COMMIT_TYPES = new Set(['feat', 'fix', 'style', 'perf']);
const INTERNAL_ONLY_SCOPES = new Set([
  'build',
  'ci',
  'deps',
  'dev',
  'docs',
  'eval',
  'evals',
  'release',
  'release-notes',
  'storybook',
  'submodule',
  'submodules',
  'test',
  'tests',
  'workflow',
  'workflows',
]);
const TECHNICAL_SUMMARY_PATTERNS = [
  /\bci\b/i,
  /\bbundl(e|ing)\b/i,
  /\bbuild(s|ing)?\b/i,
  /\bdeploy(s|ed|ment)?\b/i,
  /\be2e\b/i,
  /\bgithub\b/i,
  /\bmcp[-\s]?smoke\b/i,
  /\bpackag(e|ing)\b/i,
  /\bpre-push\b/i,
  /\brelease(s)?\b/i,
  /\bstorybook\b/i,
  /\bsubmodule\b/i,
  /\btest(s|ing)?\b/i,
  /\bvitest\b/i,
  /\bworkflow\b/i,
  /\bUNCONFIGURED_TEST_MCPS\b/,
];

// Deterministic backstop for the system prompt's hard bans. The prompt asks the
// model to avoid these; this enforces it so a non-compliant response can't leak
// ticket IDs, stage/phase refs, commit prefixes, code identifiers, or internal
// jargon into a non-technical channel. A bullet that trips any pattern is
// dropped — and if every bullet is dropped, the post is suppressed entirely
// (never a degraded post). Patterns are deliberately narrow to avoid dropping
// legitimate user-facing copy (e.g. model names like "GPT-5" must NOT match).
const BANNED_BULLET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'ticket/issue ID', pattern: /\bREBEL-\d+[A-Za-z]?\b/i },
  { label: 'ticket/issue ID', pattern: /\b[A-Z]{2,}-\d{3,}\b/ },
  { label: 'stage/phase reference', pattern: /\b(?:stage|phase)\s*\d+\b/i },
  { label: 'follow-up reference', pattern: /\(\s*follow[-\s]?up\s*\)/i },
  { label: 'commit-style prefix', pattern: /\b(?:feat|fix|chore|refactor|docs|test|perf|build|ci|style)(?:\([^)]*\))?\s*:/i },
  { label: 'engineering jargon', pattern: /\b(?:resolver|parity|idempotent|idempotency)\b/i },
  { label: 'file path or filename', pattern: /\b[\w/-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|yml|yaml)\b/i },
  { label: 'code constant', pattern: /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/ },
];

function findBannedBulletContent(line: string): string | null {
  for (const { label, pattern } of BANNED_BULLET_PATTERNS) {
    if (pattern.test(line)) {
      return label;
    }
  }
  return null;
}

type GenerationMode = 'summary' | 'quiet' | 'raw_fallback';
type RunMode = 'full' | 'emit-only' | 'post-from' | 'commit-from';

interface CliOptions {
  dryRun: boolean;
  noCommit: boolean;
  since?: string;
  fromFile?: string;
  fallbackDays: number;
  forceRepost: boolean;
  mode: RunMode;
  outputDir?: string;
}

interface RawCommit {
  hash: string;
  subject: string;
  body: string;
}

interface FixtureInput {
  commits: RawCommit[];
  submoduleAdvances: SubmoduleAdvance[];
  mockedLlmCompletion?: string;
}

interface CommitInput {
  index: number;
  hash: string;
  type: string;
  scope: string | null;
  subject: string;
  bodyFirstLine: string;
}

interface SubmoduleAdvance {
  submodule: string;
  from_sha: string;
  to_sha: string;
  commits: string[];
}

interface RenderBuckets {
  whatYoullSee: string[];
  whatWeFixed: string[];
  worthALook: string[];
}

interface SummaryMetadata {
  releaseSha: string;
  releaseShaShort: string;
  betaVersion: string;
  workflowRunUrl: string;
  runId: string;
  runAttempt: string;
  isBackfill: boolean;
  fallbackDays: number;
  generationMode: GenerationMode;
  generatedAtIso: string;
  idempotencyKey: string;
  /**
   * Number of additional `[deploy-beta]` markers the range walk-back consumed
   * to recover user-visible work after the immediate previous marker yielded
   * zero visible commits. 0 means the range was used as-resolved. Only set
   * when the walk actually recovered visible commits — if the walk exhausted
   * without finding any, this stays at 0 and the Quiet path renders cleanly.
   */
  consolidatedMarkerCount: number;
}

/**
 * The result of building a beta summary, as a discriminated union on `kind` so
 * that the SKIPPED state (idempotency hit, or a `raw_fallback` degraded summary
 * we deliberately suppress) is structurally incapable of carrying renderable
 * `markdown`/`slackPayload` into the Slack/changelog paths. Before this was a
 * single interface with an optional `skipReason` + empty-string markdown, so a
 * skipped bundle could be rendered/posted by shape alone if a `skipReason` guard
 * was ever missed (260607_make_beta_summaries_reliable_and_human, ab8ad392).
 *
 * `kind: 'posted'` covers BOTH a real summary (`metadata.generationMode === 'summary'`)
 * and a quiet beta (`generationMode === 'quiet'`) — they share an identical render
 * shape and identical handling (both render markdown + slackPayload and post), so
 * the posted/quiet distinction is carried by `metadata.generationMode` rather than a
 * third identical-shaped union member (which would add narrowing churn for no extra
 * safety). The dangerous, non-rendering state is `kind: 'skipped'`, and the union
 * makes "render a skipped bundle" fail to type-check.
 */
type SummaryBundle =
  | {
      kind: 'posted';
      metadata: SummaryMetadata;
      markdown: string;
      slackPayload: SlackWebhookPayload;
    }
  | {
      kind: 'skipped';
      metadata: SummaryMetadata;
      skipReason: string;
    };

interface SlackText {
  type: 'plain_text';
  text: string;
  emoji?: boolean;
}

interface SlackMrkdwn {
  type: 'mrkdwn';
  text: string;
}

interface SlackHeaderBlock {
  type: 'header';
  text: SlackText;
}

interface SlackContextBlock {
  type: 'context';
  elements: SlackMrkdwn[];
}

interface SlackSectionBlock {
  type: 'section';
  text: SlackMrkdwn;
}

interface SlackActionsBlock {
  type: 'actions';
  elements: Array<{
    type: 'button';
    text: SlackText;
    url: string;
  }>;
}

type SlackBlock = SlackHeaderBlock | SlackContextBlock | SlackSectionBlock | SlackActionsBlock;

interface SlackWebhookPayload {
  text: string;
  username: string;
  icon_emoji: string;
  blocks: SlackBlock[];
}

interface CommitRange {
  kind: 'since' | 'marker' | 'backfill';
  releaseSha: string;
  startRef?: string;
  isBackfill: boolean;
  fallbackDays: number;
}

interface LlmBucketEntry {
  /** Preferred shape: where in the product the change is (friendly area name). */
  area?: string;
  /** Preferred shape: what a user notices, in one plain sentence. */
  change?: string;
  /** Legacy shape: a single pre-composed bullet string (still accepted). */
  bullet?: string;
  source_indices?: number[];
  submodule_indices?: number[];
}

interface LlmResponseShape {
  what_youll_see: LlmBucketEntry[];
  what_we_fixed: LlmBucketEntry[];
  worth_a_look: LlmBucketEntry[];
}

function logInfo(message: string): void {
  console.log(`[post-beta-summary] ${message}`);
}

function logWarn(message: string): void {
  console.warn(`[post-beta-summary] ${message}`);
}

function logError(message: string): void {
  console.error(`[post-beta-summary] ${message}`);
}

/**
 * Structured, machine-readable outcome of the internal-changelog ARCHIVE COMMIT
 * path (`commitAndPushSummary`). The marker walk-back treats the archived
 * `INTERNAL_CHANGELOG.md` as the team's "last-announced release state"; if the
 * archive silently no-ops or fails, that state is stale and a later beta walks
 * back across a SHA boundary it shouldn't (see
 * `docs-private/postmortems/260531_beta_slack_summary_walks_back_across_55d515e_p3_postmortem.md`).
 * Making the outcome explicit + observable is the prerequisite for trusting that
 * state — and the silent `return true` no-op below is exactly the "silent
 * failure is a bug" pattern this replaces.
 */
type ArchiveCommitOutcomeKind =
  | 'skipped-bundle' // bundle.kind === 'skipped'; nothing to archive (expected, not degraded).
  | 'wrote-no-commit' // --no-commit: file written, git intentionally skipped.
  | 'no-op' // file written but produced NO staged change — observable degraded state.
  | 'committed' // committed + pushed to dev.
  | 'commit-failed' // `git add`/`git commit` itself failed; archive did not advance.
  | 'push-failed'; // committed locally but push exhausted retries.

interface ArchiveCommitOutcome {
  kind: ArchiveCommitOutcomeKind;
  /** Derived: did the path leave the system in the intended success state? */
  succeeded: boolean;
  releaseShaShort: string | null;
  betaVersion: string | null;
  /** Number of push attempts made (0 when push not reached). */
  pushAttempts: number;
  /** Failure detail for `push-failed`, else null. */
  error: string | null;
}

/**
 * Emit a single structured, machine-readable line for the archive commit
 * outcome so operators (and `metadata.json` / CI step summary consumers) can
 * trust the last-announced release state instead of inferring it from a boolean
 * or a stray `console.warn`. Severity tracks the outcome: degraded (`no-op`) is
 * warned, failure (`push-failed`) is errored, everything else is informational.
 */
function logArchiveCommitOutcome(outcome: ArchiveCommitOutcome): void {
  const line = `[archive-commit] ${JSON.stringify(outcome)}`;
  if (outcome.kind === 'push-failed' || outcome.kind === 'commit-failed') {
    logError(line);
  } else if (outcome.kind === 'no-op') {
    logWarn(line);
  } else {
    logInfo(line);
  }
}

function isCiEnvironment(): boolean {
  return process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
}

function printUsage(): void {
  const usage = [
    'Usage:',
    '  npx tsx scripts/post-beta-summary.ts [options]',
    '',
    'Default mode (no orchestration flags): generate -> post Slack -> commit+push',
    '',
    'Options:',
    '  --dry-run                 Generate only, print markdown + Slack JSON',
    '  --no-commit               Skip markdown commit + push in full mode',
    '  --since <ref>             Use custom git range start',
    '  --from-file <path>        Load commits from fixture JSON file',
    `  --fallback-days <N>       Backfill window in days (default: ${DEFAULT_FALLBACK_DAYS})`,
    '  --force-repost            Bypass idempotency no-op guard',
    '  --emit-only               Generate and write artifacts to --output-dir',
    '  --post-from <dir>         Post Slack from previously emitted artifacts',
    '  --commit-from <dir>       Commit/push markdown from emitted artifacts',
    '  --output-dir <dir>        Output directory for --emit-only artifacts',
    '  --help                    Show this help text',
  ];
  console.log(usage.join('\n'));
}

function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      'no-commit': { type: 'boolean', default: false },
      since: { type: 'string' },
      'from-file': { type: 'string' },
      'fallback-days': { type: 'string' },
      'force-repost': { type: 'boolean', default: false },
      'emit-only': { type: 'boolean', default: false },
      'post-from': { type: 'string' },
      'commit-from': { type: 'string' },
      'output-dir': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  const activeModes = [
    values['emit-only'] ? 'emit-only' : null,
    values['post-from'] ? 'post-from' : null,
    values['commit-from'] ? 'commit-from' : null,
  ].filter((mode): mode is RunMode => mode !== null);

  if (activeModes.length > 1) {
    throw new Error('Use only one orchestration mode at a time: --emit-only, --post-from, or --commit-from.');
  }

  const fallbackDaysRaw = values['fallback-days'] ?? String(DEFAULT_FALLBACK_DAYS);
  const fallbackDays = Number.parseInt(fallbackDaysRaw, 10);
  if (!Number.isFinite(fallbackDays) || fallbackDays < 1) {
    throw new Error(`Invalid --fallback-days value "${fallbackDaysRaw}". Expected integer >= 1.`);
  }

  const mode: RunMode = values['emit-only']
    ? 'emit-only'
    : values['post-from']
      ? 'post-from'
      : values['commit-from']
        ? 'commit-from'
        : 'full';

  if (mode === 'emit-only' && !values['output-dir']) {
    throw new Error('--emit-only requires --output-dir <dir>.');
  }

  if (mode === 'commit-from' && values['dry-run'] && values['no-commit']) {
    throw new Error('Invalid flag combination: --commit-from cannot be combined with --dry-run and --no-commit.');
  }
  if (mode === 'commit-from' && (values['dry-run'] || values['no-commit'])) {
    throw new Error('Invalid flag combination: --commit-from cannot be combined with --dry-run or --no-commit.');
  }
  if (mode === 'post-from' && values['dry-run']) {
    throw new Error('Invalid flag combination: --post-from cannot be combined with --dry-run.');
  }

  return {
    dryRun: values['dry-run'],
    noCommit: values['no-commit'],
    since: values.since,
    fromFile: values['from-file'],
    fallbackDays,
    forceRepost: values['force-repost'],
    mode,
    outputDir: values['output-dir'] ?? values['post-from'] ?? values['commit-from'],
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toShortSha(sha: string): string {
  return sha.slice(0, 7);
}

function normaliseWhitespace(input: string): string {
  return input
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

function sanitiseBulletText(text: string): string {
  let next = text;
  next = next.replace(/\[deploy-beta\]/gi, '[deploy beta]');
  next = next.replace(/\b[a-f0-9]{7,40}\b/gi, '');
  next = next.replace(/#\d+/g, '');
  next = next.replace(/\borigin\/[^\s)]+/gi, '');
  next = next.replace(/\brefs\/heads\/[^\s)]+/gi, '');
  return normaliseWhitespace(next);
}

function sentenceCase(text: string): string {
  const normalised = normaliseWhitespace(text);
  if (!normalised) {
    return '';
  }
  return `${normalised.charAt(0).toUpperCase()}${normalised.slice(1)}`;
}

function lowerFirst(text: string): string {
  const normalised = normaliseWhitespace(text);
  if (!normalised) {
    return '';
  }
  return `${normalised.charAt(0).toLowerCase()}${normalised.slice(1)}`;
}

function isInternalOnlyCommit(commit: { scope: string | null; subject: string; bodyFirstLine?: string }): boolean {
  const scope = commit.scope?.toLowerCase();
  if (scope && INTERNAL_ONLY_SCOPES.has(scope)) {
    return true;
  }

  // Strip the literal `[deploy-beta]` marker token before regex matching so
  // user-visible commits whose subject/body happens to carry the marker
  // (e.g. `fix(safety): Bump USER_MESSAGE_MAX_CHARS … [deploy-beta]`) are
  // not falsely classified as internal by the `/\bdeploy(s|ed|ment)?\b/i`
  // pattern in TECHNICAL_SUMMARY_PATTERNS.
  const searchable = `${commit.subject} ${commit.bodyFirstLine ?? ''}`.replace(/\[deploy-beta\]/gi, '');
  return TECHNICAL_SUMMARY_PATTERNS.some((pattern) => pattern.test(searchable));
}

function buildFallbackDetail(commit: CommitInput): string | null {
  const body = sanitiseBulletText(commit.bodyFirstLine);
  if (!body || TECHNICAL_SUMMARY_PATTERNS.some((pattern) => pattern.test(body))) {
    return null;
  }

  const hasUserContext = /\b(user|users|someone|demo|support|setup|connect(?:or|ion)|preview|previews|homepage|onboarding)\b/i.test(body);
  return hasUserContext ? lowerFirst(body).replace(/[.!?]+$/, '') : null;
}

function normaliseFallbackSubject(subject: string): string {
  return sanitiseBulletText(subject)
    .replace(/^Added\b/i, 'Adds')
    .replace(/^Add\b/i, 'Adds')
    .replace(/^Fixed\b/i, 'Fixes')
    .replace(/^Fix\b/i, 'Fixes')
    .replace(/^Prevented\b/i, 'Prevents')
    .replace(/^Prevent\b/i, 'Prevents')
    .replace(/^Stopped\b/i, 'Stops')
    .replace(/^Stop\b/i, 'Stops')
    .replace(/^Reduced\b/i, 'Reduces')
    .replace(/^Reduce\b/i, 'Reduces')
    .replace(/^Tightened\b/i, 'Tightens')
    .replace(/^Tighten\b/i, 'Tightens')
    .replace(/^Clarified\b/i, 'Clarifies')
    .replace(/^Clarify\b/i, 'Clarifies');
}

function buildFallbackBullet(commit: CommitInput): string | null {
  if (isInternalOnlyCommit(commit)) {
    return null;
  }

  const cleaned = normaliseFallbackSubject(commit.subject);
  const detail = buildFallbackDetail(commit);

  if (!cleaned || TECHNICAL_SUMMARY_PATTERNS.some((pattern) => pattern.test(cleaned))) {
    return null;
  }

  const bullet = sentenceCase(cleaned).replace(/[.!?]+$/, '');
  if (!detail || bullet.toLowerCase().includes(detail.toLowerCase())) {
    return bullet;
  }

  return `${bullet}: ${detail}.`;
}

function capBucketLines(lines: string[]): string[] {
  if (lines.length <= MAX_BUCKET_LINES) {
    return lines;
  }
  const keepCount = Math.max(1, MAX_BUCKET_LINES - 1);
  const overflowCount = lines.length - keepCount;
  return [...lines.slice(0, keepCount), `and ${overflowCount} smaller tweaks`];
}

async function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, {
    cwd: options?.cwd ?? REPO_ROOT,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
}

async function runGit(args: string[], options?: { cwd?: string }): Promise<string> {
  const result = await runCommand('git', args, options);
  return result.stdout.trim();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const maybeWithStderr = error as Error & { stderr?: string; stdout?: string };
    const stderr = typeof maybeWithStderr.stderr === 'string' ? maybeWithStderr.stderr.trim() : '';
    const stdout = typeof maybeWithStderr.stdout === 'string' ? maybeWithStderr.stdout.trim() : '';
    const details = [error.message.trim(), stderr, stdout].filter(Boolean).join(' | ');
    return details || error.message || String(error);
  }
  return String(error);
}

async function tryGit(args: string[], options?: { cwd?: string }): Promise<{ ok: true; stdout: string } | { ok: false; error: Error }> {
  try {
    const stdout = await runGit(args, options);
    return { ok: true, stdout };
  } catch (error) {
    const message = `git ${args.join(' ')} failed: ${getErrorMessage(error)}`;
    return {
      ok: false,
      error: new Error(message),
    };
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

function resolvePathFromRepo(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.join(REPO_ROOT, inputPath);
}

async function resolveReleaseSha(): Promise<string> {
  if (process.env.RELEASE_SHA) {
    return process.env.RELEASE_SHA;
  }
  const localHead = await runGit(['rev-parse', '--verify', 'HEAD']);
  return localHead;
}

async function resolveBetaVersion(): Promise<string> {
  if (process.env.BETA_VERSION) {
    return process.env.BETA_VERSION;
  }
  const pkgPath = path.join(REPO_ROOT, 'package.json');
  const pkg = await readJsonFile<{ version?: string }>(pkgPath);
  if (!pkg.version) {
    throw new Error('Unable to resolve beta version from package.json.');
  }
  return pkg.version;
}

function parseConventionalSubject(subject: string): { type: string; scope: string | null; summary: string } {
  const match = subject.match(/^([a-z]+)(?:\(([^)]+)\))?!?:\s*(.+)$/i);
  if (!match) {
    return { type: 'other', scope: null, summary: subject.trim() };
  }
  return {
    type: match[1].toLowerCase(),
    scope: match[2] ? match[2].trim() : null,
    summary: match[3].trim(),
  };
}

function parseGitLogOutput(raw: string): RawCommit[] {
  if (!raw.trim()) {
    return [];
  }
  return raw
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash = '', subject = '', body = ''] = entry.split('\x1f');
      return {
        hash: hash.trim(),
        subject: subject.trim(),
        body: body.trim(),
      };
    });
}

async function getLatestDeployBetaMarker(ref: string): Promise<string | null> {
  const result = await tryGit(['log', '--first-parent', '--format=%H', '--grep=\\[deploy-beta\\]', '-n', '1', ref]);
  if (!result.ok) {
    logInfo(`Marker lookup fallback for ref "${ref}": ${result.error.message}`);
    return null;
  }
  return result.stdout || null;
}

async function resolveCommitRange(releaseSha: string, options: CliOptions): Promise<CommitRange> {
  if (options.since) {
    logInfo(`Using explicit --since range start: ${options.since}`);
    return {
      kind: 'since',
      releaseSha,
      startRef: options.since,
      isBackfill: false,
      fallbackDays: options.fallbackDays,
    };
  }

  const currentMarker = await getLatestDeployBetaMarker(releaseSha);
  if (!currentMarker) {
    logWarn(`No [deploy-beta] marker found at-or-before ${toShortSha(releaseSha)}. Falling back to ${options.fallbackDays} days.`);
    return {
      kind: 'backfill',
      releaseSha,
      isBackfill: true,
      fallbackDays: options.fallbackDays,
    };
  }

  const previousMarker = await getLatestDeployBetaMarker(`${currentMarker}^`);
  if (!previousMarker) {
    logWarn(`No previous [deploy-beta] marker found before ${toShortSha(currentMarker)}. Falling back to ${options.fallbackDays} days.`);
    return {
      kind: 'backfill',
      releaseSha,
      isBackfill: true,
      fallbackDays: options.fallbackDays,
    };
  }

  logInfo(`Resolved marker range ${toShortSha(previousMarker)}..${toShortSha(releaseSha)}.`);
  return {
    kind: 'marker',
    releaseSha,
    startRef: previousMarker,
    isBackfill: false,
    fallbackDays: options.fallbackDays,
  };
}

async function loadCommitsFromGit(range: CommitRange): Promise<RawCommit[]> {
  const prettyFormat = '--pretty=format:%H%x1f%s%x1f%b%x1e';
  const args = ['log', '--no-merges', prettyFormat];

  if (range.kind === 'marker' || range.kind === 'since') {
    args.push(`${range.startRef}..${range.releaseSha}`);
  } else {
    args.push(range.releaseSha, `--since=${range.fallbackDays} days ago`);
  }

  const raw = await runGit(args);
  return parseGitLogOutput(raw);
}

async function getCommitTimestamp(sha: string): Promise<Date> {
  const isoString = await runGit(['log', '-1', '--format=%aI', sha]);
  return new Date(isoString);
}

/**
 * Walks the rendered `INTERNAL_CHANGELOG.md` content from top (most recent)
 * to bottom and returns the short SHA prefix of the most recent section that
 * is NOT a Quiet-only post — i.e., contains at least one recognised bucket
 * heading. Returns `null` if the file has no real announcements yet (empty,
 * "Latest"-anchor only, or only Quiet sections).
 *
 * Used as a lower bound on the walk-back: we never cross past an already-
 * announced beta because doing so would re-announce work that landed in
 * that earlier summary.
 *
 * The expected section header shape is the same one `renderMarkdown`
 * produces: `## YYYY-MM-DD — beta v… ([shaShort](url))`.
 */
function findLastAnnouncedReleaseShaPrefix(changelogContent: string): string | null {
  if (!changelogContent.trim()) {
    return null;
  }

  const headerRegex = /^## (.+)$/gm;
  const headers: Array<{ headerLine: string; matchIndex: number }> = [];
  let headerMatch: RegExpExecArray | null;
  while ((headerMatch = headerRegex.exec(changelogContent)) !== null) {
    headers.push({ headerLine: headerMatch[1], matchIndex: headerMatch.index });
  }

  for (let idx = 0; idx < headers.length; idx += 1) {
    const { headerLine, matchIndex } = headers[idx];
    if (headerLine.trim().toLowerCase() === 'latest') {
      continue;
    }

    const bodyStart = changelogContent.indexOf('\n', matchIndex);
    if (bodyStart === -1) {
      continue;
    }
    const bodyEnd = idx + 1 < headers.length ? headers[idx + 1].matchIndex : changelogContent.length;
    const body = changelogContent.slice(bodyStart + 1, bodyEnd);

    const hasNonQuietBucket = [...ANNOUNCED_SECTION_HEADINGS]
      .some((heading) => body.includes(`### ${heading}`));
    if (!hasNonQuietBucket) {
      continue;
    }

    const shaMatch = headerLine.match(/\(\[([0-9a-f]+)\]\(/i);
    if (shaMatch) {
      return shaMatch[1];
    }
  }

  return null;
}

interface ExpandMarkerRangeDeps {
  getLatestMarker: (ref: string) => Promise<string | null>;
  loadCommits: (range: CommitRange) => Promise<RawCommit[]>;
  filterVisible: (commits: RawCommit[]) => CommitInput[];
  getCommitTimestamp: (sha: string) => Promise<Date>;
  /**
   * Short SHA prefix of the most recent non-Quiet announcement on file (from
   * `INTERNAL_CHANGELOG.md`). When set, walk-back stops BEFORE processing any
   * marker SHA whose 40-char form starts with this prefix — i.e., we never
   * cross past an already-announced beta, which would re-announce work that
   * was already in the team's earlier summary. Source via
   * `findLastAnnouncedReleaseShaPrefix(changelogContent)`.
   */
  lastAnnouncedShaPrefix?: string;
}

interface ExpandMarkerRangeResult {
  range: CommitRange;
  rawCommits: RawCommit[];
  visibleCommits: CommitInput[];
  hopsWalked: number;
}

/**
 * Walk backwards through the `[deploy-beta]` marker chain when the initial
 * marker-delimited range yielded zero visible commits.
 *
 * Rationale: `[deploy-beta]` is now appended to CI-fix retry commits rather
 * than reserved for dedicated `chore(release)` trigger commits. Between two
 * consecutive retry markers the inter-marker range collapses to a single
 * internal-only commit and the script otherwise reports a false "Quiet beta",
 * dropping the substantial user-visible work bundled into the *original*
 * failed beta attempts. See the diagnosis doc at
 * `docs-private/investigations/260521_beta_summary_quiet_false_positive.md`.
 *
 * Termination guards (whichever fires first):
 *   - Hop ceiling: `MAX_MARKER_WALK_HOPS` markers (safety bound).
 *   - `getLatestMarker` returns `null`: no more markers in the chain.
 *   - A previously-seen marker is encountered (cycle guard).
 *   - The next marker matches `lastAnnouncedShaPrefix`: stop before
 *     crossing past an already-announced beta (prevents re-announcement).
 *   - Fallback-days cap: the widened range never extends further back than
 *     the standard backfill window (`fallbackDays`).
 *   - Visible commits found: the widened range is returned.
 *
 * Pure helper: all git access flows through injected `deps` so this is
 * deterministically unit-testable without touching the filesystem.
 */
async function expandMarkerRangeUntilVisible(
  initialRange: CommitRange,
  initialRawCommits: RawCommit[],
  initialVisibleCommits: CommitInput[],
  fallbackDays: number,
  deps: ExpandMarkerRangeDeps,
): Promise<ExpandMarkerRangeResult> {
  if (initialRange.kind !== 'marker' || !initialRange.startRef || initialVisibleCommits.length !== 0) {
    return {
      range: initialRange,
      rawCommits: initialRawCommits,
      visibleCommits: initialVisibleCommits,
      hopsWalked: 0,
    };
  }

  // Initial-start guard: if the immediate previous marker is itself the most
  // recent announced beta, walk-back must not proceed at all — any hop would
  // widen the range past that announced boundary and re-include its work. The
  // current beta is genuinely Quiet (only internal-only work since the
  // announced one) and should render as such.
  if (
    deps.lastAnnouncedShaPrefix
    && initialRange.startRef.startsWith(deps.lastAnnouncedShaPrefix)
  ) {
    return {
      range: initialRange,
      rawCommits: initialRawCommits,
      visibleCommits: initialVisibleCommits,
      hopsWalked: 0,
    };
  }

  const fallbackMs = fallbackDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const seenMarkers = new Set<string>([initialRange.startRef]);

  let currentStartRef = initialRange.startRef;
  let currentRange: CommitRange = initialRange;
  let currentRawCommits = initialRawCommits;
  let currentVisibleCommits = initialVisibleCommits;
  let hopsWalked = 0;

  while (hopsWalked < MAX_MARKER_WALK_HOPS) {
    const newStartRef = await deps.getLatestMarker(`${currentStartRef}^`);
    if (!newStartRef) {
      break;
    }
    if (seenMarkers.has(newStartRef)) {
      break;
    }
    if (deps.lastAnnouncedShaPrefix && newStartRef.startsWith(deps.lastAnnouncedShaPrefix)) {
      break;
    }

    const newTimestamp = await deps.getCommitTimestamp(newStartRef);
    if (Number.isFinite(newTimestamp.getTime()) && now - newTimestamp.getTime() > fallbackMs) {
      break;
    }

    seenMarkers.add(newStartRef);
    hopsWalked += 1;
    currentStartRef = newStartRef;
    currentRange = {
      ...initialRange,
      startRef: newStartRef,
    };
    currentRawCommits = await deps.loadCommits(currentRange);
    currentVisibleCommits = deps.filterVisible(currentRawCommits);

    if (currentVisibleCommits.length > 0) {
      return {
        range: currentRange,
        rawCommits: currentRawCommits,
        visibleCommits: currentVisibleCommits,
        hopsWalked,
      };
    }
  }

  return {
    range: currentRange,
    rawCommits: currentRawCommits,
    visibleCommits: currentVisibleCommits,
    hopsWalked,
  };
}

function parseFixtureCommitRow(row: unknown, index: number): RawCommit {
  if (typeof row === 'string') {
    return {
      hash: `fixture-${String(index + 1).padStart(4, '0')}`,
      subject: row.trim(),
      body: '',
    };
  }
  if (!row || typeof row !== 'object') {
    throw new Error(`Fixture row ${index + 1} is invalid.`);
  }
  const data = row as { hash?: unknown; subject?: unknown; body?: unknown };
  if (typeof data.subject !== 'string' || !data.subject.trim()) {
    throw new Error(`Fixture row ${index + 1} must include a non-empty "subject" string.`);
  }
  return {
    hash: typeof data.hash === 'string' && data.hash.trim()
      ? data.hash.trim()
      : `fixture-${String(index + 1).padStart(4, '0')}`,
    subject: data.subject.trim(),
    body: typeof data.body === 'string' ? data.body : '',
  };
}

async function loadCommitsFromFixture(filePath: string): Promise<FixtureInput> {
  const absolutePath = resolvePathFromRepo(filePath);
  const fixture = await readJsonFile<unknown>(absolutePath);

  const rows = Array.isArray(fixture)
    ? fixture
    : (fixture && typeof fixture === 'object' && Array.isArray((fixture as { commits?: unknown[] }).commits))
      ? (fixture as { commits: unknown[] }).commits
      : null;

  if (!rows) {
    throw new Error(`Fixture ${absolutePath} must be an array or object with a "commits" array.`);
  }

  let submoduleAdvances: SubmoduleAdvance[] = [];
  let mockedLlmCompletion: string | undefined;
  if (fixture && typeof fixture === 'object' && !Array.isArray(fixture)) {
    const submoduleCandidate = (fixture as { submodule_advances?: unknown }).submodule_advances;
    if (Array.isArray(submoduleCandidate)) {
      submoduleAdvances = submoduleCandidate
        .filter((entry): entry is SubmoduleAdvance => !!entry && typeof entry === 'object')
        .map((entry) => ({
          submodule: typeof entry.submodule === 'string' ? entry.submodule : 'unknown-submodule',
          from_sha: typeof entry.from_sha === 'string' ? entry.from_sha : '',
          to_sha: typeof entry.to_sha === 'string' ? entry.to_sha : '',
          commits: Array.isArray(entry.commits)
            ? entry.commits.filter((item): item is string => typeof item === 'string')
            : [],
        }));
    }

    const mockCompletion = (fixture as { mocked_llm_completion?: unknown }).mocked_llm_completion;
    if (typeof mockCompletion === 'string' && mockCompletion.trim()) {
      mockedLlmCompletion = mockCompletion;
    }
  }

  return {
    commits: rows.map(parseFixtureCommitRow),
    submoduleAdvances,
    mockedLlmCompletion,
  };
}

function filterVisibleCommits(commits: RawCommit[]): CommitInput[] {
  const candidates = commits
    .map((commit) => {
      const parsed = parseConventionalSubject(commit.subject);
      return {
        index: 0,
        hash: commit.hash,
        type: parsed.type,
        scope: parsed.scope,
        subject: parsed.summary,
        bodyFirstLine: commit.body.split('\n').map((line) => line.trim()).find(Boolean) ?? '',
      };
    })
    .filter((commit) => VISIBLE_COMMIT_TYPES.has(commit.type))
    .filter((commit) => !isInternalOnlyCommit(commit));

  return candidates.map((commit, index) => ({
    ...commit,
    index,
  }));
}

async function detectSubmoduleAdvances(range: CommitRange): Promise<SubmoduleAdvance[]> {
  if (!range.startRef || range.kind === 'backfill') {
    return [];
  }

  const diffResult = await tryGit([
    'diff',
    '--raw',
    `${range.startRef}..${range.releaseSha}`,
    '--',
    'rebel-system',
    'super-mcp',
  ]);

  if (!diffResult.ok) {
    logInfo(`Submodule advance detection fallback: ${diffResult.error.message}`);
    return [];
  }

  if (!diffResult.stdout.trim()) {
    return [];
  }

  const advances: SubmoduleAdvance[] = [];
  const lines = diffResult.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^:160000 160000 ([a-f0-9]{40}) ([a-f0-9]{40}) [A-Z]\t(.+)$/i);
    if (!match) {
      continue;
    }
    const fromSha = match[1];
    const toSha = match[2];
    const submodulePath = match[3];
    if (fromSha === toSha || /^0+$/.test(toSha)) {
      continue;
    }

    const logResult = await tryGit(['log', '--oneline', `${fromSha}..${toSha}`], {
      cwd: path.join(REPO_ROOT, submodulePath),
    });

    advances.push({
      submodule: submodulePath,
      from_sha: fromSha,
      to_sha: toSha,
      commits: logResult.ok
        ? logResult.stdout.split('\n').map((item) => item.trim()).filter(Boolean)
        : [],
    });
    if (!logResult.ok) {
      logInfo(`Submodule commit log fallback for ${submodulePath}: ${logResult.error.message}`);
    }
  }
  return advances;
}

async function readFileIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function isMissingRemoteChangelogError(message: string): boolean {
  return /INTERNAL_CHANGELOG\.md/i.test(message)
    && /(does not exist|exists on disk, but not in)/i.test(message);
}

async function readChangelogForIdempotency(): Promise<{ content: string; source: 'remote' | 'local' }> {
  const isCi = isCiEnvironment();
  const remoteFetch = await tryGit(['fetch', 'origin', 'dev']);
  if (!remoteFetch.ok) {
    if (isCi) {
      throw new Error(`Idempotency check failed in CI: ${remoteFetch.error.message}`);
    }
    logInfo(`Falling back to local INTERNAL_CHANGELOG.md (fetch failed): ${remoteFetch.error.message}`);
    return {
      content: await readFileIfExists(INTERNAL_CHANGELOG_PATH),
      source: 'local',
    };
  }

  const remoteContent = await tryGit(['show', 'origin/dev:INTERNAL_CHANGELOG.md']);
  if (remoteContent.ok) {
    return {
      content: remoteContent.stdout,
      source: 'remote',
    };
  }

  if (isMissingRemoteChangelogError(remoteContent.error.message)) {
    logInfo('Remote INTERNAL_CHANGELOG.md not found on origin/dev; treating idempotency baseline as empty (first run).');
    return {
      content: '',
      source: 'remote',
    };
  }

  if (isCi) {
    throw new Error(`Idempotency check failed in CI: ${remoteContent.error.message}`);
  }

  logInfo(`Falling back to local INTERNAL_CHANGELOG.md (remote read failed): ${remoteContent.error.message}`);
  return {
    content: await readFileIfExists(INTERNAL_CHANGELOG_PATH),
    source: 'local',
  };
}

function alreadyPostedForSha(changelogContent: string, releaseShaShort: string): boolean {
  const pattern = new RegExp(`beta-summary-key:\\s*${escapeRegExp(releaseShaShort)}-`);
  return pattern.test(changelogContent);
}

function buildLlmSystemPrompt(): string {
  return [
    'You write internal beta release notes for Rebel.',
    'Audience: product, sales, customer success, and other non-technical teammates who need to know what changed for users.',
    'Primary reader need: customer-facing teammates should be able to recognise what changed, say WHERE in the app it is, and avoid being surprised in demos, office hours, or support conversations.',
    'Voice and tone:',
    '- Dry, witty, calm, useful.',
    '- Clear over clever, useful over impressive.',
    '- Plain language for non-technical knowledge workers.',
    '- No emoji.',
    '',
    'Every bullet answers two things: WHERE in the product the change is, and WHAT changed in plain English.',
    '- "area": the user-facing part of the app the change touches, in friendly product terms (for example "Conversations", "Connectors", "Model picker", "Files", "Meetings", "Onboarding", "Settings", "Voice", "Home", "Actions"). Never a code scope, module, file, or function name.',
    '- "change": what a person would notice, or can now rely on, in one calm sentence.',
    '',
    'Hard rules — these make the note useless to non-technical readers, so never do them:',
    '- No issue or ticket IDs (for example REBEL-62A, JIRA-123).',
    '- No "Stage N", phase numbers, "follow-up", or planning references.',
    '- No commit-style prefixes (feat:, fix:, chore:) and never copy a commit subject verbatim.',
    '- No internal codenames, variable names, function names, or file paths.',
    '- No engineering jargon (for example "resolver", "overlay", "parity", "atomic", "idempotent", "escalation"). Translate to plain user impact.',
    '- No raw commit hashes, PR numbers, or branch refs.',
    '- Never include the literal [deploy-beta].',
    '',
    'Task:',
    '- Return strict JSON only, no markdown, no prose outside JSON.',
    '- Use three buckets. These JSON keys render as Slack/markdown sections:',
    `  1) what_youll_see -> "${SECTION_UI_CHANGES}" (visible screens, copy, navigation, setup, loading/error states, interaction changes)`,
    `  2) what_we_fixed -> "${SECTION_DEMO_SUPPORT}" (reliability/behaviour changes, framed as what users notice or what support can now explain)`,
    `  3) worth_a_look -> "${SECTION_OTHER_FIXES}" (useful internal context that should not dominate the post)`,
    '- Buckets may be empty arrays.',
    '- Lead with what users can see, demo, explain, or rely on. Omit implementation mechanics.',
    '- This is an awareness briefing, not a review rota. Do not assign review tasks or name which internal roles should review.',
    '- Do not mention tests, CI, build systems, Storybook, submodules, commit hygiene, or release plumbing unless it directly changes what users experience.',
    '- Every bullet must include at least one reference array:',
    '  - source_indices (indexes into commits)',
    '  - submodule_indices (indexes into submodule_advances)',
    '- Bullets may reference commits, submodule advances, or both.',
    '',
    'Examples:',
    '- UI: { "area": "Home", "change": "the Today panel opens with clearer first-run guidance, so new users have an easier first scan.", "source_indices": [1] }',
    '- Demo/support: { "area": "Connectors", "change": "setting up a connection now explains itself when it needs attention, so support can point to the on-screen recovery step.", "source_indices": [2] }',
    '- Other: { "area": "Files", "change": "repeated file updates feel steadier during longer sessions.", "source_indices": [3] }',
    '- Submodule-only: { "area": "Skills", "change": "bundled skill wording is clearer.", "submodule_indices": [0] }',
    '',
    'Required JSON schema:',
    '{',
    '  "what_youll_see": [{ "area": "string", "change": "string", "source_indices": [0], "submodule_indices": [0] }],',
    '  "what_we_fixed":  [{ "area": "string", "change": "string", "source_indices": [0], "submodule_indices": [0] }],',
    '  "worth_a_look":   [{ "area": "string", "change": "string", "source_indices": [0], "submodule_indices": [0] }]',
    '}',
  ].join('\n');
}

function extractLikelyJsonObject(rawText: string): string {
  const trimmed = rawText.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error('No JSON object found in LLM response.');
  }
  return match[0];
}

interface BucketParseResult {
  kept: string[];
  droppedReasons: string[];
}

/**
 * Validates one bucket's entries leniently: a malformed entry (bad bullet,
 * missing/out-of-range reference indices) is dropped with a recorded reason
 * rather than throwing. This prevents a single bad index from discarding an
 * otherwise-good summary and forcing the conservative commit-dump fallback.
 * Structural problems (the whole value is not an array) are reported as a drop
 * reason too, so the caller can decide whether to retry.
 */
function parseBucketEntries(
  bucketName: string,
  value: unknown,
  commitCount: number,
  submoduleCount: number,
): BucketParseResult {
  const kept: string[] = [];
  const droppedReasons: string[] = [];

  if (value === undefined || value === null) {
    return { kept, droppedReasons };
  }
  if (!Array.isArray(value)) {
    droppedReasons.push(`Bucket "${bucketName}" is not an array.`);
    return { kept, droppedReasons };
  }

  value.forEach((entry, idx) => {
    const drop = (reason: string): void => {
      droppedReasons.push(`Bucket "${bucketName}" entry ${idx}: ${reason}`);
    };

    if (!entry || typeof entry !== 'object') {
      drop('not an object');
      return;
    }
    const candidate = entry as {
      area?: unknown;
      change?: unknown;
      bullet?: unknown;
      source_indices?: unknown;
      submodule_indices?: unknown;
    };

    // Preferred shape is structured area + change ("where" + "what"), composed
    // into "Area — change". A legacy single "bullet" string is still accepted so
    // a model that returns the older shape degrades gracefully instead of being
    // dropped (which would force a skipped post).
    const area = typeof candidate.area === 'string' ? candidate.area.trim() : '';
    const change = typeof candidate.change === 'string' ? candidate.change.trim() : '';
    const legacyBullet = typeof candidate.bullet === 'string' ? candidate.bullet.trim() : '';
    let rawLine = '';
    if (area && change) {
      rawLine = `${area} — ${change}`;
    } else if (legacyBullet) {
      rawLine = legacyBullet;
    }
    if (!rawLine) {
      drop('missing area+change (and no legacy bullet)');
      return;
    }

    const sourceIndices = Array.isArray(candidate.source_indices) ? candidate.source_indices : [];
    const submoduleIndices = Array.isArray(candidate.submodule_indices) ? candidate.submodule_indices : [];

    if (sourceIndices.length === 0 && submoduleIndices.length === 0) {
      drop('missing source_indices and submodule_indices');
      return;
    }

    const badSourceIndex = sourceIndices.some(
      (index) => !Number.isInteger(index) || index < 0 || index >= commitCount,
    );
    if (badSourceIndex) {
      drop('out-of-range or non-integer source index');
      return;
    }

    const badSubmoduleIndex = submoduleIndices.some(
      (index) => !Number.isInteger(index) || index < 0 || index >= submoduleCount,
    );
    if (badSubmoduleIndex) {
      drop('out-of-range or non-integer submodule index');
      return;
    }

    const cleaned = sanitiseBulletText(rawLine);
    if (!cleaned) {
      drop('empty after sanitisation');
      return;
    }
    const banned = findBannedBulletContent(cleaned);
    if (banned) {
      drop(`contains banned content (${banned})`);
      return;
    }
    kept.push(cleaned);
  });

  return { kept, droppedReasons };
}

interface DetailedLlmResponse {
  buckets: RenderBuckets;
  keptCount: number;
  droppedReasons: string[];
}

/**
 * Parses an LLM response, keeping every valid bullet and reporting which (if
 * any) were dropped. Throws only on structural failures that make the whole
 * response unusable (no JSON object, invalid JSON) — those are the cases that
 * warrant a retry rather than a partial accept.
 */
function parseLlmResponseDetailed(
  rawText: string,
  commitCount: number,
  submoduleCount: number,
): DetailedLlmResponse {
  const jsonText = extractLikelyJsonObject(rawText);
  const parsed = JSON.parse(jsonText) as Partial<LlmResponseShape>;

  const whatYoullSee = parseBucketEntries('what_youll_see', parsed.what_youll_see, commitCount, submoduleCount);
  const whatWeFixed = parseBucketEntries('what_we_fixed', parsed.what_we_fixed, commitCount, submoduleCount);
  const worthALook = parseBucketEntries('worth_a_look', parsed.worth_a_look, commitCount, submoduleCount);

  return {
    buckets: {
      whatYoullSee: capBucketLines(whatYoullSee.kept),
      whatWeFixed: capBucketLines(whatWeFixed.kept),
      worthALook: capBucketLines(worthALook.kept),
    },
    keptCount: whatYoullSee.kept.length + whatWeFixed.kept.length + worthALook.kept.length,
    droppedReasons: [
      ...whatYoullSee.droppedReasons,
      ...whatWeFixed.droppedReasons,
      ...worthALook.droppedReasons,
    ],
  };
}

function parseLlmResponse(rawText: string, commitCount: number, submoduleCount: number): RenderBuckets {
  return parseLlmResponseDetailed(rawText, commitCount, submoduleCount).buckets;
}

function extractTextBlocks(response: Anthropic.Message): string {
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * Requests one completion attempt. Injected in tests to drive the repair-retry
 * loop deterministically; in production it wraps the Anthropic client.
 */
type CompletionRequester = (userContent: string, attempt: number) => Promise<string>;

async function generateBucketsWithLlm(
  commits: CommitInput[],
  submoduleAdvances: SubmoduleAdvance[],
  metadata: SummaryMetadata,
  mockedLlmCompletion?: string,
  requestCompletionOverride?: CompletionRequester,
): Promise<RenderBuckets> {
  const parseCompletionWithAssistantPrefill = (completionText: string): DetailedLlmResponse => {
    const completionBody = completionText.trim();
    if (!completionBody) {
      throw new Error('Anthropic returned an empty response.');
    }
    const prefilled = completionBody.startsWith('{')
      ? completionBody
      : `{${completionBody}`;
    try {
      return parseLlmResponseDetailed(prefilled, commits.length, submoduleAdvances.length);
    } catch (prefillError) {
      // The model may have ignored the assistant '{' prefill and emitted a
      // full JSON object (sometimes wrapped in prose). In that case prepending
      // '{' corrupts otherwise-valid JSON, so salvage by parsing the raw
      // completion before counting this attempt as failed.
      if (!completionBody.startsWith('{')) {
        try {
          return parseLlmResponseDetailed(completionBody, commits.length, submoduleAdvances.length);
        } catch {
          throw prefillError;
        }
      }
      throw prefillError;
    }
  };

  const hasInputToSummarise = commits.length > 0 || submoduleAdvances.length > 0;

  // Accept a parsed response, logging any dropped bullets for observability.
  // No usable bullets when there WAS input to summarise is an under-production
  // failure: throw so the caller retries and, if still unusable, suppresses the
  // post — never broadcast a blank/near-blank summary. Empty is only a valid
  // outcome when there was genuinely nothing to summarise.
  const acceptOrThrow = (result: DetailedLlmResponse): RenderBuckets => {
    if (result.keptCount > 0) {
      if (result.droppedReasons.length > 0) {
        logWarn(
          `Kept ${result.keptCount} bullet(s); dropped ${result.droppedReasons.length} invalid one(s): ${result.droppedReasons.join('; ')}`,
        );
      }
      return result.buckets;
    }
    if (hasInputToSummarise) {
      const detail = result.droppedReasons.length > 0
        ? result.droppedReasons.join('; ')
        : `model returned no usable bullets for ${commits.length} commit(s) and ${submoduleAdvances.length} submodule advance(s)`;
      throw new Error(`No usable bullets after validation: ${detail}`);
    }
    return result.buckets;
  };

  if (mockedLlmCompletion) {
    return acceptOrThrow(parseCompletionWithAssistantPrefill(mockedLlmCompletion));
  }

  const payload = {
    beta_version: metadata.betaVersion,
    release_sha_short: metadata.releaseShaShort,
    is_backfill: metadata.isBackfill,
    commits: commits.map((commit) => ({
      index: commit.index,
      type: commit.type,
      scope: commit.scope,
      subject: commit.subject,
      body_first_line: commit.bodyFirstLine,
    })),
    submodule_advances: submoduleAdvances,
  };
  const basePayloadJson = JSON.stringify(payload, null, 2);

  const requestCompletion: CompletionRequester = requestCompletionOverride ?? (() => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set.');
    }
    const client = new Anthropic({
      apiKey,
      timeout: 60_000,
      maxRetries: 2,
    });
    return async (userContent: string): Promise<string> => {
      const request = {
        model: DEFAULT_MODEL,
        max_tokens: 2_000,
        system: buildLlmSystemPrompt(),
        messages: [
          {
            role: 'user',
            content: userContent,
          },
          {
            role: 'assistant',
            content: '{',
          },
        ],
      } satisfies Anthropic.MessageCreateParamsNonStreaming;
      const response = await client.messages.create(request);
      return extractTextBlocks(response);
    };
  })();

  // The Anthropic SDK's maxRetries only covers transport failures (429/5xx/
  // network). It does NOT retry a 200 response we then fail to parse or
  // validate — historically the single largest cause of falling back to the
  // commit dump. This app-level loop re-prompts with the validation error so a
  // malformed-but-recoverable response gets a repair attempt before we give up.
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt += 1) {
    const userContent = attempt === 1
      ? basePayloadJson
      : `${basePayloadJson}\n\nNOTE: a previous attempt was rejected (${lastError?.message ?? 'unknown error'}). Return corrected, strict JSON only, matching the required schema. Every bullet must include valid, in-range source_indices and/or submodule_indices.`;

    try {
      const completion = await requestCompletion(userContent, attempt);
      return acceptOrThrow(parseCompletionWithAssistantPrefill(completion));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < MAX_LLM_ATTEMPTS) {
        logWarn(`LLM attempt ${attempt} unusable (${lastError.message}); retrying.`);
      }
    }
  }

  throw lastError ?? new Error('LLM summary generation failed.');
}

function buildRawFallbackBuckets(commits: CommitInput[]): RenderBuckets {
  const buckets: RenderBuckets = {
    whatYoullSee: [],
    whatWeFixed: [],
    worthALook: [],
  };

  for (const commit of commits) {
    const bullet = buildFallbackBullet(commit);
    if (!bullet) {
      continue;
    }

    if (commit.type === 'feat' || commit.type === 'style') {
      buckets.whatYoullSee.push(bullet);
    } else if (commit.type === 'fix' || commit.type === 'perf') {
      buckets.whatWeFixed.push(bullet);
    } else {
      buckets.worthALook.push(bullet);
    }
  }

  if (
    buckets.whatYoullSee.length === 0
    && buckets.whatWeFixed.length === 0
    && buckets.worthALook.length === 0
  ) {
    buckets.whatWeFixed.push('Behind-the-scenes reliability work for the beta channel. Nothing obvious to demo this time.');
  }

  return {
    whatYoullSee: capBucketLines(buckets.whatYoullSee),
    whatWeFixed: capBucketLines(buckets.whatWeFixed),
    worthALook: capBucketLines(buckets.worthALook),
  };
}

function renderBucketSection(title: string, bullets: string[]): string[] {
  if (bullets.length === 0) {
    return [];
  }
  return [
    `### ${title}`,
    ...bullets.map((bullet) => `- ${bullet}`),
    '',
  ];
}

function buildConsolidatedMarkerDisclosure(count: number): string {
  if (count === 1) {
    return "Catches up on 1 earlier beta release whose summary didn't make it out.";
  }
  return `Catches up on ${count} earlier beta releases whose summaries didn't make it out.`;
}

function renderMarkdown(
  metadata: SummaryMetadata,
  buckets: RenderBuckets,
  quietMessage: string | null,
): string {
  const lines: string[] = [];
  lines.push(`## ${metadata.generatedAtIso.slice(0, 10)} — beta v${metadata.betaVersion} ([${metadata.releaseShaShort}](${metadata.workflowRunUrl}))`);
  lines.push(`<!-- beta-summary-key: ${metadata.idempotencyKey} -->`);

  if (metadata.isBackfill) {
    lines.push('<!-- backfill: true -->');
  }
  lines.push('');

  if (metadata.isBackfill) {
    lines.push(`_First generated beta summary — covering the last ${metadata.fallbackDays} days. Future betas will be incremental._`);
    lines.push('');
  } else if (metadata.consolidatedMarkerCount > 0) {
    lines.push(`_${buildConsolidatedMarkerDisclosure(metadata.consolidatedMarkerCount)}_`);
    lines.push('');
  }

  if (quietMessage) {
    lines.push(`_${quietMessage}_`);
    lines.push('');
  } else {
    lines.push(...renderBucketSection(SECTION_UI_CHANGES, buckets.whatYoullSee));
    lines.push(...renderBucketSection(SECTION_DEMO_SUPPORT, buckets.whatWeFixed));
    lines.push(...renderBucketSection(SECTION_OTHER_FIXES, buckets.worthALook));
  }

  lines.push(`_AI-generated — ping us if it's off. [Workflow run](${metadata.workflowRunUrl})._`);

  if (metadata.generationMode === 'raw_fallback') {
    lines.push('');
    lines.push('_Automatic writer fell back to a conservative user-facing summary; workflow logs have the technical detail._');
  }

  return lines.join('\n').trim();
}

function chunkSlackBullets(title: string, bullets: string[]): SlackSectionBlock[] {
  if (bullets.length === 0) {
    return [];
  }
  const blocks: SlackSectionBlock[] = [];
  let currentChunk: string[] = [];

  const flush = (chunkIndex: number): void => {
    if (currentChunk.length === 0) {
      return;
    }
    const header = chunkIndex === 0 ? `*${title}*` : `*${title} (cont.)*`;
    const text = `${header}\n${currentChunk.map((line) => `- ${line}`).join('\n')}`;
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text,
      },
    });
    currentChunk = [];
  };

  let chunkIndex = 0;
  for (const bullet of bullets) {
    const candidate = [...currentChunk, bullet];
    const header = chunkIndex === 0 ? `*${title}*` : `*${title} (cont.)*`;
    const candidateText = `${header}\n${candidate.map((line) => `- ${line}`).join('\n')}`;
    if (candidateText.length > MAX_SLACK_SECTION_CHARS && currentChunk.length > 0) {
      flush(chunkIndex);
      chunkIndex += 1;
    }
    currentChunk.push(bullet);
  }
  flush(chunkIndex);
  return blocks;
}

function renderSlackPayload(
  metadata: SummaryMetadata,
  buckets: RenderBuckets,
  quietMessage: string | null,
): SlackWebhookPayload {
  const headerText = metadata.isBackfill
    ? 'First beta summary — backfill'
    : `Beta v${metadata.betaVersion} is out`;

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: headerText,
        emoji: true,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'AI-generated — ping us if it\'s off.',
        },
      ],
    },
  ];

  if (metadata.isBackfill) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `First generated beta summary — covering the last ${metadata.fallbackDays} days.`,
        },
      ],
    });
  } else if (metadata.consolidatedMarkerCount > 0) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: buildConsolidatedMarkerDisclosure(metadata.consolidatedMarkerCount),
        },
      ],
    });
  }

  if (quietMessage) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: quietMessage,
      },
    });
  } else {
    blocks.push(...chunkSlackBullets(SECTION_UI_CHANGES, buckets.whatYoullSee));
    blocks.push(...chunkSlackBullets(SECTION_DEMO_SUPPORT, buckets.whatWeFixed));
    blocks.push(...chunkSlackBullets(SECTION_OTHER_FIXES, buckets.worthALook));
  }

  if (metadata.generationMode === 'raw_fallback') {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Automatic writer fell back to a conservative user-facing summary; workflow logs have the technical detail.',
        },
      ],
    });
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Workflow run',
          emoji: true,
        },
        url: metadata.workflowRunUrl,
      },
    ],
  });

  const textLines: string[] = [headerText];
  if (quietMessage) {
    textLines.push(quietMessage);
  } else {
    if (buckets.whatYoullSee.length > 0) {
      textLines.push(`${SECTION_UI_CHANGES}: ${buckets.whatYoullSee.join(' | ')}`);
    }
    if (buckets.whatWeFixed.length > 0) {
      textLines.push(`${SECTION_DEMO_SUPPORT}: ${buckets.whatWeFixed.join(' | ')}`);
    }
    if (buckets.worthALook.length > 0) {
      textLines.push(`${SECTION_OTHER_FIXES}: ${buckets.worthALook.join(' | ')}`);
    }
  }
  textLines.push(`Workflow run: ${metadata.workflowRunUrl}`);

  return {
    text: textLines.join('\n'),
    username: process.env.INTERNAL_CHANGELOG_SLACK_USERNAME ?? 'Rebel Releases',
    icon_emoji: process.env.INTERNAL_CHANGELOG_SLACK_ICON_EMOJI ?? ':ship:',
    blocks,
  };
}

async function postSlackPayload(
  payload: SlackWebhookPayload,
  options?: { lenient: boolean },
): Promise<boolean> {
  const webhook = process.env.SLACK_WEBHOOK_URL_GENERAL;
  if (!webhook) {
    logWarn('SLACK_WEBHOOK_URL_GENERAL not set. Skipping Slack post.');
    return true;
  }

  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt < 3) {
    attempt += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.ok) {
        logInfo(`Slack post succeeded (attempt ${attempt}).`);
        return true;
      }

      const body = (await response.text()).slice(0, 500);
      const shouldRetry = response.status >= 500 && attempt < 3;
      const error = new Error(`Slack webhook error ${response.status}: ${body}`);
      if (!shouldRetry) {
        throw error;
      }

      logWarn(`Slack post failed with ${response.status}; retrying (attempt ${attempt}/3).`);
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const timedOut = /abort/i.test(errorMessage);
      lastError = new Error(
        timedOut
          ? `Slack webhook request timed out after 10 seconds (attempt ${attempt}).`
          : errorMessage,
      );
      if (attempt >= 3) {
        break;
      }
      logWarn(`Slack post attempt ${attempt} failed: ${lastError.message}. Retrying.`);
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    } finally {
      clearTimeout(timeout);
    }
  }

  const finalError = lastError ?? new Error('Slack post failed with unknown error.');
  if (options?.lenient) {
    logError(`Slack post failed (lenient mode): ${finalError.message}`);
    return false;
  }
  throw finalError;
}

function removeExistingSectionBySha(content: string, releaseShaShort: string): string {
  const markerRegex = new RegExp(`<!-- beta-summary-key:\\s*${escapeRegExp(releaseShaShort)}-[^>]*-->`);
  const markerMatch = markerRegex.exec(content);
  if (!markerMatch || markerMatch.index < 0) {
    return content;
  }

  const beforeMarker = content.slice(0, markerMatch.index);
  const sectionStart = Math.max(
    beforeMarker.lastIndexOf('\n## ') + 1,
    beforeMarker.startsWith('## ') ? 0 : -1,
  );
  const startIndex = sectionStart >= 0 ? sectionStart : markerMatch.index;

  const nextSectionIndex = content.indexOf('\n## ', markerMatch.index);
  const endIndex = nextSectionIndex >= 0 ? nextSectionIndex + 1 : content.length;

  const updated = `${content.slice(0, startIndex)}${content.slice(endIndex)}`;
  return updated.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function prependUnderLatestAnchor(content: string, markdownBlock: string): string {
  const latestAnchor = '## Latest';
  const index = content.indexOf(latestAnchor);
  if (index < 0) {
    return `${content.trimEnd()}\n\n${latestAnchor}\n\n${markdownBlock.trim()}\n`;
  }

  const afterAnchorIndex = index + latestAnchor.length;
  const before = content.slice(0, afterAnchorIndex).trimEnd();
  const after = content.slice(afterAnchorIndex).trimStart();
  const pieces = [before, '', markdownBlock.trim(), ''];
  if (after) {
    pieces.push(after);
  }
  return `${pieces.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

async function writeStepSummary(bundle: SummaryBundle): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }

  const lines: string[] = [];
  if (bundle.kind === 'skipped') {
    lines.push(`### Internal beta summary skipped`);
    lines.push(`Reason: ${bundle.skipReason}`);
    lines.push(`Release: ${bundle.metadata.releaseShaShort}`);
  } else {
    lines.push('### Internal beta summary');
    lines.push(bundle.markdown);
  }
  lines.push('');

  await fs.appendFile(summaryPath, `${lines.join('\n')}\n`, 'utf8');
}

async function appendFailureToStepSummary(title: string, details: string): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  const lines = [
    `### ${title}`,
    details,
    '',
  ];
  await fs.appendFile(summaryPath, `${lines.join('\n')}\n`, 'utf8');
}

async function writeBundleToDirectory(outputDir: string, bundle: SummaryBundle): Promise<void> {
  const absoluteOutputDir = resolvePathFromRepo(outputDir);
  await fs.mkdir(absoluteOutputDir, { recursive: true });
  await fs.writeFile(path.join(absoluteOutputDir, 'metadata.json'), JSON.stringify({
    metadata: bundle.metadata,
    skipReason: bundle.kind === 'skipped' ? bundle.skipReason : null,
  }, null, 2), 'utf8');

  if (bundle.kind === 'posted') {
    await fs.writeFile(path.join(absoluteOutputDir, 'summary.md'), `${bundle.markdown}\n`, 'utf8');
    await fs.writeFile(path.join(absoluteOutputDir, 'slack.json'), JSON.stringify(bundle.slackPayload, null, 2), 'utf8');
  }
}

async function readBundleFromDirectory(directory: string): Promise<SummaryBundle> {
  const absoluteDir = resolvePathFromRepo(directory);
  const metadataFile = await readJsonFile<{
    metadata: SummaryMetadata;
    skipReason: string | null;
  }>(path.join(absoluteDir, 'metadata.json'));

  const skipReason = metadataFile.skipReason ?? undefined;
  if (skipReason) {
    return {
      kind: 'skipped',
      metadata: metadataFile.metadata,
      skipReason,
    };
  }

  const markdown = await fs.readFile(path.join(absoluteDir, 'summary.md'), 'utf8');
  const slackPayload = await readJsonFile<SlackWebhookPayload>(path.join(absoluteDir, 'slack.json'));
  return {
    kind: 'posted',
    metadata: metadataFile.metadata,
    markdown,
    slackPayload,
  };
}

/**
 * Injectable seams for `commitAndPushSummary` so both the success path and the
 * degraded/failure paths are unit-testable without a real git repo or
 * filesystem (mirrors the `ExpandMarkerRangeDeps` pattern above). Defaults bind
 * to the real implementations.
 */
interface CommitArchiveDeps {
  runGit: (args: string[]) => Promise<string>;
  tryGit: (args: string[]) => Promise<{ ok: true; stdout: string } | { ok: false; error: Error }>;
  readChangelog: () => Promise<string>;
  writeChangelog: (content: string) => Promise<void>;
  emitOutcome: (outcome: ArchiveCommitOutcome) => void;
}

const defaultCommitArchiveDeps: CommitArchiveDeps = {
  runGit: (args) => runGit(args),
  tryGit: (args) => tryGit(args),
  readChangelog: () => readFileIfExists(INTERNAL_CHANGELOG_PATH),
  writeChangelog: (content) => fs.writeFile(INTERNAL_CHANGELOG_PATH, content, 'utf8'),
  emitOutcome: (outcome) => logArchiveCommitOutcome(outcome),
};

/**
 * Append, commit, and push the internal beta summary to `INTERNAL_CHANGELOG.md`
 * on `dev`.
 *
 * Returns a structured {@link ArchiveCommitOutcome} (not a bare boolean) so the
 * archive path is observable and non-silent: callers, the structured
 * `[archive-commit]` log line, and the CI step summary can distinguish "archive
 * advanced" (`committed`) from "archive untouched" (`no-op`) from "commit/push
 * failed" (`commit-failed` / `push-failed`). This matters because
 * the marker walk-back trusts the archived changelog as the last-announced
 * release state; a no-op/failure that masquerades as success makes that state
 * untrustworthy. `outcome.succeeded` preserves the prior boolean contract for
 * callers (lenient push failure → `false`; strict → throw).
 */
async function commitAndPushSummary(
  bundle: SummaryBundle,
  options?: { lenient: boolean; skipGitCommit?: boolean },
  deps: CommitArchiveDeps = defaultCommitArchiveDeps,
): Promise<ArchiveCommitOutcome> {
  const baseOutcome = {
    releaseShaShort: bundle.metadata.releaseShaShort ?? null,
    betaVersion: bundle.metadata.betaVersion ?? null,
  };
  const emit = (outcome: ArchiveCommitOutcome): ArchiveCommitOutcome => {
    deps.emitOutcome(outcome);
    return outcome;
  };

  if (bundle.kind === 'skipped') {
    logInfo(`Skipping commit: ${bundle.skipReason}`);
    return emit({ ...baseOutcome, kind: 'skipped-bundle', succeeded: true, pushAttempts: 0, error: null });
  }

  const current = await deps.readChangelog();
  const withoutExisting = removeExistingSectionBySha(current || '## Latest\n', bundle.metadata.releaseShaShort);
  const nextContent = prependUnderLatestAnchor(withoutExisting || '## Latest\n', bundle.markdown);

  await deps.writeChangelog(nextContent);
  if (options?.skipGitCommit) {
    logInfo('Wrote INTERNAL_CHANGELOG.md and skipped git commit/push (--no-commit).');
    return emit({ ...baseOutcome, kind: 'wrote-no-commit', succeeded: true, pushAttempts: 0, error: null });
  }

  await deps.runGit(['add', '--', INTERNAL_CHANGELOG_RELATIVE_PATH]);
  const stagedFiles = await deps.runGit(['diff', '--cached', '--name-only']);
  if (!stagedFiles.split('\n').map((line) => line.trim()).filter(Boolean).includes(INTERNAL_CHANGELOG_RELATIVE_PATH)) {
    // Observable degraded state: the file write produced no staged change, so the
    // archive — and therefore the last-announced release state — did NOT advance.
    // Previously this returned a silent `true`; it is now an explicit `no-op`
    // outcome (succeeded: false) so it can never masquerade as a clean commit.
    logWarn('No staged changelog change detected; archive did not advance (no-op).');
    return emit({ ...baseOutcome, kind: 'no-op', succeeded: false, pushAttempts: 0, error: null });
  }

  // Terminal-failure handler shared by the commit and push paths: emit the
  // structured outcome (so the failure is observable on every terminal path),
  // then honour the lenient/strict contract — lenient returns succeeded:false,
  // strict re-throws.
  const failTerminal = (
    kind: 'commit-failed' | 'push-failed',
    finalError: Error,
    pushAttempts: number,
  ): ArchiveCommitOutcome => {
    const failureOutcome = emit({
      ...baseOutcome,
      kind,
      succeeded: false,
      pushAttempts,
      error: finalError.message,
    });
    if (options?.lenient) {
      logError(`Archive commit failed (${kind}, lenient mode): ${finalError.message}`);
      return failureOutcome;
    }
    throw finalError;
  };

  const subject = `chore(internal-changelog): beta v${bundle.metadata.betaVersion} summary [skip ci]`;
  const body = [
    'Automated internal beta summary update.',
    'Generated by scripts/post-beta-summary.ts.',
  ].join('\n');

  try {
    await deps.runGit(['commit', '-m', subject, '-m', body]);
  } catch (error) {
    const commitError = error instanceof Error ? error : new Error(String(error));
    // `git commit` failed (e.g. hook rejection, identity not configured); the
    // archive did not advance, so this terminal path must be observable too.
    logError(`git commit for changelog archive failed: ${commitError.message}`);
    return failTerminal('commit-failed', commitError, 0);
  }

  let attempt = 0;
  let lastError: Error | null = null;
  while (attempt < 3) {
    attempt += 1;
    try {
      await deps.runGit(['push', 'origin', 'dev']);
      logInfo(`Pushed changelog commit to origin/dev (attempt ${attempt}).`);
      return emit({ ...baseOutcome, kind: 'committed', succeeded: true, pushAttempts: attempt, error: null });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= 3) {
        break;
      }
      logWarn(`Push attempt ${attempt} failed; running fetch+rebase before retry.`);
      try {
        await deps.runGit(['fetch', 'origin', 'dev']);
        await deps.runGit(['rebase', 'origin/dev']);
      } catch (rebaseError) {
        const rebaseMessage = getErrorMessage(rebaseError);
        lastError = new Error(`Failed to rebase on retry attempt ${attempt}: ${rebaseMessage}`);
        logWarn(lastError.message);
        const abortResult = await deps.tryGit(['rebase', '--abort']);
        if (!abortResult.ok) {
          logWarn(`Best-effort rebase abort failed: ${abortResult.error.message}`);
        }
      }
    }
  }

  const abortResult = await deps.tryGit(['rebase', '--abort']);
  if (!abortResult.ok) {
    logInfo(`No rebase abort needed (or already clean): ${abortResult.error.message}`);
  }

  const finalError = lastError ?? new Error('Push failed with unknown error.');
  return failTerminal('push-failed', finalError, attempt);
}

async function buildSummaryBundle(options: CliOptions): Promise<SummaryBundle> {
  const releaseSha = await resolveReleaseSha();
  const releaseShaShort = toShortSha(releaseSha);
  const betaVersion = await resolveBetaVersion();
  const runId = process.env.GITHUB_RUN_ID ?? 'local-run';
  const runAttempt = process.env.WORKFLOW_RUN_ATTEMPT ?? process.env.GITHUB_RUN_ATTEMPT ?? '1';
  const workflowRunUrl = process.env.WORKFLOW_RUN_URL
    ?? (process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : 'https://github.com/mindstone/rebel-app/actions');

  const metadataBase: Omit<SummaryMetadata, 'generationMode'> = {
    releaseSha,
    releaseShaShort,
    betaVersion,
    workflowRunUrl,
    runId,
    runAttempt,
    isBackfill: false,
    fallbackDays: options.fallbackDays,
    generatedAtIso: new Date().toISOString(),
    idempotencyKey: `${releaseShaShort}-${runId}-${runAttempt}`,
    consolidatedMarkerCount: 0,
  };

  const existingChangelog = await readChangelogForIdempotency();
  if (!options.forceRepost && alreadyPostedForSha(existingChangelog.content, releaseShaShort)) {
    return {
      kind: 'skipped',
      metadata: {
        ...metadataBase,
        generationMode: 'summary',
      },
      skipReason: `already posted for release ${releaseShaShort} (checked ${existingChangelog.source})`,
    };
  }

  let rawCommits: RawCommit[] = [];
  let fixtureInput: FixtureInput | null = null;
  let range: CommitRange = {
    kind: 'backfill',
    releaseSha,
    isBackfill: true,
    fallbackDays: options.fallbackDays,
  };

  if (options.fromFile) {
    fixtureInput = await loadCommitsFromFixture(options.fromFile);
    rawCommits = fixtureInput.commits;
    logInfo(`Loaded ${rawCommits.length} commits from fixture ${options.fromFile}.`);
  } else {
    range = await resolveCommitRange(releaseSha, options);
    rawCommits = await loadCommitsFromGit(range);
    logInfo(`Loaded ${rawCommits.length} commits from git history.`);
  }

  let visibleCommits = filterVisibleCommits(rawCommits);
  let consolidatedMarkerCount = 0;

  if (
    !options.fromFile
    && range.kind === 'marker'
    && !range.isBackfill
    && visibleCommits.length === 0
  ) {
    const previousStartRef = range.startRef;
    const lastAnnouncedShaPrefix = findLastAnnouncedReleaseShaPrefix(existingChangelog.content) ?? undefined;
    const expansion = await expandMarkerRangeUntilVisible(
      range,
      rawCommits,
      visibleCommits,
      options.fallbackDays,
      {
        getLatestMarker: getLatestDeployBetaMarker,
        loadCommits: loadCommitsFromGit,
        filterVisible: filterVisibleCommits,
        getCommitTimestamp,
        lastAnnouncedShaPrefix,
      },
    );
    if (expansion.hopsWalked > 0 && expansion.visibleCommits.length > 0) {
      range = expansion.range;
      rawCommits = expansion.rawCommits;
      visibleCommits = expansion.visibleCommits;
      consolidatedMarkerCount = expansion.hopsWalked;
      const oldStartShort = previousStartRef ? toShortSha(previousStartRef) : '(unknown)';
      const newStartShort = expansion.range.startRef ? toShortSha(expansion.range.startRef) : '(unknown)';
      logInfo(
        `Widened marker range ${expansion.hopsWalked} marker(s) back to recover user-visible work `
        + `(${oldStartShort} → ${newStartShort}; cumulative range ${newStartShort}..${releaseShaShort}).`,
      );
    } else if (expansion.hopsWalked > 0) {
      // Walked, but never recovered visible work. Keep `consolidatedMarkerCount`
      // at 0 so the Quiet path renders cleanly without a contradictory rollup
      // disclosure; just record what happened in the logs.
      logInfo(
        `Walked back ${expansion.hopsWalked} marker(s) without finding user-visible work; rendering Quiet beta.`,
      );
    }
  }

  const submoduleAdvances = fixtureInput
    ? fixtureInput.submoduleAdvances
    : await detectSubmoduleAdvances(range);

  let generationMode: GenerationMode = 'summary';
  let buckets: RenderBuckets = {
    whatYoullSee: [],
    whatWeFixed: [],
    worthALook: [],
  };
  let quietMessage: string | null = null;
  let fallbackReason: string | null = null;

  if (visibleCommits.length === 0) {
    generationMode = 'quiet';
    quietMessage = 'Quiet beta — internal plumbing only. Nothing user-visible this round.';
  } else {
    try {
      buckets = await generateBucketsWithLlm(visibleCommits, submoduleAdvances, {
        ...metadataBase,
        generationMode: 'summary',
      }, fixtureInput?.mockedLlmCompletion);
      buckets = {
        whatYoullSee: capBucketLines(buckets.whatYoullSee),
        whatWeFixed: capBucketLines(buckets.whatWeFixed),
        worthALook: capBucketLines(buckets.worthALook),
      };
    } catch (error) {
      generationMode = 'raw_fallback';
      fallbackReason = error instanceof Error ? error.message : String(error);
      logWarn(`LLM summary unavailable after ${MAX_LLM_ATTEMPTS} attempt(s); suppressing the post rather than sending a degraded commit-dump: ${fallbackReason}`);
    }
  }

  const metadata: SummaryMetadata = {
    ...metadataBase,
    generationMode,
    isBackfill: options.fromFile ? false : range.isBackfill,
    fallbackDays: options.fallbackDays,
    consolidatedMarkerCount,
  };

  // Policy: a degraded (commit-dump) summary must never reach the channel. If
  // the AI writer could not produce a usable summary, we skip posting (and
  // archiving) entirely rather than broadcasting raw commit text to a
  // non-technical audience. The skip is observable: it is logged here, recorded
  // in metadata.json, and surfaced in the CI step summary via writeStepSummary.
  if (generationMode === 'raw_fallback') {
    return {
      kind: 'skipped',
      metadata,
      skipReason: `summary generation failed after ${MAX_LLM_ATTEMPTS} attempt(s); not posting a degraded summary (${fallbackReason ?? 'unknown error'})`,
    };
  }

  const markdown = renderMarkdown(metadata, buckets, quietMessage);
  const slackPayload = renderSlackPayload(metadata, buckets, quietMessage);

  return {
    kind: 'posted',
    metadata,
    markdown,
    slackPayload,
  };
}

async function runPostFrom(directory: string): Promise<void> {
  const bundle = await readBundleFromDirectory(directory);
  if (bundle.kind === 'skipped') {
    logInfo(`Skipping Slack post: ${bundle.skipReason}`);
    return;
  }
  const posted = await postSlackPayload(bundle.slackPayload, { lenient: true });
  if (!posted) {
    await appendFailureToStepSummary(
      'Internal beta summary Slack post failed',
      'Slack post failed during `--post-from`; markdown commit step can still run.',
    );
  }
}

async function runCommitFrom(directory: string): Promise<void> {
  const bundle = await readBundleFromDirectory(directory);
  if (bundle.kind === 'skipped') {
    logInfo(`Skipping commit: ${bundle.skipReason}`);
    return;
  }
  const outcome = await commitAndPushSummary(bundle, { lenient: true, skipGitCommit: false });
  if (!outcome.succeeded) {
    await appendFailureToStepSummary(
      'Internal beta summary commit did not advance the archive',
      `Archive commit outcome: ${outcome.kind}${outcome.error ? ` — ${outcome.error}` : ''}. `
        + 'Slack post may still have succeeded, but the last-announced release state was not updated.',
    );
  }
}

async function runFullOrEmit(options: CliOptions): Promise<void> {
  const bundle = await buildSummaryBundle(options);
  await writeStepSummary(bundle);

  if (options.mode === 'emit-only') {
    if (!options.outputDir) {
      throw new Error('Missing --output-dir for --emit-only mode.');
    }
    await writeBundleToDirectory(options.outputDir, bundle);
    logInfo(`Emitted artifacts to ${resolvePathFromRepo(options.outputDir)}.`);
    return;
  }

  if (bundle.kind === 'skipped') {
    logInfo(bundle.skipReason);
    return;
  }

  if (options.dryRun) {
    console.log('--- Rendered Markdown ---');
    console.log(bundle.markdown);
    console.log('--- Slack Payload ---');
    console.log(JSON.stringify(bundle.slackPayload, null, 2));
    return;
  }

  try {
    await postSlackPayload(bundle.slackPayload, { lenient: false });
  } catch (error) {
    const message = getErrorMessage(error);
    logError(`Slack post failed (continuing to markdown commit): ${message}`);
    await appendFailureToStepSummary(
      'Internal beta summary Slack post failed',
      `Slack post failed before commit step: ${message}`,
    );
  }

  try {
    const outcome = await commitAndPushSummary(bundle, {
      lenient: false,
      skipGitCommit: options.noCommit,
    });
    if (!outcome.succeeded) {
      // A no-op (file write produced no staged change) does not throw, but the
      // archive — and the last-announced release state — did not advance, so it
      // must remain observable rather than passing silently.
      await appendFailureToStepSummary(
        'Internal beta summary commit did not advance the archive',
        `Archive commit outcome: ${outcome.kind}${outcome.error ? ` — ${outcome.error}` : ''}. `
          + 'The last-announced release state was not updated.',
      );
    }
  } catch (error) {
    const message = getErrorMessage(error);
    await appendFailureToStepSummary(
      'Internal beta summary commit failed',
      `Commit/push failed in full mode: ${message}`,
    );
    throw error;
  }
}

async function main(): Promise<void> {
  const parsedOptions = parseCliArgs(process.argv.slice(2));
  const isCi = isCiEnvironment();
  const localSafetyDryRun =
    parsedOptions.mode === 'full'
    && !isCi
    && !parsedOptions.dryRun
    && !parsedOptions.noCommit;

  const options: CliOptions = localSafetyDryRun
    ? { ...parsedOptions, dryRun: true }
    : parsedOptions;

  if (localSafetyDryRun) {
    console.error('Local default is --dry-run for safety. Use --no-commit to post Slack and write the markdown file locally without committing or pushing, or set CI=1 to simulate CI mode.');
  }

  if (options.mode === 'post-from') {
    if (!options.outputDir) {
      logError('--post-from requires a directory path.');
      return;
    }
    try {
      await runPostFrom(options.outputDir);
    } catch (error) {
      const message = getErrorMessage(error);
      logError(`--post-from failure (forced exit 0): ${message}`);
      await appendFailureToStepSummary(
        'Internal beta summary Slack post failed',
        `Post-from mode failed (exit 0): ${message}`,
      );
    }
    return;
  }

  if (options.mode === 'commit-from') {
    if (!options.outputDir) {
      logError('--commit-from requires a directory path.');
      return;
    }
    try {
      await runCommitFrom(options.outputDir);
    } catch (error) {
      const message = getErrorMessage(error);
      logError(`--commit-from failure (forced exit 0): ${message}`);
      await appendFailureToStepSummary(
        'Internal beta summary commit failed',
        `Commit-from mode failed (exit 0): ${message}`,
      );
    }
    return;
  }

  await runFullOrEmit(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logError(message);
    process.exit(1);
  });
}

export {
  BANNED_BULLET_PATTERNS,
  buildLlmSystemPrompt,
  buildRawFallbackBuckets,
  commitAndPushSummary,
  expandMarkerRangeUntilVisible,
  filterVisibleCommits,
  findBannedBulletContent,
  findLastAnnouncedReleaseShaPrefix,
  generateBucketsWithLlm,
  parseLlmResponse,
  parseLlmResponseDetailed,
  renderMarkdown,
  renderSlackPayload,
};

export type {
  ArchiveCommitOutcome,
  ArchiveCommitOutcomeKind,
  CommitArchiveDeps,
  CommitInput,
  CommitRange,
  ExpandMarkerRangeDeps,
  ExpandMarkerRangeResult,
  RawCommit,
  SummaryMetadata,
};
