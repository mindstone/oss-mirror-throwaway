// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AutomationAdmissionBlock,
  AutomationDefinition,
  AutomationProviderReadinessSummary,
  AutomationRun,
} from '@shared/types';
import { AutomationsPanel } from '../AutomationsPanel';

const mocks = vi.hoisted(() => ({
  useAutomationsCrud: vi.fn(),
  runAutomationNow: vi.fn(),
  upsertAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
}));

vi.mock('../../hooks/useAutomationsCrud', () => ({
  useAutomationsCrud: mocks.useAutomationsCrud,
}));

vi.mock('../../hooks/useAutomationApprovals', () => ({
  useAutomationApprovals: () => ({
    approvalsByAutomation: new Map(),
    dismissApproval: vi.fn(),
    approveToolApproval: vi.fn(),
    approveMemoryApproval: vi.fn(),
  }),
  getAutomationReasonDisplayText: () => '',
}));

vi.mock('@renderer/features/settings/SettingsProvider', () => ({
  useSettings: () => ({
    draftSettings: {},
  }),
}));

vi.mock('@renderer/contexts', () => ({
  useMentionContext: () => ({
    mentionResultsForQuery: async () => [],
    ensureLibraryIndex: async () => undefined,
    getRelativeLibraryPath: () => null,
    hasWorkspace: true,
    hasConversations: true,
    coreDirectory: '/tmp',
    libraryIndex: null,
    libraryIndexLoading: false,
    libraryIndexError: null,
    refreshLibraryIndex: async () => undefined,
  }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODEX_CAUSE: AutomationAdmissionBlock = {
  source: 'provider-readiness',
  code: 'codex_disconnected',
  errorKind: 'connection-not-configured',
  headlineClass: 'auth',
  provider: 'codex',
  message: 'ChatGPT Pro is disconnected. Reconnect it in Settings, or switch to another provider.',
};

const makeSummary = (
  overrides: Partial<AutomationProviderReadinessSummary> = {},
): AutomationProviderReadinessSummary => ({
  readiness: 'ready',
  affectedAutomationCount: 0,
  affectedAutomationIds: [],
  blockedRunCount: 0,
  sinceMs: null,
  cause: null,
  ...overrides,
});

const makeDefinition = (
  overrides: Partial<AutomationDefinition> = {},
): AutomationDefinition => ({
  id: 'auto-1',
  name: 'Weekly digest',
  description: 'Summarize updates',
  filePath: 'weekly-digest.md',
  schedule: { type: 'daily', time: '09:00' } as AutomationDefinition['schedule'],
  enabled: true,
  createdAt: 1000,
  updatedAt: 1000,
  lastRunStatus: 'failure',
  lastRunAt: Date.now() - (60 * 60 * 1000),
  ...overrides,
});

const makeRun = (overrides: Partial<AutomationRun> = {}): AutomationRun => ({
  id: 'run-1',
  automationId: 'auto-1',
  startedAt: Date.now() - (60 * 60 * 1000),
  completedAt: Date.now() - (60 * 60 * 1000) + 500,
  status: 'provider_not_ready',
  trigger: 'schedule',
  error: CODEX_CAUSE.message,
  ...overrides,
});

describe('AutomationsPanel provider readiness surfacing', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.runAutomationNow.mockReset().mockResolvedValue(null);
    mocks.upsertAutomation.mockReset().mockResolvedValue(undefined);
    mocks.deleteAutomation.mockReset().mockResolvedValue(undefined);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  const renderPanel = (args: {
    summary?: AutomationProviderReadinessSummary;
    runs?: AutomationRun[];
    definitions?: AutomationDefinition[];
    onOpenProviderSettings?: (cause: AutomationAdmissionBlock | null) => void;
  } = {}) => {
    const {
      summary = makeSummary(),
      runs = [],
      definitions = [makeDefinition()],
      onOpenProviderSettings = vi.fn(),
    } = args;

    mocks.useAutomationsCrud.mockReturnValue({
      definitions,
      runs,
      quarantined: [],
      loading: false,
      error: null,
      upsertAutomation: mocks.upsertAutomation,
      deleteAutomation: mocks.deleteAutomation,
      runAutomationNow: mocks.runAutomationNow,
    });

    const props = {
      onViewSession: vi.fn(),
      onStartCreateConversation: vi.fn(),
      onStartEditConversation: vi.fn(),
      showToast: vi.fn(),
      providerReadinessSummary: summary,
      onOpenProviderSettings,
    };

    act(() => {
      root.render(<AutomationsPanel {...props} />);
    });

    return {
      rerender: (next: Partial<typeof props> & { summary?: AutomationProviderReadinessSummary }) => {
        const nextSummary = next.summary ?? summary;
        const nextProps = {
          ...props,
          ...next,
          providerReadinessSummary: nextSummary,
        };
        act(() => {
          root.render(<AutomationsPanel {...nextProps} />);
        });
      },
    };
  };

  it('shows one coalesced provider-readiness notice and hides it when readiness clears', () => {
    const onOpenProviderSettings = vi.fn();
    const summary = makeSummary({
      readiness: 'blocked',
      affectedAutomationCount: 3,
      affectedAutomationIds: ['auto-1', 'auto-2', 'auto-3'],
      blockedRunCount: 7,
      sinceMs: Date.now() - (2 * 60 * 60 * 1000),
      cause: CODEX_CAUSE,
    });

    const mounted = renderPanel({
      summary,
      definitions: [makeDefinition({ id: 'auto-1' }), makeDefinition({ id: 'auto-2' })],
      onOpenProviderSettings,
    });

    expect(container.textContent).toContain('Automations are waiting on ChatGPT Pro');
    expect(container.textContent).toContain("ChatGPT Pro is disconnected, so 3 automations can't run. Reconnect and they'll pick up on their own.");
    expect(container.querySelectorAll('[data-testid^="automations-provider-readiness-notice-"]')).toHaveLength(1);

    const reconnectCta = container.querySelector('[data-testid="automations-provider-readiness-cta-0"]') as HTMLButtonElement | null;
    expect(reconnectCta).not.toBeNull();
    act(() => {
      reconnectCta?.click();
    });
    expect(onOpenProviderSettings).toHaveBeenCalledWith(CODEX_CAUSE);

    mounted.rerender({ summary: makeSummary() });
    expect(container.querySelector('[data-testid^="automations-provider-readiness-notice-"]')).toBeNull();
  });

  it('renders waiting rows, groups consecutive same-cause runs, and shows S10 detail copy', () => {
    const now = Date.now();
    const runs: AutomationRun[] = [
      makeRun({
        id: 'run-wait-1',
        startedAt: now - (60 * 60 * 1000),
        admissionBlock: CODEX_CAUSE,
      }),
      makeRun({
        id: 'run-wait-2',
        startedAt: now - (2 * 60 * 60 * 1000),
        admissionBlock: CODEX_CAUSE,
      }),
      makeRun({
        id: 'run-failure-1',
        startedAt: now - (3 * 60 * 60 * 1000),
        status: 'failure',
        admissionBlock: undefined,
        error: 'generic failure',
      }),
    ];

    renderPanel({
      summary: makeSummary(),
      runs,
      definitions: [makeDefinition({ lastRunAt: runs[0].startedAt ?? null })],
    });

    expect(container.textContent).toContain('Waiting on ChatGPT Pro');

    const viewRunsButton = container.querySelector('[data-testid="automation-run-history-toggle-auto-1"]') as HTMLButtonElement | null;
    expect(viewRunsButton).not.toBeNull();
    act(() => {
      viewRunsButton?.click();
    });

    const waitingRows = container.querySelectorAll('[data-testid^="automation-run-history-waiting-auto-1-"]');
    expect(waitingRows).toHaveLength(1);
    expect(container.textContent).toContain('2 scheduled runs skipped since');
    expect(container.textContent).toContain('Failed');

    const waitingToggle = waitingRows[0]?.querySelector('button');
    expect(waitingToggle?.textContent).toContain('Show details');
    act(() => {
      (waitingToggle as HTMLButtonElement).click();
    });

    expect(container.textContent).toContain("Rebel didn't run this because ChatGPT Pro is disconnected. Reconnect and runs resume on schedule, or use Run now if you'd rather not wait.");
    expect(waitingRows[0]?.textContent).toContain('Run now');
  });
});
