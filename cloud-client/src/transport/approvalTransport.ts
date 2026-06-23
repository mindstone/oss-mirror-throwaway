/**
 * ApprovalTransport — platform-neutral interface for approval-flow IPC calls.
 *
 * Introduced by Stage 0 of the cross-surface approval consolidation
 * (`docs/plans/260416_centralize_approval_and_diff_viewing_ux.md`). Desktop
 * provides an adapter that wraps `window.safetyPromptApi.*` / `window.settingsApi.*`;
 * mobile provides an adapter that wraps `cloudClient.ipcCall(...)`. Hooks that
 * move from `src/renderer/` to `cloud-client/` (Stage 4) depend on this
 * interface rather than `window.*` directly, so they run unchanged on both
 * platforms.
 *
 * Design rules (enforced by review + ESLint boundary rules):
 * - This module is React-free and Zustand-free.
 * - Types mirror the Zod-inferred shapes in `src/shared/ipc/channels/safetyPrompt.ts`
 *   and `src/shared/ipc/channels/settings.ts`. They are locally defined here to
 *   avoid coupling `@rebel/cloud-client` to `@shared/ipc/*` (which is a
 *   desktop-only alias).
 * - The settings surface is INTENTIONALLY NARROW (see D11 in the planning doc):
 *   no `getAll`/`updateAll`. Exposing full `AppSettings` over the cloud
 *   transport would leak `providerKeys`, `claude.apiKey`, and other secrets.
 * - `safetyPrompt.update(...)` exists because `usePrincipleOptions.doApply()`
 *   persists the applied selection by calling `window.safetyPromptApi.update(...)`.
 *   Transport adapters MUST route it through the same channel on their platform.
 * - `safetyPrompt.onUpdated(listener)` wires push-event invalidation so that
 *   a write from one surface invalidates in-memory state on every connected
 *   surface (prevents the split-brain scenario flagged in round-2 review).
 */

// ---------------------------------------------------------------------------
// Core shapes (mirror the Zod-inferred types from src/shared/ipc/channels/*)
// ---------------------------------------------------------------------------

export type PrincipleDirection = 'allow' | 'deny';
export type PrincipleOptionScope = 'trusted_tool' | 'broad' | 'specific';
export type SafetyPromptUpdater = 'user' | 'system' | 'migration';

export interface BlockedActionContext {
  toolName: string;
  toolInput: Record<string, unknown>;
  spaceDescription?: string;
  sessionType?: 'interactive' | 'automation' | 'role';
  automationName?: string;
  blockReason: string;
}

export interface PrincipleOption {
  label: string;
  scope: PrincipleOptionScope;
}

export interface PrincipleOptionsResult {
  options: PrincipleOption[];
  error?: string;
}

export interface PrincipleApplyRequest {
  blockedAction: BlockedActionContext;
  selectedLabel: string;
  scope: PrincipleOptionScope;
}

export interface PrincipleUpdate {
  summary: string;
  proposedPrinciple: string;
  fullUpdatedPrompt: string;
}

export interface PrincipleApplyResult {
  update: PrincipleUpdate | null;
  error?: string;
}

export interface SafetyPromptHistoryEntry {
  prompt: string;
  version: number;
  updatedAt: number;
  updatedBy: SafetyPromptUpdater;
}

export interface SafetyPromptSnapshot {
  prompt: string;
  version: number;
  lastUpdatedAt: number;
  lastUpdatedBy: SafetyPromptUpdater;
  history: SafetyPromptHistoryEntry[];
  migrationComplete: boolean;
}

export interface SafetyPromptUpdateRequest {
  prompt: string;
  updatedBy?: SafetyPromptUpdater;
}

/** Space safety level — mirrors `SettingsStore.spaceSafetyLevels` values. */
export type SpaceSafetyLevel = 'permissive' | 'balanced' | 'cautious';

export interface AddTrustedToolRequest {
  toolId: string;
  displayName?: string;
  serverHint?: string;
}

/** Event payload pushed when any surface writes the safety prompt. */
export interface SafetyPromptUpdatedEvent {
  version: number;
  lastUpdatedAt: number;
  lastUpdatedBy: SafetyPromptUpdater;
}

