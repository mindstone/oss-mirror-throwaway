import type { IdentityKind } from '../identityKinds';

export type McpMode = 'none' | 'direct' | 'super-mcp';

export type McpSummaryStatus = 'missing' | 'ready' | 'error';

export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpServerPreview {
  name: string;
  transport: McpTransport;
  type?: string | null;
  command?: string | null;
  args?: string[] | null;
  url?: string | null;
  cwd?: string | null;
  envKeys?: string[];
  headersKeys?: string[];
  description?: string | null;
  health?: 'ok' | 'error' | 'unavailable';
  catalogStatus?: 'ready' | 'auth_required' | 'error';
  catalogError?: string | null;
  catalogSummary?: string | null;
  toolCount?: number | null;
  /** Links server to catalog entry (e.g., 'bundled-fathom'). Used for catalog matching. */
  catalogId?: string | null;
  /** Account email for this server (for account disambiguation). */
  email?: string | null;
  /** Workspace/team name for workspace-based MCPs like Slack. */
  workspace?: string | null;
  /** Timestamp when this server was last connected/authenticated (epoch ms). */
  lastConnectedAt?: number | null;
  /** Whether this server is disabled (excluded from tool routing but visible in UI). */
  disabled?: boolean;
  /**
   * Whether this server uses OAuth. Mirrors the persisted `oauth: true` field on the
   * super-mcp-router.json entry. Used by Settings UI to surface a "Re-authenticate"
   * affordance for custom (non-catalog) OAuth connectors whose catalog metadata is
   * absent. Only `true` is meaningful — otherwise the field is omitted.
   */
  oauth?: boolean;
  /**
   * Whether this account's OAuth refresh token is dead and the user must
   * reconnect (persisted needs-reconnect latch, `oauthRefreshFailureStore`).
   * Overlaid by `describeMcpConfiguration` onto every emitted server list.
   * Deliberately separate from `health`: `health === 'error'` means "MCP
   * server broken" (different failure mode, different remediation).
   * Only `true` is meaningful; ABSENT means healthy-or-unknown (the overlay
   * omits the field entirely when the latch store cannot be read).
   */
  needsReconnect?: boolean;
}

export interface McpServerConfigDetails {
  name: string;
  type: string | null;
  transport: McpTransport;
  command: string | null;
  args: string[] | null;
  url: string | null;
  cwd: string | null;
  env: Record<string, string> | null;
  headers: Record<string, string> | null;
  description: string | null;
  /** Links server to catalog entry (e.g., 'bundled-fathom'). Used for catalog matching. */
  catalogId?: string | null;
  /** Account email for this server (for account disambiguation). */
  email?: string | null;
  /** Workspace/team name for workspace-based MCPs like Slack. */
  workspace?: string | null;
  /** Timestamp when this server was last connected/authenticated (epoch ms). */
  lastConnectedAt?: number | null;
}

export interface McpRouterPreview {
  configPaths: string[];
  upstreamServers: McpServerPreview[];
  upstreamCount: number;
  httpMode: 'stdio' | 'http';
  isRunning: boolean;
  port?: number;
  url?: string;
  lastHealthCheck?: number | null;
}

export interface McpConfigSummary {
  status: McpSummaryStatus;
  mode: McpMode;
  configPath: string | null;
  servers: McpServerPreview[];
  editableServers?: McpServerPreview[];
  upstreamCount: number;
  router?: McpRouterPreview | null;
  lastLoadedAt: number;
  error?: string;
  managed?: {
    isManaged: boolean;
    managedPath: string;
    sourcePath?: string | null;
    wrapperVersion?: number;
  };
}

export interface McpServerUpsertPayload {
  name: string;
  transport?: McpTransport;
  /** Specific transport type (http vs sse). Takes precedence over transport when saving. */
  type?: 'http' | 'sse' | null;
  command?: string | null;
  args?: string[] | null;
  url?: string | null;
  cwd?: string | null;
  env?: Record<string, string> | null;
  headers?: Record<string, string> | null;
  description?: string | null;
  oauth?: boolean | null;
  /** Extra OAuth authorization URL params (e.g., { prompt: 'consent' } for workspace selection) */
  oauthParams?: Record<string, string> | null;
  /** Pre-registered OAuth client ID (for servers that don't support DCR, e.g. Asana V2) */
  oauthClientId?: string | null;
  /** Pre-registered OAuth client secret */
  oauthClientSecret?: string | null;
  /**
   * Optional raw JSON config string. If provided, the server extracts the config
   * using `extractServerConfig()` which supports various formats (Claude Desktop,
   * keyed, standard, etc.). The extracted config is validated and used to build
   * the server entry. If `name` is not provided, it will be extracted from the config.
   */
  rawConfig?: string | null;
  /** Links server to catalog entry (e.g., 'bundled-fathom'). Used for catalog matching. */
  catalogId?: string | null;
  /** Account email for this server (for account disambiguation). */
  email?: string | null;
  /** Workspace/team name for workspace-based MCPs like Slack. */
  workspace?: string | null;
  /** Timestamp when this server was last connected/authenticated (epoch ms). Auto-set on user-initiated connect. */
  lastConnectedAt?: number | null;
}

