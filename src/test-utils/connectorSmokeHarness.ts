/**
 * Connector live read-only smoke harness (TEST-ONLY — never imported by production code).
 *
 * Mirrors `src/test-utils/liveApiHarness.ts` (the LLM-provider live tier) for MCP
 * *connectors*: it exercises the real desktop path — credential/token resolution → MCP
 * connect → a real read-only tool call — for a representative sample of connectors using the
 * operator's stored tokens / keys. Two transports:
 *  - 'stdio' (default): spawns a local MCP via `StdioClientTransport` (slack/google/microsoft/
 *    elevenlabs/replit/vanta).
 *  - 'http': connects to a REMOTE OAuth MCP via `StreamableHTTPClientTransport`, passing the
 *    bearer access token as an Authorization header (notion). The remote path only READS the
 *    operator's token file and writes nothing locally; the static read-only guard can't AST-prove
 *    a remote server, so remote cells use a curated allowlist (guard-enforced against a hardcoded
 *    REMOTE_READONLY_OPS set) PLUS runtime verification that the server advertises
 *    `readOnlyHint:true` for each op before it is called.
 * Design + safety model: docs/project/CONNECTOR_LIVE_SMOKE.md and the PLAN
 * (docs/plans/260608_connector-live-smoke-tests/PLAN.md).
 *
 * SAFETY MODEL (accurate, not overclaimed):
 *  - NO external / service-side mutations. The runner calls ONLY tool names on the cell's
 *    static `readOnlyOps` allowlist, every one of which is `readOnlyHint:true` /
 *    not-`destructiveHint:true` (guard-proven, fail-closed). So nothing is created, modified,
 *    or deleted on the connected service.
 *  - LOCAL credential-state writes (OAuth access-token refresh rewriting a token file; SSH
 *    trust-on-first-use appending to known_hosts) CAN happen as a side-effect of authenticating
 *    for a read. These are isolated to DISPOSABLE temp copies: each cell copies the credential
 *    material it needs into an mkdtemp dir, points the spawn env/config paths at the COPY, and
 *    rm -rf's it in teardown. The user's REAL credential dirs are never used as spawn targets
 *    and are never modified. (This is NOT a claim of "literally zero writes anywhere" — it's a
 *    claim that all writes land in throwaway copies.)
 *
 * Enforced BY CONSTRUCTION:
 *  1. The runner calls ONLY tool names that appear in the cell's static `readOnlyOps`
 *     allowlist. It never lists the server's advertised tools and never accepts a tool name
 *     from anywhere but that frozen array. A write/destructive tool the server exposes is
 *     structurally unreachable from here.
 *  2. A separate static guard (`scripts/check-connector-smoke-readonly.ts`) asserts every
 *     allowlisted op is annotated `readOnlyHint: true` (and not `destructiveHint: true`) in
 *     the connector's tool registration, so the allowlist can't silently drift into a write.
 *  3. The whole tier is opt-in behind `RUN_CONNECTOR_SMOKE_TESTS`: unset/blank ⇒ every cell
 *     SKIPS with a clear, secret-free reason (keyless/credless = green, by construction), so
 *     the files are inert in normal / CI runs.
 *  4. A cell additionally SKIPS (never fails) when its prereqs (token file present, key env
 *     set, …) aren't met — the connector simply isn't connected on this machine.
 *  5. Tokens / keys are NEVER logged. Diagnostics are scrubbed of any value the cell marks as
 *     secret before being surfaced in a skip line or assertion message.
 *  6. The spawn descriptor a cell returns may carry a `cleanup()` that removes the disposable
 *     temp credential copies; the runner ALWAYS invokes it in teardown.
 *
 * IMPORTANT: this module must NOT enter app/runtime bundles. It lives under
 * `src/test-utils/`, imports only `vitest` + node + the MCP SDK + the pure (side-effect-free)
 * connector-smoke allowlist DATA, and reads only `process.env` (or an injected env map). Do not
 * import it from anything under `src/main`, `src/core`, `src/renderer`, or `src/preload`.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
// SSOT for the read-only allowlist (pure, side-effect-free DATA — imports nothing, no
// @private/Electron). The runner resolves the ops to call FROM THIS, keyed by connector id —
// NOT from a mutable per-cell field — so a cell can never diverge from the set the static guard
// (check-connector-smoke-readonly.ts) verifies.
import {
  allowlistEntryFor,
  type ConnectorReadOnlyOpSpec,
} from '../../tests/connector-smoke/connectorSmokeAllowlist';

/** Minimal, read-only env shape so callers/tests can inject without `process.env`. */
export type ConnectorSmokeEnv = Readonly<Record<string, string | undefined>>;

