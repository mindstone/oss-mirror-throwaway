// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { TodayItem } from '../../types';

const { mockUseSessionStore, useTodayStreamMock } = vi.hoisted(() => {
  const mockedUseSessionStore = Object.assign(
    vi.fn((selector?: (state: { sessionSummaries: unknown[] }) => unknown) => {
      const state = { sessionSummaries: [] };
      return selector ? selector(state) : state;
    }),
    { getState: () => ({ sessionSummaries: [] }) },
  );

  return {
    mockUseSessionStore: mockedUseSessionStore,
    useTodayStreamMock: vi.fn(),
  };
});

vi.mock('../TodaySection.module.css', () => ({
  default: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));

vi.mock('lucide-react', () => {
  const Icon = (props: Record<string, unknown>) => React.createElement('svg', props);
  return {
    Calendar: Icon,
    Inbox: Icon,
    Zap: Icon,
    Users: Icon,
    ChevronRight: Icon,
    Plug: Icon,
    MessageCircle: Icon,
    X: Icon,
    CheckCircle2: Icon,
    Archive: Icon,
    Trash2: Icon,
    Info: Icon,
  };
});

vi.mock('@renderer/components/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement('button', props, children),
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? React.createElement('div', { role: 'dialog' }, children) : null,
  DialogBody: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  DialogContent: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) => React.createElement('p', null, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) => React.createElement('footer', null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) => React.createElement('header', null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) => React.createElement('h2', null, children),
  IconTile: ({ icon: Icon, label }: { icon?: React.ComponentType<Record<string, unknown>>; label?: string }) =>
    React.createElement('span', { 'aria-label': label }, Icon ? React.createElement(Icon, {}) : null),
  InlineToggle: ({ checked, onChange, label }: { checked?: boolean; onChange?: (checked: boolean) => void; label?: string }) =>
    React.createElement(
      'label',
      null,
      React.createElement('input', {
        type: 'checkbox',
        checked: Boolean(checked),
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange?.(event.currentTarget.checked),
      }),
      label,
    ),
  SectionHeader: ({ title, subtitle }: { title: string; subtitle?: string }) =>
    React.createElement('header', null, React.createElement('h2', null, title), subtitle ? React.createElement('p', null, subtitle) : null),
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  useToast: () => ({
    showToast: vi.fn(() => 'toast-id'),
    dismissToast: vi.fn(),
  }),
}));

vi.mock('../../../agent-session/store/sessionStore', () => ({
  useSessionStore: mockUseSessionStore,
}));

vi.mock('@renderer/src/tracking', () => ({
  tracking: {
    homepage: new Proxy({}, { get: () => vi.fn() }),
  },
}));

vi.mock('../../hooks/useTodayStream', () => ({
  useTodayStream: (...args: unknown[]) => useTodayStreamMock(...args),
  markMeetingPrepped: vi.fn(),
}));

vi.mock('../../utils/meetingFormatters', () => ({
  getTimeUntilMeeting: vi.fn(() => 'Soon'),
  formatMeetingTime: vi.fn(() => '10:00'),
  isMeetingSoon: vi.fn(() => true),
}));

vi.mock('@renderer/features/composer/hooks/useTranscriptionMic', () => ({
  useTranscriptionMic: () => ({
    isRecording: false,
    isProcessing: false,
    toggleRecording: vi.fn(),
    stopAndSend: vi.fn(),
    audioLevel: 0,
  }),
}));

vi.mock('../../../inbox/components/VoiceMicButton', () => ({
  VoiceMicButton: (props: Record<string, unknown>) => React.createElement('button', props),
}));

vi.mock('@renderer/contexts/AppContext', () => ({
  useAppContext: () => ({
    showToast: vi.fn(),
  }),
}));

