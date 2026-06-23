#!/usr/bin/env tsx
/**
 * Agent-driven OSS MCP release pipeline.
 *
 * Single command: `npm run mcp:release <connector-name>`.
 *
 * Drives a 9-stage state machine end-to-end with a durable ledger at
 * `<repo>/.cache/mcp-releases/<id>.json` so the agent can resume from any
 * partial failure with `--resume <id>`.
 *
 * Recovery for externally-landed bumps (e.g. a version bump merged via PR on
 * mcp-servers, skipping this script): `npm run mcp:release -- --reconcile
 * <connector-name>`. Seeds a fresh ledger at stage "version-bumped" from the
 * already-merged submodule state, then re-runs every remaining gate (§13,
 * build/test, publish verification, catalog pin, validate, push). This
 * replaces the old hand-seeded-ledger recipe (see
 * docs/plans/260611_mcp-landing-process/PLAN.md, Decision Log 13:15).
 *
 * See:
 *  - docs/plans/260525_oss_release_automation.md (v2) — design and decisions
 *  - docs/project/MCP_OSS_RELEASE_AGENT_DRIVEN.md — colleague-facing runbook
 *
 * Non-goals for this version:
 *  - Multi-agent contention guard (deferred YAGNI)
 *  - Slack notification (deferred until a release notification path exists)
 *  - --abort subcommand (deferred until needed)
 *
 * Stages (collapsed from v1 11 -> v2 9):
 *  0. preflight
 *  1. version-bumped (lockstep bump delegated to the submodule's
 *     scripts/bump-connector.mjs — the single bump implementation, shared
 *     with the CONTRIBUTING.md bootstrap recipe — then §13 gate + build/test
 *     + Release-Gate-trailer-stamped commit here)
 *  2. submodule-pushed (prompt for push auth, push to mcp-servers/main)
 *  3. workflow-triggered (find Actions run via gh CLI)
 *  4. workflow-success (gh run watch)
 *  5. published-verified (npm propagation + audit signatures + npx smoke + registry)
 *  6. catalog-updated (catalog pin + submodule pointer atomic commit)
 *  7. validate-fast-passed (npm run validate:fast)
 *  8. dev-pushed (prompt for push auth, push via git-safe-sync.ts --no-advance-submodules)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as readline from 'node:readline/promises';
import { execSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { parseArgs } from 'node:util';
import { getMapping, listConnectorNames, type ConnectorReleaseMapping } from './mcp-release-catalog-mapping';

const REPO_ROOT = path.resolve(__dirname, '..');
const LEDGER_DIR = path.join(REPO_ROOT, '.cache', 'mcp-releases');
const SUBMODULE_DIR = path.join(REPO_ROOT, 'mcp-servers');
const SECURITY_REVIEW_DIR = path.join(REPO_ROOT, 'docs-private', 'reports', 'security-reviews');

type StageId =
  | 'preflight'
  | 'version-bumped'
  | 'submodule-pushed'
  | 'workflow-triggered'
  | 'workflow-success'
  | 'published-verified'
  | 'catalog-updated'
  | 'validate-fast-passed'
  | 'dev-pushed'
  | 'complete';

const STAGE_ORDER: StageId[] = [
  'preflight',
  'version-bumped',
  'submodule-pushed',
  'workflow-triggered',
  'workflow-success',
  'published-verified',
  'catalog-updated',
  'validate-fast-passed',
  'dev-pushed',
  'complete',
];

export interface Ledger {
  id: string;
  connectorName: string;
  startedAt: string;
  updatedAt: string;
  stage: StageId;
  fromVersion: string | null;
  toVersion: string | null;
  releaseCommitSha?: string;
  workflowRunId?: string;
  catalogCommitSha?: string;
  securityReviewPath?: string;
  securityReviewSha256?: string;
  /** True for ledgers seeded by --reconcile (externally-merged bump). Gates
   * the fail-loud reconcile preconditions in Stage 1/3 across --resume. */
  reconcile?: boolean;
  errors: Array<{ stage: StageId; error: string; at: string }>;
}

export type PushStage = 'submodule-pushed' | 'dev-pushed';

// --- Ledger -----------------------------------------------------------------

function ensureLedgerDir(): void {
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
}

export function assertSafeLedgerId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]*-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{4}$/.test(id)) {
    throw new Error(`Invalid release ledger id: ${id}`);
  }
}

function ledgerPath(id: string): string {
  assertSafeLedgerId(id);
  const resolvedDir = fs.realpathSync(LEDGER_DIR);
  const resolvedPath = path.resolve(LEDGER_DIR, `${id}.json`);
  if (!resolvedPath.startsWith(`${resolvedDir}${path.sep}`)) {
    throw new Error(`Release ledger path escapes ${LEDGER_DIR}: ${resolvedPath}`);
  }
  return resolvedPath;
}

/**
 * Single source of truth for release ledger ids. `--reconcile` reuses this
 * rather than hand-constructing an id, so seeded ledgers always satisfy
 * `assertSafeLedgerId` (the hand-seeding trap from the retell-ai@0.2.3
 * reconcile — PLAN.md Decision Log 13:15 (a)).
 */
export function generateLedgerId(connectorName: string): string {
  return `${connectorName}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(2).toString('hex')}`;
}

function newLedger(connectorName: string): Ledger {
  const id = generateLedgerId(connectorName);
  const now = new Date().toISOString();
  return {
    id,
    connectorName,
    startedAt: now,
    updatedAt: now,
    stage: 'preflight',
    fromVersion: null,
    toVersion: null,
    errors: [],
  };
}

function readLedger(id: string): Ledger {
  const raw = fs.readFileSync(ledgerPath(id), 'utf8');
  return parseLedger(JSON.parse(raw));
}

function writeLedger(ledger: Ledger): void {
  ledger.updatedAt = new Date().toISOString();
  const target = ledgerPath(ledger.id);
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmp, target);
}

function recordError(ledger: Ledger, stage: StageId, error: unknown): void {
  ledger.errors.push({
    stage,
    error: error instanceof Error ? error.message : String(error),
    at: new Date().toISOString(),
  });
  writeLedger(ledger);
}

function advanceStage(ledger: Ledger, to: StageId): void {
  ledger.stage = to;
  writeLedger(ledger);
  console.log(`\n>>> Advanced to stage: ${to}`);
}

// --- Shell helpers ----------------------------------------------------------

function sh(cmd: string, opts: { cwd?: string; stdio?: 'pipe' | 'inherit' } = {}): string {
  return execSync(cmd, {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    stdio: opts.stdio ?? 'pipe',
  }).trim();
}

function spawnBlocking(cmd: string, args: string[], opts: { cwd?: string } = {}): SpawnSyncReturns<string> {
  return spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
  });
}

/**
 * True iff `ancestor` is an ancestor of (or equal to) `descendant`.
 * Exit 0 = ancestor, exit 1 = not an ancestor; anything else (e.g. unknown
 * SHA) is a real error and throws rather than silently returning false.
 */
export function isCommitAncestor(ancestor: string, descendant: string, cwd: string): boolean {
  // git-exec-allow: exit-code-only probe (no stdout to buffer); needs tri-state status 0/1/other which gitCapture does not expose
  const r = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new Error(
    `git merge-base --is-ancestor ${ancestor} ${descendant} failed (exit ${r.status}): ${r.stderr?.trim()}`,
  );
}

