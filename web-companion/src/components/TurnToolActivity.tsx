import { useMemo, useState } from 'react';
import {
  buildToolLabel,
  type CompletedStep,
  type ImageContentBlock,
  type ImageRef,
  type SessionToolEvent,
} from '@rebel/cloud-client';
import { CheckCircleIcon, ChevronDownIcon, LoaderIcon, XIcon } from './icons';
import { ToolResultImage } from './ToolResultImage';
import styles from './TurnToolActivity.module.css';

type DisplayStep = {
  key: string;
  label: string;
  shortDetail?: string;
  imageContent?: ImageContentBlock[];
  imageRef?: (ImageRef | null)[];
  isError: boolean;
  isInProgress: boolean;
};

type DisplayStepTimelineEntry = DisplayStep & {
  sortTimestamp: number;
  sortIndex: number;
};

interface TurnToolActivityProps {
  turnId: string;
  events?: SessionToolEvent[];
  fallbackSteps?: CompletedStep[];
  owningSessionId?: string;
}

function mapEventsToDisplaySteps(events: SessionToolEvent[], turnId: string): DisplayStep[] {
  const pairedByToolUseId = new Map<string, {
    start?: SessionToolEvent;
    end?: SessionToolEvent;
    firstTimestamp: number;
    firstIndex: number;
  }>();
  const standaloneEvents: Array<{ event: SessionToolEvent; index: number }> = [];

  events.forEach((event, index) => {
    const toolUseId = event.toolUseId?.trim();
    if (!toolUseId) {
      standaloneEvents.push({ event, index });
      return;
    }

    const existing = pairedByToolUseId.get(toolUseId);
    const pair = existing ?? {
      firstTimestamp: event.timestamp,
      firstIndex: index,
    };

    if (
      event.timestamp < pair.firstTimestamp
      || (event.timestamp === pair.firstTimestamp && index < pair.firstIndex)
    ) {
      pair.firstTimestamp = event.timestamp;
      pair.firstIndex = index;
    }

    if (event.stage === 'start') {
      pair.start = event;
    } else {
      pair.end = event;
    }

    pairedByToolUseId.set(toolUseId, pair);
  });

  const timelineEntries: DisplayStepTimelineEntry[] = [];

  pairedByToolUseId.forEach((pair, toolUseId) => {
    const sourceEvent = pair.start ?? pair.end;
    if (!sourceEvent) return;

    const fallbackToolName = sourceEvent.toolName?.trim() || 'tool';
    const detailForLabel = pair.start?.detail ?? pair.end?.detail;
    const richLabel = buildToolLabel(fallbackToolName, detailForLabel);
    const imageContent = pair.end?.imageContent ?? pair.start?.imageContent;
    const imageRef = pair.end?.imageRef ?? pair.start?.imageRef;

    timelineEntries.push({
      key: `${turnId}-event-${toolUseId}`,
      label: richLabel.label || fallbackToolName,
      shortDetail: richLabel.shortDetail,
      imageContent: imageContent && imageContent.length > 0 ? imageContent : undefined,
      imageRef: imageRef && imageRef.length > 0 ? imageRef : undefined,
      isError: Boolean(pair.end?.isError),
      isInProgress: Boolean(pair.start && !pair.end),
      sortTimestamp: pair.firstTimestamp,
      sortIndex: pair.firstIndex,
    });
  });

  standaloneEvents.forEach(({ event, index }) => {
    const fallbackToolName = event.toolName?.trim() || 'tool';
    const richLabel = buildToolLabel(fallbackToolName, event.detail);

    timelineEntries.push({
      key: `${turnId}-event-${event.timestamp}-${index}`,
      label: richLabel.label || fallbackToolName,
      shortDetail: richLabel.shortDetail,
      imageContent:
        event.stage === 'end' && event.imageContent && event.imageContent.length > 0
          ? event.imageContent
          : undefined,
      imageRef:
        event.stage === 'end' && event.imageRef && event.imageRef.length > 0
          ? event.imageRef
          : undefined,
      isError: event.stage === 'end' ? Boolean(event.isError) : false,
      isInProgress: event.stage === 'start',
      sortTimestamp: event.timestamp,
      sortIndex: index,
    });
  });

  timelineEntries.sort((a, b) => {
    if (a.sortTimestamp === b.sortTimestamp) {
      return a.sortIndex - b.sortIndex;
    }
    return a.sortTimestamp - b.sortTimestamp;
  });

  return timelineEntries.map((entry) => ({
    key: entry.key,
    label: entry.label,
    shortDetail: entry.shortDetail,
    imageContent: entry.imageContent,
    imageRef: entry.imageRef,
    isError: entry.isError,
    isInProgress: entry.isInProgress,
  }));
}

function mapFallbackStepToDisplayStep(step: CompletedStep, turnId: string, index: number): DisplayStep {
  const fallbackToolName = step.toolName?.trim() || step.label?.trim() || 'tool';
  const richLabel = buildToolLabel(fallbackToolName, step.detail);

  return {
    key: step.toolUseId ? `${turnId}-step-${step.toolUseId}` : `${turnId}-step-${step.timestamp}-${index}`,
    label: richLabel.label || fallbackToolName,
    shortDetail: richLabel.shortDetail,
    imageContent: undefined,
    imageRef: undefined,
    isError: Boolean(step.isError),
    isInProgress: false,
  };
}

export function TurnToolActivity({ turnId, events, fallbackSteps, owningSessionId }: TurnToolActivityProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const displaySteps = useMemo(() => {
    const serverEvents = events ?? [];
    if (serverEvents.length > 0) {
      return mapEventsToDisplaySteps(serverEvents, turnId);
    }

    return (fallbackSteps ?? []).map((step, index) => mapFallbackStepToDisplayStep(step, turnId, index));
  }, [events, fallbackSteps, turnId]);

  if (displaySteps.length === 0) return null;

  const summaryText = `Used ${displaySteps.length} tool${displaySteps.length === 1 ? '' : 's'}`;

  return (
    <div className={styles.container} data-testid={`turn-tool-activity-${turnId}`}>
      <button
        type="button"
        className={styles.summaryButton}
        onClick={() => setIsExpanded((prev) => !prev)}
        aria-expanded={isExpanded}
      >
        <span className={styles.summaryText}>{summaryText}</span>
        <span className={`${styles.chevron} ${isExpanded ? styles.chevronExpanded : ''}`}>
          <ChevronDownIcon size={14} />
        </span>
      </button>

      <div className={`${styles.stepsPanel} ${isExpanded ? styles.stepsPanelExpanded : ''}`}>
        <ul className={styles.stepsList}>
          {displaySteps.map((step) => (
            <li key={step.key} className={styles.stepRow}>
              <span className={styles.stepIconWrap}>
                {step.isInProgress ? (
                  <LoaderIcon size={12} className={styles.runningIcon} />
                ) : step.isError ? (
                  <XIcon size={12} className={styles.errorIcon} />
                ) : (
                  <CheckCircleIcon size={14} className={styles.successIcon} />
                )}
              </span>
              <div className={styles.stepContent}>
                <span className={styles.stepLabel}>
                  {step.label}
                  {step.shortDetail ? <span className={styles.stepDetail}>{` · ${step.shortDetail}`}</span> : null}
                </span>
                {(step.imageContent?.length || step.imageRef?.length) ? (
                  <ToolResultImage
                    images={step.imageContent}
                    imageRef={step.imageRef}
                    owningSessionId={owningSessionId}
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
