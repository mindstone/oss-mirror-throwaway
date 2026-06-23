/**
 * Desktop adapter for `ApprovalTransport`.
 *
 * Added by Stage 0 of the cross-surface approval consolidation plan
 * (`docs/plans/260416_centralize_approval_and_diff_viewing_ux.md`). Wraps the
 * existing `window.safetyPromptApi.*` and `window.settingsApi.*` bridges so
 * hooks moved to `@rebel/cloud-client` in Stage 4 can run on desktop without
 * talking to `window.*` directly.
 *
 * Semantics in this stage:
 *  - `safetyPrompt.*` forwards to the existing IPC bridge.
 *  - `settings.setSpaceSafetyLevel` preserves today's behaviour by doing a
 *    `settings.get` → shallow-merge `spaceSafetyLevels` → `settings.update`
 *    dance. Stage 4 will replace this with a narrow, dedicated channel so the
 *    cloud transport never has to expose full `AppSettings` (see D11).
 *  - `safetyPrompt.onUpdated` subscribes via the new
 *    `window.safetyPromptSubscriptions.onSafetyPromptUpdated` bridge (wired
 *    alongside this module in Stage 0).
 */

import type {
  ApprovalTransport,
  SafetyPromptSnapshot,
  SpaceSafetyLevel,
} from '@rebel/cloud-client';
import { ApprovalTransportError } from '@rebel/cloud-client';

/**
 * Build the desktop adapter. Optional overrides are used by tests; production
 * callers invoke `buildDesktopApprovalTransport()` with no arguments so the
 * real `window.*` bridges are used.
 */
export interface DesktopApprovalTransportDeps {
  /** Injected `window.safetyPromptApi`. Defaults to the real bridge. */
  safetyPromptApi?: typeof window.safetyPromptApi;
  /** Injected `window.settingsApi`. Defaults to the real bridge. */
  settingsApi?: typeof window.settingsApi;
  /** Injected push-event subscription bridge. Defaults to the real one. */
  safetyPromptSubscriptions?: typeof window.safetyPromptSubscriptions;
}

export function buildDesktopApprovalTransport(
  deps: DesktopApprovalTransportDeps = {},
): ApprovalTransport {
  const safetyPromptApi = deps.safetyPromptApi ?? window.safetyPromptApi;
  const settingsApi = deps.settingsApi ?? window.settingsApi;
  const safetyPromptSubscriptions =
    deps.safetyPromptSubscriptions ?? window.safetyPromptSubscriptions;

  return {
    safetyPrompt: {
      generateOptions(ctx) {
        return safetyPromptApi.generateOptions(ctx);
      },
      generateDenyOptions(ctx) {
        return safetyPromptApi.generateDenyOptions(ctx);
      },
      applySelection(req) {
        return safetyPromptApi.applySelection(req);
      },
      applyDenySelection(req) {
        return safetyPromptApi.applyDenySelection(req);
      },
      async update(req): Promise<SafetyPromptSnapshot> {
        const response = await safetyPromptApi.update({
          prompt: req.prompt,
          updatedBy: req.updatedBy,
        });
        return {
          prompt: response.prompt,
          version: response.version,
          lastUpdatedAt: response.lastUpdatedAt,
          lastUpdatedBy: response.lastUpdatedBy,
          history: response.history,
          migrationComplete: response.migrationComplete,
        };
      },
      onUpdated(listener) {
        return safetyPromptSubscriptions.onSafetyPromptUpdated(listener);
      },
    },
    settings: {
      async setSpaceSafetyLevel(spaceId: string, level: SpaceSafetyLevel): Promise<void> {
        // Uses the narrow-slice `settings:set-space-safety-level` channel (D11 / F-R2-2).
        // The previous get→merge→update dance was racy (F-R2-12).
        //
        // F4-1 fail-loud: the handler returns `{ success: boolean, error?, spaceId? }`
        // and does NOT throw on error (READ_ONLY / UNKNOWN_SPACE_ID). Without
        // this check the hook would treat the void-returning call as success
        // and silently apply the UI "applied" state while no mutation happened.
        const response = await settingsApi.setSpaceSafetyLevel({ spaceId, level });
        if (response && response.success === false) {
          const { success: _s, error, ...rest } = response;
          throw new ApprovalTransportError(
            'settings.setSpaceSafetyLevel',
            error,
            rest,
          );
        }
      },
      async addTrustedTool(req): Promise<void> {
        const response = await settingsApi.addTrustedTool({
          toolId: req.toolId,
          displayName: req.displayName,
          serverHint: req.serverHint,
        });
        if (response && response.success === false) {
          // F4-1 fail-loud. Stage 4 R2 hardened the handler + schema so the
          // response now carries `error: 'READ_ONLY'` + `toolId` when the
          // settings store is read-only, giving consumers typed classification.
          const { success: _s, ...rest } = response as { success: boolean } & Record<string, unknown>;
          throw new ApprovalTransportError(
            'settings.addTrustedTool',
            typeof rest.error === 'string' ? rest.error : undefined,
            rest,
          );
        }
      },
    },
  };
}
