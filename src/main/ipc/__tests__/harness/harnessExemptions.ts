/**
 * Stage 7: the reasoned, category-based exemption map for the IPC contract
 * harness coverage guard.
 *
 * ## The problem this solves (anti-rot keystone)
 * The round-trip harness (Stages 5–6) covers the **cloud-safe registrar subset**
 * — 276 invoke channels that are (a) `type:'invoke'`, (b) NOT skipped from the
 * handler-presence assertion (i.e. expected to register through the
 * `registerHandler` chokepoint, not a `RAW_IPC_BYPASS_CHANNELS`/e2e bypass), and
 * (c) actually registered by the 23 cloud-safe registrars in
 * `cloudSafeRegistrars.ts`. The full not-skipped invoke surface is ~600 channels,
 * so ~324 invoke channels are NOT round-tripped today.
 *
 * Without a guard, a newly-added invoke channel that the harness does not cover
 * would be SILENTLY uncovered — exactly the "reads as covered when it isn't"
 * false-green the harness exists to prevent. The coverage guard
 * (`coverageGuard.ts`) makes every uncovered channel either:
 *   - covered (round-tripped), OR
 *   - matched by a **reasoned, category-based rule below**, OR
 *   - a LOUD test failure (with the channel name + the category it fell through).
 *
 * ## Why a DOMAIN-keyed category map (not 324 per-channel entries)
 * Measured (Stage-7 probe, 2026-06-09): the uncovered not-skipped invoke surface
 * partitions **cleanly by `ipcContract` domain group** — every covered domain has
 * ALL of its not-skipped invoke channels covered, and every uncovered channel
 * belongs to a domain group that is **entirely** uncovered (the
 * `mixedDomainUncovered` probe set was empty). This is structural: a registrar
 * registers a whole domain's channels or none of them, and the cloud-safe subset
 * is exactly the set of registrars in `cloudSafeRegistrars.ts`. So a
 * **domain → {category, reason}** map is the precise, reasoned, enumerable
 * exemption granularity — one reviewed line per deferred domain, NOT a blanket
 * "everything else is fine" and NOT 324 individual channel entries.
 *
 * The guard re-derives + asserts the no-mixed-domain invariant, so if a future
 * registrar ever covers only PART of a domain (breaking the clean partition), the
 * guard fails loud and this map's granularity must be revisited.
 *
 * ## Categories (reasoned deferrals, NOT a catch-all)
 * Every exempt domain is tagged with one of these enumerated categories. The
 * category is the *reason* the domain is out of the current cloud-safe round-trip
 * scope — each is a deliberate, reviewed deferral, not an accident:
 *  - `agent-surface`      — the heavy agent/turn-executor + operator surface;
 *                           depends on the sibling spin-out's
 *                           `bootRealAgentServices()`. Visible deferral.
 *  - `connector`          — external OAuth/API connectors (Google/GitHub/Slack/
 *                           Salesforce/Plaud); most use direct-`ipcMain.handle`
 *                           bypass, the rest need live external deps. Deferred.
 *  - `plugins-mcp`        — the plugin host + MCP surface; not in the cloud-safe
 *                           registrar set, large transitive deps. Deferred.
 *  - `desktop-native`     — Electron/desktop-only surfaces (windows, clipboard,
 *                           voice, meeting bot, local STT/inference, recording)
 *                           that the headless cloud-safe boot does not register.
 *  - `cloud-orchestration`— cloud provisioning / continuity / subscription /
 *                           routing channels that need the cloud-coupled tail the
 *                           minimal ambient boot deliberately does NOT install.
 *  - `not-cloud-safe`     — other registrars simply not in the 23-entry cloud-safe
 *                           barrel yet (smaller misc/feature domains). Deferred
 *                           until a registrar is added to `cloudSafeRegistrars.ts`.
 *
 * NOTE on no-arg (void-request) channels: they are NOT whole-channel-exempt here.
 * A void-request channel that IS covered keeps full RESPONSE coverage via the
 * harness; the request side is vacuous for it but the response is still parsed.
 * The request-side-only exemption lives in the harness/sampler layer, not here —
 * this map only governs which *whole channels* are out of round-trip scope.
 */

import { ipcContract } from '@shared/ipc/contracts';

/** The enumerated reasons an `ipcContract` domain is outside the current round-trip scope. */
export type HarnessExemptCategory =
  | 'agent-surface'
  | 'connector'
  | 'plugins-mcp'
  | 'desktop-native'
  | 'cloud-orchestration'
  | 'not-cloud-safe';

export interface HarnessExemptDomain {
  readonly category: HarnessExemptCategory;
  /** One-line human reason this domain is deferred (shown in the guard failure). */
  readonly reason: string;
}

/** Every `ipcContract` domain key (typed against the registry so a rename fails to compile). */
export type IpcContractDomain = keyof typeof ipcContract;

/**
 * The reasoned, category-based exemption map: every `ipcContract` domain whose
 * not-skipped invoke channels are intentionally NOT round-tripped by the
 * cloud-safe harness subset today, each with a category + one-line reason.
 *
 * Keyed by `IpcContractDomain` so a domain rename/removal is a COMPILE error, and
 * validated at runtime by `coverageGuard.ts` (a key that is not a real domain, or
 * a domain that is actually covered, fails the guard).
 *
 * To cover one of these: add its registrar to `cloudSafeRegistrars.ts` (Stage 5),
 * then DELETE its entry here — the guard will then require it to round-trip.
 */