// ---------------------------------------------------------------------------
// Fail-loud error class — thrown by adapters when a handler returns
// `{ success: false }` without throwing (F4-1).
// ---------------------------------------------------------------------------

/**
 * Error thrown by an `ApprovalTransport` adapter when the underlying IPC
 * handler returned a structured `{ success: false, error?: string }` payload
 * without raising. Without this error, the hook would treat the void-returning
 * settings calls as success and silently apply the UI "applied" state while
 * no actual mutation happened on disk.
 *
 * `code` carries the handler-provided error discriminator (`READ_ONLY`,
 * `UNKNOWN_SPACE_ID`, etc.). Callers can branch on it to surface
 * user-appropriate copy; otherwise the default message already contains the
 * code for fail-loud diagnostics.
 */
export class ApprovalTransportError extends Error {
  constructor(
    /** Which transport method failed (e.g. `'settings.addTrustedTool'`). */
    public readonly method: string,
    /** Handler-provided error code (undefined if absent). */
    public readonly code: string | undefined,
    /**
     * Extra structured fields the handler returned alongside `success: false`
     * (e.g. `{ spaceId }` on `UNKNOWN_SPACE_ID`). Kept as `unknown` so the
     * transport layer never silently reshapes handler output.
     */
    public readonly details: Record<string, unknown> = {},
  ) {
    super(
      code
        ? `ApprovalTransport ${method} failed: ${code}`
        : `ApprovalTransport ${method} failed with success: false`,
    );
    this.name = 'ApprovalTransportError';
    // Restore the prototype chain when compiled down the ES5 target — otherwise
    // `instanceof ApprovalTransportError` fails on tests transpiled through
    // older Babel pipelines (kept for defense-in-depth; most modern builds
    // don't need it).
    Object.setPrototypeOf(this, ApprovalTransportError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Transport interface
// ---------------------------------------------------------------------------

export interface ApprovalTransport {
  /**
   * Safety-prompt principle flow. Used by `usePrincipleOptions`.
   */
  safetyPrompt: {
    /** Generate 3 allow-principle options for a blocked action. */
    generateOptions(ctx: BlockedActionContext): Promise<PrincipleOptionsResult>;

    /** Generate 3 deny-principle options for a blocked action. */
    generateDenyOptions(ctx: BlockedActionContext): Promise<PrincipleOptionsResult>;

    /** Apply an allow selection — returns the proposed prompt update (not persisted). */
    applySelection(req: PrincipleApplyRequest): Promise<PrincipleApplyResult>;

    /** Apply a deny selection — returns the proposed prompt update (not persisted). */
    applyDenySelection(req: PrincipleApplyRequest): Promise<PrincipleApplyResult>;

    /**
     * Persist a safety-prompt update. Called by `usePrincipleOptions.doApply()`
     * after `applySelection()` returns. On desktop (local mode) this writes to
     * `safety-prompt.json` directly. On cloud-routed surfaces (mobile, or
     * desktop connected to cloud-service) this writes via cloud-service so
     * the cloud instance state remains the single source of truth.
     */
    update(req: SafetyPromptUpdateRequest): Promise<SafetyPromptSnapshot>;

    /**
     * Subscribe to `safety-prompt:updated` push events. Returns an unsubscribe
     * function. Used to keep in-memory copies in sync across connected surfaces.
     */
    onUpdated(listener: (evt: SafetyPromptUpdatedEvent) => void): () => void;
  };

  /**
   * Settings surface — INTENTIONALLY NARROW. See D11 in the planning doc:
   * exposing full `AppSettings` to the cloud transport would leak
   * `providerKeys`/`claude.apiKey`. Only add methods for specific, documented
   * slices needed by approval flows.
   */
  settings: {
    /**
     * Set the safety level for a single memory space. Replaces the current
     * "read full settings → modify spaceSafetyLevels → write full settings"
     * dance in `usePrincipleOptions.confirmTrustedTool()`.
     */
    setSpaceSafetyLevel(spaceId: string, level: SpaceSafetyLevel): Promise<void>;

    /**
     * Add an entry to the trusted-tools allowlist. The transport must ensure
     * this is rate-limited / audit-logged on the cloud side (desktop
     * implementation reuses the existing `settings:add-trusted-tool` IPC).
     */
    addTrustedTool(req: AddTrustedToolRequest): Promise<void>;
  };
}
