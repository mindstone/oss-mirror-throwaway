import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderId } from '@shared/diagnostics/providerReachabilitySnapshot';
import type { ReachabilityAssessment } from '../providerReachabilitySnapshot';
import {
  MIN_EMIT_INTERVAL_MS,
  __resetReachabilityTelemetryForTest,
  evaluateAndRecordReachability,
  recordReachabilityVerdict,
} from '../providerReachabilityTelemetry';

const captureKnownCondition = vi.fn();
const recordKnownConditionLedgerOnly = vi.fn();
const addBreadcrumb = vi.fn();

vi.mock('@core/sentry/captureKnownCondition', () => ({
  captureKnownCondition: (...args: unknown[]) => captureKnownCondition(...args),
  recordKnownConditionLedgerOnly: (...args: unknown[]) => recordKnownConditionLedgerOnly(...args),
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({ addBreadcrumb }),
  setErrorReporter: vi.fn(),
}));

// Mock the snapshot module so evaluateAndRecordReachability's probe wave is observable/controllable
// (the recordReachabilityVerdict tests don't touch these). The slow refresh lets concurrent calls
// overlap so the F2 coalescing test is meaningful.
const refreshProviderReachabilityCache = vi.fn(
  () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
);
const getProviderReachabilitySnapshot = vi.fn(() => ({
  snapshotPresent: true,
  lastRefreshAt: 0,
  providers: {},
}));
const detectAllProvidersUnreachable = vi.fn(
  (): ReachabilityAssessment => ({
    verdict: 'none_unreachable',
    consideredProviders: ['anthropic'],
    unreachableProviders: [],
    errorCodes: {},
    lastRefreshAt: 0,
  }),
);
vi.mock('../providerReachabilitySnapshot', () => ({
  // No-arg forwarding: these mocks ignore call args (the production snapshot arg is irrelevant to
  // what they return), so we avoid spreading into the fixed-arity vi.fn impls.
  refreshProviderReachabilityCache: () => refreshProviderReachabilityCache(),
  getProviderReachabilitySnapshot: () => getProviderReachabilitySnapshot(),
  detectAllProvidersUnreachable: () => detectAllProvidersUnreachable(),
}));

