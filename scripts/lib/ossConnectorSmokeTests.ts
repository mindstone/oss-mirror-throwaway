/**
 * OSS Connector Smoke-Test Registry
 *
 * Maps each rebel-oss connector ID to a single safe smoke probe — typically a
 * read-only list/get tool that exercises the real API without side effects.
 *
 * Used by `scripts/test-oss-connectors.ts`. Hand-curated; do NOT auto-discover
 * (risk of accidentally calling write tools).
 *
 * Modes:
 * - 'ok'             — assert the tool returned a non-error response.
 * - 'error-allowed'  — assert the server responded at all (didn't crash).
 *                      Used for OAuth connectors where the smoke tool may
 *                      return an auth-required error without test credentials,
 *                      and for tools that expect to fail with a bogus input
 *                      (e.g., napkin_check_status with a zero-UUID).
 *
 * Connectors without a known safe read-only probe are deliberately absent.
 * The runner reports them as smoke=none so we know to add a probe.
 */

export interface OssConnectorSmokeProbe {
  tool: string;
  args?: Record<string, unknown>;
  mode: 'ok' | 'error-allowed';
  /** Optional notes — why this tool, why this mode */
  note?: string;
}

export const OSS_CONNECTOR_SMOKE_PROBES: Record<string, OssConnectorSmokeProbe> = {
  // ─── API-key connectors with clean read-only list/get tools ───────────────
  'bundled-fathom': {
    tool: 'list_fathom_meetings',
    args: { limit: 1 },
    mode: 'ok',
  },
  'bundled-mixmax': {
    tool: 'get_mixmax_user',
    mode: 'ok',
  },
  'bundled-zendesk': {
    tool: 'list_zendesk_accounts',
    mode: 'ok',
    note: 'Lists locally-stored accounts — works even with no Zendesk credentials configured. Use list_zendesk_groups for a real API probe once credentials are wired.',
  },
  'bundled-freshdesk': {
    tool: 'list_freshdesk_accounts',
    mode: 'ok',
    note: 'Lists locally-stored accounts — works even with no Freshdesk credentials configured.',
  },
  'bundled-pandadoc': {
    tool: 'list_templates',
    mode: 'ok',
  },
  'bundled-gamma': {
    tool: 'gamma_list_themes',
    mode: 'ok',
  },
  'bundled-elevenlabs': {
    tool: 'list_voices',
    args: { page_size: 1 },
    mode: 'ok',
  },
  'bundled-napkin': {
    tool: 'napkin_check_status',
    args: { request_id: '00000000-0000-0000-0000-000000000000' },
    mode: 'error-allowed',
    note: 'Bogus UUID — server should reject with 404, proving it processed the request.',
  },
  'bundled-retell-ai': {
    tool: 'list_phone_numbers',
    mode: 'ok',
  },
  'bundled-runway': {
    tool: 'get_runway_balance',
    mode: 'ok',
  },
  'bundled-humaans': {
    tool: 'get_humaans_me',
    mode: 'ok',
  },
  'bundled-workday': {
    tool: 'list_workday_organizations',
    mode: 'ok',
  },
  'bundled-quickbooks': {
    tool: 'list_quickbooks_accounts',
    mode: 'ok',
  },
  'bundled-servicenow': {
    tool: 'list_servicenow_users',
    mode: 'ok',
  },
  'bundled-talentlms': {
    tool: 'get_talentlms_site_info',
    mode: 'ok',
  },
  'bundled-google-analytics': {
    tool: 'ga_list_account_summaries',
    mode: 'ok',
  },

  // ─── Local-SSH connectors (require user-supplied host + ~/.ssh key) ────────
  'bundled-replit-ssh': {
    tool: 'replit_check_connection',
    args: {
      host: process.env.OSS_TEST_BUNDLED_REPLIT_SSH__HOST ?? '',
      user: process.env.OSS_TEST_BUNDLED_REPLIT_SSH__USER ?? '',
    },
    mode: 'ok',
    note: 'Read-only health probe against a live *.replit.dev host. Requires OSS_TEST_BUNDLED_REPLIT_SSH__HOST + __USER set, and ~/.ssh/rebel-replit registered at replit.com/account#ssh-keys. Skipped when env is unset (probe will return CONFIG_MISSING and the smoke will fail — operator should --skip bundled-replit-ssh or set the env vars). Never call write tools from this registry — replit_setup_ssh mutates ~/.ssh/.',
  },

  // ─── OAuth connectors — list connected accounts (works without live creds) ──
  'bundled-hubspot': {
    tool: 'list_hubspot_accounts',
    mode: 'error-allowed',
    note: 'OAuth — returns empty list or auth-required without tokens. Proves server boots.',
  },
  'bundled-salesforce': {
    tool: 'salesforce_list_connected_accounts',
    mode: 'error-allowed',
    note: 'OAuth — returns empty list without tokens. Proves server boots.',
  },
  'bundled-outreach': {
    tool: 'outreach_list_connected_accounts',
    mode: 'error-allowed',
    note: 'OAuth — returns empty list without tokens. Proves server boots.',
  },
  'bundled-slack': {
    tool: 'list_slack_workspaces',
    mode: 'ok',
    note: 'OAuth — read-only; returns ok:true,connected:false,workspaces:[] without tokens. Proves server boots.',
  },
  'bundled-google': {
    tool: 'list_workspace_accounts',
    mode: 'error-allowed',
    note: 'OAuth — local account listing/auth-required path only. Proves the OSS Google Workspace server boots without making Google API calls.',
  },

  // ─── Host-context-required connectors — bootstrap status only ──────────────
  'bundled-office': {
    tool: 'rebel_office_status',
    mode: 'error-allowed',
    note: 'Requires running Office add-in; status call proves server boots and responds.',
  },
  'bundled-apple-shortcuts': {
    tool: 'apple_shortcuts_list',
    mode: 'error-allowed',
    note: 'macOS-only; on non-macOS hosts the tool errors but the server responds.',
  },

  // ─── Explicitly NO smoke probe (list-tools check only) ────────────────────
  // Reason: no known side-effect-free tool, or smoke would require setup we
  // don't want to automate. Leaving these absent is intentional — the runner
  // will report smoke=none so a human can decide later.
  //
  //   'bundled-icloud-mail'        — IMAP, requires live mailbox + password
  //   'bundled-yahoo-mail'         — IMAP, requires live mailbox + password
  //   'bundled-custom-email'       — IMAP, requires live mailbox + password
  //   'bundled-kling'              — only mutating/configure tools
  //   'bundled-nano-banana'        — only generate/edit tools (cost real $)
  //   'bundled-browser-automation' — needs browser context
};

/** Connector IDs that are intentionally absent from the registry. */
export const OSS_CONNECTORS_WITHOUT_SMOKE_PROBE: ReadonlySet<string> = new Set([
  'bundled-icloud-mail',
  'bundled-yahoo-mail',
  'bundled-custom-email',
  'bundled-kling',
  'bundled-nano-banana',
  'bundled-browser-automation',
]);
