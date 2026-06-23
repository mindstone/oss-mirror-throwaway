import { useEffect, useMemo, useState } from 'react';
import { Video, Eye, EyeOff, GraduationCap, ChevronDown, X } from 'lucide-react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
} from '@floating-ui/react';
import { Button } from '@renderer/components/ui/Button';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import type { OperatorMetadata } from '@shared/ipc/channels/operators';
import { useSettingsSafe } from '@renderer/features/settings';
import { useOperatorRegistry } from '@renderer/features/operators/hooks/useOperatorRegistry';
import { AskSparkButton } from './AskSparkButton';
import type { MeetingTriggerHeardState } from '../features/agent-session/hooks/useMeetingTriggerHeard';
import './MeetingCompanionBanner.css';

export interface CoachSelection {
  skillPath: string;
  skillName: string;
  description?: string;
  proactiveIntervalMinutes?: number;
}

export type PresenceMode = 'silent' | 'coach' | 'participant';

const PRESENCE_MODE_OPTIONS: Array<{ mode: PresenceMode; label: string }> = [
  { mode: 'silent', label: 'Listen' },
  { mode: 'coach', label: 'Coach' },
  { mode: 'participant', label: 'Join in' },
];

interface MeetingCompanionBannerProps {
  meetingTitle: string;
  meetingUrl: string;
  /** Whether the meeting is still recording */
  isRecording: boolean;
  /** Whether live captions are actively flowing (true = active, false = stale, undefined = unknown) */
  captionsActive?: boolean;
  /** Currently selected coach (null = no coach) */
  selectedCoach: CoachSelection | null;
  /** Callback when coach selection changes. `withPresenceMode` is set when the user picked a coach
   *  as part of switching to a mode that requires one (e.g. "Join in" without a coach). */
  onSelectCoach: (coach: CoachSelection | null, withPresenceMode?: PresenceMode) => void;
  /** Show all checks toggle (only visible when coach is selected) */
  showAllChecks?: boolean;
  /** Callback for show all checks toggle */
  onToggleShowAllChecks?: (value: boolean) => void;
  /** Bot presence mode (when undefined, derived from selectedCoach) */
  presenceMode?: PresenceMode;
  /** Callback when presence mode changes */
  onPresenceModeChange?: (mode: PresenceMode) => void;
  /** When true, hides "Join in" (participant) mode — local recording has no relay/avatar */
  disableParticipantMode?: boolean;
  /** Network connection status */
  isOnline?: boolean;
  /** State from the useMeetingTriggerHeard hook */
  triggerState?: MeetingTriggerHeardState;
  /** Callback to submit Ask Spark prompt */
  onAskSparkSubmit?: (prompt: string, label: string) => void;
  /** Opens the Operators panel from zero-state affordances. */
  onOpenOperatorsPanel?: () => void;
  /** Storybook/test seam for deterministic Operator scenarios. */
  operatorRegistryOverride?: {
    operators: OperatorMetadata[];
    loading?: boolean;
  };
}

/**
 * Banner shown at the top of meeting companion conversations.
 * Includes meeting info, coach picker, prep notes link, and filter toggle.
 */
