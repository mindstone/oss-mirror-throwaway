/**
 * Cloud Channel Policies — single source of truth for desktop→cloud IPC routing.
 *
 * Defines every IPC channel that can be routed to the cloud service along with
 * metadata about how it's handled. The three previously-separate allowlists
 * (CLOUD_ROUTABLE_CHANNELS, DUAL_WRITE_CHANNELS, CLOUD_IPC_ALLOWLIST) are now
 * derived from this one table. Channels NOT in this table are local-only.
 *
 * The opposite direction (cloud → desktop push events) is governed by
 * CLOUD_PUSH_ALLOWLIST in cloudEventChannel.ts. Both must be maintained.
 *
 * NOTE: `sessions:save-sync` is intentionally NOT in this table. It uses
 * `ipcMain.on` (synchronous IPC) and is handled by a dedicated forwarder in
 * `cloudRouter.registerSaveSyncForwarder()`, which bypasses the standard
 * shouldRouteToCloud/forward routing entirely.
 *
 * @see docs/project/CLOUD_ARCHITECTURE.md — cloud transport and deployment model
 * @see docs/project/CROSS_SURFACE_PARITY_CHECKLIST.md — parity expectations
 * @see cloud-service/AGENTS.md — how to add a cloud-routable channel
 */

/**
 * How a channel is handled on the cloud service:
 * - 'rest' : dedicated HTTP route handler in server.ts (not in generic IPC allowlist)
 * - 'ipc'  : generic /api/ipc/:channel endpoint
 * - 'ws'   : WebSocket (agent:turn only)
 */
type CloudTransport = 'rest' | 'ipc' | 'ws';

interface ChannelCloudPolicy {
  /** Client forwards to cloud when cloud mode is active */
  routable: true;
  /** Also runs locally (keeps local state in sync for fallback) */
  dualWrite?: true;
  /** How the cloud service handles this channel */
  transport: CloudTransport;
}

/**
 * Complete policy table for cloud-routable IPC channels.
 *
 * After the "execute where triggered" migration (Phase A + C), almost all
 * channels run locally on desktop. Only dual-write channels remain — they
 * run locally AND forward to cloud to keep cloud state fresh for mobile/web.
 *
 * Mobile/web bypass this table entirely (they call cloud-service endpoints
 * directly). Removing a channel here only affects desktop → cloud forwarding.
 *
 * Stage 2 (260428 SE sensor): contribution-observation writes (build/test/
 * ready/server/software_engineer_task_completed) are intentionally desktop-only.
 * The bridge and post-turn sweep that emit these observations do not exist on
 * cloud/mobile yet, so there is no routable `contribution:observe` channel in
 * this table. When cloud/mobile gain contribution build flow, revisit this
 * decision and add explicit channel policy entries rather than silently relying
 * on omission.
 *
 * Stage 3 (SE-evidence gate): `AppSettings.enforceSoftwareEngineerEvidence` is
 * also desktop-only for now. It rides the existing `settings:update` channel
 * on desktop, but is stripped before cloud forwarding via
 * `stripLocalSettings()` in `src/shared/cloudSettingsPolicy.ts`.
 *
 * MCP Apps iframe-host trust-boundary channels (`mcp:issue-nonce`,
 * `mcp:update-context`, `mcp:send-message`, nonce invalidation, and
 * grant-permission) are desktop-only in v1 per
 * `docs/project/MCP_APPS_BIDIRECTIONAL_TRUST_CONTRACT.md`: cloud/mobile do not
 * host live MCP App iframes, and no nonce/permission state syncs cross-device.
 *
 * Operator registry/activation channels (`operators:*`, including `operators:activate`,
 * `operators:remove`, `operators:setDisplayName`, `operators:duplicate`, and
 * `operators:startPersonalisation`) are intentionally desktop-only: they read local
 * Space files, and `rebel_operator__consult` fails closed off the desktop surface.
 *
 * Slack identity-resolution channels (`slack:resolve-user`, `slack:resolve-author-input`)
 * are intentionally desktop-only: workspace bot tokens live in the desktop keychain
 * and never travel to the cloud. Cloud-only / mobile-only users who need to manage
 * the Slack allowlist will follow up via a separate cloud-resolver flow once OAuth
 * tokens are persisted server-side. Until then, allowlist mutations from cloud/mobile
 * surfaces are not supported and the renderer surfaces this gracefully (no IPC bridge
 * available → "Use the canonical user ID" copy in the panel).
 */
