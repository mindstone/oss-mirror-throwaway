import { useState, type ReactNode } from 'react';
import { MessageMarkdown } from '@renderer/components/MessageMarkdown';
import { ImageGrid } from '@renderer/features/agent-session/components/ImageGrid';
import { imageGridSourceFromEvent } from '@renderer/features/agent-session/components/imageGridSource';
import { ToolResultContent } from '@renderer/features/agent-session/components/ToolResultContent';
import { getFileOperationDetails } from '@renderer/utils/fileOperations';
import { formatTimestamp, formatUsage } from '@renderer/utils/formatters';
import { tryFormatJSON } from '@renderer/utils/stringUtils';
import styles from '../WorkSurface.module.css';
import type { StorylineEntry, StorylineFilters } from '../types';
import type { AgentTurnMessage } from '@shared/types';
import type React from 'react';

type StorylineDetailPanelProps = {
  entry: StorylineEntry | null;
  filters: StorylineFilters;
  showDetails: boolean;
  setShowDetails?: React.Dispatch<React.SetStateAction<boolean>>;
  loadWorkspaceFile: (path: string) => Promise<void>;
  onOpenConversation?: (sessionId: string) => void;
  /** Session the storyline events belong to. Used to resolve `imageRef` assets via `rebel-asset://`. */
  sessionId?: string;
  messages?: AgentTurnMessage[];
  editingMessageId?: string | null;
  onBeginEditMessage?: (messageId: string) => void;
};

type DetailSectionProps = {
  title: string;
  badge?: string;
  defaultOpen?: boolean;
  children: ReactNode;
};

