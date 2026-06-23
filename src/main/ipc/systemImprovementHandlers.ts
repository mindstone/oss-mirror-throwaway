/**
 * System Improvement Domain IPC Handlers
 */

import { registerHandler } from './utils/registerHandler';
import { systemImprovementChannels } from '@shared/ipc/channels/systemImprovement';
import {
  getPendingSuggestions,
  updateSuggestionState,
} from '@core/services/systemImprovementStore';

export function registerSystemImprovementHandlers(): void {
  const getPendingChannel = systemImprovementChannels['system-improvement:get-pending'];
  registerHandler(getPendingChannel.channel, async (_event, ..._args) => {
    return { suggestions: getPendingSuggestions() };
  });

  const updateStateChannel = systemImprovementChannels['system-improvement:update-state'];
  registerHandler(updateStateChannel.channel, async (_event, ...args) => {
    const validated = updateStateChannel.request.parse(args[0]);
    const success = updateSuggestionState(validated.id, validated.state);
    return { success };
  });
}
