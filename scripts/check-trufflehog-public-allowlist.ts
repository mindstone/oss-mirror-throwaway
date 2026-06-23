#!/usr/bin/env tsx
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const scriptPath = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(scriptPath), '..');

const KNOWN_KINDS = ['corporate-inbox', 'public-test-key', 'public-fixture'] as const;
type PublicAllowlistKind = (typeof KNOWN_KINDS)[number];

const CORP_DOMAINS = new Set(['mindstone.com', 'mindstone.app']);
const CORPORATE_ROLE_LOCAL_PARTS = new Set([
  'support',
  'security',
  'legal',
  'press',
  'hello',
  'contact',
  'engineering',
  'privacy',
  'help',
  'info',
  'sales',
]);
const PUBLIC_TEST_KEY_PREFIXES = ['pk_test_', 'sk_test_', 'whsec_test_', 'rk_test_'] as const;
const PUBLIC_FIXTURE_DOMAINS = new Set(['example.com', 'example.org', 'example.net']);
const DOCUMENTATION_IPV4_CIDRS = new Set(['192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24']);
const DOCUMENTATION_IPV6_CIDRS = new Set(['2001:db8::/32']);
const KNOWN_KIND_SET = new Set<string>(KNOWN_KINDS);
const PUBLIC_TEST_KEY_PREFIX_SET = new Set<string>(PUBLIC_TEST_KEY_PREFIXES);

const EMAIL_RE = /^([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})$/iu;
const INTERNAL_SLACK_RE = /\bmindstone\.slack\.com\b/iu;
const INTERNAL_LINEAR_RE = /\blinear\.app\/mindstone\b/iu;
const SLACK_TOKEN_RE = /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/iu;
const PRODUCTION_TOKEN_RE = /\b(?:sk_live_|pk_live_|rk_live_|whsec_live_|ghp_[A-Za-z0-9]{20,})/iu;

interface CliOptions {
  readonly allowlistPath: string;
  readonly help: boolean;
}

export type TruffleHogPublicAllowlistFindingCode =
  | 'schema'
  | 'unknown-kind'
  | 'missing-kind'
  | 'unsafe-pattern'
  | 'corporate-inbox'
  | 'public-test-key'
  | 'public-fixture';

export interface TruffleHogPublicAllowlistFinding {
  readonly code: TruffleHogPublicAllowlistFindingCode;
  readonly entry: string;
  readonly detail: string;
}

export interface TruffleHogPublicAllowlistEntry {
  readonly kind: PublicAllowlistKind;
  readonly pattern: string;
  readonly reason?: string;
}

export interface TruffleHogPublicAllowlistResult {
  readonly ok: boolean;
  readonly entriesChecked: number;
  readonly findings: readonly TruffleHogPublicAllowlistFinding[];
}

export interface TruffleHogPublicAllowlistOptions {
  readonly repoRoot?: string;
  readonly allowlistPath?: string;
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: tsx scripts/check-trufflehog-public-allowlist.ts [--allowlist <path>] [--help]',
      '',
      'Validates .trufflehog-public-allowlist.yaml as a repo-side public-mirror',
      'governance allowlist. This file is not a TruffleHog --config file.',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv: readonly string[]): CliOptions {
  let allowlistPath = path.join(REPO_ROOT, '.trufflehog-public-allowlist.yaml');
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--allowlist') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --allowlist');
      allowlistPath = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { allowlistPath, help };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function entryLabel(index: number, pattern?: unknown): string {
  if (typeof pattern === 'string' && pattern.trim().length > 0) {
    return `allowlist[${index}] ${pattern}`;
  }
  return `allowlist[${index}]`;
}

function finding(
  code: TruffleHogPublicAllowlistFindingCode,
  entry: string,
  detail: string,
): TruffleHogPublicAllowlistFinding {
  return { code, entry, detail };
}

function normaliseDomain(value: string): string {
  return value.trim().toLowerCase();
}

