import { describe, expect, it } from 'vitest';
import { extractPairSessionIdFromToolDetail } from '../toolDetailParsing';

describe('extractPairSessionIdFromToolDetail', () => {
  it('extracts the canonical rebel_bridge_prepare_install installSessionAlias from nested tool detail JSON', () => {
    const pairSessionId = 'install_alias_123';
    const detail = JSON.stringify(
      {
        ok: true,
        reason: 'ok',
        retryable: false,
        data: {
          installSessionAlias: pairSessionId,
          pairSessionId,
        },
      },
      null,
      2,
    );

    expect(extractPairSessionIdFromToolDetail(detail)).toBe(pairSessionId);
  });
});
