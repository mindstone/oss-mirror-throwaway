/**
 * MeetingCompanionManager
 *
 * Owns the meeting companion creation logic, dedup override dialog, and related
 * refs/effects. Extracted from App.tsx to isolate the 135-line meeting companion
 * useEffect and 3 refs from the main render path. When no meeting is active,
 * the effect is a cheap no-op and the dialog renders nothing visible.
 *
 * State communicated back to App.tsx:
 * - `setCompanionSessionByMeetingUrl` callback — updates the mapping used by flowShellHeaderCenter
 * - `requestDedupOverride` via ref handle — opens the dedup override dialog from flowShellHeaderCenter
 */

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { ToastMessage } from '@renderer/contexts';
import type { AgentSessionWithRuntime } from '../types';
import type { AgentAttachmentPayload, MeetingCompanionTriggerMeta } from '@shared/types';
import type { MeetingTriggerDetectedPayload } from '@shared/ipc/channels/meetingTrigger';
import { createId } from '@shared/utils/id';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { extractMeetingId } from '@rebel/shared';
import { useMeetingStatus } from '@renderer/hooks/useMeetingStatus';
import { getSessionStoreState, buildRuntimeFromSnapshot } from '../store';
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@renderer/components/ui';
import { tracking } from '@renderer/src/tracking';
import { resolveReusableCompanion } from './resolveReusableCompanion';
import { meetingEventEmitter } from '@rebel/cloud-client';

/**
 * Normalize a meeting URL to a stable dedup key using platform-aware extraction.
 * Falls back to the raw URL when extraction fails (unknown platform, malformed URL).
 *
 * This is critical: Zoom (and other platforms) can present the same meeting with
 * different URL forms (e.g. `us02web.zoom.us/j/123?pwd=...` vs `zoom.us/j/123/`).
 * Without normalization, the companion dedup map sees them as distinct meetings.
 */
export function getMeetingKey(url: string): string {
  return extractMeetingId(url) ?? url;
}

// ─── Dedup override dialog state ────────────────────────────────────────────
interface DedupOverrideDialogState {
  open: boolean;
  meetingUrl: string;
  meetingTitle: string;
  ownerName: string;
}

// ─── Public ref handle ──────────────────────────────────────────────────────
export interface MeetingCompanionManagerRef {
  /** Open the dedup override dialog (called from flowShellHeaderCenter in App.tsx) */
  requestDedupOverride: (dialog: DedupOverrideDialogState) => void;
}

// ─── Props ──────────────────────────────────────────────────────────────────
export interface MeetingCompanionManagerProps {
  // Outbound — App.tsx state setter for companionSessionByMeetingUrl (consumed by flowShellHeaderCenter).
  // Map is keyed by normalized meeting ID (via getMeetingKey), NOT raw URLs.
  setCompanionSessionByMeetingUrl: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  companionSessionByMeetingUrl: Record<string, string>;

  // Inbound — stable callbacks from App.tsx
  /**
   * Canonical user-facing conversation navigation helper from App.tsx.
   * Applies the scroll-settling contract (markPendingHistoryScroll) + sets
   * sessions surface, so the user lands at the latest turn of the companion
   * session instead of the top. See
   * docs-private/investigations/260416_thread_scroll_jumps_to_top_on_switch.md.
   */
  navigateToConversation: (sessionId: string) => Promise<boolean>;
  showToast: (message: ToastMessage) => void;
  handleUserMessageRef: RefObject<((
    text: string,
    source?: 'text' | 'voice',
    attachments?: AgentAttachmentPayload[],
    options?: { editTargetMessageId?: string; targetSessionId?: string; triggerMeta?: MeetingCompanionTriggerMeta; isHidden?: boolean; messageOrigin?: string }
  ) => Promise<void>) | null>;
}

// ─── Component ──────────────────────────────────────────────────────────────
const MeetingCompanionManagerInner = forwardRef<
  MeetingCompanionManagerRef,
  MeetingCompanionManagerProps