async function confirm(prompt: string): Promise<boolean> {
  if (process.env.MCP_RELEASE_AUTO_APPROVE === '1') {
    console.log(`(MCP_RELEASE_AUTO_APPROVE=1) auto-approving: ${prompt}`);
    return true;
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      `Cannot prompt: stdin is not a TTY. Set MCP_RELEASE_AUTO_APPROVE=1 if you trust this context. (Prompt was: ${prompt})`,
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${prompt} [y/N] `);
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

async function confirmPush(stage: PushStage, ledger: Ledger, prompt: string): Promise<boolean> {
  const expected = pushApprovalToken(stage, ledger);
  if (process.env.MCP_RELEASE_AUTO_APPROVE === '1') {
    console.log(
      `(MCP_RELEASE_AUTO_APPROVE=1) does not approve push stages. ` +
        `Set MCP_RELEASE_PUSH_APPROVAL="${expected}" for this one push if you trust this context.`,
    );
  }

  const decision = evaluatePushApproval({
    stage,
    ledger,
    pushApprovalEnv: process.env.MCP_RELEASE_PUSH_APPROVAL,
    isTTY: process.stdin.isTTY === true,
  });
  switch (decision.kind) {
    case 'approved':
      console.log(`(MCP_RELEASE_PUSH_APPROVAL) approved ${stage}`);
      return true;
    case 'rejected-non-tty':
      throw new Error(
        `Cannot prompt for ${stage}: stdin is not a TTY. ` +
          `If you trust this exact release state, resume with MCP_RELEASE_PUSH_APPROVAL="${decision.expectedToken}".`,
      );
    case 'needs-prompt':
      break;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${prompt} [y/N] `);
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

export type PushApprovalDecision =
  | { kind: 'approved' }
  | { kind: 'needs-prompt' }
  | { kind: 'rejected-non-tty'; expectedToken: string };

export function evaluatePushApproval(args: {
  stage: PushStage;
  ledger: Ledger;
  pushApprovalEnv: string | undefined;
  isTTY: boolean;
}): PushApprovalDecision {
  const expected = pushApprovalToken(args.stage, args.ledger);
  if (args.pushApprovalEnv === expected) return { kind: 'approved' };
  if (!args.isTTY) return { kind: 'rejected-non-tty', expectedToken: expected };
  return { kind: 'needs-prompt' };
}

export function pushApprovalToken(stage: PushStage, ledger: Ledger): string {
  const sha = stage === 'submodule-pushed' ? ledger.releaseCommitSha : ledger.catalogCommitSha;
  if (!sha) {
    throw new Error(`Cannot compute ${stage} approval token: missing commit SHA`);
  }
  return `${ledger.id}:${stage}:${sha}`;
}

function parseLedger(value: unknown): Ledger {
  const record = asRecord(value);
  if (!record) throw new Error('Invalid release ledger: expected object');

  const id = requiredString(record, 'id');
  assertSafeLedgerId(id);
  const connectorName = requiredString(record, 'connectorName');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(connectorName)) {
    throw new Error(`Invalid release ledger connectorName: ${connectorName}`);
  }
  const stage = requiredString(record, 'stage') as StageId;
  if (!STAGE_ORDER.includes(stage)) {
    throw new Error(`Invalid release ledger stage: ${stage}`);
  }

  const fromVersion = nullableString(record, 'fromVersion');
  const toVersion = nullableString(record, 'toVersion');
  if (fromVersion !== null) assertSemver(fromVersion, 'fromVersion');
  if (toVersion !== null) assertSemver(toVersion, 'toVersion');

  const errors = record.errors;
  if (!Array.isArray(errors)) throw new Error('Invalid release ledger errors: expected array');

  const ledger: Ledger = {
    id,
    connectorName,
    startedAt: requiredIsoString(record, 'startedAt'),
    updatedAt: requiredIsoString(record, 'updatedAt'),
    stage,
    fromVersion,
    toVersion,
    errors: errors.map(parseLedgerError),
  };

  const releaseCommitSha = optionalSha(record, 'releaseCommitSha');
  if (releaseCommitSha) ledger.releaseCommitSha = releaseCommitSha;
  const workflowRunId = optionalString(record, 'workflowRunId');
  if (workflowRunId) {
    if (!/^\d+$/.test(workflowRunId)) throw new Error(`Invalid release ledger workflowRunId: ${workflowRunId}`);
    ledger.workflowRunId = workflowRunId;
  }
  const catalogCommitSha = optionalSha(record, 'catalogCommitSha');
  if (catalogCommitSha) ledger.catalogCommitSha = catalogCommitSha;
  const securityReviewPath = optionalString(record, 'securityReviewPath');
  if (securityReviewPath) ledger.securityReviewPath = securityReviewPath;
  const securityReviewSha256 = optionalString(record, 'securityReviewSha256');
  if (securityReviewSha256) {
    if (!/^[a-f0-9]{64}$/.test(securityReviewSha256)) {
      throw new Error(`Invalid release ledger securityReviewSha256: ${securityReviewSha256}`);
    }
    ledger.securityReviewSha256 = securityReviewSha256;
  }
  const reconcile = record.reconcile;
  if (reconcile !== undefined) {
    if (typeof reconcile !== 'boolean') {
      throw new Error('Invalid release ledger reconcile: expected boolean when present');
    }
    if (reconcile) ledger.reconcile = true;
  }

  const stageIndex = STAGE_ORDER.indexOf(stage);
  if (stageIndex > STAGE_ORDER.indexOf('preflight') && !ledger.toVersion) {
    throw new Error(`Invalid release ledger: stage ${stage} requires toVersion`);
  }
  if (stageIndex > STAGE_ORDER.indexOf('version-bumped') && !ledger.releaseCommitSha) {
    throw new Error(`Invalid release ledger: stage ${stage} requires releaseCommitSha`);
  }
  if (stageIndex > STAGE_ORDER.indexOf('workflow-triggered') && !ledger.workflowRunId) {
    throw new Error(`Invalid release ledger: stage ${stage} requires workflowRunId`);
  }
  if (stageIndex > STAGE_ORDER.indexOf('catalog-updated') && !ledger.catalogCommitSha) {
    throw new Error(`Invalid release ledger: stage ${stage} requires catalogCommitSha`);
  }

  return ledger;
}

function parseLedgerError(value: unknown): { stage: StageId; error: string; at: string } {
  const record = asRecord(value);
  if (!record) throw new Error('Invalid release ledger error: expected object');
  const stage = requiredString(record, 'stage') as StageId;
  if (!STAGE_ORDER.includes(stage)) throw new Error(`Invalid release ledger error stage: ${stage}`);
  return {
    stage,
    error: requiredString(record, 'error'),
    at: requiredIsoString(record, 'at'),
  };
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid release ledger: ${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid release ledger: ${key} must be a non-empty string when present`);
  }
  return value;
}

function nullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid release ledger: ${key} must be a string or null`);
  }
  return value;
}

function requiredIsoString(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid release ledger: ${key} must be an ISO timestamp`);
  }
  return value;
}

function optionalSha(record: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(record, key);
  if (!value) return undefined;
  if (!/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(`Invalid release ledger ${key}: ${value}`);
  }
  return value;
}

function assertSemver(version: string, label: string): void {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid ${label}: ${version}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function registryEntryMatches(entry: unknown, registryName: string, version: string): boolean {
  const record = asRecord(entry);
  const nestedServer = asRecord(record?.server);
  const versionDetail = asRecord(record?.versionDetail);

  const name =
    stringField(nestedServer, 'name') ??
    stringField(record, 'name');
  const entryVersion =
    stringField(nestedServer, 'version') ??
    stringField(versionDetail, 'version') ??
    stringField(record, 'version');

  return name === registryName && entryVersion === version;
}

function registryResponseMatches(response: unknown, registryName: string, version: string): boolean {
  if (registryEntryMatches(response, registryName, version)) return true;

  const record = asRecord(response);
  const servers = record?.servers;
  return Array.isArray(servers) && servers.some((server) => registryEntryMatches(server, registryName, version));
}

function verifySecurityReviewGate(
  mapping: ConnectorReleaseMapping,
  version: string,
  reviewPathFlag: string | undefined,
): { path: string; sha256: string } {
  assertSecurityReviewNotSkipped();

  const reviewPath = resolveSecurityReviewPath(mapping, version, reviewPathFlag);
  const review = fs.readFileSync(reviewPath, 'utf8');
  const relativePath = path.relative(REPO_ROOT, reviewPath);

  validateSecurityReviewGateFields(
    extractReviewGateFields(review),
    { connector: mapping.name, npmPackage: mapping.npmPackage, version },
    relativePath,
  );

  console.log(`Security review gate passed: ${relativePath}`);
  return {
    path: relativePath,
    sha256: crypto.createHash('sha256').update(review).digest('hex'),
  };
}

export function assertSecurityReviewNotSkipped(env: NodeJS.ProcessEnv = process.env): void {
  if (env.MCP_RELEASE_SKIP_SECURITY_REVIEW === '1') {
    throw new Error(
      'MCP_RELEASE_SKIP_SECURITY_REVIEW is no longer supported. ' +
        'Every agent-driven connector release requires a security review artifact.',
    );
  }
}

/**
 * Pure gate-block validation (extracted for unit testing).
 *
 * §13 AI-only contract (PLAN.md Decision Log 2026-06-11 13:20): new artifacts
 * carry `Author-Model`, `Adversarial-Model` (different model family),
 * `Adversarial-Verdict: UPHELD` (or `UPHELD-WITH-ADDENDA`), and
 * `Release-Authorized-By` (operator name or standing-policy ref). Legacy
 * artifacts that predate the AI-only revision carry `Human-Signoff` instead;
 * it is accepted as an alias for `Release-Authorized-By`, and the model/
 * verdict fields are NOT required for those (they predate the fields).
 */
export function validateSecurityReviewGateFields(
  gate: Map<string, string>,
  expected: { connector: string; npmPackage: string; version: string },
  relativePath: string,
): void {
  const gateStatus = gate.get('security-review-gate');
  if (gateStatus !== 'Approved' && gateStatus !== 'Approved-with-deferred-findings') {
    throw new Error(
      `${relativePath} must contain "Security-Review-Gate: Approved" or ` +
        `"Security-Review-Gate: Approved-with-deferred-findings"`,
    );
  }
  requireGateField(gate, 'connector', expected.connector, relativePath);
  requireGateField(gate, 'package', expected.npmPackage, relativePath);
  requireGateField(gate, 'version', expected.version, relativePath);
  requireGateField(gate, 'critical-findings-open', '0', relativePath);
  requireGateField(gate, 'high-findings-open', '0', relativePath);

  validateReleaseAuthorization(gate, relativePath);
}

const GATE_PLACEHOLDER_RE = /^(n\/?a|pending|todo)$/i;

function isPlaceholderGateValue(value: string | undefined): boolean {
  return !value || GATE_PLACEHOLDER_RE.test(value.trim());
}

/**
 * Model family by prefix (leading alphabetic token of the model id):
 * `claude-fable-5` -> claude, `gpt-5.5` -> gpt, `gemini-2.5-pro` -> gemini.
 * Used to enforce cross-family adversarial review (author vs adversarial
 * model must differ by family, not just by id).
 */
export function modelFamily(modelId: string): string {
  const normalized = modelId.trim().replace(/^`+|`+$/g, '').toLowerCase();
  const match = normalized.match(/^[a-z]+/);
  return match ? match[0] : normalized;
}

function validateReleaseAuthorization(gate: Map<string, string>, relativePath: string): void {
  const authorizedBy = gate.get('release-authorized-by');
  const legacySignoff = gate.get('human-signoff');
  const authorization = authorizedBy ?? legacySignoff;
  if (isPlaceholderGateValue(authorization)) {
    throw new Error(
      `${relativePath} must contain a non-empty "Release-Authorized-By" ` +
        `(operator name or standing-policy reference; legacy artifacts may use "Human-Signoff" instead)`,
    );
  }

  const authorModel = gate.get('author-model');
  const adversarialModel = gate.get('adversarial-model');
  const adversarialVerdict = gate.get('adversarial-verdict');

  // Legacy artifact: Human-Signoff only, no AI-only fields at all. These
  // predate the §13 AI-only revision and stay valid as-is. The presence of
  // ANY new-format field (including Adversarial-Verdict alone) means partial
  // adoption — validated fully below, fail-loud.
  const isLegacyArtifact =
    authorizedBy === undefined &&
    authorModel === undefined &&
    adversarialModel === undefined &&
    adversarialVerdict === undefined;
  if (isLegacyArtifact) return;

  // New-format artifact (or partial adoption — validated fully, fail-loud).
  if (isPlaceholderGateValue(authorModel)) {
    throw new Error(`${relativePath} must contain a non-empty "Author-Model" (e.g. claude-fable-5)`);
  }
  if (isPlaceholderGateValue(adversarialModel)) {
    throw new Error(
      `${relativePath} must contain a non-empty "Adversarial-Model" — ` +
        `§13 requires a cross-family adversarial review pass before release`,
    );
  }
  const authorFamily = modelFamily(authorModel!);
  const adversarialFamily = modelFamily(adversarialModel!);
  if (authorFamily === adversarialFamily) {
    throw new Error(
      `${relativePath}: Adversarial-Model (${adversarialModel}) must be a DIFFERENT model family ` +
        `than Author-Model (${authorModel}) — both resolve to family "${authorFamily}". ` +
        `§13 requires cross-family adversarial review (e.g. claude-* author + gpt-* adversarial).`,
    );
  }
  const verdict = (adversarialVerdict ?? '').trim().replace(/^`+|`+$/g, '').toUpperCase();
  if (verdict !== 'UPHELD' && verdict !== 'UPHELD-WITH-ADDENDA') {
    throw new Error(
      `${relativePath} must contain "Adversarial-Verdict: UPHELD" (or "UPHELD-WITH-ADDENDA") ` +
        `(got ${adversarialVerdict ?? 'missing'}). ` +
        `A release cannot proceed until the cross-family adversarial pass upholds the review.`,
    );
  }
}

function resolveSecurityReviewPath(
  mapping: ConnectorReleaseMapping,
  version: string,
  reviewPathFlag: string | undefined,
): string {
  const candidate = reviewPathFlag
    ? path.resolve(REPO_ROOT, reviewPathFlag)
    : findDefaultSecurityReview(mapping, version);
  const resolvedReviewDir = fs.realpathSync(SECURITY_REVIEW_DIR);
  const resolvedCandidate = fs.realpathSync(candidate);
  if (!resolvedCandidate.startsWith(`${resolvedReviewDir}${path.sep}`)) {
    throw new Error(
      `Security review must live under ${path.relative(REPO_ROOT, SECURITY_REVIEW_DIR)}: ` +
        path.relative(REPO_ROOT, resolvedCandidate),
    );
  }
  return resolvedCandidate;
}

function findDefaultSecurityReview(mapping: ConnectorReleaseMapping, version: string): string {
  if (!fs.existsSync(SECURITY_REVIEW_DIR)) {
    throw new Error(`Security review directory is missing: ${SECURITY_REVIEW_DIR}`);
  }
  const suffix = `_${mapping.name}_${version}.md`;
  const matches = fs
    .readdirSync(SECURITY_REVIEW_DIR)
    .filter((name) => name.endsWith(suffix))
    .map((name) => path.join(SECURITY_REVIEW_DIR, name));
  if (matches.length === 0) {
    throw new Error(
      `Missing security review for ${mapping.npmPackage}@${version}. ` +
        `Expected docs-private/reports/security-reviews/<yyMMdd>_${mapping.name}_${version}.md, ` +
        `or pass --security-review=<path>.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple security reviews match ${mapping.name}@${version}; pass --security-review=<path> explicitly:\n` +
        matches.map((match) => `  - ${path.relative(REPO_ROOT, match)}`).join('\n'),
    );
  }
  return matches[0]!;
}

const RELEASE_GATE_HEADER_RE = /^##\s+Release Gate\s*$/;
const MARKDOWN_SECTION_RE = /^##\s/;

/**
 * Parse the machine-readable gate fields from a §13 review.
 *
 * Scoped to the `## Release Gate` section when the artifact has one (every
 * current/future artifact does). This matters: parsing the whole document
 * lets a later prose line like `- Version: 0.2.4 (security fix on top of
 * 0.2.3)` silently OVERWRITE the gate-block `Version: 0.2.4` under last-wins
 * Map semantics, failing an otherwise-valid release (it cost 3 retries
 * shipping retell-ai 0.2.4). Within the scoped block we keep FIRST-wins so the
 * clean leading field list always beats any prose mention lower in the same
 * section (e.g. an "Adversarial pass …" parenthetical). When no `## Release
 * Gate` header is present we fall back to whole-document parsing — the older
 * pre-gate-block artifacts have no header and must still validate if ever
 * re-checked. See docs/plans/260611_s13-version-scan-fix.
 */
