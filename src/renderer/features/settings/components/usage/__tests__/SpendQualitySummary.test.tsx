// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageTab } from '../../tabs/UsageTab';
import {
  SpendQualitySummary,
  type HeroSavings,
  type SpendQualitySummaryProps,
  type SpendQualityWaterfall,
  type SpendOutcomeKind,
} from '../SpendQualitySummary';

// The Records click-through uses navigation; stub it so UsageTab can mount
// outside a NavigationProvider.
const navigateMock = vi.fn();
vi.mock('@renderer/hooks/useAppNavigation', () => ({
  useAppNavigation: () => ({ navigate: navigateMock }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  unmount: () => void;
}

const OUTCOME_KINDS: SpendOutcomeKind[] = [
  'success',
  'aborted',
  'quota',
  'safety_eval_rejected',
  'tool_budget',
  'failed',
  'auxiliary_success',
  'auxiliary_failed',
  'legacy_unknown',
];

function makeWaterfall(
  entries: Partial<Record<SpendOutcomeKind, { totalUsd: number; count?: number }>>,
): SpendQualityWaterfall {
  const buckets = Object.fromEntries(
    OUTCOME_KINDS.map((kind) => {
      const entry = entries[kind];
      return [
        kind,
        {
          totalUsd: entry?.totalUsd ?? 0,
          count: entry?.count ?? (entry?.totalUsd ? 1 : 0),
          lastTs: entry?.totalUsd ? 1_700_000_000_000 : 0,
        },
      ];
    }),
  ) as SpendQualityWaterfall['buckets'];

  return {
    buckets,
    total: {
      totalUsd: Object.values(entries).reduce((sum, entry) => sum + (entry?.totalUsd ?? 0), 0),
      count: Object.values(entries).reduce(
        (sum, entry) => sum + (entry?.count ?? (entry?.totalUsd ? 1 : 0)),
        0,
      ),
    },
    orphans: {
      resolutionLost: 0,
      resolutionUnmatched: 0,
    },
  };
}

const baseProps: SpendQualitySummaryProps = {
  period: 'week',
  onPeriodChange: vi.fn(),
  loading: false,
  error: false,
  totalCostUsd: 0,
  entryCount: 0,
  turnCount: 0,
  categoryTotals: {},
  waterfall: makeWaterfall({}),
  savings: null,
  byCategoryRaw: {},
  automationTypeBreakdown: [],
  totalInputTokens: 0,
  firstUse: true,
};

function render(overrides: Partial<SpendQualitySummaryProps>): React.ReactElement {
  return <SpendQualitySummary {...baseProps} {...overrides} />;
}

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function mountAsync(ui: React.ReactElement): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function subscriptionSavings(over: Partial<HeroSavings> = {}): HeroSavings {
  const covered = over.subscriptionCoveredUsd ?? 1563;
  const paid = over.actualCostUsd ?? 130;
  const free = over.freeUsd ?? 0;
  const unclassified = over.unclassifiedUsd ?? 99;
  const total = covered + paid + free + unclassified;
  return {
    subscriptionCoveredUsd: covered,
    actualCostUsd: paid,
    freeUsd: free,
    unclassifiedUsd: unclassified,
    hasSubscriptionUsage: covered > 0,
    totalValueUsd: total,
    coveragePercent: total > 0 ? Math.round((covered / total) * 100) : 0,
    subscriptionLabel: 'ChatGPT Subscription',
    mixedSubscriptions: false,
    paidProviders: [{ label: 'Anthropic (API key)', cost: paid }],
    ...over,
  };
}

describe('SpendQualitySummary', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders the witty first-use empty state without a hero number', () => {
    mounted = mount(render({ firstUse: true }));
    expect(mounted.container.textContent).toContain(
      'No usage yet. Have a conversation and the receipt will appear here. Bureaucracy, but useful.',
    );
    expect(mounted.container.textContent).not.toContain('You paid');
  });

  it('shows the "no data for this period" recovery branch when entries exist elsewhere', () => {
    mounted = mount(render({ firstUse: false, period: 'day' }));
    expect(mounted.container.textContent).toContain('Nothing here for the last 24 hours');
    // Period control stays visible so the user can recover.
    expect(mounted.container.querySelector('[data-testid="usage-period-week"]')).toBeTruthy();
  });

  it('honest hero leads with "You paid" and shows unclassified as a separate line', () => {
    mounted = mount(
      render({
        totalCostUsd: 1792,
        entryCount: 10,
        turnCount: 1240,
        savings: subscriptionSavings(),
        categoryTotals: { conversations: 1084, automations: 528, housekeeping: 190 },
        waterfall: makeWaterfall({ success: { totalUsd: 1210 } }),
      }),
    );

    const text = mounted.container.textContent ?? '';
    expect(text).toContain('You paid');
    // "You paid" is the known out-of-pocket number, NOT the total value.
    expect(mounted.container.querySelector('[data-testid="usage-hero-paid"]')?.textContent).toBe(
      '$130.00',
    );
    // Coverage framed as good news.
    expect(text).toContain('ChatGPT Subscription covered');
    // Unclassified shown separately, never folded into "You paid".
    expect(mounted.container.querySelector('[data-testid="usage-hero-unclassified"]')).toBeTruthy();
    expect(text).toContain('before we tracked costs in detail');
  });

  it('API-only hero shows a single out-of-pocket number with no coverage bar', () => {
    mounted = mount(
      render({
        totalCostUsd: 129,
        entryCount: 5,
        turnCount: 40,
        savings: subscriptionSavings({
          subscriptionCoveredUsd: 0,
          actualCostUsd: 129,
          unclassifiedUsd: 0,
          hasSubscriptionUsage: false,
          subscriptionLabel: null,
        }),
        waterfall: makeWaterfall({ success: { totalUsd: 129 } }),
      }),
    );

    const text = mounted.container.textContent ?? '';
    expect(text).toContain('You paid');
    expect(mounted.container.querySelector('[data-testid="usage-hero-paid"]')?.textContent).toBe(
      '$129.00',
    );
    expect(text).not.toContain('covered');
  });

  it('uses a generic subscription name when subscriptions are mixed', () => {
    mounted = mount(
      render({
        totalCostUsd: 1792,
        entryCount: 10,
        turnCount: 100,
        savings: subscriptionSavings({ mixedSubscriptions: true, subscriptionLabel: null }),
        waterfall: makeWaterfall({ success: { totalUsd: 1210 } }),
      }),
    );
    expect(mounted.container.textContent).toContain('Your subscription covered');
  });

  it('shows category list and spend-quality rows when populated', () => {
    mounted = mount(
      render({
        totalCostUsd: 12.34,
        entryCount: 4,
        turnCount: 4,
        savings: subscriptionSavings({
          subscriptionCoveredUsd: 8,
          actualCostUsd: 4.34,
          unclassifiedUsd: 0,
        }),
        categoryTotals: {
          conversations: 7,
          automations: 2,
          fileIntelligence: 1,
          memoryNotes: 1,
          safetyChecks: 0.25,
          housekeeping: 1.09,
        },
        waterfall: makeWaterfall({
          success: { totalUsd: 7 },
          auxiliary_success: { totalUsd: 2 },
          failed: { totalUsd: 1 },
          tool_budget: { totalUsd: 2.34 },
        }),
      }),
    );

    const text = mounted.container.textContent ?? '';
    expect(text).toContain('Conversations');
    expect(text).toContain('Automations');
    expect(text).toContain('Files & search');
    expect(text).toContain('Memory & notes');
    expect(text).toContain('Safety checks');
    expect(text).toContain('Background housekeeping');
    expect(text).toContain('Spend quality');
    expect(text).toContain('Completed work');
    expect(text).toContain('Behind-the-scenes work');
    expect(text).toContain('Hit a service/tool limit');
    // Calmer, factual unfinished-work note (no "Brutal, but honest").
    expect(text).toContain("didn't finish but were still billed");
    expect(text).not.toContain('Brutal, but honest');
  });

  it('expands the Background housekeeping row to reveal sub-categories (compaction)', () => {
    mounted = mount(
      render({
        totalCostUsd: 190,
        entryCount: 10,
        turnCount: 50,
        savings: subscriptionSavings(),
        categoryTotals: { housekeeping: 190 },
        byCategoryRaw: {
          'compaction-bts': 98,
          'title-generation': 24,
          'unknown-housekeeping': 37,
          'cache-warmup': 31,
        },
        waterfall: makeWaterfall({ auxiliary_success: { totalUsd: 190 } }),
      }),
    );

    const row = mounted.container.querySelector('[data-testid="usage-category-housekeeping"]');
    expect(row).toBeTruthy();
    expect(row?.getAttribute('aria-expanded')).toBe('false');
    click(row!);
    expect(
      mounted.container.querySelector('[data-testid="usage-subrows-housekeeping"]'),
    ).toBeTruthy();
  });

  it('only renders the legacy_unknown row when non-zero', () => {
    const populated = {
      totalCostUsd: 1,
      entryCount: 1,
      turnCount: 1,
      savings: subscriptionSavings({
        subscriptionCoveredUsd: 0,
        actualCostUsd: 1,
        unclassifiedUsd: 0,
        hasSubscriptionUsage: false,
        subscriptionLabel: null,
      }),
      categoryTotals: { conversations: 1 },
    };

    mounted = mount(render({ ...populated, waterfall: makeWaterfall({ success: { totalUsd: 1 } }) }));
    expect(mounted.container.textContent).not.toContain('Older/unclear entries');
    mounted.unmount();
    mounted = null;

    mounted = mount(
      render({ ...populated, waterfall: makeWaterfall({ legacy_unknown: { totalUsd: 1 } }) }),
    );
    expect(mounted.container.textContent).toContain('Older/unclear entries');
  });

  it('shows the error Notice copy', () => {
    mounted = mount(render({ error: true, waterfall: null }));
    expect(mounted.container.textContent).toContain(
      'Usage data could not be loaded. Your work is untouched. Try again.',
    );
  });
});