function makeAssessment(
  verdict: ReachabilityAssessment['verdict'],
  overrides?: Partial<ReachabilityAssessment>,
): ReachabilityAssessment {
  const providers: ProviderId[] = ['anthropic', 'openai', 'google', 'openrouter', 'codex', 'rebel-cloud'];
  return {
    verdict,
    consideredProviders: providers,
    unreachableProviders: verdict === 'all_unreachable' ? providers : [],
    errorCodes:
      verdict === 'all_unreachable'
        ? {
            anthropic: 'timeout',
            openai: 'timeout',
            google: 'dns',
            openrouter: 'dns',
            codex: 'timeout',
            'rebel-cloud': 'dns',
          }
        : {},
    lastRefreshAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetReachabilityTelemetryForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordReachabilityVerdict', () => {
  it('none_unreachable → all_unreachable emits all_providers_unreachable once', () => {
    recordReachabilityVerdict(makeAssessment('none_unreachable', { consideredProviders: ['anthropic'] }));
    recordReachabilityVerdict(makeAssessment('all_unreachable'));

    expect(captureKnownCondition).toHaveBeenCalledTimes(1);
    expect(captureKnownCondition).toHaveBeenCalledWith(
      'all_providers_unreachable',
      {
        extra: {
          providerCount: 6,
          unreachableProviders: expect.any(Array),
          consideredProviders: expect.any(Array),
          errorCodes: expect.objectContaining({ anthropic: 'timeout', google: 'dns' }),
        },
      },
      expect.objectContaining({ message: 'all_providers_unreachable' }),
    );
    expect(recordKnownConditionLedgerOnly).not.toHaveBeenCalled();
  });

  it('all_unreachable → all_unreachable does not re-emit (edge semantics)', () => {
    recordReachabilityVerdict(makeAssessment('all_unreachable'));
    recordReachabilityVerdict(makeAssessment('all_unreachable'));

    expect(captureKnownCondition).toHaveBeenCalledTimes(1);
  });

  it('all_unreachable → none_unreachable emits providers_reachability_recovered', () => {
    recordReachabilityVerdict(makeAssessment('all_unreachable'));
    recordReachabilityVerdict(
      makeAssessment('none_unreachable', {
        consideredProviders: ['anthropic'],
        unreachableProviders: [],
        errorCodes: {},
      }),
    );

    expect(recordKnownConditionLedgerOnly).toHaveBeenCalledTimes(1);
    expect(recordKnownConditionLedgerOnly).toHaveBeenCalledWith('providers_reachability_recovered');
    expect(addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'provider.reachability',
        message: 'providers_reachability_recovered',
        level: 'info',
      }),
    );
  });

  it('partially_unreachable → all_unreachable emits', () => {
    recordReachabilityVerdict(
      makeAssessment('partially_unreachable', {
        unreachableProviders: ['anthropic'],
        errorCodes: { anthropic: 'timeout' },
      }),
    );
    recordReachabilityVerdict(makeAssessment('all_unreachable'));

    expect(captureKnownCondition).toHaveBeenCalledTimes(1);
  });

  it('inconclusive is a no-op and does not block a subsequent all_unreachable emit', () => {
    recordReachabilityVerdict(
      makeAssessment('inconclusive', {
        consideredProviders: [],
        unreachableProviders: [],
        errorCodes: {},
      }),
    );
    recordReachabilityVerdict(makeAssessment('all_unreachable'));

    expect(captureKnownCondition).toHaveBeenCalledTimes(1);
    expect(recordKnownConditionLedgerOnly).not.toHaveBeenCalled();
  });

  it('min-interval: second none→all edge within MIN_EMIT_INTERVAL_MS is suppressed after recovery', () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    recordReachabilityVerdict(makeAssessment('all_unreachable'));
    expect(captureKnownCondition).toHaveBeenCalledTimes(1);

    recordReachabilityVerdict(
      makeAssessment('none_unreachable', {
        consideredProviders: ['anthropic'],
        unreachableProviders: [],
        errorCodes: {},
      }),
    );
    now += 60_000;
    recordReachabilityVerdict(makeAssessment('all_unreachable'));
    expect(captureKnownCondition).toHaveBeenCalledTimes(1);

    now += MIN_EMIT_INTERVAL_MS;
    recordReachabilityVerdict(
      makeAssessment('none_unreachable', {
        consideredProviders: ['anthropic'],
        unreachableProviders: [],
        errorCodes: {},
      }),
    );
    recordReachabilityVerdict(makeAssessment('all_unreachable'));
    expect(captureKnownCondition).toHaveBeenCalledTimes(2);
  });

  it('all-providers-down shape (full-offline / DNS-all-down cohorts): emits the warning', () => {
    // Efficacy: would have fired on a fully-offline user (every probe times out) and a
    // DNS-all-down user (every connect fails). NOTE: this is the EVERY-provider-down shape.
    // FOX-3513 was a PARTIAL block (api.openai.com stayed reachable) → partially_unreachable
    // → would NOT fire here; that case needs the active-providers-only verdict follow-up (see PLAN).
    const allDownShape = makeAssessment('all_unreachable', {
      consideredProviders: ['anthropic', 'openai', 'google', 'openrouter', 'codex', 'rebel-cloud'],
      unreachableProviders: ['anthropic', 'openai', 'google', 'openrouter', 'codex', 'rebel-cloud'],
      errorCodes: {
        anthropic: 'timeout',
        openai: 'timeout',
        google: 'timeout',
        openrouter: 'timeout',
        codex: 'timeout',
        'rebel-cloud': 'dns',
      },
    });

    recordReachabilityVerdict(allDownShape);

    expect(captureKnownCondition).toHaveBeenCalledWith(
      'all_providers_unreachable',
      expect.objectContaining({
        extra: expect.objectContaining({
          providerCount: 6,
          errorCodes: expect.objectContaining({
            anthropic: 'timeout',
            'rebel-cloud': 'dns',
          }),
        }),
      }),
      expect.any(Error),
    );
  });

  it('F1: a SUSTAINED outage that began suppressed (within min-interval) still emits once the interval elapses, with no phantom recovery', () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    // Episode 1: emits.
    recordReachabilityVerdict(makeAssessment('all_unreachable'));
    expect(captureKnownCondition).toHaveBeenCalledTimes(1);
    // Brief recovery.
    recordReachabilityVerdict(makeAssessment('none_unreachable', { consideredProviders: ['anthropic'], unreachableProviders: [], errorCodes: {} }));
    expect(recordKnownConditionLedgerOnly).toHaveBeenCalledTimes(1);

    // Episode 2 begins within the min-interval → first observation is SUPPRESSED...
    now += 60_000;
    recordReachabilityVerdict(makeAssessment('all_unreachable'));
    expect(captureKnownCondition).toHaveBeenCalledTimes(1);
    // ...and STAYS all-down (sustained, no recovery between) — old "set latch to all_unreachable on
    // suppression" code would never emit again. New episode model keeps it "not yet emitted".
    now += 60_000;
    recordReachabilityVerdict(makeAssessment('all_unreachable'));
    expect(captureKnownCondition).toHaveBeenCalledTimes(1);

    // Once the interval since the last EMITTED warning elapses, the still-open episode emits.
    now = 1_000_000 + MIN_EMIT_INTERVAL_MS + 1;
    recordReachabilityVerdict(makeAssessment('all_unreachable'));
    expect(captureKnownCondition).toHaveBeenCalledTimes(2);

    // The suppressed-then-emitted episode never minted a phantom recovery: ledger count unchanged
    // from the single real recovery above.
    expect(recordKnownConditionLedgerOnly).toHaveBeenCalledTimes(1);
  });
});

describe('evaluateAndRecordReachability', () => {
  it('F2: concurrent calls during one outage collapse to a single probe wave', async () => {
    await Promise.all([
      evaluateAndRecordReachability('server_error'),
      evaluateAndRecordReachability('server_error'),
      evaluateAndRecordReachability('server_error'),
    ]);

    expect(refreshProviderReachabilityCache).toHaveBeenCalledTimes(1);
  });

  it('skips the probe wave entirely for non-reachability error kinds', async () => {
    await evaluateAndRecordReachability('rate_limit');
    await evaluateAndRecordReachability('auth');
    await evaluateAndRecordReachability('context_overflow');

    expect(refreshProviderReachabilityCache).not.toHaveBeenCalled();
  });

  it('runs the probe wave for a server_error kind', async () => {
    await evaluateAndRecordReachability('server_error');

    expect(refreshProviderReachabilityCache).toHaveBeenCalledTimes(1);
    expect(detectAllProvidersUnreachable).toHaveBeenCalledTimes(1);
  });

  it('runs the probe wave for a network kind', async () => {
    await evaluateAndRecordReachability('network');

    expect(refreshProviderReachabilityCache).toHaveBeenCalledTimes(1);
    expect(detectAllProvidersUnreachable).toHaveBeenCalledTimes(1);
  });
});
