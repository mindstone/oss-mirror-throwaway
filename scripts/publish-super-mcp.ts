#!/usr/bin/env npx tsx
/**
 * Idempotently publish super-mcp-router when the current super-mcp version is
 * not already present on the public npm registry.
 *
 * @see docs/plans/260607_supermcp-release-automation/PLAN.md (Stage 3)
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { GENERATED_SUPER_MCP_ROUTER_VERSION } from '../src/core/services/superMcpVersion.generated';

const PACKAGE_NAME = 'super-mcp-router';
const VERIFY_ATTEMPTS = 8;
const VERIFY_DELAY_MS = 5000;

export interface NpmRunOptions {
  readonly cwd: string;
}

export interface NpmRunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

type MaybePromise<T> = T | Promise<T>;

export interface PublishSuperMcpDeps {
  readonly cwd: string;
  readonly runNpm: (args: readonly string[], opts: NpmRunOptions) => MaybePromise<NpmRunResult>;
  readonly readFile: (filePath: string) => MaybePromise<string>;
  readonly exists: (filePath: string) => MaybePromise<boolean>;
  readonly sleep?: (ms: number) => MaybePromise<void>;
  readonly generatedVersion?: string;
  readonly verifyAttempts?: number;
  readonly verifyDelayMs?: number;
}

export interface PublishSuperMcpOptions {
  readonly dryRun?: boolean;
  readonly preflightOnly?: boolean;
  readonly verify?: boolean;
  readonly skipSmoke?: boolean;
}

export type PublishSuperMcpStatus = 'already-published' | 'would-publish' | 'published' | 'dry-run';

export interface PublishSuperMcpResult {
  readonly status: PublishSuperMcpStatus;
  readonly version: string;
  readonly messages: readonly string[];
}

interface SuperMcpPackageJson {
  readonly name: string;
  readonly version: string;
  readonly files: readonly string[];
}

interface NpmPackEntry {
  readonly files?: ReadonlyArray<{ readonly path?: unknown }>;
}

export class PublishSuperMcpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PublishSuperMcpError';
  }
}

function superMcpDir(deps: Pick<PublishSuperMcpDeps, 'cwd'>): string {
  return path.join(deps.cwd, 'super-mcp');
}

function packagePath(deps: Pick<PublishSuperMcpDeps, 'cwd'>): string {
  return path.join(superMcpDir(deps), 'package.json');
}

function distCliPath(deps: Pick<PublishSuperMcpDeps, 'cwd'>): string {
  return path.join(superMcpDir(deps), 'dist', 'cli.js');
}

function formatResultError(result: NpmRunResult): string {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  if (stderr && stdout) return `${stderr}\n${stdout}`;
  return stderr || stdout || `npm exited ${result.status}`;
}

function parsePackageJson(raw: string, relativePath: string): SuperMcpPackageJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PublishSuperMcpError(
      'invalid-package-json',
      `Failed to parse ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new PublishSuperMcpError('invalid-package-json', `Expected ${relativePath} to contain a JSON object.`);
  }

  const record = parsed as Record<string, unknown>;
  if (record.name !== PACKAGE_NAME) {
    throw new PublishSuperMcpError(
      'wrong-package-name',
      `Expected ${relativePath} name to be ${JSON.stringify(PACKAGE_NAME)}, got ${JSON.stringify(record.name)}.`,
    );
  }
  if (typeof record.version !== 'string' || record.version.trim() === '') {
    throw new PublishSuperMcpError('invalid-package-version', `Expected ${relativePath} version to be a non-empty string.`);
  }
  if (!Array.isArray(record.files) || record.files.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new PublishSuperMcpError('invalid-package-files', `Expected ${relativePath} files to be a non-empty string array.`);
  }

  return {
    name: record.name,
    version: record.version,
    files: record.files as string[],
  };
}

function parseNpmViewVersion(result: NpmRunResult): string | null {
  if (result.status !== 0) {
    if (isNpmVersionNotFound(result)) return null;
    throw new PublishSuperMcpError('npm-view-failed', `npm view failed: ${formatResultError(result)}`);
  }

  const stdout = result.stdout.trim();
  if (stdout === '') {
    return null;
  }

  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (typeof parsed === 'string') return parsed;
    if (parsed === null) return null;
  } catch {
    return stdout.replace(/^"|"$/g, '');
  }

  throw new PublishSuperMcpError('npm-view-unexpected', `npm view returned unexpected JSON: ${stdout}`);
}

function isNpmVersionNotFound(result: NpmRunResult): boolean {
  const combined = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return (
    combined.includes('e404') ||
    combined.includes('404 not found') ||
    combined.includes('no matching version found') ||
    combined.includes('version not found')
  );
}

function isPublishConflict(result: NpmRunResult): boolean {
  const combined = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return (
    combined.includes('e409') ||
    combined.includes('conflict') ||
    combined.includes('previously published') ||
    combined.includes('cannot publish over the previously published versions') ||
    combined.includes('you cannot publish over the previously published versions')
  );
}

function parsePackFilePaths(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new PublishSuperMcpError(
      'npm-pack-invalid-json',
      `npm pack --dry-run --json returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new PublishSuperMcpError('npm-pack-invalid-json', 'npm pack --dry-run --json returned no tarball entries.');
  }

  const entries = parsed as NpmPackEntry[];
  const files = entries.flatMap((entry) => entry.files ?? []);
  const paths = files
    .map((entry) => entry.path)
    .filter((entry): entry is string => typeof entry === 'string')
    .map(normalizeTarballPath);
  if (paths.length === 0) {
    throw new PublishSuperMcpError('npm-pack-invalid-json', 'npm pack --dry-run --json returned no file paths.');
  }
  return paths;
}

function normalizeTarballPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^package\//, '').replace(/^\.\//, '');
}

function assertTarballContainsExpectedFiles(packageJson: SuperMcpPackageJson, packedFiles: readonly string[]): void {
  const missing: string[] = [];
  const fileSet = new Set(packedFiles.map(normalizeTarballPath));

  if (!fileSet.has('dist/cli.js')) {
    missing.push('dist/cli.js');
  }

  for (const declared of packageJson.files) {
    const normalized = normalizeTarballPath(declared).replace(/\/+$/, '');
    if (declared.endsWith('/') || declared.endsWith('/*')) {
      const prefix = `${normalized.replace(/\/\*$/, '')}/`;
      if (!packedFiles.some((filePath) => normalizeTarballPath(filePath).startsWith(prefix))) {
        missing.push(declared);
      }
      continue;
    }

    if (!fileSet.has(normalized)) {
      missing.push(declared);
    }
  }

  if (missing.length > 0) {
    throw new PublishSuperMcpError(
      'npm-pack-missing-files',
      `npm pack --dry-run is missing expected super-mcp-router files: ${missing.join(', ')}`,
    );
  }
}

async function readAndValidatePackage(deps: PublishSuperMcpDeps): Promise<SuperMcpPackageJson> {
  const relativePackagePath = path.relative(deps.cwd, packagePath(deps));
  const packageJson = parsePackageJson(await deps.readFile(packagePath(deps)), relativePackagePath);
  const generatedVersion = deps.generatedVersion ?? GENERATED_SUPER_MCP_ROUTER_VERSION;
  if (packageJson.version !== generatedVersion) {
    throw new PublishSuperMcpError(
      'generated-version-mismatch',
      `${relativePackagePath} version ${packageJson.version} does not match ` +
        `GENERATED_SUPER_MCP_ROUTER_VERSION ${generatedVersion}. Run npm run generate:super-mcp-version.`,
    );
  }
  return packageJson;
}

async function viewPublishedVersion(deps: PublishSuperMcpDeps, version: string): Promise<string | null> {
  const result = await deps.runNpm(['view', `${PACKAGE_NAME}@${version}`, 'version', '--json'], { cwd: deps.cwd });
  return parseNpmViewVersion(result);
}

async function assertPublishableTarball(deps: PublishSuperMcpDeps, packageJson: SuperMcpPackageJson): Promise<void> {
  const result = await deps.runNpm(['pack', '--dry-run', '--json'], { cwd: superMcpDir(deps) });
  if (result.status !== 0) {
    throw new PublishSuperMcpError('npm-pack-failed', `npm pack --dry-run failed: ${formatResultError(result)}`);
  }
  const packedFiles = parsePackFilePaths(result.stdout);
  assertTarballContainsExpectedFiles(packageJson, packedFiles);
}

export async function planPublishSuperMcp(
  deps: PublishSuperMcpDeps,
  _options: PublishSuperMcpOptions = {},
): Promise<PublishSuperMcpResult> {
  const packageJson = await readAndValidatePackage(deps);

  if (!(await deps.exists(distCliPath(deps)))) {
    throw new PublishSuperMcpError(
      'missing-dist-cli',
      `Missing ${path.relative(deps.cwd, distCliPath(deps))}. Run npm run build:super-mcp before publish preflight.`,
    );
  }

  const publishedVersion = await viewPublishedVersion(deps, packageJson.version);
  if (publishedVersion === packageJson.version) {
    return {
      status: 'already-published',
      version: packageJson.version,
      messages: [`SKIP already published ${PACKAGE_NAME}@${packageJson.version}`],
    };
  }
  if (publishedVersion !== null) {
    throw new PublishSuperMcpError(
      'npm-view-version-mismatch',
      `npm view ${PACKAGE_NAME}@${packageJson.version} returned ${publishedVersion}, expected ${packageJson.version}.`,
    );
  }

  await assertPublishableTarball(deps, packageJson);

  return {
    status: 'would-publish',
    version: packageJson.version,
    messages: [`would publish ${PACKAGE_NAME}@${packageJson.version}`],
  };
}

export async function publishSuperMcp(
  deps: PublishSuperMcpDeps,
  options: PublishSuperMcpOptions = {},
): Promise<PublishSuperMcpResult> {
  const plan = await planPublishSuperMcp(deps, options);
  if (plan.status === 'already-published') return plan;

  if (options.preflightOnly || options.dryRun) {
    return {
      status: options.preflightOnly ? 'would-publish' : 'dry-run',
      version: plan.version,
      messages: plan.messages,
    };
  }

  const publishResult = await deps.runNpm(['publish', '--provenance', '--access', 'public'], { cwd: superMcpDir(deps) });
  if (publishResult.status !== 0) {
    if (isPublishConflict(publishResult)) {
      const publishedAfterConflict = await viewPublishedVersion(deps, plan.version);
      if (publishedAfterConflict === plan.version) {
        return {
          status: 'published',
          version: plan.version,
          messages: [`SUCCESS already published by another runner ${PACKAGE_NAME}@${plan.version}`],
        };
      }
    }
    throw new PublishSuperMcpError('npm-publish-failed', `npm publish failed: ${formatResultError(publishResult)}`);
  }

  const messages = [`published ${PACKAGE_NAME}@${plan.version}`];
  if (options.verify) {
    await verifyPublishedVersion(deps, plan.version);
    messages.push(`verified ${PACKAGE_NAME}@${plan.version} on npm`);
  }

  return {
    status: 'published',
    version: plan.version,
    messages,
  };
}

async function verifyPublishedVersion(deps: PublishSuperMcpDeps, version: string): Promise<void> {
  const attempts = deps.verifyAttempts ?? VERIFY_ATTEMPTS;
  const delayMs = deps.verifyDelayMs ?? VERIFY_DELAY_MS;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const publishedVersion = await viewPublishedVersion(deps, version);
    if (publishedVersion === version) return;
    if (attempt < attempts) {
      await (deps.sleep ?? defaultSleep)(delayMs);
    }
  }
  throw new PublishSuperMcpError(
    'npm-verify-timeout',
    `Timed out waiting for ${PACKAGE_NAME}@${version} to appear on npm after ${attempts} attempts.`,
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCliArgs(argv: readonly string[]): PublishSuperMcpOptions {
  const options: PublishSuperMcpOptions = {
    dryRun: false,
    preflightOnly: false,
    verify: false,
    skipSmoke: false,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      (options as { dryRun: boolean }).dryRun = true;
    } else if (arg === '--preflight-only') {
      (options as { preflightOnly: boolean }).preflightOnly = true;
    } else if (arg === '--verify') {
      (options as { verify: boolean }).verify = true;
    } else if (arg === '--skip-smoke') {
      (options as { skipSmoke: boolean }).skipSmoke = true;
    } else {
      throw new PublishSuperMcpError(
        'invalid-args',
        `Unknown argument ${arg}. Supported flags: --dry-run, --preflight-only, --verify, --skip-smoke.`,
      );
    }
  }

  return options;
}

function createCliDeps(cwd: string): PublishSuperMcpDeps {
  return {
    cwd,
    runNpm: (args, opts) => {
      const result = spawnSync('npm', args, {
        cwd: opts.cwd,
        encoding: 'utf8',
      });
      return {
        status: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? (result.error ? result.error.message : ''),
      };
    },
    readFile: (filePath) => fs.readFileSync(filePath, 'utf8'),
    exists: (filePath) => fs.existsSync(filePath),
  };
}

async function main(): Promise<number> {
  const options = parseCliArgs(process.argv.slice(2));
  const deps = createCliDeps(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const result = await publishSuperMcp(deps, options);
  for (const message of result.messages) {
    process.stdout.write(`[publish-super-mcp] ${message}\n`);
  }
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main()
    .then((exitCode) => process.exit(exitCode))
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof PublishSuperMcpError ? err.code : 'unexpected';
      process.stderr.write(`[publish-super-mcp] FAIL ${code}: ${message}\n`);
      process.exit(1);
    });
}
