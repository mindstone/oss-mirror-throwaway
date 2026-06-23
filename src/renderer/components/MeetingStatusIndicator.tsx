import { useCallback, useState, useEffect, useRef } from 'react';
import { Mic, Square, Loader2, X, RotateCcw, CalendarDays, AlertCircle, CheckCircle, MessageSquare } from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import { AvatarPopover } from '@renderer/components/AvatarPopover';
import { RecordingStateIndicator } from '@renderer/components/RecordingStateIndicator';

import {
  useMeetingStatus,
  formatTimeUntilMeeting,
  formatRecordingDuration,
} from '@renderer/hooks/useMeetingStatus';
import { hasRealPrepPath } from '@shared/ipc/channels/calendar';
import type { RebelAvatarId } from '@shared/types';
import type { MeetingJoinMode } from '@shared/types/settings';
import './MeetingStatusIndicator.css';

/** R2 bucket URL for avatar images */
const AVATAR_BASE_URL = 'https://pub-15a8bb8fa4a2468086761a85641af2c8.r2.dev/rebel-avatars';

/** Avatar display names */
const AVATAR_NAMES: Record<RebelAvatarId, string> = {
  dash: 'Dash',
  glitch: 'Glitch',
  rogue: 'Rogue',
  scout: 'Scout',
  spark: 'Spark',
};

/** Quips when external provider (Fireflies/Fathom) is handling the meeting */
const EXTERNAL_PROVIDER_QUIPS = [
  "Your other assistant has this one. I'll survive.",
  "Sitting this one out. It's fine. Really.",
  "Outsourced. I understand.",
  "Someone else is taking notes. I'm not jealous.",
  "I'll just be here if you need me.",
];

/** Quips for local recording states */
const LOCAL_RECORDING_QUIPS = [
  'Recording locally.',
  'Taking notes from here.',
  'Capturing this for you.',
  'Listening in.',
  'On it.',
];

/** Quips when meeting is pre-scheduled (auto-join confirmed) */
const PRE_SCHEDULED_QUIPS = [
  "I'll be there.",
  "Already on it.",
  "Consider it handled.",
  "Penciled in.",
  "Save me a seat.",
];

/** Quips when a colleague's Rebel is already recording (collaborator state) */
const COLLABORATOR_QUIPS = [
  "You'll get the transcript too.",
  "Shared notes incoming.",
  "Teamwork. You'll see it all.",
  "One Rebel is enough. You're covered.",
  "Transcript will land in your library.",
];

interface MeetingStatusIndicatorProps {
  onSendRebel?: (meetingUrl: string, meetingTitle: string) => void | Promise<void>;
  onSkip?: (meetingUrl: string) => void;
  onStopRecording?: (botId: string) => void | Promise<void>;
  onStopPhysicalRecording?: () => void | Promise<void>;
  onStopQuickCapture?: () => void | Promise<void>;
  onTryAgain?: (meetingUrl: string, meetingTitle: string, botId?: string) => void | Promise<void>;
  onDismiss?: (botId?: string) => void;
  onOpenSettings?: () => void;
  onPrepMe?: (prompt: string) => void;
  onShowPrep?: (prepPath: string) => void;
  /** Schedule bot and open meeting link (for upcoming meetings) */
  onJoinWithRebel?: (meetingUrl: string, meetingTitle: string, scheduledFor: string) => void | Promise<void>;
  /** Just open meeting link without scheduling bot */
  onJoin?: (meetingUrl: string) => void;
  /** Start local recording as fallback. botId is provided to cancel the cloud bot. */
  onRecordLocally?: (meetingTitle: string, botId?: string) => void | Promise<void>;
  /** Stop local recording */
  onStopLocalRecording?: () => void | Promise<void>;
  /** Force send own bot when a collaborator's bot is already in the meeting */
  onSendMineAnyway?: (meetingUrl: string, meetingTitle: string) => void | Promise<void>;
  /** Callback to open the meeting companion conversation */
  onOpenCompanion?: () => void;
  /** Whether the companion conversation exists and can be opened */
  hasCompanion?: boolean;
}

