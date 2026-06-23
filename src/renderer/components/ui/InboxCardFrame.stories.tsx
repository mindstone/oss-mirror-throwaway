// @ts-nocheck
import * as React from 'react';
import { useMemo, useState } from 'react';
import { Archive, CheckCircle2, ExternalLink, FileText, Trash2 } from 'lucide-react';
import { Button, InlineToggle } from '@renderer/components/ui';
import { InboxCardFrame } from '@renderer/features/inbox/components/InboxCardFrame';
import cardStyles from '@renderer/features/inbox/components/InboxItemCard.module.css';
import expandedStyles from '@renderer/features/inbox/components/InboxItemExpanded.module.css';

const meta = {
  title: 'Inbox/Inbox Card Frame',
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'Internal preview for the extracted inbox workflow-card frame. This is a feature-level reusable shell for action cards with selection, activation, expansion, and footer actions. It is intentionally not part of the manifest-backed design-system registry.',
      },
    },
  },
};

export default meta;

const SAMPLE_TITLE = 'Review this action item';
const SAMPLE_SUBTITLE =
  'Use this space to preview how a medium-length title, supporting context, and action controls sit together inside the workflow card.';

function ExpandedPreview() {
  return (
    <div className={expandedStyles.expanded}>
      <div className={expandedStyles.references}>
        <span className={expandedStyles.sectionLabel}>References</span>
        <div className={expandedStyles.referenceChips}>
          <button className={`${expandedStyles.referenceChip} ${expandedStyles.referenceChipClickable}`} type="button">
            <FileText size={12} />
            <span className={expandedStyles.referenceChipLabel}>Reference link</span>
          </button>
          <button className={`${expandedStyles.referenceChip} ${expandedStyles.referenceChipClickable}`} type="button">
            <ExternalLink size={12} />
            <span className={expandedStyles.referenceChipLabel}>Supporting detail</span>
          </button>
        </div>
      </div>
      <div className={expandedStyles.clarifyingSection}>
        <span className={expandedStyles.sectionLabel}>Why expand exists</span>
        <p className={expandedStyles.clarifyingText}>
          This slot is where references, draft content, or clarifying details can appear when a card
          needs more context than the collapsed view should show.
        </p>
      </div>
    </div>
  );
}

function CardPreview({
  label,
  initialExpanded = false,
  initialSelected = false,
  initialArchived = false,
}) {
  const [isExpanded, setIsExpanded] = useState(initialExpanded);
  const [isSelected, setIsSelected] = useState(initialSelected);
  const [isArchived, setIsArchived] = useState(initialArchived);
  const [autoDone, setAutoDone] = useState(false);
  const [context, setContext] = useState('');

  const footer = useMemo(
    () => (
      <>
        <div className={cardStyles.footerLeft}>
          {!isArchived && (
            <>
              <button className={`${cardStyles.footerButton} ${cardStyles.footerButtonDanger}`} type="button">
                <Trash2 size={12} /> Delete
              </button>
              <button className={cardStyles.footerButton} type="button">
                <Archive size={12} /> Archive
              </button>
            </>
          )}
          {isArchived && (
            <button className={cardStyles.footerButton} type="button" onClick={() => setIsArchived(false)}>
              <Archive size={12} /> Restore
            </button>
          )}
        </div>
        <div className={cardStyles.footerRight}>
          {!isArchived && (
            <InlineToggle
              checked={autoDone}
              label="Auto-mark done"
              onCheckedChange={setAutoDone}
              stopPropagation
            />
          )}
          <Button size="xs" variant="outline">
            <CheckCircle2 size={11} /> Review
          </Button>
        </div>
      </>
    ),
    [autoDone, isArchived],
  );

  return (
    <section style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button size="xs" variant="outline" onClick={() => setIsExpanded((prev) => !prev)}>
            {isExpanded ? 'Collapse' : 'Expand'}
          </Button>
          <Button size="xs" variant="outline" onClick={() => setIsSelected((prev) => !prev)}>
            {isSelected ? 'Deselect' : 'Select'}
          </Button>
          <Button size="xs" variant="outline" onClick={() => setIsArchived((prev) => !prev)}>
            {isArchived ? 'Unarchive' : 'Archive'}
          </Button>
        </div>
      </div>

      <InboxCardFrame
        itemId={label.toLowerCase().replace(/\s+/g, '-')}
        isExpanded={isExpanded}
        isSelected={isSelected}
        isArchived={isArchived}
        selectionActive={isSelected}
        onToggleSelect={() => setIsSelected((prev) => !prev)}
        selectionLabel={`Select ${SAMPLE_TITLE}`}
        onActivate={() => setIsExpanded((prev) => !prev)}
        expandedContent={<ExpandedPreview />}
        footer={footer}
      >
        <div className={cardStyles.cardContent}>
          <span className={cardStyles.metaRow}>
            <span className={`${cardStyles.statusBadge} ${cardStyles.priorityHigh}`}>High</span>
            <span className={cardStyles.metaRowRight}>
              <span className={cardStyles.provenanceLabel}>Placeholder source</span>
              <span className={cardStyles.timestamp}>added 2h ago</span>
            </span>
          </span>
          <span className={cardStyles.cardTitle}>{SAMPLE_TITLE}</span>
          <div className={cardStyles.subtitleRow}>
            <p className={isExpanded ? cardStyles.subtitleExpanded : cardStyles.subtitle}>{SAMPLE_SUBTITLE}</p>
          </div>
          {!isArchived && (
            <div className={cardStyles.inputRow}>
              <textarea
                className={cardStyles.contextInput}
                placeholder="Add optional context..."
                value={context}
                rows={1}
                onChange={(event) => setContext(event.target.value)}
                onClick={(event) => event.stopPropagation()}
              />
            </div>
          )}
        </div>
      </InboxCardFrame>
    </section>
  );
}

export const InteractivePreview = {
  render: () => (
    <div style={{ display: 'grid', gap: 28, padding: '32px 24px', maxWidth: 1100 }}>
      <section style={{ display: 'grid', gap: 10, maxWidth: 760 }}>
        <h1 style={{ margin: 0, fontSize: 32, lineHeight: 1.2 }}>Inbox Card Frame</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', lineHeight: 1.55 }}>
          This is the extracted shell behind the main inbox action card. It owns the card structure,
          activation model, selection affordance, expansion wrapper, and footer slot. The inbox item
          itself still decides what content and actions go inside.
        </p>
      </section>

      <CardPreview label="Interactive example" />
      <CardPreview label="Expanded example" initialExpanded />
      <CardPreview label="Archived example" initialArchived />
    </div>
  ),
};