export interface McpRouterPathPatchPayload {
  action: 'add' | 'remove';
  path: string;
}

export interface McpConfigMutationResult {
  summary: McpConfigSummary;
  backupPath?: string | null;
}

/**
 * Information about an individual MCP tool from a server.
 * Returned by settings:mcp-list-tools for the tool visibility UI.
 */
export interface McpToolInfo {
  /** Server ID (e.g., "GoogleWorkspace-greg-work-com", "Slack-mindstone") */
  serverId: string;
  /** Fully-qualified tool ID (e.g., "filesystem__read_file") */
  toolId: string;
  /** Tool name (usually same as toolId) */
  name: string;
  /** Short description of what the tool does */
  summary?: string;
  /** Example argument structure hint */
  argsSkeleton?: unknown;
  /** Whether this tool is blocked by security policy */
  blocked?: boolean;
  /** Reason for blocking (if blocked) */
  blockedReason?: string;
  /** Whether this tool is disabled by the user (distinct from security-blocked) */
  userDisabled?: boolean;
  /** Whether this tool is disabled by the organization's administrator */
  adminDisabled?: boolean;
  /** Server-declared: tool does not modify external state */
  readOnlyHint?: boolean;
  /** Server-declared: tool may permanently destroy data */
  destructiveHint?: boolean;
  /** Server-declared: repeated calls with same args are safe */
  idempotentHint?: boolean;
}

// Connector Catalog Types
export type ConnectorProvider = 'direct' | 'community' | 'bundled' | 'rebel-oss';

/** Returns true for providers that use bundled-style config (bundledConfig, setupToolName, etc.) */
export const isBundledLikeProvider = (provider: ConnectorProvider): boolean =>
  provider === 'bundled' || provider === 'rebel-oss';
export type ConnectorCategory =
  | 'communication'
  | 'productivity'
  | 'development'
  | 'sales'
  | 'analytics'
  | 'storage'
  | 'payments'
  | 'design'
  | 'media'
  | 'research';

/** Extensible list of known MCP capabilities declared in the connector catalog. */
export type McpCapabilityId = 'web-search';

/** Capability metadata used for tool suppression and prompt guidance. */
export interface McpCapability {
  id: McpCapabilityId;
  promptGuidance?: string;
}

export interface ConnectorMcpConfig {
  transport: McpTransport;
  type?: 'http' | 'sse';
  url?: string;
  command?: string;
  args?: string[];
  /** Static environment variables to inject. Values may contain {{MCP_CONFIG_DIR}} and {{MCP_BASE_DIR}} placeholders. */
  env?: Record<string, string>;
  oauth?: boolean;
  /** Extra OAuth authorization URL params (e.g., { prompt: 'consent' } for workspace selection) */
  oauthParams?: Record<string, string>;
  /** Pre-registered OAuth client ID (for servers that don't support DCR, e.g. Asana V2) */
  oauthClientId?: string;
  /** Pre-registered OAuth client secret */
  oauthClientSecret?: string;
}

/**
 * Configuration for bundled MCP servers that ship with the app.
 * These run locally and may require OAuth or API key setup.
 */
