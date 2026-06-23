import { z } from 'zod';

/**
 * Zod schemas for the connector catalog (resources/connector-catalog.json) and any
 * runtime override catalog passed via REBEL_CATALOG_OVERRIDE.
 *
 * Extracted from src/main/services/connectorCatalogResolver.ts so that non-Electron
 * tooling (notably scripts/dev-mcp-managed-install.ts) can validate override shape
 * without pulling in the Electron `app` module.
 *
 * Behaviour-preserving extraction: imports here must remain Electron-free.
 */

/**
 * Whitelist of OSS-published `@mindstone/mcp-server-*` (and engineering-org
 * equivalents) packages that the resolver's `validateCommandArgs` accepts in
 * an override's `mcpConfig.command='npx'` entries.
 *
 * Single source of truth for both:
 *  - `src/main/services/connectorCatalogResolver.ts` (rejects overrides at startup)
 *  - `scripts/dev-mcp-managed-install.ts` (filters the bundled catalog before
 *    writing an auto-generated override, so unwhitelisted entries — Fathom,
 *    Gamma, browser-automation, etc. — don't cause silent override rejection).
 *
 * Adding a connector here requires reviewer attention: it widens the surface
 * an override can target. See § Whitelist drift in MCP_DEV_LOCAL_OVERRIDE.md.
 */
export const ALLOWED_NPX_PACKAGE_RE =
  /^@(mindstone|mindstone-engineering)\/mcp-server-(slack|hubspot|google-drive|google-workspace|replit-ssh|microsoft-365|microsoft-mail|microsoft-calendar|microsoft-files|microsoft-teams|microsoft-sharepoint|imagegen|canary|salesforce|xero)@\d+\.\d+\.\d+$/;

const McpConfigSchema = z.object({
  transport: z.enum(['stdio', 'http', 'sse']).optional(),
  type: z.enum(['http', 'sse']).optional(),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  oauth: z.boolean().optional(),
  oauthParams: z.record(z.string(), z.string()).optional(),
  oauthClientId: z.string().optional(),
  oauthClientSecret: z.string().optional(),
}).strict();

const BundledConfigSchema = z.object({
  authType: z.enum(['oauth', 'api-key', 'oauth-user-provided', 'none']),
  settingsKey: z.string().optional(),
  serverName: z.string(),
  envKey: z.string().optional(),
  setupToolName: z.string().optional(),
  authApi: z.enum([
    'googleWorkspaceApi',
    'slackApi',
    'hubspotApi',
    'microsoftApi',
    'discourseApi',
  ]).optional(),
  providerKeyMapping: z.record(z.string(), z.string()).optional(),
  accountIdentityEnvVar: z.string().optional(),
}).strict();

const SetupFieldSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  type: z.enum(['url', 'text', 'password', 'select', 'boolean']).optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  default: z.string().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() }).strict()).optional(),
  envVar: z.string().optional(),
  settingsKey: z.string().optional(),
  headerKey: z.string().optional(),
  headerPrefix: z.string().optional(),
  helpText: z.string().optional(),
  urlOverrides: z.record(z.string(), z.string()).optional(),
  setupUrlOverrides: z.record(z.string(), z.string()).optional(),
}).strict();

export const AccountIdentityEnum = z.enum([
  'email',
  'workspace',
  'subdomain',
  'domain',
  'tenant',
  'none',
]);

const ConnectorSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  icon: z.string(),
  provider: z.enum(['direct', 'community', 'bundled', 'rebel-oss']),
  capabilities: z.array(z.object({ id: z.string(), promptGuidance: z.string().optional() }).strict()).optional(),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    annotations: z.record(z.string(), z.unknown()).optional(),
  }).strict()).optional(),
  urlPatterns: z.array(z.object({
    pattern: z.string(),
    tool: z.string(),
    extractArgs: z.object({ group: z.string().optional(), param: z.string() }).strict().optional(),
    label: z.string().optional(),
  }).strict()).optional(),
  popular: z.boolean().optional(),
  requiresEnv: z.array(z.string()).optional(),
  verified: z.boolean().optional(),
  verifiedSource: z.string().optional(),
  contributors: z.array(z.object({ name: z.string(), github: z.string() }).strict()).optional(),
  platforms: z.array(z.enum(['darwin', 'win32', 'linux'])).optional(),
  requiresDesktopApp: z.boolean().optional(),
  /**
   * Whether this connector's tools accept local filesystem paths and therefore
   * require a host-supplied, user-trusted sandbox root at spawn time. When true,
   * `validateLocalFileSandboxRequirements` (scripts/lib/validateCatalogImport.ts)
   * asserts mcpConfig.env declares the local-file sandbox env keys with their
   * exact placeholder values. See postmortem 260531_resolve_runway_sandbox_*.
   */
  requiresLocalFileSandbox: z.boolean().optional(),
  requiresSetup: z.boolean().optional(),
  setupUrl: z.string().optional(),
  setupUrlBehavior: z.enum(['button', 'auto-open', 'reference']).optional(),
  setupUrlButtonLabel: z.string().optional(),
  setupNotice: z.string().optional(),
  setupInstructions: z.string().optional(),
  setupFields: z.array(SetupFieldSchema).optional(),
  runtime: z.enum(['node', 'python']).optional(),
  accountIdentity: AccountIdentityEnum.optional(),
  authMethod: z.enum(['dcr', 'rebel-oauth']).optional(),
  isInternal: z.boolean().optional(),
  maturity: z.enum(['beta', 'stable', 'deprecated', 'preview']).optional(),
  hidden: z.boolean().optional(),
  preview: z.boolean().optional(),
  callbackUrl: z.string().optional(),
  mcpConfig: McpConfigSchema.optional(),
  bundledConfig: BundledConfigSchema.optional(),
}).strict();

export const CatalogSchema = z.object({
  version: z.number(),
  connectors: z.array(ConnectorSchema),
}).strict();
