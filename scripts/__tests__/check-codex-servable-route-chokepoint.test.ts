import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkCodexServableRouteChokepoint } from '../check-codex-servable-route-chokepoint';
import { STEPS } from '../run-validate-fast';

const ROUTE_PRODUCER = path.join('src', 'core', 'rebelCore', 'providerRouting.ts');

function realSource(): string {
  return fs.readFileSync(path.join(process.cwd(), ROUTE_PRODUCER), 'utf8');
}

/**
 * Minimal synthetic producer file with BOTH dispatchable codex arms gated, used to
 * prove the mutations (gate removal) flip green→red deterministically without
 * coupling the test to the exact line shape of the live source.
 */
const SYNTHETIC_GOOD = `
function profileDecision(input: { model: string }) {
  const wireModel = input.model;
  if (!isCodexServableModel(wireModel)) {
    return codexUnsupportedModelDecision({ model: wireModel });
  }
  return makeDecision({
    provider: 'codex',
    credentialSource: 'codex-subscription',
    wireModelId: wireModel,
  });
}

function routeDecision(input: { model: string; routeScope: string }) {
  const model = input.model;
  const isCodexServableForScope = isRouteTableScope(input.routeScope) || isCodexServableModel(model);
  if (!isCodexServableForScope) {
    return codexUnsupportedModelDecision({ model });
  }
  return makeDecision({
    provider: 'codex',
    credentialSource: 'codex-subscription',
    wireModelId: model,
  });
}
`;

describe('check-codex-servable-route-chokepoint', () => {
  it('passes on the real providerRouting.ts source (both codex arms gated)', () => {
    const violations = checkCodexServableRouteChokepoint(realSource());
    expect(violations).toEqual([]);
  });

  it('passes on the synthetic two-arm-gated control', () => {
    expect(checkCodexServableRouteChokepoint(SYNTHETIC_GOOD)).toEqual([]);
  });

  it('FAILS when the active-arm (routeDecision) codex-servable gate is removed', () => {
    const mutated = SYNTHETIC_GOOD.replace(
      /function routeDecision[\s\S]*?\n}\n/,
      `
function routeDecision(input: { model: string; routeScope: string }) {
  const model = input.model;
  return makeDecision({
    provider: 'codex',
    credentialSource: 'codex-subscription',
    wireModelId: model,
  });
}
`,
    );
    expect(mutated).not.toBe(SYNTHETIC_GOOD);
    const violations = checkCodexServableRouteChokepoint(mutated);
    expect(violations.map((v) => v.kind)).toContain('ungated_producer');
    expect(violations.map((v) => v.message).join('\n')).toContain('routeDecision');
    expect(violations.map((v) => v.message).join('\n')).toContain('isCodexServableModel');
  });

  it('FAILS when the profile-arm (profileDecision) codex-servable gate is removed', () => {
    const mutated = SYNTHETIC_GOOD.replace(
      /function profileDecision[\s\S]*?\n}\n/,
      `
function profileDecision(input: { model: string }) {
  const wireModel = input.model;
  return makeDecision({
    provider: 'codex',
    credentialSource: 'codex-subscription',
    wireModelId: wireModel,
  });
}
`,
    );
    expect(mutated).not.toBe(SYNTHETIC_GOOD);
    const violations = checkCodexServableRouteChokepoint(mutated);
    expect(violations.map((v) => v.kind)).toContain('ungated_producer');
    expect(violations.map((v) => v.message).join('\n')).toContain('profileDecision');
  });

  it('FAILS (no_producers_found) when a dispatchable codex producer is removed entirely', () => {
    // Drop the profile arm's makeDecision producer → only one dispatchable codex
    // producer remains, below MIN_DISPATCHABLE_CODEX_PRODUCERS.
    const mutated = SYNTHETIC_GOOD.replace(
      /function profileDecision[\s\S]*?\n}\n/,
      `
function profileDecision(input: { model: string }) {
  const wireModel = input.model;
  if (!isCodexServableModel(wireModel)) {
    return codexUnsupportedModelDecision({ model: wireModel });
  }
  return noCredentialsDecision({ model: wireModel });
}
`,
    );
    const violations = checkCodexServableRouteChokepoint(mutated);
    expect(violations.map((v) => v.kind)).toContain('no_producers_found');
  });

  it('does NOT fire on the openrouter / anthropic dispatchable producers (no false positive)', () => {
    const otherProviders = `
function otherArms(model: string) {
  const a = makeDecision({ provider: 'openrouter', credentialSource: 'openrouter-key', wireModelId: model });
  const b = makeDecision({ provider: 'anthropic', credentialSource: 'anthropic-key', wireModelId: model });
  return [a, b];
}
` + SYNTHETIC_GOOD;
    // Still only the two codex arms are evaluated; the non-codex producers are ignored.
    expect(checkCodexServableRouteChokepoint(otherProviders)).toEqual([]);
  });

  it('is wired into validate:fast as a standalone step', () => {
    expect(STEPS.map((step) => step.name)).toContain('check-codex-servable-route-chokepoint');
  });
});