export const CLOUD_CHANNEL_POLICIES = {
  // ---------------------------------------------------------------------------
  // Agent execution
  // ---------------------------------------------------------------------------
  // agent:turn and agent:stop-turn removed — desktop interactive turns now
  // execute locally (execute-where-triggered). Results sync to cloud via
  // the outbox/save-sync pipeline. Mobile/web execute on cloud directly.
  'agent:tool-safety-response': { routable: true, dualWrite: true, transport: 'ipc' },
  'error:apply-resolution': { routable: true, transport: 'ipc' },
  'memory:write-approval-response': { routable: true, dualWrite: true, transport: 'ipc' },

  // ---------------------------------------------------------------------------
  // Settings — dedicated REST route (dual-write keeps cloud settings in sync)
  // ---------------------------------------------------------------------------
  'settings:update': { routable: true, dualWrite: true, transport: 'rest' },

  // ---------------------------------------------------------------------------
  // Codex OAuth tokens — desktop pushes tokens to cloud so ChatGPT Pro works
  // on cloud / mobile. The interactive login flow stays desktop-only; this
  // channel carries the resulting tokens (and refresh updates) across.
  // Dual-write so the handler also runs locally (no-op on desktop since
  // tokens are already written, but keeps tests symmetrical).
  // ---------------------------------------------------------------------------
  'codex:sync-tokens': { routable: true, dualWrite: true, transport: 'rest' },

  // ---------------------------------------------------------------------------
  // Automations — dual-write so cloud scheduler gets definition updates
  // ---------------------------------------------------------------------------
  'automations:upsert': { routable: true, dualWrite: true, transport: 'ipc' },
  'automations:delete': { routable: true, dualWrite: true, transport: 'ipc' },

  // ---------------------------------------------------------------------------
  // Safety Prompt — dual-write keeps cloud Safety Prompt in sync
  // ---------------------------------------------------------------------------
  'safety-prompt:update': { routable: true, dualWrite: true, transport: 'ipc' },
  'safety-prompt:revert': { routable: true, dualWrite: true, transport: 'ipc' },
  'safety-prompt:reset': { routable: true, dualWrite: true, transport: 'ipc' },

  // ---------------------------------------------------------------------------
  // Inbox — desktop is source of truth. By-ID mutations are dual-write so
  // changes (archive, delete, quadrant, etc.) propagate to cloud for web/mobile.
  // Reads stay local on desktop (fast, offline-capable).
  //
  // inbox:add generates a deterministic UUID in the IPC handler and mutates
  // the payload before returning, so cloud receives the same ID via args
  // forwarding in ElectronHandlerRegistry.
  //
  // inbox:execute generates a deterministic sessionId in the IPC handler and
  // mutates the payload, same pattern as inbox:add. The handler calls store
  // functions directly (not through IPC), so the individual mutation
  // dual-writes (inbox:set-executing, etc.) don't fire — only inbox:execute
  // itself forwards atomically to cloud.
  // ---------------------------------------------------------------------------
  'inbox:add': { routable: true, dualWrite: true, transport: 'ipc' },
  'inbox:execute': { routable: true, dualWrite: true, transport: 'ipc' },
  'inbox:delete': { routable: true, dualWrite: true, transport: 'ipc' },
  'inbox:set-archived': { routable: true, dualWrite: true, transport: 'ipc' },
  'inbox:mark-archived': { routable: true, dualWrite: true, transport: 'ipc' },
  'inbox:set-quadrant': { routable: true, dualWrite: true, transport: 'ipc' },
  'inbox:set-dueBy': { routable: true, dualWrite: true, transport: 'ipc' },
  'inbox:set-status': { routable: true, dualWrite: true, transport: 'ipc' },
  'inbox:set-tags': { routable: true, dualWrite: true, transport: 'ipc' },
  'inbox:set-executing': { routable: true, dualWrite: true, transport: 'ipc' },
  'inbox:record-execution': { routable: true, dualWrite: true, transport: 'ipc' },

  // ---------------------------------------------------------------------------
  // Feedback
  // ---------------------------------------------------------------------------
  'feedback:conversation-get': { routable: true, transport: 'ipc' },
  'feedback:conversation-rate': { routable: true, transport: 'ipc' },
  'feedback:conversation-dismiss': { routable: true, transport: 'ipc' },

  // ---------------------------------------------------------------------------
  // Diagnostics (Stage 1c Wave 4 & Stage 2 Wave D)
  //
  // Read channel for the in-app Diagnostics surface. Routable WITHOUT dualWrite:
  // the read needs to honor where the user runs. Desktop call → desktop ledger;
  // mobile call → cloud ledger via the generic /api/ipc endpoint.
  //
  // NOTE: settings_drift_observation events (Wave D) are diagnostics-only ledger
  // entries. They do not have an IPC channel and are not gated on cloud-channel
  // routing, as both desktop and cloud independently observe and emit drift.
  //
  // Wave F diagnostic section toggles do not add a desktop→cloud IPC channel:
  // desktop bug reports stay local via `bug-report:submit-bug`, while mobile
  // passes the same shared SectionId map to cloud REST `/feedback` and
  // `/diagnostics/self`.
  // ---------------------------------------------------------------------------
  'diagnostics:get-recent-context': { routable: true, transport: 'ipc' },
} as const satisfies Record<string, ChannelCloudPolicy>;

// ---------------------------------------------------------------------------
// Derived sets — replace the 3 previously hand-maintained sets
// ---------------------------------------------------------------------------

/** All channels that can be routed to the cloud service. */
export const CLOUD_ROUTABLE_CHANNELS = new Set(Object.keys(CLOUD_CHANNEL_POLICIES));

/** Channels that run locally AND forward to cloud (keeps local state in sync). */
export const DUAL_WRITE_CHANNELS = new Set(
  Object.entries(CLOUD_CHANNEL_POLICIES)
    .filter(([, p]) => 'dualWrite' in p && p.dualWrite)
    .map(([ch]) => ch),
);

/**
 * Channels authorized for the generic /api/ipc/:channel endpoint on the cloud service.
 *
 * NOTE: sessions:export-logs, sessions:generate-summary, and sessions:get-diagnostic-summary
 * are server-only channels (used by cloud-side code directly, not client-routed).
 * They are NOT in this table — the server supplements this set with its own additions.
 */
export const CLOUD_IPC_ALLOWLIST = new Set(
  Object.entries(CLOUD_CHANNEL_POLICIES)
    .filter(([, p]) => p.transport === 'ipc')
    .map(([ch]) => ch),
);
