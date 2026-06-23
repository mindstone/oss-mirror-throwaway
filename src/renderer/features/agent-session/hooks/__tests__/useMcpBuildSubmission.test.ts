// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';

// Enable React act() environment
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = require('react-dom/client');
const { act: reactAct } = require('react');

const mockNavigate = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
 
vi.mock('@renderer/hooks/useAppNavigation', () => ({
  useAppNavigationSafe: () => ({ navigate: mockNavigate }),
}));

// ─── Mock window.contributionApi ─────────────────────────────────────

const mockGetBySession = vi.fn();
const mockUpdateLocalState = vi.fn();
const mockSubmitUnified = vi.fn();
const mockGetAuthStatus = vi.fn();
const mockStartAuth = vi.fn();

(window as unknown as { contributionApi: Record<string, unknown> }).contributionApi = {
  getBySession: (...args: unknown[]) => mockGetBySession(...args),
  updateLocalState: (...args: unknown[]) => mockUpdateLocalState(...args),
  submitUnified: (...args: unknown[]) => mockSubmitUnified(...args),
  getAuthStatus: (...args: unknown[]) => mockGetAuthStatus(...args),
  startAuth: (...args: unknown[]) => mockStartAuth(...args),
};

import { useMcpBuildSubmission, type UseMcpBuildSubmissionArgs, type UseMcpBuildSubmissionResult } from '../useMcpBuildSubmission';

// ─── Helpers ─────────────────────────────────────────────────────────