export function extractReviewGateFields(review: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = review.split(/\r?\n/);

  const headerIdx = lines.findIndex((l) => RELEASE_GATE_HEADER_RE.test(l));
  const scoped = headerIdx !== -1;
  let start = 0;
  let end = lines.length;
  if (scoped) {
    start = headerIdx + 1;
    const rel = lines.slice(start).findIndex((l) => MARKDOWN_SECTION_RE.test(l));
    end = rel === -1 ? lines.length : start + rel;
  }

  for (let i = start; i < end; i++) {
    const line = lines[i].replace(/^\s*[-*]\s*/, '').trim();
    const match = line.match(/^\*{0,2}([A-Za-z][A-Za-z-]+)\*{0,2}:\s*(.+?)\s*$/);
    if (match) {
      const key = match[1].toLowerCase();
      // Inside an exact scoped block: FIRST-wins, so the clean leading field
      // list beats any later prose mention in the same section. In the
      // whole-document fallback (no exact header — only pre-gate-block legacy
      // artifacts) we KEEP last-wins: that preserves legacy behavior exactly
      // and avoids a new under-block path where a malformed near-miss-header
      // artifact passes on an early prose value while ignoring a later, wrong
      // gate block. (Reviewer F1, s13-version-scan-fix.)
      if (scoped && fields.has(key)) continue;
      fields.set(key, match[2]);
    }
  }
  return fields;
}

function requireGateField(
  fields: Map<string, string>,
  key: string,
  expected: string,
  relativePath: string,
): void {
  const actual = fields.get(key);
  if (actual !== expected) {
    throw new Error(`${relativePath} must contain "${key}: ${expected}" (got ${actual ?? 'missing'})`);
  }
}

// --- Release-Gate trailer (Stage 5′) -----------------------------------------
//
// Every release commit created by this script is stamped with a git trailer
//   Release-Gate: <repo-relative-review-path>#<sha256-hex64>
// binding the commit to the exact §13 review artifact that gated it
// (PLAN.md Decision Log 2026-06-11 13:20). Public mcp-servers CI validates
// FORMAT only (docs-private is unreachable there, by design); the Rebel-side
// audit below validates path + hash against the actual private artifact.

export type ReleaseGateTrailer =
  | { kind: 'absent' }
  | { kind: 'malformed'; raw: string }
  | { kind: 'present'; path: string; sha256: string };

// Mirrors the public gate's TRAILER_RE in
// mcp-servers/.github/workflows/release.yml exactly (single space after the
// colon, docs-private/reports/security-reviews/ prefix, path segments of
// [A-Za-z0-9._-] that never start with "." — which also excludes ".." traversal
// and empty segments — a .md suffix, and a lowercase 64-hex sha256). Rebel-side
// must never accept (or stamp) what the public gate refuses, so this grammar is
// deliberately the NARROWER of the two and a parity test in
// scripts/__tests__/mcp-release.test.ts extracts the workflow regex and asserts
// identical verdicts over a shared fixture list — grammar drift fails tests
// here instead of blocking a release post-push.
const RELEASE_GATE_TRAILER_RE =
  /^Release-Gate: (docs-private\/reports\/security-reviews\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.md)#([a-f0-9]{64})$/;

export function formatReleaseGateTrailer(reviewPath: string, sha256: string): string {
  const trailer = `Release-Gate: ${reviewPath}#${sha256}`;
  // Fail closed BEFORE the release commit exists: a trailer the public
  // mcp-servers workflow gate would refuse must never be stamped (e.g. a
  // custom --security-review filename with characters outside the public
  // grammar, or a non-lowercase-hex hash).
  if (!RELEASE_GATE_TRAILER_RE.test(trailer)) {
    throw new Error(
      `Refusing to stamp a Release-Gate trailer the public mcp-servers release gate would reject: ` +
        `"${trailer}". The review path must live under docs-private/reports/security-reviews/, ` +
        `use only [A-Za-z0-9._-] characters with no segment starting with ".", end in .md, and ` +
        `the hash must be 64 lowercase hex chars. ` +
        `See TRAILER_RE in mcp-servers/.github/workflows/release.yml.`,
    );
  }
  return trailer;
}

export function parseReleaseGateTrailer(commitMessage: string): ReleaseGateTrailer {
  const line = commitMessage.split(/\r?\n/).find((l) => l.trim().startsWith('Release-Gate:'));
  if (line === undefined) return { kind: 'absent' };
  // Match the RAW line, not a trimmed copy: the public gate's grep is
  // line-anchored, so leading/trailing whitespace must read as malformed here
  // too. (The path grammar itself already rejects traversal and empty
  // segments; the audit never reads from this untrusted path anyway — it uses
  // the ledger's own path.)
  const match = line.match(RELEASE_GATE_TRAILER_RE);
  if (!match) return { kind: 'malformed', raw: line.trim() };
  return { kind: 'present', path: match[1], sha256: match[2] };
}

export type ReleaseGateAuditResult =
  | { status: 'ok' }
  | { status: 'warn-absent'; note: string }
  | { status: 'fail'; reason: string };

/**
 * Pure audit verdict for the Release-Gate trailer on a release commit
 * (extracted for unit testing; fs/git plumbing lives in
 * auditReleaseGateTrailer).
 *
 * Absent trailer = structured WARNING, not failure: commits merged before
 * Stage 5′ stamping landed (e.g. retell-ai@0.2.3, reconciled externally)
 * cannot be retro-stamped — rewriting a merged public commit is off the
 * table — so the Rebel-side audit record (release ledger + committed §13
 * artifact) covers those. Trailer present but wrong = fail loud.
 */
