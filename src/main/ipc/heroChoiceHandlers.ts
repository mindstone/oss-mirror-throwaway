/**
 * Hero Choice Domain IPC Handlers
 */

import { registerHandler } from './utils/registerHandler';
import { heroChoiceChannels } from '@shared/ipc/channels/heroChoice';
import {
  getCurrentHeroChoice,
  updateCandidateState,
  setCandidateFeedback,
} from '@core/services/heroChoiceStore';
import { generateHeroChoiceNow } from '../services/heroChoiceScheduler';

export function registerHeroChoiceHandlers(): void {
  const getCurrentChannel = heroChoiceChannels['hero-choice:get-current'];
  registerHandler(getCurrentChannel.channel, async () => {
    return { entry: getCurrentHeroChoice() };
  });

  const updateStateChannel = heroChoiceChannels['hero-choice:update-candidate-state'];
  registerHandler(updateStateChannel.channel, async (_event, ...args) => {
    const validated = updateStateChannel.request.parse(args[0]);
    const success = updateCandidateState(validated.candidateId, validated.state);
    return { success };
  });

  const setFeedbackChannel = heroChoiceChannels['hero-choice:set-feedback'];
  registerHandler(setFeedbackChannel.channel, async (_event, ...args) => {
    const validated = setFeedbackChannel.request.parse(args[0]);
    const success = setCandidateFeedback(validated.candidateId, validated.feedback);
    return { success };
  });

  const generateNowChannel = heroChoiceChannels['hero-choice:generate-now'];
  registerHandler(generateNowChannel.channel, async () => {
    try {
      const entry = await generateHeroChoiceNow();
      return { entry };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { entry: null, error: msg };
    }
  });
}
