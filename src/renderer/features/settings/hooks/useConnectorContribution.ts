/**
 * Hook to fetch the most recent contribution record for a given connector name.
 *
 * Uses existing `contribution:list` IPC channel + client-side filter.
 * Fetch-on-mount only — NO polling (per forward plan D1).
 * Re-fetches when connectorName changes; stale-request guard discards
 * in-flight responses from a previous connectorName.
 *
 * @see docs/plans/260414_p8_contribution_status_settings_card.md
 */

import { useState, useEffect } from 'react';
import type { ConnectorContributionSchema } from '@shared/ipc/channels/contribution';
import type { z } from 'zod';

/** Full contribution record — inferred from the IPC schema. */
export type ConnectorContribution = z.infer<typeof ConnectorContributionSchema>;

/**
 * Fetches the most recent contribution record matching `connectorName`.
 *
 * - Returns `{ contribution: null, loading: false }` when no connectorName
 *   is provided or no matching contribution exists.
 * - Guards against stale responses: when connectorName changes, in-flight
 *   fetches from the previous name are discarded via a cancellation flag.
 *
 * @param connectorName - The MCP server config name to look up.
 */
export function useConnectorContribution(
  connectorName: string | null | undefined,
): { contribution: ConnectorContribution | null; loading: boolean } {
  const [contribution, setContribution] = useState<ConnectorContribution | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!connectorName) {
      setContribution(null);
      return;
    }

    let cancelled = false;
    setContribution(null);
    setLoading(true);

    const fetchData = async () => {
      try {
        const result = await window.contributionApi.list({});
        if (cancelled) return;
        // Find most recent contribution matching this connector name
        const match =
          result.contributions
            .filter((c) => c.connectorName.toLowerCase() === connectorName.toLowerCase())
            .sort(
              (a, b) =>
                new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
            )[0] ?? null;
        setContribution(match);
      } catch {
        // IPC failure — leave state unchanged
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void fetchData();

    return () => {
      cancelled = true;
    };
  }, [connectorName]);

  return { contribution, loading };
}
