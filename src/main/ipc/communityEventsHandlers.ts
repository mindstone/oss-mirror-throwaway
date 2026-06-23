/**
 * Community Events Domain IPC Handlers
 *
 * Wires the community events IPC channels to the core service and store.
 * Desktop-only — not registered in cloudChannelPolicies.
 *
 * @see src/core/services/communityEventsService.ts
 * @see docs/plans/260402_spark_community_events_nearby.md
 */

import { registerHandler } from './utils/registerHandler';
import { communityEventsChannels } from '@shared/ipc/channels/communityEvents';
import { createScopedLogger } from '@core/logger';
import { getCommunityEventCardData } from '@core/services/communityEventsService';
import {
  fetchEventsFromGraphQL,
  lookupUserLocationFromIP,
  geocodeAddressViaNominatim,
} from '@core/services/communityEventsApiClient';
import {
  setSuppressed,
  dismissEvent,
} from '@core/services/communityEventsStore';
import { getWeekTopSessions } from '@core/services/timeSavedStore';

const log = createScopedLogger({ service: 'communityEventsHandlers' });

export function registerCommunityEventsHandlers(): void {
  // ── Get card data ───────────────────────────────────────────────
  const getCardDataChannel = communityEventsChannels['communityEvents:get-card-data'];
  registerHandler(getCardDataChannel.channel, async () => {
    try {
      return await getCommunityEventCardData({
        fetchEvents: fetchEventsFromGraphQL,
        lookupUserLocation: lookupUserLocationFromIP,
        geocodeAddress: geocodeAddressViaNominatim,
        getTopSession: () => {
          const sessions = getWeekTopSessions(1);
          return sessions.length > 0 ? sessions[0] : null;
        },
      });
    } catch (error) {
      log.warn({ error }, 'Failed to get community event card data');
      return { type: 'no-event' as const, organizerUrl: 'https://community-admin.mindstone.ai/interest' };
    }
  });

  // ── Suppress/unsuppress ─────────────────────────────────────────
  const suppressChannel = communityEventsChannels['communityEvents:suppress'];
  registerHandler(suppressChannel.channel, async (_event, ...args) => {
    const validated = suppressChannel.request.parse(args[0]);
    setSuppressed(validated.suppress);
    return { success: true };
  });

  // ── Dismiss event ───────────────────────────────────────────────
  const dismissChannel = communityEventsChannels['communityEvents:dismiss-event'];
  registerHandler(dismissChannel.channel, async (_event, ...args) => {
    const validated = dismissChannel.request.parse(args[0]);
    dismissEvent(validated.eventId);
    return { success: true };
  });
}
