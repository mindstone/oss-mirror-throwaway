import type { Meta, StoryObj } from '@storybook/react';
import type { ReactNode } from 'react';
import { Copy, Database } from 'lucide-react';
import { Notice } from '@renderer/components/ui';
import { AdditionalViewRow } from './AdditionalViewRow';
import { ConversationStarRating } from './ConversationStarRating';
import { MessageWorkDisclosure } from './MessageWorkDisclosure';
import { PrimaryViewSourceStrip } from './PrimaryViewSourceStrip';
import styles from './ConversationPane.module.css';

const meta = {
  title: 'Agent Session/MCP Apps/Primary Message States',
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'A3c local conversation states for primary MCP App views: primary body, collapsed work, additional views, failure, and narrow width.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function FakePrimaryView({
  title = 'Editable email draft',
  summary = 'Email draft to alice@example.com about the Q2 plan.',
  prose = 'Drafted the email for review.',
  showFullProse = false,
  failed = false,
  sourcePackageId = 'GoogleWorkspace-jane-example-com',
  defaultTooltipOpen = false,
  compactStrip = false,
}: {
  title?: string;
  summary?: string;
  prose?: string;
  showFullProse?: boolean;
  failed?: boolean;
  sourcePackageId?: string | null;
  defaultTooltipOpen?: boolean;
  compactStrip?: boolean;
}) {
  return (
    <section className={styles.mcpAppPrimaryView} aria-label={title}>
      <div className={styles.mcpAppPrimaryCaption}>
        <p>{showFullProse ? prose : prose.split('. ')[0] + (prose.includes('. ') ? '.' : '')}</p>
        {showFullProse ? (
          <p className={styles.mcpAppPrimaryCaptionFull}>{prose}</p>
        ) : prose.length > 140 ? (
          <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-xs)' }}>
            Show Rebel&apos;s note
          </span>
        ) : null}
      </div>
      <PrimaryViewSourceStrip
        sourcePackageId={sourcePackageId}
        viewRoleLabel={title}
        defaultTooltipOpen={defaultTooltipOpen}
        isCompact={compactStrip}
        hasFailure={failed}
      />
      {failed ? (
        <Notice tone="error" placement="inline" title="The view failed to load.">
          <div className={styles.mcpAppRecoveryContent}>
            <p>Rebel&apos;s note is still here.</p>
            <p className={styles.mcpAppSummaryBlock}>{summary}</p>
          </div>
        </Notice>
      ) : (
        <div
          style={{
            minHeight: 220,
            border: '1px solid var(--color-border-soft)',
            borderRadius: 'var(--radius-lg)',
            background: 'color-mix(in srgb, var(--color-card) 78%, transparent)',
            display: 'grid',
            placeItems: 'center',
            color: 'var(--color-text-secondary)',
          }}
        >
          {summary}
        </div>
      )}
    </section>
  );
}

function StoryFrame({ children, narrow = false }: { children: ReactNode; narrow?: boolean }) {
  return (
    <div
      style={{
        maxWidth: narrow ? 360 : 760,
        containerType: 'inline-size',
        containerName: 'conversation',
        display: 'grid',
        gap: 'var(--space-3)',
        padding: 24,
      }}
    >
      {children}
    </div>
  );
}

function ResultMessageFooterAnatomy({ narrow = false }: { narrow?: boolean }) {
  return (
    <StoryFrame narrow={narrow}>
      <article className={`${styles.message} ${styles.result}`} data-role="result">
        <header className={styles.header}>
          <span className={styles.label}>
            <span>Behind the scenes</span>
            <span>Memory checked</span>
          </span>
        </header>
        <div className={styles.body}>
          <p>
            Created Actions item: <strong>Meeting: Team Member website handoff</strong>
          </p>
          <p>Included a brief meeting summary and executable proposals.</p>
        </div>
        <footer className={styles.footer} aria-label="Message actions and response feedback">
          <span className={styles.footerMeta} role="group" aria-label="Message actions and metadata">
            <button className={`${styles.action} ${styles.infoIcon}`} type="button" aria-label="View turn usage details">
              <Database size={14} aria-hidden />
            </button>
            <button className={`${styles.action} ${styles.usageButton}`} type="button" aria-label="Copy message">
              <Copy size={14} aria-hidden />
            </button>
            <time>10:57</time>
          </span>
          <div
            className={styles.footerFeedback}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)', color: 'var(--color-text-muted)' }}
          >
            <span style={{ fontSize: 'var(--text-xs)', whiteSpace: 'nowrap' }}>How was this response?</span>
            <ConversationStarRating value={null} onSelect={() => undefined} size="sm" />
          </div>
        </footer>
      </article>
    </StoryFrame>
  );
}

