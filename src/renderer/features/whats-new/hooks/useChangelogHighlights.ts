import { useEffect, useMemo, useState } from 'react';
import { useSettings } from '@renderer/features/settings/SettingsProvider';
import {
  parseChangelogHighlights,
  type ChangelogHighlight,
} from '../utils/changelogParser';

/**
 * Result returned by `useChangelogHighlights`.
 */
export interface UseChangelogHighlightsResult {
  /** Highlights for the current app version, minus any the user has dismissed. */
  highlights: ChangelogHighlight[];
  /** True while the changelog IPC is in-flight. */
  loading: boolean;
}

/**
 * Module-level in-flight dedup for the changelog fetch.
 *
 * Multiple hook instances that mount while a fetch is in progress share the
 * same underlying `window.miscApi.getChangelog()` promise. This intentionally
 * dedupes the IPC call without caching the result — after the promise
 * resolves we clear the reference so the next mount performs a fresh fetch.
 *
 * This keeps the hook cheap when many surfaces subscribe (empty-state whisper,
 * nudge, sidebar widget) at the same moment during app startup, while leaving
 * the changelog source-of-truth up to each hook instance's own state.
 */
let inflightPromise: Promise<string | null> | null = null;

/**
 * Shared fetcher. Returns the raw changelog markdown (or `null` on failure).
 * Wraps the IPC call with try/catch so callers never observe a rejection.
 */
async function fetchChangelogMarkdown(): Promise<string | null> {
  if (inflightPromise) return inflightPromise;

  inflightPromise = (async () => {
    try {
      const result = await window.miscApi.getChangelog();
      if (result.success && result.content) {
        return result.content;
      }
      return null;
    } catch (err) {
      console.error('[useChangelogHighlights] Failed to fetch changelog:', err);
      return null;
    } finally {
      inflightPromise = null;
    }
  })();

  return inflightPromise;
}

/**
 * Hook: returns the current-version changelog highlights for use as a
 * discovery candidate (see `contextualDiscoverySelection`).
 *
 * Behaviour:
 * - Gated on `settings.onboardingCompleted` — onboarding-active users don't
 *   see discovery slots yet.
 * - When ineligible to fetch, returns `{ highlights: [], loading: false }`.
 * - Fetches via `window.miscApi.getChangelog()` with module-level in-flight
 *   dedup so concurrent mounts share a single IPC call.
 * - Parses with `parseChangelogHighlights` against the app version (after
 *   stripping any `v` prefix).
 * - Filters out highlights the user has already dismissed for this version
 *   via `settings.dismissedWhatsNewHighlights[version]`.
 *
 * Relevance scoring is intentionally left to the presentation layer — this
 * hook exposes the full eligible set so consumers can pick however they want.
 */
export function useChangelogHighlights(): UseChangelogHighlightsResult {
  const { settings } = useSettings();

  const appVersion = window.electronEnv?.appVersion;
  const normalizedAppVersion = appVersion?.replace(/^v/, '');

  const eligible = Boolean(settings?.onboardingCompleted && normalizedAppVersion);

  const [rawHighlights, setRawHighlights] = useState<ChangelogHighlight[]>([]);
  const [loading, setLoading] = useState<boolean>(eligible);

  useEffect(() => {
    if (!eligible || !normalizedAppVersion) {
      setRawHighlights([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    void fetchChangelogMarkdown().then((markdown) => {
      if (cancelled) return;
      if (markdown) {
        setRawHighlights(parseChangelogHighlights(markdown, normalizedAppVersion));
      } else {
        setRawHighlights([]);
      }
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [eligible, normalizedAppVersion]);

  const dismissedTitles = useMemo(() => {
    if (!normalizedAppVersion || !settings?.dismissedWhatsNewHighlights) {
      return new Set<string>();
    }
    return new Set(settings.dismissedWhatsNewHighlights[normalizedAppVersion] ?? []);
  }, [normalizedAppVersion, settings?.dismissedWhatsNewHighlights]);

  const highlights = useMemo(
    () => rawHighlights.filter((h) => !dismissedTitles.has(h.title)),
    [rawHighlights, dismissedTitles],
  );

  return { highlights, loading };
}
