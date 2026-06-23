import { describe, expect, it } from 'vitest';

import { computeUnifiedConnectionsSnapshot } from '../useUnifiedConnections';
import type { McpServerPreview } from '@shared/types';

/**
 * Pins the runtime status override for the Rebel Browser (bundled-app-bridge)
 * card. The backing `RebelAppBridge` MCP server is always running (it's an
 * internal server), so `server.health` stays `'ok'` forever. That means
 * revoking paired browser extensions would leave the card stuck in the
 * "connected" state with a Disconnect button the user can click forever
 * without any feedback.
 *
 * `useUnifiedConnections` consults the caller-supplied `appBridgePairedCount`
 * and flips the card status to `'available'` when there are no paired
 * clients AND the bridge itself is healthy. That moves Rebel Browser into
 * the marketplace "Available" section where the standard
 * "Set up with Rebel" CTA renders from the `!isConnected` branch of
 * `ExpandedConnectionCard` (`isConnected === (status !== 'available')`).
 *
 * See `src/renderer/features/settings/hooks/useAppBridgePairedCount.ts` for
 * the hook that produces the count, and `UnifiedConnectionsPanel.handleDisconnect`
 * for the consumer that triggers a refresh after `appBridgeApi.revoke({})`.
 */

const appBridgeServer: McpServerPreview = {
  name: 'RebelAppBridge',
  transport: 'stdio',
  catalogId: 'bundled-app-bridge',
  // Health stays 'ok' for internal servers even after all extensions are
  // unpaired — that's the whole reason this override exists.
  health: 'ok',
  args: ['/resources/mcp/rebel-app-bridge/server.cjs'],
};

function getAppBridgeConnection(
  snapshot: ReturnType<typeof computeUnifiedConnectionsSnapshot>,
) {
  return snapshot.connections.find(
    (c) => c.catalogEntry?.id === 'bundled-app-bridge',
  );
}

describe('computeUnifiedConnectionsSnapshot — bundled-app-bridge status override', () => {
  it('keeps the card as connected when appBridgePairedCount is omitted (back-compat)', () => {
    const snap = computeUnifiedConnectionsSnapshot({
      servers: [appBridgeServer],
      includeAvailable: false,
    });
    const conn = getAppBridgeConnection(snap);
    expect(conn).toBeDefined();
    // Default path: health='ok' → status 'connected'. No override applied.
    expect(conn?.status).toBe('connected');
  });

  it('keeps the card as connected when appBridgePairedCount > 0', () => {
    const snap = computeUnifiedConnectionsSnapshot({
      servers: [appBridgeServer],
      includeAvailable: false,
      appBridgePairedCount: 2,
    });
    expect(getAppBridgeConnection(snap)?.status).toBe('connected');
  });

  it('flips the card to available when appBridgePairedCount === 0 and bridge is healthy', () => {
    const snap = computeUnifiedConnectionsSnapshot({
      servers: [appBridgeServer],
      includeAvailable: false,
      appBridgePairedCount: 0,
    });
    const conn = getAppBridgeConnection(snap);
    // 'available' moves the card into the marketplace pool in
    // UnifiedConnectionsPanel (`c.status === 'available'` filter) and
    // unlocks the `!isConnected` render branch in ExpandedConnectionCard
    // that shows the standard Rebel setup CTA.
    expect(conn?.status).toBe('available');
  });

  it('does NOT override when appBridgePairedCount is null (loading / unknown)', () => {
    // Intentional: null must NOT be treated as zero, or the card would
    // briefly flash the Install button during the first paint before the
    // hook's initial fetch resolves.
    const snap = computeUnifiedConnectionsSnapshot({
      servers: [appBridgeServer],
      includeAvailable: false,
      appBridgePairedCount: null,
    });
    expect(getAppBridgeConnection(snap)?.status).toBe('connected');
  });

  it('preserves server.health === "error" even when appBridgePairedCount === 0', () => {
    // If the bridge itself is broken, the card should surface that
    // failure mode rather than routing the user into Install flow (which
    // wouldn't help: the problem isn't the pair state, it's the bridge).
    const brokenBridgeServer: McpServerPreview = {
      ...appBridgeServer,
      health: 'error',
    };
    const snap = computeUnifiedConnectionsSnapshot({
      servers: [brokenBridgeServer],
      includeAvailable: false,
      appBridgePairedCount: 0,
    });
    expect(getAppBridgeConnection(snap)?.status).toBe('error');
  });

  it('preserves server.health === "unavailable" even when appBridgePairedCount === 0', () => {
    // Same rationale as the 'error' case: bridge missing a dependency
    // should not be masked by "paired count is zero".
    const unavailableBridgeServer: McpServerPreview = {
      ...appBridgeServer,
      health: 'unavailable',
    };
    const snap = computeUnifiedConnectionsSnapshot({
      servers: [unavailableBridgeServer],
      includeAvailable: false,
      appBridgePairedCount: 0,
    });
    expect(getAppBridgeConnection(snap)?.status).toBe('needs-setup');
  });

  it('does NOT apply the override to any other connector', () => {
    const otherServer: McpServerPreview = {
      name: 'RebelDiagnostics',
      transport: 'stdio',
      catalogId: 'rebel-diagnostics',
      health: 'ok',
      args: ['/resources/mcp/rebel-diagnostics/server.cjs'],
    };
    const snap = computeUnifiedConnectionsSnapshot({
      servers: [otherServer],
      includeAvailable: false,
      appBridgePairedCount: 0,
    });
    const conn = snap.connections.find(
      (c) => c.catalogEntry?.id === 'rebel-diagnostics',
    );
    // Must remain 'connected' — the override is app-bridge-specific.
    expect(conn?.status).toBe('connected');
  });

  it('does not duplicate the Rebel Browser card when flipped to available', () => {
    // connectedIds is still populated for bundled-app-bridge even when
    // the override fires, so the marketplace pass (which also iterates
    // the catalog) must not create a second Rebel Browser card.
    const snap = computeUnifiedConnectionsSnapshot({
      servers: [appBridgeServer],
      includeAvailable: true, // marketplace pass enabled
      appBridgePairedCount: 0,
    });
    const appBridgeCards = snap.connections.filter(
      (c) => c.catalogEntry?.id === 'bundled-app-bridge',
    );
    expect(appBridgeCards).toHaveLength(1);
    expect(appBridgeCards[0]?.status).toBe('available');
  });
});
