/**
 * App Bridge IPC channels (Stage 6a + Stage 7).
 *
 * Exposes the settings-UI surface for the Rebel browser extension pairing
 * workflow. Handlers live in `src/main/ipc/appBridgeHandlers.ts` and delegate
 * to the running bridge over its router-internal HTTP endpoints.
 *
 * Invoke channels (Stage 6a):
 *   - `app-bridge:pair-start`  — mint a short-lived pair code
 *   - `app-bridge:list-paired` — return currently paired clients
 *   - `app-bridge:revoke`      — revoke a paired client (or all of them)
 *
 * Broadcast channels (Stage 7 — not defined as invoke schemas because
 * `BroadcastService.sendToAllWindows()` is loosely typed):
 *   - `intent:external-context-arrived` — new conversation created by the
 *     browser extension; payload carries sessionId + tabContext so the
 *     renderer can show the `BrowserContextChip` and optionally switch
 *     to the new session.
 *   - `intent:buffered-message` — a message from the extension that
 *     arrived during an active turn and is being held in the
 *     `pendingInputBuffer`. Renderer renders the `ExternalContextIndicator`
 *     "held for you" state.
 *   - `intent:buffer-drained` — one (or more) buffered messages were
 *     submitted after the active turn finished. Renderer clears the
 *     "held for you" state.
 *
 * The payload Zod schemas live alongside for runtime narrowing in the
 * renderer (we don't use the schemas to register channel types — broadcast
 * channels are not part of the invoke contract map — but exporting them
 * keeps one source of truth for shape & validation).
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import { z } from 'zod';
import { defineInvokeChannel } from '../schemas/common';
import { ExternalContext } from '@rebel/shared';

const PairStartRequestSchema = z.object({
  /**
   * App identifier the code is scoped to. Stage 6a only advertises
   * `'browser-extension'` but the bridge accepts any non-empty string so
   * Office / future surfaces can reuse this channel.
   */
  appId: z.string().min(1).default('browser-extension'),
});

export const LEGACY_SETTINGS_SESSION_ID = '__legacy_settings_ui__' as const;

export const BrowserIdSchema = z.enum([
  'chrome',
  'edge',
  'brave',
  'arc',
  'vivaldi',
  'opera',
  'comet',
  'dia',
  'thorium',
  'yandex',
  'opera-gx',
  'sidekick',
  'none-of-the-above',
]);
export type BrowserId = z.infer<typeof BrowserIdSchema>;

export const DetectedBrowserSchema = z.object({
  id: BrowserIdSchema,
  displayName: z.string(),
  installPath: z.string(),
  binaryPath: z.string().optional(),
  extensionsPageUrl: z.string().optional(),
});
export type DetectedBrowser = z.infer<typeof DetectedBrowserSchema>;

const PairStartResponseSchema = z.object({
  code: z.string().min(4),
  /** Seconds until the code expires. Server-authoritative — do not guess. */
  expiresInSeconds: z.number().int().positive(),
  /** Absolute ms-epoch expiry, handy for UI countdowns. */
  expiresAt: z.number().int().positive(),
  pairSessionId: z.string().min(1),
  /** Echoed appId so the caller can confirm scope. */
  appId: z.string().min(1),
});

const PairedClientSchema = z.object({
  clientId: z.string().min(1),
  appId: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative().optional(),
  /** Display label (e.g. the browser user agent, if we captured one). */
  label: z.string().optional(),
});

const ListPairedResponseSchema = z.object({
  clients: z.array(PairedClientSchema),
});

const CheckExtensionVersionRequestSchema = z.object({});
const CheckExtensionVersionResponseSchema = z.object({
  currentVersion: z.string().nullable(),
  latestVersion: z.string(),
});

const RevokeRequestSchema = z.object({
  /** When omitted, revokes every paired client. */
  clientId: z.string().min(1).optional(),
});

const RevokeResponseSchema = z.object({
  revoked: z.number().int().nonnegative(),
});

/**
 * Stage 9 — `app-bridge:restart-dynamic-port`.
 *
 * UI CTA for the "Port conflict" state. Stops the bridge and restarts
 * the manager so `createAppBridge()` walks its fallback list again. The
 * new port + state file are written to disk; the extension's discovery
 * helper picks them up on its next poll.
 *
 * Existing paired tokens survive the restart (they live in `tokenStore`,
 * which is re-hydrated from disk by the bridge factory), so the user
 * doesn't have to re-pair.
 */
const RestartDynamicPortRequestSchema = z.object({});

const RestartDynamicPortResponseSchema = z.object({
  /** Whether the manager actually restarted. `false` when the bridge was never running (kill switch, non-desktop surface). */
  restarted: z.boolean(),
  /** New bound port on success. `null` when `restarted: false` or the factory could not bind any port. */
  port: z.number().int().positive().nullable(),
  /** Diagnostic reason when `restarted` is false. */
  skipReason: z
    .union([
      z.literal('not-running'),
      z.literal('kill-switch'),
      z.literal('surface-not-desktop'),
    ])
    .nullable(),
});