export const SinglePrimary: Story = {
  render: () => (
    <StoryFrame>
      <FakePrimaryView />
    </StoryFrame>
  ),
};

export const ResultFooterAnatomy: Story = {
  render: () => <ResultMessageFooterAnatomy />,
};

export const ResultFooterAnatomyNarrow: Story = {
  render: () => <ResultMessageFooterAnatomy narrow />,
};

export const SourceStripDefaultClosedTooltip: Story = {
  render: () => (
    <StoryFrame>
      <PrimaryViewSourceStrip
        sourcePackageId="GoogleWorkspace-jane-example-com"
        viewRoleLabel="Editable email draft"
      />
    </StoryFrame>
  ),
};

export const SourceStripDefaultOpenTooltip: Story = {
  render: () => (
    <StoryFrame>
      <PrimaryViewSourceStrip
        sourcePackageId="GoogleWorkspace-jane-example-com"
        viewRoleLabel="Editable email draft"
        defaultTooltipOpen
      />
    </StoryFrame>
  ),
};

export const SourceStripDefaultLightTheme: Story = {
  decorators: [
    (StoryComponent) => (
      <div className="light" style={{ minHeight: '100vh', background: 'var(--color-bg-page)', color: 'var(--color-text-primary)' }}>
        <StoryComponent />
      </div>
    ),
  ],
  render: () => (
    <StoryFrame>
      <PrimaryViewSourceStrip
        sourcePackageId="GoogleWorkspace-jane-example-com"
        viewRoleLabel="Editable email draft"
      />
    </StoryFrame>
  ),
};

export const SourceStripDefaultDarkTheme: Story = {
  decorators: [
    (StoryComponent) => (
      <div className="dark" style={{ minHeight: '100vh', background: 'var(--color-bg-page)', color: 'var(--color-text-primary)' }}>
        <StoryComponent />
      </div>
    ),
  ],
  render: () => (
    <StoryFrame>
      <PrimaryViewSourceStrip
        sourcePackageId="GoogleWorkspace-jane-example-com"
        viewRoleLabel="Editable email draft"
      />
    </StoryFrame>
  ),
};

export const SourceStripCompactWidth: Story = {
  render: () => (
    <StoryFrame narrow>
      <PrimaryViewSourceStrip
        sourcePackageId="GoogleWorkspace-jane-example-com"
        viewRoleLabel="Editable email draft"
        isCompact
      />
    </StoryFrame>
  ),
};

export const SourceStripUnknownSource: Story = {
  render: () => (
    <StoryFrame>
      <PrimaryViewSourceStrip
        sourcePackageId="unknown-foo-bar-jane-example-com"
        viewRoleLabel="Generated chart"
      />
    </StoryFrame>
  ),
};

export const SourceStripNoSourceFallback: Story = {
  render: () => (
    <StoryFrame>
      <PrimaryViewSourceStrip viewRoleLabel="Interactive view" />
    </StoryFrame>
  ),
};

export const SourceStripRebelPrefixExternal: Story = {
  render: () => (
    <StoryFrame>
      <PrimaryViewSourceStrip
        sourcePackageId="rebel-canvas"
        viewRoleLabel="External connector with Rebel-like name"
      />
    </StoryFrame>
  ),
};

export const PrimaryWithCollapsedWork: Story = {
  render: () => (
    <StoryFrame>
      <FakePrimaryView />
      <MessageWorkDisclosure label="Show 2 steps" count={2}>
        <div>Read source notes</div>
        <div>Checked calendar availability</div>
      </MessageWorkDisclosure>
    </StoryFrame>
  ),
};

export const PrimaryWithOpenWork: Story = {
  render: () => (
    <StoryFrame>
      <FakePrimaryView />
      <MessageWorkDisclosure label="Show 2 steps" count={2} defaultOpen>
        <div>Read source notes</div>
        <div>Checked calendar availability</div>
      </MessageWorkDisclosure>
    </StoryFrame>
  ),
};

