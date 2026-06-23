/**
 * Skills Domain IPC Handlers
 *
 * Provides skill usage tracking functionality.
 *
 * @see src/main/services/skillUsageStore.ts
 */

import type { HandlerInvokeEvent } from '@core/handlerRegistry';
import { registerHandler } from './utils/registerHandler';
import { skillsChannels } from '@shared/ipc/channels/skills';
import { getAllSkillUsage, markSkillNudged } from '../services/skillUsageStore';

export function registerSkillsHandlers(): void {
  // Get all skill usage
  const usageChannel = skillsChannels['skills:get-usage'];
  registerHandler(
    usageChannel.channel,
    async (_event: HandlerInvokeEvent, _request: unknown) => {
      const skills = getAllSkillUsage().map(s => ({
        skillName: s.skillName,
        usageCount: s.usageCount,
        lastUsedAt: s.lastUsedAt,
        lastNudgeShownAt: s.lastNudgeShownAt,
      }));
      return { skills };
    }
  );

  // Mark skill as nudged (for improvement nudge throttling)
  const nudgeChannel = skillsChannels['skills:mark-nudged'];
  registerHandler(
    nudgeChannel.channel,
    async (_event: HandlerInvokeEvent, request: unknown) => {
      const validated = nudgeChannel.request.parse(request);
      markSkillNudged(validated.skillName);
      return { success: true };
    }
  );
}