export function MeetingCompanionBanner({
  meetingTitle,
  isRecording,
  captionsActive,
  selectedCoach,
  onSelectCoach,
  showAllChecks = true,
  onToggleShowAllChecks,
  presenceMode,
  onPresenceModeChange,
  disableParticipantMode,
  isOnline,
  triggerState,
  onAskSparkSubmit,
  onOpenOperatorsPanel,
  operatorRegistryOverride,
}: MeetingCompanionBannerProps) {
  const [isCoachPickerOpen, setIsCoachPickerOpen] = useState(false);
  const [showParticipantNotice, setShowParticipantNotice] = useState(false);
  const [pendingPresenceMode, setPendingPresenceMode] = useState<PresenceMode | null>(null);
  const settingsContext = useSettingsSafe();
  const registry = useOperatorRegistry({
    coreDirectory: settingsContext?.settings?.coreDirectory,
    mode: 'panel',
    roleFilter: 'live_meeting',
  });
  const operators = operatorRegistryOverride?.operators ?? registry.operators;
  const operatorsLoading = operatorRegistryOverride?.loading ?? registry.loading;

  const [showFirstUse, setShowFirstUse] = useState(() => {
    return localStorage.getItem('meeting.askSpark.onboardingDismissed') !== 'true';
  });
  const coachLabel = (coach: OperatorMetadata): string => coach.displayName ?? coach.name;

  const handleDismissFirstUse = () => {
    localStorage.setItem('meeting.askSpark.onboardingDismissed', 'true');
    setShowFirstUse(false);
  };

  const effectivePresenceMode: PresenceMode = presenceMode ?? (selectedCoach ? 'coach' : 'silent');

  useEffect(() => {
    if (!showParticipantNotice) return;
    const timeoutId = window.setTimeout(() => {
      setShowParticipantNotice(false);
    }, 3000);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [showParticipantNotice]);

  // Floating UI setup for coach picker
  const { refs, floatingStyles, context } = useFloating({
    open: isCoachPickerOpen,
    onOpenChange: setIsCoachPickerOpen,
    placement: 'bottom-start',
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'menu' });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    dismiss,
    role,
  ]);

  const coachOperators = useMemo(() => {
    return operators.filter((operator) => operator.roles.includes('live_meeting'));
  }, [operators]);

  // Group coaches by source (platform vs user)
  const { platformCoaches, userCoaches } = useMemo(() => {
    const platform: OperatorMetadata[] = [];
    const user: OperatorMetadata[] = [];
    
    for (const coach of coachOperators) {
      if (coach.category === 'bundled') {
        platform.push(coach);
      } else {
        user.push(coach);
      }
    }
    
    return { platformCoaches: platform, userCoaches: user };
  }, [coachOperators]);

  const handleSelectCoach = (skill: OperatorMetadata | null) => {
    const deferredMode = pendingPresenceMode;
    setPendingPresenceMode(null);

    if (skill === null) {
      onSelectCoach(null);
    } else {
      onSelectCoach({
        skillPath: skill.operatorFileAbsolutePath,
        skillName: coachLabel(skill),
        description: skill.description,
      }, deferredMode ?? undefined);
      if (deferredMode === 'participant') {
        setShowParticipantNotice(true);
      }
    }
    setIsCoachPickerOpen(false);
  };

  const handleClearCoach = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPendingPresenceMode(null);
    onSelectCoach(null);
  };

  const handlePresenceModeClick = (mode: PresenceMode) => {
    if (disableParticipantMode && mode === 'participant') return;
    if (mode === effectivePresenceMode) {
      return;
    }

    if (mode === 'participant' && !selectedCoach) {
      setPendingPresenceMode('participant');
      setIsCoachPickerOpen(true);
      return;
    }

    if (mode === 'silent') {
      setPendingPresenceMode(null);
      setIsCoachPickerOpen(false);
      setShowParticipantNotice(false);
    }

    onPresenceModeChange?.(mode);

    if (mode === 'participant' && selectedCoach) {
      setShowParticipantNotice(true);
    }
  };

  const hasCoaches = coachOperators.length > 0;
  const shouldShowCoachPicker = isRecording && !operatorsLoading && (effectivePresenceMode !== 'silent' || isCoachPickerOpen);

  let statusText: React.ReactNode = null;
  if (isOnline === false) {
    statusText = 'Offline - voice trigger paused. Ask Spark still saves questions.';
  } else if (triggerState?.rateLimited) {
    statusText = 'Voice trigger is paused for this meeting. Ask Spark still works.';
  } else if (triggerState?.pulsing) {
    statusText = 'Spark heard you';
  } else if (triggerState?.awaitingTurn) {
    statusText = 'Still drafting...';
  } else if (isRecording && captionsActive !== undefined) {
    statusText = captionsActive ? 'Captions flowing' : 'Captions seem to have stopped. Still recording.';
  }

  return (
    <div className="meeting-companion-banner-container">
      <div className="meeting-companion-banner">
        {/* Left side: Meeting info */}
        <div className="meeting-companion-banner__info">
          <div className="meeting-companion-banner__icon-wrapper">
            <Video size={14} className={isRecording ? 'meeting-companion-banner__recording-icon' : ''} />
            {isRecording && captionsActive !== undefined && (
              <Tooltip content={captionsActive ? 'Captions flowing' : 'Captions seem to have stopped. Still recording.'}>
                <span
                  className={`meeting-companion-banner__caption-dot ${captionsActive ? 'meeting-companion-banner__caption-dot--active' : 'meeting-companion-banner__caption-dot--warning'}`}
                  aria-label={captionsActive ? 'Live captions active' : 'Live captions may have stopped'}
                />
              </Tooltip>
            )}
          </div>
          <span className="meeting-companion-banner__title">{meetingTitle}</span>
          {statusText && isRecording && (
            <span className="meeting-companion-banner__status-text">{statusText}</span>
          )}
          {!isRecording && (
            <span className="meeting-companion-banner__ended">Meeting ended</span>
          )}
        </div>

        {/* Right side: Controls */}
        <div className="meeting-companion-banner__controls">
          {isRecording && onAskSparkSubmit && (
            <AskSparkButton
              isOnline={isOnline ?? true}
              isPulsing={triggerState?.pulsing ?? false}
              rateLimited={triggerState?.rateLimited ?? false}
              onSubmit={onAskSparkSubmit}
            />
          )}

          {isRecording && (
          <div className="meeting-companion-banner__mode-group">
            <div className="meeting-companion-banner__mode-toggle" role="group" aria-label="Companion mode">
              {(disableParticipantMode
                ? PRESENCE_MODE_OPTIONS.filter(o => o.mode !== 'participant')
                : PRESENCE_MODE_OPTIONS
              ).map((option) => (
                <Button
                  key={option.mode}
                  size="sm"
                  variant="ghost"
                  className={`meeting-companion-banner__mode-btn ${effectivePresenceMode === option.mode ? 'meeting-companion-banner__mode-btn--active' : ''}`}
                  onClick={() => handlePresenceModeClick(option.mode)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
            {showParticipantNotice && (
              <span className="meeting-companion-banner__mode-notice">
                Spark will speak up when there's something to add.
              </span>
            )}
          </div>
        )}

        {/* Coach picker */}
        {shouldShowCoachPicker && (
          <div className="meeting-companion-banner__coach-picker">
            <Button
              ref={refs.setReference}
              size="sm"
              variant="ghost"
              className={`meeting-companion-banner__coach-btn ${selectedCoach ? 'meeting-companion-banner__coach-btn--active' : ''}`}
              {...getReferenceProps()}
            >
              <GraduationCap size={12} />
              <span>{selectedCoach ? selectedCoach.skillName : 'No coach'}</span>
              <ChevronDown size={10} />
            </Button>
            {selectedCoach && (
              <button
                type="button"
                className="meeting-companion-banner__coach-clear"
                onClick={handleClearCoach}
                aria-label="Clear coach selection"
              >
                <X size={10} />
              </button>
            )}

            {isCoachPickerOpen && (
              <FloatingPortal>
                <div
                  ref={refs.setFloating}
                  style={floatingStyles}
                  className="meeting-companion-banner__coach-menu"
                  role="menu"
                  {...getFloatingProps()}
                >
                  <button
                    className={`meeting-companion-banner__coach-item ${!selectedCoach ? 'meeting-companion-banner__coach-item--selected' : ''}`}
                    onClick={() => handleSelectCoach(null)}
                    role="menuitem"
                  >
                    No coach
                  </button>

                  {!hasCoaches && (
                    <div
                      className="meeting-companion-banner__coach-zero-state"
                      role="presentation"
                    >
                      <span>No coaches available — install or activate a live meeting coach.</span>
                      {onOpenOperatorsPanel && (
                        <button
                          type="button"
                          className="meeting-companion-banner__coach-zero-link"
                          onClick={() => {
                            setIsCoachPickerOpen(false);
                            onOpenOperatorsPanel();
                          }}
                        >
                          Open Operators panel
                        </button>
                      )}
                    </div>
                  )}

                  {userCoaches.length > 0 && (
                    <>
                      <div className="meeting-companion-banner__coach-separator" />
                      <div className="meeting-companion-banner__coach-section">Your Coaches</div>
                      {userCoaches.map((coach) => (
                        <button
                          key={coach.id}
                          className={`meeting-companion-banner__coach-item ${selectedCoach?.skillPath === coach.operatorFileAbsolutePath ? 'meeting-companion-banner__coach-item--selected' : ''}`}
                          onClick={() => handleSelectCoach(coach)}
                          role="menuitem"
                        >
                          <span className="meeting-companion-banner__coach-name">{coachLabel(coach)}</span>
                          {coach.description && (
                            <span className="meeting-companion-banner__coach-desc">{coach.description}</span>
                          )}
                        </button>
                      ))}
                    </>
                  )}

                  {platformCoaches.length > 0 && (
                    <>
                      <div className="meeting-companion-banner__coach-separator" />
                      <div className="meeting-companion-banner__coach-section">Base Coaches</div>
                      {platformCoaches.map((coach) => (
                        <button
                          key={coach.id}
                          className={`meeting-companion-banner__coach-item ${selectedCoach?.skillPath === coach.operatorFileAbsolutePath ? 'meeting-companion-banner__coach-item--selected' : ''}`}
                          onClick={() => handleSelectCoach(coach)}
                          role="menuitem"
                        >
                          <span className="meeting-companion-banner__coach-name">{coachLabel(coach)}</span>
                          {coach.description && (
                            <span className="meeting-companion-banner__coach-desc">{coach.description}</span>
                          )}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </FloatingPortal>
            )}
          </div>
        )}

        {/* Show all checks toggle - only visible when coach is selected */}
        {isRecording && selectedCoach && onToggleShowAllChecks && effectivePresenceMode !== 'participant' && (
          <Tooltip content={showAllChecks ? 'Show tips only' : 'Show all checks'}>
            <button
              type="button"
              className="meeting-companion-banner__toggle"
              onClick={() => onToggleShowAllChecks(!showAllChecks)}
              aria-label={showAllChecks ? 'Show tips only' : 'Show all checks'}
            >
              {showAllChecks ? <Eye size={14} /> : <EyeOff size={14} />}
            </button>
          </Tooltip>
        )}
      </div>
      </div>

      {/* Extra rows */}
      {showFirstUse && (
        <div className="meeting-companion-banner__extra-row">
          <span>Try: "Hey Spark, summarise so far." Answers stay here, not in the call.</span>
          <button onClick={handleDismissFirstUse} className="meeting-companion-banner__extra-row-close" aria-label="Dismiss">
            <X size={12} />
          </button>
        </div>
      )}
      {!showFirstUse && triggerState?.lastDropReason && (
        <div className="meeting-companion-banner__extra-row">
          <span>Your last question didn't go through. Please ask again.</span>
        </div>
      )}
    </div>
  );
}
