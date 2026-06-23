import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  RETRY_STACKING_EXEMPT,
  checkProviderProxyRetryStacking,
} from '../check-provider-proxy-retry-stacking';
import { STEPS } from '../run-validate-fast';

const CLIENT_FACTORY = path.join('src', 'core', 'rebelCore', 'clientFactory.ts');

/**
 * Minimal synthetic clientFactory PRECEDENCE-1 proxy block. `decisions` is the body of the
 * AnthropicClient construction (the part that may carry `maxRetries: 0`). Discriminators are
 * declared by the same `const is<Name>Proxy = proxyConfig.defaultHeaders?...` convention the guard
 * keys on.
 */
function proxyBlock(opts: {
  discriminators: readonly string[];
  decisions: string;
}): string {
  const decls = opts.discriminators
    .map((name) => `    const ${name} = proxyConfig.defaultHeaders?.['x-${name}-turn'] === 'true';`)
    .join('\n');
  return `
  if (proxyConfig?.baseURL) {
${decls}
    return new AnthropicClient({
      ...auth,
      baseURL: proxyConfig.baseURL,
${opts.decisions}
    });
  }
`;
}

describe('check-provider-proxy-retry-stacking', () => {
  it('passes on the real clientFactory.ts source in the repo', () => {
    const src = fs.readFileSync(CLIENT_FACTORY, 'utf8');
    expect(checkProviderProxyRetryStacking(src)).toEqual([]);
  });

  it('passes a synthetic proxy that delegates retries via `maxRetries: 0`', () => {
    const src = proxyBlock({
      discriminators: ['isCodexProxy'],
      decisions: '      ...(isCodexProxy ? { maxRetries: 0 } : {}),',
    });
    expect(checkProviderProxyRetryStacking(src, {})).toEqual([]);
  });

  it('passes a synthetic proxy that is documented-exempt (intentionally stacks)', () => {
    const src = proxyBlock({
      discriminators: ['isOpenRouterProxy'],
      decisions: '      enableContextManagement: true,',
    });
    expect(
      checkProviderProxyRetryStacking(src, { isOpenRouterProxy: 'measure-first, see PM 260619 Rec 2' }),
    ).toEqual([]);
  });

  it('FAILS a synthetic NEW proxy that stacks (no maxRetries:0, no exemption)', () => {
    // The core by-construction guarantee: a future provider proxy added without the maxRetries
    // decision silently inherits the SDK default and stacks over runWithRetry. This must fail CI.
    const src = proxyBlock({
      discriminators: ['isNewVendorProxy'],
      decisions: '      enableContextManagement: true,',
    });
    const violations = checkProviderProxyRetryStacking(src, {});
    expect(violations.map((v) => v.discriminator)).toContain('isNewVendorProxy');
    expect(violations.map((v) => v.message).join('\n')).toContain('SILENTLY INHERIT the SDK');
  });

  it('FAILS when an EXISTING decided proxy gains a NEW sibling that stacks', () => {
    // Codex delegates (maxRetries:0); the newly-added vendor proxy does not and is not exempt.
    const src = proxyBlock({
      discriminators: ['isCodexProxy', 'isNewVendorProxy'],
      decisions: '      ...(isCodexProxy ? { maxRetries: 0 } : {}),',
    });
    const violations = checkProviderProxyRetryStacking(src, {});
    expect(violations.map((v) => v.discriminator)).toEqual(['isNewVendorProxy']);
  });

  it('FAILS a new proxy named in an UNRELATED sibling spread before Codex maxRetries:0 (GPT-5.5 F1)', () => {
    // The precision regression: `isNewVendorProxy` appears in a sibling spread (`...(isNewVendorProxy
    // ? { provider } : {})`) within the SAME constructor, BEFORE Codex's `...(isCodexProxy ?
    // { maxRetries: 0 } : {})`. It does NOT guard the maxRetries literal, so it must NOT be counted as
    // decided — a statement-window scan would have falsely passed it; the guard-expression extractor
    // keys only on the condition that directly applies `{ maxRetries: 0 }`.
    const src = proxyBlock({
      discriminators: ['isCodexProxy', 'isNewVendorProxy'],
      decisions:
        "      ...(isNewVendorProxy ? { provider: 'NewVendor' } : {}),\n" +
        '      ...(isCodexProxy ? { maxRetries: 0 } : {}),',
    });
    const violations = checkProviderProxyRetryStacking(src, {});
    expect(violations.map((v) => v.discriminator)).toEqual(['isNewVendorProxy']);
    expect(violations.map((v) => v.message).join('\n')).toContain('SILENTLY INHERIT the SDK');
  });

  it('passes a multi-condition guard that decides BOTH discriminators (`(isCodexProxy || isFooProxy)`)', () => {
    const src = proxyBlock({
      discriminators: ['isCodexProxy', 'isFooProxy'],
      decisions: '      ...((isCodexProxy || isFooProxy) ? { maxRetries: 0 } : {}),',
    });
    expect(checkProviderProxyRetryStacking(src, {})).toEqual([]);
  });

  it('passes the hoisted-const decision form (`const extra = isX ? { maxRetries: 0 } : {}`)', () => {
    // A natural refactor: hoist the conditional retry-config to a local, then spread it. The condition
    // is still directly to the left of the `{ maxRetries: 0 }` object, so the discriminator is decided.
    const src = `
  if (proxyConfig?.baseURL) {
    const isHoistProxy = proxyConfig.defaultHeaders?.['x-hoist-turn'] === 'true';
    const retryOpt = isHoistProxy ? { maxRetries: 0 } : {};
    return new AnthropicClient({ ...auth, ...retryOpt });
  }
`;
    expect(checkProviderProxyRetryStacking(src, {})).toEqual([]);
  });

  it('FAILS a proxy that is BOTH maxRetries:0 AND exempt (contradictory)', () => {
    const src = proxyBlock({
      discriminators: ['isCodexProxy'],
      decisions: '      ...(isCodexProxy ? { maxRetries: 0 } : {}),',
    });
    const violations = checkProviderProxyRetryStacking(src, { isCodexProxy: 'contradictory' });
    expect(violations.map((v) => v.discriminator)).toContain('isCodexProxy');
    expect(violations.map((v) => v.message).join('\n')).toContain('contradictory');
  });

  it('FAILS an exemption keyed to a discriminator that no longer exists (stale)', () => {
    const src = proxyBlock({
      discriminators: ['isCodexProxy'],
      decisions: '      ...(isCodexProxy ? { maxRetries: 0 } : {}),',
    });
    const violations = checkProviderProxyRetryStacking(src, { isGoneProxy: 'left behind' });
    expect(violations.map((v) => v.discriminator)).toContain('isGoneProxy');
    expect(violations.map((v) => v.message).join('\n')).toContain('stale exemption');
  });

  it('FAILS (synthetic violation) when no proxy discriminator is found (convention moved)', () => {
    const violations = checkProviderProxyRetryStacking('const x = 1;', {});
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('found no provider-proxy discriminator');
  });

  it('ignores a comment that mentions a fake discriminator (comments stripped)', () => {
    const src =
      `// const isFakeProxy = proxyConfig.defaultHeaders?.['x-fake'];\n` +
      proxyBlock({
        discriminators: ['isCodexProxy'],
        decisions: '      ...(isCodexProxy ? { maxRetries: 0 } : {}),',
      });
    // isFakeProxy is only in a comment → must NOT be treated as a real, undecided discriminator.
    expect(checkProviderProxyRetryStacking(src, {})).toEqual([]);
  });

  it('a `maxRetries: 0` guarded by a multi-condition expression decides every named discriminator', () => {
    const src = proxyBlock({
      discriminators: ['isCodexProxy', 'isFooProxy'],
      decisions: '      ...((isCodexProxy || isFooProxy) ? { maxRetries: 0 } : {}),',
    });
    expect(checkProviderProxyRetryStacking(src, {})).toEqual([]);
  });

  it('is wired into validate:fast as a standalone step', () => {
    expect(STEPS.map((step) => step.name)).toContain('validate:provider-proxy-retry-stacking');
  });

  it('the real OpenRouter / route-table exemptions are present and non-empty', () => {
    expect(RETRY_STACKING_EXEMPT.isOpenRouterProxy?.trim().length).toBeGreaterThan(0);
    expect(RETRY_STACKING_EXEMPT.isRouteTableProxy?.trim().length).toBeGreaterThan(0);
  });
});