export function assessReleaseGateAudit(args: {
  trailer: ReleaseGateTrailer;
  ledgerReviewPath: string | undefined;
  recomputedSha256: string | undefined;
}): ReleaseGateAuditResult {
  const { trailer, ledgerReviewPath, recomputedSha256 } = args;
  if (trailer.kind === 'absent') {
    return {
      status: 'warn-absent',
      note:
        'Release commit carries no Release-Gate trailer. It predates Stage 5′ stamping ' +
        '(or was merged externally and reconciled via --reconcile). The script cannot ' +
        'retro-stamp an already-merged commit; the release ledger plus the committed ' +
        '§13 review artifact are the audit record for this release.',
    };
  }
  if (trailer.kind === 'malformed') {
    return {
      status: 'fail',
      reason:
        `Release-Gate trailer is malformed: "${trailer.raw}". ` +
        'Expected "Release-Gate: <repo-relative-review-path>#<sha256-hex64>".',
    };
  }
  if (!ledgerReviewPath) {
    return {
      status: 'fail',
      reason: 'Release-Gate trailer present but the ledger has no securityReviewPath to audit against.',
    };
  }
  if (trailer.path !== ledgerReviewPath) {
    return {
      status: 'fail',
      reason:
        `Release-Gate trailer points at "${trailer.path}" but this release's §13 review is ` +
        `"${ledgerReviewPath}". The release commit was stamped against a different artifact.`,
    };
  }
  if (!recomputedSha256) {
    return {
      status: 'fail',
      reason:
        `Release-Gate trailer references ${trailer.path} but that artifact is missing locally; ` +
        'cannot recompute its sha256. Restore/commit the review artifact, then resume.',
    };
  }
  if (trailer.sha256 !== recomputedSha256) {
    return {
      status: 'fail',
      reason:
        `Release-Gate trailer hash MISMATCH for ${trailer.path}:\n` +
        `  trailer:    ${trailer.sha256}\n` +
        `  recomputed: ${recomputedSha256}\n` +
        'The review artifact changed after the release commit was stamped (or the trailer was ' +
        'forged). Do NOT proceed: investigate, restore the reviewed artifact (or re-review and ' +
        'start a fresh release ledger).',
    };
  }
  return { status: 'ok' };
}

/**
 * Rebel-side post-publish audit (Stage 5′, second half): verify the
 * Release-Gate trailer on the release commit against the local docs-private
 * review artifact. Called from Stage 6, where the release commit is known
 * and is about to be pinned into the Rebel catalog commit.
 */
function auditReleaseGateTrailer(ledger: Ledger): void {
  if (!ledger.releaseCommitSha) {
    throw new Error('Ledger missing releaseCommitSha; cannot audit Release-Gate trailer');
  }
  const message = sh(`git log -1 --format=%B ${ledger.releaseCommitSha}`, { cwd: SUBMODULE_DIR });
  const trailer = parseReleaseGateTrailer(message);

  let recomputedSha256: string | undefined;
  if (trailer.kind === 'present' && ledger.securityReviewPath) {
    const artifactPath = path.join(REPO_ROOT, ledger.securityReviewPath);
    if (fs.existsSync(artifactPath)) {
      recomputedSha256 = crypto
        .createHash('sha256')
        .update(fs.readFileSync(artifactPath))
        .digest('hex');
    }
  }

  const result = assessReleaseGateAudit({
    trailer,
    ledgerReviewPath: ledger.securityReviewPath,
    recomputedSha256,
  });
  if (result.status === 'warn-absent') {
    console.warn(
      `[release-gate-audit] ${JSON.stringify({
        result: 'absent-trailer',
        connector: ledger.connectorName,
        releaseCommitSha: ledger.releaseCommitSha,
        note: result.note,
      })}`,
    );
    return;
  }
  if (result.status === 'fail') {
    throw new Error(`Release-Gate trailer audit failed for ${ledger.releaseCommitSha}: ${result.reason}`);
  }
  console.log(`Release-Gate trailer audit passed: ${ledger.securityReviewPath}`);
}

// --- Stage 0: preflight -----------------------------------------------------

async function stagePreflight(
  ledger: Ledger,
  mapping: ConnectorReleaseMapping,
  flags: ReleaseFlags,
): Promise<void> {
  // Required flags for fresh release
  if (!flags.description || flags.description.trim().length === 0) {
    throw new Error(
      'Missing --description="...". Provide a one-line CHANGELOG entry that describes what changed in this release. Example: --description="Fix Slack channels API rate-limit handling"',
    );
  }
  if (flags.description.length > 200) {
    throw new Error(
      `--description must be <= 200 chars (got ${flags.description.length}). Long-form notes belong in CHANGELOG.md.`,
    );
  }

  // Working tree clean (in submodule)?
  if (!fs.existsSync(SUBMODULE_DIR)) {
    throw new Error('mcp-servers submodule not present. Run: git submodule update --init mcp-servers');
  }
  const submoduleStatus = sh('git status --porcelain', { cwd: SUBMODULE_DIR });
  if (submoduleStatus.length > 0) {
    throw new Error(
      `mcp-servers submodule has uncommitted changes:\n${submoduleStatus}\n\nCommit or stash before invoking the release.`,
    );
  }

  // Connector dir exists?
  const connectorDir = path.join(SUBMODULE_DIR, 'connectors', mapping.name);
  if (!fs.existsSync(connectorDir)) {
    throw new Error(`Connector directory not found: ${connectorDir}`);
  }

  // Read fromVersion (current package.json version on the submodule HEAD)
  const pkgJsonPath = path.join(connectorDir, 'package.json');
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { version: string; name: string };
  if (pkgJson.name !== mapping.npmPackage) {
    throw new Error(
      `Package name mismatch: catalog mapping says "${mapping.npmPackage}" but ${pkgJsonPath} says "${pkgJson.name}". Fix the mapping or the package.json.`,
    );
  }
  ledger.fromVersion = pkgJson.version;

  // Catalog entries exist?
  const catalogPath = path.join(REPO_ROOT, 'resources', 'connector-catalog.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as {
    connectors: Array<{ id: string; mcpConfig?: { args?: string[] } }>;
  };
  for (const catalogId of mapping.catalogIds) {
    const entry = catalog.connectors.find((c) => c.id === catalogId);
    if (!entry) {
      throw new Error(
        `Catalog entry "${catalogId}" not found. Add it to resources/connector-catalog.json before releasing this connector.`,
      );
    }
    if (!mapping.firstPublish) {
      const pin = entry.mcpConfig?.args?.[1];
      const expected = `${mapping.npmPackage}@${ledger.fromVersion}`;
      if (pin !== expected) {
        throw new Error(
          `Catalog entry "${catalogId}" pin "${pin}" does not match current submodule version "${expected}". Reconcile manually first.`,
        );
      }
    }
  }

  // Compute the next version preview for the prompt. The actual write
  // happens in Stage 1; here we only show the user what they're approving.
  const previewVersion = mapping.firstPublish
    ? '0.0.1'
    : computeNextVersion(ledger.fromVersion!, flags.bumpType);
  const securityReview = verifySecurityReviewGate(mapping, previewVersion, flags.securityReview);
  ledger.securityReviewPath = securityReview.path;
  ledger.securityReviewSha256 = securityReview.sha256;

  // Confirm with user
  console.log(`\nPreflight summary for "${mapping.name}":`);
  console.log(`  npm package:     ${mapping.npmPackage}`);
  console.log(`  current version: ${ledger.fromVersion}${mapping.firstPublish ? ' (first publish)' : ''}`);
  console.log(`  bump type:       ${flags.bumpType}`);
  console.log(`  next version:    ${previewVersion}`);
  console.log(`  catalog IDs:     ${mapping.catalogIds.join(', ')}`);
  console.log(`  description:     ${flags.description}`);
  console.log(`  security review: ${securityReview.path}`);

  if (!(await confirm(`Proceed with release?`))) {
    throw new Error('User declined to proceed');
  }
  // Stage 1 will write the actual toVersion after the bump.
  writeLedger(ledger);
}

// --- Version helpers --------------------------------------------------------

/**
 * Numeric major.minor.patch comparison: negative if a < b, 0 if equal,
 * positive if a > b. Prerelease/build suffixes are ignored — catalog pins
 * and connector package.json versions are plain x.y.z in practice
 * (assertSemver tolerates suffixes for forward-compat, so we don't reject
 * them here either; --reconcile only needs an ahead/behind ordering).
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) throw new Error(`Cannot compare non-semver version: ${v}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function computeNextVersion(current: string, bumpType: 'patch' | 'minor' | 'major'): string {
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/);
  if (!m) {
    throw new Error(`Cannot bump non-semver version: ${current}`);
  }
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bumpType === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bumpType === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

// --- Stage 1: version-bumped ------------------------------------------------
//
// The file mutation itself (package.json, package-lock.json, server.json,
// CHANGELOG.md, catalogue/install-links regen; STATUS.json no longer stores a
// version as of schema v2) is delegated to
// the submodule's own scripts/bump-connector.mjs — the single bump
// implementation, shared with the first-publish bootstrap recipe in
// mcp-servers/CONTRIBUTING.md (Stage 7a of
// docs/plans/260611_mcp-landing-process). This stage keeps what is
// Rebel-specific: ledger idempotency, the §13 gate, build/test, and the
// Release-Gate-trailer-stamped commit (the .mjs never commits).

/**
 * Version-skew guard (Stage 7a, R2-F7): Stage 1 executes whatever
 * bump-connector.mjs the current submodule pin has. An older pin doesn't
 * have the script at all — fail loud with the exact fix rather than falling
 * back to an inline bump (no dual implementations).
 */
export function assertBumpConnectorScript(submoduleDir: string): string {
  const scriptPath = path.join(submoduleDir, 'scripts', 'bump-connector.mjs');
  if (!fs.existsSync(scriptPath)) {
    throw new Error(
      `${scriptPath} not found — the mcp-servers submodule pin predates the shared bump ` +
        `implementation that Stage 1 delegates to. Fix: update the mcp-servers submodule to a ` +
        `release-tooling commit (>= 2026-06-11) — see MCP_OSS_RELEASE_AGENT_DRIVEN.md.`,
    );
  }
  return scriptPath;
}

