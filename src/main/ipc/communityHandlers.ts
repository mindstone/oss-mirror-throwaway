/**
 * Community Domain IPC Handlers
 *
 * Handles community highlights from the Rebels forum and community share wins.
 */

import { getElectronModule } from '@core/lazyElectron';
import { createScopedLogger } from '@core/logger';
import { registerHandler } from './utils/registerHandler';
import { getOrGenerateAnonymousId, trackMainEvent } from '../analytics';
import { hashSessionId } from '@shared/trackingTypes';
import type { CommunityHighlightsService } from '../services/communityHighlightsService';
import type { AppSettings, AgentSession } from '@shared/types';
import { composeCommunitySharePost, buildDiscourseNewTopicUrl } from '../services/communityShareService';
import {
  getEligibility,
  storePreview,
  getPreview,
  dismissEligibility,
  setOptedOut,
  clearSessionData,
} from '../services/communityShareStore';

const log = createScopedLogger({ ipc: 'community' });

export interface CommunityHandlerDeps {
  getCommunityHighlightsService: () => CommunityHighlightsService;
  getSettings: () => AppSettings;
  getSession: (id: string) => Promise<AgentSession | null>;
}

export function registerCommunityHandlers(deps: CommunityHandlerDeps): void {
  const { getCommunityHighlightsService, getSettings, getSession } = deps;

  // ─────────────────────────────────────────────────────────────────────────
  // Community Highlights (existing)
  // ─────────────────────────────────────────────────────────────────────────

  registerHandler('community:get-highlights', async () => {
    try {
      const service = getCommunityHighlightsService();
      return service.getState();
    } catch (error) {
      log.error({ error }, 'Failed to get community highlights');
      return {
        highlights: [],
        lastFetchedAt: null,
        lastError: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  registerHandler('community:refresh-highlights', async () => {
    try {
      const service = getCommunityHighlightsService();
      return await service.refresh();
    } catch (error) {
      log.error({ error }, 'Failed to refresh community highlights');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Community Share Wins
  // ─────────────────────────────────────────────────────────────────────────

  registerHandler('community:get-share-eligibility', async (_event, args: { sessionId: string }) => {
    const eligibility = getEligibility(args.sessionId) ?? null;
    if (eligibility) {
      trackMainEvent({
        anonymousId: getOrGenerateAnonymousId(),
        event: 'Impact Story Eligible',
        properties: {
          storyId: hashSessionId(args.sessionId),
          sourceSessionId: hashSessionId(args.sessionId),
          timeSavedMinutes: eligibility.timeSavedMinutes,
          impactType: eligibility.impact,
        },
      });
    }
    return { eligibility };
  });

  registerHandler('community:compose-share-post', async (_event, args: { sessionId: string }) => {
    const { sessionId } = args;

    try {
      const session = await getSession(sessionId);

      if (!session) {
        log.warn({ sessionId }, 'Session not found for community share composition');
        return { preview: null, error: 'Session not found' };
      }

      const settings = getSettings();
      const result = await composeCommunitySharePost(session, settings);

      if (!result.success) {
        return { preview: null, error: result.error, errorKind: result.errorKind };
      }

      if (result.preview) {
        storePreview(result.preview);
        trackMainEvent({
          anonymousId: getOrGenerateAnonymousId(),
          event: 'Impact Story Submitted',
          properties: {
            storyId: hashSessionId(sessionId),
            sourceSessionId: hashSessionId(sessionId),
            workflowType: 'community_share',
            impactType: result.preview.impact,
            approvalStatus: 'pending',
          },
        });
      }

      return { preview: result.preview };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      log.error({ sessionId, error: errMsg }, 'Failed to compose community share post');
      return { preview: null, error: errMsg };
    }
  });

  registerHandler('community:open-discourse-share', async (_event, args: { sessionId: string }) => {
    const { sessionId } = args;

    try {
      const preview = getPreview(sessionId);
      if (!preview) {
        return { success: false, error: 'No preview found for session' };
      }

      // Desktop-only: copy body to clipboard and open browser
      const electron = getElectronModule();
      if (electron?.clipboard) {
        electron.clipboard.writeText(preview.body);
      }

      // Open Discourse with pre-filled title
      const url = buildDiscourseNewTopicUrl(preview.title);
      if (electron?.shell) {
        await electron.shell.openExternal(url);
      }

      // Clear the eligibility (mark as shared)
      clearSessionData(sessionId);
      trackMainEvent({
        anonymousId: getOrGenerateAnonymousId(),
        event: 'Impact Story Approved',
        properties: {
          storyId: hashSessionId(sessionId),
          sourceSessionId: hashSessionId(sessionId),
          workflowType: 'community_share',
          impactType: preview.impact,
          approvalStatus: 'approved',
          approvedAt: Date.now(),
        },
      });

      log.info({ sessionId }, 'Opened Discourse share with clipboard content');
      return { success: true };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      log.error({ sessionId, error: errMsg }, 'Failed to open Discourse share');
      return { success: false, error: errMsg };
    }
  });

  registerHandler('community:dismiss-share', async (_event, args: { sessionId: string }) => {
    dismissEligibility(args.sessionId);
    trackMainEvent({
      anonymousId: getOrGenerateAnonymousId(),
      event: 'Impact Story Dismissed',
      properties: {
        storyId: hashSessionId(args.sessionId),
        sourceSessionId: hashSessionId(args.sessionId),
        workflowType: 'community_share',
        approvalStatus: 'dismissed',
      },
    });
    log.debug({ sessionId: args.sessionId }, 'Community share dismissed');
  });

  registerHandler('community:opt-out-sharing', async () => {
    setOptedOut(true);
    log.info('User opted out of community sharing');
  });

  log.info('Community IPC handlers registered');
}