export interface BundledMcpConfig {
  /** How this bundled server authenticates */
  authType: 'oauth' | 'api-key' | 'oauth-user-provided' | 'none';
  /** Settings key to check if enabled (e.g., 'googleWorkspace.enabled') */
  settingsKey?: string;
  /** MCP server name as registered in bundledMcpManager */
  serverName: string;
  /** Environment variable for API key auth (e.g., 'GAMMA_API_KEY') */
  envKey?: string;
  /**
   * The MCP tool name to call for setup/authentication.
   * For OAuth: e.g., 'authenticate_workspace_account', 'authenticate_slack_workspace'
   * For API-key: e.g., 'configure_fathom_api_key', 'configure_gamma_api_key'
   * Used by "Set up with Rebel" to generate connector-specific prompts.
   */
  setupToolName?: string;
  /**
   * The window API to use for OAuth authentication.
   * For bundled stdio OAuth MCPs that have dedicated auth services.
   * E.g., 'googleWorkspaceApi', 'slackApi', 'hubspotApi', 'microsoftApi'
   * The API must have a startAuth() method that returns { success: boolean; error?: string }
   */
  authApi?: 'googleWorkspaceApi' | 'slackApi' | 'hubspotApi' | 'microsoftApi' | 'discourseApi';
  /**
   * Map of env var name → provider key ID.
   * When set, the system uses the shared provider key instead of requiring a per-connector key.
   * E.g., { "GEMINI_API_KEY": "google" } means this connector can use the shared Google API key.
   */
  providerKeyMapping?: Partial<Record<string, import('./settings').ProviderKeyId>>;
  /**
   * Environment variable to receive the connector's account-identity email
   * (the value supplied via the UI's Account Email input, not a setupField).
   * Used by connectors like Email IMAP where the email is part of auth
   * (e.g., "EMAIL_IMAP_EMAIL") but is captured through the shared email input
   * rather than a per-connector setupField.
   */
  accountIdentityEnvVar?: string;
}

/**
 * Defines a user input field for connectors requiring manual setup (Pattern 4b).
 * Used when connector needs user-specific values like URLs, API keys, or tokens.
 */
export interface SetupField {
  /** Unique field identifier (e.g., 'url', 'apiKey', 'instanceUrl') */
  id: string;
  /** Display label for the input */
  label: string;
  /**
   * Input type:
   * - 'url' validates URL format
   * - 'password' masks input
   * - 'text' is plain
   * - 'select' renders dropdown
   * - 'boolean' renders an inline toggle (stored as the string 'true' or 'false')
   */
  type: 'url' | 'text' | 'password' | 'select' | 'boolean';
  /** Whether the field is required (default: true) */
  required?: boolean;
  /** Placeholder text for the input */
  placeholder?: string;
  /**
   * Default value for the field. Always a string at runtime — boolean fields use
   * the literal string 'true' or 'false' to keep the storage shape uniform
   * (Record<string, string>).
   */
  default?: string;
  /** Optional help text shown beneath the field (boolean toggles in particular benefit from a one-liner explainer). */
  helpText?: string;
  /** Options for select fields */
  options?: { value: string; label: string }[];
  /** If set, the value is injected into mcpConfig.env[envVar] instead of the URL */
  envVar?: string;
  /** If set, the value is saved to app settings at this key path (e.g., 'salesforce.clientId') */
  settingsKey?: string;
  /** If set, the value is injected into mcpConfig.headers[headerKey] */
  headerKey?: string;
  /** Prefix to prepend to the value when setting the header (e.g., 'Bearer ') */
  headerPrefix?: string;
  /**
   * If set (only valid with type='select'), the selected option's value is used
   * to look up a URL that overrides mcpConfig.url at connection time.
   * Keys must match `options[].value`. Used for region toggles where the same
   * vendor exposes distinct HTTP endpoints per region (e.g., US vs EU).
   */
  urlOverrides?: Record<string, string>;
  /**
   * If set (only valid with type='select'), the selected option's value overrides
   * the catalog-level `setupUrl` for the "Open …" button. Keys must match
   * `options[].value`. Used when the setup dashboard URL differs per region.
   */
  setupUrlOverrides?: Record<string, string>;
}

/** Declaration of a URL pattern that a connector can handle for document prefetching. */
export interface UrlPatternDeclaration {
  /** Regex pattern matching URLs this connector handles. Use named capture groups for ID extraction. */
  pattern: string;
  /** Which tool to call to fetch the document content. Must be a read-only tool. */
  tool: string;
  /** How to extract args from the URL for the tool call. */
  extractArgs?: {
    /** Named capture group in the pattern to extract (default: "id") */
    group?: string;
    /** Parameter name to pass to the tool (must match the tool's inputSchema) */
    param: string;
  };
  /** Human-readable label for this pattern (e.g., "Google Docs") */
  label?: string;
}

/**
 * Base fields common to all connector catalog entries.
 * Extended by provider-specific types to form a discriminated union.
 */
