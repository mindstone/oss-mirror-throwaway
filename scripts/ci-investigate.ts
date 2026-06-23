#!/usr/bin/env npx tsx

import { Cli, Command, Option, UsageError } from 'clipanion';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_LINES = 800;
const DEFAULT_MAX_BYTES = 400 * 1024;
const GH_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const UNKNOWN_EXCERPT_LINES = 80;
const UNKNOWN_EXCERPT_BYTES = 32 * 1024;
const GH_MIN_VERSION = { major: 2, minor: 50 };
const RETRY_DELAY_MS = 5000;
const GENERIC_VALIDATE_FAST_ID = 'validate-fast-generic';

export interface ReproCommand {
  command: string;
  cwd?: string;
  description?: string;
}

export interface SignatureEntry {
  id: string;
  displayName: string;
  regex: RegExp;
  jobNamePattern?: RegExp;
  repro: ReproCommand;
  lens: string;
  signpost?: string;
}

export interface Match {
  id: string;
  displayName: string;
  repro: ReproCommand;
  lens: string;
  signpost?: string;
  evidenceLine?: string;
  jobName?: string;
}

export interface MatchResult extends Match {
  regexSourceLength: number;
}

export interface JobBlock {
  jobName: string;
  text: string;
  lines: string[];
}

export type DiagnosisPacket =
  | {
      status: 'classified';
      runId: string;
      workflowName: string;
      failedJobs: string[];
      matches: Match[];
      logPath?: string;
      truncated: boolean;
    }
  | {
      status: 'unknown';
      runId: string;
      workflowName: string;
      failedJobs: string[];
      logPath?: string;
      truncated: boolean;
      logExcerptTail: string;
      tentativeRepro?: {
        command: string;
        description: string;
      };
    }
  | {
      status: 'no_failure';
      runId: string;
      workflowName: string;
      conclusion: 'success' | 'skipped' | string;
    }
  | {
      status: 'in_progress';
      runId: string;
      workflowName: string;
      runStatus: 'in_progress' | 'queued' | string;
    }
  | {
      status: 'hard_error';
      reason: string;
      remediation: string;
    };

export const EXIT_CODE_BY_STATUS: Record<DiagnosisPacket['status'], number> = {
  classified: 0,
  unknown: 2,
  no_failure: 0,
  in_progress: 0,
  hard_error: 1,
};

export interface GhCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

export interface RunViewStreamingOptions {
  outputPath: string;
  maxTailLines: number;
  maxTailBytes: number;
}

export interface RunViewStreamingResult {
  status: number | null;
  stderr: string;
  logExcerptTail: string;
  truncated: boolean;
}

export interface GhRunner {
  version(): GhCommandResult;
  authStatus(): GhCommandResult;
  runList(args: string[]): GhCommandResult;
  runView(args: string[]): GhCommandResult;
  runViewStreaming(args: string[], options: RunViewStreamingOptions): Promise<RunViewStreamingResult>;
}

export interface FsLike {
  existsSync(targetPath: string): boolean;
  mkdirSync(targetPath: string, options: { recursive: true }): void;
  renameSync(fromPath: string, toPath: string): void;
  unlinkSync(targetPath: string): void;
}

export interface RunMeta {
  runId: string;
  workflowName: string;
  conclusion: string | null;
  status: string | null;
  attempt: number | null;
  headSha?: string | null;
}

export interface BuildDiagnosisPacketInput {
  runMeta: RunMeta;
  matches: MatchResult[];
  failedJobs: string[];
  logPath?: string;
  truncated: boolean;
  logExcerptTail: string;
}

export interface InvestigateOptions {
  branch?: string;
  runId?: string;
  fromFile?: string;
  dryRun?: boolean;
  json?: boolean;
  noFetch?: boolean;
  limit?: number;
}

export interface InvestigateDeps {
  runner?: GhRunner;
  fsLike?: FsLike;
  cwd?: string;
  repoRoot?: string;
  catalog?: SignatureEntry[];
  maxLines?: number;
  maxBytes?: number;
}

export interface InvestigateResult {
  packet: DiagnosisPacket;
  exitCode: number;
  output: string;
}

interface RawRunSummary {
  databaseId?: number | string;
  workflowName?: string | null;
  name?: string | null;
  conclusion?: string | null;
  status?: string | null;
  attempt?: number | string | null;
  headSha?: string | null;
}

interface PreparedCatalogEntry {
  entry: SignatureEntry;
  regex: RegExp;
  jobNamePattern?: RegExp;
}

interface LogScanResult {
  matches: MatchResult[];
  failedJobs: string[];
  logExcerptTail: string;
  truncated: boolean;
}

const NODE_FS: FsLike = {
  existsSync: fs.existsSync,
  mkdirSync: (targetPath, options) => {
    fs.mkdirSync(targetPath, options);
  },
  renameSync: (fromPath, toPath) => {
    fs.renameSync(fromPath, toPath);
  },
  unlinkSync: (targetPath) => {
    fs.unlinkSync(targetPath);
  },
};

