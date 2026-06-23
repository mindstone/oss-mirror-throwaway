import { describe, expect, it } from 'vitest';
import type { McpAppUiMeta } from '@shared/types';
import {
  getPrimaryMcpAppCaptionDefault,
  PERMISSION_NEEDED_COPY,
} from '../mcpAppCaptionDefaults';

type CaptionMeta = Pick<McpAppUiMeta, 'structuredFallback'>;

describe('mcpAppCaptionDefaults', () => {
  it.each([
    ['email-draft', 'Draft ready. Tweak before sending.'],
    ['calendar-pick', 'Time options ready. Pick what works.'],
    ['document-outline', 'Outline ready. The blank page has lost.'],
    ['plain', 'View ready. Details below.'],
  ] as const)('returns the %s caption default', (kind, expected) => {
    expect(getPrimaryMcpAppCaptionDefault({
      structuredFallback: { kind, payload: {} },
    } as CaptionMeta)).toBe(expected);
  });

  it('returns null when structuredFallback is missing', () => {
    expect(getPrimaryMcpAppCaptionDefault()).toBeNull();
    expect(getPrimaryMcpAppCaptionDefault({})).toBeNull();
  });

  it('returns null for unknown structuredFallback kinds', () => {
    expect(getPrimaryMcpAppCaptionDefault({
      structuredFallback: { kind: 'future-kind', payload: {} },
    } as unknown as CaptionMeta)).toBeNull();
  });

  it('exports the reserved permission-needed copy without wiring it to UI', () => {
    expect(PERMISSION_NEEDED_COPY).toBe(
      'Allow this view to read this conversation so it can stay in sync.',
    );
  });
});
