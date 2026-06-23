/**
 * MeetingButton
 *
 * Collapsed button for passive meeting states.
 * Shows a dimmed calendar icon that opens a popover with:
 * - "Paste a meeting link" input to send the notetaker to any meeting
 * - Meeting settings link
 * 
 * This replaces the "No meetings detected" text in the header to reduce noise.
 * Active meeting states continue to render inline via MeetingStatusIndicator.
 */

import { useState, type FC } from 'react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  FloatingPortal,
  useDismiss,
  useClick,
  useInteractions,
} from '@floating-ui/react';
import { CalendarDays, Mic, Settings } from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import { IconButton } from '@renderer/components/ui/IconButton';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import { MaturityBadge } from '@renderer/components/ui/MaturityBadge';
import { useMeetingStatus } from '@renderer/hooks/useMeetingStatus';
import type { MeetingState } from '@shared/ipc/channels/meetingBot';
import { SendMeetingLinkPopover, type SendMeetingLinkResult } from './SendMeetingLinkPopover';
import './MeetingButton.css';

const PASSIVE_STATES_FOR_BUTTON: ReadonlySet<MeetingState> = new Set([
  'no_meetings',
  'preview',
  'done',
  'done_physical',
  'done_quick_capture',
]);

export interface MeetingButtonProps {
  onOpenSettings?: () => void;
  onSendToMeeting?: (meetingUrl: string, meetingTitle: string, scheduledFor?: string) => Promise<SendMeetingLinkResult>;
  onStartQuickCapture?: () => void | Promise<void>;
  isQuickCaptureRecording?: boolean;
}

/**
 * MeetingButtonInner - the actual button UI (always renders)
 */
const MeetingButtonInner: FC<MeetingButtonProps> = ({
  onOpenSettings,
  onSendToMeeting,
  onStartQuickCapture,
  isQuickCaptureRecording,
}) => {
  const [isOpen, setIsOpen] = useState(false);

  const {
    refs,
    floatingStyles,
    context,
  } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'bottom',
    middleware: [
      offset(8),
      flip({ fallbackAxisSideDirection: 'start', padding: 8 }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context);
  const dismiss = useDismiss(context, {
    escapeKey: true,
    outsidePress: true,
  });

  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss]);

  const handleOpenSettings = () => {
    onOpenSettings?.();
    setIsOpen(false);
  };

  return (
    <>
      <Tooltip content="Notetaker options" disabled={isOpen}>
        <IconButton
          ref={refs.setReference}
          size="sm"
          className="meeting-button"
          aria-label="Notetaker options"
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          {...getReferenceProps()}
        >
          <CalendarDays size={16} className="meeting-button__icon" />
        </IconButton>
      </Tooltip>

      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className="meeting-button-popover"
            role="dialog"
            aria-label="Notetaker settings"
            {...getFloatingProps()}
          >
            <div className="meeting-button-popover__header">
              <span className="meeting-button-popover__title">Notetaker</span>
              <MaturityBadge level="labs" featureName="Notetaker" />
            </div>

            {onSendToMeeting ? (
              <SendMeetingLinkPopover
                onSend={onSendToMeeting}
                onClose={() => setIsOpen(false)}
              />
            ) : (
              <p className="meeting-button-popover__text">
                No upcoming meetings
              </p>
            )}

            <div className="meeting-button-popover__actions">
              {onStartQuickCapture && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void onStartQuickCapture();
                    setIsOpen(false);
                  }}
                  disabled={isQuickCaptureRecording}
                  className="meeting-button-popover__btn"
                >
                  <Mic size={14} />
                  Record from mic
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={handleOpenSettings}
                className="meeting-button-popover__btn"
              >
                <Settings size={14} />
                Meeting settings
              </Button>
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  );
};

MeetingButtonInner.displayName = 'MeetingButtonInner';

/**
 * MeetingButton - Only renders for passive meeting states.
 * Place this in the header-right area alongside other icon buttons.
 */
export const MeetingButton: FC<MeetingButtonProps> = (props) => {
  const status = useMeetingStatus();
  
  // Only show the collapsed button in passive states.
  if (!PASSIVE_STATES_FOR_BUTTON.has(status.state)) {
    return null;
  }
  
  return <MeetingButtonInner {...props} />;
};

MeetingButton.displayName = 'MeetingButton';
