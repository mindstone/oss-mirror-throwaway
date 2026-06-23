// cloud-client/src/hooks/useDraftPreservingSend.ts
//
// Event-driven online-send draft preservation.
//
// PROBLEM
// ---------
// Today, the mobile conversation send path is fire-and-forget:
//
//   1) setInput('');  2) startTurn(...);  3) clearAttachments();
//
// If `startTurn`'s WebSocket throws or closes before the server has
// acknowledged the turn (i.e. before `activeTurnId` is set), the composer
// has already been wiped — the user's prompt is lost.
//
// WHY NOT A TIME WINDOW?
// -----------------------
// An arbitrary "restore if error fires within 1.5s" heuristic is brittle:
//   - It can miss late failures that still happen before ack.
//   - It can restore over a message the user already retried manually.
//   - It can fire spuriously for the previous turn's error.
//
// THIS HOOK
// ---------
// Event-based latch with explicit guards:
//
//   - Each send gets a unique `attemptId`.
//   - `activeTurnId: null -> non-null` during an active attempt window
//       => CLEAR the snapshot (server accepted; prompt is visible optimistically).
//   - `error` transitions AND `activeTurnId` never fired for this attempt
//       => RESTORE the snapshot (pre-ack failure).
//   - If the composer's revision (incremented on user input) has changed since
//     the attempt started, RESTORE is skipped to avoid clobbering user edits.
//   - On unmount, all pending attempts are discarded.
//
// HOW TO WIRE
// ----------
// Callsite pattern (React Native / web):
//
//   const { beginSendAttempt, noteUserEdit } = useDraftPreservingSend({
//     activeTurnId,
//     error,
//     getComposerSnapshot: () => ({ input, attachments }),
//     onRestore: (snapshot) => {
//       setInput(snapshot.input);
//       restoreAttachments(snapshot.attachments);
//       showToast("Didn't send — restored your draft.");
//     },
//   });
//
//   function handleSend() {
//     const attempt = beginSendAttempt();
//     setInput(''); clearAttachments();
//     startTurn(id, prompt, atts);
//     void attempt.done; // optional — for tests
//   }
//
//   // When the user types into the composer:
//   <TextInput onChangeText={(v) => { setInput(v); noteUserEdit(); }} />
//
// OUT OF SCOPE
// ------------
//   - `RECOVERY_EXHAUSTION_ERROR` (fires after `activeTurnId` was set). The
//     prompt is already visible in optimistic messages by then, so we don't
//     try to "resurrect" the composer. useAgentTurn's normal error-display
//     and retry affordance handles that case.
//
//   - `sendAndDoneInBackground()` uses an independent socket and navigates
//     away before the result — callers wire it separately via a dedicated
//     `sendAndDoneInBackground` failure callback (see
//     `mobile/src/utils/sendAndDone.ts`). That path doesn't go through this
//     hook.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createLogger } from '../utils/logger';

const log = createLogger('useDraftPreservingSend');

export interface DraftSnapshot<Att> {
  input: string;
  attachments: Att[];
}

export interface UseDraftPreservingSendOptions<Att> {
  /** Live value from useAgentTurn().activeTurnId */
  activeTurnId: string | null;
  /** Live value from useAgentTurn().error */
  error: string | null;
  /**
   * Live value from useAgentTurn().isSending. Used to detect the "silent clear"
   * path where the turn WS errors/closes pre-ack and useAgentTurn clears state
   * without setting an error (e.g., socket close after session-status recovery
   * finds the session is not busy).
   */
  isSending: boolean;
  /** Returns the composer contents at the moment a send is begun */
  getComposerSnapshot: () => DraftSnapshot<Att>;
  /** Called when restore is appropriate. Caller decides UX (toast, etc.) */
  onRestore: (snapshot: DraftSnapshot<Att>, reason: 'error' | 'silent-clear') => void;
}

export interface SendAttemptHandle {
  /** Stable ID for this attempt. Tests / logs can reference it. */
  attemptId: string;
  /** Promise that resolves when the attempt is cleared, restored, or unmounted. */
  done: Promise<'cleared' | 'restored' | 'aborted'>;
  /**
   * Manually abort the attempt (caller decided not to restore anyway,
   * e.g. user navigated away). Resolves `done` with 'aborted'.
   */
  abort: () => void;
}

export interface UseDraftPreservingSendReturn<Att = unknown> {
  /**
   * Call BEFORE clearing the composer. Returns an `attemptId` + `done` promise.
   * The hook will either clear the snapshot (on `activeTurnId` set) or restore
   * it (on error without activeTurnId set).
   *
   * Pass an explicit `override` to snapshot a value that isn't currently in
   * the composer (e.g. a voice transcript that is being sent straight through
   * without the user ever seeing it in the composer). Without an override,
   * the hook uses `getComposerSnapshot()`.
   */
  beginSendAttempt: (override?: DraftSnapshot<Att>) => SendAttemptHandle;
  /**
   * Call when the user edits the composer. Prevents restore from clobbering
   * the user's subsequent input.
   */
  noteUserEdit: () => void;
  /** True when at least one attempt is currently pending. Useful for tests. */
  hasPendingAttempt: () => boolean;
}

interface PendingAttempt<Att> {
  attemptId: string;
  startedRevision: number;
  snapshot: DraftSnapshot<Att>;
  resolve: (v: 'cleared' | 'restored' | 'aborted') => void;
  /** True once this attempt has been settled (any outcome). */
  settled: boolean;
}

let attemptCounter = 0;
function nextAttemptId(): string {
  attemptCounter += 1;
  return `send-${Date.now().toString(36)}-${attemptCounter.toString(36)}`;
}

