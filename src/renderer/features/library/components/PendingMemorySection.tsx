/**
 * PendingMemorySection
 *
 * Collapsible section showing pending memory write approvals in the Library (Show: Memory).
 * Triggers agent turns without navigation - user can optionally navigate to
 * the session to watch the turn execute live.
 */

import { useState, useCallback, type FC } from 'react';
import { Brain, ChevronDown, X, RefreshCw, ExternalLink } from 'lucide-react';
import { getFileName } from '@renderer/utils/stringUtils';
import { cn } from '@renderer/lib/utils';
import { formatRelativeTime as _formatRelativeTime, legacyMissingLocation } from '@rebel/shared';
import { FileLocationBadge } from '@renderer/components/ui/FileLocationBadge';
import type { PendingMemoryRequest } from '../hooks/usePendingMemoryApprovals';
import styles from './PendingMemorySection.module.css';

const COLLAPSED_KEY = 'memory-pending-section-collapsed';

export interface PendingMemorySectionProps {
  requests: PendingMemoryRequest[];
  onSave: (toolUseId: string) => Promise<void>;
  onSkip: (toolUseId: string) => Promise<void>;
  onSaveAll: () => Promise<void>;
  onSkipAll: () => Promise<void>;
  /** Navigate to the conversation that triggered this approval */
  onViewConversation?: (sessionId: string) => void;
}

const formatRelativeTime = (timestamp: number): string =>
  _formatRelativeTime(timestamp, { includeYesterday: false, absoluteDateAfterDays: 1 });

export const PendingMemorySection: FC<PendingMemorySectionProps> = ({
  requests,
  onSave,
  onSkip,
  onSaveAll,
  onSkipAll,
  onViewConversation,
}) => {
  // Auto-expand when 3+ items, otherwise respect stored preference
  const [isExpanded, setIsExpanded] = useState(() => {
    if (requests.length >= 3) return true;
    if (typeof window === 'undefined') return false;
    try {
      const stored = localStorage.getItem(COLLAPSED_KEY);
      return stored !== 'true';
    } catch {
      return false;
    }
  });

  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [skippingIds, setSkippingIds] = useState<Set<string>>(new Set());
  const [isBulkSaving, setIsBulkSaving] = useState(false);
  const [isBulkSkipping, setIsBulkSkipping] = useState(false);

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? 'false' : 'true');
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  }, []);

  const handleSave = useCallback(
    async (toolUseId: string) => {
      setSavingIds((prev) => new Set([...prev, toolUseId]));
      try {
        await onSave(toolUseId);
      } finally {
        setSavingIds((prev) => {
          const next = new Set(prev);
          next.delete(toolUseId);
          return next;
        });
      }
    },
    [onSave]
  );

  const handleSkip = useCallback(
    async (toolUseId: string) => {
      setSkippingIds((prev) => new Set([...prev, toolUseId]));
      try {
        await onSkip(toolUseId);
      } finally {
        setSkippingIds((prev) => {
          const next = new Set(prev);
          next.delete(toolUseId);
          return next;
        });
      }
    },
    [onSkip]
  );

  const handleSaveAll = useCallback(async () => {
    setIsBulkSaving(true);
    try {
      await onSaveAll();
    } finally {
      setIsBulkSaving(false);
    }
  }, [onSaveAll]);

  const handleSkipAll = useCallback(async () => {
    setIsBulkSkipping(true);
    try {
      await onSkipAll();
    } finally {
      setIsBulkSkipping(false);
    }
  }, [onSkipAll]);

  if (requests.length === 0) return null;

  const isMultiple = requests.length > 1;
  const isAnyProcessing =
    savingIds.size > 0 || skippingIds.size > 0 || isBulkSaving || isBulkSkipping;

  return (
    <div className={styles.container}>
      <button
        type="button"
        className={styles.header}
        onClick={handleToggle}
        aria-expanded={isExpanded}
        aria-label={isExpanded ? 'Collapse pending memories' : 'Expand pending memories'}
      >
        <div className={styles.iconWrapper}>
          <Brain size={14} className={styles.icon} aria-hidden />
          {isMultiple && <span className={styles.badge}>{requests.length}</span>}
        </div>
        <span className={styles.title}>
          Waiting to remember
          {!isExpanded && (
            <span className={styles.subtitle}>
              {requests.length === 1 ? '1 memory forming...' : `${requests.length} memories forming...`}
            </span>
          )}
        </span>
        <ChevronDown
          size={14}
          className={cn(styles.chevron, isExpanded && styles.chevronOpen)}
          aria-hidden
        />
      </button>

      {isExpanded && (
        <div className={styles.content}>
          {requests.map((request) => {
            const isSaving = savingIds.has(request.toolUseId);
            const isSkipping = skippingIds.has(request.toolUseId);
            const isProcessing = isSaving || isSkipping || isBulkSaving || isBulkSkipping;
            const filename = getFileName(request.filePath);
            // Stage 5A+ parity: render <FileLocationBadge> instead of a
            // handcrafted spaceName ▸ filename breadcrumb. The badge handles
            // middle-ellipsis, degraded state, and a11y consistently with
            // the rest of the inbox surface.
            const location = request.location ?? legacyMissingLocation({
              fileName: filename,
              spaceName: request.spaceName,
              legacyPath: request.spacePath || request.filePath,
            });

            return (
              <div key={request.toolUseId} className={styles.itemCard}>
                <div className={styles.itemHeader}>
                  <FileLocationBadge
                    location={location}
                    className={styles.itemMeta}
                  />
                  <span className={styles.itemTime}>{formatRelativeTime(request.timestamp)}</span>
                </div>
                <p className={styles.itemSummary}>{request.summary}</p>
                <div className={styles.itemActions}>
                  <button
                    type="button"
                    className={styles.saveButton}
                    onClick={() => handleSave(request.toolUseId)}
                    disabled={isProcessing}
                  >
                    {isSaving ? (
                      <>
                        <RefreshCw size={12} className={styles.spinning} />
                        Allowing...
                      </>
                    ) : (
                      'Allow once'
                    )}
                  </button>
                  <button
                    type="button"
                    className={styles.skipButton}
                    onClick={() => handleSkip(request.toolUseId)}
                    disabled={isProcessing}
                  >
                    {isSkipping ? (
                      <>
                        <RefreshCw size={12} className={styles.spinning} />
                        Denying...
                      </>
                    ) : (
                      <>
                        <X size={12} />
                        Deny
                      </>
                    )}
                  </button>
                  {onViewConversation && (
                    <button
                      type="button"
                      className={styles.viewButton}
                      onClick={() => onViewConversation(request.originalSessionId)}
                      disabled={isProcessing}
                      title="View conversation"
                      aria-label="View conversation"
                    >
                      <ExternalLink size={12} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {isMultiple && (
            <div className={styles.bulkActions}>
              <button
                type="button"
                className={styles.bulkSkipButton}
                onClick={handleSkipAll}
                disabled={isAnyProcessing}
              >
                {isBulkSkipping ? (
                  <>
                    <RefreshCw size={12} className={styles.spinning} />
                    Denying...
                  </>
                ) : (
                  <>
                    <X size={12} />
                    Deny all
                  </>
                )}
              </button>
              <button
                type="button"
                className={styles.bulkSaveButton}
                onClick={handleSaveAll}
                disabled={isAnyProcessing}
              >
                {isBulkSaving ? (
                  <>
                    <RefreshCw size={12} className={styles.spinning} />
                    Allowing...
                  </>
                ) : (
                  'Allow all'
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

PendingMemorySection.displayName = 'PendingMemorySection';
