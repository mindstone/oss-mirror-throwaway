// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SlackRecentSender } from '@rebel/cloud-client';
import type { InboundAuthorPolicy } from '@rebel/shared';
import type { UseInboundAuthorPolicyResult } from '../../../hooks/useInboundAuthorPolicy';
import type { UseSlackRecentSendersResult } from '../RecentMessageAttemptsPanel';
import { RecentMessageAttemptsPanel } from '../RecentMessageAttemptsPanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function render(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function buildPolicy(overrides: Partial<InboundAuthorPolicy> = {}): InboundAuthorPolicy {
  return {
    inboundAuthorPolicySchemaVersion: 1,
    policyRevision: 4,
    mode: 'allowlist',
    allowlist: { slack: [] },
    blocklist: { slack: [] },
    surfaceTrusted: { slack: [] },
    agentAllowlist: { slack: [] },
    notices: { upgradeReviewPending: false },
    ...overrides,
  };
}

function createPolicyState(
  policy: InboundAuthorPolicy,
  overrides: Partial<UseInboundAuthorPolicyResult> = {},
): UseInboundAuthorPolicyResult {
  const base: UseInboundAuthorPolicyResult = {
    policy,
    legacyAllowlistSlack: [],
    legacyBlocklistSlack: [],
    slackAuthorMetadata: {},
    setMode: vi.fn().mockResolvedValue(undefined),
    addToAllowlist: vi.fn().mockResolvedValue({ ok: true, canonicalId: 'U_RESOLVED' }),
    addToBlocklist: vi.fn().mockResolvedValue({ ok: true, canonicalId: 'U_RESOLVED' }),
    removeFromAllowlist: vi.fn().mockResolvedValue(undefined),
    removeFromBlocklist: vi.fn().mockResolvedValue(undefined),
    reresolveLegacyAllowlistEntry: vi.fn().mockResolvedValue({ ok: true, canonicalId: 'U_RERESOLVED' }),
    reresolveLegacyBlocklistEntry: vi.fn().mockResolvedValue({ ok: true, canonicalId: 'U_RERESOLVED' }),
    setSurfaceTrusted: vi.fn().mockResolvedValue(undefined),
    addToAgentAllowlist: vi.fn().mockResolvedValue(undefined),
    dismissUpgradeReviewNotice: vi.fn().mockResolvedValue(undefined),
    markUpgradeReviewDismissedNow: vi.fn(),
  };
  return {
    ...base,
    ...overrides,
  };
}

function sender(overrides: Partial<SlackRecentSender>): SlackRecentSender {
  return {
    principalKey: 'slack:T1:human:U12345678',
    kind: 'human',
    authorId: 'U12345678',
    normalizedAuthorId: 'U12345678',
    teamId: 'T1',
    lastSeenAt: Date.now() - 2 * 60 * 1000,
    attemptCount: 2,
    channelIds: ['general'],
    lastChannelType: 'channel',
    ...overrides,
  };
}

function createRecentState(
  senders: SlackRecentSender[],
  overrides: Partial<UseSlackRecentSendersResult> = {},
): UseSlackRecentSendersResult {
  return {
    senders,
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    clearAll: vi.fn().mockResolvedValue({ cleared: senders.length }),
    ...overrides,
  };
}

