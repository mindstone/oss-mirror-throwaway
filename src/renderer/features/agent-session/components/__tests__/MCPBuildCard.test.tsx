// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import type { SubmittedSubstatus } from '@shared/utils/contributionStateMapping';

// Mock CSS module
vi.mock('../MCPBuildCard.module.css', () => ({
  default: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  AlertTriangle: (props: any) => React.createElement('svg', { 'data-icon': 'alert-triangle', ...props }),
  Bot: (props: any) => React.createElement('svg', { 'data-icon': 'bot', ...props }),
  CheckCircle2: (props: any) => React.createElement('svg', { 'data-icon': 'check-circle-2', ...props }),
  Clock3: (props: any) => React.createElement('svg', { 'data-icon': 'clock-3', ...props }),
  ExternalLink: (props: any) => React.createElement('svg', { 'data-icon': 'external-link', ...props }),
  Loader2: (props: any) => React.createElement('svg', { 'data-icon': 'loader-2', ...props }),
  PartyPopper: (props: any) => React.createElement('svg', { 'data-icon': 'party-popper', ...props }),
  RefreshCw: (props: any) => React.createElement('svg', { 'data-icon': 'refresh-cw', ...props }),
  Sparkles: (props: any) => React.createElement('svg', { 'data-icon': 'sparkles', ...props }),
  Wrench: (props: any) => React.createElement('svg', { 'data-icon': 'wrench', ...props }),
  XCircle: (props: any) => React.createElement('svg', { 'data-icon': 'x-circle', ...props }),
}));

