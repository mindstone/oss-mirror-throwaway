import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHookAwareToolExecutor } from '../hookPipeline';
import type { ToolExecutionResult } from '../types';

const { curateToolOutputMock } = vi.hoisted(() => ({
  curateToolOutputMock: vi.fn(),
}));

 
vi.mock('../toolOutputCurator', () => ({
  ENABLE_TOOL_OUTPUT_CURATION: true,
  CURATION_THRESHOLD_CHARS: 1,
  curateToolOutput: curateToolOutputMock,
}));

const TEST_SIGNAL = new AbortController().signal;

describe('hookPipeline curation preserves image fields', () => {
  beforeEach(() => {
    curateToolOutputMock.mockReset();
    curateToolOutputMock.mockResolvedValue({
      output: 'curated-output',
      wasCurated: true,
      originalSize: 1024,
      curatedSize: 128,
    });
  });

  it('preserves imageRef when returning curated output', async () => {
    const resultWithImageRef: ToolExecutionResult = {
      output: 'very long output that should be curated',
      isError: false,
      imageRef: [{ assetId: 'asset-1', mimeType: 'image/png', byteSize: 42 }],
    };
    const executeTool = vi.fn(async () => resultWithImageRef);

    const executor = createHookAwareToolExecutor(
      executeTool,
      undefined,
      {},
      {
        curationContext: {
          client: {} as never,
          model: unsafeAssertRoutingModelId('test-model'),
        },
      },
    );

    const result = await executor('test_tool', {}, 'tool-use-1', TEST_SIGNAL);

    expect(result.output).toBe('curated-output');
    expect(result.imageRef).toEqual(resultWithImageRef.imageRef);
  });

  it('preserves both imageContent and imageRef on curated output', async () => {
    const resultWithImages: ToolExecutionResult = {
      output: 'another very long output that should be curated',
      isError: false,
      imageContent: [{ type: 'image', data: 'base64', mimeType: 'image/png' }],
      imageRef: [{ assetId: 'asset-2', mimeType: 'image/png', byteSize: 77 }],
    };
    const executeTool = vi.fn(async () => resultWithImages);

    const executor = createHookAwareToolExecutor(
      executeTool,
      undefined,
      {},
      {
        curationContext: {
          client: {} as never,
          model: unsafeAssertRoutingModelId('test-model'),
        },
      },
    );

    const result = await executor('test_tool', {}, 'tool-use-2', TEST_SIGNAL);

    expect(result.output).toBe('curated-output');
    expect(result.imageContent).toEqual(resultWithImages.imageContent);
    expect(result.imageRef).toEqual(resultWithImages.imageRef);
  });
});
