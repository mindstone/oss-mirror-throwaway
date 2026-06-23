import { useCallback, useEffect, useState } from 'react';
import { Brain, MessageCircle, MessageSquare, Mic, Square, VolumeX } from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import { useVisibilityAwareInterval } from '@renderer/hooks/useVisibilityAwareInterval';
import { ContributionPill } from '@renderer/components/ContributionPill';
import { formatRecordingDuration, type MeetingStatus as MeetingStatusState } from '@renderer/hooks/useMeetingStatus';
import type { RebelAvatarId } from '@shared/types';

interface RecordingStateIndicatorProps {
  status: MeetingStatusState;
  avatarId: RebelAvatarId;
  hasCompanion?: boolean;
  onOpenCompanion?: () => void;
  onStopRecording?: (botId: string) => void | Promise<void>;
}

export function RecordingStateIndicator({
  status,
  avatarId: _avatarId,
  hasCompanion,
  onOpenCompanion,
  onStopRecording,
}: RecordingStateIndicatorProps) {
  const [recordingCount, setRecordingCount] = useState(0);
  const [knowledgeAccessEnabled, setKnowledgeAccessEnabled] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [hasPendingResponse, setHasPendingResponse] = useState(false);
  const [contributionPreview, setContributionPreview] = useState<{
    text: string;
    scores?: { relevance: number; helpfulness: number; timing: number } | null;
    triggerType?: string;
    triggerExcerpt?: string;
  } | null>(null);

  // Fetch recording count when in recording state (for multi-bot badge)
  // Reset count when not recording
  useEffect(() => {
    if (status.state !== 'recording') {
      setRecordingCount(0);
    }
  }, [status.state]);

  // Poll recording count (UI-only badge) - pause when backgrounded
  useVisibilityAwareInterval(
    async () => {
      if (status.state !== 'recording') return;
      try {
        const result = await window.meetingBotApi?.getRecordingCount?.();
        if (result) {
          setRecordingCount(result.recordingCount);
        }
      } catch {
        // Ignore errors
      }
    },
    10000, // Foreground: 10s
    null,  // Background: pause (UI-only)
    [status.state]
  );

  // Fetch knowledge access state when recording starts, reset when not recording
  useEffect(() => {
    if (status.state !== 'recording' || !status.botId) {
      setKnowledgeAccessEnabled(false);
      return;
    }

    // Fetch current knowledge access state
    window.meetingBotApi?.getKnowledgeAccess?.({ botId: status.botId })
      .then((result) => {
        setKnowledgeAccessEnabled(result?.enabled ?? false);
      })
      .catch(() => {
        setKnowledgeAccessEnabled(false);
      });
  }, [status.state, status.botId]);

  // Poll speaking and pending response state when recording
  // Reset state when not recording
  useEffect(() => {
    if (status.state !== 'recording' || !status.botId) {
      setIsSpeaking(false);
      setHasPendingResponse(false);
      setContributionPreview(null);
    }
  }, [status.state, status.botId]);

  // Poll speaking state (UI-only for buttons) - conservative background rate
  // Note: Actual meeting bot runs in main process independently
  useVisibilityAwareInterval(
    async () => {
      if (status.state !== 'recording' || !status.botId) return;
      try {
        const [speakingResult, pendingResult] = await Promise.all([
          window.meetingBotApi?.isSpeaking?.({ botId: status.botId }),
          window.meetingBotApi?.hasPendingResponse?.({ botId: status.botId }),
        ]);
        setIsSpeaking(speakingResult?.speaking ?? false);
        setHasPendingResponse(pendingResult?.pending ?? false);

        // Fetch contribution preview when pending in participant mode
        if (pendingResult?.pending && status.presenceMode === 'participant') {
          const previewResult = await window.meetingBotApi?.getContributionPreview?.({ botId: status.botId });
          setContributionPreview(previewResult ?? null);
        } else {
          setContributionPreview(null);
        }
      } catch {
        // Ignore errors
      }
    },
    500,  // Foreground: 500ms for responsiveness
    1000, // Background: 1000ms (conservative - don't break meeting bot)
    [status.state, status.botId, status.presenceMode]
  );

  const handleToggleKnowledgeAccess = useCallback(async () => {
    if (!status.botId) {
      return;
    }

    const newEnabled = !knowledgeAccessEnabled;
    setKnowledgeAccessEnabled(newEnabled);

    try {
      const result = await window.meetingBotApi?.setKnowledgeAccess?.({
        botId: status.botId,
        enabled: newEnabled,
      });

      // Revert if the call failed
      if (!result?.success) {
        setKnowledgeAccessEnabled(!newEnabled);
      }
    } catch {
      // Revert on error
      setKnowledgeAccessEnabled(!newEnabled);
    }
  }, [status.botId, knowledgeAccessEnabled]);

  const handleStopSpeaking = useCallback(async () => {
    if (!status.botId) {
      return;
    }

    try {
      await window.meetingBotApi?.stopSpeaking?.({ botId: status.botId });
      setIsSpeaking(false); // Optimistic update
      setHasPendingResponse(false); // Also clears pending if any
    } catch {
      // Ignore errors
    }
  }, [status.botId]);

  const handleLetSparkSpeak = useCallback(async () => {
    if (!status.botId) {
      return;
    }

    try {
      await window.meetingBotApi?.speakPendingResponse?.({ botId: status.botId });
      setHasPendingResponse(false); // Optimistic update
    } catch {
      // Ignore errors
    }
  }, [status.botId]);

  const handleStopRecording = useCallback(async () => {
    if (status.botId && onStopRecording) {
      await onStopRecording(status.botId);
    }
  }, [status.botId, onStopRecording]);

  const duration = formatRecordingDuration(status.recordingDuration ?? 0);
  const avatarNotConnected = status.avatarConnected === false;

  return (
    <div className="meeting-status meeting-status--recording">
      <div className="meeting-status__icon-wrapper">
        <Tooltip content={avatarNotConnected ? 'Interactive features unavailable' : undefined}>
          <Mic className={`meeting-status__icon meeting-status__icon--recording${avatarNotConnected ? ' meeting-status__icon--no-avatar' : ''}`} size={14} />
        </Tooltip>
        {recordingCount > 1 && (
          <Tooltip content={`${recordingCount} meetings recording`}>
            <span className="meeting-status__badge">{recordingCount}</span>
          </Tooltip>
        )}
        {status.captionsActive !== undefined && (
          <Tooltip content={status.captionsActive ? 'Captions flowing' : 'Captions seem to have stopped. Still recording.'}>
            <span
              className={`meeting-status__caption-dot ${status.captionsActive ? 'meeting-status__caption-dot--active' : 'meeting-status__caption-dot--warning'}`}
              aria-label={status.captionsActive ? 'Live captions active' : 'Live captions may have stopped'}
            />
          </Tooltip>
        )}
      </div>
      <span className="meeting-status__quip">{status.quip || 'Taking notes'}</span>
      {status.presenceMode && status.presenceMode !== 'silent' && (
        <Tooltip content={status.presenceMode === 'participant' ? 'Actively participating in the meeting' : 'Coaching you during the meeting'}>
          <span className="meeting-status__presence-pill">
            {status.presenceMode === 'participant' ? 'Join in' : 'Coach'}
          </span>
        </Tooltip>
      )}
      <span className="meeting-status__duration">{duration}</span>
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
      <Tooltip
        content={
          knowledgeAccessEnabled ? (
            <>
              <strong>Knowledge Q&A is ON</strong>
              <br />
              Rebel can search your Spaces to answer questions.
              <br />
              <span style={{ opacity: 0.7 }}>Click to turn off.</span>
            </>
          ) : (
            <>
              <strong>Answer questions from your Spaces</strong>
              <br />
              When someone asks Rebel a question (e.g., "Spark, what deadline did we agree on?"),
              Rebel will search your Spaces — notes, docs, meeting transcripts — to find the answer.
              <br /><br />
              <strong>Off (default):</strong> Rebel can only reference what's been said in this meeting.
              <br />
              <strong>On:</strong> Rebel searches your Spaces for answers.
              <br /><br />
              <span style={{ opacity: 0.7 }}>
                Privacy note: Answers are spoken aloud or posted in chat, so other participants will hear/see the information.
              </span>
            </>
          )
        }
      >
        <Button
          size="sm"
          variant="ghost"
          onClick={handleToggleKnowledgeAccess}
          className={`meeting-status__btn-knowledge ${knowledgeAccessEnabled ? 'meeting-status__btn-knowledge--active' : ''}`}
        >
          <Brain size={12} />
        </Button>
      </Tooltip>
      {hasPendingResponse && !isSpeaking && !contributionPreview && (
        <Tooltip content="Let Spark speak">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleLetSparkSpeak}
            className="meeting-status__btn-let-speak"
          >
            <MessageCircle size={12} />
          </Button>
        </Tooltip>
      )}
      {isSpeaking && (
        <Tooltip content="Stop speaking">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleStopSpeaking}
            className="meeting-status__btn-stop-speaking"
          >
            <VolumeX size={12} />
          </Button>
        </Tooltip>
      )}
      <Tooltip content="Stop recording">
        <Button
          size="sm"
          variant="ghost"
          onClick={handleStopRecording}
          className="meeting-status__btn-stop"
        >
          <Square size={12} />
        </Button>
      </Tooltip>
      {contributionPreview && !isSpeaking && (
        <ContributionPill
          preview={contributionPreview}
          botId={status.botId ?? ''}
          onCleared={() => {
            setContributionPreview(null);
            setHasPendingResponse(false);
          }}
        />
      )}
    </div>
  );
}