async function stageVersionBumped(
  ledger: Ledger,
  mapping: ConnectorReleaseMapping,
  flags: ReleaseFlags,
): Promise<void> {
  const connectorDir = path.join(SUBMODULE_DIR, 'connectors', mapping.name);

  // Idempotency: if HEAD already contains a version commit for this connector,
  // skip the bump but still pick up the new version into the ledger. The
  // branching only decides the TARGET version; the mutation is the .mjs's job
  // (called unconditionally below — in the already-bumped cases it runs in
  // idempotent sync mode, preserving the self-healing regen behavior
  // that --reconcile's assertReconcileRegenClean depends on).
  const pkgJsonPath = path.join(connectorDir, 'package.json');
  const currentVersion = (JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { version: string }).version;

  if (ledger.toVersion && currentVersion === ledger.toVersion) {
    console.log(`Version already bumped to ${currentVersion}, skipping bump`);
  } else if (currentVersion !== ledger.fromVersion) {
    // Submodule was bumped externally (or this is a resume); pick it up.
    ledger.toVersion = currentVersion;
    console.log(`Detected version ${currentVersion} (already bumped); using as toVersion`);
  } else {
    ledger.toVersion = computeNextVersion(ledger.fromVersion!, flags.bumpType);
    console.log(`Bumping ${mapping.name} ${ledger.fromVersion} -> ${ledger.toVersion} (${flags.bumpType})`);
  }

  // Single bump implementation, at the submodule pin (version-skew guard).
  assertBumpConnectorScript(SUBMODULE_DIR);
  const bumpArgs = ['scripts/bump-connector.mjs', mapping.name, '--to', ledger.toVersion!];
  if (flags.description) {
    bumpArgs.push('--changelog-entry', flags.description);
  }
  const bump = spawnBlocking('node', bumpArgs, { cwd: SUBMODULE_DIR });
  if (bump.status !== 0) {
    throw new Error(
      'scripts/bump-connector.mjs failed (see its output above). If it reported a missing ' +
        '--changelog-entry, resume with: npm run mcp:release -- --resume <ledger-id> --description="..."',
    );
  }

  // Reconcile precondition (a): the regen above must have been a no-op on an
  // externally-merged bump — any drift means the merged commit was incomplete
  // and reconcile cannot recover it (see assertReconcileRegenClean).
  if (ledger.reconcile) {
    assertReconcileRegenClean(sh('git status --porcelain', { cwd: SUBMODULE_DIR }), mapping.name);
  }

  const securityReview = verifySecurityReviewGate(mapping, ledger.toVersion!, flags.securityReview);
  if (securityReview) {
    ledger.securityReviewPath = securityReview.path;
    ledger.securityReviewSha256 = securityReview.sha256;
  }

  // Build + test (sanity check the bump didn't break anything obvious)
  console.log('Running: npm ci && npm run build && npm test');
  let r = spawnBlocking('npm', ['ci'], { cwd: connectorDir });
  if (r.status !== 0) throw new Error('npm ci failed');
  r = spawnBlocking('npm', ['run', 'build'], { cwd: connectorDir });
  if (r.status !== 0) throw new Error('npm run build failed');
  // Test step is optional — some connectors may not have it
  const connPkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { scripts?: Record<string, string> };
  if (connPkg.scripts?.test) {
    r = spawnBlocking('npm', ['test'], { cwd: connectorDir });
    if (r.status !== 0) throw new Error('npm test failed');
  }

  // Commit (atomic). Stage explicit paths only — never `git add -A` or
  // `git add .` which would sweep up sibling-connector or unrelated WIP.
  console.log('Committing release commit in submodule');
  const filesToStage = [
    `connectors/${mapping.name}/package.json`,
    `connectors/${mapping.name}/package-lock.json`,
    `connectors/${mapping.name}/server.json`,
    `connectors/${mapping.name}/CHANGELOG.md`,
    // STATUS.json carries no version since schema v2 — not staged by releases.
    // Generated catalogue outputs (regenerated above).
    // Explicit paths only — never `git add docs/` — so an unrelated
    // sibling-connector catalogue drift is left in the working tree rather
    // than swept into this release commit.
    `docs/index.md`,
    `docs/catalogue/${mapping.name}.md`,
    // Install-links block regenerated above from server.json.
    `connectors/${mapping.name}/README.md`,
  ];
  for (const f of filesToStage) {
    if (fs.existsSync(path.join(SUBMODULE_DIR, f))) {
      sh(`git add ${JSON.stringify(f)}`, { cwd: SUBMODULE_DIR });
    }
  }

  // Skip if nothing actually changed (e.g. resumed mid-stage with all files
  // already committed in a previous attempt, or a --reconcile of an
  // externally-merged bump that already included the full regen set).
  const staged = sh('git diff --cached --name-only', { cwd: SUBMODULE_DIR });
  if (staged.length > 0) {
    // Stage 5′: stamp the Release-Gate trailer (subject + blank line +
    // trailer paragraph via a second -m, per git trailer convention) binding
    // this commit to the §13 review artifact that gated it. The Rebel-side
    // audit in Stage 6 verifies it; public mcp-servers CI checks format only.
    if (!ledger.securityReviewPath || !ledger.securityReviewSha256) {
      throw new Error(
        'Cannot stamp Release-Gate trailer: ledger is missing securityReviewPath/securityReviewSha256 ' +
          '(the §13 gate should have populated these before the commit)',
      );
    }
    const trailer = formatReleaseGateTrailer(ledger.securityReviewPath, ledger.securityReviewSha256);
    sh(
      `git commit -m ${JSON.stringify(`chore(release): ${mapping.name}@${ledger.toVersion}`)} ` +
        `-m ${JSON.stringify(trailer)}`,
      { cwd: SUBMODULE_DIR },
    );
  }
  ledger.releaseCommitSha = sh('git rev-parse HEAD', { cwd: SUBMODULE_DIR });
  console.log(`Release commit: ${ledger.releaseCommitSha}`);
  // Slice 1b: the regen above may have refreshed pre-existing sibling catalogue
  // drift into the working tree (we only staged this connector's page). Surface
  // it loudly so the stray file doesn't silently trip git-safe-sync later.
  surfaceSiblingCatalogueDrift(mapping.name);
  writeLedger(ledger);
}

// --- Stage 2: submodule-pushed ----------------------------------------------

async function stageSubmodulePushed(ledger: Ledger): Promise<void> {
  if (!ledger.releaseCommitSha) {
    throw new Error('Ledger missing releaseCommitSha; cannot push to mcp-servers/main');
  }
  // Already-landed release commit (a --reconcile of an externally-merged
  // bump, or a resume after a push that succeeded mid-crash): there is
  // nothing to push, and `git push HEAD:main` could even fail non-fast-
  // forward if remote main moved on. Skip the push entirely — and skip the
  // push-authorization prompt, since no push happens.
  sh('git fetch origin main', { cwd: SUBMODULE_DIR });
  const originMain = sh('git rev-parse origin/main', { cwd: SUBMODULE_DIR });
  if (isCommitAncestor(ledger.releaseCommitSha, originMain, SUBMODULE_DIR)) {
    console.log(
      `Release commit ${ledger.releaseCommitSha} is already contained in mcp-servers origin/main ` +
        `(${originMain}); skipping push.`,
    );
    return;
  }
  if (!(await confirmPush('submodule-pushed', ledger, `Push commit ${ledger.releaseCommitSha} to mcp-servers/main?`))) {
    throw new Error('User declined to push to mcp-servers/main');
  }
  const head = sh('git rev-parse HEAD', { cwd: SUBMODULE_DIR });
  if (head !== ledger.releaseCommitSha) {
    throw new Error(
      `Refusing to push mcp-servers/main because submodule HEAD does not match the release commit:\n` +
        `  ledger.releaseCommitSha: ${ledger.releaseCommitSha}\n` +
        `  submodule HEAD:         ${head}`,
    );
  }
  console.log('Pushing to mcp-servers/main');
  const r = spawnBlocking('git', ['push', 'origin', 'HEAD:main'], { cwd: SUBMODULE_DIR });
  if (r.status !== 0) {
    // One retry
    console.log('Push failed, retrying once...');
    const r2 = spawnBlocking('git', ['push', 'origin', 'HEAD:main'], { cwd: SUBMODULE_DIR });
    if (r2.status !== 0) throw new Error('Push to mcp-servers/main failed twice');
  }
}

// --- Stage 3: workflow-triggered --------------------------------------------

