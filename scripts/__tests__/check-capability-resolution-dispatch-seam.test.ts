import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkCapabilityResolutionDispatchSeam } from '../check-capability-resolution-dispatch-seam';
import { STEPS } from '../run-validate-fast';
import { GUARD_NAMES as SOURCE_POLICY_GUARDS } from '../groups/source-policy-chokepoints';

const AGENT_TOOL = path.join('src', 'core', 'rebelCore', 'agentTool.ts');
const PROXY = path.join('src', 'main', 'services', 'localModelProxyServer.ts');

// Minimal synthetic seams. The guard scans raw text for computeSupportsReasoningReplay(...) and
// inspects the 2nd (model) argument.
function agentToolSeam(modelArg: string): string {
  return `
    const subModelForLimits = isRouteTableScope(routeScope) ? (routedModelForTransport ?? model) : model;
    const supportsReasoningReplay = computeSupportsReasoningReplay(routeProfile, ${modelArg});
  `;
}

function proxySeam(...modelArgs: string[]): string {
  return modelArgs
    .map(
      (arg, i) => `
    const modelName = profile.model || anthropicRequest.model;
    const supportsReasoningReplay${i} = computeSupportsReasoningReplay(profile, ${arg});
  `,
    )
    .join('\n');
}

describe('check-capability-resolution-dispatch-seam', () => {
  it('passes when agentTool keys on the concrete backend and proxy keys on profile-concrete sources', () => {
    const violations = checkCapabilityResolutionDispatchSeam(
      agentToolSeam('subModelForLimits'),
      proxySeam('modelName', 'profile.model || anthropicRequest.model', 'nsModelName'),
    );
    expect(violations).toEqual([]);
  });

  it('fails when agentTool keys reasoning-replay on the bare alias `model` (F3 drift)', () => {
    const violations = checkCapabilityResolutionDispatchSeam(
      agentToolSeam('model'),
      proxySeam('profile.model || anthropicRequest.model'),
    );
    expect(violations.map((v) => v.file)).toContain('agentTool');
    expect(violations.find((v) => v.file === 'agentTool')?.arg).toBe('model');
    expect(violations.map((v) => v.message).join('\n')).toContain('concrete routed backend');
  });

  it('fails when a proxy site keys replay on the bare inbound `anthropicRequest.model` alias', () => {
    const violations = checkCapabilityResolutionDispatchSeam(
      agentToolSeam('subModelForLimits'),
      proxySeam('anthropicRequest.model'),
    );
    expect(violations.map((v) => v.file)).toContain('proxy');
    expect(violations.find((v) => v.file === 'proxy')?.arg).toBe('anthropicRequest.model');
    expect(violations.map((v) => v.message).join('\n')).toContain('profile-concrete source');
  });

  it('fails when a proxy fallback chain puts the alias FIRST (`anthropicRequest.model || profile.model`)', () => {
    // Regression for the token-presence false-pass: the alias wins at runtime even though a concrete
    // token is present later in the chain. The guard keys on the winning (first `||`) operand.
    const violations = checkCapabilityResolutionDispatchSeam(
      agentToolSeam('subModelForLimits'),
      proxySeam('anthropicRequest.model || profile.model'),
    );
    expect(violations.map((v) => v.file)).toContain('proxy');
    expect(violations.find((v) => v.file === 'proxy')?.arg).toBe('anthropicRequest.model || profile.model');
    expect(violations.map((v) => v.message).join('\n')).toContain('winning operand');
  });

  it('fails when the agentTool seam has no computeSupportsReasoningReplay call (seam moved)', () => {
    const violations = checkCapabilityResolutionDispatchSeam(
      'const supportsReasoningReplay = false;',
      proxySeam('profile.model || anthropicRequest.model'),
    );
    expect(violations.map((v) => v.file)).toContain('agentTool');
    expect(violations.map((v) => v.message).join('\n')).toContain('has no computeSupportsReasoningReplay');
  });

  it('fails when the proxy seam has no computeSupportsReasoningReplay call (recompute removed)', () => {
    const violations = checkCapabilityResolutionDispatchSeam(
      agentToolSeam('subModelForLimits'),
      'const supportsReasoningReplay = false;',
    );
    expect(violations.map((v) => v.file)).toContain('proxy');
    expect(violations.map((v) => v.message).join('\n')).toContain('has no computeSupportsReasoningReplay');
  });

  it('is wired into validate:fast via the source-policy-chokepoints group', () => {
    expect(STEPS.map((step) => step.name)).toContain('validate:source-policy-chokepoints');
    expect(SOURCE_POLICY_GUARDS).toContain('check-capability-resolution-dispatch-seam');
  });

  it('passes on the real agentTool.ts + localModelProxyServer.ts sources in the repo', () => {
    const agentToolSrc = fs.readFileSync(AGENT_TOOL, 'utf8');
    const proxySrc = fs.readFileSync(PROXY, 'utf8');
    expect(checkCapabilityResolutionDispatchSeam(agentToolSrc, proxySrc)).toEqual([]);
  });
});