const CheckPairStatusRequestSchema = z.object({
  pairSessionId: z.string().min(1).optional(),
});
const CheckPairStatusResponseSchema = z.object({
  paired: z.array(z.object({ appId: z.string(), clientId: z.string() })),
  hasPending: z.boolean(),
  activeSessionCount: z.number().int().nonnegative().optional(),
  pairSessionExpired: z.boolean().optional(),
  /**
   * True when the bridge has no record of this pairSessionId at all — neither
   * active nor recently-ended. Distinct from `pairSessionExpired`. Agents
   * should treat this as a hard error (the ID was fabricated or copied
   * wrong), not a retry.
   */
  pairSessionNotFound: z.boolean().optional(),
  degraded: z.literal('trust-persist-failed').optional(),
});

const ListPendingApprovalsRequestSchema = z.object({});
const ListPendingApprovalsResponseSchema = z.object({
  pending: z.array(
    z.object({
      pendingApprovalId: z.string(),
      fingerprint: z.string().min(1),
      extensionId: z.string(),
      inferredBrowserId: z.string().optional(),
      createdAt: z.number(),
      expiresAt: z.number(),
    })
  ),
});

const ResolvePendingApprovalRequestSchema = z.object({
  pendingApprovalId: z.string().min(1),
  approved: z.boolean(),
  fingerprint: z.string().min(1),
  pairSessionId: z.string().min(1),
});
const ResolvePendingApprovalResponseSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.union([
      z.literal('already-resolved'),
      z.literal('not-found'),
      z.literal('expired'),
      z.literal('fingerprint-mismatch'),
      z.literal('session-mismatch'),
      z.literal('session-expired'),
      z.literal('session-unbound'),
    ]),
  }),
]);

const EndPairSessionRequestSchema = z.object({
  pairSessionId: z.string().min(1),
});
const createHostToolResultSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    ok: z.boolean(),
    reason: z.string(),
    retryable: z.boolean(),
    userMessage: z.string().optional(),
    instructions: z.string().optional(),
    data: dataSchema.optional(),
  });

const EndPairSessionResponseSchema = createHostToolResultSchema(z.object({}));
const ResetInstallDataSchema = z.object({
  revoked: z.number().int().nonnegative(),
  idsRemoved: z.number().int().nonnegative(),
  folderRemoved: z.boolean().optional(),
  degraded: z.boolean().optional(),
});
const ResetInstallRequestSchema = z.object({
  pairSessionId: z.string().min(1),
  full: z.boolean().optional(),
});
const ResetInstallResponseSchema = createHostToolResultSchema(ResetInstallDataSchema);

const NmhManifestResultSchema = z.object({
  browserId: BrowserIdSchema,
  ok: z.boolean(),
  reason: z.string().optional(),
});
const RegisterNmhManifestRequestSchema = z.object({});
const RegisterNmhManifestResponseSchema = z.array(NmhManifestResultSchema);
const UnregisterNmhManifestRequestSchema = z.object({
  browserIds: z.array(BrowserIdSchema),
});
const UnregisterNmhManifestResponseSchema = z.array(NmhManifestResultSchema);