describe('UsageTab data loading', () => {
  let mounted: Mounted | null = null;
  const getCostSummary = vi.fn();
  const getCostWaterfall = vi.fn();
  const getInsights = vi.fn();
  const getDailyBreakdown = vi.fn();
  const automationsState = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T12:00:00Z'));
    getCostSummary.mockResolvedValue({
      totalCostUsd: 30,
      entryCount: 3,
      turnCount: 3,
      oldestEntry: 1_700_000_000_000,
      newestEntry: 1_700_000_100_000,
      byCategory: { conversations: 20, housekeeping: 10 },
      byCategoryRaw: { agent: 20, 'compaction-bts': 10 },
      byAutomationType: {},
      byAuthMethod: { 'codex-subscription': 25, 'api-key': 5 },
      totalInputTokens: 1000,
      totalCacheReadTokens: 500,
      totalCacheCreationTokens: 100,
    });
    getCostWaterfall.mockResolvedValue(makeWaterfall({ success: { totalUsd: 30 } }));
    getInsights.mockResolvedValue({
      topSession: null,
      topTurn: null,
      comparison: { currentPeriodCost: 30, previousPeriodCost: 20, percentChange: 50 },
      avgCostPerTurn: 10,
      avgCostPerActiveDay: 15,
      activeDayCount: 2,
      peakDay: null,
      projectedMonthCost: 100,
      projectionBasis: { effectiveDays: 7, daysSinceFirstUsage: 30, periodDays: 7 },
    });
    getDailyBreakdown.mockResolvedValue([]);
    automationsState.mockResolvedValue({ definitions: [] });

    Object.defineProperty(window, 'usageApi', {
      configurable: true,
      value: { getCostSummary, getCostWaterfall, getInsights, getDailyBreakdown },
    });
    Object.defineProperty(window, 'automationsApi', {
      configurable: true,
      value: { state: automationsState },
    });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('loads glance + detail data and switches periods (incl. 24h)', async () => {
    mounted = await mountAsync(<UsageTab />);

    expect(getCostSummary).toHaveBeenCalled();
    expect(getInsights).toHaveBeenCalled();
    expect(getDailyBreakdown).toHaveBeenCalled();

    const summaryCallsBefore = getCostSummary.mock.calls.length;
    const last24h = mounted.container.querySelector('[data-testid="usage-period-day"]');
    expect(last24h).toBeTruthy();

    click(last24h!);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(getCostSummary.mock.calls.length).toBeGreaterThan(summaryCallsBefore);
    expect(getCostWaterfall).toHaveBeenCalled();
  });

  it('degrades observably when the insights fetch fails (glance still renders, Records/Efficiency show a badge + notice)', async () => {
    getInsights.mockRejectedValueOnce(new Error('boom'));
    // daily still succeeds — independent degradation

    mounted = await mountAsync(<UsageTab />);

    // Glance hero still renders.
    expect(mounted.container.querySelector('[data-testid="usage-hero"]')).toBeTruthy();
    // Records + Efficiency are still MOUNTED (not hidden) and show the degraded state.
    expect(
      mounted.container.querySelector('[data-testid="usage-records-section"]'),
    ).toBeTruthy();
    expect(
      mounted.container.querySelector('[data-testid="usage-efficiency-section"]'),
    ).toBeTruthy();
    expect(mounted.container.textContent).toContain("Couldn't load");
  });

  it('degrades the daily table independently when only the daily fetch fails', async () => {
    getDailyBreakdown.mockRejectedValueOnce(new Error('boom'));
    // insights still succeeds — Records/Efficiency must NOT be hidden

    mounted = await mountAsync(<UsageTab />);

    expect(mounted.container.querySelector('[data-testid="usage-hero"]')).toBeTruthy();
    expect(
      mounted.container.querySelector('[data-testid="usage-daily-section"]'),
    ).toBeTruthy();
    expect(mounted.container.textContent).toContain("Couldn't load the daily breakdown");
  });

  it('fails the whole page when the glance fetch fails', async () => {
    getCostSummary.mockRejectedValue(new Error('ledger gone'));
    getCostWaterfall.mockRejectedValue(new Error('ledger gone'));

    mounted = await mountAsync(<UsageTab />);
    expect(mounted.container.textContent).toContain(
      'Usage data could not be loaded. Your work is untouched. Try again.',
    );
  });

  it('costliest single turn is click-through to its conversation when it has a session', async () => {
    getInsights.mockResolvedValue({
      topSession: null,
      topTurn: {
        turnId: 'turn-1',
        sessionId: 'sess-42',
        cost: 1.23,
        timestamp: 1_700_000_050_000,
        sessionTitle: 'Big doc analysis',
      },
      comparison: { currentPeriodCost: 30, previousPeriodCost: 20, percentChange: 50 },
      avgCostPerTurn: 10,
      avgCostPerActiveDay: 15,
      activeDayCount: 2,
      peakDay: null,
      projectedMonthCost: 100,
      projectionBasis: { effectiveDays: 7, daysSinceFirstUsage: 30, periodDays: 7 },
    });

    mounted = await mountAsync(<UsageTab />);
    const topTurn = mounted.container.querySelector<HTMLElement>(
      '[data-testid="usage-record-top-turn"]',
    );
    expect(topTurn).toBeTruthy();
    expect(topTurn?.getAttribute('role')).toBe('button');
    navigateMock.mockClear();
    topTurn?.click();
    expect(navigateMock).toHaveBeenCalledWith({ type: 'sessions', sessionId: 'sess-42' });
  });
});
