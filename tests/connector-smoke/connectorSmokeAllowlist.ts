/**
 * Connector-smoke read-only ALLOWLIST — pure, side-effect-free DATA (the single source of
 * truth for what tools the smoke is allowed to call).
 *
 * SAFETY-CRITICAL and intentionally DEPENDENCY-FREE. This module imports NOTHING — no
 * `@private/mindstone`, no `setOAuthCredentialsProvider`, no spawn/runtime helpers, no
 * `@core/services/*`. It is plain data so it can be imported by BOTH:
 *   1. `scripts/check-connector-smoke-readonly.ts` (a standalone CLI + a validate:fast gate
 *      step that runs OUTSIDE Electron — pulling in the runtime-heavy cells module here would
 *      transitively `new ElectronStore()` and crash with "Please specify the 'projectName'
 *      option"), and
 *   2. `tests/connector-smoke/connectorSmokeCells.ts` (the live cells derive their
 *      `readOnlyOps` from this same data, so the live allowlist can't drift from what the
 *      static read-only guard verifies).
 *
 * LOCAL (stdio) entries: add the tool source dir + read-only op names. The guard
 * (`check-connector-smoke-readonly.ts`) AST-proves each op is annotated `readOnlyHint:true` and
 * not `destructiveHint:true` in that connector's source.
 *
 * REMOTE (http) entries (e.g. Notion): there is no local source to AST-prove. Mark them
 * `remote: true` with a curated op set. The guard requires every remote op to be in the hardcoded
 * `REMOTE_READONLY_OPS` set below (so it still FAILS if someone adds a non-curated/write op), and
 * the runner additionally verifies at runtime that the server advertises `readOnlyHint:true` for
 * each op before calling it. See the per-op citation comments.
 */

/** An operator-supplied env var that maps to one read-only tool call argument. */
export interface ConnectorEnvArgumentSpec {
  /** Tool argument name to populate when the env var is set. */
  argument: string;
  /** Operator env var name. Missing/blank means this op skips green. */
  env: string;
}

export type ConnectorResponseJsonExpectation = 'okTrue' | 'slackMessageHasFilesMetadata';

/** A read-only tool name + its minimal read-only call arguments. */
export interface ConnectorReadOnlyOpSpec {
  /** Read-only tool name — MUST be annotated read-only (enforced by the static guard). */
  name: string;
  /** Minimal read-only arguments for the call. */
  arguments: Readonly<Record<string, unknown>>;
  /** Optional env-sourced arguments. Missing/blank env vars skip this op green. */
  envArguments?: readonly ConnectorEnvArgumentSpec[];
  /** Optional declarative JSON response assertions owned by the harness. */
  responseJsonExpectations?: readonly ConnectorResponseJsonExpectation[];
}

/** Per-connector allowlist entry — pure data shared by the guard and the live cells. */
export interface ConnectorSmokeAllowlistEntry {
  /** Stable connector id (slack/google/microsoft/elevenlabs/replit/vanta/notion). */
  connector: string;
  /**
   * LOCAL connectors only: directory name under `mcp-servers/connectors/` the guard greps for
   * tool registrations. Omitted for remote (http) connectors, which have no local source.
   */
  toolSourceConnectorDir?: string;
  /** True for REMOTE (http) connectors — the guard checks ops against REMOTE_READONLY_OPS. */
  remote?: boolean;
  /** THE read-only allowlist for this connector. */
  readOnlyOps: readonly ConnectorReadOnlyOpSpec[];
}

/**
 * Curated read-only ops for REMOTE MCPs (no local source to AST-prove). An op on a remote cell's
 * allowlist MUST appear here or the static guard FAILS. Each entry is a documented read:
 *  - notion-get-users  — Notion remote MCP advertises readOnlyHint:true, destructiveHint:false;
 *    "Retrieves a list of users" (a `get-` read). Confirmed live (16 tools, isError:false).
 *  - notion-get-teams  — same: readOnlyHint:true, destructiveHint:false; "Retrieves a list of
 *    teams (teamspaces)" (a `get-` read). Confirmed live.
 */
export const REMOTE_READONLY_OPS: readonly string[] = ['notion-get-users', 'notion-get-teams'];

export const CONNECTOR_SMOKE_ALLOWLIST: readonly ConnectorSmokeAllowlistEntry[] = [
  {
    connector: 'slack',
    toolSourceConnectorDir: 'slack',
    readOnlyOps: [
      { name: 'list_slack_workspaces', arguments: {} },
      { name: 'list_slack_channels', arguments: { limit: 5 } },
      {
        name: 'get_slack_message_by_link',
        arguments: { include_thread: false },
        envArguments: [{ argument: 'url', env: 'SLACK_SMOKE_PERMALINK' }],
        responseJsonExpectations: ['okTrue', 'slackMessageHasFilesMetadata'],
      },
    ],
  },
  {
    connector: 'google',
    toolSourceConnectorDir: 'google-workspace',
    readOnlyOps: [
      { name: 'list_workspace_accounts', arguments: {} },
      { name: 'list_workspace_calendars', arguments: {} },
    ],
  },
  {
    connector: 'microsoft',
    toolSourceConnectorDir: 'microsoft-calendar',
    readOnlyOps: [{ name: 'list_calendars', arguments: {} }],
  },
  {
    connector: 'elevenlabs',
    toolSourceConnectorDir: 'elevenlabs',
    readOnlyOps: [{ name: 'list_voices', arguments: {} }],
  },
  {
    connector: 'replit',
    toolSourceConnectorDir: 'replit-ssh',
    // host/user are injected from env at spawn time by the cell — not hardcoded here.
    readOnlyOps: [{ name: 'replit_check_connection', arguments: {} }],
  },
  {
    connector: 'vanta',
    toolSourceConnectorDir: 'vanta',
    readOnlyOps: [
      { name: 'vanta_list_controls', arguments: {} },
      { name: 'vanta_list_people', arguments: {} },
    ],
  },
  {
    // REMOTE OAuth MCP (Streamable-HTTP at https://mcp.notion.com/mcp). No local source to
    // AST-prove → curated ops (must be in REMOTE_READONLY_OPS) + runtime readOnlyHint check.
    connector: 'notion',
    remote: true,
    readOnlyOps: [
      { name: 'notion-get-users', arguments: {} },
      { name: 'notion-get-teams', arguments: {} },
    ],
  },
] as const;

/** Lookup an allowlist entry by connector id (throws if unknown — programmer error). */
export function allowlistEntryFor(connector: string): ConnectorSmokeAllowlistEntry {
  const entry = CONNECTOR_SMOKE_ALLOWLIST.find((e) => e.connector === connector);
  if (!entry) {
    throw new Error(`No connector-smoke allowlist entry for connector '${connector}'`);
  }
  return entry;
}
