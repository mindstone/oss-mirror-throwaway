import { describe, expectTypeOf, it } from 'vitest';
import { brandRouteWireModel } from '@shared/utils/wireModelId';
import { ProviderRouter } from '../providerRouting';
import { DISPATCHABLE_TRANSPORT_BY_PROVIDER_AND_DIALECT } from '../providerRouteDecision';
import type {
  DispatchableRouteDecision,
  ProviderModelDialect,
  ProviderRouteDecision,
  TerminalRouteDecision,
} from '../providerRouteDecision';

function makeDecision(): DispatchableRouteDecision {
  return {
    kind: 'dispatchable',
    provider: 'anthropic',
    transport: 'anthropic-direct',
    dispatchPath: 'direct-provider',
    modelDialect: 'anthropic-native',
    role: 'execution',
    routeScope: 'normal-turn',
    canonicalModelId: 'claude-sonnet-4-6',
    wireModelId: brandRouteWireModel('claude-sonnet-4-6'),
    profileId: null,
    resolvedFrom: 'settings',
    codexConnectivity: 'unknown',
    fallbackHint: null,
    credentialSource: 'anthropic-api-key',
    invalidReason: 'none',
  };
}

function noCredentialsDecision(): TerminalRouteDecision {
  return {
    kind: 'terminal',
    provider: 'anthropic',
    transport: 'no-credentials',
    dispatchPath: 'none',
    modelDialect: 'anthropic-native',
    role: 'execution',
    routeScope: 'normal-turn',
    canonicalModelId: 'claude-sonnet-4-6',
    wireModelId: brandRouteWireModel('claude-sonnet-4-6'),
    profileId: null,
    resolvedFrom: 'settings',
    codexConnectivity: 'unknown',
    fallbackHint: null,
    credentialSource: 'missing-anthropic',
    invalidReason: 'missing-anthropic-credentials',
  };
}