/**
 * A single cheap prerequisite for a cell to run (e.g. a token file existing, or an env var
 * being present). Evaluated lazily — `ok()` is a thunk so the harness only touches the
 * filesystem / env when the opt-in gate is already on. `diagnostic` is author-supplied and
 * surfaced in the skip line, so it MUST NOT contain secret material (the harness also
 * defensively scrubs known secret values before surfacing it).
 */
export interface ConnectorPrereq {
  name: string;
  ok: () => boolean;
  diagnostic: string;
}

/** What to spawn for a STDIO cell: a local MCP server process. */
export interface ConnectorSpawn {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd?: string;
  /**
   * Best-effort teardown for any disposable temp credential copies this spawn created (mkdtemp
   * dirs pointed at by the spawn env). ALWAYS invoked by the runner in `finally`, after the
   * client closes. Must not throw — wrap its own errors.
   */
  cleanup?: () => void;
}

/**
 * How to reach a REMOTE (HTTP) MCP: a Streamable-HTTP endpoint + the auth headers. The bearer
 * access token is passed as a header only; the runner never writes anything locally for a remote
 * cell (it just READS the token file). `cleanup` exists for symmetry but is rarely needed.
 */
export interface ConnectorHttpConnection {
  url: string;
  headers: Readonly<Record<string, string>>;
  cleanup?: () => void;
}

export interface ConnectorSmokeCell {
  /** Stable connector id (slack/google/microsoft/elevenlabs/replit/vanta). */
  connector: string;
  /** Auth family this cell represents — documentation only, surfaced in the label. */
  authFamily: string;
  /** Human-readable label used in the describe block + skip diagnostics. */
  label: string;
  /** Cheap presence checks; ALL must pass for the cell to run live. */
  prereqs: readonly ConnectorPrereq[];
  /**
   * THE ALLOWLIST IS NOT HERE. The runner resolves the ops to call from the pure SSOT
   * (`connectorSmokeAllowlist.ts`) keyed by `connector` — a cell cannot add/alter the tool-name
   * set, so it can never diverge from what the static read-only guard checks. A cell that needs
   * per-op call arguments (e.g. replit host/user) supplies them via `argsFor`, which can ONLY
   * override the arguments of an already-allowlisted op name — never introduce a new op.
   */
  argsFor?: (opName: string) => Readonly<Record<string, unknown>> | undefined;
  /**
   * Transport: 'stdio' (default) spawns a local MCP via `buildSpawn`; 'http' connects to a
   * remote MCP via `buildHttpConnection` (Streamable-HTTP). Exactly one builder must match.
   */
  transport?: 'stdio' | 'http';
  /** Build the stdio spawn descriptor (transport 'stdio'). Called only when the cell can run. */
  buildSpawn?: () => ConnectorSpawn;
  /** Build the remote HTTP connection (transport 'http'). Called only when the cell can run. */
  buildHttpConnection?: () => ConnectorHttpConnection;
  /**
   * Secret values to scrub out of any surfaced diagnostic (defense-in-depth for invariant 5).
   * Author-supplied (e.g. the resolved API key / client secret); evaluated lazily.
   */
  secretsToScrub?: () => readonly string[];
  /**
   * For OAuth cells: did the COMMERCIAL client creds (CLIENT_ID/SECRET, or Microsoft clientId)
   * resolve? When true and the connector nonetheless returns `auth_required`, that is more
   * suspicious than a plain expired token — it may be a real live-path regression (a renamed /
   * wrong spawn env var), so the runner logs a prominent DEGRADED warning instead of an
   * invisible skip (F2). Omit for API-key/SSH cells where it doesn't apply.
   */
  clientCredsResolved?: () => boolean;
}

