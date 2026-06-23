import { memo } from 'react';
import { ExternalLink, FileText, Mail } from 'lucide-react';
import type { InboxItem, InboxReference } from '@shared/types';
import styles from './InboxItemExpanded.module.css';

export type InboxItemExpandedProps = {
  item: InboxItem;
  onOpenFile?: (path: string) => void;
};

function getReferenceLabel(ref: InboxReference): string {
  if (ref.label) return ref.label;
  if (ref.kind === 'workspace') return ref.path.split(/[/\\]/).pop() || ref.path;
  if (ref.kind === 'url') return ref.url;
  if (ref.kind === 'email') return ref.threadId;
  return 'Reference';
}

function getReferenceIcon(ref: InboxReference) {
  if (ref.kind === 'email') return Mail;
  if (ref.kind === 'url') return ExternalLink;
  return FileText;
}

const InboxItemExpandedComponent = ({
  item,
  onOpenFile,
}: InboxItemExpandedProps) => {
  const hasReferences = (item.references?.length ?? 0) > 0;
  const hasDraft = !!item.draft?.trim();
  const hasClarifyingQuestion = !!item.clarifyingQuestion?.trim();

  const handleReferenceClick = (ref: InboxReference) => {
    if (ref.kind === 'workspace' && onOpenFile) {
      onOpenFile(ref.path);
    } else if (ref.kind === 'url') {
      try {
        const parsed = new URL(ref.url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          void window.api.openUrl(ref.url);
        }
      } catch {
        // Malformed URL — ignore silently
      }
    }
  };

  const hasAnything = hasReferences || hasDraft || hasClarifyingQuestion;
  if (!hasAnything) return null;

  return (
    <div className={styles.expanded}>
      {/* References */}
      {hasReferences && (
        <div className={styles.references}>
          <span className={styles.sectionLabel}>References</span>
          <div className={styles.referenceChips}>
            {item.references.map((ref, i) => {
              const Icon = getReferenceIcon(ref);
              const isClickable = ref.kind === 'workspace' || ref.kind === 'url';
              return (
                <button
                  key={i}
                  className={`${styles.referenceChip} ${isClickable ? styles.referenceChipClickable : ''}`}
                  onClick={isClickable ? () => handleReferenceClick(ref) : undefined}
                  type="button"
                  disabled={!isClickable}
                >
                  <Icon size={12} />
                  <span className={styles.referenceChipLabel}>
                    {getReferenceLabel(ref)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Draft content */}
      {hasDraft && (
        <div className={styles.draftSection}>
          <span className={styles.sectionLabel}>Rebel&apos;s draft</span>
          <span className={styles.sectionSubtext}>You can edit this before sending</span>
          <div className={styles.draftContent}>
            {(item.draft?.split('\n') ?? []).map((line, i) => (
              <p key={i} className={styles.draftParagraph}>{line}</p>
            ))}
          </div>
        </div>
      )}

      {/* Clarifying question */}
      {hasClarifyingQuestion && (
        <div className={styles.clarifyingSection}>
          <span className={styles.sectionLabel}>Rebel needs your input</span>
          <p className={styles.clarifyingText}>{item.clarifyingQuestion}</p>
        </div>
      )}
    </div>
  );
};

export const InboxItemExpanded = memo(InboxItemExpandedComponent);
InboxItemExpanded.displayName = 'InboxItemExpanded';
