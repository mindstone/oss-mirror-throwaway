import { describe, expect, it } from 'vitest';
import { derivePolicy } from '../turnPolicy';
import { AUTOMATION_HARD_CEILING_MS } from '@core/services/turnPipeline/watchdogConstants';

describe('TurnPolicy override surface', () => {
  it('caller-supplied { semanticContext: "sync", lane: "foreground" } overrides automation defaults', () => {
    const effectivePolicy = derivePolicy('automation', {
      semanticContext: 'sync',
      lane: 'foreground',
    });

    expect(effectivePolicy.lane).toBe('foreground');
    expect(effectivePolicy.semanticContext).toBe('sync');
    expect(effectivePolicy.watchdogHardCeilingMs).toBe(AUTOMATION_HARD_CEILING_MS);
    expect(effectivePolicy.origin).toBe('automation');
  });
});
