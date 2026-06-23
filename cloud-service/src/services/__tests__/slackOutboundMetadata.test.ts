import { describe, expect, it, vi } from 'vitest';
import {
  buildOutboundMetadata,
  SLACK_MESSAGE_METADATA_MAX_BYTES,
  type SlackOutboundMetadataIntent,
} from '@core/services/externalConversation/slackOutboundMetadata';

const BASE_SETTINGS = {
  experimental: {
    agentInstanceId: '7a14c8f2-6ab7-4974-b53a-c13bf9d0a585',
  },
} as const;

function createLogger() {
  return {
    warn: vi.fn(),
  };
}

describe('slackOutboundMetadata', () => {
  it.each([
    ['thread_reply', 'rebel_thread_reply'],
    ['thread_open', 'rebel_thread_open'],
    ['dm_reply', 'rebel_dm_reply'],
  ] as const)('builds %s metadata with normalized outbound event type', (intent, expectedEventType) => {
    const metadata = buildOutboundMetadata(intent, {
      settings: BASE_SETTINGS,
      workspace: { authedUserId: 'U_OWNER_1' },
      threadScope: '1779854400.000100',
    });

    expect(metadata).toEqual({
      event_type: expectedEventType,
      event_payload: {
        agentInstanceId: BASE_SETTINGS.experimental.agentInstanceId,
        ownerUserId: 'U_OWNER_1',
        threadScope: '1779854400.000100',
      },
    });
  });

  it('skips metadata and logs when agentInstanceId is missing', () => {
    const log = createLogger();
    const metadata = buildOutboundMetadata('thread_reply', {
      settings: { experimental: {} },
      workspace: { authedUserId: 'U_OWNER_1' },
      threadScope: '1779854400.000100',
      log,
    });

    expect(metadata).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'thread_reply',
        eventType: 'rebel_thread_reply',
      }),
      'slack_outbound_metadata_missing_agent_instance_id',
    );
  });

  it('skips metadata and logs when payload exceeds the 1KB cap', () => {
    const log = createLogger();
    const metadata = buildOutboundMetadata('thread_reply', {
      settings: BASE_SETTINGS,
      workspace: { authedUserId: 'U_OWNER_1' },
      threadScope: 't'.repeat(SLACK_MESSAGE_METADATA_MAX_BYTES * 2),
      log,
    });

    expect(metadata).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'thread_reply',
        eventType: 'rebel_thread_reply',
        maxBytes: SLACK_MESSAGE_METADATA_MAX_BYTES,
        metadataBytes: expect.any(Number),
      }),
      'slack_outbound_metadata_oversize',
    );
  });

  it('allows missing ownerUserId while preserving agent and thread scope', () => {
    const metadata = buildOutboundMetadata('dm_reply' satisfies SlackOutboundMetadataIntent, {
      settings: BASE_SETTINGS,
      workspace: {},
      threadScope: '1779854400.000200',
    });

    expect(metadata).toEqual({
      event_type: 'rebel_dm_reply',
      event_payload: {
        agentInstanceId: BASE_SETTINGS.experimental.agentInstanceId,
        threadScope: '1779854400.000200',
      },
    });
  });
});
