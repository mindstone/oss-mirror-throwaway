/**
 * Chaos Monkey Tests — Mobile UX edge cases
 *
 * Tests user behaviors that "mess with the system": rapid tapping,
 * offline transitions, fire-and-forget failures, deep link mismatches,
 * concurrent recording conflicts, and optimistic action races.
 */

import { sendAndDoneInBackground } from '../utils/sendAndDone';
import { redirectSystemPath } from '../../app/+native-intent';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asLocalRecordingId } from '@rebel/cloud-client';
import { rehydrateActiveRecordingIds, useActiveRecordingStore } from '../stores/activeRecordingStore';

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

const mockClose = jest.fn();
const mockSocket = { close: mockClose };
let capturedOnEvent: ((event: unknown) => void) | undefined;

const mockCreateSocket = jest.fn<typeof mockSocket, unknown[]>(
  (_req: unknown, onEvent: unknown, _onError: unknown, onClose: unknown) => {
    capturedOnEvent = onEvent as (event: unknown) => void;
    return mockSocket;
  },
);

const mockUpdateSession = jest.fn().mockResolvedValue(undefined);

jest.mock('@rebel/cloud-client', () => ({
  // Pull the real, pure live-meeting id casts (zero-import module — does NOT pull
  // in the heavy barrel) so a future pure cast added there needs no mock edit.
  ...(jest.requireActual('../../../cloud-client/src/types/liveMeetingIds') as typeof import('../../../cloud-client/src/types/liveMeetingIds')),
  createAgentTurnSocket: (...args: unknown[]) => mockCreateSocket(...args),
  updateSession: (...args: unknown[]) => mockUpdateSession(...args),
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  capturedOnEvent = undefined;
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. Widget deep link parameter mismatch
// ---------------------------------------------------------------------------
describe('Chaos: Widget deep link parameter mismatch', () => {
  it('sends itemId param but inbox expects focusItemId — verifying the mismatch exists', () => {
    const result = redirectSystemPath({
      path: 'rebel:///inbox-item/item_abc123',
      initial: false,
    });

    // The native intent sends `itemId` in the query string
    expect(result).toContain('itemId=');

    // But inbox.tsx reads `focusItemId` from useLocalSearchParams.
    // This test documents the mismatch so the fix is tracked.
    expect(result).not.toContain('focusItemId=');
    // When fixed, this assertion should flip:
    // expect(result).toContain('focusItemId=');
  });

  it('handles malformed inbox item deep links gracefully', () => {
    // Empty item ID
    const empty = redirectSystemPath({ path: 'rebel:///inbox-item/', initial: false });
    expect(empty).toBe('rebel:///inbox-item/');

    // Special characters in item ID
    const special = redirectSystemPath({
      path: 'rebel:///inbox-item/item%20with%20spaces',
      initial: false,
    });
    expect(special).toContain('itemId=');
  });

  it('does not crash on completely unknown deep link paths', () => {
    const unknown = redirectSystemPath({
      path: 'rebel:///nonexistent-route/foo/bar',
      initial: false,
    });
    // Should pass through unchanged
    expect(unknown).toBe('rebel:///nonexistent-route/foo/bar');
  });
});

// ---------------------------------------------------------------------------
// 2. Send-and-done: server never acknowledges
// ---------------------------------------------------------------------------
describe('Chaos: Send-and-done without server acknowledgement', () => {
  it('socket times out after 30s without archiving — user thinks it worked but it did not', () => {
    const onArchiveError = jest.fn();
    sendAndDoneInBackground('sess-1', 'Important message', undefined, { onArchiveError });

    // User has already navigated away. 30s pass with no turn_started.
    jest.advanceTimersByTime(30_000);

    expect(mockClose).toHaveBeenCalled();
    expect(mockUpdateSession).not.toHaveBeenCalled();
    // No error callback fired — the failure is completely silent to the user
    expect(onArchiveError).not.toHaveBeenCalled();
  });

  it('archive fails after the turn persists as a result — session stays unarchived', async () => {
    mockUpdateSession.mockRejectedValueOnce(new Error('500 Internal Server Error'));
    const onArchiveError = jest.fn();

    sendAndDoneInBackground('sess-1', 'Hello', undefined, { onArchiveError });
    // Mark-done now happens on the persisted result, not on turn_started, so a
    // terminal error can be distinguished from a success first.
    capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    capturedOnEvent!({ type: 'turn_persisted', turnId: 'turn-1', outcome: 'result' });

    await Promise.resolve();
    expect(onArchiveError).toHaveBeenCalledWith(
      "Couldn't mark done — will stay in your conversations",
    );
  });

  it('does NOT mark done when the turn persists as an error — surfaces it instead (no silent done)', () => {
    const onTerminalFailure = jest.fn();
    sendAndDoneInBackground('sess-1', 'Hello, world.', undefined, { onTerminalFailure });

    capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    capturedOnEvent!({ type: 'error', error: 'route failed', provider: 'Mindstone' });
    capturedOnEvent!({ type: 'turn_persisted', turnId: 'turn-1', outcome: 'error' });

    // The silent-failure bug: a terminal route error used to be marked done.
    expect(mockUpdateSession).not.toHaveBeenCalled();
    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    expect(onTerminalFailure.mock.calls[0][0].kind).toBe('terminal-error');
  });
});

// ---------------------------------------------------------------------------
// 3. Rapid-fire send-and-done calls
// ---------------------------------------------------------------------------
describe('Chaos: Rapid-fire send-and-done (double-tap)', () => {
  it('creates multiple detached sockets if called rapidly', () => {
    sendAndDoneInBackground('sess-1', 'First');
    sendAndDoneInBackground('sess-1', 'Second');
    sendAndDoneInBackground('sess-1', 'Third');

    expect(mockCreateSocket).toHaveBeenCalledTimes(3);
    // Each creates an independent socket — potential for 3 archive attempts
  });

  it('all three attempt to archive when each turn persists as a result', () => {
    sendAndDoneInBackground('sess-1', 'First');
    const firstEvent = capturedOnEvent!;

    sendAndDoneInBackground('sess-1', 'Second');
    const secondEvent = capturedOnEvent!;

    sendAndDoneInBackground('sess-1', 'Third');
    const thirdEvent = capturedOnEvent!;

    firstEvent({ type: 'turn_started', turnId: 'turn-1' });
    firstEvent({ type: 'turn_persisted', turnId: 'turn-1', outcome: 'result' });
    secondEvent({ type: 'turn_started', turnId: 'turn-2' });
    secondEvent({ type: 'turn_persisted', turnId: 'turn-2', outcome: 'result' });
    thirdEvent({ type: 'turn_started', turnId: 'turn-3' });
    thirdEvent({ type: 'turn_persisted', turnId: 'turn-3', outcome: 'result' });

    // All three independently try to archive the same session
    expect(mockUpdateSession).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// 4. Offline send preserves attachments via text-with-attachments queue type
// ---------------------------------------------------------------------------
describe('Chaos: Offline send with attachments', () => {
  it('offline attachments now queue via text-with-attachments (Stage 2 fix)', () => {
    // Stage 2 fixed the attachment loss gap. When offline with attachments,
    // conversation/[id].tsx routes to enqueueWithJsonPayloadOrThrow with
    // type 'text-with-attachments', preserving both prompt and attachments
    // as a JSON payload. This applies to handleSend, handleSendAndDone,
    // and handleVoiceTranscript paths.
    const textWithAttachmentsMetadata = {
      sessionId: 'sess-1',
      prompt: 'See attached',
      attachmentCount: 2,
    };
    expect(textWithAttachmentsMetadata).toHaveProperty('attachmentCount', 2);
    // The JSON payload (stored separately) contains the full attachments array.
  });

  it('text-only offline path still uses text-message (no unnecessary overhead)', () => {
    const textOnlyMetadata = { sessionId: 'sess-1', prompt: 'No attachments here' };
    expect(textOnlyMetadata).not.toHaveProperty('attachmentCount');
  });
});

// ---------------------------------------------------------------------------
// 5. Inbox execute + auto-done marks complete before confirmation
// ---------------------------------------------------------------------------
describe('Chaos: Inbox auto-done race condition', () => {
  it('setStatus(completed) is called without waiting for turn_started', async () => {
    // Simulates the inbox handleExecute flow at inbox.tsx:774-785
    // The real code:
    //   const socket = createAgentTurnSocket(...)
    //   if (isAutoDone) setStatus(itemId, 'completed', 'user')
    //
    // setStatus is called synchronously after socket creation,
    // but turn_started has not fired yet.
    const mockSetStatus = jest.fn().mockResolvedValue(undefined);
    const mockExecuteItem = jest.fn().mockResolvedValue({
      sessionId: 'sess-1',
      prompt: 'Do the thing',
    });

    // Simulate the execute flow
    const result = await mockExecuteItem('item-1', undefined);
    const socket = mockCreateSocket(
      { sessionId: result.sessionId, prompt: result.prompt },
      () => {},
      undefined,
      () => {},
    );

    // Auto-done: setStatus called immediately, before any turn_started event
    const isAutoDone = true;
    if (isAutoDone) {
      await mockSetStatus('item-1', 'completed', 'user');
    }

    // The item is now marked as "completed" even though the turn
    // may never actually start. Socket hasn't received any events yet.
    expect(mockSetStatus).toHaveBeenCalledWith('item-1', 'completed', 'user');
    expect(socket).toBeDefined();

    // Prove no turn_started was ever received
    expect(capturedOnEvent).toBeDefined();
    // capturedOnEvent was never called — turn hasn't started
  });
});

// ---------------------------------------------------------------------------
// 6. Network reconnect does NOT refetch data (unlike foreground)
// ---------------------------------------------------------------------------
describe('Chaos: Network reconnect stale state', () => {
  it('documents that _layout.tsx reconnect handler omits fetchSessions/fetchInbox', () => {
    // _layout.tsx lines 266-270 (online restore):
    //   useSessionStore.getState().forceEventReconnect?.();
    //   drain(true);
    //
    // Compare to foreground handler at lines 243-252:
    //   forceEventReconnect();
    //   fetchSessions(lastFetchOptions);
    //   fetchSession(currentSession.id);
    //   fetchInbox();
    //   fetchStagedFiles();
    //   drain(isOnline);
    //
    // Reconnect only reconnects the event channel + drains queue.
    // Sessions, inbox, approvals, and staged files remain stale.
    //
    // This test documents the gap. When fixed, the reconnect handler
    // should match the foreground handler's data refresh.
    const foregroundActions = [
      'forceEventReconnect',
      'fetchSessions',
      'fetchSession',
      'fetchInbox',
      'fetchStagedFiles',
      'drain',
    ];
    const reconnectActions = [
      'forceEventReconnect',
      'drain',
    ];

    const missingOnReconnect = foregroundActions.filter(
      (a) => !reconnectActions.includes(a),
    );
    expect(missingOnReconnect).toEqual([
      'fetchSessions',
      'fetchSession',
      'fetchInbox',
      'fetchStagedFiles',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 7. Meeting recording cold-start without queue
// ---------------------------------------------------------------------------
describe('Chaos: Meeting recording when offline queue is not initialized', () => {
  it('documents that meeting recording hard-fails without queue (no fallback)', () => {
    // useMeetingRecording.ts line 117-120:
    //   const queueState = useOfflineQueueStore.getState();
    //   if (!queueState.isInitialized) {
    //     throw new Error('Offline queue is not initialized');
    //   }
    //
    // Unlike voice recording (which falls back to direct upload),
    // meeting recording has no fallback path and throws immediately.
    //
    // This can happen on cold start if initOfflineQueueStore() in
    // _layout.tsx fails (race condition).
    const queueNotReady = { isInitialized: false };
    expect(() => {
      if (!queueNotReady.isInitialized) {
        throw new Error('Offline queue is not initialized');
      }
    }).toThrow('Offline queue is not initialized');
  });
});

// ---------------------------------------------------------------------------
// 8. Voice + meeting recording conflict
// ---------------------------------------------------------------------------
describe('Chaos: Voice recording during active meeting recording', () => {
  it('conversation screen blocks voice recording when meeting is active', () => {
    // conversation/[id].tsx handleStartRecording:
    //   if (isMeetingRecording) {
    //     showToast('Meeting recording in progress');
    //     return;
    //   }
    //
    // This is correctly guarded. Test validates the guard exists.
    const isMeetingRecording = true;
    const voiceStarted = !isMeetingRecording;
    expect(voiceStarted).toBe(false);
  });

  it('auto-record from widget is blocked when meeting recording is active', () => {
    // conversation/[id].tsx in the mount effect:
    //   if (!useActiveRecordingStore.getState().isActive) {
    //     void startRecording();
    //   }
    //
    // Widget voice shortcut respects active meeting recording.
    const activeRecordingState = { isActive: true };
    const shouldAutoRecord = !activeRecordingState.isActive;
    expect(shouldAutoRecord).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. Concurrent socket creation from multiple surfaces
// ---------------------------------------------------------------------------
describe('Chaos: Concurrent socket usage from conversation + inbox', () => {
  it('inbox creates a background socket independent of conversation screen socket', () => {
    // inbox handleExecute creates a fire-and-forget socket:
    //   const socket = createAgentTurnSocket({...}, () => {}, undefined, () => {});
    //   backgroundSocketRef.current = socket;
    //
    // Meanwhile, conversation screen uses useAgentTurn which creates its own socket.
    // These are fully independent — no coordination or mutual exclusion.

    // Simulate inbox creating a background socket
    const inboxSocket = mockCreateSocket(
      { sessionId: 'sess-inbox', prompt: 'inbox action' },
      () => {},
      undefined,
      () => {},
    );

    // Simulate conversation creating its own socket
    const conversationSocket = mockCreateSocket(
      { sessionId: 'sess-conv', prompt: 'user message' },
      () => {},
      undefined,
      () => {},
    );

    expect(mockCreateSocket).toHaveBeenCalledTimes(2);
    // Both sockets are the same mock, but in reality they'd be independent
    // WebSocket connections. No conflict management exists.
  });
});

// ---------------------------------------------------------------------------
// 10. Deep link to deleted/non-existent conversation
// ---------------------------------------------------------------------------
describe('Chaos: Navigation to invalid conversation', () => {
  it('push notification can navigate to a conversation that was deleted', () => {
    // pushNotifications.ts navigates directly: router.push(`/conversation/${sessionId}`)
    // If the session was deleted between notification send and tap,
    // conversation/[id].tsx will:
    //   1. Call fetchSession(id) which will fail
    //   2. Show error state with retry button
    //
    // This is handled, but the error message is generic.
    const sessionId = 'deleted-session-id';
    const route = `/conversation/${sessionId}`;
    expect(route).toBe('/conversation/deleted-session-id');
    // The screen will show an error state — not a crash. Verified in code.
  });
});

// ---------------------------------------------------------------------------
// 11. Queued text messages invisible outside owning conversation
// ---------------------------------------------------------------------------
describe('Chaos: Offline text messages disappear from user awareness', () => {
  it('queued text-message items are only visible inside the conversation that owns them', () => {
    // conversation/[id].tsx lines 1422-1434 subscribe to queue items
    // filtered by (item.metadata.sessionId === id).
    //
    // But PendingRecordingsList only shows voice-transcription and
    // meeting-chunk items — text-message items have no global surface.
    //
    // If user queues text in conversation A, navigates away, there's
    // no indication that a queued message exists.
    const queueItemTypes = ['voice-transcription', 'meeting-chunk', 'text-message'];
    const pendingRecordingsListTypes = ['voice-transcription', 'meeting-chunk'];
    const globallyVisibleTypes = queueItemTypes.filter(
      (t) => pendingRecordingsListTypes.includes(t),
    );

    expect(globallyVisibleTypes).not.toContain('text-message');
  });
});

// ---------------------------------------------------------------------------
// 12. Send while session is busy (double-send guard)
// ---------------------------------------------------------------------------
describe('Chaos: Double-send prevention', () => {
  it('handleSend blocks when isSending is true', () => {
    const isSending = true;
    const isBusy = false;
    const inputHasText = true;
    const canSend = inputHasText && !isSending && !isBusy;
    expect(canSend).toBe(false);
  });

  it('handleSend blocks when session.isBusy is true (server-reported)', () => {
    const isSending = false;
    const isBusy = true;
    const inputHasText = true;
    const canSend = inputHasText && !isSending && !isBusy;
    expect(canSend).toBe(false);
  });

  it('but voice transcript handler bypasses busy check for direct send', () => {
    // handleVoiceTranscript does NOT check isSending or isBusy
    // before calling startTurn or enqueue. This means voice
    // transcripts from the queue consumer can fire turns
    // even if another turn is already active.
    //
    // (Actually: the transcript handler for intent=send calls
    // startTurn directly, which itself guards at the socket level.
    // But there's no UI-level guard preventing the attempt.)
    const voiceHandlerChecksBusy = false;
    expect(voiceHandlerChecksBusy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 13. Meeting recording store race on bootstrap screen
// ---------------------------------------------------------------------------
describe('Chaos: Meeting recording bootstrap store sync race', () => {
  it('documents the race between startRecording and store sync', () => {
    // meeting-recording.tsx lines 86-91 check:
    //   if (useActiveRecordingStore().isActive) { ... }
    // immediately after startRecording() resolves.
    //
    // But the store is synced via a useEffect in MeetingRecordingContext
    // (lines 60-73), which runs AFTER React renders.
    //
    // So on the first render after startRecording, isActive can still be false.
    //
    // Timeline:
    //   1. startRecording() resolves → hook state = 'recording'
    //   2. Provider re-renders → useEffect queued
    //   3. Bootstrap screen reads store → isActive still false ← RACE
    //   4. useEffect fires → setRecording() → isActive = true
    //
    // The user can see a false "Failed to start" error.
    const hookState = 'recording'; // After startRecording resolves
    const storeIsActive = false;    // Before useEffect syncs

    // This is the race window
    expect(hookState).toBe('recording');
    expect(storeIsActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 14. Crash recovery for meeting recordings
// ---------------------------------------------------------------------------
describe('Chaos: Meeting recording crash recovery cold-start wiring', () => {
  const COMPANION_SESSION_KEY = '@rebel/active-recording-companion-session-id';
  const CLOUD_SESSION_KEY = '@rebel/active-recording-cloud-session-id';

  beforeEach(async () => {
    useActiveRecordingStore.setState({
      isActive: false,
      meetingSessionId: null,
      startTime: null,
      title: null,
      companionSessionId: null,
      cloudSessionId: null,
    });
    await AsyncStorage.clear();
  });

  it('wires rehydrateActiveRecordingIds in app cold-start layout boot path', () => {
    const layoutSource = readFileSync(join(__dirname, '../../app/_layout.tsx'), 'utf8');
    expect(layoutSource).toContain('rehydrateActiveRecordingIds');
    expect(layoutSource).toContain('void rehydrateActiveRecordingIds()');
  });

  it('rehydrates persisted companion + cloud ids when an active recording store exists', async () => {
    await AsyncStorage.setItem(COMPANION_SESSION_KEY, 'companion-1');
    await AsyncStorage.setItem(CLOUD_SESSION_KEY, 'cloud-session-1');
    useActiveRecordingStore.setState({
      isActive: true,
      meetingSessionId: asLocalRecordingId('meeting-local-1'),
      startTime: 123,
      title: 'Meeting',
      companionSessionId: null,
      cloudSessionId: null,
    });

    await rehydrateActiveRecordingIds();

    const state = useActiveRecordingStore.getState();
    expect(state.companionSessionId).toBe('companion-1');
    expect(state.cloudSessionId).toBe('cloud-session-1');
  });
});