describe('RecentMessageAttemptsPanel', () => {
  const mounted: Mounted[] = [];

  afterEach(() => {
    for (const instance of mounted) {
      instance.unmount();
    }
    mounted.length = 0;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('renders the locked empty state copy when there are no senders', () => {
    const panel = render(
      <RecentMessageAttemptsPanel
        policyState={createPolicyState(buildPolicy())}
        recentSendersState={createRecentState([])}
      />,
    );
    mounted.push(panel);

    expect(panel.container.textContent).toContain('No blocked attempts yet. Slack, briefly civil.');
  });

  it('handles Allow this ID action for human senders', async () => {
    const addToAllowlist = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const policyState = createPolicyState(buildPolicy(), { addToAllowlist });
    const recentState = createRecentState(
      [sender({ principalKey: 'slack:T1:human:UALLOW' })],
      { remove },
    );
    const panel = render(
      <RecentMessageAttemptsPanel
        policyState={policyState}
        recentSendersState={recentState}
      />,
    );
    mounted.push(panel);

    const allow = panel.container.querySelector(
      '[data-testid="recent-message-attempt-allow-slack:T1:human:UALLOW"]',
    );
    expect(allow).not.toBeNull();
    await click(allow!);

    expect(addToAllowlist).toHaveBeenCalledWith('U12345678');
    expect(remove).toHaveBeenCalledWith('slack:T1:human:UALLOW');
  });

  it('handles Block this ID and Dismiss actions', async () => {
    const addToBlocklist = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const policyState = createPolicyState(buildPolicy(), { addToBlocklist });
    const recentState = createRecentState(
      [sender({ principalKey: 'slack:T1:human:UBLOCK' })],
      { remove },
    );
    const panel = render(
      <RecentMessageAttemptsPanel
        policyState={policyState}
        recentSendersState={recentState}
      />,
    );
    mounted.push(panel);

    const block = panel.container.querySelector(
      '[data-testid="recent-message-attempt-block-slack:T1:human:UBLOCK"]',
    );
    expect(block).not.toBeNull();
    await click(block!);

    expect(addToBlocklist).toHaveBeenCalledWith('U12345678');
    expect(remove).toHaveBeenCalledWith('slack:T1:human:UBLOCK');

    const dismiss = panel.container.querySelector(
      '[data-testid="recent-message-attempt-dismiss-slack:T1:human:UBLOCK"]',
    );
    expect(dismiss).not.toBeNull();
    await click(dismiss!);
    expect(remove).toHaveBeenCalledWith('slack:T1:human:UBLOCK');
  });

  it('renders unknown-user copy and the Other Rebels subsection', () => {
    const panel = render(
      <RecentMessageAttemptsPanel
        policyState={createPolicyState(buildPolicy())}
        recentSendersState={createRecentState([
          sender({
            principalKey: 'slack:T1:human:UUNKNOWN',
            authorId: 'UUNKNOWN',
            normalizedAuthorId: 'UUNKNOWN',
            displayName: undefined,
            handle: undefined,
          }),
          sender({
            principalKey: 'slack:T1:agent:rebel-instance-A',
            kind: 'agent',
            authorId: 'rebel-instance-A',
            normalizedAuthorId: 'REBEL-INSTANCE-A',
            displayName: 'Rebel in Finance',
            lastChannelType: 'im',
            channelIds: ['D1234'],
          }),
        ])}
      />,
    );
    mounted.push(panel);

    expect(panel.container.textContent).toContain('Unknown Slack user');
    expect(panel.container.textContent).toContain('Slack ID UU…WN');
    expect(panel.container.textContent).toContain('Other Rebels');
  });

  it('routes agent allow action to addToAgentAllowlist', async () => {
    const addToAgentAllowlist = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const policyState = createPolicyState(buildPolicy(), { addToAgentAllowlist });
    const recentState = createRecentState([
      sender({
        principalKey: 'slack:T1:agent:rebel-instance-A',
        kind: 'agent',
        authorId: 'rebel-instance-A',
        normalizedAuthorId: 'REBEL-INSTANCE-A',
      }),
    ], { remove });
    const panel = render(
      <RecentMessageAttemptsPanel
        policyState={policyState}
        recentSendersState={recentState}
      />,
    );
    mounted.push(panel);

    const allow = panel.container.querySelector(
      '[data-testid="recent-message-attempt-allow-slack:T1:agent:rebel-instance-A"]',
    );
    expect(allow).not.toBeNull();
    await click(allow!);

    expect(addToAgentAllowlist).toHaveBeenCalledWith('slack', 'rebel-instance-A');
    expect(remove).toHaveBeenCalledWith('slack:T1:agent:rebel-instance-A');
  });

  it('escapes hostile strings and keeps disconnected historical notice visible', () => {
    const panel = render(
      <RecentMessageAttemptsPanel
        policyState={createPolicyState(buildPolicy())}
        recentSendersState={createRecentState([
          sender({
            principalKey: 'slack:T1:human:UHOSTILE',
            authorId: 'UHOSTILE',
            normalizedAuthorId: 'UHOSTILE',
            displayName: '<script>alert(1)</script>',
          }),
        ])}
        slackConnected={false}
      />,
    );
    mounted.push(panel);

    expect(panel.container.textContent).toContain('Connect Slack to add people from recent attempts.');
    expect(panel.container.innerHTML).not.toContain('<script>alert(1)</script>');
    expect(panel.container.innerHTML).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('calls clearAll from the top action', async () => {
    const clearAll = vi.fn().mockResolvedValue({ cleared: 1 });
    const panel = render(
      <RecentMessageAttemptsPanel
        policyState={createPolicyState(buildPolicy())}
        recentSendersState={createRecentState([sender({ principalKey: 'slack:T1:human:UCLEAR' })], { clearAll })}
      />,
    );
    mounted.push(panel);

    const clear = panel.container.querySelector('[data-testid="recent-message-attempts-clear-all"]');
    expect(clear).not.toBeNull();
    await click(clear!);
    expect(clearAll).toHaveBeenCalledTimes(1);
  });
});