export const appBridgeChannels = {
  'app-bridge:pair-start': defineInvokeChannel({
    channel: 'app-bridge:pair-start',
    request: PairStartRequestSchema,
    response: PairStartResponseSchema,
    description:
      'Mint a short-lived pair code that the extension can claim for a bearer token.',
  }),
  'app-bridge:list-paired': defineInvokeChannel({
    channel: 'app-bridge:list-paired',
    request: z.object({}),
    response: ListPairedResponseSchema,
    description: 'List currently paired app-bridge clients.',
  }),
  'app-bridge:check-extension-version': defineInvokeChannel({
    channel: 'app-bridge:check-extension-version',
    request: CheckExtensionVersionRequestSchema,
    response: CheckExtensionVersionResponseSchema,
    description:
      'Return the latest bundled Rebel Browser version and the currently connected extension version when available.',
  }),
  'app-bridge:revoke': defineInvokeChannel({
    channel: 'app-bridge:revoke',
    request: RevokeRequestSchema,
    response: RevokeResponseSchema,
    description:
      'Revoke a paired client (or all, if no clientId is provided).',
  }),
  'app-bridge:restart-dynamic-port': defineInvokeChannel({
    channel: 'app-bridge:restart-dynamic-port',
    request: RestartDynamicPortRequestSchema,
    response: RestartDynamicPortResponseSchema,
    description:
      'Stop and restart the bridge so it rebinds to the first available fallback port. Used by the "Let Rebel pick another port" CTA.',
  }),
  'app-bridge:detect-browsers': defineInvokeChannel({
    channel: 'app-bridge:detect-browsers',
    request: z.object({}),
    response: z.object({ browsers: z.array(DetectedBrowserSchema) }),
    description: 'Detect installed browsers that can host Rebel Browser.',
  }),
  'app-bridge:extract-extension': defineInvokeChannel({
    channel: 'app-bridge:extract-extension',
    request: z.object({ browserId: BrowserIdSchema }),
    response: z.object({
      ok: z.boolean(),
      targetDir: z.string().optional(),
      action: z.enum(['written', 'skipped']).optional(),
      pairSessionId: z.string().min(1).optional(),
      reason: z.string().optional(),
    }),
    description: 'Extract the browser extension folder for a specific browser.',
  }),
  'app-bridge:reveal-extension-folder': defineInvokeChannel({
    channel: 'app-bridge:reveal-extension-folder',
    request: z.object({ browserId: BrowserIdSchema }),
    response: z.object({ ok: z.boolean() }),
    description: 'Reveal the extension folder in the OS file explorer.',
  }),
  'app-bridge:open-browser-extensions-page': defineInvokeChannel({
    channel: 'app-bridge:open-browser-extensions-page',
    request: z.object({ browserId: BrowserIdSchema }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string().optional(),
      fallbackUrl: z.string().optional(),
    }),
    description: 'Open the extensions page in the user\'s default browser (or specific one if possible).',
  }),
  'app-bridge:check-pair-status': defineInvokeChannel({
    channel: 'app-bridge:check-pair-status',
    request: CheckPairStatusRequestSchema,
    response: CheckPairStatusResponseSchema,
    description: 'Check if there are any paired clients or pending approvals.',
  }),
  'app-bridge:list-pending-approvals': defineInvokeChannel({
    channel: 'app-bridge:list-pending-approvals',
    request: ListPendingApprovalsRequestSchema,
    response: ListPendingApprovalsResponseSchema,
    description: 'List all pending TOFU approvals.',
  }),
  'app-bridge:resolve-pending-approval': defineInvokeChannel({
    channel: 'app-bridge:resolve-pending-approval',
    request: ResolvePendingApprovalRequestSchema,
    response: ResolvePendingApprovalResponseSchema,
    description: 'Approve or reject a pending TOFU approval.',
  }),
  'app-bridge:end-pair-session': defineInvokeChannel({
    channel: 'app-bridge:end-pair-session',
    request: EndPairSessionRequestSchema,
    response: EndPairSessionResponseSchema,
    description: 'End a pending pair session without revoking paired app tokens.',
  }),
  'app-bridge:reset-install': defineInvokeChannel({
    channel: 'app-bridge:reset-install',
    request: ResetInstallRequestSchema,
    response: ResetInstallResponseSchema,
    description:
      'Reset an abandoned install session by revoking only its pair-scoped tokens and trusted dev extension ids.',
  }),
  'app-bridge:register-nmh': defineInvokeChannel({
    channel: 'app-bridge:register-nmh',
    request: RegisterNmhManifestRequestSchema,
    response: RegisterNmhManifestResponseSchema,
    description:
      'Write latent Native Messaging Host manifests for detected paired browsers. The relay binary is not bundled yet, so this is forward-compatibility groundwork only.',
  }),
  'app-bridge:unregister-nmh': defineInvokeChannel({
    channel: 'app-bridge:unregister-nmh',
    request: UnregisterNmhManifestRequestSchema,
    response: UnregisterNmhManifestResponseSchema,
    description:
      'Remove latent Native Messaging Host manifests for the specified browsers when Rebel owns the file.',
  }),
} as const;

// ---------------------------------------------------------------------------
// Stage 7 — broadcast payloads
// ---------------------------------------------------------------------------

/**
 * Page/tab context fields propagated from the extension popup into the
 * renderer. All optional — the popup can fire lightweight intents without
 * a text body, and a tab is only nominally required (the origin-guard
 * allowlist already gates who can reach the bridge).
 */
export const IntentTabContextSchema = z.object({
  tabId: z.number().int().nonnegative().optional(),
  windowId: z.number().int().nonnegative().optional(),
  url: z.string().max(2048).optional(),
  title: z.string().max(1024).optional(),
}).strict();
export type IntentTabContext = z.infer<typeof IntentTabContextSchema>;

export const IntentDocumentContextSchema = z.object({
  host: z.string().max(64).optional(),
  title: z.string().max(1024).optional(),
  url: z.string().max(2048).optional(),
}).strict();
export type IntentDocumentContext = z.infer<typeof IntentDocumentContextSchema>;

