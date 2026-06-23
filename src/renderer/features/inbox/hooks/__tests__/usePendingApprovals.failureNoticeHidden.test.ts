// @vitest-environment happy-dom
/**
 * Regression (260618 diagnosis): a staged-tool EXECUTION FAILURE notice sent
 * via the primary `onSendContinuation` path must be hidden + stamped
 * `system-continuation`, exactly like the SUCCESS notice.
 *
 * The bug: the failure path called `onSendContinuation(sessionId, message)`
 * with NO `receiptText`, while the success path passed a receipt. Per
 * `resolveSendMessageOptions`, the receipt is the hide signal — so the failure
 * notice stayed a visible `role:'user'` message, rode the message queue, was
 * stamped `queue-drain` on drain, and rendered as an editable "YOU" bubble,
 * misattributing a system error to the user. The user already learns of the
 * failure via the returned `outcome` (toast); this transcript message exists
 * only for the agent and must not appear as user input.
 *
 * This file covers the `onSendContinuation`-present path (the real App drawer
 * surface). The fallback (`onSendContinuation` omitted) path is covered by
 * usePendingApprovals.fallbackDelivery.test.ts, which already routes the
 * failure through `dispatchAgentTurn({ isSystemContinuation: true })`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, act, flushAsync } from '@renderer/test-utils';
import { resolveSendMessageOptions } from '@renderer/utils/resolveSendMessageOptions';
import {
  usePendingApprovals,
  type PendingApprovalItem,
} from '../usePendingApprovals';

const stagedExecuteMock = vi.fn();
const stagedExecuteBatchMock = vi.fn();
const onSendContinuation = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  stagedExecuteMock.mockResolvedValue({ success: true, content: 'Email sent to bob@example.com' });
  stagedExecuteBatchMock.mockResolvedValue({ executed: [] });
  onSendContinuation.mockResolvedValue(undefined);

  vi.stubGlobal('api', {
    onToolSafetyApprovalRequest: vi.fn(() => () => undefined),
    onMemoryWriteApprovalRequest: vi.fn(() => () => undefined),
    onMemoryWriteApprovalResolved: vi.fn(() => () => undefined),
    onToolSafetyApprovalResolved: vi.fn(() => () => undefined),
    onStagedToolCall: vi.fn(() => () => undefined),
    onStagedToolCallUpdated: vi.fn(() => () => undefined),
    onStagedFilesChanged: vi.fn(() => () => undefined),
    getStagedFiles: vi.fn().mockResolvedValue({ files: [] }),
    sendMemoryWriteApprovalResponse: vi.fn().mockResolvedValue({ success: true }),
  });
  vi.stubGlobal('safetyApi', {
    pending: vi.fn().mockResolvedValue([]),
    stagedGetAll: vi.fn().mockResolvedValue([]),
    stagedExecute: stagedExecuteMock,
    stagedExecuteBatch: stagedExecuteBatchMock,
    stagedReject: vi.fn().mockResolvedValue({ success: true }),
  });
  vi.stubGlobal('memoryApi', { getPendingApprovals: vi.fn().mockResolvedValue([]) });
  vi.stubGlobal('sessionsApi', { list: vi.fn().mockResolvedValue([]) });
  vi.stubGlobal('agentApi', { turn: vi.fn().mockResolvedValue({ turnId: 'turn-1' }) });
});

const makeStagedItem = (overrides: Partial<PendingApprovalItem> = {}): PendingApprovalItem => ({
  id: 'staged-tool:st-1',
  type: 'staged-tool',
  title: 'Send email',
  description: 'Send email to Bob',
  timestamp: 1_000,
  sessionId: 'session-1',
  stagedToolCall: {
    id: 'st-1',
    displayName: 'Send email',
    mcpPayload: { packageId: 'gmail', toolId: 'send_email', args: {} },
  },
  ...overrides,
});

async function mountHook() {
  const harness = renderHook(() => usePendingApprovals({ onSendContinuation }));
  await flushAsync(); // settle the initial loadApprovals effect
  return harness;
}

/** Extract the (sessionId, message, receiptText) of the nth onSendContinuation call. */
function continuationCall(index = 0) {
  const call = onSendContinuation.mock.calls[index];
  return { sessionId: call?.[0], message: call?.[1], receiptText: call?.[2] };
}

describe('executeStagedApproval — failure notice is hidden via onSendContinuation', () => {
  it('FAILURE → continuation passes a receipt, so resolveSendMessageOptions hides it as system-continuation', async () => {
    stagedExecuteMock.mockResolvedValueOnce({ success: false, error: 'SMTP exploded' });
    const { result, unmount } = await mountHook();

    await act(async () => {
      await result.current.executeStagedApproval(makeStagedItem());
    });

    expect(onSendContinuation).toHaveBeenCalledTimes(1);
    const { message, receiptText } = continuationCall();

    // The full error goes to the agent in the message body…
    expect(message).toContain('Failed to execute: Send email');
    expect(message).toContain('SMTP exploded');

    // …and a receipt is supplied — THE regression. (Pre-fix this was undefined.)
    expect(receiptText).toBe('Failed to execute: Send email');

    // Tie the receipt to the actual visibility outcome: a receiptText forces
    // the message hidden + stamped system-continuation, so it never renders as
    // an editable "YOU" bubble.
    const resolved = resolveSendMessageOptions({ receiptText });
    expect(resolved).toEqual({ shouldHide: true, messageOrigin: 'system-continuation' });

    unmount();
  });

  it('regression guard: SUCCESS notice also passes a receipt (unchanged) and resolves to hidden', async () => {
    const { result, unmount } = await mountHook();

    await act(async () => {
      await result.current.executeStagedApproval(makeStagedItem());
    });

    expect(onSendContinuation).toHaveBeenCalledTimes(1);
    const { receiptText } = continuationCall();
    expect(receiptText).toBe('Executed: Send email');
    expect(resolveSendMessageOptions({ receiptText })).toEqual({
      shouldHide: true,
      messageOrigin: 'system-continuation',
    });

    unmount();
  });
});