describe('providerRouteDecision compile-time narrowing matrix', () => {
  it('C1 dispatchable dispatchPath excludes "none"', () => {
    expectTypeOf<'none'>().not.toMatchTypeOf<DispatchableRouteDecision['dispatchPath']>();

    // @ts-expect-error dispatchable decisions cannot use dispatchPath "none".
    const badDispatchPath: DispatchableRouteDecision = { ...makeDecision(), dispatchPath: 'none' };
    void badDispatchPath;
  });

  it('C2 terminal dispatchPath is exactly "none"', () => {
    expectTypeOf<TerminalRouteDecision['dispatchPath']>().toEqualTypeOf<'none'>();
  });

  it('C3 dispatchable transport excludes terminal transports', () => {
    expectTypeOf<'no-credentials'>().not.toMatchTypeOf<DispatchableRouteDecision['transport']>();
    expectTypeOf<'fail-closed-codex-disconnected'>().not.toMatchTypeOf<DispatchableRouteDecision['transport']>();

    // @ts-expect-error dispatchable decisions cannot use terminal transports.
    const badTransport: DispatchableRouteDecision = { ...makeDecision(), transport: 'no-credentials' };
    void badTransport;
  });

  it('C4 terminal transport is the terminal transport union', () => {
    expectTypeOf<TerminalRouteDecision['transport']>().toEqualTypeOf<
      'no-credentials' | 'fail-closed-codex-disconnected'
    >();
  });

  it('C5 decision.kind narrow leaves dispatchable arm in residual branch', () => {
    const decision: ProviderRouteDecision = Math.random() > 0.5 ? makeDecision() : noCredentialsDecision();
    if (decision.kind === 'terminal') return;
    expectTypeOf(decision).toEqualTypeOf<DispatchableRouteDecision>();
  });

  it('C5b dispatchable decisions are structurally incompatible with dispatchPath "none"', () => {
    expectTypeOf<DispatchableRouteDecision>().not.toMatchTypeOf<{ dispatchPath: 'none' }>();

    // @ts-expect-error dispatchable arm cannot satisfy { dispatchPath: 'none' }.
    const badDispatchableArm: { dispatchPath: 'none' } = makeDecision() as DispatchableRouteDecision;
    void badDispatchableArm;
  });

  it('C6 makeDecision return type is dispatchable', () => {
    expectTypeOf<ReturnType<typeof makeDecision>>().toEqualTypeOf<DispatchableRouteDecision>();
  });

  it('C7 noCredentialsDecision return type is terminal', () => {
    expectTypeOf<ReturnType<typeof noCredentialsDecision>>().toEqualTypeOf<TerminalRouteDecision>();
  });

  it('C8 ProviderRouter.forSubagent returns union ProviderRouteDecision', () => {
    expectTypeOf<ReturnType<typeof ProviderRouter.forSubagent>>().toEqualTypeOf<ProviderRouteDecision>();
  });

  it('C9 dispatchable invalidReason is exactly "none"', () => {
    expectTypeOf<DispatchableRouteDecision['invalidReason']>().toEqualTypeOf<'none'>();
  });

  it('C10 terminal invalidReason excludes "none"', () => {
    expectTypeOf<'none'>().not.toMatchTypeOf<TerminalRouteDecision['invalidReason']>();

    // @ts-expect-error terminal decisions cannot use invalidReason "none".
    const badInvalidReason: TerminalRouteDecision = { ...noCredentialsDecision(), invalidReason: 'none' };
    void badInvalidReason;
  });

  it('C11 transport table rejects illegal provider/dialect cells', () => {
    const badTransportTable = {
      anthropic: { 'anthropic-native': 'anthropic-direct' },
      openrouter: {
        'anthropic-native': 'openrouter-proxy',
        'openrouter-prefixed': 'openrouter-proxy',
        'openai-compatible': 'openrouter-proxy',
      },
      codex: {
        // @ts-expect-error codex anthropic-native dispatches anthropic-direct, not codex-proxy.
        'anthropic-native': 'codex-proxy',
        'openai-compatible': 'codex-proxy',
      },
      local: { 'local-openai-compatible': 'local-openai-compatible-http' },
    } as const satisfies {
      anthropic: { 'anthropic-native': 'anthropic-direct' };
      openrouter: {
        'anthropic-native': 'openrouter-proxy';
        'openrouter-prefixed': 'openrouter-proxy';
        'openai-compatible': 'openrouter-proxy';
      };
      codex: { 'anthropic-native': 'anthropic-direct'; 'openai-compatible': 'codex-proxy' };
      local: { 'local-openai-compatible': 'local-openai-compatible-http' };
    };
    void badTransportTable;
  });

  it('C12 transport table requires dialect narrowing before provider-row lookup', () => {
    const dialect: ProviderModelDialect = Math.random() > 0.5 ? 'openai-compatible' : 'profile-ref';

    // @ts-expect-error provider sub-records must be indexed only after dialect narrowing.
    const transport = DISPATCHABLE_TRANSPORT_BY_PROVIDER_AND_DIALECT.codex[dialect];
    void transport;
  });

  it('C13 wireModelId requires route-layer branding', () => {
    const plainModel: string = 'claude-sonnet-4-6';
    const brandedModel = brandRouteWireModel(plainModel);
    expectTypeOf(brandedModel).toMatchTypeOf<DispatchableRouteDecision['wireModelId']>();
    expectTypeOf<DispatchableRouteDecision['wireModelId']>().toMatchTypeOf<string>();
    expectTypeOf<string>().not.toMatchTypeOf<DispatchableRouteDecision['wireModelId']>();

    // @ts-expect-error plain strings cannot be assigned to route-plan wireModelId.
    const badPlainString: DispatchableRouteDecision = { ...makeDecision(), wireModelId: plainModel };
    void badPlainString;

    // @ts-expect-error stored/prefixed literals cannot be assigned without explicit branding.
    const badPrefixedLiteral: DispatchableRouteDecision = { ...makeDecision(), wireModelId: 'model:claude-sonnet-4-6' };
    void badPrefixedLiteral;

    const goodBranded: DispatchableRouteDecision = { ...makeDecision(), wireModelId: brandedModel };
    void goodBranded;
  });
});