/**
 * `intent:external-context-arrived` payload — fired when the extension
 * successfully creates a new conversation via the bridge. Renderer
 * responds by calling `createBackgroundSession()` and, optionally,
 * switching to the session (when the intent asked for focus).
 *
 * `chat` is the embedded-chat side panel intent kind — the side panel
 * does NOT focus the desktop window when sending messages, so the
 * `focus` field is set to `false` for `chat` create flows.
 */
export const IntentExternalContextArrivedSchema = z.object({
  sessionId: z.string().min(1),
  appId: z.string().min(1),
  intent: z.enum(['summarise', 'ask', 'save_to_notes', 'chat']),
  /** Formatted initial user message that was submitted to spawn the turn. */
  initialText: z.string().min(1),
  tabContext: IntentTabContextSchema.optional(),
  documentContext: IntentDocumentContextSchema.optional(),
  externalContext: ExternalContext.optional(),
  /** When true, the renderer should focus the window + switch to the new session. */
  focus: z.boolean().default(true),
  /** ms-epoch when the intent landed in the handler, for ordering. */
  receivedAt: z.number().int().nonnegative(),
}).strict();
export type IntentExternalContextArrived = z.infer<typeof IntentExternalContextArrivedSchema>;

/**
 * `intent:buffered-message` payload — message held in the pending-input
 * buffer because a turn was active when it arrived. Delivered to the
 * renderer so `ExternalContextIndicator` can show a "held for you" chip.
 */
export const IntentBufferedMessageSchema = z.object({
  sessionId: z.string().min(1),
  appId: z.string().min(1),
  messageId: z.string().min(1),
  text: z.string().min(1),
  tabContext: IntentTabContextSchema.optional(),
  documentContext: IntentDocumentContextSchema.optional(),
  externalContext: ExternalContext.optional(),
  receivedAt: z.number().int().nonnegative(),
  /** Total queue depth after this entry was appended — lets the UI label "3 things queued". */
  queueSize: z.number().int().positive(),
}).strict();
export type IntentBufferedMessage = z.infer<typeof IntentBufferedMessageSchema>;

/**
 * `intent:buffer-drained` payload — fires once per drain. `flushedIds`
 * lists the message IDs the service submitted (in FIFO order) and
 * `remaining` is 0 unless a new intent landed between drain and
 * broadcast, in which case the renderer leaves the chip visible for
 * those still-held messages.
 */
export const IntentBufferDrainedSchema = z.object({
  sessionId: z.string().min(1),
  flushedIds: z.array(z.string().min(1)),
  remaining: z.number().int().nonnegative(),
  drainedAt: z.number().int().nonnegative(),
}).strict();
export type IntentBufferDrained = z.infer<typeof IntentBufferDrainedSchema>;

export const CONNECTOR_STATUS_CHANGED = 'connector:status-changed' as const;

/**
 * `connector:status-changed` payload — deterministic connector lifecycle
 * status translated from desktop-only app-bridge pair events.
 *
 * There is intentionally no `sessionId` field here: the renderer resolves
 * ownership by scanning persisted sessions for a matching
 * `setupContext.pairSessionId`. See
 * `docs/plans/260422_renderer_driven_connector_status.md`.
 *
 * `.strict()` is a security boundary: Stage 2 must strip `tokenFingerprint`
 * and any other `PairEvent`-only fields before broadcasting to the renderer.
 */
export const ConnectorStatusChangedPayloadSchema = z.object({
  // Keep this as a literal today; widen to a discriminated union when a
  // second connector lands (see Forward Work in the planning doc).
  connectorId: z.literal('bundled-app-bridge'),
  // Internal `session-ended` never crosses this boundary; the translator maps
  // it to `cancelled`, `expired`, or suppresses it entirely.
  status: z.enum(['connected', 'expired', 'cancelled']),
  pairSessionId: z.string().min(1),
  emittedAt: z.number().int().nonnegative(),
  // `${pairSessionId}:${emittedAt}:${status}` today; format is a renderer dedup
  // hint, not part of the wire contract.
  eventId: z.string().min(1),
}).strict();
export type ConnectorStatusChangedPayload = z.infer<typeof ConnectorStatusChangedPayloadSchema>;

/**
 * Broadcast channel names — kept as a typed map so main-process callers
 * and renderer subscribers can share a single constant.
 */
export const APP_BRIDGE_BROADCAST_CHANNELS = {
  CONNECTOR_STATUS_CHANGED,
  EXTERNAL_CONTEXT_ARRIVED: 'intent:external-context-arrived',
  BUFFERED_MESSAGE: 'intent:buffered-message',
  BUFFER_DRAINED: 'intent:buffer-drained',
  PENDING_APPROVAL_UPDATED: 'app-bridge:pending-approval-updated',
} as const;
export type AppBridgeBroadcastChannel =
  (typeof APP_BRIDGE_BROADCAST_CHANNELS)[keyof typeof APP_BRIDGE_BROADCAST_CHANNELS];
