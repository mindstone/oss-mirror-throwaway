import { useMemo, useState } from 'react';
import { buildToolLabel, type CompletedStep } from '@rebel/cloud-client';
import { CheckCircleIcon, ChevronDownIcon, XIcon } from './icons';
import styles from './AgentActivityBubble.module.css';

const TOOL_STATUS_PATTERN = /^Using\s+(.+?)\.\.\.$/i;

type DisplayStep = {
  key: string;
  label: string;
  shortDetail?: string;
  isError: boolean;
};

function parseRunningToolName(statusText?: string | null): string | null {
  const trimmed = statusText?.trim();
  if (!trimmed) return null;

  const match = TOOL_STATUS_PATTERN.exec(trimmed);
  return match?.[1]?.trim() || null;
}

interface AgentActivityBubbleProps {
  completedSteps: CompletedStep[];
  statusText?: string | null;
  thinkingHeadline?: string;
}

export function AgentActivityBubble({
  completedSteps,
  statusText,
  thinkingHeadline,
}: AgentActivityBubbleProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const runningToolLabel = useMemo(() => {
    const toolName = parseRunningToolName(statusText);
    if (!toolName) return null;
    return buildToolLabel(toolName);
  }, [statusText]);

  const displaySteps = useMemo<DisplayStep[]>(() => {
    return completedSteps.map((step, index) => {
      const fallbackToolName = step.toolName?.trim() || step.label?.trim() || 'Tool';
      const richLabel = buildToolLabel(fallbackToolName, step.detail);

      return {
        key: step.toolUseId ? `tool-${step.toolUseId}` : `step-${step.timestamp}-${index}`,
        label: richLabel.label || fallbackToolName,
        shortDetail: richLabel.shortDetail,
        isError: Boolean(step.isError),
      };
    });
  }, [completedSteps]);

  const headline = useMemo(() => {
    if (runningToolLabel) {
      return runningToolLabel.shortDetail
        ? `${runningToolLabel.label} · ${runningToolLabel.shortDetail}`
        : runningToolLabel.label;
    }

    return thinkingHeadline?.trim() || 'Rebel is thinking...';
  }, [runningToolLabel, thinkingHeadline]);

  const completedCount = displaySteps.length;

  return (
    <div className={styles.container} data-testid="conversation-live-tool-activity">
      <div className={styles.headlineRow}>
        <span className={styles.pulseDot} aria-hidden="true" />
        <p className={styles.headline}>{headline}</p>
      </div>

      {completedCount > 0 && (
        <div className={styles.stepsSection}>
          <button
            type="button"
            className={styles.toggleButton}
            onClick={() => setIsExpanded((prev) => !prev)}
            aria-expanded={isExpanded}
          >
            <span>
              {isExpanded
                ? 'Hide completed steps'
                : `Show ${completedCount} completed step${completedCount === 1 ? '' : 's'}`}
            </span>
            <span className={`${styles.chevron} ${isExpanded ? styles.chevronExpanded : ''}`}>
              <ChevronDownIcon size={14} />
            </span>
          </button>

          <div className={`${styles.stepsPanel} ${isExpanded ? styles.stepsPanelExpanded : ''}`}>
            <ul className={styles.stepsList}>
              {displaySteps.map((step) => (
                <li key={step.key} className={styles.stepRow}>
                  <span className={styles.stepIconWrap}>
                    {step.isError ? (
                      <XIcon size={12} className={styles.errorIcon} />
                    ) : (
                      <CheckCircleIcon size={14} className={styles.successIcon} />
                    )}
                  </span>
                  <span className={styles.stepLabel}>
                    {step.label}
                    {step.shortDetail ? <span className={styles.stepDetail}>{` · ${step.shortDetail}`}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