function unsafePatternFinding(
  entry: string,
  value: string,
  fieldName: string,
): TruffleHogPublicAllowlistFinding | null {
  if (INTERNAL_SLACK_RE.test(value)) {
    return finding('unsafe-pattern', entry, `Internal Slack URLs are never public-mirror allowlist entries (${fieldName}).`);
  }
  if (INTERNAL_LINEAR_RE.test(value)) {
    return finding('unsafe-pattern', entry, `Internal Linear URLs are never public-mirror allowlist entries (${fieldName}).`);
  }
  if (SLACK_TOKEN_RE.test(value)) {
    return finding('unsafe-pattern', entry, `Slack-shaped token patterns are never public-mirror allowlist entries (${fieldName}).`);
  }
  if (PRODUCTION_TOKEN_RE.test(value)) {
    return finding('unsafe-pattern', entry, `Production token patterns are never public-mirror allowlist entries (${fieldName}).`);
  }
  return null;
}

function validateCorporateInbox(
  entry: string,
  pattern: string,
): TruffleHogPublicAllowlistFinding | null {
  const match = EMAIL_RE.exec(pattern);
  if (!match) {
    return finding('corporate-inbox', entry, 'corporate-inbox entries must be literal email addresses.');
  }

  const localPart = match[1].toLowerCase();
  const domain = normaliseDomain(match[2]);
  if (!CORP_DOMAINS.has(domain)) {
    return finding('corporate-inbox', entry, `Email domain "${domain}" is not in CORP_DOMAINS.`);
  }
  if (!CORPORATE_ROLE_LOCAL_PARTS.has(localPart)) {
    return finding('corporate-inbox', entry, `Email local-part "${localPart}" is not a recognised public role inbox.`);
  }
  return null;
}

function validatePublicTestKey(
  entry: string,
  pattern: string,
): TruffleHogPublicAllowlistFinding | null {
  // Exact-prefix only: the allowlist entry must BE one of the hardcoded public
  // test-key prefixes, never a full key. Otherwise a real (if non-production)
  // secret like `sk_test_<account secret>` would pass the governance gate.
  if (!PUBLIC_TEST_KEY_PREFIX_SET.has(pattern)) {
    return finding(
      'public-test-key',
      entry,
      `Test-key entry must be EXACTLY one of the public test-key prefixes (not a full key): ${PUBLIC_TEST_KEY_PREFIXES.join(', ')}.`,
    );
  }
  return null;
}

