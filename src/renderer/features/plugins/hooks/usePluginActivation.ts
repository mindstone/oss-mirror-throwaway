/**
 * usePluginActivation
 *
 * Encapsulates the per-user "On for me" / "Off for me" gesture used by the
 * Library Plugins lens. Mirrors the activation flow already in
 * `PluginsTab.enableSpacePlugin` / `disableSpacePlugin` so we keep one path
 * for compile → activation IPC → register → README index.
 *
 * Stage A1.3 of docs/plans/260521_plugin_publishing_org_distribution.md.
 */

import { useCallback, useState } from 'react';
import type { PluginManifest } from '../manifest/pluginManifest';
import { registerPlugin, unregisterPlugin } from '../manifest/pluginRegistry';

export interface ActivationTarget {
  manifest: PluginManifest;
  source: string;
  spacePath?: string;
}

export interface UsePluginActivationResult {
  pendingPluginIds: ReadonlySet<string>;
  error: string | null;
  clearError: () => void;
  activate: (target: ActivationTarget) => Promise<{ ok: true } | { ok: false; error: string }>;
  deactivate: (pluginId: string, spacePath?: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export function usePluginActivation(): UsePluginActivationResult {
  const [pendingPluginIds, setPendingPluginIds] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  const setPending = useCallback((pluginId: string, isPending: boolean) => {
    setPendingPluginIds((previous) => {
      const next = new Set(previous);
      if (isPending) {
        next.add(pluginId);
      } else {
        next.delete(pluginId);
      }
      return next;
    });
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const activate = useCallback(
    async ({ manifest, source, spacePath }: ActivationTarget) => {
      setError(null);
      setPending(manifest.id, true);
      try {
        if (!window.pluginsApi?.addActivated) {
          const message = 'Plugin activation is unavailable in this environment.';
          setError(message);
          return { ok: false as const, error: message };
        }

        const { compilePluginSource } = await import('../compiler/pluginCompiler');
        const compiled = compilePluginSource(source);
        if (!compiled.ok) {
          const message = `"${manifest.name}" has compile errors: ${compiled.errors
            .map((e) => e.message)
            .join(', ')}`;
          setError(message);
          return { ok: false as const, error: message };
        }

        await window.pluginsApi.addActivated({ pluginId: manifest.id });
        await window.pluginsApi.removeDeactivated?.({ pluginId: manifest.id });

        const registration = registerPlugin(manifest, source);
        if (!registration.ok) {
          await window.pluginsApi.removeActivated({ pluginId: manifest.id });
          setError(registration.error);
          return { ok: false as const, error: registration.error };
        }

        if (spacePath && window.pluginsApi.indexReadme) {
          const indexResponse = await window.pluginsApi.indexReadme({
            pluginId: manifest.id,
            spacePath,
          });
          if (!indexResponse.success) {
            const message = `"${manifest.name}" was turned on, but its README couldn't be indexed.`;
            setError(message);
          }
        }

        return { ok: true as const };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to turn on plugin.';
        setError(message);
        return { ok: false as const, error: message };
      } finally {
        setPending(manifest.id, false);
      }
    },
    [setPending],
  );

  const deactivate = useCallback(
    async (pluginId: string, spacePath?: string) => {
      setError(null);
      setPending(pluginId, true);
      try {
        if (!window.pluginsApi?.removeActivated) {
          const message = 'Plugin activation is unavailable in this environment.';
          setError(message);
          return { ok: false as const, error: message };
        }
        await window.pluginsApi.removeActivated({ pluginId });
        await window.pluginsApi.addDeactivated?.({ pluginId });
        unregisterPlugin(pluginId);
        if (spacePath && window.pluginsApi.deindexReadme) {
          await window.pluginsApi.deindexReadme({ pluginId, spacePath });
        }
        return { ok: true as const };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to turn off plugin.';
        setError(message);
        return { ok: false as const, error: message };
      } finally {
        setPending(pluginId, false);
      }
    },
    [setPending],
  );

  return {
    pendingPluginIds,
    error,
    clearError,
    activate,
    deactivate,
  };
}