async function stageWorkflowTriggered(ledger: Ledger, mapping: ConnectorReleaseMapping): Promise<void> {
  // Wait up to 60s for the workflow to register
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    try {
      const list = sh(
        // --limit 50 (not 5): a --reconcile may run days after the merge, by
        // which point the release run is no longer among the most recent few.
        `gh run list --repo mindstone/mcp-servers --workflow release.yml --limit 50 --json databaseId,headSha,status,createdAt`,
      );
      const runs = JSON.parse(list) as Array<{ databaseId: number; headSha: string; status: string }>;
      const match = runs.find((r) => r.headSha === ledger.releaseCommitSha);
      if (match) {
        ledger.workflowRunId = String(match.databaseId);
        console.log(`Found workflow run: ${ledger.workflowRunId}`);
        writeLedger(ledger);
        return;
      }
    } catch (err) {
      console.log(`gh run list failed: ${err instanceof Error ? err.message : String(err)}; retrying...`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(
    `No workflow run found for SHA ${ledger.releaseCommitSha} after 60s` +
      (ledger.reconcile
        ? `. (--reconcile matches the run by the origin/main tip; if release.yml never ran for this ` +
          `commit — e.g. the push that landed it did not touch ` +
          `connectors/${mapping.name}/package.json — --reconcile cannot recover it. Follow ` +
          `docs/project/MCP_OSS_PACKAGE_MANUAL_UPDATE.md instead.)`
        : ''),
  );
}

// --- Stage 4: workflow-success ----------------------------------------------

async function stageWorkflowSuccess(ledger: Ledger): Promise<void> {
  if (!ledger.workflowRunId) throw new Error('Missing workflowRunId');
  console.log(`Watching workflow ${ledger.workflowRunId}`);
  const r = spawnBlocking('gh', [
    'run',
    'watch',
    ledger.workflowRunId,
    '--repo',
    'mindstone/mcp-servers',
    '--exit-status',
  ]);
  if (r.status !== 0) throw new Error(`Workflow ${ledger.workflowRunId} did not succeed`);
}

// --- Stage 5: published-verified --------------------------------------------

async function stagePublishedVerified(
  ledger: Ledger,
  mapping: ConnectorReleaseMapping,
  flags: { skipRegistryConfirm: boolean },
): Promise<void> {
  if (!ledger.toVersion) throw new Error('Missing toVersion');
  const spec = `${mapping.npmPackage}@${ledger.toVersion}`;

  // Sub-check A: npm CDN propagation + Sigstore via npm audit signatures
  console.log(`Checking npm registry for ${spec}`);
  const start = Date.now();
  let propagated = false;
  while (Date.now() - start < 10 * 60 * 1000) {
    try {
      sh(`npm view ${spec} version`);
      propagated = true;
      break;
    } catch {
      // not yet
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 10000));
  }
  if (!propagated) throw new Error(`${spec} not on npm registry after 10 minutes`);
  console.log('');
  console.log('Verifying Sigstore signature via npm audit signatures');
  const auditDir = fs.mkdtempSync(path.join(REPO_ROOT, '.cache', 'npm-audit-'));
  try {
    fs.writeFileSync(
      path.join(auditDir, 'package.json'),
      JSON.stringify({ name: 'mcp-release-audit', version: '0.0.0', dependencies: { [mapping.npmPackage]: ledger.toVersion } }, null, 2),
    );
    const r = spawnBlocking('npm', ['install', '--no-audit', '--ignore-scripts'], { cwd: auditDir });
    if (r.status !== 0) throw new Error('npm install for audit signatures failed');
    const auditResult = spawnBlocking('npm', ['audit', 'signatures'], { cwd: auditDir });
    if (auditResult.status !== 0) {
      throw new Error('npm audit signatures failed — package may not be signed via Trusted Publishing OIDC');
    }
  } finally {
    fs.rmSync(auditDir, { recursive: true, force: true });
  }

  // Sub-check B: npx smoke (initialize + tools/list)
  console.log(`Running smoke test: npx ${spec}`);
  const smokeResult = spawnSync('npx', ['-y', spec], {
    encoding: 'utf8',
    timeout: 30_000,
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-release-smoke', version: '1.0.0' } } }) + '\n',
  });
  if (smokeResult.status !== 0 && smokeResult.signal !== 'SIGTERM') {
    throw new Error(`npx smoke test failed: ${smokeResult.stderr || smokeResult.stdout}`);
  }

  // Sub-check C: registry confirmation (mcp-publisher to MCP registry)
  if (flags.skipRegistryConfirm) {
    console.log('Skipping registry confirmation (--skip-registry-confirm)');
  } else {
    const serverJsonPath = path.join(SUBMODULE_DIR, 'connectors', mapping.name, 'server.json');
    const serverJson = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8')) as { name?: unknown };
    const registryName = typeof serverJson.name === 'string' ? serverJson.name : '';
    if (!registryName || !registryName.includes('/')) {
      throw new Error(`${serverJsonPath} must contain a slash-delimited MCP registry name`);
    }

    // The MCP registry uses reverse-DNS namespaces from server.json.name, for
    // example `io.github.mindstone/mcp-server-slack`. The stable preview read
    // API is v0.1; keep v0 fallbacks because the registry changed shape during
    // preview and older ledgers may still be resumed.
    const encodedRegistryName = encodeURIComponent(registryName);
    const candidateUrls = [
      `https://registry.modelcontextprotocol.io/v0.1/servers/${encodedRegistryName}/versions/${ledger.toVersion}`,
      `https://registry.modelcontextprotocol.io/v0.1/servers/${encodedRegistryName}/versions/latest`,
      `https://registry.modelcontextprotocol.io/v0/servers/${registryName}/${ledger.toVersion}`,
      `https://registry.modelcontextprotocol.io/v0/servers/${encodedRegistryName}/${ledger.toVersion}`,
      `https://registry.modelcontextprotocol.io/v0/servers?name=${encodedRegistryName}`,
    ];

    const startC = Date.now();
    let registered = false;
    let lastError = '';
    while (Date.now() - startC < 5 * 60 * 1000) {
      for (const url of candidateUrls) {
        try {
          const result = sh(`curl -fsS '${url}'`);
          const parsed = JSON.parse(result) as Record<string, unknown>;
          // Require BOTH name and version to match. Without the name check,
          // any other server with the same version could falsely satisfy the gate.
          if (registryResponseMatches(parsed, registryName, ledger.toVersion)) {
            registered = true;
            break;
          }
        } catch (err) {
          lastError = String((err as Error).message ?? err);
        }
      }
      if (registered) break;
      process.stdout.write(',');
      await new Promise((r) => setTimeout(r, 10000));
    }
    if (!registered) {
      throw new Error(
        `${spec} not in MCP registry after 5 minutes (last error: ${lastError}). Check the mcp-publisher step in release.yml. ` +
          `If it's a known publisher issue and you've manually verified npm install works, re-invoke with --skip-registry-confirm.`,
      );
    }
    console.log('');
  }
}

// --- Stage 6: catalog-updated -----------------------------------------------

async function stageCatalogUpdated(ledger: Ledger, mapping: ConnectorReleaseMapping): Promise<void> {
  if (!ledger.toVersion) throw new Error('Missing toVersion');
  const spec = `${mapping.npmPackage}@${ledger.toVersion}`;

  // Update catalog entries via jq for atomic JSON manipulation. Use mktemp
  // for the working file so a crash mid-update doesn't leak a stale
  // .tmp into the working tree.
  const catalogPath = path.join(REPO_ROOT, 'resources', 'connector-catalog.json');
  for (const catalogId of mapping.catalogIds) {
    const tmp = sh(`mktemp /tmp/mcp-release-catalog-XXXXXX.json`);
    try {
      const jqExpr = `(.connectors[] | select(.id == "${catalogId}") | .mcpConfig.args[1]) = "${spec}"`;
      sh(`jq '${jqExpr}' '${catalogPath}' > '${tmp}' && mv '${tmp}' '${catalogPath}'`);
      console.log(`Updated catalog entry ${catalogId} -> ${spec}`);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw err;
    }
  }

  // (Microsoft 5 no longer carry a packageSpec const — catalog is the
  // sole source of truth. The previous atomic-update branch was removed
  // when MICROSOFT_REBEL_OSS_DEFS dropped its packageSpec field per v2 of
  // docs/plans/260525_oss_release_automation.md.)

  // Submodule pointer integrity check: the rebel-side commit must pin
  // the submodule to exactly the release commit we pushed in Stage 2,
  // not to whatever HEAD happens to be (a concurrent operator could have
  // advanced the submodule between Stages 2 and 6).
  if (!ledger.releaseCommitSha) {
    throw new Error('Ledger missing releaseCommitSha; cannot verify submodule pointer integrity');
  }
  const submoduleHead = sh('git rev-parse HEAD', { cwd: SUBMODULE_DIR });
  if (submoduleHead !== ledger.releaseCommitSha) {
    throw new Error(
      `Submodule pointer integrity check failed:\n` +
        `  expected (release commit): ${ledger.releaseCommitSha}\n` +
        `  actual (submodule HEAD):   ${submoduleHead}\n` +
        `\nSomething has advanced the mcp-servers submodule beyond the release commit. ` +
        `Reset the submodule to the expected commit before resuming, or investigate the drift.`,
    );
  }

  // Stage 5′ Rebel-side audit: the release commit's Release-Gate trailer must
  // match the local §13 review artifact (absent trailer = structured warning
  // for pre-stamping/externally-merged commits; mismatch = hard failure).
  auditReleaseGateTrailer(ledger);

  // Stage explicit paths only — never `git add -A` or `git add .` which
  // would sweep up unrelated changes from a concurrent agent.
  console.log('Staging submodule pointer advance + catalog change');
  sh('git add mcp-servers');
  sh('git add resources/connector-catalog.json');

  // Atomic commit
  const staged = sh('git diff --cached --name-only');
  if (staged.length === 0) {
    throw new Error('Nothing staged for catalog commit — submodule pointer may already be at this SHA');
  }
  const commitMsg = `chore(mcp-oss-release): ${mapping.name}@${ledger.toVersion}`;
  sh(`git commit -m "${commitMsg}"`);
  ledger.catalogCommitSha = sh('git rev-parse HEAD');
  console.log(`Catalog commit: ${ledger.catalogCommitSha}`);
  writeLedger(ledger);
}

// --- Stage 7: validate-fast-passed ------------------------------------------

async function stageValidateFastPassed(): Promise<void> {
  console.log('Running: npm run validate:fast');
  const r = spawnBlocking('npm', ['run', 'validate:fast']);
  if (r.status !== 0) throw new Error('validate:fast failed');
}

// --- Stage 8: dev-pushed ----------------------------------------------------

async function stageDevPushed(ledger: Ledger): Promise<void> {
  if (!(await confirmPush('dev-pushed', ledger, `Push commit ${ledger.catalogCommitSha} to mindstone-rebel-1/dev via git-safe-sync.ts?`))) {
    throw new Error('User declined to push to mindstone-rebel-1/dev');
  }
  // HEAD must CONTAIN the catalog commit, not necessarily BE it: legitimate
  // commits land on top between Stage 6 and here (the committed §13 review
  // artifact, merge commits from a concurrent safe-sync). Requiring strict
  // equality forced those releases into out-of-band pushes that left the
  // ledger stuck before "complete" (PLAN.md Decision Log 13:15 (b)/(c)).
  // Still refuse when the catalog commit is NOT an ancestor of HEAD — that
  // is genuinely foreign state (wrong branch, reset, different checkout).
  const head = sh('git rev-parse HEAD');
  if (!ledger.catalogCommitSha) {
    throw new Error('Ledger missing catalogCommitSha; cannot verify push target');
  }
  if (head !== ledger.catalogCommitSha) {
    if (!isCommitAncestor(ledger.catalogCommitSha, head, REPO_ROOT)) {
      throw new Error(
        `Refusing to push Rebel branch because HEAD does not contain the catalog commit:\n` +
          `  ledger.catalogCommitSha: ${ledger.catalogCommitSha}\n` +
          `  Rebel HEAD:             ${head}\n` +
          `The catalog commit is not an ancestor of HEAD — this looks like foreign state ` +
          `(wrong branch/checkout or a reset). Investigate before resuming.`,
      );
    }
    console.log(
      `HEAD ${head.slice(0, 12)} is a descendant of catalog commit ` +
        `${ledger.catalogCommitSha.slice(0, 12)}; proceeding (post-catalog commits such as the ` +
        `§13 review artifact or sync merges are expected).`,
    );
  }
  // Use git-safe-sync.ts per AGENTS.md (handles submodule push ordering,
  // FF-only, post-merge verification, etc.). --no-advance-submodules avoids
  // bundling unrelated rebel-system / coding-agent-instructions advances
  // into the release push (mcp-servers was already pushed in Stage 2).
  const r = spawnBlocking('npx', [
    'tsx',
    'scripts/git-safe-sync.ts',
    '--no-advance-submodules',
  ]);
  if (r.status !== 0) throw new Error('git-safe-sync.ts failed');
}

// --- Reconcile mode (Stage 6 of the landing-process plan) --------------------
//
// `npm run mcp:release -- --reconcile <connector>`: scripted recovery for a
// version bump that landed on mcp-servers/main OUTSIDE this script (e.g. a
// PR merge like mindstone/mcp-servers#85). Verifies the merged state, then
// seeds a ledger at stage "version-bumped" with true facts and enters the
// normal resume loop — so every remaining gate (§13, build/test, workflow,
// npm/Sigstore/registry verification, catalog pin, validate:fast, push)
// re-runs exactly as in a fresh release. Replaces the hand-seeded-ledger
// recipe (PLAN.md Decision Log 13:15).
//
// Scope (fail-loud preconditions, review round 2): reconcile only handles
// the CLEAN tip case — submodule HEAD must equal the origin/main tip
// (assertReconcileTipCheckout), and Stage 1's idempotent regen must be a
// no-op (assertReconcileRegenClean; no drift-fix commits). Stage 2 skips the
// push for already-landed commits. Anything else routes to
// docs/project/MCP_OSS_PACKAGE_MANUAL_UPDATE.md.

/**
 * Reconcile precondition (fail-loud, extracted for unit testing): the
 * submodule must be checked out at the origin/main TIP, not merely contained
 * in it. Reconcile pins `ledger.releaseCommitSha` to this HEAD; Stage 2's
 * push-skip and Stage 3's workflow-run match key off that SHA, so a non-tip
 * checkout (older release) would match the wrong workflow run or attempt a
 * non-fast-forward push. Older/non-tip releases are deliberately out of
 * scope — recover via docs/project/MCP_OSS_PACKAGE_MANUAL_UPDATE.md.
 */
export function assertReconcileTipCheckout(head: string, originMain: string): void {
  if (head === originMain) return;
  throw new Error(
    `mcp-servers submodule HEAD (${head}) is not the origin/main tip (${originMain}).\n` +
      `--reconcile only supports reconciling the bump that is currently the tip of ` +
      `mcp-servers/main. Check out the tip first:\n` +
      `  git -C mcp-servers fetch origin main && git -C mcp-servers checkout origin/main\n` +
      `If the bump you need is OLDER than the tip, --reconcile cannot recover it — ` +
      `follow docs/project/MCP_OSS_PACKAGE_MANUAL_UPDATE.md instead.`,
  );
}

/**
 * Reconcile precondition (fail-loud, extracted for unit testing): Stage 1's
 * idempotent regen (catalogue, install-links) must be a
 * NO-OP on an externally-merged bump. Any working-tree drift means the
 * merged commit was incomplete; a drift-fix commit would not touch
 * connectors/<name>/package.json, so release.yml would never run for it and
 * Stage 3 would hang. Abort — reconcile only handles the clean case.
 */
export function assertReconcileRegenClean(statusPorcelain: string, connectorName: string): void {
  if (statusPorcelain.trim().length === 0) return;
  throw new Error(
    `--reconcile aborted: the idempotent regen left working-tree changes in mcp-servers:\n` +
      `${statusPorcelain}\n` +
      `The externally-merged ${connectorName} bump is incomplete (stale catalogue / ` +
      `install-links). --reconcile will NOT create a drift-fix commit: release.yml would never run ` +
      `for it, and the release run would hang at workflow-triggered. Land the regen fixes on ` +
      `mcp-servers/main manually (docs/project/MCP_OSS_PACKAGE_MANUAL_UPDATE.md), then re-run ` +
      `--reconcile. The drift above is left in the working tree for inspection.`,
  );
}

/**
 * Detects pre-existing SIBLING-connector catalogue drift left in the working
 * tree after Stage 1's regen (Slice 1b — fixes the "stray docs/catalogue/<x>.md
 * blocks my push" class).
 *
 * bump-connector.mjs regenerates the WHOLE catalogue, but the release commit
 * stages only the released connector's page (`docs/catalogue/<released>.md`) +
 * `docs/index.md` — deliberately, so unrelated siblings aren't swept into the
 * release. The side effect: if a sibling's committed catalogue page was already
 * stale vs its STATUS.json, the regen "fixes" it and leaves it as an
 * uncommitted modification. That stray file later trips git-safe-sync's
 * clean-submodule safety check, with no hint of where it came from — exactly
 * the blocker a colleague hit. Rather than leave it silent, we surface it
 * loudly with the exact remediation (Chief's judgment: surface, don't
 * auto-commit — sibling drift is a pre-existing condition the operator should
 * resolve deliberately, and auto-committing would muddy an unrelated
 * connector's change into this release's train).
 *
 * Pure + unit-testable: takes `git status --porcelain` output, returns the
 * drifted sibling catalogue page paths (excluding the released connector's own
 * page and the always-staged `docs/index.md`), sorted.
 */
export function detectSiblingCatalogueDrift(
  statusPorcelain: string,
  releasedConnectorName: string,
): string[] {
  const releasedPage = `docs/catalogue/${releasedConnectorName}.md`;
  const drifted: string[] = [];
  for (const rawLine of statusPorcelain.split('\n')) {
    if (rawLine.trim().length === 0) continue;
    // porcelain v1: two status columns + a space, then the path at col 3.
    let p = rawLine.slice(3).trim();
    // git quotes paths with special/non-ASCII bytes under default core.quotePath.
    if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) p = p.slice(1, -1);
    if (/^docs\/catalogue\/[^/]+\.md$/.test(p) && p !== releasedPage) {
      drifted.push(p);
    }
  }
  return [...new Set(drifted)].sort((a, b) => a.localeCompare(b));
}

