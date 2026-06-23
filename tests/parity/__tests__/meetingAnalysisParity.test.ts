import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAttachmentPayload } from '@shared/types';
import { runFallbackAnalysis } from '../../../cloud-service/src/services/cloudMeetingAnalysis';
import {
  initializeMeetingAnalysisService,
  triggerMeetingAnalysis,
} from '../../../src/main/services/meetingBot/meetingAnalysisService';

describe('meeting analysis parity', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
    vi.restoreAllMocks();
  });

  it('produces identical prompt + attachment payload for the same transcript fixture on cloud and desktop', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-analysis-parity-'));
    tempDirs.push(workspaceDir);

    const cloudCalls: Array<{
      prompt: string;
      resetConversation: boolean;
      attachments: AgentAttachmentPayload[];
    }> = [];

    const fallbackResult = await runFallbackAnalysis(
      {
        botId: 'bot-1',
        userId: 'user-1',
        meetingTitle: 'Parity Sync',
        transcript: 'Alice: shipped.\nBob: great.\n',
        participants: ['Alice', 'Bob'],
        meetingStartTime: Date.parse('2026-05-17T10:30:00.000Z'),
      },
      {
        executeAgentTurn: async (_turnId, prompt, options) => {
          cloudCalls.push({
            prompt,
            resetConversation: options.resetConversation,
            attachments: (options.attachments ?? []) as AgentAttachmentPayload[],
          });
        },
        getSettings: () => ({ coreDirectory: workspaceDir }),
      },
      'cloud-fallback',
    );

    expect(fallbackResult).toEqual({ success: true });
    expect(cloudCalls).toHaveLength(1);

    const cloudAttachment = cloudCalls[0].attachments[0];
    expect(cloudAttachment).toBeTruthy();

    const desktopCalls: Array<{
      prompt: string;
      resetConversation: boolean;
      attachments: AgentAttachmentPayload[];
    }> = [];

    initializeMeetingAnalysisService({
      runHeadlessTurn: async ({ prompt, options }) => {
        desktopCalls.push({
          prompt,
          resetConversation: options.resetConversation,
          attachments: (options.attachments ?? []) as AgentAttachmentPayload[],
        });
      },
      getSettings: () => ({ coreDirectory: workspaceDir }),
    });

    const desktopResult = await triggerMeetingAnalysis(
      'bot-1',
      cloudAttachment.path,
      undefined,
      { skipMeetingBotTracking: true },
    );

    expect(desktopResult).toEqual({ ran: true });
    expect(desktopCalls).toHaveLength(1);

    expect(desktopCalls[0].prompt).toBe(cloudCalls[0].prompt);
    expect(desktopCalls[0].resetConversation).toBe(cloudCalls[0].resetConversation);

    const normalizeAttachment = (attachment: AgentAttachmentPayload) => ({
      name: attachment.name,
      path: attachment.path,
      relativePath: attachment.relativePath,
      size: attachment.size,
      content: attachment.content,
    });

    expect(normalizeAttachment(desktopCalls[0].attachments[0])).toEqual(
      normalizeAttachment(cloudAttachment),
    );
  });
});