vi.mock('../FocusDiscoveryCard', () => ({
  FocusDiscoveryCard: ({ meetingCount }: { meetingCount: number }) =>
    React.createElement('div', { 'data-testid': 'today-card' }, `Focus nudge (${meetingCount})`),
  getFocusNudgeDismissCount: () => 0,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = require('react-dom/client');
const { act: reactAct } = require('react');

import { TodaySection } from '../TodaySection';

function makeTodayItem(id: string, title: string, type: TodayItem['type'] = 'inbox'): TodayItem {
  return {
    id,
    type,
    title,
    ctaLabel: 'Review',
    ctaAction: 'navigate',
    ctaPath: 'rebel://conversation/test',
    subtitle: 'Context',
    timestamp: Date.now(),
  };
}

function renderTodaySection(overrides: Partial<React.ComponentProps<typeof TodaySection>> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  const props = {
    userState: { kind: 'established-daily' },
    onStartMeetingPrep: () => 'session-1',
    onOpenFile: vi.fn(),
    onOpenSession: vi.fn(),
    onNavigateToInbox: vi.fn(),
    onNavigateToTeam: vi.fn(),
    connectedConnectorCount: 2,
    userAddedConnectorCount: 0,
    onNavigateToConnectors: vi.fn(),
    onboardingActivationIncomplete: true,
    hasAvailableOnboardingCoachSession: false,
    onStartOnboardingIntro: vi.fn(),
    meetingCache: {
      meetings: [
        {
          id: 'meeting-1',
          calendarEventId: 'event-1',
          calendarSource: 'google',
          title: 'Important meeting',
          startTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          participants: ['A', 'B'],
          participantEmails: ['[Mindstone-email]', '[external-email]'],
        },
      ],
      isLoading: false,
      isStale: false,
      syncWarnings: [],
      populatedAt: Date.now(),
      refresh: vi.fn(async () => undefined),
    },
    inboxResult: {
      items: [],
      isLoading: false,
    },
    enabled: true,
    focusEnabled: false,
    onEnableFocus: vi.fn(async () => undefined),
    ...overrides,
  } satisfies React.ComponentProps<typeof TodaySection>;

  reactAct(() => {
    root.render(
      React.createElement(TodaySection, props),
    );
  });

  return {
    container,
    root,
    rerender(nextOverrides: Partial<React.ComponentProps<typeof TodaySection>> = {}) {
      reactAct(() => {
        root.render(React.createElement(TodaySection, { ...props, ...nextOverrides }));
      });
    },
  };
}

describe('TodaySection', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('caps the rendered Today section at five cards including structural cards', () => {
    useTodayStreamMock.mockReturnValue({
      items: [
        makeTodayItem('urgent-1', 'Urgent 1'),
        makeTodayItem('urgent-2', 'Urgent 2'),
        makeTodayItem('urgent-3', 'Urgent 3'),
        makeTodayItem('urgent-4', 'Urgent 4'),
      ],
      suggestions: [
        makeTodayItem('suggestion-1', 'Suggestion 1'),
      ],
      totalCount: 7,
      isLoading: false,
      isEmpty: false,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    const { container } = renderTodaySection();

    expect(container.querySelectorAll('[data-testid="today-card"]')).toHaveLength(5);
    expect(container.textContent).toContain('Tell Rebel what matters');
    expect(container.textContent).toContain('Connect your tools');
    expect(container.textContent).not.toContain('Focus nudge (1)');

    expect(container.textContent).toContain('Urgent 1');
    expect(container.textContent).toContain('Urgent 2');
    expect(container.textContent).toContain('Urgent 3');
    expect(container.textContent).not.toContain('Urgent 4');
    expect(container.textContent).not.toContain('Suggestion 1');
    expect(container.textContent).toContain('View all actions');
  });

  it('keeps onboarding and connector guidance visible when real Today items arrive', () => {
    useTodayStreamMock.mockReturnValue({
      items: [
        makeTodayItem('urgent-1', 'Customer renewal prep'),
        makeTodayItem('urgent-2', 'Follow up on launch notes'),
      ],
      suggestions: [],
      totalCount: 2,
      isLoading: false,
      isEmpty: false,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    const { container } = renderTodaySection({
      connectedConnectorCount: 2,
      userAddedConnectorCount: 2,
      onboardingActivationIncomplete: true,
      focusEnabled: true,
    });
    const cards = [...container.querySelectorAll('[data-testid="today-card"]')];

    expect(cards.map((card) => card.textContent).slice(0, 2)).toEqual([
      expect.stringContaining('Start here'),
      expect.stringContaining('Add at least three connectors'),
    ]);
    expect(container.textContent).toContain('Customer renewal prep');
    expect(container.textContent).toContain('Follow up on launch notes');
    expect(container.textContent).not.toContain('Try a quick task');
    expect(container.textContent).not.toContain('Prep your next meeting');
  });

  it('orders connectors before onboarding when the user has no connectors', () => {
    useTodayStreamMock.mockReturnValue({
      items: [],
      suggestions: [],
      totalCount: 0,
      isLoading: false,
      isEmpty: false,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    const { container } = renderTodaySection({
      connectedConnectorCount: 0,
      userAddedConnectorCount: 0,
      meetingCache: {
        meetings: [],
        isLoading: false,
        isStale: false,
        syncWarnings: [],
        populatedAt: Date.now(),
        refresh: vi.fn(async () => undefined),
      },
      focusEnabled: true,
    });
    const cards = [...container.querySelectorAll('[data-testid="today-card"]')];

    expect(cards.map((card) => card.textContent).slice(0, 2)).toEqual([
      expect.stringContaining('Connect your tools'),
      expect.stringContaining('Tell Rebel what matters'),
    ]);
    expect(cards.map((card) => card.textContent)).toContainEqual(expect.stringContaining('Draft a quick message'));
    expect(cards.map((card) => card.textContent)).not.toContainEqual(expect.stringContaining('Check your action list'));
    expect(container.textContent).not.toContain('Your personalised cards will appear here soon.');
    expect(container.querySelector('[data-testid="today-card-skeleton"]')).toBeFalsy();
  });

  it('orders onboarding before connector baseline guidance when fewer than three connectors exist', () => {
    useTodayStreamMock.mockReturnValue({
      items: [],
      suggestions: [],
      totalCount: 0,
      isLoading: false,
      isEmpty: false,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    const { container } = renderTodaySection({
      connectedConnectorCount: 2,
      userAddedConnectorCount: 2,
      meetingCache: {
        meetings: [
          {
            id: 'meeting-2',
            calendarEventId: 'event-2',
            calendarSource: 'google',
            title: 'Another meeting',
            startTime: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
            endTime: new Date(Date.now() + 120 * 60 * 1000).toISOString(),
            participants: ['A', 'B'],
            participantEmails: ['[Mindstone-email]', '[external-email]'],
          },
        ],
        isLoading: false,
        isStale: false,
        syncWarnings: [],
        populatedAt: Date.now(),
        refresh: vi.fn(async () => undefined),
      },
      focusEnabled: true,
    });
    const cards = [...container.querySelectorAll('[data-testid="today-card"]')];

    expect(cards.map((card) => card.textContent).slice(0, 3)).toEqual([
      expect.stringContaining('Start here'),
      expect.stringContaining('Add at least three connectors'),
      expect.stringContaining('Prep your next meeting'),
    ]);
    expect(container.textContent).toContain('People get better results when Rebel can compare signals');
    expect(container.textContent).not.toContain('Your personalised cards will appear here soon.');
    expect(container.querySelector('[data-testid="today-card-skeleton"]')).toBeFalsy();
    expect(container.querySelectorAll('[data-testid="today-card"]')).toHaveLength(3);
  });

  it('switches connector guidance to enrichment copy once the baseline is reached', () => {
    useTodayStreamMock.mockReturnValue({
      items: [],
      suggestions: [],
      totalCount: 0,
      isLoading: false,
      isEmpty: false,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    const { container } = renderTodaySection({
      connectedConnectorCount: 3,
      userAddedConnectorCount: 3,
      meetingCache: {
        meetings: [],
        isLoading: false,
        isStale: false,
        syncWarnings: [],
        populatedAt: Date.now(),
        refresh: vi.fn(async () => undefined),
      },
      focusEnabled: true,
    });

    expect(container.textContent).toContain('Add more connectors');
    expect(container.textContent).toContain('You have the basics. More connectors give Rebel a wider view');
    expect(container.textContent).not.toContain('Add at least three connectors');
  });

  it('hides connector guidance once the user has five or more connectors', () => {
    useTodayStreamMock.mockReturnValue({
      items: [],
      suggestions: [],
      totalCount: 0,
      isLoading: false,
      isEmpty: false,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    const { container } = renderTodaySection({
      connectedConnectorCount: 5,
      userAddedConnectorCount: 5,
      onboardingActivationIncomplete: false,
      meetingCache: {
        meetings: [],
        isLoading: false,
        isStale: false,
        syncWarnings: [],
        populatedAt: Date.now(),
        refresh: vi.fn(async () => undefined),
      },
      focusEnabled: true,
    });

    expect(container.textContent).not.toContain('Add more connectors');
    expect(container.textContent).not.toContain('You have the basics. More connectors give Rebel a wider view');
    expect(container.querySelector('[data-type="connector-nudge"]')).toBeFalsy();
  });

  it('keeps connector guidance during onboarding even after dismissal or five connectors', () => {
    localStorage.setItem('rebel:homepage:connectorNudgeDismissedAt', String(Date.now()));
    useTodayStreamMock.mockReturnValue({
      items: [],
      suggestions: [],
      totalCount: 0,
      isLoading: false,
      isEmpty: false,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    const { container } = renderTodaySection({
      connectedConnectorCount: 5,
      userAddedConnectorCount: 5,
      onboardingActivationIncomplete: true,
      meetingCache: {
        meetings: [],
        isLoading: false,
        isStale: false,
        syncWarnings: [],
        populatedAt: Date.now(),
        refresh: vi.fn(async () => undefined),
      },
      focusEnabled: true,
    });

    const cards = [...container.querySelectorAll('[data-testid="today-card"]')];
    expect(cards.map((card) => card.textContent).slice(0, 2)).toEqual([
      expect.stringContaining('1. Start here'),
      expect.stringContaining('2. Add more connectors'),
    ]);
    expect(container.textContent).toContain('You have the basics. More connectors give Rebel a wider view');
    expect(container.querySelector('[data-type="connector-nudge"]')).toBeTruthy();
  });

  it('keeps useful starter actions visible while Today is still loading', () => {
    useTodayStreamMock.mockReturnValue({
      items: [],
      suggestions: [],
      totalCount: 0,
      isLoading: true,
      isEmpty: false,
      sourceStatus: {
        meetingsLoading: true,
        inboxLoading: true,
      },
    });

    const { container } = renderTodaySection({
      userState: { kind: 'new-loading' },
      connectedConnectorCount: 2,
      userAddedConnectorCount: 2,
      onboardingActivationIncomplete: false,
      meetingCache: {
        meetings: [],
        isLoading: true,
        isStale: false,
        syncWarnings: [],
        populatedAt: null,
        refresh: vi.fn(async () => undefined),
      },
      focusEnabled: true,
    });

    expect(container.textContent).toContain('Add at least three connectors');
    expect(container.textContent).toContain('Try a quick task');
    expect(container.textContent).toContain('Your personalised cards will appear here soon.');
    expect(container.querySelectorAll('[data-testid="today-card-skeleton"]').length).toBeGreaterThan(0);
  });

  it('shows the loading preview skeleton beneath structural cards while Today is still loading', () => {
    useTodayStreamMock.mockReturnValue({
      items: [],
      suggestions: [],
      totalCount: 0,
      isLoading: true,
      isEmpty: false,
      sourceStatus: {
        meetingsLoading: true,
        inboxLoading: true,
      },
    });

    const { container } = renderTodaySection({
      userState: { kind: 'new-loading' },
      connectedConnectorCount: 2,
      userAddedConnectorCount: 2,
      meetingCache: {
        meetings: [],
        isLoading: true,
        isStale: false,
        syncWarnings: [],
        populatedAt: null,
        refresh: vi.fn(async () => undefined),
      },
      focusEnabled: true,
    });

    expect(container.textContent).toContain('Your personalised cards will appear here soon.');
    const skeletonCount = container.querySelectorAll('[data-testid="today-card-skeleton"]').length;
    expect(skeletonCount).toBeGreaterThan(0);
    expect(skeletonCount).toBeLessThanOrEqual(2);
  });

  it('removes the starter action from priority once real Today items arrive', () => {
    useTodayStreamMock.mockReturnValue({
      items: [],
      suggestions: [],
      totalCount: 0,
      isLoading: true,
      isEmpty: false,
      sourceStatus: {
        meetingsLoading: true,
        inboxLoading: true,
      },
    });

    const onStartMeetingPrep = vi.fn(() => 'starter-session');
    const { container, rerender } = renderTodaySection({
      userState: { kind: 'new-loading' },
      connectedConnectorCount: 2,
      userAddedConnectorCount: 4,
      onboardingActivationIncomplete: false,
      onStartMeetingPrep,
      meetingCache: {
        meetings: [],
        isLoading: true,
        isStale: false,
        syncWarnings: [],
        populatedAt: null,
        refresh: vi.fn(async () => undefined),
      },
      focusEnabled: true,
    });

    const starterButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Try');
    expect(starterButton).toBeTruthy();
    reactAct(() => {
      starterButton?.click();
    });
    expect(onStartMeetingPrep).toHaveBeenCalledOnce();

    useTodayStreamMock.mockReturnValue({
      items: [makeTodayItem('urgent-1', 'Urgent 1')],
      suggestions: [],
      totalCount: 1,
      isLoading: false,
      isEmpty: false,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });
    rerender({
      userState: { kind: 'established-daily' },
      meetingCache: {
        meetings: [],
        isLoading: false,
        isStale: false,
        syncWarnings: [],
        populatedAt: Date.now(),
        refresh: vi.fn(async () => undefined),
      },
    });

    expect(container.textContent).toContain('Urgent 1');
    expect(container.textContent).not.toContain('Prep your next meeting');
  });

  it('lets users dismiss the meeting prep starter card', () => {
    useTodayStreamMock.mockReturnValue({
      items: [],
      suggestions: [],
      totalCount: 0,
      isLoading: false,
      isEmpty: false,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    const { container } = renderTodaySection({
      connectedConnectorCount: 2,
      userAddedConnectorCount: 2,
      meetingCache: {
        meetings: [
          {
            id: 'meeting-2',
            calendarEventId: 'event-2',
            calendarSource: 'google',
            title: 'Another meeting',
            startTime: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
            endTime: new Date(Date.now() + 120 * 60 * 1000).toISOString(),
            participants: ['A', 'B'],
            participantEmails: ['[Mindstone-email]', '[external-email]'],
          },
        ],
        isLoading: false,
        isStale: false,
        syncWarnings: [],
        populatedAt: Date.now(),
        refresh: vi.fn(async () => undefined),
      },
      focusEnabled: true,
    });

    expect(container.textContent).toContain('Prep your next meeting');
    const prepCard = [...container.querySelectorAll('[data-testid="today-card"]')]
      .find((card) => card.textContent?.includes('Prep your next meeting'));
    const dismissButton = prepCard?.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement | null;
    expect(dismissButton).toBeTruthy();

    reactAct(() => {
      dismissButton?.click();
    });

    expect(container.textContent).not.toContain('Prep your next meeting');
  });

  it('shows a general starter task when connectors exist but no specific connector category is known', () => {
    useTodayStreamMock.mockReturnValue({
      items: [],
      suggestions: [],
      totalCount: 0,
      isLoading: false,
      isEmpty: false,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    const onStartMeetingPrep = vi.fn(() => 'starter-session');
    const { container } = renderTodaySection({
      connectedConnectorCount: 2,
      userAddedConnectorCount: 2,
      onStartMeetingPrep,
      meetingCache: {
        meetings: [],
        isLoading: false,
        isStale: false,
        syncWarnings: [],
        populatedAt: Date.now(),
        refresh: vi.fn(async () => undefined),
      },
      focusEnabled: true,
    });

    expect(container.textContent).toContain('Try a quick task');
    expect(container.textContent).not.toContain('Prep your next meeting');

    const starterButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Try');
    reactAct(() => {
      starterButton?.click();
    });

    expect(onStartMeetingPrep).toHaveBeenCalledWith(
      'Help me turn a rough work request into a clear next step. Ask one question if you need context.',
    );
  });

  it('does not promise source-specific starter work from connector metadata alone', () => {
    useTodayStreamMock.mockReturnValue({
      items: [],
      suggestions: [],
      totalCount: 0,
      isLoading: false,
      isEmpty: false,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    const onStartMeetingPrep = vi.fn(() => 'starter-session');
    const { container } = renderTodaySection({
      connectedConnectorCount: 1,
      userAddedConnectorCount: 1,
      connectorActionAvailability: { hasEmail: false, hasMessaging: true, hasDocsOrWork: false },
      onStartMeetingPrep,
      meetingCache: {
        meetings: [],
        isLoading: false,
        isStale: false,
        syncWarnings: [],
        populatedAt: Date.now(),
        refresh: vi.fn(async () => undefined),
      },
      focusEnabled: true,
    });

    expect(container.textContent).toContain('Try a quick task');
    expect(container.textContent).not.toContain('Follow up on recent messages');
    expect(container.textContent).not.toContain('Draft a reply');
    expect(container.textContent).not.toContain('Summarise a document');
    const starterButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Try');
    reactAct(() => {
      starterButton?.click();
    });

    expect(onStartMeetingPrep).toHaveBeenCalledWith(
      'Help me turn a rough work request into a clear next step. Ask one question if you need context.',
    );
  });

  it('shows a no-connector starter action users can try immediately', () => {
    useTodayStreamMock.mockReturnValue({
      items: [],
      suggestions: [],
      totalCount: 0,
      isLoading: false,
      isEmpty: false,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    const onStartMeetingPrep = vi.fn(() => 'starter-session');
    const { container } = renderTodaySection({
      connectedConnectorCount: 0,
      userAddedConnectorCount: 0,
      onStartMeetingPrep,
      meetingCache: {
        meetings: [],
        isLoading: false,
        isStale: false,
        syncWarnings: [],
        populatedAt: Date.now(),
        refresh: vi.fn(async () => undefined),
      },
      focusEnabled: true,
    });

    expect(container.textContent).toContain('Draft a quick message');
    const starterButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Try');
    reactAct(() => {
      starterButton?.click();
    });

    expect(onStartMeetingPrep).toHaveBeenCalledWith(
      'Draft a concise work message from a rough idea. Ask me what I need to say, then turn it into a clear email, follow-up, or Slack-style note.',
    );
  });

  it('shows the first-run checking state without showing a manual starter action', () => {
    useTodayStreamMock.mockReturnValue({
      items: [],
      suggestions: [],
      totalCount: 0,
      isLoading: false,
      isEmpty: false,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    const { container } = renderTodaySection({
      userState: { kind: 'new-loading' },
      connectedConnectorCount: 2,
      userAddedConnectorCount: 4,
      onboardingActivationIncomplete: false,
      firstRunActionsPass: {
        status: 'running',
        activationId: 'onboarding:1',
        startedAt: Date.now(),
      },
      meetingCache: {
        meetings: [],
        isLoading: false,
        isStale: false,
        syncWarnings: [],
        populatedAt: Date.now(),
        refresh: vi.fn(async () => undefined),
      },
      focusEnabled: true,
    });

    expect(container.textContent).toContain('Checking your calendar and Actions for useful next steps.');
    expect(container.textContent).toContain('Add more connectors');
    expect(container.textContent).toContain('Your personalised cards will appear here soon.');
    expect(container.textContent).not.toContain('Try a quick task');
    expect(container.querySelector('[data-testid="today-card-skeleton"]')).toBeTruthy();
  });

  it('does not show first-run skeletons for pending passes that are waiting for a source', () => {
    useTodayStreamMock.mockReturnValue({
      items: [],
      suggestions: [],
      totalCount: 0,
      isLoading: false,
      isEmpty: false,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    const { container } = renderTodaySection({
      firstRunActionsPass: {
        status: 'pending',
        activationId: 'onboarding:1',
        startedAt: Date.now(),
      },
      focusEnabled: true,
    });

    expect(container.textContent).toContain('Connect your tools');
    expect(container.textContent).toContain('Tell Rebel what matters');
    expect(container.textContent).toContain('Prep your next meeting');
    expect(container.textContent).not.toContain('Checking your calendar and Actions for useful next steps.');
    expect(container.textContent).not.toContain('Your personalised cards will appear here soon.');
    expect(container.querySelector('[data-testid="today-card-skeleton"]')).toBeFalsy();
  });

  it('shows first-run skeleton cards beneath structural cards while waiting for actions', () => {
    useTodayStreamMock.mockReturnValue({
      items: [],
      suggestions: [],
      totalCount: 0,
      isLoading: false,
      isEmpty: false,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    const { container } = renderTodaySection({
      firstRunActionsPass: {
        status: 'running',
        activationId: 'onboarding:1',
        startedAt: Date.now(),
      },
      focusEnabled: true,
    });

    expect(container.textContent).toContain('Connect your tools');
    expect(container.textContent).toContain('Tell Rebel what matters');
    expect(container.textContent).toContain('Checking your calendar and Actions for useful next steps.');
    expect(container.textContent).toContain('Your personalised cards will appear here soon.');
    expect(container.querySelectorAll('[data-testid="today-card-skeleton"]').length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain('Try a quick task');
  });

  it('keeps a starter action visible after an empty first-run pass during onboarding', () => {
    useTodayStreamMock.mockReturnValue({
      items: [],
      suggestions: [],
      totalCount: 0,
      isLoading: false,
      isEmpty: true,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    const { container } = renderTodaySection({
      firstRunActionsPass: {
        status: 'completed',
        activationId: 'onboarding:1',
        itemsCreated: 0,
        completedAt: Date.now(),
      },
      focusEnabled: true,
    });

    expect(container.textContent).toContain('Connect your tools');
    expect(container.textContent).toContain('Tell Rebel what matters');
    expect(container.textContent).toContain('Prep your next meeting');
    expect(container.textContent).toContain('Rebel hasn\'t pulled enough from your connected tools yet.');
    expect(container.textContent).not.toContain('Nothing urgent yet.');
    expect(container.querySelector('[data-testid="today-card-skeleton"]')).toBeFalsy();
  });

  it('replaces first-run skeletons with failure copy beneath structural cards', () => {
    useTodayStreamMock.mockReturnValue({
      items: [],
      suggestions: [],
      totalCount: 0,
      isLoading: false,
      isEmpty: true,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    const { container } = renderTodaySection({
      firstRunActionsPass: {
        status: 'failed',
        activationId: 'onboarding:1',
        error: 'Calendar unavailable',
      },
      focusEnabled: true,
    });

    expect(container.textContent).toContain('Connect your tools');
    expect(container.textContent).toContain('Tell Rebel what matters');
    expect(container.textContent).toContain('Still getting connected');
    expect(container.textContent).toContain('cards will appear here as your tools finish syncing');
    expect(container.querySelector('[data-testid="today-card-skeleton"]')).toBeFalsy();
  });

  it('shows real first-run action items without keeping skeletons behind them', () => {
    useTodayStreamMock.mockReturnValue({
      items: [makeTodayItem('first-run-action', 'Prep for Customer sync')],
      suggestions: [],
      totalCount: 1,
      isLoading: false,
      isEmpty: false,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    const { container } = renderTodaySection({
      onboardingActivationIncomplete: false,
      userAddedConnectorCount: 4,
      firstRunActionsPass: {
        status: 'completed',
        activationId: 'onboarding:1',
        itemsCreated: 1,
        createdItemIds: ['first-run-action'],
        completedAt: Date.now(),
      },
      focusEnabled: true,
    });

    expect(container.textContent).toContain('Prep for Customer sync');
    expect(container.textContent).not.toContain('Your personalised cards will appear here soon.');
    expect(container.textContent).not.toContain('Nothing urgent yet.');
    expect(container.querySelector('[data-testid="today-card-skeleton"]')).toBeFalsy();
  });

  it('shows the settled first-run empty copy after no action items qualify', () => {
    useTodayStreamMock.mockReturnValue({
      items: [],
      suggestions: [],
      totalCount: 0,
      isLoading: false,
      isEmpty: true,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    const { container } = renderTodaySection({
      connectedConnectorCount: 2,
      userAddedConnectorCount: 4,
      onboardingActivationIncomplete: false,
      firstRunActionsPass: {
        status: 'completed',
        activationId: 'onboarding:1',
        itemsCreated: 0,
        completedAt: Date.now(),
      },
      meetingCache: {
        meetings: [],
        isLoading: false,
        isStale: false,
        syncWarnings: [],
        populatedAt: Date.now(),
        refresh: vi.fn(async () => undefined),
      },
      focusEnabled: true,
    });

    expect(container.textContent).toContain('Rebel hasn\'t pulled enough from your connected tools yet.');
    expect(container.textContent).not.toContain('Try a quick task');
  });

  it('shows the calm empty state after an empty first-run pass when setup cards are gone', () => {
    useTodayStreamMock.mockReturnValue({
      items: [],
      suggestions: [],
      totalCount: 0,
      isLoading: false,
      isEmpty: true,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    const { container } = renderTodaySection({
      connectedConnectorCount: 5,
      userAddedConnectorCount: 5,
      onboardingActivationIncomplete: false,
      firstRunActionsPass: {
        status: 'completed',
        activationId: 'onboarding:1',
        itemsCreated: 0,
        completedAt: Date.now(),
      },
      meetingCache: {
        meetings: [],
        isLoading: false,
        isStale: false,
        syncWarnings: [],
        populatedAt: Date.now(),
        refresh: vi.fn(async () => undefined),
      },
      focusEnabled: true,
    });

    expect(container.textContent).toContain('Nothing urgent yet. Rebel will add cards here when meetings, messages, or follow-ups need attention.');
    expect(container.textContent).not.toContain('Your personalised cards will appear here soon.');
    expect(container.querySelector('[data-testid="today-card-skeleton"]')).toBeFalsy();
  });

  it('replaces the settled first-run empty state when later action items arrive', () => {
    useTodayStreamMock.mockReturnValue({
      items: [],
      suggestions: [],
      totalCount: 0,
      isLoading: false,
      isEmpty: true,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    const { container, rerender } = renderTodaySection({
      connectedConnectorCount: 5,
      userAddedConnectorCount: 5,
      onboardingActivationIncomplete: false,
      firstRunActionsPass: {
        status: 'completed',
        activationId: 'onboarding:1',
        itemsCreated: 0,
        completedAt: Date.now(),
      },
      meetingCache: {
        meetings: [],
        isLoading: false,
        isStale: false,
        syncWarnings: [],
        populatedAt: Date.now(),
        refresh: vi.fn(async () => undefined),
      },
      focusEnabled: true,
    });

    expect(container.textContent).toContain('Nothing urgent yet.');

    useTodayStreamMock.mockReturnValue({
      items: [makeTodayItem('later-action', 'Follow up with Anna')],
      suggestions: [],
      totalCount: 1,
      isLoading: false,
      isEmpty: false,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    rerender();

    expect(container.textContent).toContain('Follow up with Anna');
    expect(container.textContent).not.toContain('Nothing urgent yet.');
    expect(container.querySelector('[data-testid="today-card-skeleton"]')).toBeFalsy();
  });

  it('keeps real Today items visible when the first-run pass reports a failure', () => {
    useTodayStreamMock.mockReturnValue({
      items: [makeTodayItem('later-action', 'Follow up with Anna')],
      suggestions: [],
      totalCount: 1,
      isLoading: false,
      isEmpty: false,
      sourceStatus: {
        meetingsLoading: false,
        inboxLoading: false,
      },
    });

    const { container } = renderTodaySection({
      connectedConnectorCount: 2,
      userAddedConnectorCount: 4,
      onboardingActivationIncomplete: false,
      firstRunActionsPass: {
        status: 'failed',
        activationId: 'onboarding:1',
        error: 'Calendar unavailable',
      },
      meetingCache: {
        meetings: [],
        isLoading: false,
        isStale: false,
        syncWarnings: [],
        populatedAt: Date.now(),
        refresh: vi.fn(async () => undefined),
      },
      focusEnabled: true,
    });

    expect(container.textContent).toContain('Follow up with Anna');
    expect(container.textContent).toContain('Still getting connected');
    expect(container.textContent).toContain('cards will appear here as your tools finish syncing');
  });
});
