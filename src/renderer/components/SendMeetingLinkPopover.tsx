/**
 * SendMeetingLinkPopover
 *
 * Inline form for pasting a meeting link to send the Rebel notetaker.
 * Supports Zoom, Google Meet, and Microsoft Teams links.
 * Validates URLs client-side via extractMeetingId() from @rebel/shared.
 * Optionally allows scheduling for a future time (default: send now).
 */

import { useState, useCallback, useRef, useEffect, type FC } from 'react';
import { Video, CheckCircle, Loader2 } from 'lucide-react';
import { extractMeetingId } from '@rebel/shared';
import { Button } from '@renderer/components/ui/Button';
import { Input } from '@renderer/components/ui/Input';
import './SendMeetingLinkPopover.css';

const SEND_QUIPS = [
  'On my way. Save me a seat.',
  'Your stand-in has been summoned.',
  'Dispatching your proxy...',
  'Running to the meeting. Virtually.',
];

const SCHEDULED_QUIPS = [
  'Penciled in.',
  "I'll be there.",
  'Consider it handled.',
  'Noted. See you then.',
];

function pickQuip(quips: string[]): string {
  return quips[Math.floor(Math.random() * quips.length)];
}

/** Extract a human-readable platform label from a meeting ID prefix */
function getPlatformLabel(meetingId: string | null): string | null {
  if (!meetingId) return null;
  if (meetingId.startsWith('zoom:')) return 'Zoom';
  if (meetingId.startsWith('meet:')) return 'Google Meet';
  if (meetingId.startsWith('teams:')) return 'Teams';
  if (meetingId.startsWith('other:')) return 'Meeting';
  return null;
}

export interface SendMeetingLinkResult {
  success: boolean;
  botId?: string;
  error?: string;
  isOwner?: boolean;
  ownerName?: string;
  canOverride?: boolean;
}

export interface SendMeetingLinkPopoverProps {
  onSend: (meetingUrl: string, meetingTitle: string, scheduledFor?: string) => Promise<SendMeetingLinkResult>;
  onClose?: () => void;
}

export const SendMeetingLinkPopover: FC<SendMeetingLinkPopoverProps> = ({ onSend, onClose }) => {
  const [url, setUrl] = useState('');
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduledTime, setScheduledTime] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus input on mount
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  const trimmedUrl = url.trim();
  const meetingId = trimmedUrl ? extractMeetingId(trimmedUrl) : null;
  const platform = getPlatformLabel(meetingId);
  const isValidUrl = !!meetingId;

  const handleSend = useCallback(async () => {
    if (!trimmedUrl || !isValidUrl) return;

    setError(null);
    setSuccess(null);
    setSending(true);

    try {
      const title = platform ? `${platform} Meeting` : 'Meeting';
      const scheduledFor = showSchedule && scheduledTime
        ? new Date(scheduledTime).toISOString()
        : undefined;

      // Validate scheduled time is in the future
      if (scheduledFor) {
        const scheduledMs = new Date(scheduledFor).getTime();
        const nowMs = Date.now();
        if (scheduledMs <= nowMs) {
          setError('Pick a time in the future, or send now.');
          setSending(false);
          return;
        }
        const minutesAhead = (scheduledMs - nowMs) / (1000 * 60);
        if (minutesAhead < 15) {
          setError('Needs at least 15 minutes advance notice.');
          setSending(false);
          return;
        }
      }

      const result = await onSend(trimmedUrl, title, scheduledFor);

      if (result.success) {
        const quip = scheduledFor ? pickQuip(SCHEDULED_QUIPS) : pickQuip(SEND_QUIPS);
        setSuccess(quip);
        // Auto-close after a brief moment
        setTimeout(() => onClose?.(), 1800);
      } else if (result.isOwner === false && result.ownerName) {
        setError(`${result.ownerName}'s Rebel is already in this meeting.`);
      } else {
        setError(result.error ?? 'Something went wrong. Try again.');
      }
    } catch {
      setError('Something went sideways — try again.');
    } finally {
      setSending(false);
    }
  }, [trimmedUrl, isValidUrl, platform, showSchedule, scheduledTime, onSend, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && isValidUrl && !sending) {
      e.preventDefault();
      void handleSend();
    }
  }, [isValidUrl, sending, handleSend]);

  // Success state
  if (success) {
    return (
      <div className="send-meeting-link">
        <p className="send-meeting-link__success">
          <CheckCircle size={14} /> {success}
        </p>
      </div>
    );
  }

  return (
    <div className="send-meeting-link">
      <div className="send-meeting-link__input-row">
        <Input
          ref={inputRef}
          type="url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setError(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Paste a meeting link"
          aria-label="Meeting URL"
          autoComplete="off"
        />
        {platform && (
          <span className="send-meeting-link__platform-badge">
            <Video size={12} />
            {platform}
          </span>
        )}
      </div>

      {error && <p className="send-meeting-link__error">{error}</p>}

      {trimmedUrl && !isValidUrl && !error && (
        <p className="send-meeting-link__error">
          Paste a Zoom, Google Meet, or Teams link.
        </p>
      )}

      {!showSchedule && isValidUrl && (
        <button
          type="button"
          className="send-meeting-link__schedule-toggle"
          onClick={() => setShowSchedule(true)}
        >
          Schedule for later
        </button>
      )}

      {showSchedule && (
        <div className="send-meeting-link__schedule-row">
          <label htmlFor="schedule-time">When:</label>
          <input
            id="schedule-time"
            type="datetime-local"
            value={scheduledTime}
            onChange={(e) => setScheduledTime(e.target.value)}
          />
          <button
            type="button"
            className="send-meeting-link__schedule-toggle"
            onClick={() => {
              setShowSchedule(false);
              setScheduledTime('');
            }}
          >
            Now
          </button>
        </div>
      )}

      <div className="send-meeting-link__actions">
        <Button
          size="sm"
          onClick={() => void handleSend()}
          disabled={!isValidUrl || sending}
        >
          {sending ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              Sending...
            </>
          ) : showSchedule && scheduledTime ? (
            'Schedule'
          ) : (
            'Send now'
          )}
        </Button>
      </div>
    </div>
  );
};

SendMeetingLinkPopover.displayName = 'SendMeetingLinkPopover';