export const HARNESS_EXEMPT_DOMAINS: Partial<Record<IpcContractDomain, HarnessExemptDomain>> = {
  // ── agent-surface (sibling-deferred: needs bootRealAgentServices()) ──
  agent: { category: 'agent-surface', reason: 'agent turn-executor surface; depends on the sibling spin-out bootRealAgentServices()' },
  agentError: { category: 'agent-surface', reason: 'agent error-reporting surface; part of the deferred agent boot' },
  operators: { category: 'agent-surface', reason: 'operator-management surface; part of the deferred agent boot' },
  codex: { category: 'agent-surface', reason: 'Codex agent integration; deferred with the agent surface' },
  systemImprovement: { category: 'agent-surface', reason: 'self-improvement/agent-feedback surface; deferred with the agent surface' },
  contribution: { category: 'agent-surface', reason: 'contribution/agent-output surface; deferred with the agent surface' },
  inboundTriggers: { category: 'agent-surface', reason: 'inbound automation triggers feeding the agent; deferred with the agent surface' },

  // ── connector (external OAuth/API; bypass or live-deps) ──
  googleWorkspace: { category: 'connector', reason: 'Google Workspace OAuth connector; live external deps, not in the cloud-safe registrar set' },
  github: { category: 'connector', reason: 'GitHub connector; live external deps, not in the cloud-safe registrar set' },
  slack: { category: 'connector', reason: 'Slack connector; live external deps, not in the cloud-safe registrar set' },
  salesforce: { category: 'connector', reason: 'Salesforce connector; live external deps, not in the cloud-safe registrar set' },
  plaud: { category: 'connector', reason: 'Plaud device/cloud connector; live external deps, not in the cloud-safe registrar set' },

  // ── plugins-mcp ──
  plugins: { category: 'plugins-mcp', reason: 'plugin host surface; large transitive deps, not in the cloud-safe registrar set' },

  // ── desktop-native (Electron/desktop-only; headless boot does not register) ──
  app: { category: 'desktop-native', reason: 'desktop app/window/clipboard/notification surface; Electron-only, not headless-bootable' },
  appBridge: { category: 'desktop-native', reason: 'desktop app-bridge surface; Electron-only' },
  voice: { category: 'desktop-native', reason: 'voice capture/TTS surface; desktop-only deps' },
  meetingBot: { category: 'desktop-native', reason: 'meeting-bot surface; desktop-only deps' },
  systemHealth: { category: 'desktop-native', reason: 'system-health/diagnostics-of-host surface; desktop-only deps' },
  auth: { category: 'desktop-native', reason: 'desktop auth/session surface; Electron-only window flows' },
  export: { category: 'desktop-native', reason: 'file export/save-dialog surface; Electron-only dialog deps' },
  migration: { category: 'desktop-native', reason: 'move-to-new-computer export/import surface; native save/open dialogs, local userData file ops, boot-time profile adoption + app.relaunch — Electron-only, fundamentally not cloud-routable' },
  demo: { category: 'desktop-native', reason: 'demo/dev-only desktop surface' },
  version: { category: 'desktop-native', reason: 'app-update/version surface; Electron autoUpdater deps' },
  focus: { category: 'desktop-native', reason: 'focus-mode/desktop-window surface; Electron-only' },
  officeSidecar: { category: 'desktop-native', reason: 'office-sidecar bridge; desktop-only deps' },
  htmlPreviewTrust: { category: 'desktop-native', reason: 'HTML preview trust surface; desktop-only window deps' },

  // ── cloud-orchestration (needs the cloud-coupled tail the ambient boot omits) ──
  cloud: { category: 'cloud-orchestration', reason: 'cloud provisioning/routing; needs the cloud-coupled bootstrap tail the minimal ambient boot deliberately omits' },
  cloudContinuity: { category: 'cloud-orchestration', reason: 'cloud continuity/catch-up; needs the cloud-coupled tail' },
  subscription: { category: 'cloud-orchestration', reason: 'subscription/billing surface; needs live cloud deps' },
  openRouter: { category: 'cloud-orchestration', reason: 'OpenRouter routing surface; needs live provider deps' },
  spaceMaintenance: { category: 'cloud-orchestration', reason: 'space-maintenance surface; needs cloud-coupled deps' },

  // ── not-cloud-safe (misc/feature registrars simply not in the 23-entry barrel yet) ──
  permissions: { category: 'not-cloud-safe', reason: 'permissions surface; registrar not in the cloud-safe barrel yet' },
  bugReport: { category: 'not-cloud-safe', reason: 'bug-report surface; registrar not in the cloud-safe barrel yet' },
  heroChoice: { category: 'not-cloud-safe', reason: 'hero-choice onboarding surface; registrar not in the cloud-safe barrel yet' },
  dailySpark: { category: 'not-cloud-safe', reason: 'daily-spark surface; registrar not in the cloud-safe barrel yet' },
  communityEvents: { category: 'not-cloud-safe', reason: 'community-events surface; registrar not in the cloud-safe barrel yet' },
  communityVideoRecs: { category: 'not-cloud-safe', reason: 'community-video-recs surface; registrar not in the cloud-safe barrel yet' },
  folders: { category: 'not-cloud-safe', reason: 'folders surface; registrar not in the cloud-safe barrel yet' },
  identity: { category: 'not-cloud-safe', reason: 'Desktop-only OSS lead-capture egress (identity:capture-oss-lead); fire-and-forget POST to Mindstone, intentionally not cloud-routable — excluded from CLOUD_CHANNEL_POLICIES (see identityChannelCloudPolicy.test.ts). No cloud-safe registrar by design.' },
};