// Mock the UI components used by the card.
vi.mock('@renderer/components/ui', () => ({
  Button: ({ children, disabled, ...rest }: any) =>
    React.createElement('button', { disabled, ...rest }, children),
  IconButton: ({ children, disabled, ...rest }: any) =>
    React.createElement('button', { disabled, ...rest }, children),
  Spinner: ({ label }: any) =>
    React.createElement('span', { 'data-testid': 'spinner', 'data-label': label }),
  Tooltip: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

// Mock cn utility
vi.mock('@renderer/lib/utils', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));

// Enable React act() environment
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = require('react-dom/client');
const { act: reactAct } = require('react');

import {
  buildMcpBuildQuestionBatch,
  MCPBuildCard,
  type MCPBuildCardState,
} from '../MCPBuildCard';

// ── Render helper ───────────────────────────────────────────────────

function renderCard(
  state: MCPBuildCardState,
  props: Partial<React.ComponentProps<typeof MCPBuildCard>> = {},
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);

  reactAct(() => {
    root.render(
      React.createElement(MCPBuildCard, { state, ...props }),
    );
  });

  return container;
}

// ─── 260424 PR-template revamp follow-up (addendum #2) ─────────────
// The inline `github-check` card (with the "One more thing" form) was
// removed. The phase now renders nothing — the footer question batch
// is the single attribution surface. The card state is preserved so
// the transcript machinery (dismissal keys, poller, refetch) keeps
// working across `github-check`, but it paints no pixels.

describe('MCPBuildCard — github-check phase renders nothing (addendum #2)', () => {
  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
  });

  it('renders no DOM for github-check (form removed; footer batch owns attribution)', () => {
    const container = renderCard(
      { phase: 'github-check', connectorName: 'TestConn', rebelName: 'Alex' },
      {
        onUseRebelName: vi.fn(),
        onGitHubYes: vi.fn(),
        onAnonymous: vi.fn(),
      },
    );
    // No section, no button, no form — render returns null.
    expect(container.querySelector('section')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('still renders nothing when no handlers are wired', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);
    reactAct(() => {
      root.render(
        React.createElement(MCPBuildCard, {
          state: { phase: 'github-check', connectorName: 'TestConn' } as MCPBuildCardState,
        }),
      );
    });
    expect(container.querySelector('section')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });
});

// ─── VAL-CARD-004: Helper text varies by substatus ──────────────────

describe('MCPBuildCard — submitted phase helper text', () => {
  const substatuses: Array<{
    substatus: SubmittedSubstatus;
    helperText: string;
    expectedFragment: string;
  }> = [
    {
      substatus: 'under_review',
      helperText:
        "The Mindstone team is taking a look now to make sure everything works well and is ready to share. We'll let you know as soon as it's available to everyone.",
      expectedFragment: "We'll let you know as soon as it's available to everyone",
    },
    {
      substatus: 'pending_approval',
      helperText: 'Automated checks passed. Your connector is waiting for approval.',
      expectedFragment: 'waiting for approval',
    },
    {
      substatus: 'checks_failed',
      helperText: 'Automated checks found an issue before approval. Rebel can help you fix it.',
      expectedFragment: 'Automated checks found an issue',
    },
    {
      substatus: 'changes_needed',
      helperText: 'Maintainer requested changes.',
      expectedFragment: 'requested changes',
    },
    {
      substatus: 'approved',
      helperText: 'Approved! Publishing soon.',
      expectedFragment: 'Approved',
    },
    {
      substatus: 'rejected',
      helperText: 'Not accepted.',
      expectedFragment: 'Not accepted',
    },
    {
      substatus: 'published',
      helperText: 'Now live in the Rebel connector catalog!',
      expectedFragment: 'live in the Rebel',
    },
  ];

  it.each(substatuses)(
    'renders "$expectedFragment" for substatus "$substatus"',
    ({ substatus, helperText, expectedFragment }) => {
      const container = renderCard({
        phase: 'submitted',
        connectorName: 'TestConn',
        helperText,
        substatus,
      });

      const text = container.textContent;
      expect(text).toContain(expectedFragment);
    },
  );

  it('renders distinct text for each substatus', () => {
    const texts = substatuses.map(({ substatus, helperText }) => {
      const container = renderCard({
        phase: 'submitted',
        connectorName: 'TestConn',
        helperText,
        substatus,
      });
      return container.textContent;
    });

    // Verify all texts are distinct
    const unique = new Set(texts);
    expect(unique.size).toBe(substatuses.length);
  });

  it('uses default helper text when helperText not provided', () => {
    const container = renderCard({
      phase: 'submitted',
      connectorName: 'TestConn',
    });

    expect(container.textContent).toContain(
      "A reviewer is taking a look now to make sure everything works well and is ready to share. We'll let you know as soon as it's available to everyone.",
    );
  });

  it('uses Sent for review as the primary title with a byline', () => {
    const container = renderCard({
      phase: 'submitted',
      connectorName: 'TestConn',
      substatus: 'under_review',
      authorName: 'team-member',
    });

    expect(container.textContent).toContain('Sent for review');
    expect(container.textContent).toContain('by team-member');
  });

  it('renders the author byline when provided', () => {
    const container = renderCard({
      phase: 'submitted',
      connectorName: 'TestConn',
      helperText: 'Automated checks passed.',
      substatus: 'pending_approval',
      authorName: 'octocat',
    });

    expect(container.textContent).toContain('by octocat');
  });

  it('sets data-substatus attribute when substatus provided', () => {
    const container = renderCard({
      phase: 'submitted',
      connectorName: 'TestConn',
      helperText: 'Approved!',
      substatus: 'approved',
    });

    const section = container.querySelector('section[data-substatus="approved"]');
    expect(section).toBeTruthy();
  });

  it('renders a refresh status control when a refresh handler is provided', () => {
    const container = renderCard(
      {
        phase: 'submitted',
        connectorName: 'TestConn',
        substatus: 'under_review',
      },
      { onRefreshStatus: vi.fn() },
    );

    const refreshButton = container.querySelector('button[aria-label="Check for updates"]');
    expect(refreshButton).toBeTruthy();
  });

  it('renders a View in Settings button when a settings handler is provided', () => {
    const container = renderCard(
      {
        phase: 'submitted',
        connectorName: 'TestConn',
        substatus: 'under_review',
      },
      { onViewInSettings: vi.fn() },
    );

    const buttons = container.querySelectorAll('button');
    const viewInSettingsButton = Array.from(buttons).find(
      (btn) => btn.textContent?.includes('View in Settings'),
    );

    expect(viewInSettingsButton).toBeTruthy();
    expect(viewInSettingsButton!.getAttribute('variant')).toBe('default');
  });
});

// ─── MCPBuildCard — changes_needed "Make the tweaks" action ──

describe('MCPBuildCard — submitted phase follow-up action', () => {
  it('renders "Make the tweaks" button for changes_needed substatus', () => {
    const onMakeChanges = vi.fn();
    const container = renderCard(
      {
        phase: 'submitted',
        connectorName: 'TestConn',
        helperText: 'The reviewer has some suggestions.',
        substatus: 'changes_needed',
      },
      { onMakeChanges },
    );

    const buttons = container.querySelectorAll('button');
    const makeChangesButton = Array.from(buttons).find(
      (btn) => btn.textContent?.includes('Make the tweaks'),
    );

    expect(makeChangesButton).toBeTruthy();
    expect(makeChangesButton!.disabled).toBeFalsy();
  });

  it('does NOT render "Make the tweaks" button for non-actionable substatuses', () => {
    const onMakeChanges = vi.fn();
    const noActionSubstatuses: SubmittedSubstatus[] = [
      'under_review',
      'pending_approval',
      'approved',
      'rejected',
      'published',
    ];

    for (const substatus of noActionSubstatuses) {
      const container = renderCard(
        {
          phase: 'submitted',
          connectorName: 'TestConn',
          helperText: 'Some text',
          substatus,
        },
        { onMakeChanges },
      );

      const buttons = container.querySelectorAll('button');
      const makeChangesButton = Array.from(buttons).find(
        (btn) => btn.textContent?.includes('Make the tweaks'),
      );

      expect(makeChangesButton).toBeUndefined();
    }
  });

  it('"Make the tweaks" button is disabled when no handler provided', () => {
    const container = renderCard({
      phase: 'submitted',
      connectorName: 'TestConn',
      helperText: 'The reviewer has some suggestions.',
      substatus: 'changes_needed',
    });

    const buttons = container.querySelectorAll('button');
    const makeChangesButton = Array.from(buttons).find(
      (btn) => btn.textContent?.includes('Make the tweaks'),
    );

    expect(makeChangesButton).toBeTruthy();
    expect(makeChangesButton!.disabled).toBe(true);
  });

  it('renders "Make the tweaks" button for checks_failed substatus', () => {
    const onMakeChanges = vi.fn();
    const container = renderCard(
      {
        phase: 'submitted',
        connectorName: 'TestConn',
        helperText: 'Automated checks found an issue before approval.',
        substatus: 'checks_failed',
      },
      { onMakeChanges },
    );

    const buttons = container.querySelectorAll('button');
    const makeChangesButton = Array.from(buttons).find(
      (btn) => btn.textContent?.includes('Make the tweaks'),
    );

    expect(makeChangesButton).toBeTruthy();
    expect(makeChangesButton!.disabled).toBeFalsy();
  });

  it('calls onMakeChanges handler when button clicked', () => {
    const onMakeChanges = vi.fn();
    const container = renderCard(
      {
        phase: 'submitted',
        connectorName: 'TestConn',
        helperText: 'The reviewer has some suggestions.',
        substatus: 'changes_needed',
      },
      { onMakeChanges },
    );

    const buttons = container.querySelectorAll('button');
    const makeChangesButton = Array.from(buttons).find(
      (btn) => btn.textContent?.includes('Make the tweaks'),
    );

    reactAct(() => {
      makeChangesButton!.click();
    });

    expect(onMakeChanges).toHaveBeenCalledTimes(1);
  });
});

describe('MCPBuildCard — submitted phase GitHub CTA hierarchy', () => {
  it('uses the outlined secondary variant for View on GitHub in passive states', () => {
    const container = renderCard(
      {
        phase: 'submitted',
        connectorName: 'TestConn',
        helperText: 'Automated checks passed.',
        substatus: 'pending_approval',
        prUrl: 'https://github.com/example/repo/pull/1',
      },
      { onViewOnGitHub: vi.fn(), onViewInSettings: vi.fn() },
    );

    const buttons = container.querySelectorAll('button');
    const viewOnGitHubButton = Array.from(buttons).find(
      (btn) => btn.textContent?.includes('View on GitHub'),
    );

    expect(viewOnGitHubButton).toBeTruthy();
    expect(viewOnGitHubButton!.getAttribute('variant')).toBe('outline');
  });

  it('uses the primary button variant for View in Settings in passive states', () => {
    const container = renderCard(
      {
        phase: 'submitted',
        connectorName: 'TestConn',
        helperText: 'Automated checks passed.',
        substatus: 'pending_approval',
        prUrl: 'https://github.com/example/repo/pull/1',
      },
      { onViewOnGitHub: vi.fn(), onViewInSettings: vi.fn() },
    );

    const buttons = container.querySelectorAll('button');
    const viewInSettingsButton = Array.from(buttons).find(
      (btn) => btn.textContent?.includes('View in Settings'),
    );

    expect(viewInSettingsButton).toBeTruthy();
    expect(viewInSettingsButton!.getAttribute('variant')).toBe('default');
  });

  it('demotes View in Settings when Make the tweaks is the primary action', () => {
    const container = renderCard(
      {
        phase: 'submitted',
        connectorName: 'TestConn',
        helperText: 'Maintainer requested changes.',
        substatus: 'changes_needed',
        prUrl: 'https://github.com/example/repo/pull/2',
      },
      { onMakeChanges: vi.fn(), onViewOnGitHub: vi.fn(), onViewInSettings: vi.fn() },
    );

    const buttons = container.querySelectorAll('button');
    const viewInSettingsButton = Array.from(buttons).find(
      (btn) => btn.textContent?.includes('View in Settings'),
    );

    expect(viewInSettingsButton).toBeTruthy();
    expect(viewInSettingsButton!.getAttribute('variant')).toBe('secondary');
  });

  it('calls onViewInSettings with the connector name when clicked', () => {
    const onViewInSettings = vi.fn();
    const container = renderCard(
      {
        phase: 'submitted',
        connectorName: 'TestConn',
        substatus: 'pending_approval',
      },
      { onViewInSettings },
    );

    const buttons = container.querySelectorAll('button');
    const viewInSettingsButton = Array.from(buttons).find(
      (btn) => btn.textContent?.includes('View in Settings'),
    );

    reactAct(() => {
      viewInSettingsButton!.click();
    });

    expect(onViewInSettings).toHaveBeenCalledWith('TestConn');
  });
});

// ─── Basic phase rendering ──────────────────────────────────────────

describe('MCPBuildCard — basic rendering', () => {
  it('renders submit-prompt phase', () => {
    const container = renderCard({
      phase: 'submit-prompt',
      connectorName: 'Freshdesk',
      tools: [],
    });
    expect(container.textContent).toContain('Freshdesk');
    expect(container.textContent).toContain('Share it with everyone');
  });

  it('renders no submit-prompt card in OSS builds', () => {
    const container = renderCard(
      {
        phase: 'submit-prompt',
        connectorName: 'Freshdesk',
        tools: [],
      },
      { isOssBuild: true },
    );

    expect(container.querySelector('section')).toBeNull();
    expect(container.textContent).not.toContain('Share it with everyone');
  });
});

// ─── 2026-04-20 correction: building phase ─────────────────────────

describe('MCPBuildCard — building phase', () => {
  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
  });

  it('renders building.implementing with "Building your <name> tool" title and no submit CTA', () => {
    const container = renderCard({
      phase: 'building',
      subphase: 'implementing',
      connectorName: 'Notion',
      tools: [],
    });
    expect(container.textContent).toContain('Building your Notion tool');
    // No submit CTA should appear during implementing
    expect(container.textContent).not.toContain('Share it with everyone');
    // No question card / CTA buttons should be rendered for a purely
    // informational state.
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(0);
  });

  it('renders building.testing with "Trying out your <name> tool" title and no submit CTA', () => {
    const container = renderCard({
      phase: 'building',
      subphase: 'testing',
      connectorName: 'Notion',
      tools: [],
    });
    expect(container.textContent).toContain('Trying out your Notion tool');
    expect(container.textContent).not.toContain('Share it with everyone');
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(0);
  });

  it('uses subphase-specific helper copy', () => {
    const implementingContainer = renderCard({
      phase: 'building',
      subphase: 'implementing',
      connectorName: 'Notion',
      tools: [],
    });
    expect(implementingContainer.textContent).toContain(
      'putting the pieces together',
    );

    // Swap DOM for isolated second render
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }

    const testingContainer = renderCard({
      phase: 'building',
      subphase: 'testing',
      connectorName: 'Notion',
      tools: [],
    });
    expect(testingContainer.textContent).toContain(
      'trying each new action with realistic examples',
    );
  });

  it('buildMcpBuildQuestionBatch returns null for building phase (no synthesized question)', () => {
    // Informational-only state: no UserQuestionCard should be synthesized.
    const implementingBatch = buildMcpBuildQuestionBatch(
      { phase: 'building', subphase: 'implementing', connectorName: 'Notion', tools: [] },
      'session-1',
    );
    expect(implementingBatch).toBeNull();

    const testingBatch = buildMcpBuildQuestionBatch(
      { phase: 'building', subphase: 'testing', connectorName: 'Notion', tools: [] },
      'session-1',
    );
    expect(testingBatch).toBeNull();
  });
});

