import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@core/agentRuntimeTypes';
import { createAgentMessageAdapter } from '@core/rebelCore/agentMessageAdapter';
import type { RebelCoreEvent } from '@core/rebelCore/types';
import type { ImageRef } from '@shared/types';
import { collectToolHints } from '../agentMessageHandler';

const TEST_IMAGE_REF: ImageRef = {
  assetId: 'turn-1-42-0',
  mimeType: 'image/png',
  byteSize: 1234,
  width: 1280,
  height: 720,
  thumbnailAssetId: 'turn-1-42-0-thumb',
  uploadStatus: 'uploaded',
};

const TEST_IMAGE_REF_1: ImageRef = {
  assetId: 'turn-1-42-1',
  mimeType: 'image/png',
  byteSize: 1734,
  uploadStatus: 'uploaded',
};

const TEST_IMAGE_REF_2: ImageRef = {
  assetId: 'turn-1-42-2',
  mimeType: 'image/png',
  byteSize: 2345,
  uploadStatus: 'uploaded',
};

const TEST_IMAGE_REF_3: ImageRef = {
  assetId: 'turn-1-42-3',
  mimeType: 'image/png',
  byteSize: 3456,
  uploadStatus: 'uploaded',
};

const getToolResultBlock = (message: AgentMessage): Record<string, unknown> => {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('Expected message content array');
  }
  const first = content[0];
  if (!first || typeof first !== 'object') {
    throw new Error('Expected tool_result content block');
  }
  return first as Record<string, unknown>;
};

describe('agentMessageAdapter ↔ agentMessageHandler imageRef roundtrip', () => {
  it('preserves imageRef from RebelCoreEvent through tool_result content and collectToolHints', () => {
    const adapter = createAgentMessageAdapter({
      model: 'claude-sonnet-4-20250514',
      tools: ['Read'],
      sessionId: 'test-session',
      cwd: '/tmp',
    });

    const event: Extract<RebelCoreEvent, { type: 'tool_use:result' }> = {
      type: 'tool_use:result',
      toolUseId: 'tool-use-1',
      output: 'Captured screenshot',
      isError: false,
      imageContent: [{ type: 'image', data: 'abc123', mimeType: 'image/png' }],
      imageRef: [TEST_IMAGE_REF],
    };

    const [message] = adapter.handleEvent(event);
    expect(message).toBeDefined();

    const toolResultBlock = getToolResultBlock(message);
    expect(toolResultBlock.imageRef).toEqual([TEST_IMAGE_REF]);
    expect(toolResultBlock.content).toEqual([
      { type: 'text', text: 'Captured screenshot' },
      { type: 'image', data: 'abc123', mimeType: 'image/png', imageRef: TEST_IMAGE_REF },
    ]);

    const toolEnd = collectToolHints(message).find((candidate) => candidate.stage === 'end');
    expect(toolEnd?.imageRef).toEqual([TEST_IMAGE_REF]);
    expect(toolEnd?.imageContent).toEqual([{ type: 'image', data: 'abc123', mimeType: 'image/png' }]);
  });

  it('falls back to top-level tool_result imageRef when image blocks do not carry refs', () => {
    const message: AgentMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-use-top-level',
          content: [
            { type: 'text', text: 'Captured screenshot' },
            { type: 'image', data: 'abc123', mimeType: 'image/png' },
          ],
          imageRef: [TEST_IMAGE_REF],
        }],
      },
    };

    const toolEnd = collectToolHints(message).find((candidate) => candidate.stage === 'end');
    expect(toolEnd?.imageRef).toEqual([TEST_IMAGE_REF]);
  });

  it('preserves a middle null imageRef through adapter and handler roundtrip', () => {
    const adapter = createAgentMessageAdapter({
      model: 'claude-sonnet-4-20250514',
      tools: ['Read'],
      sessionId: 'test-session',
      cwd: '/tmp',
    });

    const event: Extract<RebelCoreEvent, { type: 'tool_use:result' }> = {
      type: 'tool_use:result',
      toolUseId: 'tool-use-middle-null',
      output: 'Captured screenshots',
      isError: false,
      imageContent: [
        { type: 'image', data: 'img-0', mimeType: 'image/png' },
        { type: 'image', data: 'fallback-1', mimeType: 'image/png' },
        { type: 'image', data: 'img-2', mimeType: 'image/png' },
      ],
      imageRef: [TEST_IMAGE_REF, null, TEST_IMAGE_REF_2],
    };

    const [message] = adapter.handleEvent(event);
    expect(message).toBeDefined();

    const toolResultBlock = getToolResultBlock(message);
    expect(toolResultBlock.imageRef).toEqual([TEST_IMAGE_REF, null, TEST_IMAGE_REF_2]);
    expect(toolResultBlock.content).toEqual([
      { type: 'text', text: 'Captured screenshots' },
      { type: 'image', data: 'img-0', mimeType: 'image/png', imageRef: TEST_IMAGE_REF },
      { type: 'image', data: 'fallback-1', mimeType: 'image/png' },
      { type: 'image', data: 'img-2', mimeType: 'image/png', imageRef: TEST_IMAGE_REF_2 },
    ]);

    const toolEnd = collectToolHints(message).find((candidate) => candidate.stage === 'end');
    expect(toolEnd?.imageRef).toEqual([TEST_IMAGE_REF, null, TEST_IMAGE_REF_2]);
    expect(toolEnd?.imageContent).toEqual([
      { type: 'image', data: 'img-0', mimeType: 'image/png' },
      { type: 'image', data: 'fallback-1', mimeType: 'image/png' },
      { type: 'image', data: 'img-2', mimeType: 'image/png' },
    ]);
  });

  it.each([
    {
      label: 'first-null',
      refs: [null, TEST_IMAGE_REF_1, TEST_IMAGE_REF_2],
    },
    {
      label: 'last-null',
      refs: [TEST_IMAGE_REF, TEST_IMAGE_REF_1, null],
    },
    {
      label: 'multiple-null',
      refs: [null, TEST_IMAGE_REF_1, null, TEST_IMAGE_REF_3],
    },
  ])('preserves $label positional imageRef roundtrip without dropping surviving refs', ({ label, refs }) => {
    const adapter = createAgentMessageAdapter({
      model: 'claude-sonnet-4-20250514',
      tools: ['Read'],
      sessionId: 'test-session',
      cwd: '/tmp',
    });

    const imageContent = refs.map((_, index) => ({
      type: 'image' as const,
      data: `img-${index}`,
      mimeType: 'image/png',
    }));

    const event: Extract<RebelCoreEvent, { type: 'tool_use:result' }> = {
      type: 'tool_use:result',
      toolUseId: `tool-use-${label}`,
      output: 'Captured screenshots',
      isError: false,
      imageContent,
      imageRef: refs,
    };

    const [message] = adapter.handleEvent(event);
    expect(message).toBeDefined();

    const toolResultBlock = getToolResultBlock(message);
    expect(toolResultBlock.imageRef).toEqual(refs);
    expect(toolResultBlock.content).toEqual([
      { type: 'text', text: 'Captured screenshots' },
      ...refs.map((ref, index) => ({
        type: 'image',
        data: `img-${index}`,
        mimeType: 'image/png',
        ...(ref ? { imageRef: ref } : {}),
      })),
    ]);

    const toolEnd = collectToolHints(message).find((candidate) => candidate.stage === 'end');
    expect(toolEnd?.imageRef).toEqual(refs);
    expect(toolEnd?.imageContent).toEqual(imageContent);
  });
});