export const CATALOG: SignatureEntry[] = [
  {
    id: 'knip-health-unused-file',
    displayName: 'Knip — unused files',
    regex: /✘ Found \d+ unused file\(s\):/,
    repro: {
      command: 'npm run validate:knip-health',
    },
    lens: 'none (mechanical)',
    signpost: 'docs/project/CODE_HEALTH_TOOLS.md',
  },
  {
    id: 'knip-health-unused-dependency',
    displayName: 'Knip — unused dependencies',
    regex: /✘ Found \d+ unused dependenc(?:y|ies|\(y\/ies\)):/,
    repro: {
      command: 'npm run validate:knip-health',
      description:
        'Knip found dependencies declared in package.json that are no longer used. This is a code-health signal, not a flaky test; remove the dependency or add the missing entry point only if the usage is intentionally dynamic.',
    },
    lens: 'none (mechanical)',
    signpost: 'docs/project/CODE_HEALTH_TOOLS.md',
  },
  {
    id: 'cross-surface-parity-baseline-drift',
    displayName: 'Cross-surface parity baseline drift',
    regex: /Baseline drift: a new escape-hatch was added without updating the Stage 5 baseline\./,
    repro: {
      command: 'npm run validate:cross-surface-parity-gap',
      description:
        'A new desktop-only or cross-surface escape hatch was detected. This is usually a meaningful architecture signal: either remove the escape hatch or update the Stage 5 baseline with a documented trap-catalogue justification.',
    },
    lens: 'Cross-surface parity',
    signpost: 'docs/project/CROSS_SURFACE_PARITY_TRAP_CATALOGUE.md',
  },
  {
    id: 'eslint-new-warnings-regression',
    displayName: 'ESLint new-warning regression',
    regex: /ESLint warning regression: [^\n]+ \(baseline: \d+, current: \d+\)/,
    jobNamePattern: /eslint-new-warnings|validate-and-test/i,
    repro: {
      command: 'npm run validate:eslint-new-warnings',
      description:
        'The diff-scoped ESLint warning gate found a warning regression. Treat silent-swallow and runtime-safety warnings as meaningful unless the evidence points to warning-signature churn; if so, fix the classifier/baseline rather than weakening the rule.',
    },
    lens: 'Runtime Safety',
  },
  {
    id: 'circular-deps',
    displayName: 'Circular dependencies',
    regex: /✘ (?:Renderer|Main) has \d+ circular dependencies/,
    repro: {
      command: 'npm run validate:circular-deps',
    },
    lens: 'Architecture',
  },
  {
    id: 'mcp-lockfile-drift',
    displayName: 'MCP lockfile drift',
    regex: /❌ \d+ package\(s\) missing package-lock\.json:/,
    repro: {
      command: 'npx tsx scripts/check-mcp-lockfiles.ts',
    },
    lens: 'MCP',
  },
  {
    id: 'ipc-contract-drift',
    displayName: 'IPC contract drift',
    regex: /❌\s+Validation failed with errors|❌\s+Duplicate channels found|❌\s+.*Missing request or response schema\b/,
    repro: {
      command: 'npm run validate:ipc',
    },
    lens: 'Cross-process Contract',
  },
  {
    id: 'ts-ratchet-regression',
    displayName: 'TypeScript ratchet regression',
    regex: /✘ [^:\n]+: \d+ errors \(baseline: \d+\) — new errors introduced/,
    repro: {
      command: 'npm run validate:ts-ratchet',
    },
    lens: 'Approach Assessment',
  },
  {
    id: 'react-hooks-exhaustive-deps',
    displayName: 'React Hooks exhaustive deps',
    regex: /\b(?:warning|error)\s+.*react-hooks\/exhaustive-deps\b/,
    repro: {
      command: 'npm run lint',
    },
    lens: 'none (mechanical)',
  },
  {
    id: 'store-version-mismatch',
    displayName: 'Store version registry mismatch',
    regex: /FAILED: Store version registry is incomplete or has mismatches\./,
    repro: {
      command: 'npm run validate:store-versions',
    },
    lens: 'Migration Safety',
  },
  {
    id: 'submodule-pointer-not-pushed',
    displayName: 'Submodule pointer not pushed',
    regex: /Fetched in submodule path '[^']+', but it did not contain [0-9a-f]{40}\. Direct fetching of that commit failed\./,
    repro: {
      command: 'git submodule status',
      description:
        'Superproject references an unpushed submodule SHA. Ensure the submodule is pushed BEFORE the superproject. The /git-safe-sync-and-push slash command handles ordering automatically (--recurse-submodules=on-demand).',
    },
    lens: 'Operational',
    signpost: '.factory/commands/git-safe-sync-and-push.md',
  },
  {
    id: 'rebel-system-token-missing',
    displayName: 'REBEL_SYSTEM_TOKEN secret missing',
    regex: /REBEL_SYSTEM_TOKEN secret is empty or not set/,
    repro: {
      command: 'gh secret list',
      description:
        'CI cannot fetch the rebel-system submodule without REBEL_SYSTEM_TOKEN. Set it in GitHub repo Settings → Secrets and variables → Actions. This is an environment / repo-config issue, not a code bug.',
    },
    lens: 'Operational',
  },
  {
    id: 'metro-unable-to-resolve-module',
    displayName: 'Metro could not resolve module (mobile bundle)',
    regex: /Unable to resolve module \S+ from .+: \S+ could not be found within the project/,
    repro: {
      command: 'cd mobile && npx expo start --clear',
      description:
        'React Native Metro bundler cannot resolve a module imported in a path it tries to bundle. Typical cause: a Node-only dep (pino, fs, path, electron, electron-store) imported through a code path that runs on mobile. Fix: gate the import behind a boundary interface in src/core/ (PlatformConfig, StoreFactory, ErrorReporter, Logger). See docs/project/CROSS_SURFACE_PARITY_CHECKLIST.md.',
    },
    lens: 'Cross-surface parity',
    signpost: 'docs/project/CROSS_SURFACE_PARITY_CHECKLIST.md',
  },
  {
    id: 'cloud-rollup-unresolved-import',
    displayName: 'Cloud Vite/Rollup unresolved import',
    regex: /\[vite\]: Rollup failed to resolve import "[^"]+" from "[^"]+"/,
    repro: {
      command: 'npm run verify:cloud-docker',
      description:
        'Cloud Docker build failed because Vite/Rollup could not resolve an import in cloud-client or cloud-service. Typical cause: a dependency present in the desktop bundle but not declared in cloud-client/package.json or cloud-service/package.json, or an import that crosses a surface boundary unsafely. Run verify:cloud-docker locally to reproduce.',
    },
    lens: 'Cross-surface parity',
  },
  {
    id: 'vitest-snapshot-mismatch',
    displayName: 'Vitest snapshot mismatch',
    regex: /\bError: Snapshot `[^`]+` mismatched\b/,
    repro: {
      command: 'npx vitest run',
      description:
        'A toMatchSnapshot assertion saw different output than the committed .snap file. Most snapshot mismatches in CI but not locally are PORTABILITY bugs: machine-specific data (absolute paths, timestamps, hostnames, OS-specific separators, locale-formatted dates) leaked into the snapshot. Fix the test to normalize before snapshotting (path.relative against repoRoot, redact dates, etc.), THEN run `npx vitest run -u <test-file>` to regenerate. Only blindly run -u if the change is a real, intentional output update — otherwise you ratchet a host-specific snapshot.',
    },
    lens: 'Testability',
  },
  {
    id: 'eval-migration-lock-temp-cleanup',
    displayName: 'Eval migration-lock temp cleanup failure',
    regex: /ENOTEMPTY: directory not empty, rmdir ['"][^'"]*migration-lock-[^'"]*['"]/,
    repro: {
      command: 'npx vitest run --project=evals evals/__tests__/migration-lock.test.ts',
      description:
        'The migration-lock test left heartbeat/temp files behind while the temp directory was being removed. This is a flaky-suspect test-hygiene signal; check teardown ordering, heartbeat shutdown, and recursive cleanup before treating it as product behavior.',
    },
    lens: 'Testability',
  },
  {
    id: 'release-e2e-harness-cascade',
    displayName: 'Release E2E harness startup/teardown cascade',
    regex:
      /SAFETY ABORT: startup probe failed \(startup-probe-timeout\)|App close timed out or failed: Error: App close timeout/,
    jobNamePattern: /E2E Tests|test-e2e/i,
    repro: {
      command: 'npm run package && npm run test:e2e',
      description:
        'The release E2E job failed in startup or teardown plumbing. This is often a harness cascade: read the E2E STOP-gate docs before changing specs, and isolate app startup/local-cloud/close health before debugging downstream UI assertions.',
    },
    lens: 'Testability / E2E',
    signpost: 'docs/project/E2E_TEST_FIXING_GUIDELINES.md',
  },
  {
    id: 'e2e-ipc-payload-size-guard',
    displayName: 'E2E IPC payload size guard',
    regex: /IPC channels with payloads >\d+KB:/,
    jobNamePattern: /E2E Tests|test-e2e/i,
    repro: {
      command: 'npm run test:e2e:perf',
      description:
        'The performance E2E payload guard found an IPC payload above the configured threshold. Unlike broad E2E cascades, this is a specific performance signal; inspect the listed channel and reduce payload shape or paging behavior.',
    },
    lens: 'Performance',
  },
  {
    id: 'mobile-testflight-eas-submit-failure',
    displayName: 'Mobile TestFlight EAS submit failure',
    regex: /\tSubmit to TestFlight\t.*##\[error\]Process completed with exit code 1\./,
    jobNamePattern: /Build & Submit iOS to TestFlight|build-ios/i,
    repro: {
      command: 'cd mobile && eas submit --platform ios --profile production --latest --non-interactive',
      description:
        'The iOS build reached the TestFlight submit step and failed there. This is a deploy/credentials/App Store Connect operational signal, not evidence that the app failed to compile. Capture raw EAS submit output before changing app code.',
    },
    lens: 'Operational',
    signpost: 'docs/project/CI_PIPELINE.md',
  },
  {
    id: 'dependabot-private-submodule-access',
    displayName: 'Dependabot private submodule access failure',
    regex:
      /Failed to request additional scope: 403 Either the repo doesn't exist, or Dependabot doesn't have access to it|Cloning of submodule failed: .*git@github\.com:mindstone\/[^ ]+\.git/,
    jobNamePattern: /dependabot/i,
    repro: {
      command: 'gh secret list --app dependabot',
      description:
        'Dependabot failed while accessing private submodules or their credentials. This is an operational/configuration failure outside app-code validation; grant appropriate access, adjust submodule checkout for Dependabot, or exclude the affected update group.',
    },
    lens: 'Operational',
    signpost: '.github/dependabot.yml',
  },
  {
    id: 'eval-planner-fixture-failure',
    displayName: 'Eval planner fixture failure',
    regex: /\bFAIL \d{2}_[a-z0-9_]+\b/,
    jobNamePattern: /rebel-core-planner|Eval — rebel-core-planner/i,
    repro: {
      command: 'npm run eval:rebel-core-planner',
      description:
        'The schema-boundary planner eval failed one or more named fixtures. If different fixtures fail across retry attempts, treat it as a borderline or stochastic eval signal; inspect artifacts before changing prompts or thresholds.',
    },
    lens: 'Eval Quality',
    signpost: 'docs/project/WRITING_EVALS.md',
  },
  {
    id: 'validate-fast-generic',
    displayName: 'validate:fast generic failure',
    regex: /##\[error\]Process completed with exit code 1\./,
    jobNamePattern: /validate-and-test/i,
    repro: {
      command: 'npm run validate:fast',
    },
    lens: 'unknown — see classified-list expansion follow-up',
  },
];

class SlidingTailBuffer {
  private readonly lines: string[] = [];
  private readonly lineBytes: number[] = [];
  private currentBytes = 0;
  private carry = '';
  private dropped = false;

  constructor(
    private readonly maxLines: number,
    private readonly maxBytes: number,
  ) {}

  pushChunk(chunk: Buffer | string): void {
    const chunkText = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const combined = this.carry + chunkText;
    const parts = combined.split('\n');
    this.carry = parts.pop() ?? '';
    for (const rawLine of parts) {
      this.addLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
    }
  }

  addLine(line: string): void {
    let normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    let withNewlineBytes = Buffer.byteLength(normalized, 'utf8') + 1;

    if (withNewlineBytes > this.maxBytes) {
      const buffer = Buffer.from(normalized, 'utf8');
      const maxSlice = Math.max(this.maxBytes - 1, 1);
      normalized = buffer.subarray(Math.max(0, buffer.length - maxSlice)).toString('utf8');
      withNewlineBytes = Buffer.byteLength(normalized, 'utf8') + 1;
      this.lines.length = 0;
      this.lineBytes.length = 0;
      this.currentBytes = 0;
      this.dropped = true;
    }

    this.lines.push(normalized);
    this.lineBytes.push(withNewlineBytes);
    this.currentBytes += withNewlineBytes;
    this.prune();
  }

  finish(): { text: string; truncated: boolean } {
    if (this.carry.length > 0) {
      this.addLine(this.carry);
      this.carry = '';
    }
    return {
      text: this.lines.join('\n'),
      truncated: this.dropped,
    };
  }

  private prune(): void {
    while (this.lines.length > this.maxLines) {
      const removed = this.lineBytes.shift() ?? 0;
      this.lines.shift();
      this.currentBytes -= removed;
      this.dropped = true;
    }

    while (this.currentBytes > this.maxBytes && this.lines.length > 0) {
      const removed = this.lineBytes.shift() ?? 0;
      this.lines.shift();
      this.currentBytes -= removed;
      this.dropped = true;
    }
  }
}

function ghResultFromSpawn(result: SpawnSyncReturns<string>): GhCommandResult {
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function runGh(args: string[]): GhCommandResult {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: GH_MAX_BUFFER_BYTES,
  });
  return ghResultFromSpawn(result);
}

async function runGhStreaming(
  args: string[],
  options: RunViewStreamingOptions,
): Promise<RunViewStreamingResult> {
  return new Promise((resolve, reject) => {
    const tailBuffer = new SlidingTailBuffer(options.maxTailLines, options.maxTailBytes);
    const stderrChunks: Buffer[] = [];
    const child = spawn('gh', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = fs.createWriteStream(options.outputPath, { encoding: 'utf8' });

    let settled = false;
    let exitCode: number | null = null;
    let childClosed = false;
    let outputClosed = false;

    const maybeResolve = (): void => {
      if (settled || !childClosed || !outputClosed) {
        return;
      }
      settled = true;
      const tail = tailBuffer.finish();
      resolve({
        status: exitCode,
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        logExcerptTail: tail.text,
        truncated: tail.truncated,
      });
    };

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      output.destroy();
      reject(error);
    });

    output.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(error);
    });

    child.stdout.on('data', (chunk: Buffer | string) => {
      tailBuffer.pushChunk(chunk);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.stdout.pipe(output);

    child.on('close', (code) => {
      exitCode = code;
      childClosed = true;
      maybeResolve();
    });

    output.on('close', () => {
      outputClosed = true;
      maybeResolve();
    });
  });
}

export function createSpawnGhRunner(): GhRunner {
  return {
    version: () => runGh(['--version']),
    authStatus: () => runGh(['auth', 'status']),
    runList: (args: string[]) => runGh(['run', 'list', ...args]),
    runView: (args: string[]) => runGh(['run', 'view', ...args]),
    runViewStreaming: (args: string[], options: RunViewStreamingOptions) =>
      runGhStreaming(['run', 'view', ...args], options),
  };
}

export function getExitCode(packet: DiagnosisPacket): number {
  return EXIT_CODE_BY_STATUS[packet.status];
}

function cloneRegex(regex: RegExp): RegExp {
  const filteredFlags = regex.flags.replaceAll('g', '').replaceAll('y', '');
  return new RegExp(regex.source, filteredFlags);
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function firstEvidenceLine(text: string, regex: RegExp): string | undefined {
  const matcher = cloneRegex(regex);
  for (const line of text.split(/\r?\n/)) {
    if (matcher.test(line)) {
      return line;
    }
  }
  return undefined;
}

function toMatch(result: MatchResult): Match {
  return {
    id: result.id,
    displayName: result.displayName,
    repro: result.repro,
    lens: result.lens,
    signpost: result.signpost,
    evidenceLine: result.evidenceLine,
    jobName: result.jobName,
  };
}

function sortedMatches(matches: MatchResult[]): MatchResult[] {
  // Stable tie-breaker: longest regex source wins; if equal, alphabetical id.
  return matches.sort((left, right) => {
    if (left.regexSourceLength !== right.regexSourceLength) {
      return right.regexSourceLength - left.regexSourceLength;
    }
    return left.id.localeCompare(right.id);
  });
}

export function classifyLog(log: string, catalog: SignatureEntry[]): MatchResult[] {
  const normalized = normalizeNewlines(log);
  const matches: MatchResult[] = [];

  for (const entry of catalog) {
    const matcher = cloneRegex(entry.regex);
    if (!matcher.test(normalized)) {
      continue;
    }

    matches.push({
      id: entry.id,
      displayName: entry.displayName,
      repro: entry.repro,
      lens: entry.lens,
      signpost: entry.signpost,
      evidenceLine: firstEvidenceLine(normalized, entry.regex),
      regexSourceLength: entry.regex.source.length,
    });
  }

  return sortedMatches(matches);
}

export function splitFailedJobLogs(rawLog: string): JobBlock[] {
  const lines = normalizeNewlines(rawLog).split('\n');
  const byJob = new Map<string, string[]>();
  const order: string[] = [];
  let lastJobName: string | null = null;

  for (const line of lines) {
    const prefixMatch = line.match(/^([^\t\r\n]+)\t[^\t\r\n]+\t/);
    if (prefixMatch) {
      const jobName = prefixMatch[1].trim();
      if (!byJob.has(jobName)) {
        byJob.set(jobName, []);
        order.push(jobName);
      }
      byJob.get(jobName)?.push(line);
      lastJobName = jobName;
      continue;
    }

    const fallbackJob = lastJobName ?? 'unknown-job';
    if (!byJob.has(fallbackJob)) {
      byJob.set(fallbackJob, []);
      order.push(fallbackJob);
    }
    byJob.get(fallbackJob)?.push(line);
  }

  if (order.length === 0) {
    return [
      {
        jobName: 'unknown-job',
        lines,
        text: lines.join('\n'),
      },
    ];
  }

  return order.map((jobName) => {
    const jobLines = byJob.get(jobName) ?? [];
    return {
      jobName,
      lines: jobLines,
      text: jobLines.join('\n'),
    };
  });
}

export function truncateLog(
  input: string,
  opts: { maxLines: number; maxBytes: number },
): { text: string; truncated: boolean } {
  const maxLines = Math.max(1, opts.maxLines);
  const maxBytes = Math.max(1, opts.maxBytes);
  const lines = normalizeNewlines(input).split('\n');

  let truncated = false;
  let tail = lines;
  if (tail.length > maxLines) {
    tail = tail.slice(-maxLines);
    truncated = true;
  }

  let text = tail.join('\n');
  while (Buffer.byteLength(text, 'utf8') > maxBytes && tail.length > 0) {
    tail = tail.slice(1);
    text = tail.join('\n');
    truncated = true;
  }

  if (text === '' && input !== '' && Buffer.byteLength(input, 'utf8') > maxBytes) {
    const inputBuffer = Buffer.from(input, 'utf8');
    text = inputBuffer.subarray(inputBuffer.length - maxBytes).toString('utf8');
    truncated = true;
  }

  return { text, truncated };
}

function isInProgressStatus(status: string | null): boolean {
  return status === 'in_progress' || status === 'queued';
}

function selectClassifiedMatches(matches: MatchResult[]): {
  classifiedMatches: MatchResult[];
  tentativeRepro?: {
    command: string;
    description: string;
  };
} {
  const specificMatches = matches.filter((match) => match.id !== GENERIC_VALIDATE_FAST_ID);
  if (specificMatches.length > 0) {
    return {
      classifiedMatches: sortedMatches(specificMatches),
    };
  }

  const genericMatch = matches.find((match) => match.id === GENERIC_VALIDATE_FAST_ID);
  if (!genericMatch) {
    return {
      classifiedMatches: [],
    };
  }

  return {
    classifiedMatches: [],
    tentativeRepro: {
      command: genericMatch.repro.command,
      description:
        genericMatch.repro.description ??
        'Generic validate:fast signal matched, but no specific failure signature was found.',
    },
  };
}

export function buildDiagnosisPacket(input: BuildDiagnosisPacketInput): DiagnosisPacket {
  if (isFailureLikeConclusion(input.runMeta.conclusion)) {
    const selected = selectClassifiedMatches(input.matches);
    if (selected.classifiedMatches.length > 0) {
      return {
        status: 'classified',
        runId: input.runMeta.runId,
        workflowName: input.runMeta.workflowName,
        failedJobs: input.failedJobs,
        matches: selected.classifiedMatches.map(toMatch),
        logPath: input.logPath,
        truncated: input.truncated,
      };
    }

    const excerpt = truncateLog(input.logExcerptTail, {
      maxLines: UNKNOWN_EXCERPT_LINES,
      maxBytes: UNKNOWN_EXCERPT_BYTES,
    }).text;

    return {
      status: 'unknown',
      runId: input.runMeta.runId,
      workflowName: input.runMeta.workflowName,
      failedJobs: input.failedJobs,
      logPath: input.logPath,
      truncated: input.truncated,
      logExcerptTail: excerpt,
      tentativeRepro: selected.tentativeRepro,
    };
  }

  if (input.runMeta.conclusion === null && isInProgressStatus(input.runMeta.status)) {
    return {
      status: 'in_progress',
      runId: input.runMeta.runId,
      workflowName: input.runMeta.workflowName,
      runStatus: input.runMeta.status ?? 'in_progress',
    };
  }

  return {
    status: 'no_failure',
    runId: input.runMeta.runId,
    workflowName: input.runMeta.workflowName,
    conclusion: String(input.runMeta.conclusion ?? input.runMeta.status ?? 'unknown'),
  };
}

function formatMatchLines(matches: Match[]): string[] {
  const lines: string[] = [];
  for (const match of matches) {
    lines.push(`- [${match.id}] ${match.displayName}`);
    if (match.jobName) {
      lines.push(`  Job: ${match.jobName}`);
    }
    lines.push(`  Repro: ${match.repro.command}`);
    if (match.repro.cwd) {
      lines.push(`  Repro cwd: ${match.repro.cwd}`);
    }
    if (match.repro.description) {
      lines.push(`  Repro notes: ${match.repro.description}`);
    }
    lines.push(`  Lens: ${match.lens}`);
    if (match.signpost) {
      lines.push(`  Signpost: ${match.signpost}`);
    }
    if (match.evidenceLine) {
      lines.push(`  Evidence: ${match.evidenceLine}`);
    }
  }
  return lines;
}

export function renderHuman(packet: DiagnosisPacket): string {
  switch (packet.status) {
    case 'classified': {
      const lines: string[] = [
        'CI diagnosis: classified',
        `Run: ${packet.runId}`,
        `Workflow: ${packet.workflowName}`,
      ];
      if (packet.failedJobs.length > 0) {
        lines.push(`Failed jobs: ${packet.failedJobs.join(', ')}`);
      }
      lines.push('Matches:');
      lines.push(...formatMatchLines(packet.matches));
      if (packet.logPath) {
        lines.push(`Log path: ${packet.logPath}`);
      }
      if (packet.truncated) {
        lines.push(
          `Log tail was truncated to last ${DEFAULT_MAX_LINES} lines and ${Math.floor(DEFAULT_MAX_BYTES / 1024)}KB.`,
        );
      }
      return lines.join('\n');
    }
    case 'unknown': {
      const lines: string[] = [
        'CI diagnosis: unknown',
        `Run: ${packet.runId}`,
        `Workflow: ${packet.workflowName}`,
      ];
      if (packet.failedJobs.length > 0) {
        lines.push(`Failed jobs: ${packet.failedJobs.join(', ')}`);
      }
      if (packet.logPath) {
        lines.push(`Log path: ${packet.logPath}`);
      }
      if (packet.tentativeRepro) {
        lines.push(`Tentative repro: ${packet.tentativeRepro.command}`);
        lines.push(`Tentative repro note: ${packet.tentativeRepro.description}`);
      }
      if (packet.truncated) {
        lines.push(
          `Log tail was truncated to last ${DEFAULT_MAX_LINES} lines and ${Math.floor(DEFAULT_MAX_BYTES / 1024)}KB.`,
        );
      }
      lines.push('Log excerpt (tail):');
      lines.push(packet.logExcerptTail);
      return lines.join('\n');
    }
    case 'no_failure': {
      if (packet.conclusion === 'dry_run') {
        return [
          'CI diagnosis: dry run',
          `Run: ${packet.runId}`,
          `Workflow: ${packet.workflowName}`,
          'Dry run mode skipped failed-job log fetch and classification.',
        ].join('\n');
      }

      if (packet.runId === 'none') {
        return 'CI diagnosis: no recent runs found for the requested branch.';
      }

      return [
        'CI diagnosis: no failure',
        `Run: ${packet.runId}`,
        `Workflow: ${packet.workflowName}`,
        `Conclusion: ${packet.conclusion}`,
      ].join('\n');
    }
    case 'in_progress':
      return [
        'CI diagnosis: run in progress',
        `Run: ${packet.runId}`,
        `Workflow: ${packet.workflowName}`,
        `Status: ${packet.runStatus}`,
      ].join('\n');
    case 'hard_error':
      return [
        'CI diagnosis: hard error',
        `Reason: ${packet.reason}`,
        `Remediation: ${packet.remediation}`,
      ].join('\n');
    default: {
      const unreachable: never = packet;
      return unreachable;
    }
  }
}

export function renderJson(packet: DiagnosisPacket): string {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

function createHardError(reason: string, remediation: string): DiagnosisPacket {
  return {
    status: 'hard_error',
    reason,
    remediation,
  };
}

function parseGhVersion(stdout: string): { major: number; minor: number; patch: number } | null {
  const match = stdout.match(/gh version (\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

function isGhVersionSupported(version: { major: number; minor: number }): boolean {
  if (version.major > GH_MIN_VERSION.major) {
    return true;
  }
  if (version.major < GH_MIN_VERSION.major) {
    return false;
  }
  return version.minor >= GH_MIN_VERSION.minor;
}

function ensureGhReady(runner: GhRunner): DiagnosisPacket | null {
  let versionResult: GhCommandResult;
  try {
    versionResult = runner.version();
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return createHardError(
        'gh CLI not found.',
        'gh CLI not found. Install: https://cli.github.com/. Or run with --from-file <path>',
      );
    }
    return createHardError(
      `Failed to run gh --version: ${err.message ?? String(error)}`,
      'Ensure gh CLI is installed and executable, or run with --from-file <path>.',
    );
  }

  if (versionResult.error?.code === 'ENOENT') {
    return createHardError(
      'gh CLI not found.',
      'gh CLI not found. Install: https://cli.github.com/. Or run with --from-file <path>',
    );
  }

  if (versionResult.status !== 0) {
    return createHardError(
      `gh --version failed: ${versionResult.stderr || versionResult.stdout}`,
      'Ensure gh CLI is installed correctly, or run with --from-file <path>.',
    );
  }

  const parsedVersion = parseGhVersion(versionResult.stdout);
  if (!parsedVersion) {
    return createHardError(
      `Unable to parse gh version output: ${versionResult.stdout.trim()}`,
      'Upgrade gh CLI to version 2.50+ from https://cli.github.com/.',
    );
  }

  if (!isGhVersionSupported(parsedVersion)) {
    return createHardError(
      `gh CLI version too old: ${parsedVersion.major}.${parsedVersion.minor}.${parsedVersion.patch}`,
      'gh CLI 2.50+ is required. Upgrade at https://cli.github.com/.',
    );
  }

  const authResult = runner.authStatus();
  if (authResult.status !== 0) {
    return createHardError(
      'gh not authenticated.',
      'gh not authenticated. Run: gh auth login (or set GH_TOKEN env var)',
    );
  }

  return null;
}

function parseRunSummary(raw: RawRunSummary): RunMeta | null {
  if (raw.databaseId === undefined || raw.databaseId === null) {
    return null;
  }

  const workflowName = raw.workflowName ?? raw.name ?? 'unknown-workflow';
  const maybeAttempt =
    raw.attempt === undefined || raw.attempt === null ? null : Number.parseInt(String(raw.attempt), 10);

  return {
    runId: String(raw.databaseId),
    workflowName,
    conclusion: raw.conclusion ?? null,
    status: raw.status ?? null,
    attempt: Number.isFinite(maybeAttempt) ? maybeAttempt : null,
    headSha: raw.headSha ?? null,
  };
}

// Conclusions that should surface as failures requiring user attention.
// `cancelled` is intentionally excluded — most cancellations are deliberate
// (user-cancelled, superseded by newer push) and surfacing them as failures is noisy.
// `skipped` and `neutral` are deliberately not failures.
const FAILURE_LIKE_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'action_required',
  'startup_failure',
  'stale',
]);

export function isFailureLikeConclusion(conclusion: string | null | undefined): boolean {
  return typeof conclusion === 'string' && FAILURE_LIKE_CONCLUSIONS.has(conclusion);
}

// Selects the most relevant run from a `gh run list` response.
//
// Design choice — "latest run group" not "latest commit":
// `gh run list` is sorted by createdAt desc, so runs[0] is whichever workflow
// most-recently STARTED (could be a manual rerun on an older SHA). We treat
// runs[0].headSha as "the SHA most worth investigating right now" and look at
// all sibling workflows on that SHA. For the typical post-push case this is
// correct (runs[0] is the just-triggered CI on the just-pushed SHA). For the
// manual-rerun-on-older-SHA case, the user should pass --run-id explicitly.
//
// When headSha is unavailable on runs[0] (degraded gh response), we fall back
// to scanning all returned runs for ANY failure-like conclusion rather than
// silently hiding sibling failures.
export function selectRelevantRun(runs: RunMeta[]): RunMeta | null {
  if (runs.length === 0) {
    return null;
  }
  const first = runs[0];
  const latestSha = first.headSha ?? null;
  if (latestSha) {
    const sameShaRuns = runs.filter((run) => run.headSha === latestSha);
    const failureOnLatestSha = sameShaRuns.find((run) => isFailureLikeConclusion(run.conclusion));
    return failureOnLatestSha ?? first;
  }
  const anyFailure = runs.find((run) => isFailureLikeConclusion(run.conclusion));
  return anyFailure ?? first;
}

function parseRunList(stdout: string): RunMeta[] {
  const parsed = JSON.parse(stdout) as RawRunSummary[];
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .map((item) => parseRunSummary(item))
    .filter((item): item is RunMeta => item !== null);
}

function parseRunView(stdout: string): RunMeta | null {
  const parsed = JSON.parse(stdout) as RawRunSummary;
  if (!parsed || Array.isArray(parsed)) {
    return null;
  }
  return parseRunSummary(parsed);
}

function runGit(args: string[], cwd: string): GhCommandResult {
  // git-exec-allow: ci investigate git wrapper preserves status and stderr for diagnostics
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return ghResultFromSpawn(result);
}

function resolveRepoRoot(cwd: string): string {
  const result = runGit(['rev-parse', '--show-toplevel'], cwd);
  if (result.status === 0 && result.stdout.trim().length > 0) {
    return result.stdout.trim();
  }
  return cwd;
}

function resolveCurrentBranch(cwd: string): string {
  const result = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (result.status === 0 && result.stdout.trim().length > 0) {
    return result.stdout.trim();
  }
  return 'dev';
}

function ensureCacheDir(fsLike: FsLike, repoRoot: string): string {
  const cacheDir = path.join(repoRoot, 'tmp', 'ci-investigate');
  fsLike.mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

function finalize(packet: DiagnosisPacket, jsonMode: boolean): InvestigateResult {
  const output = jsonMode ? renderJson(packet) : `${renderHuman(packet)}\n`;
  return {
    packet,
    exitCode: getExitCode(packet),
    output,
  };
}

function prepareCatalog(catalog: SignatureEntry[]): PreparedCatalogEntry[] {
  return catalog.map((entry) => ({
    entry,
    regex: cloneRegex(entry.regex),
    jobNamePattern: entry.jobNamePattern ? cloneRegex(entry.jobNamePattern) : undefined,
  }));
}

function normalizeJobName(line: string, lastJobName: string | null): string {
  const prefixMatch = line.match(/^([^\t\r\n]+)\t[^\t\r\n]+\t/);
  if (prefixMatch) {
    return prefixMatch[1].trim();
  }
  return lastJobName ?? 'unknown-job';
}

async function scanLogFileForClassification(
  filePath: string,
  catalog: SignatureEntry[],
  options: { maxLines: number; maxBytes: number },
): Promise<LogScanResult> {
  const preparedCatalog = prepareCatalog(catalog);
  const tailBuffer = new SlidingTailBuffer(options.maxLines, options.maxBytes);
  const matchByKey = new Map<string, MatchResult>();
  const failedJobs: string[] = [];
  const seenJobs = new Set<string>();
  let lastJobName: string | null = null;

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lineReader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of lineReader) {
      const jobName = normalizeJobName(line, lastJobName);
      lastJobName = jobName;

      if (!seenJobs.has(jobName)) {
        seenJobs.add(jobName);
        failedJobs.push(jobName);
      }

      tailBuffer.addLine(line);

      for (const prepared of preparedCatalog) {
        if (prepared.jobNamePattern && !prepared.jobNamePattern.test(jobName)) {
          continue;
        }

        if (!prepared.regex.test(line)) {
          continue;
        }

        const key = `${jobName}\u0000${prepared.entry.id}`;
        if (matchByKey.has(key)) {
          continue;
        }

        matchByKey.set(key, {
          id: prepared.entry.id,
          displayName: prepared.entry.displayName,
          repro: prepared.entry.repro,
          lens: prepared.entry.lens,
          signpost: prepared.entry.signpost,
          evidenceLine: line,
          jobName,
          regexSourceLength: prepared.entry.regex.source.length,
        });
      }
    }
  } finally {
    lineReader.close();
    stream.destroy();
  }

  if (failedJobs.length === 0) {
    failedJobs.push('unknown-job');
  }

  const tail = tailBuffer.finish();
  return {
    matches: sortedMatches([...matchByKey.values()]),
    failedJobs,
    logExcerptTail: tail.text,
    truncated: tail.truncated,
  };
}

function parseGhErrorRemediation(stderr: string, fallback: string): string {
  if (/HTTP 401|Bad credentials/i.test(stderr)) {
    return 'gh auth status reports stale credentials; run: `gh auth refresh`';
  }
  if (/HTTP 429|API rate limit/i.test(stderr)) {
    return 'GitHub API rate limit. Wait or set `GH_TOKEN` to a token with higher limits';
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET/i.test(stderr)) {
    return 'Network/DNS error. Check VPN/connectivity and retry';
  }
  return fallback;
}

function isTransientGhError(stderr: string): boolean {
  return /HTTP 429|API rate limit exceeded|ENOTFOUND|ETIMEDOUT|ECONNRESET/i.test(stderr);
}

function retryNotice(): void {
  process.stderr.write('[ci-investigate] transient error, retrying once in 5s…\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runSyncGhWithRetry(run: () => GhCommandResult): Promise<GhCommandResult> {
  const first = run();
  const firstOutput = `${first.stderr}\n${first.stdout}`;
  if (first.status === 0 || !isTransientGhError(firstOutput)) {
    return first;
  }

  retryNotice();
  await sleep(RETRY_DELAY_MS);
  return run();
}

async function runStreamingGhWithRetry(
  run: () => Promise<RunViewStreamingResult>,
): Promise<RunViewStreamingResult> {
  const first = await run();
  if (first.status === 0 || !isTransientGhError(first.stderr)) {
    return first;
  }

  retryNotice();
  await sleep(RETRY_DELAY_MS);
  return run();
}

function cacheFileBasename(runMeta: RunMeta): string {
  if (runMeta.attempt !== null) {
    return `${runMeta.runId}-attempt-${runMeta.attempt}`;
  }
  return runMeta.runId;
}

function fileReadHardError(filePath: string, error: unknown): DiagnosisPacket {
  const err = error as NodeJS.ErrnoException;
  const errorCode = err.code ?? 'UNKNOWN';
  const reason = `Failed reading or classifying log file (${errorCode}): ${filePath}`;

  if (errorCode === 'EACCES') {
    return createHardError(reason, 'Permission denied. Make the file readable and retry.');
  }
  if (errorCode === 'ENOTDIR' || errorCode === 'EISDIR') {
    return createHardError(reason, 'Path must point to a log file, not a directory.');
  }
  if (errorCode === 'ENOENT') {
    return createHardError(reason, 'Log file not found. Verify the path and retry.');
  }

  return createHardError(
    reason,
    'Ensure the log path is valid and readable, then rerun `npm run ci:investigate`.',
  );
}

export async function runCiInvestigate(
  options: InvestigateOptions,
  deps: InvestigateDeps = {},
): Promise<InvestigateResult> {
  const cwd = deps.cwd ?? process.cwd();
  const repoRoot = deps.repoRoot ?? resolveRepoRoot(cwd);
  const fsLike = deps.fsLike ?? NODE_FS;
  const catalog = deps.catalog ?? CATALOG;
  const maxLines = deps.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const jsonMode = options.json ?? false;

  if (!Number.isFinite(limit) || limit <= 0) {
    return finalize(
      createHardError('Invalid --limit value.', 'Use a positive integer value for --limit.'),
      jsonMode,
    );
  }

  if (options.fromFile) {
    const resolvedPath = path.isAbsolute(options.fromFile)
      ? options.fromFile
      : path.join(cwd, options.fromFile);

    if (!fsLike.existsSync(resolvedPath)) {
      return finalize(
        createHardError(
          `Log file not found: ${resolvedPath}`,
          'Provide an existing path with --from-file <path>.',
        ),
        jsonMode,
      );
    }

    try {
      // Classification runs against full log; truncation is display-only.
      const scan = await scanLogFileForClassification(resolvedPath, catalog, {
        maxLines,
        maxBytes,
      });
      const packet = buildDiagnosisPacket({
        runMeta: {
          runId: 'from-file',
          workflowName: 'from-file',
          conclusion: 'failure',
          status: 'completed',
          attempt: null,
        },
        matches: scan.matches,
        failedJobs: scan.failedJobs,
        logPath: resolvedPath,
        truncated: scan.truncated,
        logExcerptTail: scan.logExcerptTail,
      });
      return finalize(packet, jsonMode);
    } catch (error) {
      return finalize(fileReadHardError(resolvedPath, error), jsonMode);
    }
  }

  const runner = deps.runner ?? createSpawnGhRunner();
  const readinessError = ensureGhReady(runner);
  if (readinessError) {
    return finalize(readinessError, jsonMode);
  }

  const branch = options.branch ?? resolveCurrentBranch(cwd);
  let runMeta: RunMeta | null = null;

  if (options.runId) {
    if (options.dryRun) {
      runMeta = {
        runId: options.runId,
        workflowName: 'unknown-workflow',
        conclusion: 'failure',
        status: 'completed',
        attempt: null,
      };
    } else {
      const runMetaResult = await runSyncGhWithRetry(() =>
        runner.runView([options.runId as string, '--json', 'databaseId,name,conclusion,status,workflowName,attempt']),
      );
      if (runMetaResult.status !== 0) {
        const stderr = runMetaResult.stderr || runMetaResult.stdout;
        return finalize(
          createHardError(
            `gh run view --json failed: ${stderr}`,
            parseGhErrorRemediation(
              stderr,
              'Confirm the run id exists and gh has access to this repository.',
            ),
          ),
          jsonMode,
        );
      }

      try {
        runMeta = parseRunView(runMetaResult.stdout);
      } catch (error) {
        return finalize(
          createHardError(
            `Failed to parse gh run view JSON: ${String(error)}`,
            'Retry with --run-id and ensure gh outputs valid JSON.',
          ),
          jsonMode,
        );
      }
    }
  } else {
    const listResult = await runSyncGhWithRetry(() =>
      runner.runList([
        '--branch',
        branch,
        '--limit',
        String(limit),
        '--json',
        'databaseId,name,conclusion,status,workflowName,event,headBranch,headSha,attempt',
      ]),
    );

    if (listResult.status !== 0) {
      const stderr = listResult.stderr || listResult.stdout;
      return finalize(
        createHardError(
          `gh run list failed: ${stderr}`,
          parseGhErrorRemediation(stderr, 'Verify repository access and gh authentication, then retry.'),
        ),
        jsonMode,
      );
    }

    let runs: RunMeta[];
    try {
      runs = parseRunList(listResult.stdout);
    } catch (error) {
      return finalize(
        createHardError(
          `Failed to parse gh run list JSON: ${String(error)}`,
          'Retry with gh CLI 2.50+ and valid repository context.',
        ),
        jsonMode,
      );
    }

    runMeta = selectRelevantRun(runs);
    if (!runMeta) {
      return finalize(
        {
          status: 'no_failure',
          runId: 'none',
          workflowName: 'unknown-workflow',
          conclusion: 'no_recent_runs',
        },
        jsonMode,
      );
    }
  }

  if (!runMeta) {
    return finalize(
      createHardError('Unable to resolve a workflow run.', 'Provide --run-id or verify --branch.'),
      jsonMode,
    );
  }

  if (options.dryRun) {
    return finalize(
      {
        status: 'no_failure',
        runId: runMeta.runId,
        workflowName: runMeta.workflowName,
        conclusion: 'dry_run',
      },
      jsonMode,
    );
  }

  if (runMeta.conclusion === null && isInProgressStatus(runMeta.status)) {
    return finalize(
      {
        status: 'in_progress',
        runId: runMeta.runId,
        workflowName: runMeta.workflowName,
        runStatus: runMeta.status ?? 'in_progress',
      },
      jsonMode,
    );
  }

  if (!isFailureLikeConclusion(runMeta.conclusion)) {
    return finalize(
      {
        status: 'no_failure',
        runId: runMeta.runId,
        workflowName: runMeta.workflowName,
        conclusion: String(runMeta.conclusion ?? runMeta.status ?? 'unknown'),
      },
      jsonMode,
    );
  }

  const cacheDir = ensureCacheDir(fsLike, repoRoot);
  const cacheBase = cacheFileBasename(runMeta);
  const cachePath = path.join(cacheDir, `${cacheBase}.log`);
  const partialPath = path.join(cacheDir, `${cacheBase}.partial.log`);

  let logExcerptTail = '';
  let truncated = false;

  if (options.noFetch) {
    if (!fsLike.existsSync(cachePath)) {
      return finalize(
        createHardError(
          `Cached log not found: ${cachePath}`,
          'Run without --no-fetch to download logs, or provide --from-file <path>.',
        ),
        jsonMode,
      );
    }
  } else {
    if (fsLike.existsSync(partialPath)) {
      fsLike.unlinkSync(partialPath);
    }
    if (fsLike.existsSync(cachePath)) {
      fsLike.unlinkSync(cachePath);
    }

    let streamResult: RunViewStreamingResult;
    try {
      streamResult = await runStreamingGhWithRetry(() =>
        runner.runViewStreaming([runMeta.runId, '--log-failed'], {
          outputPath: partialPath,
          maxTailLines: maxLines,
          maxTailBytes: maxBytes,
        }),
      );
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return finalize(
          createHardError(
            'gh CLI not found.',
            'gh CLI not found. Install: https://cli.github.com/. Or run with --from-file <path>',
          ),
          jsonMode,
        );
      }
      return finalize(
        createHardError(
          `gh run view --log-failed failed to start: ${err.message ?? String(error)}`,
          'Retry later, or use --from-file <path> with a downloaded failed-job log.',
        ),
        jsonMode,
      );
    }

    if (streamResult.status !== 0) {
      const stderr = streamResult.stderr;
      return finalize(
        createHardError(
          `gh run view --log-failed failed: ${stderr}`,
          parseGhErrorRemediation(
            stderr,
            'Retry later, or use --from-file <path> with a downloaded failed-job log.',
          ),
        ),
        jsonMode,
      );
    }

    logExcerptTail = streamResult.logExcerptTail;
    truncated = streamResult.truncated;

    try {
      fsLike.renameSync(partialPath, cachePath);
    } catch (error) {
      return finalize(
        createHardError(
          `Failed to cache streamed log at ${cachePath}: ${String(error)}`,
          'Ensure tmp/ is writable and retry.',
        ),
        jsonMode,
      );
    }
  }

  try {
    // Classification runs against full log; truncation is display-only.
    const scan = await scanLogFileForClassification(cachePath, catalog, {
      maxLines,
      maxBytes,
    });
    const packet = buildDiagnosisPacket({
      runMeta,
      matches: scan.matches,
      failedJobs: scan.failedJobs,
      logPath: cachePath,
      truncated: truncated || scan.truncated,
      logExcerptTail: logExcerptTail || scan.logExcerptTail,
    });
    return finalize(packet, jsonMode);
  } catch (error) {
    return finalize(fileReadHardError(cachePath, error), jsonMode);
  }
}

class CiInvestigateCommand extends Command {
  static paths = [Command.Default];

  static usage = Command.Usage({
    description: 'Diagnose CI failures from gh failed-job logs',
    details: `
      Resolves a workflow run, fetches failed-job logs, classifies signatures,
      and emits either a human-readable diagnosis or JSON packet.
    `,
    examples: [
      ['Investigate latest run on current branch', 'npx tsx scripts/ci-investigate.ts'],
      ['Investigate explicit run id', 'npx tsx scripts/ci-investigate.ts --run-id 123456'],
      ['Classify a local log file', 'npx tsx scripts/ci-investigate.ts --from-file ./failed.log'],
      ['JSON output for automation', 'npx tsx scripts/ci-investigate.ts --json'],
    ],
  });

  branch = Option.String('--branch', {
    description: 'Branch name to inspect (default: current git branch).',
  });

  runId = Option.String('--run-id', {
    description: 'Explicit run id to inspect. Skips list resolution.',
  });

  fromFile = Option.String('--from-file', {
    description: 'Classify an existing log file instead of calling gh.',
  });

  dryRun = Option.Boolean('--dry-run', false, {
    description: 'Print selected run metadata only. Skips gh run view log fetch.',
  });

  json = Option.Boolean('--json', false, {
    description: 'Emit machine-readable JSON.',
  });

  noFetch = Option.Boolean('--no-fetch', false, {
    description: 'Use cached tmp/ci-investigate/<runId>.log instead of fetching.',
  });

  limit = Option.String('--limit', String(DEFAULT_LIMIT), {
    description: 'How many recent runs to request from gh run list.',
  });

  async execute(): Promise<number> {
    const parsedLimit = Number.parseInt(this.limit, 10);
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
      if (this.json) {
        const packet = createHardError(
          'Invalid --limit value.',
          'Use a positive integer value for --limit.',
        );
        this.context.stdout.write(renderJson(packet));
        return getExitCode(packet);
      }
      throw new UsageError('--limit must be a positive integer');
    }

    try {
      const result = await runCiInvestigate({
        branch: this.branch ?? undefined,
        runId: this.runId ?? undefined,
        fromFile: this.fromFile ?? undefined,
        dryRun: this.dryRun,
        json: this.json,
        noFetch: this.noFetch,
        limit: parsedLimit,
      });

      this.context.stdout.write(result.output);
      return result.exitCode;
    } catch (error) {
      const packet = createHardError(
        `Unhandled ci-investigate failure: ${String(error)}`,
        'Retry the command. If it persists, run with --from-file using a downloaded failed-job log.',
      );
      this.context.stdout.write(this.json ? renderJson(packet) : `${renderHuman(packet)}\n`);
      return getExitCode(packet);
    }
  }
}

const cli = new Cli({
  binaryLabel: 'CI Investigate',
  binaryName: 'ci-investigate',
  binaryVersion: '1.0.0',
});

cli.register(CiInvestigateCommand);

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  void cli.runExit(process.argv.slice(2), Cli.defaultContext);
}
