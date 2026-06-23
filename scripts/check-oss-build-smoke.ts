#!/usr/bin/env tsx
/**
 * Static OSS build smoke gate for the B3 Mindstone carve-out.
 *
 * This script assumes the caller has already built the OSS/stub bundle with
 * `private/` detached, for example:
 *
 *   mv private private.oss-smoke-detached
 *   npm run build:legacy
 *   npm run validate:oss-smoke
 *
 * CI wiring is deliberately non-blocking until B4 acceptance flips this from a
 * smoke signal into a required release gate. See
 * docs/project/OSS_BUILD_SMOKE_RUNBOOK.md for the dynamic launch/network checks
 * that still require a desktop environment.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLicenseTier, resetFeatureGating, setLicenseTier } from '@core/featureGating';
import { OSS_NULL_AUTH_PROVIDER } from '@core/services/ossNullAuthProvider';
import { AuthConfigPresenceSchema } from '@shared/ipc/channels/auth';

interface CliOptions {
  readonly bundleRoots: readonly string[];
  readonly contractOnly: boolean;
  readonly usingDefaultBundleRoots: boolean;
  readonly help: boolean;
}

interface TextBundleFile {
  readonly file: string;
  readonly text: string;
}

interface SourceMapPayload {
  readonly sourceRoot?: unknown;
  readonly sources?: unknown;
  readonly sourcesContent?: unknown;
}

interface ForbiddenBundlePattern {
  readonly name: string;
  readonly pattern: RegExp;
}

interface BundleViolation {
  readonly file: string;
  readonly line: number;
  readonly pattern: string;
  readonly match: string;
}

interface SourceMapViolation {
  readonly file: string;
  readonly source?: string;
  readonly pattern: string;
  readonly match: string;
}

interface CheckFailure {
  readonly check: string;
  readonly message: string;
  readonly details?: readonly string[];
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BUNDLE_ROOTS = ['.vite/build', 'out/main', 'out/renderer'] as const;
const DEFAULT_MAIN_BUNDLE_ROOTS = ['.vite/build', 'out/main'] as const;
const DEFAULT_RENDERER_BUNDLE_ROOTS = ['out/renderer'] as const;

const STUB_MARKER = 'private-mindstone-stub';
const MAX_REPORTED_VIOLATIONS = 50;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

const FORBIDDEN_BUNDLE_PATTERNS: readonly ForbiddenBundlePattern[] = [
  { name: 'private source path literal', pattern: /private\/mindstone\//g },
  { name: 'real private marker', pattern: /private-mindstone-real/g },
  { name: 'desktop auth provider symbol', pattern: /\bDESKTOP_REBEL_AUTH_PROVIDER\b/g },
  { name: 'desktop current-user provider symbol', pattern: /\bElectronCurrentUserProvider\b/g },
  { name: 'Mindstone auth provider symbol', pattern: /\bMindstoneAuthProvider\b/g },
  { name: 'Mindstone electron token exchange endpoint', pattern: /\/api\/auth\/electron\/exchange\b/g },
  { name: 'Mindstone electron authorize endpoint', pattern: /\/api\/auth\/electron\/authorize\b/g },
  { name: 'Mindstone OTP send endpoint', pattern: /\/api\/auth\/electron\/otp\/send\b/g },
  { name: 'Mindstone OTP verify endpoint', pattern: /\/api\/auth\/electron\/otp\/verify\b/g },
  { name: 'Mindstone session endpoint', pattern: /\/api\/auth\/get-session\b/g },
  { name: 'Mindstone token refresh endpoint', pattern: /\/api\/auth\/token\b/g },
  { name: 'Mindstone auth heartbeat endpoint', pattern: /\/api\/heartbeat\b/g },
  { name: 'Mindstone contribution relay submit endpoint', pattern: /\/api\/contribution\/v1\/submit\b/g },
  // F7 (260618_oss-rudderstack-strip): the Elastic-2.0 RudderStack browser SDK
  // must not leak into the OSS renderer bundle. It is dependency-stripped + the
  // guarded dynamic import is aliased to a no-op stub, so a CORRECT OSS bundle
  // contains neither the bare specifier nor the node_modules path. Use the EXACT
  // package name, NOT a broad `rudderstack` — the SEPARATE MIT main-process
  // package `@rudderstack/rudder-sdk-node` legitimately remains.
  { name: 'RudderStack analytics-js bare specifier', pattern: /@rudderstack\/analytics-js/g },
  { name: 'RudderStack analytics-js node_modules path', pattern: /node_modules\/@rudderstack\/analytics-js/g },
];

const PRIVATE_SOURCEMAP_SOURCE_PATH_PATTERN = /private\/mindstone\//;
const PRIVATE_SOURCEMAP_BODY_PATTERNS: readonly ForbiddenBundlePattern[] = [
  {
    name: 'private fetchAuthConfig function body',
    pattern: /\b(?:export\s+)?(?:async\s+)?function\s+fetchAuthConfig\b/g,
  },
  {
    name: 'private fetchAuthConfig arrow body',
    pattern: /\b(?:const|let|var)\s+fetchAuthConfig\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
  },
  {
    name: 'private initiateLogin function body',
    pattern: /\b(?:export\s+)?(?:async\s+)?function\s+initiateLogin\b/g,
  },
  {
    name: 'private initiateLogin arrow body',
    pattern: /\b(?:const|let|var)\s+initiateLogin\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
  },
];

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: npm run validate:oss-smoke -- [--bundle-root <path> ...] [--contract-only] [--help]',
      '',
      'Default mode scans executable JS under .vite/build, out/main, and out/renderer when present.',
      'Run after building with private/ detached so @private/mindstone resolves to the OSS stub.',
      '--contract-only skips bundle scanning and only asserts OSS_NULL_AUTH_PROVIDER behavior.',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv: readonly string[]): CliOptions {
  const bundleRoots: string[] = [];
  let contractOnly = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--contract-only') {
      contractOnly = true;
      continue;
    }
    if (arg === '--bundle-root') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--bundle-root requires a path');
      }
      bundleRoots.push(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    bundleRoots: bundleRoots.length > 0 ? bundleRoots : DEFAULT_BUNDLE_ROOTS,
    contractOnly,
    usingDefaultBundleRoots: bundleRoots.length === 0,
    help,
  };
}

function toDisplayPath(absolutePath: string): string {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join('/');
}

function decodeUtf8OrNull(content: Buffer): string | null {
  try {
    return textDecoder.decode(content);
  } catch {
    return null;
  }
}

function listTextBundleFiles(
  bundleRoots: readonly string[],
  shouldIncludeFile: (absolutePath: string) => boolean,
): TextBundleFile[] {
  const files: TextBundleFile[] = [];
  const stack = bundleRoots
    .map((root) => path.resolve(REPO_ROOT, root))
    .filter((root) => existsSync(root));

  for (const root of stack) {
    const stat = statSync(root);
    if (stat.isFile() && shouldIncludeFile(root)) {
      const decoded = decodeUtf8OrNull(readFileSync(root));
      if (decoded !== null) {
        files.push({ file: toDisplayPath(root), text: decoded });
      }
    }
  }

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const stat = statSync(current);
    if (!stat.isDirectory()) continue;

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!shouldIncludeFile(absolutePath)) continue;

      const decoded = decodeUtf8OrNull(readFileSync(absolutePath));
      if (decoded !== null) {
        files.push({ file: toDisplayPath(absolutePath), text: decoded });
      }
    }
  }

  return files.sort((a, b) => a.file.localeCompare(b.file));
}

function listExecutableBundleFiles(bundleRoots: readonly string[]): TextBundleFile[] {
  return listTextBundleFiles(
    bundleRoots,
    (absolutePath) => absolutePath.endsWith('.js') && !absolutePath.endsWith('.js.map'),
  );
}

function listSourceMapFiles(bundleRoots: readonly string[]): TextBundleFile[] {
  return listTextBundleFiles(bundleRoots, (absolutePath) => absolutePath.endsWith('.js.map'));
}

function scanBundles(files: readonly TextBundleFile[]): BundleViolation[] {
  const violations: BundleViolation[] = [];

  for (const { file, text } of files) {
    const lines = text.split(/\r?\n/);
    for (const forbiddenPattern of FORBIDDEN_BUNDLE_PATTERNS) {
      forbiddenPattern.pattern.lastIndex = 0;
      for (const [lineIndex, line] of lines.entries()) {
        forbiddenPattern.pattern.lastIndex = 0;
        for (const match of line.matchAll(forbiddenPattern.pattern)) {
          violations.push({
            file,
            line: lineIndex + 1,
            pattern: forbiddenPattern.name,
            match: match[0],
          });
        }
      }
    }
  }

  return violations;
}

function normalizeSourcePath(sourcePath: string): string {
  return sourcePath.replaceAll('\\', '/');
}

function parseSourceMap(file: TextBundleFile): SourceMapPayload | SourceMapViolation {
  try {
    const parsed = JSON.parse(file.text) as SourceMapPayload;
    return parsed;
  } catch (error) {
    return {
      file: file.file,
      pattern: 'invalid sourcemap JSON',
      match: error instanceof Error ? error.message : String(error),
    };
  }
}

function scanSourceMaps(files: readonly TextBundleFile[]): SourceMapViolation[] {
  const violations: SourceMapViolation[] = [];

  for (const file of files) {
    const parsed = parseSourceMap(file);
    if ('pattern' in parsed) {
      violations.push(parsed);
      continue;
    }

    const sourceRoot = typeof parsed.sourceRoot === 'string'
      ? normalizeSourcePath(parsed.sourceRoot)
      : '';
    const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
    for (const rawSource of sources) {
      if (typeof rawSource !== 'string') continue;
      const normalizedSource = normalizeSourcePath(rawSource);
      const combinedSource = normalizeSourcePath(`${sourceRoot}/${rawSource}`);
      if (
        PRIVATE_SOURCEMAP_SOURCE_PATH_PATTERN.test(normalizedSource)
        || PRIVATE_SOURCEMAP_SOURCE_PATH_PATTERN.test(combinedSource)
      ) {
        violations.push({
          file: file.file,
          source: normalizedSource,
          pattern: 'private sourcemap source path',
          match: normalizedSource,
        });
      }
    }

    const sourcesContent = Array.isArray(parsed.sourcesContent) ? parsed.sourcesContent : [];
    for (const [sourceIndex, rawContent] of sourcesContent.entries()) {
      if (typeof rawContent !== 'string') continue;
      const source = typeof sources[sourceIndex] === 'string'
        ? normalizeSourcePath(sources[sourceIndex])
        : undefined;
      for (const forbiddenPattern of PRIVATE_SOURCEMAP_BODY_PATTERNS) {
        forbiddenPattern.pattern.lastIndex = 0;
        for (const match of rawContent.matchAll(forbiddenPattern.pattern)) {
          violations.push({
            file: file.file,
            source,
            pattern: forbiddenPattern.name,
            match: match[0],
          });
        }
      }
    }
  }

  return violations;
}

function formatViolations(violations: readonly BundleViolation[]): string[] {
  const lines = violations.slice(0, MAX_REPORTED_VIOLATIONS).map((violation) =>
    `${violation.file}:${violation.line} [${violation.pattern}] ${violation.match}`,
  );
  if (violations.length > MAX_REPORTED_VIOLATIONS) {
    lines.push(`... and ${violations.length - MAX_REPORTED_VIOLATIONS} more`);
  }
  return lines;
}

function formatSourceMapViolations(violations: readonly SourceMapViolation[]): string[] {
  const lines = violations.slice(0, MAX_REPORTED_VIOLATIONS).map((violation) => {
    const sourceSuffix = violation.source ? ` (${violation.source})` : '';
    return `${violation.file}${sourceSuffix} [${violation.pattern}] ${violation.match}`;
  });
  if (violations.length > MAX_REPORTED_VIOLATIONS) {
    lines.push(`... and ${violations.length - MAX_REPORTED_VIOLATIONS} more`);
  }
  return lines;
}

function assertBundleSmoke(options: CliOptions): CheckFailure | null {
  const { bundleRoots } = options;
  const presentRoots = bundleRoots.filter((root) => existsSync(path.resolve(REPO_ROOT, root)));
  if (presentRoots.length === 0) {
    return {
      check: 'bundle leak scan',
      message: `No bundle roots found. Build the OSS/stub bundle first or pass --bundle-root. Checked: ${bundleRoots.join(', ')}`,
    };
  }
  if (options.usingDefaultBundleRoots) {
    const presentMainRoots = DEFAULT_MAIN_BUNDLE_ROOTS.filter((root) =>
      existsSync(path.resolve(REPO_ROOT, root)),
    );
    const presentRendererRoots = DEFAULT_RENDERER_BUNDLE_ROOTS.filter((root) =>
      existsSync(path.resolve(REPO_ROOT, root)),
    );
    if (presentMainRoots.length === 0 || presentRendererRoots.length === 0) {
      return {
        check: 'bundle leak scan',
        message: [
          'Expected at least one main bundle root and one renderer bundle root.',
          `Main roots found: ${presentMainRoots.length > 0 ? presentMainRoots.join(', ') : 'none'}.`,
          `Renderer roots found: ${presentRendererRoots.length > 0 ? presentRendererRoots.join(', ') : 'none'}.`,
        ].join(' '),
      };
    }
  }

  const executableFiles = listExecutableBundleFiles(bundleRoots);
  if (executableFiles.length === 0) {
    return {
      check: 'bundle leak scan',
      message: `No executable UTF-8 .js bundle files found under: ${presentRoots.join(', ')}`,
    };
  }

  const containsStubMarker = executableFiles.some((file) => file.text.includes(STUB_MARKER));
  if (!containsStubMarker) {
    return {
      check: 'bundle leak scan',
      message: `OSS stub marker ${JSON.stringify(STUB_MARKER)} was not found in scanned bundle output.`,
      details: [
        'This usually means the bundle was built with private/mindstone present, or the marker was optimized away unexpectedly.',
        `Scanned roots: ${presentRoots.join(', ')}`,
      ],
    };
  }

  const violations = scanBundles(executableFiles);
  if (violations.length > 0) {
    return {
      check: 'bundle leak scan',
      message: `${violations.length} forbidden Mindstone auth/relay marker(s) found in OSS bundle output.`,
      details: formatViolations(violations),
    };
  }

  const sourceMapViolations = scanSourceMaps(listSourceMapFiles(bundleRoots));
  if (sourceMapViolations.length > 0) {
    return {
      check: 'sourcemap leak scan',
      message: `${sourceMapViolations.length} private Mindstone sourcemap leak(s) found in OSS bundle output.`,
      details: formatSourceMapViolations(sourceMapViolations),
    };
  }

  return null;
}

async function assertOssProviderContract(): Promise<CheckFailure | null> {
  const originalFetch = globalThis.fetch;
  const fetchCalls: unknown[][] = [];

  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    fetchCalls.push(args);
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    resetFeatureGating();
    setLicenseTier('free');

    const cachedConfig = OSS_NULL_AUTH_PROVIDER.getCachedAuthConfig();
    const parsedConfig = AuthConfigPresenceSchema.parse(cachedConfig);
    if (parsedConfig.licenseTier !== 'teams') {
      return {
        check: 'OSS provider contract',
        message: `Expected cached config licenseTier to be "teams", got ${JSON.stringify(parsedConfig.licenseTier)}.`,
      };
    }
    if (parsedConfig.isOssBuild !== true) {
      return {
        check: 'OSS provider contract',
        message: `Expected cached config isOssBuild to be true, got ${JSON.stringify(parsedConfig.isOssBuild)}.`,
      };
    }

    await OSS_NULL_AUTH_PROVIDER.initializeAuth();
    if (getLicenseTier() !== 'teams') {
      return {
        check: 'OSS provider contract',
        message: `Expected initializeAuth() to set global license tier to "teams", got ${JSON.stringify(getLicenseTier())}.`,
      };
    }

    const token = await OSS_NULL_AUTH_PROVIDER.getAccessToken();
    if (token !== null) {
      return {
        check: 'OSS provider contract',
        message: `Expected getAccessToken() to return null, got ${JSON.stringify(token)}.`,
      };
    }

    await OSS_NULL_AUTH_PROVIDER.requestAuthConfigRefresh();
    await OSS_NULL_AUTH_PROVIDER.refreshLicenseTier();
    OSS_NULL_AUTH_PROVIDER.invalidateAccessToken();
    OSS_NULL_AUTH_PROVIDER.setPostLoginCallback(null);
    OSS_NULL_AUTH_PROVIDER.clearCachedProviderKey('anthropic');
    OSS_NULL_AUTH_PROVIDER.clearCachedProviderKey('voice');
    OSS_NULL_AUTH_PROVIDER.getAuthState();
    OSS_NULL_AUTH_PROVIDER.getSharedDriveConfig();
    OSS_NULL_AUTH_PROVIDER.getSubscriptionState();
    OSS_NULL_AUTH_PROVIDER.getManagedAllowanceResetsAt();

    if (fetchCalls.length > 0) {
      return {
        check: 'OSS provider contract',
        message: `Expected OSS_NULL_AUTH_PROVIDER to make zero fetch calls, observed ${fetchCalls.length}.`,
      };
    }
  } finally {
    globalThis.fetch = originalFetch;
    resetFeatureGating();
  }

  return null;
}

function printFailure(failure: CheckFailure): void {
  console.error(`OSS build smoke: FAIL — ${failure.check}: ${failure.message}`);
  for (const detail of failure.details ?? []) {
    console.error(`  ${detail}`);
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return 0;
  }

  const failures: CheckFailure[] = [];

  const providerFailure = await assertOssProviderContract();
  if (providerFailure) {
    failures.push(providerFailure);
  } else {
    console.log('OSS build smoke: PASS — OSS provider contract');
  }

  if (!options.contractOnly) {
    const bundleFailure = assertBundleSmoke(options);
    if (bundleFailure) {
      failures.push(bundleFailure);
    } else {
      console.log(`OSS build smoke: PASS — bundle leak scan (${options.bundleRoots.join(', ')})`);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      printFailure(failure);
    }
    return 1;
  }

  console.log(options.contractOnly ? 'OSS build smoke: PASS' : 'OSS build smoke: PASS — all checks');
  return 0;
}

const invokedDirectly = process.argv[1]?.endsWith('check-oss-build-smoke.ts') ?? false;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`OSS build smoke: ERROR — ${message}`);
      process.exitCode = 1;
    },
  );
}

export {
  FORBIDDEN_BUNDLE_PATTERNS,
  assertBundleSmoke,
  assertOssProviderContract,
  scanBundles,
  scanSourceMaps,
};