>(function MeetingCompanionManager(
  {
    setCompanionSessionByMeetingUrl,
    companionSessionByMeetingUrl,
    navigateToConversation,
    showToast,
    handleUserMessageRef,
  },
  ref,
) {

  // ─── Meeting status (context hook) ──────────────────────────────────────
  const meetingStatus = useMeetingStatus();

  // ─── Dedup override dialog state (fully internal) ───────────────────────
  const [dedupOverrideDialog, setDedupOverrideDialog] = useState<DedupOverrideDialogState | null>(null);

  // ─── Refs ─────────────────────────────────────────────────────────────────
  const prevMeetingStateRef = useRef<typeof meetingStatus.state | null>(null); // null = first run
  // Keyed by normalized meeting ID (getMeetingKey), NOT raw URLs
  const companionCreationInProgressRef = useRef<Set<string>>(new Set());
  // Store the normalized meeting key while recording so we have it for cleanup
  // even if meetingStatus.meeting is cleared when transitioning away from recording
  const activeMeetingKeyRef = useRef<string | null>(null);
  const companionCleanupTimeoutByMeetingKeyRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const prepPromptTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const companionCleanupTimeouts = companionCleanupTimeoutByMeetingKeyRef.current;
    const prepPromptTimeouts = prepPromptTimeoutsRef.current;

    return () => {
      for (const timeout of companionCleanupTimeouts.values()) {
        clearTimeout(timeout);
      }
      companionCleanupTimeouts.clear();

      for (const timeout of prepPromptTimeouts) {
        clearTimeout(timeout);
      }
      prepPromptTimeouts.clear();
    };
  }, []);

  // ─── Auto-create meeting companion effect ─────────────────────────────────
  useEffect(() => {
    const wasRecording = prevMeetingStateRef.current === 'recording' || prevMeetingStateRef.current === 'recording_local' || prevMeetingStateRef.current === 'collaborator_recording';
    const isRecording = meetingStatus.state === 'recording' || meetingStatus.state === 'recording_local' || meetingStatus.state === 'collaborator_recording';
    const meetingUrl = meetingStatus.meeting?.meetingUrl;
    const meetingTitle = meetingStatus.meeting?.title ?? 'Meeting';
    const isFirstRun = prevMeetingStateRef.current === null;

    // Normalize URL to a stable dedup key. Zoom (and other platforms) can present
    // the same meeting with different URL forms (subdomain, query params, trailing slash).
    const meetingKey = meetingUrl ? getMeetingKey(meetingUrl) : undefined;
    const pendingCleanupTimeout = meetingKey
      ? companionCleanupTimeoutByMeetingKeyRef.current.get(meetingKey)
      : undefined;
    
    // Track the meeting key while recording (for cleanup when meeting ends)
    if (isRecording && meetingKey) {
      activeMeetingKeyRef.current = meetingKey;
      if (pendingCleanupTimeout) {
        clearTimeout(pendingCleanupTimeout);
        companionCleanupTimeoutByMeetingKeyRef.current.delete(meetingKey);
      }
    }
    
    // Create companion whenever recording is active and no companion exists for this meeting.
    // This is intentionally idempotent — it covers normal transitions, cold-start recovery,
    // HMR reloads, and race conditions (e.g., stale bot replaced by new bot for different meeting).
    // The companionCreationInProgressRef guard prevents double-creation within the same tick.
    const shouldCreateCompanion = isRecording
      && meetingUrl
      && meetingKey
      && (!companionSessionByMeetingUrl[meetingKey] || pendingCleanupTimeout != null);

    const notifyCompanionReady = (sessionId: string): void => {
      // Trigger prep notes surfacing - let agent search for any prep notes
      const prepPrompt = `I'm joining a meeting: "${meetingTitle}"${meetingUrl ? ` (${meetingUrl})` : ''}.

1. Search for any existing prep notes I may have for this meeting. If found, give me a quick summary.
2. If no prep notes are found, check whether this meeting is on my calendar:
   - If it IS on the calendar: do a brief light prep now using the calendar event (attendees, title, description). Pull recent emails/Slack involving the attendees, and if external attendees are present, do a quick web look at their company. Cap yourself to 2-3 tool calls and keep it concise. If you can't find solid info, say so — don't fabricate.
   - If it is NOT on the calendar: just say you're ready to help during the meeting.`;

      // Delay slightly to ensure session is persisted, then trigger via ref
      const prepPromptTimeout = setTimeout(() => {
        prepPromptTimeoutsRef.current.delete(prepPromptTimeout);
        if (handleUserMessageRef.current) {
          fireAndForget(handleUserMessageRef.current(prepPrompt, 'text', undefined, { targetSessionId: sessionId }), 'meetingCompanionPrep');
        }
      }, 100);
      prepPromptTimeoutsRef.current.add(prepPromptTimeout);

      // Show toast notification (skip on cold-start to avoid noise)
      if (!isFirstRun) {
        showToast({
          title: 'Meeting companion ready',
          action: {
            label: 'Open',
            onClick: () => {
              fireAndForget(navigateToConversation(sessionId), 'openCompanionSession');
            },
          },
        });
      }
    };
    
    if (shouldCreateCompanion) {
      // Guard against double-creation (React Strict Mode, HMR)
      if (companionCreationInProgressRef.current.has(meetingKey)) {
        prevMeetingStateRef.current = meetingStatus.state;
        return;
      }
      companionCreationInProgressRef.current.add(meetingKey);
      console.warn('[MeetingCompanionManager] Creating companion for', meetingUrl, { meetingKey, state: meetingStatus.state, prev: prevMeetingStateRef.current, botId: meetingStatus.botId });
      
      // Check if a companion session already exists for this meeting in sessionSummaries.
      // Uses normalized key comparison so different URL forms for the same meeting match.
      const summaries = getSessionStoreState().sessionSummaries;
      const existingCompanion = resolveReusableCompanion({
        currentBotId: meetingStatus.botId,
        currentMeetingKey: meetingKey,
        summaries,
        now: Date.now(),
      });
      
      if (existingCompanion) {
        // Existing companion found - update mapping and fire the same user-visible
        // ready signals as the fresh-creation path.
        setCompanionSessionByMeetingUrl((prev) => ({
          ...prev,
          [meetingKey]: existingCompanion.id,
        }));
        notifyCompanionReady(existingCompanion.id);
        // Keep the guard until recording ends to avoid duplicate side effects while
        // companionSessionByMeetingUrl state is still committing.
        prevMeetingStateRef.current = meetingStatus.state;
        return;
      }
      
      try {
        // Create companion session
        const sessionId = createId();
        const now = Date.now();
        
        const companionSession: AgentSessionWithRuntime = {
          id: sessionId,
          title: meetingTitle,
          messages: [],
          eventsByTurn: {},
          activeTurnId: null,
          createdAt: now,
          updatedAt: now,
          origin: 'manual',
          isBusy: false,
          lastError: null,
          resolvedAt: null,
          // Active by default (doneAt null = Active).
          doneAt: null,
          starredAt: null,
          deletedAt: null,
          meetingCompanion: {
            meetingUrl,
            botId: meetingStatus.botId,
            meetingTitle,
            startedAt: now,
          },
          runtime: buildRuntimeFromSnapshot(null, {}),
        };
        
        // Persist companion session
        getSessionStoreState().addOrUpdateHistorySession(companionSession, true);
        
        // Track the mapping (keyed by normalized meeting ID)
        setCompanionSessionByMeetingUrl((prev) => ({
          ...prev,
          [meetingKey]: sessionId,
        }));
        
        // NOTE: Do NOT delete from companionCreationInProgressRef here.
        // React setState is async — clearing the guard before the state update
        // commits allows re-renders with stale state to create duplicate companions.
        // The guard persists until recording ends (cleanup branch below).

        notifyCompanionReady(sessionId);
      } catch (error) {
        // Clear guard on failure so retry is possible on next re-render
        companionCreationInProgressRef.current.delete(meetingKey);
        console.error('[MeetingCompanionManager] Failed to create companion session', { error, meetingUrl, meetingKey });
      }
    }
    
    // Clean up companion mapping when meeting ends (prevents memory leak).
    // Use the ref which stores the normalized meeting key from when recording was active
    // (meetingStatus.meeting may already be cleared when transitioning away from recording).
    if (!isFirstRun && wasRecording && !isRecording && activeMeetingKeyRef.current) {
      const endedMeetingKey = activeMeetingKeyRef.current;
      activeMeetingKeyRef.current = null;
      // Clear creation guard now that recording is over
      companionCreationInProgressRef.current.delete(endedMeetingKey);
      // Delay cleanup slightly to allow any final operations
      const existingCleanupTimeout = companionCleanupTimeoutByMeetingKeyRef.current.get(endedMeetingKey);
      if (existingCleanupTimeout) {
        clearTimeout(existingCleanupTimeout);
        companionCleanupTimeoutByMeetingKeyRef.current.delete(endedMeetingKey);
      }
      const cleanupTimeout = setTimeout(() => {
        companionCleanupTimeoutByMeetingKeyRef.current.delete(endedMeetingKey);
        setCompanionSessionByMeetingUrl((prev) => {
          if (prev[endedMeetingKey]) {
            const { [endedMeetingKey]: _, ...rest } = prev;
            return rest;
          }
          return prev;
        });
      }, 5000);
      companionCleanupTimeoutByMeetingKeyRef.current.set(endedMeetingKey, cleanupTimeout);
    }
    
    prevMeetingStateRef.current = meetingStatus.state;
  // Note: setCompanionSessionByMeetingUrl (React setState), showToast (stable useCallback),
  // and handleUserMessageRef (useRef) are all referentially stable — added for exhaustive-deps correctness
  }, [meetingStatus.state, meetingStatus.meeting?.meetingUrl, meetingStatus.meeting?.title, meetingStatus.botId, companionSessionByMeetingUrl, navigateToConversation, setCompanionSessionByMeetingUrl, showToast, handleUserMessageRef]);

  // ─── Ask Spark quick-ask submission effect ────────────────────────────────
  useEffect(() => {
    const unsubscribe = meetingEventEmitter.on('quick-ask-submitted', (event) => {
      const { sessionId, prompt } = event;
      if (handleUserMessageRef.current) {
        fireAndForget(
          handleUserMessageRef.current(prompt, 'text', undefined, {
            targetSessionId: sessionId,
            isHidden: true,
            messageOrigin: 'user-typed',
            triggerMeta: {
              triggerSource: 'quick-ask-button',
              triggerSourceSpeaker: 'user',
              triggerExtracted: prompt,
              triggeredAt: Date.now(),
            },
          }),
          'quickAskSubmit'
        );
      } else {
        console.warn('[MeetingCompanionManager] Received quick-ask but handleUserMessageRef is null');
      }
    });

    return () => unsubscribe();
  }, [handleUserMessageRef]);

  // ─── Desktop-local voice trigger submission effect ────────────────────────
  useEffect(() => {
    const unsubscribe = window.api?.onMeetingTriggerDetected?.((event: MeetingTriggerDetectedPayload) => {
      if (meetingStatus.state !== 'recording_local') return;
      if (event.sessionId !== meetingStatus.meeting?.id) return;

      const meetingUrl = meetingStatus.meeting?.meetingUrl;
      if (!meetingUrl) return;

      const meetingKey = getMeetingKey(meetingUrl);
      const targetSessionId = companionSessionByMeetingUrl[meetingKey];
      if (!targetSessionId) {
        console.warn('[MeetingCompanionManager] Trigger detected but no companion session found', { meetingKey, event });
        return;
      }

      const triggerMeta: MeetingCompanionTriggerMeta = {
        triggerSource: 'voice-trigger',
        triggerSourceSpeaker: event.triggerSourceSpeaker,
        triggeredAt: event.segmentTimestamp,
        triggerExtracted: event.extracted,
      };

      if (handleUserMessageRef.current) {
        fireAndForget(
          handleUserMessageRef.current(event.extracted, 'text', undefined, {
            targetSessionId,
            isHidden: true,
            messageOrigin: 'user-typed',
            triggerMeta,
          }),
          'meetingTriggerDetectedSubmit',
        );
      } else {
        console.warn('[MeetingCompanionManager] Trigger detected but handleUserMessageRef is null', { event });
      }
    });

    return () => unsubscribe?.();
  }, [
    companionSessionByMeetingUrl,
    handleUserMessageRef,
    meetingStatus.meeting?.id,
    meetingStatus.meeting?.meetingUrl,
    meetingStatus.state,
  ]);

  // ─── Imperative handle ────────────────────────────────────────────────────
  const requestDedupOverride = useCallback((dialog: DedupOverrideDialogState) => {
    setDedupOverrideDialog(dialog);
  }, []);

  useImperativeHandle(ref, () => ({
    requestDedupOverride,
  }));

  // ─── Render ─────────────────────────────────────────────────────────────
  return (
    <>
      {/* Dedup override dialog - shown when another user's bot is already in meeting */}
      <Dialog
        open={dedupOverrideDialog?.open ?? false}
        onOpenChange={(open) => {
          if (!open) setDedupOverrideDialog(null);
        }}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Another notetaker is here</DialogTitle>
            <DialogDescription>
              {dedupOverrideDialog?.ownerName} already has a notetaker in this meeting.
              Do you want to send your own anyway?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDedupOverrideDialog(null)}
            >
              No, use theirs
            </Button>
            <Button
              onClick={async () => {
                if (!dedupOverrideDialog) return;
                const { meetingUrl, meetingTitle } = dedupOverrideDialog;
                setDedupOverrideDialog(null);
                showToast({ title: 'Sending your notetaker...' });
                // Send with forceJoin to override dedup
                tracking.meetingBot.sendClicked(meetingUrl, meetingTitle, 'dedup_override');
                const result = await window.meetingBotApi?.send?.({
                  meetingUrl,
                  meetingTitle,
                  forceJoin: true,
                });
                tracking.meetingBot.sendResult(result?.success ?? false, result?.error);
                if (!result?.success) {
                  showToast({ title: 'Failed to send Rebel', variant: 'error' });
                }
              }}
            >
              Yes, send mine too
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});

export const MeetingCompanionManager = memo(MeetingCompanionManagerInner);
