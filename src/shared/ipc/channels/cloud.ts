import { z } from 'zod';
import { defineInvokeChannel, OAuthSetupGuidanceSchema } from '../schemas/common';

const ReconcilerWriterSchema = z.enum([
  'startup-health',
  'managed-status',
  'router-success',
  'repair',
  'manual-refresh',
  'auto-refresh',
  'post-drain',
  'reconnect',
  'focus',
  'hourly-tick',
]);

const CloudErrorCategorySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('network'),
    subkind: z.enum(['fetch_failed', 'dns', 'tcp', 'abort', 'timeout']),
  }),
  z.object({
    kind: z.literal('auth'),
    subkind: z.enum(['unauthorized', 'forbidden', 'token_expired']),
  }),
  z.object({
    kind: z.literal('cloud_down'),
    subkind: z.enum(['http_5xx', 'reported_unhealthy', 'deprovisioning']),
  }),
  z.object({
    kind: z.literal('unknown'),
    rawMessage: z.string(),
  }),
]);

const CloudConnectionOutcomeSchema = z.discriminatedUnion('result', [
  z.object({
    result: z.literal('success'),
    writer: ReconcilerWriterSchema,
    timestamp: z.number(),
    status: z.number().optional(),
  }),
  z.object({
    result: z.literal('failure'),
    writer: ReconcilerWriterSchema,
    timestamp: z.number(),
    category: CloudErrorCategorySchema,
    rawError: z.string(),
    legacyLastError: z.string().optional(),
    status: z.number().optional(),
  }),
]);

const VmTierIdSchema = z.enum(['standard', 'faster', 'heavy-work']);

const VmTierSchema = z.object({
  id: VmTierIdSchema,
  label: z.string(),
  description: z.string(),
  cpuKind: z.enum(['shared', 'performance']),
  cpus: z.number().int(),
  memoryMb: z.number().int(),
  estimatedMonthlyCostUsd: z.number(),
  isDefault: z.boolean().optional(),
  workingRoom: z.enum(['Standard', 'Double']).optional(),
  speedRank: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
});

const VolumeStatusOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    sizeGb: z.number(),
    totalBytes: z.number(),
    usedBytes: z.number(),
    availableBytes: z.number(),
    lastCheckedAt: z.number(),
  }),
  z.object({
    kind: z.literal('cloud_unreachable'),
    sizeGb: z.number().optional(),
    reason: z.enum(['endpoint_missing', 'network']).optional(),
    error: z.string(),
    lastCheckedAt: z.number(),
  }),
  z.object({
    kind: z.literal('fly_token_missing'),
  }),
  z.object({
    kind: z.literal('not_applicable'),
    reason: z.enum(['managed', 'non_fly', 'not_byok', 'not_connected']),
  }),
]);

export const DeprovisionResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('remote-removed'),
  }),
  z.object({
    kind: z.literal('local-only-remote-uncertain'),
    error: z.string(),
  }),
  z.object({
    kind: z.literal('remote-removed-local-clear-failed'),
    error: z.string(),
  }),
  z.object({
    kind: z.literal('remote-uncertain-local-clear-failed'),
    error: z.string(),
  }),
  z.object({
    kind: z.literal('precondition-failed'),
    error: z.string(),
  }),
]);

export type DeprovisionResult = z.infer<typeof DeprovisionResultSchema>;

