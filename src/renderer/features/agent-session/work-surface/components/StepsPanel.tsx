import { createMessageSnippet, formatTimestamp } from '@renderer/utils/formatters';
import { summarizeFileOperations } from '@renderer/utils/fileOperations';
import styles from '../WorkSurface.module.css';
import type { StorylineEntry, StorylineFilters } from '../types';

const FILTERS: Array<{ key: keyof StorylineFilters; label: string }> = [
  { key: 'thinking', label: 'Thinking' },
  { key: 'files', label: 'Files' },
  { key: 'tools', label: 'Tools & status' }
];

type SessionStorylineProps = {
  entries: StorylineEntry[];
  filters: StorylineFilters;
  onToggleFilter: (filter: keyof StorylineFilters) => void;
  selectedStep: number | null;
  onSelectStep: (stepNumber: number) => void;
  /** Max characters for thinking snippet. Pass Infinity for no truncation. Default: 120 */
  snippetMaxLength?: number;
  /** Visual variant: 'cards' (default) or 'dividers' */
  variant?: 'cards' | 'dividers';
};

export const SessionStoryline = ({
  entries,
  filters,
  onToggleFilter,
  selectedStep,
  onSelectStep,
  snippetMaxLength = 120,
  variant = 'cards'
}: SessionStorylineProps) => {
  const listClassName = [
    styles.storylineList,
    variant === 'dividers' ? 'storyline-list--dividers' : ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={styles.storylineColumn}>
      <div className="scroll-fade-top" />

      <div className={styles.storylineFilterChips} role="group" aria-label="Storyline filters">
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={[styles.storylineFilterChip, filters[key] ? styles.storylineFilterChipActive : '']
              .filter(Boolean)
              .join(' ')}
            aria-pressed={filters[key]}
            onClick={() => onToggleFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {entries.length === 0 ? (
        <div className="empty-state">
          <strong>No agent steps yet</strong>
          <span>Run the agent to populate the insights timeline.</span>
        </div>
      ) : (
        <ul className={listClassName}>
          {entries.map((entry) => {
            const isSelected = entry.stepNumber === selectedStep;
            const timestampLabel = formatTimestamp(entry.timestamp);
            const thinkingText = 'text' in entry.thinkingEvent ? entry.thinkingEvent.text : '';
            const thinkingSnippet = filters.thinking
              ? snippetMaxLength === Infinity
                ? thinkingText
                : createMessageSnippet(thinkingText, snippetMaxLength)
              : null;
            const preferredOps = entry.fileOperations.filter((operation) => operation.stage === 'end');
            const fileOps = preferredOps.length > 0 ? preferredOps : entry.fileOperations;
            const fileSummary = filters.files && fileOps.length > 0 ? summarizeFileOperations(fileOps) : null;
            const toolEvents = entry.technicalEvents.filter((event) => event.type === 'tool');
            const errorEvents = entry.technicalEvents.filter((event) => event.type === 'error');
            const toolSummary =
              filters.tools && (toolEvents.length > 0 || errorEvents.length > 0)
                ? `⚙️ ${toolEvents.length}`
                : null;
            const errorSummary =
              filters.tools && errorEvents.length > 0 ? `⚠️ ${errorEvents.length}` : null;
            const badgeItems = [
              fileSummary ? `🗂 ${fileOps.length}` : null,
              toolSummary,
              errorSummary
            ].filter(Boolean);

            return (
              <li
                key={`storyline-step-${entry.stepNumber}`}
                className={[
                  styles.storylineEntry,
                  isSelected ? styles.storylineEntrySelected : '',
                  variant === 'dividers' ? 'storyline-entry--divider' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <button
                  type="button"
                  onClick={() => onSelectStep(entry.stepNumber)}
                  className={styles.storylineEntryButton}
                  aria-pressed={isSelected}
                >
                  <header className={styles.storylineEntryHeader}>
                    <span>{`Step ${entry.stepNumber}`}</span>
                    {timestampLabel ? <time>{timestampLabel}</time> : null}
                  </header>
                  <div className={styles.storylineEntryBody}>
                    {thinkingSnippet ? <p className={styles.storylineSnippet}>{thinkingSnippet}</p> : null}
                    <div className={styles.storylineEntryBadges}>
                      {fileSummary ? <span className={styles.storylineBadge}>{fileSummary}</span> : null}
                      {badgeItems.map((item, index) => (
                        <span key={`${entry.stepNumber}-badge-${index}`} className={styles.storylineBadgeLight}>
                          {item}
                        </span>
                      ))}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