interface BaseConnectorEntry {
  id: string;
  name: string;
  description: string;
  category: ConnectorCategory;
  icon: string;
  /** Capabilities this connector provides (used for tool suppression + prompt guidance). */
  capabilities?: McpCapability[];
  /**
   * Tool manifests provided by this connector. Each entry includes the tool name (identifier),
   * optional description, and optional MCP `annotations` (a free-form per-tool metadata bag
   * defined by the MCP spec — e.g., `audience`, `dangerLevel`, etc.).
   */
  tools?: Array<{ name: string; description?: string; annotations?: Record<string, unknown> }>;
  /** URL patterns this connector can handle for pre-turn document prefetching. */
  urlPatterns?: UrlPatternDeclaration[];
  popular?: boolean;
  requiresEnv?: string[];
  verified?: boolean;
  verifiedSource?: string;
  /**
   * Contributors who built this connector.
   * `contributors[0]` is the primary/original author.
   * Additional entries represent extenders or co-authors.
   */
  contributors?: Array<{ name: string; github: string }>;
  /**
   * OS platforms this connector supports. Maps to Node's `process.platform`
   * values ("darwin" / "win32" / "linux").
   *
   * - Omit or leave empty for cross-platform connectors (the common case).
   * - Set to a subset (e.g. `['darwin']`) for connectors that depend on a
   *   platform-specific CLI or runtime — Apple Shortcuts uses the macOS
   *   `shortcuts` CLI, so it is `darwin`-only.
   *
   * Filtering semantics:
   * - The "Available" connectors list hides entries whose platforms array is
   *   set and does not include the current host platform.
   * - Already-connected connections are never filtered out — if a user has a
   *   stale connection from another machine, we surface it with a platform
   *   badge so they can disconnect it.
   */
  platforms?: Array<'darwin' | 'win32' | 'linux'>;
  /** Whether this connector requires a companion desktop app running locally (e.g. Beeper, Figma, Quill). */
  requiresDesktopApp?: boolean;
  /**
   * Whether this connector's tools accept local filesystem paths and therefore
   * require a host-supplied, user-trusted sandbox root at spawn time (the
   * RUNWAY_ALLOWED_ROOT / RUNWAY_DOWNLOAD_ROOT family). When true, the catalog
   * entry must declare those env keys with their exact sandbox-ancestor
   * placeholders — enforced by validateLocalFileSandboxRequirements
   * (scripts/lib/validateCatalogImport.ts). See postmortem
   * 260531_resolve_runway_sandbox_to_user_trusted_80c7e79.
   */
  requiresLocalFileSandbox?: boolean;
  /** Whether this connector requires manual setup steps before it can be used. */
  requiresSetup?: boolean;
  /** URL to setup instructions or plugin install page. */
  setupUrl?: string;
  /**
   * How the setupUrl should be presented in the UI.
   * - 'button': Show an "Open [Name]" button (for API-key MCPs where user fetches credentials from external site)
   * - 'auto-open': URL opens automatically as part of OAuth flow (default for OAuth MCPs)
   * - 'reference': URL is just referenced in setupInstructions, no special UI (default for others)
   */
  setupUrlBehavior?: 'button' | 'auto-open' | 'reference';
  /** Custom label for the setupUrl button. Defaults to "Open {connectorName}" if not set. */
  setupUrlButtonLabel?: string;
  /** Notice shown above setup instructions (e.g., prerequisites, admin access required). */
  setupNotice?: string;
  /** Step-by-step setup instructions (newline-separated). */
  setupInstructions?: string;
  /**
   * Custom input fields for manual setup. If defined, renders these fields.
   * If undefined but requiresSetup && !mcpConfig, defaults to single URL input (backward compat).
   */
  setupFields?: SetupField[];
  /**
   * Runtime environment required for stdio MCPs.
   * - undefined: No local runtime needed (HTTP/SSE connectors, or Node.js/npx which is bundled)
   * - 'node': Requires Node.js/npx (informational, since Node is bundled with the app)
   * - 'python': Requires Python/uvx (user needs Python installed locally)
   */
  runtime?: 'node' | 'python';
  /**
   * Account identity type for this connector.
   * - 'email': Uses email address for account identity (Fathom, Google, HubSpot)
   * - 'workspace': Uses workspace/team name (Slack)
   * - 'subdomain': Uses tenant subdomain (Zendesk: <subdomain>.zendesk.com)
   * - 'domain': Uses tenant domain (Freshdesk: <domain>.freshdesk.com)
   * - 'tenant': Uses tenant ID (Workday)
   * - 'none': No account identity needed (RebelInbox, OpenAI Image)
   * - undefined: Legacy/not yet set (treat as 'email' for bundled MCPs)
   *
   * NOTE: Allowed enum values are defined by the connector catalog schema
   * (`src/shared/connectorCatalogSchema.ts`, `CatalogSchema` accountIdentity enum).
   * `src/shared/identityKinds.ts` is the canonical display/behavior semantics layer for those
   * values (`getIdentityFieldDisplay()` / `getIdentityParamName()`). Consumers MUST route through
   * those helpers rather than hand-coding switch statements on this field.
   */
  accountIdentity?: IdentityKind;
  /**
   * Authentication method for OAuth-based connectors.
   * - 'dcr': Super-MCP OAuth with Dynamic Client Registration (default)
   * - 'rebel-oauth': Rebel-side OAuth that writes token files for Super-MCP
   */
  authMethod?: 'dcr' | 'rebel-oauth';
  /**
   * Internal MCPs that are auto-configured and always-on (RebelInbox, RebelSearch, etc.).
   * These cannot be disconnected by the user - they're re-added on every app startup.
   * UI should hide disconnect button and show minimal actions.
   */
  isInternal?: boolean;
  /**
   * Maturity level of the connector.
   * - 'stable': Battle-tested, reliable for production use
   * - 'beta': Newer or less-tested, may have rough edges
   * - 'deprecated': End-of-life; surfaced for existing connections only
   * - undefined: Treated as 'beta' (conservative default for new MCPs)
   */
  maturity?: 'beta' | 'stable' | 'deprecated' | 'preview';
  /**
   * Hidden connectors are not shown in the "Available" connectors list.
   * Use this to temporarily disable a connector without removing its catalog entry.
   * Existing connections with this catalogId will still work and show in "Connected".
   */
  hidden?: boolean;
  /**
   * Developer-preview connectors are visible in the catalog but require
   * extra install ceremony (e.g. sideloading a browser extension before
   * the Chrome Web Store listing is live). Rendered with a "Developer
   * preview" pill + a callout on the expanded card so non-technical users
   * know what they're agreeing to before they click Install.
   *
   * Independent of `maturity: 'beta'` — `preview` is specifically about
   * installation friction (platform store submission in flight), not
   * feature maturity.
   *
   * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 10-preview)
   */
  preview?: boolean;
  /** OAuth callback URL for connectors that require browser-based auth flow */
  callbackUrl?: string;
}

