// SHIM-RETAINED: Cloud meeting upload flow still imports this module for coaching environment wiring.
/**
 * @deprecated Canonical implementation moved to @core/services/meeting/coaching.
 * This cloud file remains as a compatibility shim + cloud wiring.
 */

import { setMeetingCoachingEngineEnvironment } from '@core/services/meeting/coaching';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';

setMeetingCoachingEngineEnvironment({
  broadcastCoachingCard: (card) => {
    cloudEventBroadcaster.broadcast('meeting:coaching-card', card);
  },
});

export * from '@core/services/meeting/coaching';
