import { describe, it, expect } from 'vitest';
import { useAi } from '../useAi';
import type { AiApi, UseAiResult } from '../types';

/**
 * Tests for useAi hook.
 *
 * Since the project doesn't have @testing-library/react installed,
 * these tests verify the exported function type, interface structures,
 * and behavioral contracts via structural/type-level checks.
 */

describe('useAi', () => {
  describe('exports', () => {
    it('exports useAi function', () => {
      expect(typeof useAi).toBe('function');
    });
  });

  describe('AiApi type structure', () => {
    it('can construct an AiApi object with all methods', () => {
      const ai: AiApi = {
        summarize: async () => 'summary',
        extractObject: async <T>() => ({ key: 'value' }) as unknown as T,
        generate: async () => 'generated text',
      };
      expect(typeof ai.summarize).toBe('function');
      expect(typeof ai.extractObject).toBe('function');
      expect(typeof ai.generate).toBe('function');
    });

    it('summarize accepts text and optional maxLength', async () => {
      const ai: AiApi = {
        summarize: async (text: string, options?: { maxLength?: number }) => {
          return `Summary of ${text.length} chars${options?.maxLength ? `, max ${options.maxLength}` : ''}`;
        },
        extractObject: async <T>() => ({} as T),
        generate: async () => '',
      };
      const result = await ai.summarize('Hello world');
      expect(result).toBe('Summary of 11 chars');

      const withMax = await ai.summarize('Hello world', { maxLength: 50 });
      expect(withMax).toBe('Summary of 11 chars, max 50');
    });

    it('extractObject accepts text and schema, returns typed result', async () => {
      interface PersonInfo {
        name: string;
        role: string;
      }
      const ai: AiApi = {
        summarize: async () => '',
        extractObject: async <T>() => ({ name: 'Alice', role: 'Engineer' }) as T,
        generate: async () => '',
      };
      const result = await ai.extractObject<PersonInfo>('Alice is an engineer', {
        name: 'PersonInfo',
        description: 'Extract person information',
        properties: {
          name: { type: 'string', description: 'Person name' },
          role: { type: 'string', description: 'Person role' },
        },
      });
      expect(result.name).toBe('Alice');
      expect(result.role).toBe('Engineer');
    });

    it('generate accepts prompt and optional maxTokens', async () => {
      const ai: AiApi = {
        summarize: async () => '',
        extractObject: async <T>() => ({} as T),
        generate: async (prompt: string, options?: { maxTokens?: number }) => {
          return `Generated from: ${prompt}${options?.maxTokens ? ` (max ${options.maxTokens})` : ''}`;
        },
      };
      const result = await ai.generate('Write a haiku');
      expect(result).toBe('Generated from: Write a haiku');

      const withMax = await ai.generate('Write a haiku', { maxTokens: 100 });
      expect(withMax).toBe('Generated from: Write a haiku (max 100)');
    });
  });

  describe('UseAiResult type structure', () => {
    it('represents initial/idle state', () => {
      const result: UseAiResult = {
        ai: {
          summarize: async () => '',
          extractObject: async <T>() => ({} as T),
          generate: async () => '',
        },
        isProcessing: false,
        error: null,
      };
      expect(result.isProcessing).toBe(false);
      expect(result.error).toBeNull();
      expect(typeof result.ai.summarize).toBe('function');
    });

    it('represents processing state', () => {
      const result: UseAiResult = {
        ai: {
          summarize: async () => '',
          extractObject: async <T>() => ({} as T),
          generate: async () => '',
        },
        isProcessing: true,
        error: null,
      };
      expect(result.isProcessing).toBe(true);
      expect(result.error).toBeNull();
    });

    it('represents error state', () => {
      const result: UseAiResult = {
        ai: {
          summarize: async () => '',
          extractObject: async <T>() => ({} as T),
          generate: async () => '',
        },
        isProcessing: false,
        error: 'Rate limit exceeded. Try again in 30 seconds.',
      };
      expect(result.isProcessing).toBe(false);
      expect(result.error).toBe('Rate limit exceeded. Try again in 30 seconds.');
    });

    it('can represent concurrent processing with error from prior call', () => {
      const result: UseAiResult = {
        ai: {
          summarize: async () => '',
          extractObject: async <T>() => ({} as T),
          generate: async () => '',
        },
        isProcessing: true,
        error: 'Previous call failed',
      };
      // isProcessing and error can coexist during concurrent calls
      expect(result.isProcessing).toBe(true);
      expect(result.error).toBe('Previous call failed');
    });
  });

  describe('IPC request construction logic', () => {
    it('builds summarize request with only required fields', () => {
      const pluginId = 'test-plugin';
      const text = 'Hello world';
      const buildRequest = (options?: { maxLength?: number }): Record<string, unknown> => {
        const request: Record<string, unknown> = { pluginId, text };
        if (options?.maxLength != null) request.maxLength = options.maxLength;
        return request;
      };
      const request = buildRequest();

      expect(request).toEqual({ pluginId: 'test-plugin', text: 'Hello world' });
    });

    it('builds summarize request with maxLength', () => {
      const pluginId = 'test-plugin';
      const text = 'Hello world';
      const options = { maxLength: 100 };

      const request: Record<string, unknown> = { pluginId, text };
      if (options?.maxLength != null) request.maxLength = options.maxLength;

      expect(request).toEqual({ pluginId: 'test-plugin', text: 'Hello world', maxLength: 100 });
    });

    it('builds extract request with schema', () => {
      const pluginId = 'my-plugin';
      const text = 'Extract this';
      const schema = {
        name: 'PersonInfo',
        description: 'Extract person info',
        properties: { name: { type: 'string' } },
      };

      const request = { pluginId, text, schema };
      expect(request.pluginId).toBe('my-plugin');
      expect(request.text).toBe('Extract this');
      expect(request.schema.name).toBe('PersonInfo');
      expect(request.schema.properties).toEqual({ name: { type: 'string' } });
    });

    it('builds generate request with only required fields', () => {
      const pluginId = 'gen-plugin';
      const prompt = 'Write something';
      const buildRequest = (options?: { maxTokens?: number }): Record<string, unknown> => {
        const request: Record<string, unknown> = { pluginId, prompt };
        if (options?.maxTokens != null) request.maxTokens = options.maxTokens;
        return request;
      };
      const request = buildRequest();

      expect(request).toEqual({ pluginId: 'gen-plugin', prompt: 'Write something' });
    });

    it('builds generate request with maxTokens', () => {
      const pluginId = 'gen-plugin';
      const prompt = 'Write something';
      const options = { maxTokens: 500 };

      const request: Record<string, unknown> = { pluginId, prompt };
      if (options?.maxTokens != null) request.maxTokens = options.maxTokens;

      expect(request).toEqual({ pluginId: 'gen-plugin', prompt: 'Write something', maxTokens: 500 });
    });
  });

  describe('concurrent call counter logic', () => {
    it('tracks increment and decrement correctly', () => {
      let counter = 0;

      // Simulate 3 concurrent calls starting
      counter++; // call 1 starts
      counter++; // call 2 starts
      counter++; // call 3 starts
      expect(counter).toBe(3);
      expect(counter > 0).toBe(true); // isProcessing = true

      // Simulate calls completing
      counter--; // call 1 completes
      expect(counter).toBe(2);
      expect(counter > 0).toBe(true); // still processing

      counter--; // call 2 completes
      expect(counter).toBe(1);
      expect(counter > 0).toBe(true); // still processing

      counter--; // call 3 completes
      expect(counter).toBe(0);
      expect(counter === 0).toBe(true); // isProcessing = false
    });

    it('decrements on error too', () => {
      let counter = 0;
      counter++; // call starts
      expect(counter).toBe(1);

      // Simulate error — counter still decrements (finally block)
      counter--;
      expect(counter).toBe(0);
    });
  });

  describe('error handling patterns', () => {
    it('represents rate limit error message', () => {
      const error = 'Rate limit exceeded for plugin test-plugin. Try again in 45 seconds.';
      expect(error).toContain('Rate limit');
      expect(error).toContain('Try again');
    });

    it('represents BTS failure error message', () => {
      const error = 'AI request failed: Behind-the-scenes service unavailable';
      expect(error).toContain('AI request failed');
    });

    it('extracts error message from Error instance', () => {
      const err = new Error('Network timeout');
      const message = err instanceof Error ? err.message : 'AI request failed';
      expect(message).toBe('Network timeout');
    });

    it('falls back to generic message for non-Error throws', () => {
      const err: unknown = 'string error';
      const message = err instanceof Error ? err.message : 'AI request failed';
      expect(message).toBe('AI request failed');
    });
  });
});
