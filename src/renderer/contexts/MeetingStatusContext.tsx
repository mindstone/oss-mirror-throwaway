import { createContext, useContext, useState, useEffect, useRef, type ReactNode } from 'react';
import type { MeetingState, MeetingStatusSource } from '@shared/ipc/channels/meetingBot';
import { extractMeetingId } from '@rebel/shared';

export interface MeetingInfo {
  id: string;
  title: string;
  startTime: string;
  meetingUrl: string;
  participants?: string[];
  prepPath?: string;
  isPreScheduled?: boolean;
}

// SYNC: when adding fields (e.g. captionsActive), update isMeetingStatusEqual() below.
export interface MeetingStatus {
  state: MeetingState;
  source?: MeetingStatusSource;
  meeting?: MeetingInfo;
  botId?: string;
  uploadId?: string;
  recordingDuration?: number;
  quip?: string;
  waitingRoomStartTime?: number;
  otherActiveBotsCount?: number;
  /** Whether the interactive avatar is connected (enables "hey Spark", live Q&A) */
  avatarConnected?: boolean;
  /** Whether live captions are actively flowing (true = active, false = stale, undefined = unknown) */
  captionsActive?: boolean;
  /** Active participation mode for the current bot session */
  presenceMode?: 'silent' | 'coach' | 'participant';
  collaborator?: {
    ownerName?: string;
    botId: string;
  };
  healthWarning?: string;
  healthWarningType?: 'fda_required' | 'url_unavailable' | 'sdk_init_failed' | 'fda_granted';
  healthWarningResolved?: boolean;
}

const SOURCE_PRECEDENCE: MeetingStatusSource[] = [
  'desktop_sdk',
  'cloud_bot',
  'local_recording',
  'quick_capture',
  'physical_recording',
];

const PASSIVE_STATES: MeetingState[] = ['no_meetings', 'preview', 'done', 'done_quick_capture'];

const ACTIVE_STATES: MeetingState[] = [
  'detected',
  'detected_external_provider',
  'collaborator_recording',
  'dispatching',
  'joining',
  'recording',
  'waiting_too_long',
  'rejected',
  'recording_local',
  'uploading_local',
  'processing_local',
  'upload_failed',
  'recording_quick_capture',
  'transcribing_quick_capture',
  'recording_physical',
  'transcribing_physical',
];

function shouldOverrideStatus(current: MeetingStatus, incoming: MeetingStatus & { source?: MeetingStatusSource }): boolean {
  if (!current.source) return true;

  // When statuses refer to DIFFERENT meetings, apply meeting-switch rules:
  // desktop_sdk always reflects the user's current meeting, so it wins over a
  // stale cloud_bot that is still polling for a meeting the user already left.
  const currentUrl = current.meeting?.meetingUrl;
  const incomingUrl = incoming.meeting?.meetingUrl;
  const currentId = currentUrl ? extractMeetingId(currentUrl) : null;
  const incomingId = incomingUrl ? extractMeetingId(incomingUrl) : null;
  const isDifferentMeeting = !!(currentId && incomingId && currentId !== incomingId);

  if (isDifferentMeeting) {
    if (incoming.source === 'desktop_sdk') return true;
    if (current.source === 'desktop_sdk' && incoming.source === 'cloud_bot') return false;
  }
  
  const currentIsPassive = PASSIVE_STATES.includes(current.state);
  const currentIsActive = ACTIVE_STATES.includes(current.state);
  const incomingIsPassive = PASSIVE_STATES.includes(incoming.state);
  
  if (currentIsPassive) return true;
  
  if (currentIsActive && incomingIsPassive) {
    if (incoming.source && incoming.source === current.source) {
      return true;
    }
    return false;
  }
  
  if (!incoming.source) return true;
  
  const currentPrecedence = SOURCE_PRECEDENCE.indexOf(current.source);
  const incomingPrecedence = SOURCE_PRECEDENCE.indexOf(incoming.source);
  
  return incomingPrecedence >= currentPrecedence;
}

/**
 * Shallow equality check for MeetingStatus to prevent unnecessary React re-renders.
 * During recording, broadcasts arrive every 1-30s with identical payloads — returning
 * the current reference when nothing changed avoids re-rendering 7+ consumer components.
 *
 * SYNC: update this function when adding fields to MeetingStatus or MeetingInfo.
 * `meeting.participants` is intentionally excluded — participant lists are used by
 * coaching insights / FYIs (not rendered during active recording), and array equality
 * would require a deep comparison that isn't worth the cost here.
 */