/** Direct MCP connector (hosted HTTP/SSE endpoints). Requires mcpConfig. */
export interface DirectConnectorEntry extends BaseConnectorEntry {
  provider: 'direct';
  mcpConfig: ConnectorMcpConfig;
  bundledConfig?: never;
}

/**
 * Community MCP connector (npm/stdio packages).
 * mcpConfig is optional - some connectors require user-provided URL at runtime
 * (e.g., Framer where user pastes their plugin URL).
 */
export interface CommunityConnectorEntry extends BaseConnectorEntry {
  provider: 'community';
  mcpConfig?: ConnectorMcpConfig;
  bundledConfig?: never;
}

/** Bundled MCP connector (ships with app). Requires bundledConfig. */
export interface BundledConnectorEntry extends BaseConnectorEntry {
  provider: 'bundled';
  bundledConfig: BundledMcpConfig;
  mcpConfig?: never;
}

/** Rebel-maintained open-source MCP connector (externally built, uses bundled-style config). */
export interface RebelOssConnectorEntry extends BaseConnectorEntry {
  provider: 'rebel-oss';
  bundledConfig?: BundledMcpConfig;
  mcpConfig?: ConnectorMcpConfig;
}

/**
 * Discriminated union for connector catalog entries.
 * TypeScript narrows based on `provider`:
 * - 'direct' → mcpConfig is required
 * - 'community' → mcpConfig is optional (some require user-provided URL)
 * - 'bundled' → bundledConfig is required
 * - 'rebel-oss' → both bundledConfig and mcpConfig are optional (externally built, may use mcpConfig-only for npx-based connectors)
 */
export type ConnectorCatalogEntry =
  | DirectConnectorEntry
  | CommunityConnectorEntry
  | BundledConnectorEntry
  | RebelOssConnectorEntry;

export interface ConnectorCatalog {
  version: number;
  connectors: ConnectorCatalogEntry[];
}