export const LongProseDisclosureCollapsed: Story = {
  render: () => (
    <StoryFrame>
      <FakePrimaryView
        prose="Drafted the email for review. I checked the source notes, reconciled the names, and left the tone calm because apparently emails work better when they do not read like a hostage note. The draft is ready below."
      />
    </StoryFrame>
  ),
};

export const LongProseDisclosureExpanded: Story = {
  render: () => (
    <StoryFrame>
      <FakePrimaryView
        showFullProse
        prose="Drafted the email for review. I checked the source notes, reconciled the names, and left the tone calm because apparently emails work better when they do not read like a hostage note. The draft is ready below."
      />
    </StoryFrame>
  ),
};

export const PrimaryWithAdditionalViews: Story = {
  render: () => (
    <StoryFrame>
      <FakePrimaryView />
      <div className={styles.additionalViewsList}>
        <AdditionalViewRow
          viewRoleLabel="Secondary email draft"
          viewSummary="Follow-up draft for the customer success team."
          onOpen={() => undefined}
        />
        <AdditionalViewRow
          viewRoleLabel="Calendar options"
          viewSummary="Three proposed time slots for next week."
          status="loading"
          onOpen={() => undefined}
        />
      </div>
    </StoryFrame>
  ),
};

export const FailedDemotedAdditionalView: Story = {
  render: () => (
    <StoryFrame>
      <FakePrimaryView />
      <div className={styles.additionalViewsList}>
        <AdditionalViewRow
          viewRoleLabel="Secondary email draft"
          viewSummary="Follow-up draft preserved, but the view needs attention."
          status="failed"
          expanded={false}
          onOpen={() => undefined}
        />
      </div>
    </StoryFrame>
  ),
};

export const FailedInlineAutoOpen: Story = {
  render: () => (
    <StoryFrame>
      <FakePrimaryView />
      <MessageWorkDisclosure label="Show details" count={1} forceOpenWhenActiveOrFailed>
        <div>Inline lookup failed; Rebel keeps the work visible instead of tidying it away.</div>
      </MessageWorkDisclosure>
    </StoryFrame>
  ),
};

export const DemotedPrimaryCopyBehavior: Story = {
  render: () => (
    <StoryFrame>
      <FakePrimaryView />
      <div className={styles.additionalViewsList}>
        <AdditionalViewRow
          viewRoleLabel="Secondary email draft"
          viewSummary="Included in host-composed copy after the lead view summary."
          onOpen={() => undefined}
        />
      </div>
      <pre className={styles.mcpAppFallbackText}>
        {[
          'Copy message output:',
          'Drafted the email for review.',
          '[Editable email draft]',
          'Email draft to alice@example.com about the Q2 plan.',
          '[Secondary email draft]',
          'Included in host-composed copy after the lead view summary.',
        ].join('\n')}
      </pre>
    </StoryFrame>
  ),
};

export const FailedPrimary: Story = {
  render: () => (
    <StoryFrame>
      <FakePrimaryView failed />
      <MessageWorkDisclosure label="Show details" count={1} defaultOpen>
        <div>Compose email failed to load; fallback preserved.</div>
      </MessageWorkDisclosure>
    </StoryFrame>
  ),
};

export const SourceStripAboveRecoveryNotice: Story = {
  render: () => (
    <StoryFrame>
      <FakePrimaryView failed />
    </StoryFrame>
  ),
};

export const NarrowWidth: Story = {
  render: () => (
    <StoryFrame narrow>
      <FakePrimaryView compactStrip />
      <div className={styles.additionalViewsList}>
        <AdditionalViewRow
          viewRoleLabel="Secondary email draft"
          viewSummary="A deliberately long summary that should wrap before the chevron action instead of pushing the transcript sideways."
          onOpen={() => undefined}
        />
      </div>
    </StoryFrame>
  ),
};

export const MobileParityNote: Story = {
  render: () => (
    <StoryFrame>
      <div className={styles.mcpAppSummaryBlock}>
        Mobile renders additional primary views as native placeholder rows with the same role label and summary.
        React Native Storybook does not run in this desktop Storybook build.
      </div>
    </StoryFrame>
  ),
};