function isMeetingStatusEqual(a: MeetingStatus, b: MeetingStatus): boolean {
  return (
    a.state === b.state &&
    a.source === b.source &&
    a.botId === b.botId &&
    a.uploadId === b.uploadId &&
    a.recordingDuration === b.recordingDuration &&
    a.quip === b.quip &&
    a.waitingRoomStartTime === b.waitingRoomStartTime &&
    a.otherActiveBotsCount === b.otherActiveBotsCount &&
    a.avatarConnected === b.avatarConnected &&
    a.captionsActive === b.captionsActive &&
    a.presenceMode === b.presenceMode &&
    a.healthWarning === b.healthWarning &&
    a.healthWarningType === b.healthWarningType &&
    a.healthWarningResolved === b.healthWarningResolved &&
    a.meeting?.id === b.meeting?.id &&
    a.meeting?.title === b.meeting?.title &&
    a.meeting?.meetingUrl === b.meeting?.meetingUrl &&
    a.meeting?.startTime === b.meeting?.startTime &&
    a.meeting?.prepPath === b.meeting?.prepPath &&
    a.meeting?.isPreScheduled === b.meeting?.isPreScheduled &&
    a.collaborator?.botId === b.collaborator?.botId &&
    a.collaborator?.ownerName === b.collaborator?.ownerName
  );
}

const MeetingStatusContext = createContext<MeetingStatus | null>(null);

interface MeetingStatusProviderProps {
  children: ReactNode;
}

/**
 * Singleton provider for meeting status.
 * Place this once near the root of your app to share status across all consumers.
 * This eliminates redundant IPC subscriptions and polling intervals.
 */
export function MeetingStatusProvider({ children }: MeetingStatusProviderProps) {
  const [status, setStatus] = useState<MeetingStatus>({
    state: 'no_meetings',
  });
  
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    
    // Event subscription — stays on window.api (bridge builder only generates invoke methods)
    const cleanup = window.api.onMeetingBotStatus?.((newStatus) => {
      if (!isMountedRef.current) return;
      
      const mappedState = (newStatus.state as string) === 'imminent' ? 'detected' : newStatus.state;
      const incomingStatus: MeetingStatus = {
        ...newStatus,
        state: mappedState as MeetingState,
      };
      
      setStatus(current => {
        if (!shouldOverrideStatus(current, incomingStatus)) return current;
        if (isMeetingStatusEqual(current, incomingStatus)) return current;
        return incomingStatus;
      });
    });

    if (!cleanup) {
      console.warn('[MeetingStatusProvider] onMeetingBotStatus not available in window.api');
    }

    // Event subscription — stays on window.api (bridge builder only generates invoke methods)
    const healthCleanup = window.api.onMeetingBotHealthWarning?.((data: { warning: string; type?: string; resolved?: boolean }) => {
      if (!isMountedRef.current) return;
      console.warn('[MeetingStatusProvider] Health warning received:', data.warning, data.type);
      setStatus(current => ({
        ...current,
        healthWarning: data.warning,
        healthWarningType: data.type as MeetingStatus['healthWarningType'],
        healthWarningResolved: data.resolved,
      }));

      // Auto-clear resolved warnings after 8 seconds
      if (data.resolved) {
        setTimeout(() => {
          if (!isMountedRef.current) return;
          setStatus(current => ({
            ...current,
            healthWarning: undefined,
            healthWarningType: undefined,
            healthWarningResolved: undefined,
          }));
        }, 8000);
      }
    });

    void (async () => {
      try {
        const initialStatus = await window.meetingBotApi?.getCurrentStatus?.();
        if (!isMountedRef.current || !initialStatus) return;
        
        setStatus(current => {
          if (!shouldOverrideStatus(current, initialStatus as MeetingStatus)) return current;
          if (isMeetingStatusEqual(current, initialStatus as MeetingStatus)) return current;
          return initialStatus as MeetingStatus;
        });
      } catch (err) {
        console.warn('[MeetingStatusProvider] Failed to fetch initial status:', err);
      }
    })();

    const recoveryInterval = setInterval(async () => {
      if (!isMountedRef.current) return;
      
      try {
        const freshStatus = await window.meetingBotApi?.getCurrentStatus?.();
        if (!isMountedRef.current || !freshStatus) return;
        
        setStatus(current => {
          if (!PASSIVE_STATES.includes(current.state)) return current;
          if (!shouldOverrideStatus(current, freshStatus as MeetingStatus)) return current;
          if (isMeetingStatusEqual(current, freshStatus as MeetingStatus)) return current;
          return freshStatus as MeetingStatus;
        });
      } catch {
        // Silently ignore recovery check failures
      }
    }, 30 * 1000);

    return () => {
      isMountedRef.current = false;
      cleanup?.();
      healthCleanup?.();
      clearInterval(recoveryInterval);
    };
  }, []);

  return (
    <MeetingStatusContext.Provider value={status}>
      {children}
    </MeetingStatusContext.Provider>
  );
}

/**
 * Hook to access the shared meeting status from context.
 * Must be used within a MeetingStatusProvider.
 */
export function useMeetingStatusContext(): MeetingStatus {
  const context = useContext(MeetingStatusContext);
  if (context === null) {
    if (import.meta.env.DEV) {
      // HMR can recreate the context identity, orphaning consumers from the provider.
      // Return a safe default to avoid crashing the app during development.
      return { state: 'no_meetings' };
    }
    throw new Error('useMeetingStatusContext must be used within a MeetingStatusProvider');
  }
  return context;
}