/**
 * Meeting status indicator for the title bar.
 * Shows current meeting state with delightful Rebel-voice quips.
 * 
 * States:
 * - no_meetings: "No meetings detected"
 * - preview: "Next: [Meeting] at [time]" (calendar-based, future)
 * - detected: "[Meeting]" + "Send Rebel" / "Skip" (Desktop SDK detected meeting)
 * - dispatching: Quip like "On my way. Save me a seat."
 * - joining: Quip like "In the waiting room. Fashionably early."
 * - recording: "Taking notes • 12:34" + stop button
 * - waiting_too_long: "Still waiting to be admitted" + Try Again / Dismiss
 * - rejected: "Couldn't join the meeting" + Try Again / Dismiss
 */
export function MeetingStatusIndicator({
  onSendRebel,
  onSkip,
  onStopRecording,
  onStopPhysicalRecording,
  onStopQuickCapture,
  onTryAgain,
  onDismiss,
  onOpenSettings,
  onPrepMe,
  onShowPrep,
  onJoinWithRebel,
  onJoin,
  onRecordLocally,
  onStopLocalRecording,
  onSendMineAnyway,
  onOpenCompanion,
  hasCompanion,
}: MeetingStatusIndicatorProps) {
  const status = useMeetingStatus();
  const [isSending, setIsSending] = useState(false);
  const [isStartingLocalRecording, setIsStartingLocalRecording] = useState(false);
  const [avatarId, setAvatarId] = useState<RebelAvatarId>('spark');
  const [popoverOpen, setPopoverOpen] = useState(false);
  const avatarButtonRef = useRef<HTMLButtonElement>(null);
  const [joinMode, setJoinMode] = useState<MeetingJoinMode>('prompt');
  const [promptMinutesBefore, setPromptMinutesBefore] = useState(5);
  const [localRecordingSupported, setLocalRecordingSupported] = useState(false);
  const [localRecordingQuip] = useState(() => 
    LOCAL_RECORDING_QUIPS[Math.floor(Math.random() * LOCAL_RECORDING_QUIPS.length)]
  );
  const [externalProviderQuip] = useState(() =>
    EXTERNAL_PROVIDER_QUIPS[Math.floor(Math.random() * EXTERNAL_PROVIDER_QUIPS.length)]
  );
  const [preScheduledQuip] = useState(() =>
    PRE_SCHEDULED_QUIPS[Math.floor(Math.random() * PRE_SCHEDULED_QUIPS.length)]
  );
  const [collaboratorQuip, setCollaboratorQuip] = useState(() =>
    COLLABORATOR_QUIPS[Math.floor(Math.random() * COLLABORATOR_QUIPS.length)]
  );

  // Rotate collaborator quip when entering collaborator state (not just on mount)
  useEffect(() => {
    if (status.state === 'collaborator_recording') {
      setCollaboratorQuip(COLLABORATOR_QUIPS[Math.floor(Math.random() * COLLABORATOR_QUIPS.length)]);
    }
  }, [status.state]);
  // Track dismissed preview meetings (session-only, not persisted)
  const [dismissedMeetingIds, setDismissedMeetingIds] = useState<Set<string>>(new Set());

  // Load avatar and join settings
  useEffect(() => {
    window.settingsApi?.get().then(settings => {
      const avatar = settings?.meetingBot?.rebelAvatar ?? 'spark';
      setAvatarId(avatar);
      setJoinMode(settings?.meetingBot?.joinMode ?? 'prompt');
      setPromptMinutesBefore(settings?.meetingBot?.promptMinutesBefore ?? 5);
    }).catch(() => {
      // Ignore errors, use defaults
    });

    // Check if local recording is supported
    window.meetingBotApi?.isLocalRecordingSupported?.()
      .then((result: { supported: boolean }) => {
        console.warn('[MeetingStatusIndicator] isLocalRecordingSupported result:', result);
        setLocalRecordingSupported(result?.supported ?? false);
      })
      .catch((err) => {
        console.error('[MeetingStatusIndicator] isLocalRecordingSupported error:', err);
        setLocalRecordingSupported(false);
      });
  }, []);

  const handleSendRebel = useCallback(async () => {
    if (status.meeting?.meetingUrl && onSendRebel) {
      setIsSending(true);
      try {
        await onSendRebel(status.meeting.meetingUrl, status.meeting.title || 'Meeting');
      } finally {
        setIsSending(false);
      }
    }
  }, [status.meeting, onSendRebel]);

  const handleSkip = useCallback(() => {
    if (status.meeting?.meetingUrl) {
      onSkip?.(status.meeting.meetingUrl);
    }
  }, [status.meeting, onSkip]);

  const handleTryAgain = useCallback(async () => {
    if (status.meeting?.meetingUrl && onTryAgain) {
      setIsSending(true);
      try {
        await onTryAgain(status.meeting.meetingUrl, status.meeting.title || 'Meeting', status.botId);
      } finally {
        setIsSending(false);
      }
    }
  }, [status.meeting, status.botId, onTryAgain]);

  const handleDismiss = useCallback(() => {
    onDismiss?.(status.botId);
  }, [onDismiss, status.botId]);

  const handlePrepMe = useCallback(() => {
    if (status.meeting && onPrepMe) {
      const title = status.meeting.title || 'Meeting';
      onPrepMe(`Prep me for my meeting "${title}". Use the meeting-prep skill.`);
    }
  }, [status.meeting, onPrepMe]);

  const handleShowPrep = useCallback(() => {
    const prepPath = status.meeting?.prepPath;
    if (hasRealPrepPath(prepPath) && onShowPrep) {
      onShowPrep(prepPath);
    }
  }, [status.meeting, onShowPrep]);

  const handleJoinWithRebel = useCallback(async () => {
    if (status.meeting?.meetingUrl && onJoinWithRebel) {
      setIsSending(true);
      try {
        await onJoinWithRebel(
          status.meeting.meetingUrl,
          status.meeting.title || 'Meeting',
          status.meeting.startTime
        );
      } finally {
        setIsSending(false);
      }
    }
  }, [status.meeting, onJoinWithRebel]);

  const handleJoin = useCallback(() => {
    if (status.meeting?.meetingUrl && onJoin) {
      onJoin(status.meeting.meetingUrl);
    }
  }, [status.meeting, onJoin]);

  const handleRecordLocally = useCallback(async () => {
    if (onRecordLocally) {
      setIsStartingLocalRecording(true);
      try {
        await onRecordLocally(status.meeting?.title || 'Meeting', status.botId);
      } finally {
        setIsStartingLocalRecording(false);
      }
    }
  }, [onRecordLocally, status.meeting, status.botId]);

  const handleOpenSystemSettings = useCallback(() => {
    window.meetingBotApi?.requestTeamsUrlPermission?.().catch(() => {
      // Ignore errors - best-effort attempt to open settings
    });
  }, []);

  const handleStopLocalRecording = useCallback(async () => {
    if (onStopLocalRecording) {
      await onStopLocalRecording();
    }
  }, [onStopLocalRecording]);

  const avatarUrl = `${AVATAR_BASE_URL}/${avatarId}.png`;

  // Handler to dismiss a preview meeting (session-only)
  const handleDismissPreview = useCallback(() => {
    const meetingId = status.meeting?.id;
    if (meetingId) {
      setDismissedMeetingIds(prev => new Set(prev).add(meetingId));
    }
  }, [status.meeting?.id]);



  // No meetings state - return null (MeetingButton is rendered separately in header-right)
  if (status.state === 'no_meetings') {
    return null;
  }

  // Preview state (calendar-based, upcoming meeting with URL)
  if (status.state === 'preview' && status.meeting) {
    // If user dismissed this meeting's preview, show nothing (MeetingButton shows in header-right)
    if (dismissedMeetingIds.has(status.meeting.id)) {
      return null;
    }
    const timeUntil = formatTimeUntilMeeting(status.meeting.startTime);
    const startMs = new Date(status.meeting.startTime).getTime();
    const minutesUntil = (startMs - Date.now()) / (1000 * 60);
    
    // Determine if we should show join buttons based on joinMode setting
    // Show buttons if meeting is imminent OR already started (until it ends or Desktop SDK takes over)
    const isImminent = minutesUntil <= promptMinutesBefore;
    const showJoinButtons = status.meeting.meetingUrl && (
      joinMode === 'ask' || // Always show for 'ask' mode
      (joinMode === 'prompt' && isImminent) // Show when imminent or in progress for 'prompt' mode
    );

    // Check if bot is already pre-scheduled
    const isPreScheduled = status.meeting.isPreScheduled;

    // Imminent state with join buttons (only if not already pre-scheduled)
    if (showJoinButtons && !isPreScheduled) {
      return (
        <div className="meeting-status meeting-status--imminent">
          <CalendarDays className="meeting-status__calendar-icon" size={14} />
          <span className="meeting-status__preview-text">
            {status.meeting.title} · {timeUntil}
          </span>
          <div className="meeting-status__actions">
            {hasRealPrepPath(status.meeting?.prepPath) && onShowPrep ? (
              <button
                type="button"
                onClick={handleShowPrep}
                className="meeting-status__prep-link"
              >
                Show prep
              </button>
            ) : onPrepMe && (
              <button
                type="button"
                onClick={handlePrepMe}
                className="meeting-status__prep-link"
              >
                Prep me
              </button>
            )}
            <Button
              size="sm"
              onClick={handleJoinWithRebel}
              disabled={isSending}
              className="meeting-status__btn-join"
            >
              {isSending ? <Loader2 size={14} className="animate-spin" /> : 'Join with Rebel'}
            </Button>
            <button
              type="button"
              onClick={handleJoin}
              className="meeting-status__join-link"
            >
              Join
            </button>
          </div>
        </div>
      );
    }

    // Imminent + pre-scheduled: show avatar, quip, and just "Join" link
    if (showJoinButtons && isPreScheduled) {
      return (
        <div className="meeting-status meeting-status--imminent meeting-status--prescheduled">
          <img
            src={avatarUrl}
            alt={AVATAR_NAMES[avatarId]}
            className="meeting-status__avatar meeting-status__avatar--small"
          />
          <span className="meeting-status__preview-text">
            {status.meeting.title} · {timeUntil}
          </span>
          <span className="meeting-status__quip meeting-status__quip--subtle">{preScheduledQuip}</span>
          <div className="meeting-status__actions">
            {hasRealPrepPath(status.meeting?.prepPath) && onShowPrep ? (
              <button
                type="button"
                onClick={handleShowPrep}
                className="meeting-status__prep-link"
              >
                Show prep
              </button>
            ) : onPrepMe && (
              <button
                type="button"
                onClick={handlePrepMe}
                className="meeting-status__prep-link"
              >
                Prep me
              </button>
            )}
            <button
              type="button"
              onClick={handleJoin}
              className="meeting-status__join-link"
            >
              Join
            </button>
          </div>
        </div>
      );
    }

    // Regular preview (not imminent)
    // Show pre-scheduled indicator if bot is already dispatched
    return (
      <div className={`meeting-status meeting-status--preview${isPreScheduled ? ' meeting-status--prescheduled' : ''}`}>
        {isPreScheduled ? (
          <img
            src={avatarUrl}
            alt={AVATAR_NAMES[avatarId]}
            className="meeting-status__avatar meeting-status__avatar--small"
          />
        ) : (
          <CalendarDays className="meeting-status__calendar-icon" size={14} />
        )}
        <span className="meeting-status__preview-text">
          {status.meeting.title} · {timeUntil}
        </span>
        {isPreScheduled && (
          <span className="meeting-status__quip meeting-status__quip--subtle">{preScheduledQuip}</span>
        )}
        {hasRealPrepPath(status.meeting?.prepPath) && onShowPrep ? (
          <button
            type="button"
            onClick={handleShowPrep}
            className="meeting-status__prep-link"
          >
            Show prep
          </button>
        ) : onPrepMe && (
          <button
            type="button"
            onClick={handlePrepMe}
            className="meeting-status__prep-link"
          >
            Prep me
          </button>
        )}
        <Tooltip content="Dismiss">
          <button
            type="button"
            onClick={handleDismissPreview}
            className="meeting-status__dismiss-btn"
            aria-label="Dismiss meeting preview"
          >
            <X size={12} />
          </button>
        </Tooltip>
      </div>
    );
  }

  // Celebration state - FDA was just granted
  if (status.healthWarningResolved && status.healthWarningType === 'fda_granted') {
    return (
      <div className="meeting-status meeting-status--celebration">
        <img
          src={avatarUrl}
          alt={AVATAR_NAMES[avatarId]}
          className="meeting-status__avatar"
        />
        <span className="meeting-status__celebration-text">
          <CheckCircle size={14} />
          Got it. Meeting links are readable now.
        </span>
      </div>
    );
  }

  // Detected state - meeting detected via Desktop SDK
  if (status.state === 'detected' && status.meeting) {
    const hasMeetingUrl = !!status.meeting.meetingUrl;
    const needsFda = !hasMeetingUrl && status.healthWarningType === 'fda_required';
    const _urlMissing = !hasMeetingUrl && !needsFda;

    // "Needs setup" state: meeting visible but link not readable
    if (!hasMeetingUrl) {
      return (
        <div className="meeting-status meeting-status--needs-setup">
          <Tooltip content={`${AVATAR_NAMES[avatarId]} - Click to change`}>
            <button
              ref={avatarButtonRef}
              className="meeting-status__avatar-btn"
              onClick={() => setPopoverOpen(!popoverOpen)}
              aria-label="Notetaker settings"
            >
              <img
                src={avatarUrl}
                alt={AVATAR_NAMES[avatarId]}
                className="meeting-status__avatar"
              />
            </button>
          </Tooltip>
          <AvatarPopover
            isOpen={popoverOpen}
            avatarId={avatarId}
            referenceElement={avatarButtonRef.current}
            onClose={() => setPopoverOpen(false)}
            onOpenSettings={onOpenSettings ?? (() => {})}
          />
          <div className="meeting-status__needs-setup-content">
            <span className="meeting-status__title">{status.meeting.title}</span>
            <span className="meeting-status__hint">
              {needsFda
                ? 'I can see this meeting but need permission to read the link.'
                : 'I can see this meeting but can\u2019t read the link yet.'}
            </span>
          </div>
          <div className="meeting-status__actions">
            {needsFda ? (
              <Button
                size="sm"
                onClick={handleOpenSystemSettings}
                className="meeting-status__btn-primary"
              >
                Fix this
              </Button>
            ) : (
              hasRealPrepPath(status.meeting?.prepPath) && onShowPrep ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleShowPrep}
                  className="meeting-status__btn-prep"
                >
                  Show prep
                </Button>
              ) : onPrepMe ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handlePrepMe}
                  className="meeting-status__btn-prep"
                >
                  Prep me
                </Button>
              ) : null
            )}
            {localRecordingSupported && onRecordLocally && (
              <Button
                size="sm"
                variant={needsFda ? 'ghost' : 'default'}
                onClick={handleRecordLocally}
                disabled={isStartingLocalRecording}
                className={needsFda ? 'meeting-status__btn-secondary' : 'meeting-status__btn-primary'}
              >
                {isStartingLocalRecording ? (
                  <>
                    <Loader2 size={12} className="meeting-status__spinner" />
                    Starting...
                  </>
                ) : (
                  'Record locally'
                )}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={handleSkip}
              className="meeting-status__btn-secondary"
            >
              Skip
            </Button>
          </div>
        </div>
      );
    }

    // Normal detected state with URL available
    return (
      <div className="meeting-status meeting-status--detected">
        <Tooltip content={`${AVATAR_NAMES[avatarId]} - Click to change`}>
          <button
            ref={avatarButtonRef}
            className="meeting-status__avatar-btn"
            onClick={() => setPopoverOpen(!popoverOpen)}
            aria-label="Notetaker settings"
          >
            <img
              src={avatarUrl}
              alt={AVATAR_NAMES[avatarId]}
              className="meeting-status__avatar"
            />
          </button>
        </Tooltip>
        <AvatarPopover
          isOpen={popoverOpen}
          avatarId={avatarId}
          referenceElement={avatarButtonRef.current}
          onClose={() => setPopoverOpen(false)}
          onOpenSettings={onOpenSettings ?? (() => {})}
        />
        <span className="meeting-status__title">{status.meeting.title}</span>
        <div className="meeting-status__actions">
          {hasRealPrepPath(status.meeting?.prepPath) && onShowPrep ? (
            <Tooltip content="View meeting prep">
              <Button
                size="sm"
                variant="ghost"
                onClick={handleShowPrep}
                className="meeting-status__btn-prep"
              >
                Show prep
              </Button>
            </Tooltip>
          ) : onPrepMe && (
            <Tooltip content="Prepare for this meeting">
              <Button
                size="sm"
                variant="ghost"
                onClick={handlePrepMe}
                className="meeting-status__btn-prep"
              >
                Prep me
              </Button>
            </Tooltip>
          )}
          <Button
            size="sm"
            onClick={handleSendRebel}
            disabled={isSending}
            className="meeting-status__btn-primary"
          >
            {isSending ? (
              <>
                <Loader2 size={12} className="meeting-status__spinner" />
                Sending...
              </>
            ) : (
              'Send Rebel'
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleSkip}
            disabled={isSending}
            className="meeting-status__btn-secondary"
          >
            Skip
          </Button>
        </div>
        {localRecordingSupported && onRecordLocally && (
          <button
            className="meeting-status__local-link"
            onClick={handleRecordLocally}
            disabled={isSending}
          >
            or record locally instead
          </button>
        )}
      </div>
    );
  }

  // External provider state - Fireflies/Fathom is handling this meeting
  if (status.state === 'detected_external_provider' && status.meeting) {
    return (
      <div className="meeting-status meeting-status--external">
        <img
          src={avatarUrl}
          alt={AVATAR_NAMES[avatarId]}
          className="meeting-status__avatar meeting-status__avatar--dimmed"
        />
        <span className="meeting-status__title">{status.meeting.title}</span>
        <span className="meeting-status__quip">{externalProviderQuip}</span>
      </div>
    );
  }

  // Collaborator state - another Mindstone user's bot is already recording
  if (status.state === 'collaborator_recording' && status.meeting) {
    const ownerName = status.collaborator?.ownerName;
    const ownerLabel = ownerName 
      ? `${ownerName}'s Rebel`
      : "A colleague's Rebel";
    
    const handleSendMineAnyway = async () => {
      if (!status.meeting || !onSendMineAnyway) return;
      setIsSending(true);
      try {
        await onSendMineAnyway(status.meeting.meetingUrl, status.meeting.title);
      } finally {
        setIsSending(false);
      }
    };
    
    return (
      <div className="meeting-status meeting-status--collaborator">
        <Tooltip content={`${ownerLabel} is recording this meeting`}>
          <div className="meeting-status__icon-wrapper meeting-status__icon-wrapper--hoverable">
            <Mic className="meeting-status__icon meeting-status__icon--recording" size={14} />
          </div>
        </Tooltip>
        <span className="meeting-status__title">{status.meeting.title}</span>
        <span className="meeting-status__quip">{collaboratorQuip}</span>
        {hasCompanion && onOpenCompanion && (
          <Tooltip content="Open meeting companion">
            <Button
              size="sm"
              variant="ghost"
              onClick={onOpenCompanion}
              className="meeting-status__btn-companion"
            >
              <MessageSquare size={12} />
            </Button>
          </Tooltip>
        )}
        {onSendMineAnyway && (
          <Tooltip content="Send your own Rebel to this meeting">
            <button
              type="button"
              className="meeting-status__send-anyway-link"
              onClick={handleSendMineAnyway}
              disabled={isSending}
            >
              {isSending ? 'Sending...' : 'Send mine too'}
            </button>
          </Tooltip>
        )}
      </div>
    );
  }

  // Dispatching state - bot being sent
  if (status.state === 'dispatching') {
    return (
      <div className="meeting-status meeting-status--dispatching">
        <img
          src={avatarUrl}
          alt={AVATAR_NAMES[avatarId]}
          className="meeting-status__avatar meeting-status__avatar--animated"
        />
        <span className="meeting-status__quip">{status.quip || 'Dispatching your proxy...'}</span>
      </div>
    );
  }

  // Joining state - bot joining/in waiting room
  if (status.state === 'joining') {
    return (
      <div className="meeting-status meeting-status--joining">
        <img
          src={avatarUrl}
          alt={AVATAR_NAMES[avatarId]}
          className="meeting-status__avatar meeting-status__avatar--animated"
        />
        <span className="meeting-status__quip">{status.quip || 'In the waiting room...'}</span>
        {/* Escape hatch - record locally if bot is stuck */}
        {localRecordingSupported && onRecordLocally && (
          <button
            className="meeting-status__local-link"
            onClick={handleRecordLocally}
            disabled={isStartingLocalRecording}
          >
            {isStartingLocalRecording ? 'Starting...' : 'Record locally instead'}
          </button>
        )}
      </div>
    );
  }

  // Recording state - bot actively taking notes
  if (status.state === 'recording') {
    return (
      <RecordingStateIndicator
        status={status}
        avatarId={avatarId}
        hasCompanion={hasCompanion}
        onOpenCompanion={onOpenCompanion}
        onStopRecording={onStopRecording}
      />
    );
  }

  // Waiting too long state - bot stuck in waiting room
  if (status.state === 'waiting_too_long') {
    return (
      <div className="meeting-status meeting-status--warning">
        <img
          src={avatarUrl}
          alt={AVATAR_NAMES[avatarId]}
          className="meeting-status__avatar"
        />
        <span className="meeting-status__quip">{status.quip || 'Still waiting to be admitted'}</span>
        {(status.otherActiveBotsCount ?? 0) > 0 && (
          <span className="meeting-status__other-bots">
            {status.otherActiveBotsCount === 1
              ? 'Another meeting is still being recorded'
              : `${status.otherActiveBotsCount} other meetings are being recorded`}
          </span>
        )}
        <div className="meeting-status__actions">
          {localRecordingSupported && onRecordLocally && (
            <Tooltip content="Record from your computer instead">
              <Button
                size="sm"
                variant="ghost"
                onClick={handleRecordLocally}
                disabled={isStartingLocalRecording}
                className="meeting-status__btn-local"
              >
                {isStartingLocalRecording ? <Loader2 size={12} className="animate-spin" /> : <Mic size={12} />}
                Plan B
              </Button>
            </Tooltip>
          )}
          <Tooltip content="Cancel and send a new bot">
            <Button
              size="sm"
              variant="ghost"
              onClick={handleTryAgain}
              disabled={isSending}
              className="meeting-status__btn-retry"
            >
              <RotateCcw size={12} />
              Try Again
            </Button>
          </Tooltip>
          <Tooltip content="Dismiss">
            <Button
              size="sm"
              variant="ghost"
              onClick={handleDismiss}
              className="meeting-status__btn-dismiss"
            >
              <X size={12} />
            </Button>
          </Tooltip>
        </div>
      </div>
    );
  }

  // Rejected state - bot couldn't join
  if (status.state === 'rejected') {
    return (
      <div className="meeting-status meeting-status--error">
        <img
          src={avatarUrl}
          alt={AVATAR_NAMES[avatarId]}
          className="meeting-status__avatar"
        />
        <span className="meeting-status__quip">{status.quip || "Couldn't join the meeting"}</span>
        {(status.otherActiveBotsCount ?? 0) > 0 && (
          <span className="meeting-status__other-bots">
            {status.otherActiveBotsCount === 1
              ? 'Another meeting is still being recorded'
              : `${status.otherActiveBotsCount} other meetings are being recorded`}
          </span>
        )}
        <div className="meeting-status__actions">
          {localRecordingSupported && onRecordLocally && (
            <Tooltip content="Record from your computer instead">
              <Button
                size="sm"
                variant="ghost"
                onClick={handleRecordLocally}
                disabled={isStartingLocalRecording}
                className="meeting-status__btn-local"
              >
                {isStartingLocalRecording ? <Loader2 size={12} className="animate-spin" /> : <Mic size={12} />}
                Plan B
              </Button>
            </Tooltip>
          )}
          <Tooltip content="Send a new bot">
            <Button
              size="sm"
              variant="ghost"
              onClick={handleTryAgain}
              disabled={isSending}
              className="meeting-status__btn-retry"
            >
              <RotateCcw size={12} />
              Try Again
            </Button>
          </Tooltip>
          <Tooltip content="Dismiss">
            <Button
              size="sm"
              variant="ghost"
              onClick={handleDismiss}
              className="meeting-status__btn-dismiss"
            >
              <X size={12} />
            </Button>
          </Tooltip>
        </div>
      </div>
    );
  }

  // Local recording states
  if (status.state === 'recording_local') {
    const duration = formatRecordingDuration(status.recordingDuration ?? 0);
    return (
      <div className="meeting-status meeting-status--recording-local">
        <Mic className="meeting-status__icon meeting-status__icon--recording" size={14} />
        <span className="meeting-status__quip">{localRecordingQuip}</span>
        <span className="meeting-status__duration">{duration}</span>
        <Tooltip content="Stop recording">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleStopLocalRecording}
            className="meeting-status__btn-stop"
          >
            <Square size={12} />
          </Button>
        </Tooltip>
        {hasCompanion && onOpenCompanion && (
          <Tooltip content="Open meeting companion">
            <Button
              size="sm"
              variant="ghost"
              onClick={onOpenCompanion}
              className="meeting-status__btn-companion"
            >
              <MessageSquare size={12} />
            </Button>
          </Tooltip>
        )}
      </div>
    );
  }

  if (status.state === 'uploading_local') {
    return (
      <div className="meeting-status meeting-status--uploading">
        <Loader2 className="meeting-status__icon animate-spin" size={14} />
        <span className="meeting-status__quip">Uploading recording...</span>
      </div>
    );
  }

  if (status.state === 'processing_local') {
    return (
      <div className="meeting-status meeting-status--processing">
        <Loader2 className="meeting-status__icon animate-spin" size={14} />
        <span className="meeting-status__quip">Processing transcript...</span>
      </div>
    );
  }

  if (status.state === 'upload_failed') {
    return (
      <div className="meeting-status meeting-status--error">
        <AlertCircle className="meeting-status__icon meeting-status__icon--error" size={14} />
        <span className="meeting-status__quip">{status.quip || 'Upload failed'}</span>
        <Tooltip content="Dismiss">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleDismiss}
            className="meeting-status__btn-dismiss"
          >
            <X size={12} />
          </Button>
        </Tooltip>
      </div>
    );
  }

  if (status.state === 'done') {
    return (
      <div className="meeting-status meeting-status--done">
        <CheckCircle className="meeting-status__icon meeting-status__icon--success" size={14} />
        <span className="meeting-status__quip">{status.quip || 'Transcript saved'}</span>
      </div>
    );
  }

  // Quick capture states
  if (status.state === 'recording_quick_capture') {
    const duration = formatRecordingDuration(status.recordingDuration ?? 0);
    return (
      <div className="meeting-status meeting-status--recording-physical">
        <Mic className="meeting-status__icon meeting-status__icon--recording" size={14} />
        <span className="meeting-status__quip">{status.quip || 'Recording'}</span>
        <span className="meeting-status__duration">{duration}</span>
        <Tooltip content="Stop recording">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void onStopQuickCapture?.()}
            className="meeting-status__btn-stop"
          >
            <Square size={12} />
          </Button>
        </Tooltip>
      </div>
    );
  }

  if (status.state === 'transcribing_quick_capture') {
    return (
      <div className="meeting-status meeting-status--processing">
        <Loader2 className="meeting-status__icon animate-spin" size={14} />
        <span className="meeting-status__quip">{status.quip || 'Transcribing...'}</span>
      </div>
    );
  }

  if (status.state === 'done_quick_capture') {
    return (
      <div className="meeting-status meeting-status--done">
        <CheckCircle className="meeting-status__icon meeting-status__icon--success" size={14} />
        <span className="meeting-status__quip">{status.quip || 'Recording saved'}</span>
      </div>
    );
  }

  // Physical recording states (Limitless Pendant)
  if (status.state === 'recording_physical') {
    const duration = formatRecordingDuration(status.recordingDuration ?? 0);
    return (
      <Tooltip content="Recording with Limitless Pendant" delayShow={300}>
        <div className="meeting-status meeting-status--recording-physical">
          <Mic className="meeting-status__icon meeting-status__icon--recording" size={14} />
          <span className="meeting-status__quip">{status.quip || 'Recording in-person'}</span>
          <span className="meeting-status__duration">{duration}</span>
          {onStopPhysicalRecording && (
            <Tooltip content="Stop recording">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void onStopPhysicalRecording()}
                className="meeting-status__btn-stop"
              >
                <Square size={12} />
              </Button>
            </Tooltip>
          )}
        </div>
      </Tooltip>
    );
  }

  if (status.state === 'transcribing_physical') {
    return (
      <div className="meeting-status meeting-status--processing">
        <Loader2 className="meeting-status__icon animate-spin" size={14} />
        <span className="meeting-status__quip">{status.quip || 'Transcribing...'}</span>
      </div>
    );
  }

  if (status.state === 'done_physical') {
    return (
      <div className="meeting-status meeting-status--done">
        <CheckCircle className="meeting-status__icon meeting-status__icon--success" size={14} />
        <span className="meeting-status__quip">{status.quip || 'Recording saved'}</span>
      </div>
    );
  }

  // Fallback
  return null;
}