export const cloudChannels = {
  'cloud:provision': defineInvokeChannel({
    channel: 'cloud:provision',
    request: z.object({
      flyApiToken: z.string().optional(),
      apiToken: z.string().optional(),
      region: z.string().optional(),
      providerId: z.enum(['fly', 'digitalocean', 'hetzner', 'mindstone']).optional(),
      /**
       * Desired volume size in GB for BYOK providers. When omitted, the
       * provider falls back to `DEFAULT_VOLUME_SIZE_GB` (15 GB). Ignored
       * on the managed (`mindstone`) path — managed sizing is decided
       * server-side.
       */
      volumeSizeGb: z.number().int().min(10).max(500).optional(),
      /** Desired Fly VM tier ID for BYOK provisioning. */
      vmTierId: z.string().optional(),
    }).refine((data) => data.flyApiToken || data.apiToken || data.providerId === 'digitalocean' || data.providerId === 'mindstone', {
      message: 'Either flyApiToken, apiToken, DigitalOcean OAuth, or Mindstone managed provisioning required',
    }),
    response: z.object({
      success: z.boolean(),
      cloudUrl: z.string().optional(),
      cloudToken: z.string().optional(),
      appName: z.string().optional(),
      machineId: z.string().optional(),
      volumeId: z.string().optional(),
      region: z.string().optional(),
      vmTierId: VmTierIdSchema.optional(),
      error: z.string().optional(),
      warning: z.string().optional(),
      failedStep: z.number().optional(),
      cleanedUp: z.boolean().optional(),
      cleanupMessage: z.string().optional(),
    }),
    description: 'Auto-provision a cloud instance using a provider API token',
  }),

  'cloud:change-vm-tier': defineInvokeChannel({
    channel: 'cloud:change-vm-tier',
    request: z.object({
      tierId: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      updated: z.boolean().optional(),
      /**
       * True if Fly accepted the guest config write, even when later steps
       * (start, health poll) failed. Lets the UI tell users "the cloud is
       * changing but we couldn't verify it" instead of pretending nothing
       * happened.
       */
      applied: z.boolean().optional(),
      healthVerified: z.boolean().optional(),
      startedMachine: z.boolean().optional(),
      machineStateBefore: z.string().optional(),
      /** False when settings persistence failed after a successful tier change. */
      settingsPersisted: z.boolean().optional(),
      error: z.string().optional(),
    }),
    description: 'Change Fly BYOK VM performance tier and verify cloud health before returning success',
  }),

  'cloud:get-vm-tier': defineInvokeChannel({
    channel: 'cloud:get-vm-tier',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      tier: VmTierSchema.optional(),
      raw: z.object({
        cpuKind: z.string(),
        cpus: z.number(),
        memoryMb: z.number(),
      }).optional(),
      error: z.string().optional(),
    }),
    description: 'Read current Fly BYOK VM guest config and map it to a catalog tier',
  }),

  'cloud:get-volume-status': defineInvokeChannel({
    channel: 'cloud:get-volume-status',
    request: z.void(),
    response: VolumeStatusOutcomeSchema,
    description: 'Read current Fly volume size + inside-VM disk usage. Discriminated outcome — never throws on missing token / unreachable cloud.',
  }),

  'cloud:resize-volume': defineInvokeChannel({
    channel: 'cloud:resize-volume',
    request: z.object({
      targetSizeGb: z.number().int().min(10).max(500),
    }),
    response: z.object({
      success: z.boolean(),
      applied: z.boolean().optional(),
      healthVerified: z.boolean().optional(),
      sizeVerified: z.boolean().optional(),
      sizeGbBefore: z.number().optional(),
      sizeGbAfter: z.number().optional(),
      settingsPersisted: z.boolean().optional(),
      error: z.string().optional(),
      helpKey: z.enum(['billing_required', 'capacity', 'in_flight_conflict']).optional(),
    }),
    description: 'Extend the Fly volume to the target size, restart the machine, and verify the guest sees the new size. Manual-only — no auto-expand.',
  }),

  'cloud:link-fly-token': defineInvokeChannel({
    channel: 'cloud:link-fly-token',
    request: z.object({
      flyApiToken: z.string(),
      appName: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      appName: z.string().optional(),
      machineId: z.string().optional(),
      volumeId: z.string().optional(),
      region: z.string().optional(),
      error: z.string().optional(),
      diagnostic: z.object({
        reachable: z.boolean().optional(),
        authenticated: z.boolean().optional(),
        hasPublicIp: z.boolean().optional(),
      }).optional(),
    }),
    description: 'Link a Fly API token to an already-connected cloud instance, populating BYOK metadata',
  }),

  'cloud:deprovision': defineInvokeChannel({
    channel: 'cloud:deprovision',
    /**
     * `managed:true` forces the managed (Mindstone Cloud) teardown path even
     * when local settings no longer carry `provisionMode:'managed'` — needed to
     * destroy an *orphaned* backend instance after a local "Forget" wiped the
     * config. Without it the handler would key off cleared settings and fall
     * through to the BYOK path. See the managed-orphan recovery flow (PM 260608).
     */
    request: z.object({ managed: z.boolean().optional() }).optional(),
    response: DeprovisionResultSchema,
    description: 'Destroy the provisioned cloud instance (managed or BYOK); always clears local config, even when the remote teardown fails',
  }),

  'cloud:reattach-managed': defineInvokeChannel({
    channel: 'cloud:reattach-managed',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      /**
       * True when a managed instance exists on the backend but its credentials
       * can't be recovered (no cloudToken returned by discovery), so re-attach
       * is impossible and the user must destroy + re-provision instead.
       */
      needsReprovision: z.boolean().optional(),
      /**
       * True when the re-attach was aborted because a concurrent teardown
       * (deprovision / "Forget") ran during discovery — the discovered instance
       * may have just been destroyed, so we declined to write stale creds.
       * Benign: the caller should treat this as "set up again", not an error.
       */
      superseded: z.boolean().optional(),
      error: z.string().optional(),
    }),
    description: 'Re-attach to an already-running managed (Mindstone Cloud) instance discovered on the backend, writing its credentials back into local settings (recovery after a local "Forget")',
  }),

  'cloud:has-fly-token': defineInvokeChannel({
    channel: 'cloud:has-fly-token',
    request: z.void(),
    response: z.object({
      hasToken: z.boolean(),
    }),
    description: 'Check if a Fly API token is stored (without exposing the token)',
  }),

  'cloud:do-start-oauth': defineInvokeChannel({
    channel: 'cloud:do-start-oauth',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
      setupGuidance: OAuthSetupGuidanceSchema.optional(),
    }),
    description: 'Start DigitalOcean OAuth flow (opens browser)',
  }),

  'cloud:do-oauth-status': defineInvokeChannel({
    channel: 'cloud:do-oauth-status',
    request: z.void(),
    response: z.object({
      connected: z.boolean(),
      accountEmail: z.string().optional(),
      expiresAt: z.number().optional(),
    }),
    description: 'Check DigitalOcean OAuth connection status',
  }),

  'cloud:do-disconnect-oauth': defineInvokeChannel({
    channel: 'cloud:do-disconnect-oauth',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Disconnect DigitalOcean OAuth (clear tokens)',
  }),

  'cloud:destroy': defineInvokeChannel({
    channel: 'cloud:destroy',
    request: z.object({ force: z.boolean().optional() }).optional(),
    response: z.object({
      success: z.boolean(),
      /** @deprecated Local forget is now network-free and never syncs, so this is never set. Retained for back-compat. */
      syncFailed: z.boolean().optional(),
      error: z.string().optional(),
    }),
    description: 'Forget the cloud connection on this device (network-free full local wipe; the remote cloud keeps running)',
  }),

  'cloud:status': defineInvokeChannel({
    channel: 'cloud:status',
    request: z.void(),
    response: z.object({
      status: z.enum(['running', 'warm', 'provisioning', 'offline', 'error', 'not_configured']),
      url: z.string().optional(),
      error: z.string().optional(),
      /** Cloud pressure observation. Absent on older clouds or non-running states. */
      pressure: z
        .object({
          state: z.enum(['ok', 'warning', 'critical', 'unknown']),
          oomRecent: z.boolean(),
          recentRestart: z.boolean(),
        })
        .optional(),
    }),
    description: 'Check cloud service health status',
  }),

  'cloud:reconcile': defineInvokeChannel({
    channel: 'cloud:reconcile',
    request: z.object({
      writer: ReconcilerWriterSchema,
      cloudUrl: z.string().optional(),
      mode: z.enum(['reconcile', 'reportSuccess']),
    }),
    response: z.object({
      ok: z.literal(true),
      outcome: CloudConnectionOutcomeSchema.optional(),
    }),
    description: 'Run or report a cloud connection reconciliation from renderer callers',
  }),

  'cloud:wake': defineInvokeChannel({
    channel: 'cloud:wake',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Wake a stopped Fly Machine by pinging its health endpoint',
  }),

  'cloud:migrate': defineInvokeChannel({
    channel: 'cloud:migrate',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      settingsMigrated: z.boolean().optional(),
      sessionsMigrated: z.number().optional(),
      errors: z.array(z.string()).optional(),
      error: z.string().optional(),
    }),
    description: 'Migrate local data to the cloud service',
  }),

  'cloud:reconcile-migration': defineInvokeChannel({
    channel: 'cloud:reconcile-migration',
    request: z.object({
      target: z.enum(['workspace', 'appdata']),
    }),
    response: z.object({
      /**
       * - `none`            — target directory is absent or empty on the cloud.
       * - `partial_extract` — an extract was in progress and never completed;
       *                       server has cleaned up (workspace only — appdata
       *                       merges and cannot be safely wiped).
       * - `complete`        — target exists and has content (no marker file).
       */
      state: z.enum(['none', 'partial_extract', 'complete']),
      error: z.string().optional(),
    }),
    description: 'Ask the cloud service whether a prior migration extract left partial data behind, and clean it up if so. Local-only IPC (not cloud-routable).',
  }),

  'cloud:measure-footprint': defineInvokeChannel({
    channel: 'cloud:measure-footprint',
    request: z.void(),
    /**
     * Discriminated `FootprintOutcome` from
     * `src/core/services/cloud/cloudMigrationFootprint.ts`, plus a
     * `durationMs` timer for observability. Never throws — IO errors are
     * folded into `kind: 'unknown_partial'` so the renderer can branch on
     * the outcome rather than try/catch.
     *
     * Why this must run in the main process:
     *   The footprint walker does `fs.stat`/`fs.readdir` — renderer cannot.
     *   See planning doc Stage 3 "Review-Driven Amendments" for context.
     */
    response: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('measured_zero'),
        totalBytes: z.literal(0),
        workspaceBytes: z.literal(0),
        appDataBytes: z.number(),
        durationMs: z.number(),
      }),
      z.object({
        kind: z.literal('measured_nonzero'),
        totalBytes: z.number(),
        workspaceBytes: z.number().optional(),
        appDataBytes: z.number(),
        durationMs: z.number(),
      }),
      z.object({
        kind: z.literal('unknown_partial'),
        partialBytes: z.number(),
        reason: z.enum(['timeout', 'permission', 'mount_error', 'symlink_cycle']),
        durationMs: z.number(),
      }),
    ]),
    description: 'Measure cloud-migration footprint (workspace + app data). Main-process only (renderer can\u2019t stat files). Returns a discriminated outcome so the UI can show a recommended volume size or prompt the user on unknown_partial.',
  }),

  'cloud:auth-relay': defineInvokeChannel({
    channel: 'cloud:auth-relay',
    request: z.object({
      provider: z.string(),
      tokenData: z.record(z.string(), z.unknown()),
      accountId: z.string().optional(),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Relay OAuth tokens to the cloud service',
  }),

  'cloud:outbox-status': defineInvokeChannel({
    channel: 'cloud:outbox-status',
    request: z.void(),
    response: z.object({
      pending: z.number(),
      failed: z.number(),
    }),
    description: 'Get current cloud outbox pending/failed operation counts (local-only channel)',
  }),
  'cloud:workspace-force-sync': defineInvokeChannel({
    channel: 'cloud:workspace-force-sync',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      pushed: z.number().optional(),
      skipped: z.number().optional(),
      failed: z.number().optional(),
      error: z.string().optional(),
    }),
    description: 'Force an immediate workspace sync to cloud',
  }),

  'cloud:sync-now': defineInvokeChannel({
    channel: 'cloud:sync-now',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      workspace: z.object({
        pushed: z.number(),
        skipped: z.number(),
        failed: z.number(),
      }),
      error: z.string().optional(),
    }),
    description: 'Run a full incremental sync across all domains (workspace, sessions, inbox, settings)',
  }),

  'cloud:check-update': defineInvokeChannel({
    channel: 'cloud:check-update',
    request: z.object({ channel: z.enum(['stable', 'beta']).optional() }).optional(),
    response: z.object({
      success: z.boolean(),
      updateAvailable: z.boolean(),
      latestTag: z.string().optional(),
      latestImage: z.string().optional(),
      runningVersion: z.string().optional(),
      rateLimited: z.boolean().optional(),
      error: z.string().optional(),
    }),
    description: 'Check GHCR for the latest cloud image and compare against the running instance version',
  }),

  'cloud:apply-update': defineInvokeChannel({
    channel: 'cloud:apply-update',
    request: z.object({ latestTag: z.string().optional(), channel: z.enum(['stable', 'beta']).optional() }).optional(),
    response: z.object({
      success: z.boolean(),
      updated: z.boolean(),
      latestTag: z.string().optional(),
      targetImage: z.string().optional(),
      machineStateBefore: z.string().optional(),
      startedMachine: z.boolean().optional(),
      runningVersion: z.string().optional(),
      rateLimited: z.boolean().optional(),
      error: z.string().optional(),
    }),
    description: 'Trigger cloud service self-update via admin endpoint',
  }),

  'cloud:repair-ingress': defineInvokeChannel({
    channel: 'cloud:repair-ingress',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      address: z.string().optional(),
      alreadyExists: z.boolean().optional(),
      error: z.string().optional(),
    }),
    description: 'Allocate shared IPv4 for a canonical *.fly.dev cloud instance missing public IP',
  }),

  'cloud:repair-token': defineInvokeChannel({
    channel: 'cloud:repair-token',
    request: z.object({
      force: z.boolean().optional(),
    }).optional(),
    response: z.object({
      success: z.boolean(),
      conflict: z.boolean().optional(),
      restarted: z.boolean().optional(),
      alreadyCorrect: z.boolean().optional(),
      error: z.string().optional(),
    }),
    description: 'Repair REBEL_CLOUD_TOKEN in the Fly machine environment (user-confirmed)',
  }),

  'cloud:repair-fly-token': defineInvokeChannel({
    channel: 'cloud:repair-fly-token',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      alreadyRepaired: z.boolean().optional(),
      restarted: z.boolean().optional(),
      error: z.string().optional(),
    }),
    description: 'Bootstrap FLY_API_TOKEN as a Fly secret on the user\'s cloud app + restart, so the cloud-side self-updater can run without the desktop',
  }),

  'cloud:machine-state': defineInvokeChannel({
    channel: 'cloud:machine-state',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      machine: z.object({
        state: z.string(),
        checks: z.array(z.object({
          name: z.string(),
          status: z.string(),
          output: z.string().optional(),
        })).optional(),
      }).optional(),
      error: z.string().optional(),
    }),
    description: 'Get current Fly machine state for update progress monitoring',
  }),

  'cloud:export-diagnostics': defineInvokeChannel({
    channel: 'cloud:export-diagnostics',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      bundle: z.record(z.string(), z.unknown()).optional(),
      error: z.string().optional(),
    }),
    description: 'Export a redacted diagnostic bundle combining remote and local cloud metadata',
  }),

  'cloud:share-create': defineInvokeChannel({
    channel: 'cloud:share-create',
    request: z.union([
      z.object({
        resourceType: z.literal('conversation').optional(),
        sessionId: z.string(),
        expiresIn: z.enum(['24h', '7d', '30d', 'never']).optional(),
        password: z.string().min(1).max(128).optional(),
      }),
      z.object({
        resourceType: z.literal('file'),
        filePath: z.string(),
        expiresIn: z.enum(['24h', '7d', '30d', 'never']).optional(),
        password: z.string().min(1).max(128).optional(),
      }),
    ]),
    response: z.object({
      success: z.boolean(),
      shareId: z.string().optional(),
      expiresAt: z.number().optional(),
      hasPassword: z.boolean().optional(),
      error: z.string().optional(),
    }),
    description: 'Create or get existing share link for a conversation or file on the cloud service',
  }),

  'cloud:share-update': defineInvokeChannel({
    channel: 'cloud:share-update',
    request: z.union([
      z.object({
        resourceType: z.literal('conversation').optional(),
        sessionId: z.string(),
        expiresIn: z.enum(['24h', '7d', '30d', 'never']).optional(),
        password: z.string().min(1).max(128).nullable().optional(),
      }),
      z.object({
        resourceType: z.literal('file'),
        filePath: z.string(),
        expiresIn: z.enum(['24h', '7d', '30d', 'never']).optional(),
        password: z.string().min(1).max(128).nullable().optional(),
      }),
    ]),
    response: z.object({
      success: z.boolean(),
      expiresAt: z.number().optional(),
      hasPassword: z.boolean().optional(),
      error: z.string().optional(),
    }),
    description: 'Update expiry or password on an existing share link',
  }),

  'cloud:share-list': defineInvokeChannel({
    channel: 'cloud:share-list',
    request: z.object({}),
    response: z.object({
      success: z.boolean(),
      shares: z.array(z.object({
        sessionId: z.string().optional(),
        shareId: z.string(),
        title: z.string().optional(),
        createdAt: z.number(),
        expiresAt: z.number().optional(),
        hasPassword: z.boolean(),
        resourceType: z.enum(['conversation', 'file']).optional(),
        filePath: z.string().optional(),
      })).optional(),
      error: z.string().optional(),
    }),
    description: 'List all active shared resources on the cloud service',
  }),

  'cloud:share-revoke': defineInvokeChannel({
    channel: 'cloud:share-revoke',
    request: z.union([
      z.object({
        resourceType: z.literal('conversation').optional(),
        sessionId: z.string(),
      }),
      z.object({
        resourceType: z.literal('file'),
        filePath: z.string(),
      }),
    ]),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Revoke a share link for a conversation or file on the cloud service',
  }),

  'cloud:repair-machine': defineInvokeChannel({
    channel: 'cloud:repair-machine',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      oldMachineId: z.string().optional(),
      newMachineId: z.string().optional(),
      error: z.string().optional(),
    }),
    description: 'Destroy and recreate a stuck Fly Machine, preserving the volume and config',
  }),

  'cloud:fetch-lkg-image': defineInvokeChannel({
    channel: 'cloud:fetch-lkg-image',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      record: z
        .object({
          imageTag: z.string(),
          buildCommit: z.string(),
          schemaFingerprint: z.string(),
          recordedAt: z.number(),
          isBootstrapFallback: z.boolean().optional(),
          previousLastKnownGood: z
            .object({
              imageTag: z.string(),
              schemaFingerprint: z.string(),
              recordedAt: z.number(),
            })
            .nullable(),
        })
        .nullable(),
      error: z.string().optional(),
    }),
    description: 'Fetch the last-known-good image record from the cloud /api/admin/lkg-image endpoint and cache it locally (Stage D of cloud rollback defense in depth)',
  }),

  'cloud:revert-to-last-known-good': defineInvokeChannel({
    channel: 'cloud:revert-to-last-known-good',
    request: z.object({
      // Optional override — if omitted, the IPC reads the desktop LKG cache
      // (or fetches via cloud:fetch-lkg-image) to determine the target tag.
      targetImageTag: z.string().optional(),
      confirmedByUser: z.literal(true),
    }),
    response: z.object({
      success: z.boolean(),
      outcome: z
        .enum(['rolled-back', 'no-op-same-image', 'conflict', 'image-invalid', 'fly-error'])
        .optional(),
      targetImageTag: z.string().optional(),
      error: z.string().optional(),
    }),
    description: 'User-triggered rollback to the last-known-good image. Requires explicit user confirmation (cannot fire automatically).',
  }),

  'cloud:discover-instances': defineInvokeChannel({
    channel: 'cloud:discover-instances',
    request: z.void(),
    response: z.object({
      managed: z.object({
        exists: z.boolean(),
        status: z.string().optional(),
        phase: z.string().optional(),
        cloudUrl: z.string().optional(),
        cloudToken: z.string().optional(),
        error: z.string().optional(),
      }),
      byok: z.object({
        exists: z.boolean(),
        healthy: z.boolean(),
        cloudUrl: z.string().optional(),
        providerId: z.string().optional(),
        provisionMode: z.string().optional(),
      }),
      conflict: z.boolean(),
      activeInSettings: z.enum(['managed', 'byok', 'none']),
    }),
    description: 'Discover all cloud instances (managed + BYOK) in parallel and detect conflicts',
  }),

  'cloud:resolve-conflict': defineInvokeChannel({
    channel: 'cloud:resolve-conflict',
    request: z.object({
      keep: z.enum(['managed', 'byok']),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
      warning: z.string().optional(),
    }),
    description: 'Resolve a conflict where both managed and BYOK instances exist — deprovisions the unchosen one',
  }),

  'cloud:switch-provider': defineInvokeChannel({
    channel: 'cloud:switch-provider',
    request: z.object({
      targetProviderId: z.enum(['fly', 'digitalocean', 'hetzner', 'mindstone']),
      region: z.string().optional(),
      flyApiToken: z.string().optional(),
      apiToken: z.string().optional(),
      /**
       * Desired volume size in GB for the new BYOK instance. See the
       * `cloud:provision` schema above for semantics; ignored on the
       * managed (`mindstone`) target.
       */
      volumeSizeGb: z.number().int().min(10).max(500).optional(),
    }),
    response: z.object({
      success: z.boolean(),
      cloudUrl: z.string().optional(),
      cloudToken: z.string().optional(),
      error: z.string().optional(),
      failedStep: z.enum(['preflight', 'sync', 'provision', 'migrate', 'cleanup']).optional(),
      warning: z.string().optional(),
    }),
    description: 'Non-destructive provider switch: preflight → sync down → provision new → migrate up → cleanup old',
  }),

  'cloud:workspace-conflict-list': defineInvokeChannel({
    channel: 'cloud:workspace-conflict-list',
    request: z.void(),
    response: z.object({
      conflicts: z.array(z.object({
        localPath: z.string(),
        cloudCopyPath: z.string(),
        relativePath: z.string(),
      })),
      /**
       * "Pending cloud updates" — files edited on phone/web (newer version lives
       * only in Rebel's cloud) that the desktop deliberately did NOT overwrite
       * because an OS sync engine (Drive/Dropbox/iCloud) owns the local write.
       * Distinct from a conflict: only the cloud side changed, so applying is a
       * safe one-click fast-forward (no adjudication). REBEL-696 Stage 5.
       *
       * PUBLIC SHAPE: only `relativePath` crosses the preload boundary. The
       * store-internal fingerprints (`cloudHash`, `baselineLocalHash`) and
       * timestamps stay main-side — the renderer never needs them (the apply
       * handler reads the baseline FROM the store), and they are cloud-content
       * fingerprints that shouldn't leak to the renderer.
       */
      pendingUpdates: z.array(z.object({
        relativePath: z.string(),
      })),
    }),
    description: 'List pending workspace conflict files plus pending cloud updates (newer cloud-only versions awaiting a safe one-click apply)',
  }),

  'cloud:workspace-conflict-merge': defineInvokeChannel({
    channel: 'cloud:workspace-conflict-merge',
    request: z.object({
      relativePath: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      mergedContent: z.string().optional(),
      error: z.string().optional(),
    }),
    description: 'Generate an LLM merge proposal for a specific workspace conflict',
  }),

  'cloud:workspace-conflict-resolve': defineInvokeChannel({
    channel: 'cloud:workspace-conflict-resolve',
    request: z.object({
      relativePath: z.string(),
      resolution: z.enum(['accept-merge', 'keep-local', 'keep-cloud']),
      mergedContent: z.string().optional(),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Resolve a workspace conflict by accepting merge, keeping local, or keeping cloud copy',
  }),

  'cloud:workspace-pending-update-apply': defineInvokeChannel({
    channel: 'cloud:workspace-pending-update-apply',
    request: z.object({
      relativePath: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      /**
       * Stable, non-localised failure classification so the renderer can branch
       * (and telemetry can group) without parsing the human `error` string.
       * Present only on failure.
       */
      reason: z
        .enum([
          'not_configured',
          'cloud_offline',
          'not_pending',
          'cloud_changed',
          'local_changed',
          'already_current',
          'path_unsafe',
          'cloud_read_failed',
          'local_read_failed',
          'write_failed',
        ])
        .optional(),
      error: z.string().optional(),
    }),
    description: 'Apply one pending cloud update — fast-forward a single Drive/Dropbox/iCloud-owned file to the newer cloud-only version (keep-cloud semantics, user-initiated one-shot)',
  }),

} as const;