const DetailSection = ({ title, badge, defaultOpen = true, children }: DetailSectionProps) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <section className={[styles.detailSection, isOpen ? styles.detailSectionOpen : ''].filter(Boolean).join(' ')}>
      <button
        type="button"
        className={styles.detailSectionHeader}
        onClick={() => setIsOpen((value) => !value)}
        aria-expanded={isOpen}
      >
        <span>{title}</span>
        <div className={styles.detailSectionMeta}>
          {badge ? <span className={styles.detailSectionBadge}>{badge}</span> : null}
          <span className={styles.detailSectionChevron} aria-hidden>
            {isOpen ? '▾' : '▸'}
          </span>
        </div>
      </button>
      {isOpen ? <div className={styles.detailSectionBody}>{children}</div> : null}
    </section>
  );
};
export const StorylineDetailPanel = ({
  entry,
  filters,
  showDetails,
  loadWorkspaceFile,
  onOpenConversation,
  sessionId,
  messages,
  editingMessageId,
  onBeginEditMessage
}: StorylineDetailPanelProps) => {
  const filtersDisabled = !filters.thinking && !filters.files && !filters.tools;

  const renderFileSection = () => {
    if (!entry || !filters.files || entry.fileOperations.length === 0) {
      return null;
    }
    const preferredOps = entry.fileOperations.filter((operation) => operation.stage === 'end');
    const fileOps = preferredOps.length > 0 ? preferredOps : entry.fileOperations;
    return (
      <DetailSection
        key={`files-${entry.stepNumber}`}
        title="File activity"
        badge={`${fileOps.length}`}
        defaultOpen
      >
        <ul className={styles.fileOperationsList}>
          {fileOps.map((op, index) => (
            <li key={`${op.timestamp}-${index}`} className={styles.fileOperationItem}>
              {getFileOperationDetails(op)}
            </li>
          ))}
        </ul>
      </DetailSection>
    );
  };

  const renderEditedMessageBanner = () => {
    if (!messages || !editingMessageId) {
      return null;
    }
    const target = messages.find((message) => message.id === editingMessageId && message.role === 'user');
    if (!target) {
      return null;
    }

    return (
      <section className={styles.editedMessageBanner} aria-label="Editing message">
        <header className={styles.editedMessageBannerHeader}>
          <h5>Editing message</h5>
          {onBeginEditMessage ? (
            <button
              type="button"
              className={styles.editedMessageBannerButton}
              onClick={() => onBeginEditMessage(target.id)}
            >
              Edit in composer
            </button>
          ) : null}
        </header>
        <div className={styles.editedMessageBannerBody}>
          <MessageMarkdown
            content={target.text}
            onOpenFile={loadWorkspaceFile}
            onOpenConversation={onOpenConversation}
          />
        </div>
      </section>
    );
  };

  const renderTechnicalSection = () => {
    if (!entry || !filters.tools || entry.technicalEvents.length === 0) {
      return null;
    }
    return (
      <DetailSection
        key={`tools-${entry.stepNumber}`}
        title="Tool & status events"
        badge={`${entry.technicalEvents.length}`}
      >
        <section className={styles.statusDetailsEntries}>
          {entry.technicalEvents.map((event, index) => {
            const entryClassName = [
              styles.statusEntry,
              event.type === 'error' ? styles.statusEntryError : '',
              event.type === 'tool' ? styles.statusEntryTool : ''
            ]
              .filter(Boolean)
              .join(' ');

            let title = 'Status';
            let body: ReactNode = null;

            if (event.type === 'tool') {
              const jsonResult = tryFormatJSON(event.detail);
              title = `${event.stage === 'start' ? 'Tool call' : 'Tool result'} • ${event.toolName}$${
                jsonResult.isJSON ? ' (JSON)' : ''
              }`;
              const gridImages =
                event.stage === 'end'
                  ? imageGridSourceFromEvent(
                      { imageContent: event.imageContent, imageRef: event.imageRef },
                      sessionId,
                      { altPrefix: `${event.toolName} result image` },
                    )
                  : [];
              const contentRefs =
                event.stage === 'end'
                  ? (event.contentRef ?? []).flatMap((contentRef, contentIndex) => (
                      contentRef
                        ? [{
                          key: `${event.toolUseId ?? event.toolName}-${contentIndex}-${contentRef.contentId}`,
                          contentRef,
                          fallbackSummary: typeof contentRef.summary === 'string' ? contentRef.summary : undefined,
                        }]
                        : []
                    ))
                  : [];
              body = (
                <>
                  {jsonResult.isJSON ? (
                    <pre className={styles.jsonDisplay}>
                      <code>{jsonResult.formatted}</code>
                    </pre>
                  ) : (
                    <p>{jsonResult.formatted}</p>
                  )}
                  {gridImages.length > 0 ? <ImageGrid images={gridImages} /> : null}
                  {sessionId && contentRefs.length > 0 ? (
                    <div className="mt-2 space-y-2">
                      {contentRefs.map((entry) => (
                        <ToolResultContent
                          key={entry.key}
                          sessionId={sessionId}
                          contentRef={entry.contentRef}
                          fallbackSummary={entry.fallbackSummary}
                        />
                      ))}
                    </div>
                  ) : null}
                </>
              );
            } else if (event.type === 'error') {
              title = 'Error';
              body = <p>{event.error}</p>;
            } else if (event.type === 'result') {
              title = 'Run complete';
              body = (
                <>
                  <p>{event.text}</p>
                  {formatUsage(event) ? <p className={styles.usageLine}>{formatUsage(event)}</p> : null}
                </>
              );
            } else if (event.type === 'status') {
              body = <p>{event.message}</p>;
            } else {
              body = null;
            }

            return (
              <div className={entryClassName} key={`${event.type}-${event.timestamp}-${index}`}>
                <h5>{title}</h5>
                {body}
              </div>
            );
          })}
        </section>
      </DetailSection>
    );
  };

  return (
    <aside
      className={[styles.storylineDetailPanel, showDetails ? styles.storylineDetailPanelOpen : '']
        .filter(Boolean)
        .join(' ')}
      aria-label="Step details"
    >
      {!showDetails ? null : entry ? (
        <div className={styles.storylineDetailBody}>
          {renderEditedMessageBanner()}
          <header className={styles.storylineDetailHeader}>
            <div>
              <h4>{`Step ${entry.stepNumber}`}</h4>
              <p>{formatTimestamp(entry.timestamp)}</p>
            </div>
          </header>

          {filters.thinking && 'text' in entry.thinkingEvent && entry.thinkingEvent.text ? (
            <DetailSection key={`thinking-${entry.stepNumber}`} title="Assistant thinking">
              <MessageMarkdown
                content={entry.thinkingEvent.text}
                onOpenFile={loadWorkspaceFile}
                onOpenConversation={onOpenConversation}
              />
            </DetailSection>
          ) : null}

          {renderFileSection()}
          {renderTechnicalSection()}

          {filtersDisabled ? (
            <div className="empty-state">
              <strong>Filters disabled</strong>
              <span>Enable at least one filter to inspect details.</span>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="empty-state">
          <strong>Select a step</strong>
          <span>Choose a step on the left to inspect its full context.</span>
        </div>
      )}
    </aside>
  );
};
