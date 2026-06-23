import { describe, it, expect } from 'vitest';
import {
  DiagnosticsRecentContextRequestSchema,
  diagnosticsChannels,
} from '../diagnostics';

describe('diagnosticsChannels', () => {
  describe('request schema', () => {
    it('accepts an empty payload via .default({})', () => {
      const parsed = DiagnosticsRecentContextRequestSchema.parse(undefined);
      expect(parsed).toEqual({});
    });

    it('accepts limit + windowHours within bounds', () => {
      const parsed = DiagnosticsRecentContextRequestSchema.parse({
        limit: 5,
        windowHours: 24,
      });
      expect(parsed).toEqual({ limit: 5, windowHours: 24 });
    });

    it('rejects limit out of bounds', () => {
      expect(() => DiagnosticsRecentContextRequestSchema.parse({ limit: 0 })).toThrow();
      expect(() => DiagnosticsRecentContextRequestSchema.parse({ limit: 21 })).toThrow();
    });

    it('rejects non-integer limit', () => {
      expect(() => DiagnosticsRecentContextRequestSchema.parse({ limit: 1.5 })).toThrow();
    });

    it('rejects windowHours out of bounds', () => {
      expect(() => DiagnosticsRecentContextRequestSchema.parse({ windowHours: 0 })).toThrow();
      expect(() => DiagnosticsRecentContextRequestSchema.parse({ windowHours: 169 })).toThrow();
    });
  });

  describe('response schema (RecentDiagnosticContextSchema reused)', () => {
    const channelDef = diagnosticsChannels['diagnostics:get-recent-context'];

    it('accepts a valid empty-shape response', () => {
      expect(() =>
        channelDef.response.parse({
          windowHours: 24,
          limit: 5,
          nowMs: 1_700_000_000_000,
          counts: null,
          lastTimes: null,
          entriesByKind: {},
          totalEvents: 0,
          readerAvailable: false,
        }),
      ).not.toThrow();
    });

    it('accepts a populated response with valid kind keys', () => {
      expect(() =>
        channelDef.response.parse({
          windowHours: 24,
          limit: 5,
          nowMs: 1_700_000_000_000,
          counts: { tool_call_error: 2 },
          lastTimes: { tool_call_error: 1_700_000_000_000 },
          entriesByKind: {},
          totalEvents: 2,
          readerAvailable: true,
        }),
      ).not.toThrow();
    });

    it('rejects a response missing required fields', () => {
      expect(() => channelDef.response.parse({})).toThrow();
    });
  });

  it('channel name matches contract', () => {
    expect(diagnosticsChannels['diagnostics:get-recent-context'].channel).toBe(
      'diagnostics:get-recent-context',
    );
  });
});