export function useDraftPreservingSend<Att>(
  options: UseDraftPreservingSendOptions<Att>,
): UseDraftPreservingSendReturn<Att> {
  const { activeTurnId, error, isSending, getComposerSnapshot, onRestore } = options;

  // Keep callbacks in refs so we don't need stable identity from callers.
  const getSnapshotRef = useRef(getComposerSnapshot);
  getSnapshotRef.current = getComposerSnapshot;
  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;

  // Live ref to observe turn state inside the transition watcher.
  const activeTurnIdRef = useRef<string | null>(activeTurnId);

  const pendingRef = useRef<PendingAttempt<Att>[]>([]);
  const revisionRef = useRef(0);
  const lastObservedErrorRef = useRef<string | null>(error);
  const lastObservedIsSendingRef = useRef<boolean>(isSending);
  const mountedRef = useRef(true);

  // Track unmount so we can drain pending attempts without clobbering composers.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const p of pendingRef.current) {
        if (!p.settled) p.resolve('aborted');
      }
      pendingRef.current = [];
    };
  }, []);

  // CLEAR: activeTurnId null -> non-null during an attempt window.
  useEffect(() => {
    const prev = activeTurnIdRef.current;
    activeTurnIdRef.current = activeTurnId;
    if (activeTurnId && !prev && pendingRef.current.length > 0) {
      // Server accepted the turn. Every in-flight attempt is cleared —
      // the prompt now lives in the optimistic message list.
      const cleared = pendingRef.current;
      pendingRef.current = [];
      for (const p of cleared) {
        if (!p.settled) {
          log.info('Draft attempt cleared by activeTurnId', { attemptId: p.attemptId });
          p.resolve('cleared');
        }
      }
    }
  }, [activeTurnId]);

  // Shared restore helper.
  const runRestore = useCallback((reason: 'error' | 'silent-clear') => {
    if (!mountedRef.current) return;
    if (pendingRef.current.length === 0) return;
    if (activeTurnIdRef.current) {
      // Turn was acknowledged. Let the caller's normal error-display handle it.
      return;
    }
    const victim = pendingRef.current.shift();
    if (!victim || victim.settled) return;

    if (victim.startedRevision !== revisionRef.current) {
      // The user typed in the composer after the send began. Don't clobber.
      log.info('Draft restore skipped — composer edited since attempt', {
        attemptId: victim.attemptId,
        startedRevision: victim.startedRevision,
        currentRevision: revisionRef.current,
        reason,
      });
      victim.resolve('cleared');
      return;
    }

    try {
      onRestoreRef.current(victim.snapshot, reason);
      log.info('Draft restored', { attemptId: victim.attemptId, reason });
    } catch (err) {
      log.error('onRestore threw', { attemptId: victim.attemptId, error: err instanceof Error ? err.message : String(err) });
    }
    victim.resolve('restored');
  }, []);

  // RESTORE (error path): error transition while no activeTurnId has been set
  // for any currently-pending attempt.
  useEffect(() => {
    const prevError = lastObservedErrorRef.current;
    lastObservedErrorRef.current = error;
    if (!error || error === prevError) return;
    runRestore('error');
  }, [error, runRestore]);

  // RESTORE (silent-clear path): useAgentTurn sometimes clears sending state
  // without setting `error` — specifically when the WS errors/closes pre-ack
  // and checkAndUpdateSessionStatus() finds the session is not busy. In that
  // case, `isSending` transitions true -> false while `activeTurnId` is still
  // null and `error` is still null. Without this, the draft would be silently
  // lost. We fire runRestore on the same-tick transition; the activeTurnId
  // effect (if it also fires in this tick) runs first and settles the attempt.
  useEffect(() => {
    const prevIsSending = lastObservedIsSendingRef.current;
    lastObservedIsSendingRef.current = isSending;
    if (!prevIsSending || isSending) return;
    // Transitioned true -> false. If activeTurnId is set, the cleared path
    // already handled this in its effect (same tick). If an error is set,
    // the error effect will handle it. Guard against those so we only fire
    // for the truly-silent case.
    if (activeTurnIdRef.current) return;
    if (error) return;
    runRestore('silent-clear');
  }, [isSending, error, runRestore]);

  const beginSendAttempt = useCallback<UseDraftPreservingSendReturn<Att>['beginSendAttempt']>((override) => {
    const attemptId = nextAttemptId();
    const snapshot: DraftSnapshot<Att> = override ?? getSnapshotRef.current();
    const startedRevision = revisionRef.current;

    let resolveFn: (v: 'cleared' | 'restored' | 'aborted') => void = () => {};
    const done = new Promise<'cleared' | 'restored' | 'aborted'>((resolve) => {
      resolveFn = resolve;
    });

    const entry: PendingAttempt<Att> = {
      attemptId,
      startedRevision,
      snapshot,
      resolve: (v) => {
        if (entry.settled) return;
        entry.settled = true;
        resolveFn(v);
      },
      settled: false,
    };
    pendingRef.current.push(entry);

    log.info('Draft attempt begun', {
      attemptId,
      inputLen: snapshot.input.length,
      attachmentCount: snapshot.attachments.length,
    });

    return {
      attemptId,
      done,
      abort: () => {
        if (entry.settled) return;
        pendingRef.current = pendingRef.current.filter((e) => e !== entry);
        entry.resolve('aborted');
      },
    };
  }, []);

  const noteUserEdit = useCallback(() => {
    revisionRef.current += 1;
  }, []);

  const hasPendingAttempt = useCallback(() => pendingRef.current.length > 0, []);

  return useMemo(
    () => ({ beginSendAttempt, noteUserEdit, hasPendingAttempt }),
    [beginSendAttempt, noteUserEdit, hasPendingAttempt],
  );
}