// ─── Stage 3: testing-error card behavior ─────────────────────────

describe('MCPBuildCard — testing-error phase', () => {
  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
  });

  it('invokes onReRunTest when the testing-error re-run button is clicked', () => {
    const onReRunTest = vi.fn();
    const container = renderCard(
      {
        phase: 'testing-error',
        connectorName: 'Zendesk',
        tools: [
          { name: 'list_tickets', status: 'pass' },
          { name: 'create_ticket', status: 'fail', error: 'Auth failed' },
        ],
      },
      { onReRunTest },
    );
    const buttons = container.querySelectorAll('button');
    const reRunBtn = Array.from(buttons).find((b) =>
      b.textContent?.includes('Try again'),
    );
    expect(reRunBtn).toBeTruthy();
    reactAct(() => {
      reRunBtn!.click();
    });
    expect(onReRunTest).toHaveBeenCalledTimes(1);
  });

  it('renders lastTransitionError as muted text when present', () => {
    // Stage 3: the testing-error card surfaces the raw lastTransitionError
    // so the user can see why the testing gate rejected a premature
    // ready_to_submit.
    const container = renderCard({
      phase: 'testing-error',
      connectorName: 'Zendesk',
      tools: [{ name: 'list_tickets', status: 'fail', error: 'not yet tested' }],
      lastTransitionError:
        "Invalid transition: testing \u2192 ready_to_submit. Current status is 'testing'.",
    });
    expect(container.textContent).toContain('Invalid transition');
    expect(container.textContent).toContain('Check results');
  });

  it('renders friendly message for evidence-insufficient JSON lastTransitionError', () => {
    // Stage 2.5 bridge evidence gate rejects direct-create ready_to_submit
    // without a test-pass or add-server-observer signal. The structured
    // JSON reason is rendered as a user-facing sentence.
    const json = JSON.stringify({
      reason: 'evidence-insufficient',
      missingSignals: ['test-pass', 'add-server-observer'],
    });
    const container = renderCard({
      phase: 'testing-error',
      connectorName: 'Zendesk',
      tools: [{ name: 'list_tickets', status: 'fail' }],
      lastTransitionError: json,
    });
    expect(container.textContent).toContain(
      'I got ahead of myself. Trying it properly now.',
    );
    expect(container.textContent).not.toContain('evidence-insufficient');
  });

  it('renders friendly message for non-canonical-path JSON lastTransitionError', () => {
    const json = JSON.stringify({
      reason: 'non-canonical-path',
      observedPath: '/Users/you/Documents/Rebel/Chief-of-Staff/scripts/fibonacci-mcp',
      expectedPathPrefix: '~/mcp-servers/<api-name>-mcp/',
    });
    const container = renderCard({
      phase: 'testing-error',
      connectorName: 'Zendesk',
      tools: [{ name: 'list_tickets', status: 'fail' }],
      lastTransitionError: json,
    });
    expect(container.textContent).toContain(
      'Rebel saved the files in the wrong folder. Moving them now and trying again.',
    );
    expect(container.textContent).not.toContain('non-canonical-path');
    expect(container.textContent).not.toContain('canonical');
  });

  it('omits the transition-error paragraph when lastTransitionError is absent', () => {
    const container = renderCard({
      phase: 'testing-error',
      connectorName: 'Zendesk',
      tools: [{ name: 'list_tickets', status: 'fail', error: 'Auth failed' }],
    });
    // The tool-failure line and error must still render.
    expect(container.textContent).toContain('list_tickets');
    expect(container.textContent).toContain('Auth failed');
    // But no leaked "Invalid transition…" or evidence-insufficient copy.
    expect(container.textContent).not.toContain('Invalid transition');
    expect(container.textContent).not.toContain('I reported ready');
  });
});

