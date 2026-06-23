/**
 * useDraftPreservingSend hook tests.
 *
 * Verifies the event-based latch: snapshot on beginSendAttempt, clear on
 * activeTurnId null->non-null, restore on error before activeTurnId is set,
 * plus guards (user edits, unmount, manual override).
 */

import { renderHook, act } from '@testing-library/react';
import { useDraftPreservingSend } from '../hooks/useDraftPreservingSend';

// Shape mirroring `WebFileAttachment` minimally — we don't care about the full type.
interface MockAtt { id: string; name: string }

describe('useDraftPreservingSend', () => {
  function setup(overrides?: {
    initialInput?: string;
    initialAttachments?: MockAtt[];
    onRestore?: (snapshot: { input: string; attachments: MockAtt[] }, reason: 'error' | 'silent-clear') => void;
  }) {
    let activeTurnId: string | null = null as string | null;
    let error: string | null = null as string | null;
    let isSending = false;
    let input = overrides?.initialInput ?? 'hello world';
    let attachments = overrides?.initialAttachments ?? [];
    const restoreSpy = vi.fn(overrides?.onRestore ?? (() => {}));

    type Props = { turnId: string | null; err: string | null; sending: boolean };
    const hook = renderHook(
      ({ turnId, err, sending }: Props) =>
        useDraftPreservingSend<MockAtt>({
          activeTurnId: turnId,
          error: err,
          isSending: sending,
          getComposerSnapshot: () => ({ input, attachments }),
          onRestore: restoreSpy,
        }),
      { initialProps: { turnId: activeTurnId, err: error, sending: isSending } as Props },
    );

    const rerender = () => hook.rerender({ turnId: activeTurnId, err: error, sending: isSending });

    return {
      hook,
      restoreSpy,
      setInput: (v: string) => { input = v; },
      setAttachments: (v: MockAtt[]) => { attachments = v; },
      setTurnId: (v: string | null) => { activeTurnId = v; rerender(); },
      setError: (v: string | null) => { error = v; rerender(); },
      setIsSending: (v: boolean) => { isSending = v; rerender(); },
    };
  }

  it('begins an attempt and reports one pending', () => {
    const { hook } = setup();

    act(() => { hook.result.current.beginSendAttempt(); });

    expect(hook.result.current.hasPendingAttempt()).toBe(true);
  });

  it('clears pending attempts when activeTurnId transitions null -> non-null', async () => {
    const { hook, setTurnId, restoreSpy } = setup();

    let attemptPromise: Promise<'cleared' | 'restored' | 'aborted'> | null = null;
    act(() => {
      const attempt = hook.result.current.beginSendAttempt();
      attemptPromise = attempt.done;
    });
    expect(hook.result.current.hasPendingAttempt()).toBe(true);

    act(() => { setTurnId('turn-abc'); });

    await expect(attemptPromise!).resolves.toBe('cleared');
    expect(hook.result.current.hasPendingAttempt()).toBe(false);
    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it('restores the snapshot on error when activeTurnId was never set', async () => {
    const { hook, setError, restoreSpy } = setup({
      initialInput: 'pre-send draft',
      initialAttachments: [{ id: 'a1', name: 'file.png' }],
    });

    let attemptPromise: Promise<'cleared' | 'restored' | 'aborted'> | null = null;
    act(() => {
      const attempt = hook.result.current.beginSendAttempt();
      attemptPromise = attempt.done;
    });

    act(() => { setError('Connection issue. Check your internet and try again.'); });

    await expect(attemptPromise!).resolves.toBe('restored');
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(restoreSpy).toHaveBeenCalledWith(
      { input: 'pre-send draft', attachments: [{ id: 'a1', name: 'file.png' }] },
      'error',
    );
  });

  it('does NOT restore when error fires after activeTurnId was set', async () => {
    const { hook, setTurnId, setError, restoreSpy } = setup();

    act(() => { hook.result.current.beginSendAttempt(); });
    act(() => { setTurnId('turn-abc'); });
    // Attempt is now cleared. A subsequent error should not resurrect anything.
    act(() => { setError('RECOVERY_EXHAUSTION'); });

    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it('skips restore when the composer has been edited since the attempt began', async () => {
    const { hook, setError, restoreSpy } = setup();

    let attemptPromise: Promise<'cleared' | 'restored' | 'aborted'> | null = null;
    act(() => {
      const attempt = hook.result.current.beginSendAttempt();
      attemptPromise = attempt.done;
    });

    // User types into composer
    act(() => { hook.result.current.noteUserEdit(); });

    act(() => { setError('Connection issue'); });

    await expect(attemptPromise!).resolves.toBe('cleared');
    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it('uses an explicit snapshot override instead of the composer state (voice transcript path)', async () => {
    const { hook, setError, restoreSpy } = setup({
      initialInput: '', // composer is empty at send time (voice went straight through)
    });

    let attemptPromise: Promise<'cleared' | 'restored' | 'aborted'> | null = null;
    act(() => {
      const attempt = hook.result.current.beginSendAttempt({
        input: 'voice transcript text',
        attachments: [],
      });
      attemptPromise = attempt.done;
    });

    act(() => { setError('Network error'); });

    await expect(attemptPromise!).resolves.toBe('restored');
    expect(restoreSpy).toHaveBeenCalledWith(
      { input: 'voice transcript text', attachments: [] },
      'error',
    );
  });

  it('aborts pending attempts on unmount without calling onRestore', () => {
    const { hook, restoreSpy } = setup();

    act(() => { hook.result.current.beginSendAttempt(); });
    hook.unmount();

    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it('supports manual abort()', async () => {
    const { hook } = setup();

    let attemptPromise: Promise<'cleared' | 'restored' | 'aborted'> | null = null;
    let abortFn: (() => void) | null = null;
    act(() => {
      const attempt = hook.result.current.beginSendAttempt();
      attemptPromise = attempt.done;
      abortFn = attempt.abort;
    });

    act(() => { abortFn!(); });

    await expect(attemptPromise!).resolves.toBe('aborted');
    expect(hook.result.current.hasPendingAttempt()).toBe(false);
  });

  it('handles multiple concurrent attempts — clears all on activeTurnId transition', async () => {
    const { hook, setTurnId } = setup();

    let promises: Promise<'cleared' | 'restored' | 'aborted'>[] = [];
    act(() => {
      promises.push(hook.result.current.beginSendAttempt().done);
      promises.push(hook.result.current.beginSendAttempt().done);
    });
    expect(hook.result.current.hasPendingAttempt()).toBe(true);

    act(() => { setTurnId('turn-1'); });

    const results = await Promise.all(promises);
    expect(results).toEqual(['cleared', 'cleared']);
  });

  it('restores only the OLDEST attempt on error (FIFO)', async () => {
    const { hook, setError, restoreSpy } = setup();

    const snapshots: Array<{ input: string }> = [];
    let promises: Promise<'cleared' | 'restored' | 'aborted'>[] = [];
    act(() => {
      // First attempt
      promises.push(hook.result.current.beginSendAttempt({ input: 'first', attachments: [] }).done);
      snapshots.push({ input: 'first' });
      // Second attempt
      promises.push(hook.result.current.beginSendAttempt({ input: 'second', attachments: [] }).done);
      snapshots.push({ input: 'second' });
    });

    act(() => { setError('boom'); });

    // First resolves as restored, second should still be pending.
    // We can't await both since the second never resolves via error — instead
    // verify the spy was called once with 'first'.
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(restoreSpy.mock.calls[0][0]).toEqual({ input: 'first', attachments: [] });

    // Second attempt still pending — abort it so nothing leaks.
    expect(hook.result.current.hasPendingAttempt()).toBe(true);
  });

  it('does not fire restore for identical error value (no transition)', () => {
    const { hook, setError, restoreSpy } = setup();

    // Starting with a pre-existing error (shouldn't fire since no transition).
    // We simulate: set error first, then begin an attempt. The begin MUST NOT
    // immediately restore.
    act(() => { setError('existing error'); });
    act(() => { hook.result.current.beginSendAttempt(); });

    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it('distinguishes consecutive errors (new error => restore)', async () => {
    const { hook, setError, restoreSpy } = setup();

    // First error happens before any attempt — should not restore.
    act(() => { setError('first error'); });

    // Begin an attempt
    let attemptPromise: Promise<'cleared' | 'restored' | 'aborted'> | null = null;
    act(() => { attemptPromise = hook.result.current.beginSendAttempt().done; });

    // Second, distinct error fires — should restore.
    act(() => { setError('second error'); });

    await expect(attemptPromise!).resolves.toBe('restored');
    expect(restoreSpy).toHaveBeenCalledTimes(1);
  });

  // Silent-clear path: useAgentTurn sometimes clears sending state without
  // setting an error (socket close + session-status recovery finds session
  // is not busy). Without handling this, the draft would be lost.
  it('restores when isSending goes true->false with no activeTurnId and no error', async () => {
    const { hook, setIsSending, restoreSpy } = setup({
      initialInput: 'silently cleared',
    });

    let attemptPromise: Promise<'cleared' | 'restored' | 'aborted'> | null = null;
    act(() => {
      attemptPromise = hook.result.current.beginSendAttempt().done;
      setIsSending(true);
    });

    // Socket closes pre-ack without error being set.
    act(() => { setIsSending(false); });

    await expect(attemptPromise!).resolves.toBe('restored');
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(restoreSpy).toHaveBeenCalledWith(
      { input: 'silently cleared', attachments: [] },
      'silent-clear',
    );
  });

  it('does NOT fire silent-clear restore when activeTurnId was set (normal clear path)', async () => {
    const { hook, setIsSending, setTurnId, restoreSpy } = setup();

    let attemptPromise: Promise<'cleared' | 'restored' | 'aborted'> | null = null;
    act(() => {
      attemptPromise = hook.result.current.beginSendAttempt().done;
      setIsSending(true);
    });

    act(() => { setTurnId('turn-abc'); });
    // Server turn completes; isSending drops.
    act(() => { setIsSending(false); });

    await expect(attemptPromise!).resolves.toBe('cleared');
    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it('does NOT double-restore when both error and isSending transitions occur', async () => {
    const { hook, setIsSending, setError, restoreSpy } = setup();

    let attemptPromise: Promise<'cleared' | 'restored' | 'aborted'> | null = null;
    act(() => {
      attemptPromise = hook.result.current.beginSendAttempt().done;
      setIsSending(true);
    });

    // Error path: error transition, then isSending drops. The error effect
    // handles restore; the silent-clear effect must see error !== null and skip.
    act(() => { setError('network error'); setIsSending(false); });

    await expect(attemptPromise!).resolves.toBe('restored');
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(restoreSpy.mock.calls[0][1]).toBe('error');
  });
});
