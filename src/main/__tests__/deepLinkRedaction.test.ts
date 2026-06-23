/**
 * STAGE-1 CHARACTERIZATION TEST (red→green) for the deep-link extraction
 * (plan: docs/plans/260623_refactor-index-startup-extract/PLAN.md).
 *
 * These tests are EXPECTED TO BE RED right now: the module
 * `src/main/startup/deepLinkHandler.ts` does not exist yet — Stage 2 creates it.
 * They pin the EXACT current behavior of `redactDeepLinkUrl`
 * (src/main/index.ts ~1787-1800) so the extraction is provably behavior-preserving.
 *
 * STAGE-2 CONTRACT (the API Stage 2 MUST conform to):
 *   export function redactDeepLinkUrl(url: string): string  // pure, no side effects
 *
 * Behavior pinned from the current source:
 *   - Sensitive params replaced verbatim with the literal '[REDACTED]':
 *       code, state, token, access_token, refresh_token, payload
 *   - All other params preserved unchanged.
 *   - Returns the re-serialized URL via `new URL(url).toString()` (so it is
 *     normalized — trailing slash on bare origins, percent-encoding, etc.).
 *   - On URL parse failure returns the literal '[INVALID_URL]'.
 */
import { describe, expect, it } from 'vitest';

import { redactDeepLinkUrl } from '../startup/deepLinkHandler';

describe('redactDeepLinkUrl (characterization)', () => {
  it('redacts `code`', () => {
    expect(redactDeepLinkUrl('mindstone://slack/callback?code=abc123')).toBe(
      'mindstone://slack/callback?code=%5BREDACTED%5D',
    );
  });

  it('redacts `state`', () => {
    expect(redactDeepLinkUrl('mindstone://slack/callback?state=xyz')).toBe(
      'mindstone://slack/callback?state=%5BREDACTED%5D',
    );
  });

  it('redacts `token`', () => {
    expect(redactDeepLinkUrl('mindstone://x/callback?token=secret')).toBe(
      'mindstone://x/callback?token=%5BREDACTED%5D',
    );
  });

  it('redacts `access_token`', () => {
    expect(redactDeepLinkUrl('mindstone://x/callback?access_token=at')).toBe(
      'mindstone://x/callback?access_token=%5BREDACTED%5D',
    );
  });

  it('redacts `refresh_token`', () => {
    expect(redactDeepLinkUrl('mindstone://x/callback?refresh_token=rt')).toBe(
      'mindstone://x/callback?refresh_token=%5BREDACTED%5D',
    );
  });

  it('redacts `payload`', () => {
    expect(redactDeepLinkUrl('mindstone://x/callback?payload=blob')).toBe(
      'mindstone://x/callback?payload=%5BREDACTED%5D',
    );
  });

  it('preserves non-sensitive params unchanged', () => {
    expect(redactDeepLinkUrl('mindstone://subscription/callback?status=success&session_id=sess_1')).toBe(
      'mindstone://subscription/callback?status=success&session_id=sess_1',
    );
  });

  it('redacts sensitive params while preserving non-sensitive ones in a multi-param URL', () => {
    expect(
      redactDeepLinkUrl('mindstone://slack/callback?code=abc&state=xyz&team=acme&status=ok'),
    ).toBe('mindstone://slack/callback?code=%5BREDACTED%5D&state=%5BREDACTED%5D&team=acme&status=ok');
  });

  it('returns [INVALID_URL] for an unparseable URL', () => {
    expect(redactDeepLinkUrl('not a url')).toBe('[INVALID_URL]');
  });

  it('leaves a URL with no params unchanged (normalized)', () => {
    // new URL('mindstone://slack/callback').toString() preserves it as-is.
    expect(redactDeepLinkUrl('mindstone://slack/callback')).toBe('mindstone://slack/callback');
  });
});
