/**
 * Proxy Auth Contract — sentinel constant export tests.
 *
 * The sentinel literal must remain stable: any drift here would silently
 * break the producer/consumer contract between `clientFactory.ts` (sets
 * `apiKey: PROXY_HANDLES_AUTH_SENTINEL`) and the local proxy's auth
 * injection helpers (strip-then-replace).
 *
 * See: `src/core/rebelCore/proxyAuthContract.ts`,
 *      `docs/plans/260430_eval_harness_recovery_and_anthropic_auth_fix.md` Stage 2.
 */

import { describe, it, expect } from 'vitest';
import { PROXY_HANDLES_AUTH_SENTINEL, type ProxyHandlesAuthSentinel } from '../proxyAuthContract';

describe('PROXY_HANDLES_AUTH_SENTINEL', () => {
  it('has the expected runtime value', () => {
    expect(PROXY_HANDLES_AUTH_SENTINEL).toBe('proxy-handles-auth');
  });

  it('has a narrow string-literal type (compile-time check)', () => {
    // If the type ever widens to plain `string`, this assignment fails to compile.
    const _typeCheck: 'proxy-handles-auth' = PROXY_HANDLES_AUTH_SENTINEL;
    void _typeCheck;
    // The type alias must export the same literal.
    const _aliasCheck: ProxyHandlesAuthSentinel = 'proxy-handles-auth';
    void _aliasCheck;
  });

  it('cannot be confused with a real Anthropic key prefix', () => {
    // Defensive: if anyone ever proposes 'sk-ant-*' as a sentinel, this fails.
    expect(PROXY_HANDLES_AUTH_SENTINEL.startsWith('sk-')).toBe(false);
    expect(PROXY_HANDLES_AUTH_SENTINEL.length).toBeGreaterThan(0);
  });
});