/**
 * Loud, non-mutating advisory: if Stage 1's regen left sibling catalogue drift
 * in the working tree, name it and print the exact fix. Observability over
 * silence — never auto-commits or discards.
 */
function surfaceSiblingCatalogueDrift(connectorName: string): void {
  const status = sh('git status --porcelain', { cwd: SUBMODULE_DIR });
  const drifted = detectSiblingCatalogueDrift(status, connectorName);
  if (drifted.length === 0) return;
  const quoted = drifted.map((p) => JSON.stringify(p)).join(' ');
  console.warn(
    `\n⚠️  Pre-existing sibling catalogue drift detected (NOT caused by this ${connectorName} release):`,
  );
  for (const p of drifted) console.warn(`     ${p}`);
  console.warn(
    `   The regen refreshed these sibling page(s); they were stale on disk before this release and are\n` +
      `   left UNCOMMITTED — which will otherwise trip git-safe-sync's clean-submodule check later.\n` +
      `   Do NOT 'git commit' them now: that moves the submodule HEAD off this release's commit, and\n` +
      `   Stage 2 (push) + Stage 6 (pointer integrity) require HEAD to equal the release commit — the\n` +
      `   release would then refuse to proceed.\n` +
      `   • To continue THIS release cleanly now — discard the regen residue (each sibling's page is\n` +
      `     refreshed by its own next release):\n` +
      `       (cd ${SUBMODULE_DIR} && git checkout -- ${quoted})\n` +
      `   • To land the refresh deliberately — do it SEPARATELY after this release finishes: commit on\n` +
      `     mcp-servers/main and push as its own change, never inside this Release-Gate-stamped commit.\n`,
  );
}

/** Read the catalog pin version for a mapping, requiring all catalogIds to agree. */
function readCatalogPinVersion(mapping: ConnectorReleaseMapping): string {
  if (mapping.catalogIds.length === 0) {
    throw new Error(
      `Connector "${mapping.name}" has no catalog IDs — there is no Rebel catalog pin to reconcile. ` +
        `(--reconcile exists to bring the catalog pin up to an externally-landed submodule bump.)`,
    );
  }
  const catalogPath = path.join(REPO_ROOT, 'resources', 'connector-catalog.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as {
    connectors: Array<{ id: string; mcpConfig?: { args?: string[] } }>;
  };
  const versions = new Set<string>();
  for (const catalogId of mapping.catalogIds) {
    const entry = catalog.connectors.find((c) => c.id === catalogId);
    if (!entry) {
      throw new Error(`Catalog entry "${catalogId}" not found in resources/connector-catalog.json`);
    }
    const pin = entry.mcpConfig?.args?.[1];
    const prefix = `${mapping.npmPackage}@`;
    if (!pin || !pin.startsWith(prefix)) {
      throw new Error(
        `Catalog entry "${catalogId}" pin "${pin ?? 'missing'}" does not look like "${prefix}<version>"`,
      );
    }
    versions.add(pin.slice(prefix.length));
  }
  if (versions.size !== 1) {
    throw new Error(
      `Catalog entries for "${mapping.name}" pin DIFFERENT versions (${[...versions].join(', ')}). ` +
        `Reconcile the catalog entries to a single version first.`,
    );
  }
  const pinVersion = [...versions][0]!;
  assertSemver(pinVersion, `catalog pin for ${mapping.name}`);
  return pinVersion;
}