function domainFromFixture(pattern: string): string | null {
  const emailMatch = EMAIL_RE.exec(pattern);
  if (emailMatch) return normaliseDomain(emailMatch[2]);

  const withoutScheme = pattern.replace(/^https?:\/\//iu, '');
  const host = withoutScheme.split(/[/:?#]/u)[0]?.toLowerCase() ?? '';
  return host.length > 0 ? host : null;
}

function isDocumentationIPv4(pattern: string): boolean {
  if (DOCUMENTATION_IPV4_CIDRS.has(pattern)) return true;
  if (net.isIP(pattern) !== 4) return false;
  const [first, second, third] = pattern.split('.').map(Number);
  return (
    (first === 192 && second === 0 && third === 2) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  );
}

function isPublicFixture(pattern: string): boolean {
  const lowerPattern = pattern.toLowerCase();
  if (DOCUMENTATION_IPV6_CIDRS.has(lowerPattern)) return true;
  if (lowerPattern.startsWith('2001:db8:') || lowerPattern === '2001:db8::') return true;
  if (isDocumentationIPv4(lowerPattern)) return true;

  const domain = domainFromFixture(lowerPattern);
  return domain !== null && PUBLIC_FIXTURE_DOMAINS.has(domain);
}

function validatePublicFixture(
  entry: string,
  pattern: string,
): TruffleHogPublicAllowlistFinding | null {
  if (isPublicFixture(pattern)) return null;
  return finding(
    'public-fixture',
    entry,
    'Fixture pattern must be an example.com/org/net value or an IETF documentation IP range/address.',
  );
}

function validateEntry(index: number, rawEntry: unknown): TruffleHogPublicAllowlistFinding[] {
  if (!isRecord(rawEntry)) {
    return [finding('schema', `allowlist[${index}]`, 'Allowlist entries must be YAML objects.')];
  }

  const label = entryLabel(index, rawEntry.pattern);
  const rawKind = rawEntry.kind;
  const rawPattern = rawEntry.pattern;
  const rawReason = rawEntry.reason;
  const findings: TruffleHogPublicAllowlistFinding[] = [];

  if (typeof rawKind !== 'string' || rawKind.trim().length === 0) {
    findings.push(finding('missing-kind', label, 'Every allowlist entry must carry a kind discriminator.'));
  } else if (!KNOWN_KIND_SET.has(rawKind)) {
    findings.push(finding('unknown-kind', label, `Unknown kind "${rawKind}". Known kinds: ${KNOWN_KINDS.join(', ')}.`));
  }

  if (typeof rawPattern !== 'string' || rawPattern.trim().length === 0) {
    findings.push(finding('schema', label, 'Every allowlist entry must carry a non-empty string pattern.'));
    return findings;
  }

  const pattern = rawPattern.trim();
  const unsafeFinding = unsafePatternFinding(label, pattern, 'pattern');
  if (unsafeFinding) {
    findings.push(unsafeFinding);
  }
  if (rawReason !== undefined && typeof rawReason !== 'string') {
    findings.push(finding('schema', label, 'Optional reason must be a string when present.'));
  }
  if (typeof rawReason === 'string') {
    const unsafeReasonFinding = unsafePatternFinding(label, rawReason, 'reason');
    if (unsafeReasonFinding) findings.push(unsafeReasonFinding);
  }

  if (!KNOWN_KIND_SET.has(String(rawKind))) {
    return findings;
  }

  const kind = rawKind as PublicAllowlistKind;
  const kindFinding =
    kind === 'corporate-inbox'
      ? validateCorporateInbox(label, pattern)
      : kind === 'public-test-key'
        ? validatePublicTestKey(label, pattern)
        : validatePublicFixture(label, pattern);
  if (kindFinding) findings.push(kindFinding);

  return findings;
}

function parseAllowlistEntries(allowlistPath: string): unknown[] {
  const parsed = parseYaml(fs.readFileSync(allowlistPath, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error('Allowlist YAML root must be an object.');
  }
  if (parsed.version !== 1) {
    throw new Error('Allowlist YAML must declare version: 1.');
  }
  if (!Array.isArray(parsed.allowlist)) {
    throw new Error('Allowlist YAML must declare allowlist: as an array.');
  }
  return parsed.allowlist;
}

export function runTruffleHogPublicAllowlistCheck(
  options: TruffleHogPublicAllowlistOptions = {},
): TruffleHogPublicAllowlistResult {
  const repoRoot = path.resolve(options.repoRoot ?? REPO_ROOT);
  const allowlistPath = path.resolve(
    options.allowlistPath ?? path.join(repoRoot, '.trufflehog-public-allowlist.yaml'),
  );
  const entries = parseAllowlistEntries(allowlistPath);
  const findings = entries.flatMap((entry, index) => validateEntry(index, entry));

  return {
    ok: findings.length === 0,
    entriesChecked: entries.length,
    findings,
  };
}

function printResult(result: TruffleHogPublicAllowlistResult): void {
  if (result.findings.length > 0) {
    process.stderr.write('[check-trufflehog-public-allowlist] Public allowlist validation failed:\n');
    for (const resultFinding of result.findings) {
      process.stderr.write(
        `  - ${resultFinding.code} ${resultFinding.entry}: ${resultFinding.detail}\n`,
      );
    }
    return;
  }

  process.stdout.write(
    `[check-trufflehog-public-allowlist] OK (${result.entriesChecked} public-safe allowlist entr${result.entriesChecked === 1 ? 'y' : 'ies'}).\n`,
  );
}

export function main(argv: readonly string[]): number {
  let args: CliOptions;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[check-trufflehog-public-allowlist] ${message}\n`);
    printUsage();
    return 1;
  }

  if (args.help) {
    printUsage();
    return 0;
  }

  try {
    const result = runTruffleHogPublicAllowlistCheck({ allowlistPath: args.allowlistPath });
    printResult(result);
    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[check-trufflehog-public-allowlist] ${message}\n`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === scriptPath;

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