/**
 * Gating result. A discriminated union: a cell either can run (prereqs met + opt-in on) or
 * has a specific, secret-free skip reason. SKIP is always the safe outcome.
 */
export type ConnectorSmokePrereq =
  | { canRun: true }
  | { canRun: false; skipReason: string };

/** Invariant: trim, treat empty / whitespace-only as absent. */
function trimEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export interface SkippedConnectorSmokeOp {
  name: string;
  skipReason: string;
}

export interface ResolvedConnectorSmokeOps {
  /** Ops whose arguments are complete and should be called. */
  runnableOps: ConnectorReadOnlyOpSpec[];
  /** Env-gated ops skipped green before any call. */
  skippedOps: SkippedConnectorSmokeOp[];
  /** The raw SSOT op count, before env-gated skips. */
  allowlistedCount: number;
}

/**
 * The authoritative ops a cell will exercise — resolved from the SSOT allowlist (keyed by the
 * cell's `connector`), with each op's arguments optionally overridden by `cell.argsFor(name)` or
 * extended from declarative env bindings on the op spec. The NAME set comes ONLY from the SSOT, so
 * a cell cannot introduce an unguarded op.
 */
export function resolveOpsFromAllowlist(
  cell: ConnectorSmokeCell,
  env: ConnectorSmokeEnv = process.env,
): ResolvedConnectorSmokeOps {
  const entry = allowlistEntryFor(cell.connector);
  const runnableOps: ConnectorReadOnlyOpSpec[] = [];
  const skippedOps: SkippedConnectorSmokeOp[] = [];

  for (const op of entry.readOnlyOps) {
    const overrideArgs = cell.argsFor?.(op.name);
    const args: Record<string, unknown> = { ...(overrideArgs ?? op.arguments) };
    let missingEnv: { argument: string; env: string } | undefined;

    for (const envArg of op.envArguments ?? []) {
      const value = trimEnvValue(env[envArg.env]);
      if (!value) {
        missingEnv = { argument: envArg.argument, env: envArg.env };
        break;
      }
      args[envArg.argument] = value;
    }

    if (missingEnv) {
      skippedOps.push({
        name: op.name,
        skipReason:
          `${cell.connector}.${op.name}: ${missingEnv.env} is not set ` +
          `(required for argument '${missingEnv.argument}').`,
      });
      continue;
    }

    runnableOps.push({ ...op, arguments: args });
  }

  return { runnableOps, skippedOps, allowlistedCount: entry.readOnlyOps.length };
}

/**
 * Defense-in-depth for invariant 5: strip any cell-declared secret value out of a string
 * before surfacing it. Authors keep secrets out of diagnostics; this guarantees it.
 */
function scrubSecrets(message: string, secrets: readonly string[]): string {
  let scrubbed = message;
  for (const secret of secrets) {
    const trimmed = secret?.trim();
    if (!trimmed) continue;
    scrubbed = scrubbed.split(trimmed).join('[REDACTED]');
  }
  return scrubbed;
}

