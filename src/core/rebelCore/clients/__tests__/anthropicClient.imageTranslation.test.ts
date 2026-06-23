import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../modelTypes';
import { toAnthropicMessages } from '../anthropicClient';
import { TurnScopedHydrationCache } from '@core/services/imageHydrationCache';
import * as assetStoreModule from '@core/assetStore';

 
vi.mock('@core/assetStore', () => ({
  getAssetStore: vi.fn(),
}));

describe('toAnthropicMessages image translation', () => {
  it('translates internal tool_result image blocks into Anthropic base64 source shape', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: [
              { type: 'text', text: 'Screenshot captured' },
              { type: 'image', data: 'abc123', mimeType: 'image/png' },
            ],
          },
        ],
      },
    ];

    const translated = await toAnthropicMessages(messages, true) as unknown as Array<{
      role: string;
      content: Array<{
        type: string;
        content?: unknown;
      }>;
    }>;

    const toolResult = translated[0].content[0] as { content: Array<Record<string, unknown>> };
    expect(toolResult.content).toEqual([
      { type: 'text', text: 'Screenshot captured' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'abc123',
        },
      },
    ]);
  });

  it('hydrates imageRef if no data is present', async () => {
    const mockStore = {
      readAsset: vi.fn().mockResolvedValue({
        reason: 'ok',
        bytes: Buffer.from('hello-world'),
        mimeType: 'image/jpeg',
        byteSize: 11
      })
    };
    vi.mocked(assetStoreModule.getAssetStore).mockReturnValue(mockStore as any);

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-2',
            content: [
              { type: 'image', imageRef: { assetId: 'ref-1', mimeType: 'image/png', byteSize: 0 } },
            ],
          },
        ],
      },
    ];

    const cache = new TurnScopedHydrationCache();
    const translated = await toAnthropicMessages(messages, true, 'sess-1', cache) as unknown as Array<{
      role: string;
      content: Array<{ content?: Array<Record<string, unknown>> }>;
    }>;

    const toolResult = translated[0].content[0] as { content: Array<Record<string, unknown>> };
    expect(toolResult.content).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: Buffer.from('hello-world').toString('base64'),
        },
      },
    ]);
    expect(mockStore.readAsset).toHaveBeenCalledWith({ sessionId: 'sess-1', assetId: 'ref-1' });
  });

  it('inserts a synthetic tool_result when persisted history is missing one', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will check.' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'notes.md' } },
        ],
      },
    ];

    const translated = await toAnthropicMessages(messages, true) as unknown as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;

    expect(translated).toHaveLength(2);
    expect(translated[1]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'Tool result unavailable',
          is_error: true,
        },
      ],
    });
  });

  it('prepends only missing synthetic tool_results to the next user message', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
          { type: 'tool_use', id: 'tool-2', name: 'Read', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
          { type: 'text', text: 'Next instruction' },
        ],
      },
    ];

    const translated = await toAnthropicMessages(messages, true) as unknown as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;

    expect(translated).toHaveLength(2);
    expect(translated[1].content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tool-2',
        content: 'Tool result unavailable',
        is_error: true,
      },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
      { type: 'text', text: 'Next instruction' },
    ]);
  });
});