describe('buildMcpBuildQuestionBatch', () => {
  it('builds the Ask User Questions payload for submit-prompt', () => {
    const batch = buildMcpBuildQuestionBatch(
      {
        phase: 'submit-prompt',
        connectorName: 'Freshdesk',
        tools: [],
      },
      'session-1',
    );

    expect(batch).toMatchObject({
      batchId: 'mcp-build:session-1:Freshdesk:submit-prompt',
      toolUseId: 'mcp-build:session-1:Freshdesk:submit-prompt',
      sessionId: 'session-1',
    });
    expect(batch?.questions[0]).toMatchObject({
      header: 'Your Freshdesk tool is ready',
      options: [
        { id: 'add-to-community', label: 'Share it with everyone' },
        { id: 'keep-private', label: 'Keep it private' },
      ],
    });
  });

  it('returns null for submit-prompt in OSS builds', () => {
    const batch = buildMcpBuildQuestionBatch(
      {
        phase: 'submit-prompt',
        connectorName: 'Freshdesk',
        tools: [],
      },
      'session-1',
      { isOssBuild: true },
    );

    expect(batch).toBeNull();
  });

  it('builds the Ask User Questions payload for github-check with three attribution options', () => {
    const batch = buildMcpBuildQuestionBatch(
      {
        phase: 'github-check',
        connectorName: 'Zendesk',
        rebelName: 'Alex',
      },
      'session-2',
    );

    expect(batch).toMatchObject({
      batchId: 'mcp-build:session-2:Zendesk:github-check',
      toolUseId: 'mcp-build:session-2:Zendesk:github-check',
      sessionId: 'session-2',
    });
    expect(batch?.questions[0]).toMatchObject({
      header: 'Share your tool',
      options: [
        { id: 'rebel-name', label: 'Use my Rebel name (Alex)' },
        { id: 'github-yes', label: 'Use my GitHub account' },
        { id: 'anonymous', label: 'Share anonymously' },
      ],
    });
  });

  it('returns null for github-check in OSS builds', () => {
    const batch = buildMcpBuildQuestionBatch(
      {
        phase: 'github-check',
        connectorName: 'Zendesk',
        rebelName: 'Alex',
      },
      'session-2',
      { enableContributionRelay: true, isOssBuild: true },
    );

    expect(batch).toBeNull();
  });

  // Stage 5a (260420 OSS MCP backend relay): when the feature flag is
  // off (stable default), `buildMcpBuildQuestionBatch` must emit the
  // pre-Stage-1 2-option card (`github-yes` / `github-skip`) so the
  // legacy GitHub-only flow stays intact until the backend has proved
  // itself in beta.
  describe('Stage 5a: enableContributionRelay gate for github-check', () => {
    it('emits the 2-option github/skip card when enableContributionRelay is false', () => {
      const batch = buildMcpBuildQuestionBatch(
        {
          phase: 'github-check',
          connectorName: 'Zendesk',
          rebelName: 'Alex',
        },
        'session-2',
        { enableContributionRelay: false },
      );

      expect(batch?.questions[0]?.options).toEqual([
        expect.objectContaining({ id: 'github-yes', label: 'Use my GitHub account' }),
        expect.objectContaining({ id: 'github-skip', label: 'Skip for now' }),
      ]);
      // The 3-way-only option ids must not leak into the off path.
      const optionIds = (batch?.questions[0]?.options ?? []).map((o) => o.id);
      expect(optionIds).not.toContain('rebel-name');
      expect(optionIds).not.toContain('anonymous');
    });

    it('emits the 3-option picker when enableContributionRelay is true', () => {
      const batch = buildMcpBuildQuestionBatch(
        {
          phase: 'github-check',
          connectorName: 'Zendesk',
          rebelName: 'Alex',
        },
        'session-2',
        { enableContributionRelay: true },
      );

      const optionIds = (batch?.questions[0]?.options ?? []).map((o) => o.id);
      expect(optionIds).toEqual(['rebel-name', 'github-yes', 'anonymous']);
    });

    it('defaults to the 3-option picker when options arg is omitted (pre-Stage-5a call sites)', () => {
      const batch = buildMcpBuildQuestionBatch(
        { phase: 'github-check', connectorName: 'Zendesk' },
        'session-2',
      );
      const optionIds = (batch?.questions[0]?.options ?? []).map((o) => o.id);
      expect(optionIds).toEqual(['rebel-name', 'github-yes', 'anonymous']);
    });

    it('off-path uses a GitHub-specific question header (not the 3-way attribution copy)', () => {
      const batch = buildMcpBuildQuestionBatch(
        { phase: 'github-check', connectorName: 'Zendesk' },
        'session-2',
        { enableContributionRelay: false },
      );
      expect(batch?.questions[0]?.question).not.toMatch(/which name/i);
      // Must still show the "Share your tool" header so the visual
      // hierarchy is preserved across the flag states.
      expect(batch).toMatchObject({
        questions: [expect.objectContaining({ header: 'Share your tool' })],
      });
    });

    it('off-path preserves session-scoped batch ids (Stage 1.2 R3 invariant)', () => {
      const state: MCPBuildCardState = { phase: 'github-check', connectorName: 'Shared' };
      const batchA = buildMcpBuildQuestionBatch(state, 'session-A', {
        enableContributionRelay: false,
      });
      const batchB = buildMcpBuildQuestionBatch(state, 'session-B', {
        enableContributionRelay: false,
      });
      expect(batchA?.batchId).not.toBe(batchB?.batchId);
      expect(batchA?.batchId).toContain('session-A');
      expect(batchB?.batchId).toContain('session-B');
    });

    it('non-github-check phases are unaffected by the flag', () => {
      const submitBatchOff = buildMcpBuildQuestionBatch(
        { phase: 'submit-prompt', connectorName: 'Foo', tools: [] },
        'session-1',
        { enableContributionRelay: false },
      );
      const submitBatchOn = buildMcpBuildQuestionBatch(
        { phase: 'submit-prompt', connectorName: 'Foo', tools: [] },
        'session-1',
        { enableContributionRelay: true },
      );
      expect(submitBatchOff?.questions[0]?.options).toEqual(
        submitBatchOn?.questions[0]?.options,
      );

      const testingErrBatchOff = buildMcpBuildQuestionBatch(
        {
          phase: 'testing-error',
          connectorName: 'Foo',
          tools: [{ name: 't', status: 'fail' }],
        },
        'session-1',
        { enableContributionRelay: false },
      );
      const testingErrBatchOn = buildMcpBuildQuestionBatch(
        {
          phase: 'testing-error',
          connectorName: 'Foo',
          tools: [{ name: 't', status: 'fail' }],
        },
        'session-1',
        { enableContributionRelay: true },
      );
      expect(testingErrBatchOff?.questions[0]?.options).toEqual(
        testingErrBatchOn?.questions[0]?.options,
      );
    });
  });

  it('falls back to a generic Rebel name label when rebelName is missing', () => {
    const batch = buildMcpBuildQuestionBatch(
      {
        phase: 'github-check',
        connectorName: 'Zendesk',
      },
      'session-2',
    );

    expect(batch?.questions[0]?.options?.[0]).toMatchObject({
      id: 'rebel-name',
      label: 'Use my Rebel name',
    });
  });

  it('does not build the Ask User Questions payload for submitted with prUrl', () => {
    const batch = buildMcpBuildQuestionBatch(
      {
        phase: 'submitted',
        connectorName: 'Salesforce',
        prUrl: 'https://github.com/example/repo/pull/42',
        substatus: 'pending_approval',
        authorName: 'octocat',
      },
      'session-3',
    );

    expect(batch).toBeNull();
  });

  it('returns null for actionable submitted states because the inline card owns those actions', () => {
    const batch = buildMcpBuildQuestionBatch(
      {
        phase: 'submitted',
        connectorName: 'HubSpot',
        prUrl: 'https://github.com/example/repo/pull/99',
        substatus: 'changes_needed',
      },
      'session-4',
    );

    expect(batch).toBeNull();
  });

  it('returns null for submitted without prUrl', () => {
    const batch = buildMcpBuildQuestionBatch(
      {
        phase: 'submitted',
        connectorName: 'Freshdesk',
      },
      'session-1',
    );

    expect(batch).toBeNull();
  });

  it('builds the Ask User Questions payload for testing-error', () => {
    const batch = buildMcpBuildQuestionBatch(
      {
        phase: 'testing-error',
        connectorName: 'Zendesk',
        tools: [
          { name: 'list_tickets', status: 'pass' },
          { name: 'create_ticket', status: 'fail', error: 'Auth failed' },
        ],
      },
      'session-7',
    );

    expect(batch).toMatchObject({
      batchId: 'mcp-build:session-7:Zendesk:testing-error',
      sessionId: 'session-7',
    });
    expect(batch?.questions[0]).toMatchObject({
      header: 'Zendesk tool',
      question: 'A few things need attention',
      options: [
        { id: 're-run-check', label: 'Try again' },
        { id: 'contact-team', label: 'Contact the Mindstone team for help' },
      ],
    });
    expect(batch?.questions[0]?.options?.[0]).toMatchObject({ id: 're-run-check', label: 'Try again' });
    expect(batch?.questions[0]?.context).toContain('✓ list_tickets');
    expect(batch?.questions[0]?.context).toContain('✗ create_ticket — Auth failed');
  });

  it('includes autoFixMessage in testing-error context', () => {
    const batch = buildMcpBuildQuestionBatch(
      {
        phase: 'testing-error',
        connectorName: 'Slack',
        tools: [{ name: 'send_message', status: 'fail', error: 'Token expired' }],
        autoFixMessage: 'Rebel will try to fix the token automatically.',
      },
      'session-8',
    );

    expect(batch?.questions[0]?.context).toContain('Token expired');
    expect(batch?.questions[0]?.context).toContain('Rebel will try to fix the token');
  });

  // Stage 1.2 R3 (260420 OSS MCP backend relay): batchIds include
  // `sessionId` so two sessions working on a connector with the same name
  // don't share dismissal state. The `sessionId` component is a required
  // primary key in every batch id shape the builder emits.
  describe('Stage 1.2 R3 — session-scoped batchIds', () => {
    it.each([
      ['submit-prompt', { phase: 'submit-prompt' as const, connectorName: 'Shared', tools: [] }],
      ['github-check', { phase: 'github-check' as const, connectorName: 'Shared' }],
      ['testing-error', {
        phase: 'testing-error' as const,
        connectorName: 'Shared',
        tools: [{ name: 't', status: 'fail' as const }],
      }],
    ])('batchId includes sessionId for phase %s', (_label, state) => {
      const batchA = buildMcpBuildQuestionBatch(state, 'session-A');
      const batchB = buildMcpBuildQuestionBatch(state, 'session-B');
      expect(batchA?.batchId).toContain('session-A');
      expect(batchA?.batchId).toContain('Shared');
      expect(batchB?.batchId).toContain('session-B');
      expect(batchB?.batchId).toContain('Shared');
      // The core R3 invariant: distinct sessionIds produce distinct ids,
      // so dismissing in session A cannot dismiss in session B.
      expect(batchA?.batchId).not.toBe(batchB?.batchId);
      expect(batchA?.toolUseId).not.toBe(batchB?.toolUseId);
      expect(batchA?.turnId).not.toBe(batchB?.turnId);
    });
  });
});
