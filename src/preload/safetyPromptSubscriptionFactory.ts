/**
 * F-R3-9: Extracted testable factory for safety-prompt push-event subscriptions.
 *
 * Previously inlined in preload/index.ts — extraction allows unit testing
 * without requiring `contextBridge` or full Electron environment.
 */

export interface SafetyPromptUpdatedPayload {
  version: number;
  lastUpdatedAt: number;
  lastUpdatedBy: 'user' | 'system' | 'migration';
}

export interface SafetyPromptRulePersistedPayload {
  version: number;
  lastUpdatedAt: number;
  source: 'ui-picker' | 'chat-intent' | 'settings-editor' | 'system' | 'migration';
  summary: string;
  proposedPrinciple: string;
}

/**
 * Minimal IPC renderer interface — only the methods needed for subscriptions.
 * Allows injection in tests without pulling in the full Electron types.
 */
export interface IpcRendererLike {
  on(channel: string, listener: (...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (...args: unknown[]) => void): void;
}

/**
 * Create a `safetyPromptSubscriptions` API object wired to the given ipcRenderer.
 */
export function createSafetyPromptSubscriptions(ipcRenderer: IpcRendererLike) {
  return {
    onSafetyPromptUpdated: (
      callback: (data: SafetyPromptUpdatedPayload) => void,
    ): (() => void) => {
      // IpcRendererLike uses the variadic Electron signature `(...args: unknown[]) => void`,
      // so we validate the shape inside the listener rather than relying on a narrower
      // static signature. The IPC channel is typed elsewhere (contracts) — this is the
      // transport seam.
      const listener = (...args: unknown[]): void => {
        const data = args[1] as SafetyPromptUpdatedPayload;
        callback(data);
      };
      ipcRenderer.on('safety-prompt:updated', listener);
      return () => void ipcRenderer.removeListener('safety-prompt:updated', listener);
    },
    onSafetyPromptRulePersisted: (
      callback: (data: SafetyPromptRulePersistedPayload) => void,
    ): (() => void) => {
      const listener = (...args: unknown[]): void => {
        const data = args[1] as SafetyPromptRulePersistedPayload;
        callback(data);
      };
      ipcRenderer.on('safety-prompt:rule-persisted', listener);
      return () => void ipcRenderer.removeListener('safety-prompt:rule-persisted', listener);
    },
  };
}