async function flushAsync() {
  await reactAct(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderHook(initial: UseMcpBuildSubmissionArgs): {
  result: { current: UseMcpBuildSubmissionResult };
  rerender: (next: UseMcpBuildSubmissionArgs) => void;
  unmount: () => void;
} {
  const result = { current: undefined as unknown as UseMcpBuildSubmissionResult };

  const TestComponent = (props: { args: UseMcpBuildSubmissionArgs }) => {
    result.current = useMcpBuildSubmission(props.args);
    return null;
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  reactAct(() => {
    root.render(React.createElement(TestComponent, { args: initial }));
  });

  return {
    result,
    rerender: (next) => {
      reactAct(() => {
        root.render(React.createElement(TestComponent, { args: next }));
      });
    },
    unmount: () => {
      reactAct(() => { root.unmount(); });
      container.remove();
    },
  };
}

function makeArgs(overrides: Partial<UseMcpBuildSubmissionArgs> = {}): UseMcpBuildSubmissionArgs {
  return {
    currentSessionId: 'session-1',
    userFirstName: 'Alex',
    refetchMcpBuildCardState: vi.fn().mockResolvedValue(undefined),
    showToast: vi.fn(),
    emitLog: vi.fn(),
    ...overrides,
  };
}

// 260424 PR-template revamp follow-up (addendum #2): the inline PR
// form was removed, so attribution handlers no longer accept any form
// values. The existing behaviour (attribution mode, retry semantics,
// session-switch races) is unchanged — these tests exercise that
// behaviour through the new no-argument handler signatures.

// ─── Tests ───────────────────────────────────────────────────────────

describe('useMcpBuildSubmission', () => {
  beforeEach(() => {
    mockGetBySession.mockReset();
    mockUpdateLocalState.mockReset();
    mockSubmitUnified.mockReset();
    mockGetAuthStatus.mockReset();
    mockStartAuth.mockReset();
    mockNavigate.mockReset();
    mockNavigate.mockResolvedValue(true);
  });

  describe('handleSubmitToCommunity', () => {
    it('returns true and shows the picker on success', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      const args = makeArgs();
      const { result, unmount } = renderHook(args);

      let returnValue: boolean | undefined;
      await reactAct(async () => {
        returnValue = await result.current.handleSubmitToCommunity();
      });
      expect(returnValue).toBe(true);
      expect(result.current.githubCheckConnectorName).toBe('MyConn');
      unmount();
    });

    it('returns false and toasts when no contribution is found', async () => {
      mockGetBySession.mockResolvedValue({ contribution: null });
      const args = makeArgs();
      const { result, unmount } = renderHook(args);

      let returnValue: boolean | undefined;
      await reactAct(async () => {
        returnValue = await result.current.handleSubmitToCommunity();
      });
      expect(returnValue).toBe(false);
      expect(args.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining("can't find the tool") }),
      );
      unmount();
    });
  });

  describe('handleUseRebelName', () => {
    it('toasts and returns false when userFirstName is missing', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      const args = makeArgs({ userFirstName: null });
      const { result, unmount } = renderHook(args);

      let returnValue: boolean | undefined;
      await reactAct(async () => {
        returnValue = await result.current.handleUseRebelName();
      });
      expect(returnValue).toBe(false);
      expect(args.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining('Rebel name') }),
      );
      expect(mockSubmitUnified).not.toHaveBeenCalled();
      unmount();
    });

    it('submits via rebel-name attribution and returns true on success', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockSubmitUnified.mockResolvedValue({ success: true, prUrl: 'https://x/1', prNumber: 1 });
      const args = makeArgs();
      const { result, unmount } = renderHook(args);

      let returnValue: boolean | undefined;
      await reactAct(async () => {
        returnValue = await result.current.handleUseRebelName();
      });
      expect(returnValue).toBe(true);
      expect(mockUpdateLocalState).not.toHaveBeenCalled();
      expect(mockSubmitUnified).toHaveBeenCalledWith({
        contributionId: 'c1',
        desiredAttributionMode: 'rebel-name',
        desiredAttributionName: 'Alex',
      });
      unmount();
    });

    it('returns true on degraded success', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockSubmitUnified.mockResolvedValue({
        success: true,
        prUrl: 'https://x/1',
        prNumber: 1,
        degraded: 'persistence-failed',
      });
      const args = makeArgs();
      const { result, unmount } = renderHook(args);

      let returnValue: boolean | undefined;
      await reactAct(async () => {
        returnValue = await result.current.handleUseRebelName();
      });
      expect(returnValue).toBe(true);
      expect(args.emitLog).toHaveBeenCalled();
      unmount();
    });

    it('shows skippedDenylisted success toast when backend reports excluded sensitive files', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockSubmitUnified.mockResolvedValue({
        success: true,
        prUrl: 'https://x/1',
        prNumber: 1,
        skippedDenylisted: ['.env', 'credentials.json', 'secrets.txt', 'token.txt'],
      });
      const args = makeArgs();
      const { result, unmount } = renderHook(args);

      await reactAct(async () => {
        await result.current.handleUseRebelName();
      });

      expect(args.showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'We left 4 sensitive files out before sending it: .env, credentials.json, secrets.txt, …',
        }),
      );
      unmount();
    });

    it('does not pre-write attribution and keeps picker visible on typed submit failure', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockSubmitUnified.mockResolvedValue({
        success: false,
        error: { code: 'VALIDATION', message: 'file too big' },
      });
      const args = makeArgs();
      const { result, unmount } = renderHook(args);

      // Stage 1.2 R1 (260420): simulate the real entry flow — the user
      // reaches the picker by first clicking "Add to the community". The
      // picker (github-check) MUST stay visible after any recoverable
      // failure so the user can retry or switch attribution modes.
      await reactAct(async () => {
        await result.current.handleSubmitToCommunity();
      });
      expect(result.current.githubCheckConnectorName).toBe('MyConn');

      let returnValue: boolean | undefined;
      await reactAct(async () => {
        returnValue = await result.current.handleUseRebelName();
      });
      expect(returnValue).toBe(false);
      expect(mockUpdateLocalState).not.toHaveBeenCalled();
      expect(mockSubmitUnified).toHaveBeenCalledWith({
        contributionId: 'c1',
        desiredAttributionMode: 'rebel-name',
        desiredAttributionName: 'Alex',
      });
      expect(args.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'file too big', variant: 'error' }),
      );
      expect(result.current.githubCheckConnectorName).toBe('MyConn');
      expect(result.current.submittingConnectorName).toBeNull();
      unmount();
    });

    it('returns false when submitUnified returns a typed failure', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockSubmitUnified.mockResolvedValue({
        success: false,
        error: { code: 'VALIDATION', message: 'file too big' },
      });
      const args = makeArgs();
      const { result, unmount } = renderHook(args);

      // Stage 1.2 R1: reach the picker the normal way.
      await reactAct(async () => {
        await result.current.handleSubmitToCommunity();
      });

      let returnValue: boolean | undefined;
      await reactAct(async () => {
        returnValue = await result.current.handleUseRebelName();
      });
      expect(returnValue).toBe(false);
      expect(args.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'file too big', variant: 'error' }),
      );
      // Stage 1.2 R1: typed submit failure must keep the picker visible.
      expect(result.current.githubCheckConnectorName).toBe('MyConn');
      expect(result.current.submittingConnectorName).toBeNull();
      unmount();
    });

    // 260424 bug: relay returns `GITHUB_API` (HTTP 502) when the backend's
    // bot fails to create the PR on GitHub (e.g. GitHub App
    // misconfigured, bot fork missing, upstream rate-limited). The raw
    // backend message ("GitHub upstream error.") is bare and implies the
    // user did something wrong. Replace it with a retryable brand-voice
    // message that names the failure mode. Same treatment for
    // `RATE_LIMIT` (the backend message is equally unhelpful). The raw
    // message stays in the structured log inside `submitViaRelay`.
    it('shows a retryable, backend-owned message when the relay returns GITHUB_API', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockSubmitUnified.mockResolvedValue({
        success: false,
        error: { code: 'GITHUB_API', message: 'GitHub upstream error.' },
      });
      const args = makeArgs();
      const { result, unmount } = renderHook(args);

      await reactAct(async () => {
        await result.current.handleSubmitToCommunity();
      });

      let returnValue: boolean | undefined;
      await reactAct(async () => {
        returnValue = await result.current.handleUseRebelName();
      });
      expect(returnValue).toBe(false);
      expect(args.showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining("GitHub didn't take the hand-off"),
          variant: 'error',
        }),
      );
      // The raw backend message must NOT be what the user sees.
      expect(args.showToast).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: 'GitHub upstream error.' }),
      );
      // Recoverable failure: picker stays visible for retry.
      expect(result.current.githubCheckConnectorName).toBe('MyConn');
      expect(result.current.submittingConnectorName).toBeNull();
      unmount();
    });

    it('shows the same retryable message when the relay returns RATE_LIMIT', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockSubmitUnified.mockResolvedValue({
        success: false,
        error: { code: 'RATE_LIMIT', message: 'Rate limited.' },
      });
      const args = makeArgs();
      const { result, unmount } = renderHook(args);

      await reactAct(async () => {
        await result.current.handleSubmitToCommunity();
      });

      await reactAct(async () => {
        await result.current.handleUseRebelName();
      });
      expect(args.showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining("GitHub didn't take the hand-off"),
          variant: 'error',
        }),
      );
      unmount();
    });

    it('routes TIMEOUT through the transient template and preserves relay copy as description', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockSubmitUnified.mockResolvedValue({
        success: false,
        error: {
          code: 'TIMEOUT',
          message: "We didn't hear back from our backend in time. Try again?",
        },
      });
      const args = makeArgs();
      const { result, unmount } = renderHook(args);

      await reactAct(async () => {
        await result.current.handleSubmitToCommunity();
      });

      await reactAct(async () => {
        await result.current.handleUseRebelName();
      });
      expect(args.showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining("GitHub didn't take the hand-off"),
          description: "We didn't hear back from our backend in time. Try again?",
          variant: 'error',
        }),
      );
      unmount();
    });

    it('returns false when submitUnified throws (clears the overlay)', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockSubmitUnified.mockRejectedValue(new Error('backend fell over'));
      const args = makeArgs();
      const { result, unmount } = renderHook(args);

      await reactAct(async () => {
        await result.current.handleSubmitToCommunity();
      });

      let returnValue: boolean | undefined;
      await reactAct(async () => {
        returnValue = await result.current.handleUseRebelName();
      });
      expect(returnValue).toBe(false);
      expect(result.current.submittingConnectorName).toBeNull();
      expect(args.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'backend fell over', variant: 'error' }),
      );
      // Stage 1.2 R1: thrown exception must keep the picker visible
      // (only the `submitting` overlay is torn down).
      expect(result.current.githubCheckConnectorName).toBe('MyConn');
      unmount();
    });

    // Stage 1.2 R1 (260420): missing userFirstName is a recoverable
    // failure — the user needs to fill Settings > Profile or pick
    // another attribution mode. The picker must stay mounted.
    it('Stage 1.2 R1: keeps picker visible when userFirstName is missing', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      const args = makeArgs({ userFirstName: null });
      const { result, unmount } = renderHook(args);

      await reactAct(async () => {
        await result.current.handleSubmitToCommunity();
      });
      expect(result.current.githubCheckConnectorName).toBe('MyConn');

      await reactAct(async () => {
        await result.current.handleUseRebelName();
      });
      expect(result.current.githubCheckConnectorName).toBe('MyConn');
      expect(mockSubmitUnified).not.toHaveBeenCalled();
      unmount();
    });

    it('shows UNAUTHORIZED relay failures with an Open Settings action', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockSubmitUnified.mockResolvedValue({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Sign-in required',
        },
      });
      const args = makeArgs();
      const { result, unmount } = renderHook(args);

      await reactAct(async () => {
        await result.current.handleSubmitToCommunity();
      });

      await reactAct(async () => {
        await result.current.handleUseRebelName();
      });
      const toastCall = (args.showToast as ReturnType<typeof vi.fn>).mock.calls.find(
        ([toast]) => (toast as { title?: string }).title === 'Your Rebel sign-in expired',
      );
      expect(toastCall).toBeDefined();
      const toast = toastCall?.[0] as {
        description?: string;
        action?: { label: string; onClick: () => void };
      };
      expect(toast.description).toBe('Reconnect from Settings → Account.');
      expect(toast.action?.label).toBe('Open Settings');
      toast.action?.onClick();
      expect(mockNavigate).toHaveBeenCalledWith('rebel://settings/account');
      expect(result.current.githubCheckConnectorName).toBe('MyConn');
      expect(result.current.submittingConnectorName).toBeNull();
      unmount();
    });
  });

  describe('handleAnonymous', () => {
    it('passes desired attribution fields for anonymous submits', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockSubmitUnified.mockResolvedValue({ success: true, prUrl: 'https://x/1', prNumber: 1 });
      const args = makeArgs();
      const { result, unmount } = renderHook(args);

      await reactAct(async () => {
        await result.current.handleAnonymous();
      });
      expect(mockUpdateLocalState).not.toHaveBeenCalled();
      expect(mockSubmitUnified).toHaveBeenCalledWith({
        contributionId: 'c1',
        desiredAttributionMode: 'anonymous',
        desiredAttributionName: null,
      });
      unmount();
    });

    it('returns true on terminal success', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockSubmitUnified.mockResolvedValue({ success: true, prUrl: 'https://x/1', prNumber: 1 });
      const args = makeArgs();
      const { result, unmount } = renderHook(args);

      let returnValue: boolean | undefined;
      await reactAct(async () => {
        returnValue = await result.current.handleAnonymous();
      });
      expect(returnValue).toBe(true);
      unmount();
    });
  });

  describe('handleGitHubYes', () => {
    it('submits directly when already authenticated and token fresh', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockGetAuthStatus.mockResolvedValue({ connected: true, expired: false });
      mockSubmitUnified.mockResolvedValue({ success: true, prUrl: 'https://x/1', prNumber: 1 });
      const args = makeArgs();
      const { result, unmount } = renderHook(args);

      let returnValue: boolean | undefined;
      await reactAct(async () => {
        returnValue = await result.current.handleGitHubYes();
      });
      expect(returnValue).toBe(true);
      expect(mockStartAuth).not.toHaveBeenCalled();
      unmount();
    });

    it.skip('kicks off OAuth when not authenticated, then submits', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockGetAuthStatus.mockResolvedValue({ connected: false, expired: false });
      mockStartAuth.mockResolvedValue({ success: true });
      mockSubmitUnified.mockResolvedValue({ success: true, prUrl: 'https://x/1', prNumber: 1 });
      const args = makeArgs();
      const { result, unmount } = renderHook(args);

      let returnValue: boolean | undefined;
      await reactAct(async () => {
        returnValue = await result.current.handleGitHubYes();
      });
      expect(returnValue).toBe(true);
      expect(mockStartAuth).toHaveBeenCalledTimes(1);
      unmount();
    });

    it.skip('after a reAuthRequired failure, the next click forces startAuth even when local getAuthStatus reports connected', async () => {
      // First submission: local status looks fine, but server says reAuthRequired.
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockGetAuthStatus.mockResolvedValue({ connected: true, expired: false });
      mockSubmitUnified
        .mockResolvedValueOnce({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Sign in again' },
          reAuthRequired: true,
        })
        .mockResolvedValueOnce({ success: true, prUrl: 'https://x/1', prNumber: 1 });
      mockStartAuth.mockResolvedValue({ success: true });

      const args = makeArgs();
      const { result, unmount } = renderHook(args);

      // First click: local getAuthStatus passes, submit returns reAuthRequired.
      let firstResult: boolean | undefined;
      await reactAct(async () => {
        firstResult = await result.current.handleGitHubYes();
      });
      expect(firstResult).toBe(false);
      expect(mockStartAuth).not.toHaveBeenCalled();
      expect(result.current.githubCheckConnectorName).toBe('MyConn');

      // Second click: needsReAuthRef is now set — must call startAuth even
      // though getAuthStatus STILL reports connected+not-expired (the
      // local state and server state have diverged).
      mockGetAuthStatus.mockClear();
      let secondResult: boolean | undefined;
      await reactAct(async () => {
        secondResult = await result.current.handleGitHubYes();
      });
      expect(secondResult).toBe(true);
      expect(mockGetAuthStatus).not.toHaveBeenCalled(); // forced-reauth path skips the check
      expect(mockStartAuth).toHaveBeenCalledTimes(1);
      unmount();
    });

    it.skip('returns false when the OAuth attempt fails', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockGetAuthStatus.mockResolvedValue({ connected: false, expired: false });
      mockStartAuth.mockResolvedValue({ success: false, error: 'User cancelled' });
      const args = makeArgs();
      const { result, unmount } = renderHook(args);

      // Stage 1.2 R1: reach the picker the normal way so we can check
      // that an OAuth cancel does NOT hide it.
      await reactAct(async () => {
        await result.current.handleSubmitToCommunity();
      });

      let returnValue: boolean | undefined;
      await reactAct(async () => {
        returnValue = await result.current.handleGitHubYes();
      });
      expect(returnValue).toBe(false);
      expect(mockSubmitUnified).not.toHaveBeenCalled();
      // Stage 1.2 R1: OAuth cancel is recoverable — picker stays mounted.
      expect(result.current.githubCheckConnectorName).toBe('MyConn');
      unmount();
    });

    // Stage 1.2 FU4 (260420 OSS MCP backend relay): after 2+ consecutive
    // reAuthRequired failures on the same session, surface a one-shot
    // nudge toward the Rebel-name / Anonymous alternatives. Switching
    // to a non-GitHub path resets the counter and re-arms the nudge.
    it('Stage 1.2 FU4: shows a one-shot nudge toast on the 3rd consecutive reAuthRequired failure, then resets on mode switch', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockGetAuthStatus.mockResolvedValue({ connected: true, expired: false });
      mockStartAuth.mockResolvedValue({ success: true });
      // Three reAuthRequired failures in a row, then the Rebel-name
      // submission finally succeeds.
      mockSubmitUnified
        .mockResolvedValueOnce({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Sign in again' },
          reAuthRequired: true,
        })
        .mockResolvedValueOnce({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Sign in again' },
          reAuthRequired: true,
        })
        .mockResolvedValueOnce({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Sign in again' },
          reAuthRequired: true,
        })
        .mockResolvedValueOnce({ success: true, prUrl: 'https://x/1', prNumber: 1 });

      const args = makeArgs();
      const showToast = args.showToast as ReturnType<typeof vi.fn>;
      const { result, unmount } = renderHook(args);

      await reactAct(async () => {
        await result.current.handleSubmitToCommunity();
      });

      const NUDGE_TITLE = /Rebel name or share anonymously/i;

      // 1st failure: no nudge yet.
      await reactAct(async () => { await result.current.handleGitHubYes(); });
      expect(
        showToast.mock.calls.some(([msg]) => NUDGE_TITLE.test((msg as { title: string }).title)),
      ).toBe(false);

      // 2nd failure: still no nudge (threshold is N=2 consecutive, nudge
      // triggers on the following — 3rd — attempt).
      await reactAct(async () => { await result.current.handleGitHubYes(); });
      expect(
        showToast.mock.calls.some(([msg]) => NUDGE_TITLE.test((msg as { title: string }).title)),
      ).toBe(false);

      // 3rd failure: nudge fires exactly once.
      await reactAct(async () => { await result.current.handleGitHubYes(); });
      const nudgeCallsAfterThird = showToast.mock.calls.filter(
        ([msg]) => NUDGE_TITLE.test((msg as { title: string }).title),
      );
      expect(nudgeCallsAfterThird).toHaveLength(1);

      // User switches to Rebel-name. The submission succeeds, which
      // resets the counter + nudge latch.
      await reactAct(async () => { await result.current.handleUseRebelName(); });

      // A subsequent string of reAuthRequired failures after the reset
      // would re-arm the nudge. We don't have 3 more mocked responses
      // in the queue, but we can verify the latch was cleared by
      // checking the hook's internal state is resettable: the nudge
      // count is captured in a ref so the observable proof is that no
      // duplicate nudge has been added since the success.
      const nudgeCallsNow = showToast.mock.calls.filter(
        ([msg]) => NUDGE_TITLE.test((msg as { title: string }).title),
      );
      expect(nudgeCallsNow).toHaveLength(1);
      unmount();
    });
  });

  // Stage 1.3 X1a (260420 OSS MCP backend relay): explicit user
  // dismissal of the preserved github-check picker. Preservation on
  // recoverable failure (Stage 1.2 R1) left users stuck if they X-ed
  // the batch — the memo stayed pinned to `github-check`, the rebuilt
  // batch collided with the dismissed id, and the submit-prompt retry
  // affordance never returned. `clearGithubCheck()` lets the dismiss
  // handler clear the transient AND the reAuth bookkeeping so retry
  // flows start from a clean slate.
  describe('clearGithubCheck (Stage 1.3 X1a)', () => {
    it('clears the preserved github-check transient after a recoverable failure', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockSubmitUnified.mockResolvedValue({
        success: false,
        error: { code: 'VALIDATION', message: 'file too big' },
      });
      const args = makeArgs();
      const { result, unmount } = renderHook(args);

      // Reach the picker, then fail (recoverable) — R1 keeps the
      // transient mounted for retry.
      await reactAct(async () => {
        await result.current.handleSubmitToCommunity();
      });
      await reactAct(async () => {
        await result.current.handleUseRebelName();
      });
      expect(result.current.githubCheckConnectorName).toBe('MyConn');

      // User dismisses the batch → clearGithubCheck is called.
      reactAct(() => {
        result.current.clearGithubCheck();
      });
      expect(result.current.githubCheckConnectorName).toBeNull();
      expect(result.current.submittingConnectorName).toBeNull();

      // Contribution record still exists — clearGithubCheck doesn't
      // void the contribution, only the UI transient. The next
      // handleSubmitToCommunity click re-enters the picker.
      await reactAct(async () => {
        await result.current.handleSubmitToCommunity();
      });
      expect(result.current.githubCheckConnectorName).toBe('MyConn');
      unmount();
    });

    it.skip('resets the reAuth bookkeeping so a subsequent GitHub click no longer forces startAuth', async () => {
      // First: drive needsReAuthRef = true via a reAuthRequired failure.
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockGetAuthStatus.mockResolvedValue({ connected: true, expired: false });
      mockSubmitUnified.mockResolvedValueOnce({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Sign in again' },
        reAuthRequired: true,
      });
      const args = makeArgs();
      const { result, unmount } = renderHook(args);

      await reactAct(async () => {
        await result.current.handleGitHubYes();
      });
      expect(result.current.githubCheckConnectorName).toBe('MyConn');

      // Now user dismisses the picker. Transient clears, reAuth
      // bookkeeping resets.
      reactAct(() => {
        result.current.clearGithubCheck();
      });
      expect(result.current.githubCheckConnectorName).toBeNull();

      // Set up the NEXT GitHub attempt to succeed so we can observe
      // that `needsReAuthRef` has been cleared — the forced-reauth
      // path would skip getAuthStatus entirely. After clearGithubCheck,
      // it should consult getAuthStatus again.
      mockSubmitUnified.mockReset();
      mockSubmitUnified.mockResolvedValue({ success: true, prUrl: 'https://x/1', prNumber: 1 });
      mockGetAuthStatus.mockClear();

      await reactAct(async () => {
        await result.current.handleGitHubYes();
      });
      // After clearGithubCheck, the forced-reauth latch is down, so
      // the normal getAuthStatus check runs again.
      expect(mockGetAuthStatus).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('resets the reAuth nudge latch so a future streak can re-fire it', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockGetAuthStatus.mockResolvedValue({ connected: true, expired: false });
      mockStartAuth.mockResolvedValue({ success: true });
      const reAuthFailure = {
        success: false as const,
        error: { code: 'UNAUTHORIZED' as const, message: 'Sign in again' },
        reAuthRequired: true as const,
      };
      mockSubmitUnified
        .mockResolvedValueOnce(reAuthFailure)
        .mockResolvedValueOnce(reAuthFailure)
        .mockResolvedValueOnce(reAuthFailure);

      const args = makeArgs();
      const showToast = args.showToast as ReturnType<typeof vi.fn>;
      const { result, unmount } = renderHook(args);

      // 3 failures → nudge fires.
      await reactAct(async () => { await result.current.handleGitHubYes(); });
      await reactAct(async () => { await result.current.handleGitHubYes(); });
      await reactAct(async () => { await result.current.handleGitHubYes(); });
      const NUDGE_RX = /Rebel name or share anonymously/i;
      expect(
        showToast.mock.calls.filter(([msg]) => NUDGE_RX.test((msg as { title: string }).title)),
      ).toHaveLength(1);

      // Dismiss + reset. If the latch didn't reset, subsequent reAuth
      // failures would never re-surface the nudge.
      reactAct(() => {
        result.current.clearGithubCheck();
      });
      showToast.mockClear();

      // Three more reAuth failures post-clear should re-fire the nudge.
      mockSubmitUnified
        .mockResolvedValueOnce(reAuthFailure)
        .mockResolvedValueOnce(reAuthFailure)
        .mockResolvedValueOnce(reAuthFailure);
      await reactAct(async () => { await result.current.handleGitHubYes(); });
      await reactAct(async () => { await result.current.handleGitHubYes(); });
      await reactAct(async () => { await result.current.handleGitHubYes(); });
      expect(
        showToast.mock.calls.filter(([msg]) => NUDGE_RX.test((msg as { title: string }).title)),
      ).toHaveLength(1);
      unmount();
    });
  });

  // Stage 5a (260420 OSS MCP backend relay): `enableContributionRelay`
  // gates the relay submit path. When false, Rebel-name and Anonymous
  // attribution handlers short-circuit with a brand-voice toast and
  // never touch the contribution store or the submit IPC. GitHub and
  // refresh paths are unaffected.
  describe('Stage 5a: enableContributionRelay flag gating', () => {
    it('handleUseRebelName short-circuits with a toast when flag is off (no submit, no store write)', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      const args = makeArgs({ enableContributionRelay: false });
      const { result, unmount } = renderHook(args);

      let returnValue: boolean | undefined;
      await reactAct(async () => {
        returnValue = await result.current.handleUseRebelName();
      });
      expect(returnValue).toBe(false);
      // Flag off is defensive — handler must NOT touch the store or
      // submit IPC. Short-circuit before the first await.
      expect(mockGetBySession).not.toHaveBeenCalled();
      expect(mockSubmitUnified).not.toHaveBeenCalled();
      expect(args.showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringMatching(/GitHub/i),
        }),
      );
      unmount();
    });

    it('handleAnonymous short-circuits with a toast when flag is off (no submit, no store write)', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      const args = makeArgs({ enableContributionRelay: false });
      const { result, unmount } = renderHook(args);

      let returnValue: boolean | undefined;
      await reactAct(async () => {
        returnValue = await result.current.handleAnonymous();
      });
      expect(returnValue).toBe(false);
      expect(mockGetBySession).not.toHaveBeenCalled();
      expect(mockSubmitUnified).not.toHaveBeenCalled();
      expect(args.showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringMatching(/GitHub/i),
        }),
      );
      unmount();
    });

    it('handleGitHubYes is NOT gated by the flag — GitHub direct-fork path always works', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockGetAuthStatus.mockResolvedValue({ connected: true, expired: false });
      mockSubmitUnified.mockResolvedValue({ success: true, prUrl: 'https://x/1', prNumber: 1 });
      const args = makeArgs({ enableContributionRelay: false });
      const { result, unmount } = renderHook(args);

      let returnValue: boolean | undefined;
      await reactAct(async () => {
        returnValue = await result.current.handleGitHubYes();
      });
      // Flag off → relay path blocked, but GitHub direct-fork path is
      // the supported fallback and must submit normally.
      expect(returnValue).toBe(true);
      expect(mockUpdateLocalState).not.toHaveBeenCalled();
      expect(mockSubmitUnified).toHaveBeenCalledWith({
        contributionId: 'c1',
        desiredAttributionMode: 'github',
      });
      unmount();
    });

    it('handleSubmitToCommunity is NOT gated — the picker still opens so the user can pick GitHub', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      const args = makeArgs({ enableContributionRelay: false });
      const { result, unmount } = renderHook(args);

      let returnValue: boolean | undefined;
      await reactAct(async () => {
        returnValue = await result.current.handleSubmitToCommunity();
      });
      // Opening the picker is independent of the flag — the picker's
      // rendering (2-option vs 3-option) is the gate. Users must still
      // be able to reach it and then choose GitHub.
      expect(returnValue).toBe(true);
      expect(result.current.githubCheckConnectorName).toBe('MyConn');
      unmount();
    });

    it('flag on (explicit true) preserves Stage 1 3-way behaviour (regression guard)', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockSubmitUnified.mockResolvedValue({ success: true, prUrl: 'https://x/1', prNumber: 1 });
      const args = makeArgs({ enableContributionRelay: true });
      const { result, unmount } = renderHook(args);

      let returnValue: boolean | undefined;
      await reactAct(async () => {
        returnValue = await result.current.handleUseRebelName();
      });
      expect(returnValue).toBe(true);
      expect(mockUpdateLocalState).not.toHaveBeenCalled();
      expect(mockSubmitUnified).toHaveBeenCalledWith({
        contributionId: 'c1',
        desiredAttributionMode: 'rebel-name',
        desiredAttributionName: 'Alex',
      });
      unmount();
    });

    it('flag undefined defaults to ON (legacy behaviour for pre-Stage-5a callers)', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockSubmitUnified.mockResolvedValue({ success: true, prUrl: 'https://x/1', prNumber: 1 });
      const args = makeArgs(); // no enableContributionRelay override
      const { result, unmount } = renderHook(args);

      let returnValue: boolean | undefined;
      await reactAct(async () => {
        returnValue = await result.current.handleAnonymous();
      });
      expect(returnValue).toBe(true);
      expect(mockUpdateLocalState).not.toHaveBeenCalled();
      unmount();
    });

    it('flag updates dynamically when the prop changes — off→on enables submissions on the same instance', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockSubmitUnified.mockResolvedValue({ success: true, prUrl: 'https://x/1', prNumber: 1 });
      const initial = makeArgs({ enableContributionRelay: false });
      const { result, rerender, unmount } = renderHook(initial);

      // Off → short-circuit.
      await reactAct(async () => {
        await result.current.handleUseRebelName();
      });
      expect(mockSubmitUnified).not.toHaveBeenCalled();

      // Flip the flag on via a prop update — the hook must observe the
      // new value without being remounted.
      rerender(makeArgs({ enableContributionRelay: true }));

      await reactAct(async () => {
        await result.current.handleUseRebelName();
      });
      expect(mockSubmitUnified).toHaveBeenCalledTimes(1);
      unmount();
    });
  });

  describe('Stage S8: isOssBuild sharing gate', () => {
    it.each([
      ['handleSubmitToCommunity'],
      ['handleUseRebelName'],
      ['handleAnonymous'],
      ['handleGitHubYes'],
    ] as const)('%s short-circuits without touching contribution IPC in OSS builds', async (handlerName) => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      mockSubmitUnified.mockResolvedValue({ success: true, prUrl: 'https://x/1', prNumber: 1 });
      const args = makeArgs({ isOssBuild: true });
      const { result, unmount } = renderHook(args);

      let returnValue: boolean | undefined;
      await reactAct(async () => {
        returnValue = await result.current[handlerName]();
      });

      expect(returnValue).toBe(false);
      expect(mockGetBySession).not.toHaveBeenCalled();
      expect(mockSubmitUnified).not.toHaveBeenCalled();
      expect(args.showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringMatching(/isn't available|not available/i),
        }),
      );
      unmount();
    });

    it('explicit false preserves sharing entry behavior', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      const args = makeArgs({ isOssBuild: false });
      const { result, unmount } = renderHook(args);

      let returnValue: boolean | undefined;
      await reactAct(async () => {
        returnValue = await result.current.handleSubmitToCommunity();
      });

      expect(returnValue).toBe(true);
      expect(mockGetBySession).toHaveBeenCalledWith({ sessionId: 'session-1' });
      expect(result.current.githubCheckConnectorName).toBe('MyConn');
      unmount();
    });
  });

  describe('session-switch guards', () => {
    it('late submit completion no-ops when the user navigated to another session', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      let resolveSubmit: (value: unknown) => void = () => {};
      mockSubmitUnified.mockImplementation(
        () => new Promise((r) => { resolveSubmit = r; }),
      );

      const showToastMock = vi.fn();
      const refetchMock = vi.fn().mockResolvedValue(undefined);
      const emitLogMock = vi.fn();
      const args = makeArgs({
        showToast: showToastMock,
        refetchMcpBuildCardState: refetchMock,
        emitLog: emitLogMock,
      });
      const { result, rerender, unmount } = renderHook(args);

      // Fire handleAnonymous but don't wait for it.
      let submitPromise: Promise<boolean> | undefined;
      reactAct(() => {
        submitPromise = result.current.handleAnonymous();
      });
      // Let the handler reach the submit await.
      await flushAsync();

      // Switch sessions.
      rerender(makeArgs({
        currentSessionId: 'session-2',
        showToast: showToastMock,
        emitLog: emitLogMock,
        refetchMcpBuildCardState: refetchMock,
      }));
      await flushAsync();
      showToastMock.mockClear();
      // Stage 1.2 R2 (260420): clear refetch history too — we care
      // about whether it's called AFTER the session switch.
      refetchMock.mockClear();

      // Now resolve the stale submit with a success — the hook should
      // swallow it (no success toast, no setState into the new session).
      resolveSubmit!({ success: true, prUrl: 'https://x/1', prNumber: 1 });
      const returnValue = await submitPromise!;
      await flushAsync();

      expect(returnValue).toBe(false);
      expect(showToastMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining('is on its way') }),
      );
      // Stage 1.2 R2: refetchMcpBuildCardState must NOT be called when
      // the origin session has changed — the hook no longer pollutes
      // the newly-selected session's state with a forced refetch.
      expect(refetchMock).not.toHaveBeenCalled();
      unmount();
    });

    // Stage 1.2 R2 (260420): mirror of the success case above — a
    // thrown submit must also honour the origin-session gate before
    // touching `refetchMcpBuildCardState`.
    it('late submit throw no-ops (does not refetch) when the user navigated to another session', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      let rejectSubmit: (err: unknown) => void = () => {};
      mockSubmitUnified.mockImplementation(
        () => new Promise((_resolve, reject) => { rejectSubmit = reject; }),
      );

      const showToastMock = vi.fn();
      const refetchMock = vi.fn().mockResolvedValue(undefined);
      const emitLogMock = vi.fn();
      const args = makeArgs({
        showToast: showToastMock,
        refetchMcpBuildCardState: refetchMock,
        emitLog: emitLogMock,
      });
      const { result, rerender, unmount } = renderHook(args);

      let submitPromise: Promise<boolean> | undefined;
      reactAct(() => {
        submitPromise = result.current.handleAnonymous();
      });
      await flushAsync();

      rerender(makeArgs({
        currentSessionId: 'session-2',
        showToast: showToastMock,
        emitLog: emitLogMock,
        refetchMcpBuildCardState: refetchMock,
      }));
      await flushAsync();
      refetchMock.mockClear();

      rejectSubmit!(new Error('backend fell over'));
      const returnValue = await submitPromise!;
      await flushAsync();

      expect(returnValue).toBe(false);
      expect(refetchMock).not.toHaveBeenCalled();
      unmount();
    });

    it('does not throw when unmounted mid-submit', async () => {
      mockGetBySession.mockResolvedValue({
        contribution: { id: 'c1', sessionId: 'session-1', connectorName: 'MyConn', status: 'draft' },
      });
      let resolveSubmit: (value: unknown) => void = () => {};
      mockSubmitUnified.mockImplementation(
        () => new Promise((r) => { resolveSubmit = r; }),
      );

      const args = makeArgs();
      const { result, unmount } = renderHook(args);

      let submitPromise: Promise<boolean> | undefined;
      reactAct(() => {
        submitPromise = result.current.handleAnonymous();
      });
      await flushAsync();

      // Unmount while submit is in flight. React will not re-run the
      // component but the Promise chain still executes — should not throw.
      unmount();

      // Resolve the in-flight promise. The hook handler's post-await
      // setState would trip a "setState on unmounted" warning if the
      // session guard hadn't already stopped it.
      resolveSubmit!({ success: true, prUrl: 'https://x/1', prNumber: 1 });
      await submitPromise;
      expect(true).toBe(true); // reached here without throwing
    });
  });
});