async function seedReconcileLedger(
  connectorName: string,
  flags: ReleaseFlags,
): Promise<{ ledger: Ledger; mapping: ConnectorReleaseMapping }> {
  const mapping = getMapping(connectorName);
  if (mapping.firstPublish) {
    throw new Error(
      `--reconcile does not support first-publish connectors ("${mapping.name}" is marked firstPublish). ` +
        `Run a normal release, or use docs/project/MCP_OSS_PACKAGE_MANUAL_UPDATE.md for bootstrap.`,
    );
  }

  // Submodule present + clean (same posture as preflight).
  if (!fs.existsSync(SUBMODULE_DIR)) {
    throw new Error('mcp-servers submodule not present. Run: git submodule update --init mcp-servers');
  }
  const submoduleStatus = sh('git status --porcelain', { cwd: SUBMODULE_DIR });
  if (submoduleStatus.length > 0) {
    throw new Error(
      `mcp-servers submodule has uncommitted changes:\n${submoduleStatus}\n\nCommit or stash before reconciling.`,
    );
  }

  // The merged state we reconcile against must be the origin/main TIP —
  // reconcile is for the most recently landed bump, not local WIP and not an
  // older non-tip release (see assertReconcileTipCheckout for why).
  console.log('Fetching mcp-servers origin/main');
  sh('git fetch origin main', { cwd: SUBMODULE_DIR });
  const head = sh('git rev-parse HEAD', { cwd: SUBMODULE_DIR });
  const originMain = sh('git rev-parse origin/main', { cwd: SUBMODULE_DIR });
  assertReconcileTipCheckout(head, originMain);

  // Connector identity + version at the merged HEAD.
  const pkgJsonPath = path.join(SUBMODULE_DIR, 'connectors', mapping.name, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`Connector package.json not found: ${pkgJsonPath}`);
  }
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { version: string; name: string };
  if (pkgJson.name !== mapping.npmPackage) {
    throw new Error(
      `Package name mismatch: catalog mapping says "${mapping.npmPackage}" but ${pkgJsonPath} says "${pkgJson.name}".`,
    );
  }
  assertSemver(pkgJson.version, `submodule version for ${mapping.name}`);

  // The submodule must be AHEAD of the Rebel catalog pin — otherwise there
  // is nothing to reconcile (equal) or the state is foreign (behind).
  const pinVersion = readCatalogPinVersion(mapping);
  const cmp = compareSemver(pkgJson.version, pinVersion);
  if (cmp === 0) {
    throw new Error(
      `Nothing to reconcile: submodule and catalog both have ${mapping.name}@${pinVersion}.`,
    );
  }
  if (cmp < 0) {
    throw new Error(
      `Refusing to reconcile: submodule has ${mapping.name}@${pkgJson.version} but the catalog pins ` +
        `${pinVersion} (submodule is BEHIND the pin). Update the submodule checkout, or investigate.`,
    );
  }

  // §13 gate — identical to preflight. A bump that landed without a review
  // artifact stays unreconcilable until the review is written.
  const securityReview = verifySecurityReviewGate(mapping, pkgJson.version, flags.securityReview);

  // Seed the ledger with true facts at stage "version-bumped" (the id comes
  // from the script's own generator, so it always passes assertSafeLedgerId).
  const ledger = newLedger(connectorName);
  ledger.stage = 'version-bumped';
  ledger.reconcile = true;
  ledger.fromVersion = pinVersion;
  ledger.toVersion = pkgJson.version;
  ledger.securityReviewPath = securityReview.path;
  ledger.securityReviewSha256 = securityReview.sha256;
  writeLedger(ledger);

  console.log(`\nReconcile summary for "${mapping.name}":`);
  console.log(`  npm package:       ${mapping.npmPackage}`);
  console.log(`  catalog pin:       ${pinVersion}`);
  console.log(`  submodule version: ${pkgJson.version} (at ${head.slice(0, 12)}, on origin/main)`);
  console.log(`  catalog IDs:       ${mapping.catalogIds.join(', ')}`);
  console.log(`  security review:   ${securityReview.path}`);
  console.log(`  ledger:            ${ledger.id} (seeded at stage "version-bumped")`);

  if (!(await confirm('Proceed with reconcile (re-runs all remaining release gates)?'))) {
    throw new Error('User declined to reconcile');
  }
  return { ledger, mapping };
}

// --- Orchestrator -----------------------------------------------------------

interface ReleaseFlags {
  skipRegistryConfirm: boolean;
  bumpType: 'patch' | 'minor' | 'major';
  description: string | undefined;
  securityReview: string | undefined;
}

const STAGES: Record<Exclude<StageId, 'complete'>, (ledger: Ledger, mapping: ConnectorReleaseMapping, flags: ReleaseFlags) => Promise<void>> = {
  preflight: (l, m, f) => stagePreflight(l, m, f),
  'version-bumped': (l, m, f) => stageVersionBumped(l, m, f),
  'submodule-pushed': (l) => stageSubmodulePushed(l),
  'workflow-triggered': (l, m) => stageWorkflowTriggered(l, m),
  'workflow-success': (l) => stageWorkflowSuccess(l),
  'published-verified': (l, m, f) => stagePublishedVerified(l, m, f),
  'catalog-updated': (l, m) => stageCatalogUpdated(l, m),
  'validate-fast-passed': () => stageValidateFastPassed(),
  'dev-pushed': (l) => stageDevPushed(l),
};

async function run(ledger: Ledger, mapping: ConnectorReleaseMapping, flags: ReleaseFlags): Promise<void> {
  console.log(`\nRelease ledger: ${ledgerPath(ledger.id)}`);
  if (ledger.stage !== 'preflight' && ledger.stage !== 'complete') {
    if (!ledger.toVersion) throw new Error(`Cannot resume ${ledger.stage}: ledger is missing toVersion`);
    const securityReview = verifySecurityReviewGate(mapping, ledger.toVersion, flags.securityReview);
    if (securityReview) {
      if (ledger.securityReviewSha256 && ledger.securityReviewSha256 !== securityReview.sha256) {
        throw new Error(
          `Security review changed since the ledger recorded it:\n` +
            `  ledger:  ${ledger.securityReviewSha256}\n` +
            `  current: ${securityReview.sha256}\n` +
            `Review the changes, then start a fresh release ledger.`,
        );
      }
      ledger.securityReviewPath = securityReview.path;
      ledger.securityReviewSha256 = securityReview.sha256;
      writeLedger(ledger);
    }
  }
  while (ledger.stage !== 'complete') {
    const stageFn = STAGES[ledger.stage as Exclude<StageId, 'complete'>];
    if (!stageFn) throw new Error(`Unknown stage: ${ledger.stage}`);
    console.log(`\n=== Stage: ${ledger.stage} ===`);
    try {
      await stageFn(ledger, mapping, flags);
    } catch (err) {
      recordError(ledger, ledger.stage, err);
      console.error(`\nStage ${ledger.stage} failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`Resume with: npm run mcp:release -- --resume ${ledger.id}`);
      process.exit(1);
    }
    const nextIdx = STAGE_ORDER.indexOf(ledger.stage) + 1;
    advanceStage(ledger, STAGE_ORDER[nextIdx]);
  }
  console.log(`\nRelease ${mapping.name}@${ledger.toVersion} complete.`);
}

async function main(): Promise<void> {
  ensureLedgerDir();
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      resume: { type: 'string' },
      reconcile: { type: 'boolean', default: false },
      'skip-registry-confirm': { type: 'boolean', default: false },
      bump: { type: 'string' },
      description: { type: 'string' },
      'security-review': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(
      [
        'Usage:',
        '  npm run mcp:release <connector-name> -- --bump=patch --description="..."',
        '  npm run mcp:release -- --resume <ledger-id>',
        '  npm run mcp:release -- --reconcile <connector-name>',
        '  npm run mcp:release -- --skip-registry-confirm <connector-name>',
        '',
        'Required for fresh release (not --resume / --reconcile):',
        '  --bump=patch|minor|major   semver bump type (default: patch)',
        '  --description="..."        one-line CHANGELOG entry under the new version',
        '',
        'Reconcile (recovery for bumps that landed on mcp-servers/main outside this script):',
        '  --reconcile <connector>    verify merged state + §13 review, seed a ledger at',
        '                             "version-bumped", then re-run all remaining gates',
        '',
        'Security review:',
        '  --security-review=<path>    optional explicit review path; defaults to',
        '                              docs-private/reports/security-reviews/<yyMMdd>_<connector>_<version>.md',
        '',
        'Available connectors:',
        ...listConnectorNames().map((n) => `  ${n}`),
        '',
        'Environment:',
        '  MCP_RELEASE_AUTO_APPROVE=1   skip non-push interactive prompts (use with care)',
        '  MCP_RELEASE_PUSH_APPROVAL=... approve one exact push stage; script prints the expected value',
      ].join('\n'),
    );
    return;
  }

  const bumpType = (values.bump as 'patch' | 'minor' | 'major' | undefined) ?? 'patch';
  if (!['patch', 'minor', 'major'].includes(bumpType)) {
    console.error(`Invalid --bump=${bumpType}; must be patch, minor, or major.`);
    process.exit(1);
  }
  const description = values.description as string | undefined;

  const flags = {
    skipRegistryConfirm: !!values['skip-registry-confirm'],
    bumpType,
    description,
    securityReview: values['security-review'] as string | undefined,
  };

  let ledger: Ledger;
  let mapping: ConnectorReleaseMapping;
  if (values.reconcile && values.resume) {
    console.error('--reconcile and --resume are mutually exclusive (reconcile seeds a fresh ledger).');
    process.exit(1);
  }
  if (values.reconcile) {
    const connectorName = positionals[0];
    if (!connectorName) {
      console.error('Usage: npm run mcp:release -- --reconcile <connector-name>');
      process.exit(1);
    }
    ({ ledger, mapping } = await seedReconcileLedger(connectorName, flags));
  } else if (values.resume) {
    ledger = readLedger(values.resume);
    mapping = getMapping(ledger.connectorName);
    console.log(`Resuming ${ledger.id} from stage ${ledger.stage}`);
  } else {
    const connectorName = positionals[0];
    if (!connectorName) {
      console.error('Usage: npm run mcp:release <connector-name>');
      process.exit(1);
    }
    mapping = getMapping(connectorName);
    ledger = newLedger(connectorName);
    writeLedger(ledger);
  }

  await run(ledger, mapping, flags);
}

// Only run when invoked directly (npx tsx scripts/mcp-release.ts ...);
// unit tests import the exported pure helpers without triggering a release.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
}