function parseJsonResponse(cell: ConnectorSmokeCell, op: ConnectorReadOnlyOpSpec, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `${cell.connector}.${op.name} response did not parse as JSON: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function expectOkTrue(cell: ConnectorSmokeCell, op: ConnectorReadOnlyOpSpec, parsed: unknown): void {
  const body = parsed as { ok?: unknown };
  expect(body?.ok, `${cell.connector}.${op.name} expected JSON ok === true`).toBe(true);
}

function expectSlackMessageFilesMetadata(
  cell: ConnectorSmokeCell,
  op: ConnectorReadOnlyOpSpec,
  parsed: unknown,
): void {
  const body = parsed as { message?: { files?: unknown } };
  const files = body?.message?.files;
  expect(
    Array.isArray(files) && files.length > 0,
    `${cell.connector}.${op.name} expected message.files to be a non-empty array`,
  ).toBe(true);

  if (!Array.isArray(files)) return;
  for (const [index, file] of files.entries()) {
    const f = file as { id?: unknown; mimetype?: unknown; size?: unknown };
    expect(
      typeof f.id === 'string' && f.id.trim().length > 0,
      `${cell.connector}.${op.name} expected message.files[${index}].id`,
    ).toBe(true);
    expect(
      typeof f.mimetype === 'string' && f.mimetype.trim().length > 0,
      `${cell.connector}.${op.name} expected message.files[${index}].mimetype`,
    ).toBe(true);
    expect(
      typeof f.size === 'number' && Number.isFinite(f.size),
      `${cell.connector}.${op.name} expected message.files[${index}].size`,
    ).toBe(true);
  }
}

export function assertConnectorSmokeJsonExpectations(
  cell: ConnectorSmokeCell,
  op: ConnectorReadOnlyOpSpec,
  text: string,
): void {
  const expectations = op.responseJsonExpectations ?? [];
  if (expectations.length === 0) return;

  const parsed = parseJsonResponse(cell, op, text);
  for (const expectation of expectations) {
    switch (expectation) {
      case 'okTrue':
        expectOkTrue(cell, op, parsed);
        break;
      case 'slackMessageHasFilesMetadata':
        expectSlackMessageFilesMetadata(cell, op, parsed);
        break;
      default: {
        const exhaustive: never = expectation;
        throw new Error(`${cell.connector}.${op.name} has unknown JSON expectation '${exhaustive}'`);
      }
    }
  }
}

/**
 * Pure gating decision for a single cell. SKIP is always the safe outcome — this never
 * throws and never fails a test. `env` is injectable so unit tests can exercise the logic
 * without mutating `process.env`.
 *
 * Order of checks (each produces a specific, secret-free skipReason):
 *  1. Opt-in gate `RUN_CONNECTOR_SMOKE_TESTS` unset/blank.
 *  2. Any failing prereq (token/key presence) — surfaces its (scrubbed) diagnostic.
 */
export function getConnectorSmokePrereq(
  cell: ConnectorSmokeCell,
  env: ConnectorSmokeEnv = process.env,
): ConnectorSmokePrereq {
  // Opt-in behind a single gate. `npm run test:live` folds this tier in by setting
  // RUN_CONNECTOR_SMOKE_TESTS=1 alongside RUN_LIVE_API_TESTS, so the live-API run also
  // exercises connectors — without this cell gate (or the provider-registration gate)
  // needing to know about the live-API env var.
  if (!trimEnvValue(env.RUN_CONNECTOR_SMOKE_TESTS)) {
    return {
      canRun: false,
      skipReason: 'RUN_CONNECTOR_SMOKE_TESTS is not set (connector-smoke tier is opt-in).',
    };
  }

  const secrets = cell.secretsToScrub?.() ?? [];
  for (const prereq of cell.prereqs) {
    let ok = false;
    try {
      ok = prereq.ok();
    } catch (error) {
      // A prereq that throws (e.g. an unreadable path) is treated as not-met, never a failure.
      return {
        canRun: false,
        skipReason: `prerequisite '${prereq.name}' could not be evaluated: ${scrubSecrets(
          error instanceof Error ? error.message : String(error),
          secrets,
        )}`,
      };
    }
    if (!ok) {
      return {
        canRun: false,
        skipReason: `prerequisite '${prereq.name}' not met: ${scrubSecrets(prereq.diagnostic, secrets)}`,
      };
    }
  }

  return { canRun: true };
}

/** Build the single skip-diagnostic line for a skipped cell. Pure + secret-free. */
export function connectorSmokeSkipLogLine(cell: ConnectorSmokeCell, skipReason: string): string {
  return `Skipping connector-smoke test: ${cell.label}: ${skipReason}`;
}

/**
 * The DEGRADED warning emitted when a remote cell's token resolved but the server rejected it.
 * By construction it takes only the connector id + phase — NEVER the thrown error — so the bearer
 * token can never leak into the warning even if the SDK/server error embedded it. Exported so
 * this no-token-leak invariant is unit-tested (item 3).
 */
export function remoteAuthSkipDegradedLine(connector: string, phase: string): string {
  return (
    `[connector-smoke] DEGRADED ${connector}: remote token RESOLVED but the server ` +
    `rejected it (auth error at ${phase}). Likely an expired/revoked token; reconnect ${connector}.`
  );
}

/** The skip reason for a remote auth failure. Connector + phase only — never the error. */
export function remoteAuthSkipReason(connector: string, phase: string): string {
  return `${connector}: token expired/needs reconnect (remote auth error at ${phase}).`;
}

/** Extract a text block payload (parsed JSON when possible) from an MCP tool result. */
function readResultText(result: unknown): { text: string | undefined; isError: boolean } {
  const r = result as { content?: unknown; isError?: unknown };
  const isError = r?.isError === true;
  const blocks = Array.isArray(r?.content) ? r.content : [];
  const textBlock = blocks.find(
    (block): block is { type: string; text: string } =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string',
  );
  return { text: textBlock?.text, isError };
}

/** Minimal shape of an MCP `listTools` result this harness reads. */
interface AdvertisedTools {
  tools: ReadonlyArray<{
    name: string;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  }>;
}

/**
 * Remote defense-in-depth: for an http cell, assert the SERVER advertises `readOnlyHint:true`
 * (and not `destructiveHint:true`) for every allowlisted op BEFORE any call. The static guard
 * can't AST-prove a remote server, so this verifies the curated choice at runtime. We still only
 * ever call the static allowlist — this never selects a tool name from the server's list.
 */
function verifyRemoteAnnotations(
  cell: ConnectorSmokeCell,
  ops: readonly ConnectorReadOnlyOpSpec[],
  advertised: AdvertisedTools,
): void {
  const byName = new Map(advertised.tools.map((t) => [t.name, t]));
  for (const op of ops) {
    const tool = byName.get(op.name);
    expect(
      tool !== undefined,
      `${cell.connector}.${op.name}: allowlisted op is not advertised by the remote server`,
    ).toBe(true);
    expect(
      tool?.annotations?.readOnlyHint === true,
      `${cell.connector}.${op.name}: remote server does NOT advertise readOnlyHint:true ` +
        `(got ${String(tool?.annotations?.readOnlyHint)}) — refusing to call`,
    ).toBe(true);
    expect(
      tool?.annotations?.destructiveHint !== true,
      `${cell.connector}.${op.name}: remote server advertises destructiveHint:true — refusing to call`,
    ).toBe(true);
  }
}

/**
 * Detect an MCP needs-(re)auth / connect-account response so it becomes a skip-with-DEGRADED,
 * never a hard red — across the varied shapes connectors use. Connectors signal "the operator's
 * connected account needs (re)connection" rather than throwing; e.g. Slack/Google emit
 * `status: "auth_required"` / `user_action.id: <connector>.connect_account` /
 * `setupToolName: authenticate_*`, while microsoft-calendar's no-account path returns
 * `{ ok: false, error: "No Microsoft account found...", next_step: "authenticate_microsoft_account" }`.
 *
 * MUST stay SPECIFIC to auth/connect signals — a generic non-auth MCP error (e.g. rate-limited)
 * must STILL fail, so this returns false for it. Matched structurally (parsed JSON) with a string
 * fallback so a body-shape change can't silently turn an auth-state skip into a hard red.
 */
export function isAuthRequired(text: string | undefined): boolean {
  if (!text) return false;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.status === 'auth_required') return true;
    const userAction = parsed.user_action as { id?: unknown } | undefined;
    if (typeof userAction?.id === 'string' && userAction.id.includes('connect_account')) return true;
    if (typeof parsed.setupToolName === 'string' && /authenticate/i.test(parsed.setupToolName)) return true;

    // Broadened error-envelope backstop. Only treats an error as auth-required when an explicit
    // auth/connect signal is present — never a generic failure.
    const nextStep = typeof parsed.next_step === 'string' ? parsed.next_step : '';
    const actionRequired = typeof parsed.action_required === 'string' ? parsed.action_required : '';
    const errorMsg = typeof parsed.error === 'string' ? parsed.error : '';
    const failed = parsed.ok === false || parsed.isError === true;
    if (/authenticate/i.test(nextStep)) return true;
    if (failed && (/authenticate/i.test(nextStep) || /authenticate/i.test(actionRequired))) return true;
    if (/no\s+\S*\s*account found|connect (your )?\S*\s*account|account .*not connected/i.test(errorMsg)) {
      return true;
    }
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'connectorSmoke.isAuthRequired.parse',
      reason: 'best-effort JSON parse before textual auth-required fallback',
    });
  }
  return /\bauth_required\b/.test(text) || /connect_account\b/.test(text);
}

/**
 * Detect a remote (HTTP) auth failure surfaced as a THROWN error rather than an isError body —
 * e.g. an expired/invalid bearer token. Inspects BOTH numeric carriers `.status` and `.code` (the
 * MCP SDK's `StreamableHTTPError` carries the HTTP status on `.code`, not `.status`).
 *
 * 401 / "Unauthorized" / explicit token language (invalid_token / token expired / invalid_grant)
 * → auth-skip (expired token shouldn't redden the tier). 403 / "forbidden" is treated as auth ONLY
 * when accompanied by explicit token/auth language — a bare 403 is a SCOPE/POLICY failure (e.g. a
 * removed scope, a real authorization regression) and must FAIL, not be hidden as "reconnect".
 * Generic / server / network errors (500, ECONNRESET, timeout) always FAIL.
 */
export function isRemoteAuthError(error: unknown): boolean {
  const e = error as { status?: unknown; code?: unknown };
  const message = error instanceof Error ? error.message : String(error ?? '');

  const hasTokenLanguage =
    /invalid[_\s-]?token|token (?:has )?expired|expired token|invalid_grant|unauthorized|\b401\b/i.test(
      message,
    );

  // 401 (numeric or textual) / explicit token language → always auth-skip.
  if (e?.status === 401 || e?.code === 401 || hasTokenLanguage) return true;

  // 403 / "forbidden" → auth-skip ONLY with explicit token/auth language; a bare 403 must FAIL
  // (don't hide a scope/policy regression as a reconnect).
  const is403 = e?.status === 403 || e?.code === 403 || /\b403\b|forbidden/i.test(message);
  if (is403 && hasTokenLanguage) return true;

  return false;
}

/**
 * Run the live read-only smoke for a single cell. Wrapped in `describe` (when the cell can
 * run) or `describe.skip` (otherwise), logging exactly one secret-free diagnostic line per
 * skipped cell.
 *
 * FAIL-CLOSED: the ONLY tool calls this function can make are the names resolved from the SSOT
 * allowlist (`resolveOpsFromAllowlist`, keyed by connector). It
 * never calls `listTools()` to discover names and never reads a name from the server or the
 * environment. Adding a write op is therefore impossible without editing the cell's static
 * allowlist (which the read-only guard then rejects).
 *
 * NOTE: call at the top level of a test file (or inside another `describe`), never inside an
 * `it` — it creates a vitest suite. `env` is injectable for unit testing.
 */
export function runConnectorSmoke(
  cell: ConnectorSmokeCell,
  env: ConnectorSmokeEnv = process.env,
): void {
  const prereq = getConnectorSmokePrereq(cell, env);
  if (!prereq.canRun) {
    console.warn(connectorSmokeSkipLogLine(cell, prereq.skipReason));
    describe.skip(cell.label, () => {
      it('skipped (prereq not met)', () => undefined);
    });
    return;
  }

  // Resolve the ops to call STRICTLY from the SSOT allowlist (keyed by connector) — never from a
  // mutable per-cell field. A cell cannot add/alter the tool-name set the guard checks.
  const { runnableOps: ops, skippedOps, allowlistedCount } = resolveOpsFromAllowlist(cell, env);
  for (const skippedOp of skippedOps) {
    console.warn(connectorSmokeSkipLogLine(cell, skippedOp.skipReason));
  }

  describe(cell.label, () => {
    it(
      `spawns the connector and calls only its read-only allowlist (${ops.map((op) => op.name).join(', ')})`,
      async (ctx) => {
        // Red-team F5: zero-coverage must FAIL, not silently green. An empty resolved op set means
        // the SSOT entry has no ops — the cell would "pass" without exercising anything.
        expect(
          allowlistedCount > 0,
          `${cell.connector}: resolved 0 read-only ops from the allowlist — refusing a zero-coverage pass`,
        ).toBe(true);
        if (ops.length === 0) {
          ctx.skip(`${cell.connector}: all allowlisted ops skipped due to missing operator env.`);
          return;
        }

        const secrets = cell.secretsToScrub?.() ?? [];
        const isHttp = cell.transport === 'http';

        // Build the transport + a single cleanup handle, per transport kind.
        let transport: StdioClientTransport | StreamableHTTPClientTransport;
        let cleanup: (() => void) | undefined;
        if (isHttp) {
          if (!cell.buildHttpConnection) {
            throw new Error(`${cell.connector}: transport 'http' but no buildHttpConnection()`);
          }
          const conn = cell.buildHttpConnection();
          cleanup = conn.cleanup;
          transport = new StreamableHTTPClientTransport(new URL(conn.url), {
            requestInit: { headers: { ...conn.headers } },
          });
        } else {
          if (!cell.buildSpawn) {
            throw new Error(`${cell.connector}: transport 'stdio' but no buildSpawn()`);
          }
          const spawn = cell.buildSpawn();
          cleanup = spawn.cleanup;
          transport = new StdioClientTransport({
            command: spawn.command,
            args: [...spawn.args],
            env: { ...spawn.env },
            cwd: spawn.cwd,
            stderr: 'pipe',
          });
        }

        const client = new Client(
          { name: 'connector-smoke', version: '0.0.0' },
          { capabilities: {} },
        );
        // Shared auth-skip handler for any remote (http) phase (connect / listTools / call): a
        // 401/403/expired-token is RECORDED via ctx.skip() (+ a DEGRADED warn when the token
        // resolved) and ends the test — it must not redden the tier. Returns true if it handled
        // the error (caller should `return`); false means the caller must rethrow.
        const handledAsRemoteAuthSkip = (phase: string, error: unknown): boolean => {
          if (!(isHttp && isRemoteAuthError(error))) return false;
          // The DEGRADED line + skip reason are built from connector id + phase ONLY — the thrown
          // `error` is never logged here, so no bearer token can leak even if it embedded one.
          if (cell.clientCredsResolved?.()) {
            console.warn(remoteAuthSkipDegradedLine(cell.connector, phase));
          }
          ctx.skip(remoteAuthSkipReason(cell.connector, phase));
          return true;
        };

        // Holds a connect/listTools error so the skip-vs-rethrow decision happens OUTSIDE the
        // catch (keeps the deliberate `return` out of an in-catch silent-swallow lint flag).
        let connectPhaseError: { error: unknown } | undefined;

        try {
          // A remote 401/expired-token can throw at CONNECT *or* listTools time. Both go through
          // the same auth-skip handler so neither reddens the tier.
          try {
            await client.connect(transport);

            // Remote defense-in-depth: the static guard can't AST-prove a remote server's
            // annotations, so verify the SERVER's advertised annotations here — every allowlisted
            // op must advertise readOnlyHint===true BEFORE we call it; otherwise FAIL (don't call).
            // This VERIFIES the curated choice; we still only ever call the static allowlist (we do
            // NOT select tool names from the server list). listTools is INSIDE this try so a 401
            // here is also an auth-skip, not a hard red.
            if (isHttp) {
              const advertised = await client.listTools(undefined, { timeout: 60_000 });
              verifyRemoteAnnotations(cell, ops, advertised);
            }
          } catch (error) {
            // Capture and re-raise OUTSIDE the catch so the skip-vs-rethrow branch (incl. its
            // `return`) is not flagged as an in-catch silent swallow. The error is rethrown
            // (scrubbed) for the non-auth case, so nothing is swallowed.
            connectPhaseError = { error };
          }
          if (connectPhaseError) {
            if (handledAsRemoteAuthSkip('connect', connectPhaseError.error)) {
              // RECORDED via ctx.skip() (+ DEGRADED warn) inside the handler — nothing logs the
              // raw error, so no token can leak. Deliberate auth-skip path.
              return;
            }
            // Scrub the bearer token out of the message before rethrowing (F1: no error path,
            // even a non-auth one at connect/listTools, may surface secret material).
            const raw = connectPhaseError.error;
            const message = scrubSecrets(raw instanceof Error ? raw.message : String(raw), secrets);
            throw new Error(`${cell.connector} (connect/listTools) failed: ${message}`);
          }

          // Iterate the STATIC allowlist ONLY. There is no code path here that can derive a
          // tool name from the server or anywhere but this frozen array.
          for (const op of ops) {
            let result: unknown;
            let callError: { error: unknown } | undefined;
            try {
              result = await client.callTool(
                { name: op.name, arguments: { ...op.arguments } },
                undefined,
                { timeout: 120_000 },
              );
            } catch (error) {
              // Capture and decide OUTSIDE the catch (keeps the deliberate auth-skip `return` out
              // of an in-catch silent-swallow flag). Non-auth errors are rethrown (scrubbed) below.
              callError = { error };
            }
            if (callError) {
              // A remote 401/expired-token can throw at CALL time too → same auth-skip handler.
              if (handledAsRemoteAuthSkip(`call ${op.name}`, callError.error)) {
                // RECORDED via ctx.skip() (+ DEGRADED warn) inside the handler — nothing logs the
                // raw error, so no token can leak. Deliberate auth-skip path.
                return;
              }
              const raw = callError.error;
              const message = scrubSecrets(raw instanceof Error ? raw.message : String(raw), secrets);
              throw new Error(`${cell.connector}.${op.name} threw: ${message}`);
            }
            const { text, isError } = readResultText(result);
            const detail = scrubSecrets(text ?? JSON.stringify(result), secrets).slice(0, 400);
            // An `auth_required` response means the operator's connected account needs
            // (re)connection — a token/account-state condition, NOT a code regression. It is
            // ambiguous at this layer (a missing commercial CLIENT_ID/SECRET would also surface
            // as a refresh-time auth_required), so we SKIP rather than fail: the dedicated L1
            // unit test (commercialOAuthCredentialResolution.test.ts) owns the client-creds
            // regression and fails loud on it. Skipping here keeps the live tier from going red
            // every time a stored token simply expires.
            if (isError && isAuthRequired(text)) {
              // F2: if the commercial client creds DID resolve (prereq passed) yet the connector
              // still reports auth_required, this may be a real live-path regression (e.g. a
              // renamed / wrong spawn env var), not merely an expired token. We still SKIP (a
              // genuine token expiry must not turn the live tier red), but we emit a prominent
              // DEGRADED line so it's visible in the run output rather than an invisible skip.
              if (cell.clientCredsResolved?.()) {
                console.warn(
                  `[connector-smoke] DEGRADED ${cell.connector}.${op.name}: commercial client creds RESOLVED ` +
                    `but the connector returned auth_required. This is expected for a plainly-expired stored ` +
                    `token, BUT could also be a live-path regression (wrong/renamed spawn env var). ` +
                    `Investigate if you did not expect this account's token to be expired.`,
                );
              }
              ctx.skip(
                `${cell.connector}.${op.name}: connected account requires (re)connection (auth_required) — ` +
                  `cannot validate the live read path. L1 covers the commercial-credential case.`,
              );
              return;
            }
            // Basic response-shape assertions: a non-error tool result with some content.
            expect(isError, `${cell.connector}.${op.name} returned an MCP error: ${detail}`).toBe(
              false,
            );
            expect(
              text !== undefined,
              `${cell.connector}.${op.name} returned no text content: ${detail}`,
            ).toBe(true);
            if (text !== undefined) {
              assertConnectorSmokeJsonExpectations(cell, op, text);
            }
          }
        } finally {
          try {
            await client.close();
          } catch (error: unknown) {
            ignoreBestEffortCleanup(error, {
              operation: 'connectorSmoke.client.close',
              reason: 'best-effort teardown of the MCP client after a read-only smoke',
            });
          }
          // ALWAYS remove the disposable temp credential copies (stdio), even if the read
          // failed/threw. Remote cells typically have no cleanup (they only read a token file).
          if (cleanup) {
            try {
              cleanup();
            } catch (error: unknown) {
              ignoreBestEffortCleanup(error, {
                operation: 'connectorSmoke.connection.cleanup',
                reason: 'best-effort removal of the disposable temp credential copy after a smoke',
              });
            }
          }
        }
      },
      180_000,
    );
  });
}
