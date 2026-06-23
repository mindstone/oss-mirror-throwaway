import type { CSSProperties, ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { AlertTriangle, CheckCircle2, Plug, UserRound } from 'lucide-react';
import { ConnectionChip } from '@renderer/features/settings/components/ConnectionChip';
import type { UnifiedConnection } from '@renderer/features/settings/hooks/useUnifiedConnections';
import type { DirectConnectorEntry } from '@shared/types';

const meta = {
  title: 'Design System/Molecules/Connector Chips',
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'Molecule taxonomy review page. Connector chips should answer one question clearly: provider, identity, status, or attention. The current production chip is shown as evidence, not as the final taxonomy.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const connectorFixtures = {
  notion: {
    id: 'notion',
    name: 'Notion',
    description: 'Search docs and project context from your workspace.',
    category: 'productivity',
    provider: 'direct',
    icon: 'file-text',
    popular: true,
    verified: true,
    accountIdentity: 'email',
    maturity: 'stable',
    mcpConfig: {
      transport: 'http',
      url: 'https://mcp.notion.com/mcp',
      oauth: true,
    },
  },
  linear: {
    id: 'linear',
    name: 'Linear',
    description: 'Track issues, projects, and team progress.',
    category: 'development',
    provider: 'direct',
    icon: 'target',
    popular: true,
    verified: true,
    accountIdentity: 'workspace',
    maturity: 'stable',
    mcpConfig: {
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      oauth: true,
    },
  },
  monologue: {
    id: 'monologue',
    name: 'Monologue',
    description: 'Search personal voice notes and transcripts.',
    category: 'productivity',
    provider: 'direct',
    icon: 'mic',
    accountIdentity: 'email',
    maturity: 'beta',
    mcpConfig: {
      transport: 'http',
      url: 'https://api.monologue.to/mcp',
      oauth: true,
    },
  },
} satisfies Record<string, DirectConnectorEntry>;

type ConnectorFixtureId = keyof typeof connectorFixtures;

function buildConnection({
  id,
  catalogId,
  status,
  email,
  workspace,
  disabled,
  toolCount,
}: {
  id: string;
  catalogId: ConnectorFixtureId;
  status: UnifiedConnection['status'];
  email?: string;
  workspace?: string;
  disabled?: boolean;
  toolCount?: number;
}): UnifiedConnection {
  const catalogEntry = connectorFixtures[catalogId];
  if (!catalogEntry) {
    throw new Error(`Missing connector catalog fixture: ${catalogId}`);
  }
  return {
    id,
    name: catalogEntry.name,
    description: catalogEntry.description,
    icon: catalogEntry.icon,
    status,
    provider: catalogEntry.provider,
    catalogEntry,
    toolCount,
    serverPreview: {
      name: `${catalogEntry.name}-storybook`,
      transport: catalogEntry.mcpConfig.transport === 'http' ? 'http' : 'stdio',
      url: catalogEntry.mcpConfig.transport === 'http' ? catalogEntry.mcpConfig.url : undefined,
      health: status === 'connected' ? 'ok' : status === 'error' ? 'error' : 'unavailable',
      email,
      workspace,
      disabled,
      lastConnectedAt: Date.now() - 1000 * 60 * 60 * 24 * 3,
    },
  };
}

const notionConnection = buildConnection({
  id: 'notion-workspace',
  catalogId: 'notion',
  status: 'connected',
  email: '[Mindstone-email]',
  toolCount: 15,
});

const linearConnection = buildConnection({
  id: 'linear-workspace',
  catalogId: 'linear',
  status: 'needs-setup',
  workspace: 'Mindstone',
  toolCount: 9,
});

const monologueConnection = buildConnection({
  id: 'monologue-beta',
  catalogId: 'monologue',
  status: 'available',
});

const disabledConnection = buildConnection({
  id: 'linear-disabled',
  catalogId: 'linear',
  status: 'connected',
  workspace: 'Archived workspace',
  disabled: true,
  toolCount: 3,
});

const errorConnection = buildConnection({
  id: 'notion-error',
  catalogId: 'notion',
  status: 'error',
  email: '[Mindstone-email]',
  toolCount: 15,
});

const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--color-text-secondary)',
};

const reviewCardStyle: CSSProperties = {
  padding: 16,
  borderRadius: 16,
  border: '1px solid rgba(255,255,255,0.08)',
  background: 'rgba(255,255,255,0.03)',
};

function IntroBadge({ children }: { children: string }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        alignSelf: 'start',
        padding: '4px 10px',
        borderRadius: 999,
        background: 'rgba(148,163,184,0.14)',
        color: 'var(--color-text-secondary)',
        fontSize: 12,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </div>
  );
}

type TaxonomyTone = 'provider' | 'identity' | 'status' | 'attention';

function TaxonomyPill({
  icon,
  label,
  tone,
}: {
  icon: ReactNode;
  label: string;
  tone: TaxonomyTone;
}) {
  const toneStyles: Record<TaxonomyTone, CSSProperties> = {
    provider: {
      background: 'rgba(99,102,241,0.14)',
      borderColor: 'rgba(99,102,241,0.28)',
      color: 'var(--color-text-primary)',
    },
    identity: {
      background: 'rgba(148,163,184,0.12)',
      borderColor: 'rgba(148,163,184,0.22)',
      color: 'var(--color-text-secondary)',
    },
    status: {
      background: 'rgba(34,197,94,0.12)',
      borderColor: 'rgba(34,197,94,0.24)',
      color: 'var(--color-success, #22c55e)',
    },
    attention: {
      background: 'rgba(245,158,11,0.14)',
      borderColor: 'rgba(245,158,11,0.32)',
      color: 'var(--color-warning, #f59e0b)',
    },
  };

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 10px',
        borderRadius: 999,
        border: '1px solid',
        fontSize: 13,
        fontWeight: 600,
        ...toneStyles[tone],
      }}
    >
      {icon}
      {label}
    </span>
  );
}

function TaxonomyCard({
  title,
  job,
  example,
  children,
}: {
  title: string;
  job: string;
  example: string;
  children: ReactNode;
}) {
  return (
    <div style={{ ...reviewCardStyle, display: 'grid', gap: 10 }}>
      <div style={{ fontWeight: 650 }}>{title}</div>
      <div style={{ color: 'var(--color-text-secondary)', lineHeight: 1.55 }}>{job}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{children}</div>
      <div style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>Example: {example}</div>
    </div>
  );
}

export const CurrentReality: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 28, padding: '32px 24px', maxWidth: 1060 }}>
      <section style={{ display: 'grid', gap: 10 }}>
        <IntroBadge>Molecule taxonomy</IntroBadge>
        <h1 style={{ margin: 0, fontSize: 32, lineHeight: 1.2 }}>Connector Chips</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', lineHeight: 1.55, maxWidth: 780 }}>
          Connector chips are trust signals in Settings. They need to make service, account,
          health, and attention states easy to scan without asking one small pill to do
          every job at once.
        </p>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={headingStyle}>Current production reality</h2>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', lineHeight: 1.55, maxWidth: 820 }}>
          The current <code>ConnectionChip</code> is a real app pattern. It can show provider,
          source/maturity, account identity, loading, disabled, status, and attention states.
          This page makes that complexity reviewable before any future chip extraction.
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <ConnectionChip connection={notionConnection} />
          <ConnectionChip connection={notionConnection} showAccountIdentity />
          <ConnectionChip connection={linearConnection} attentionState="needs-attention" showAccountIdentity />
          <ConnectionChip connection={monologueConnection} />
          <ConnectionChip connection={disabledConnection} attentionState="inactive" showAccountIdentity />
          <ConnectionChip connection={notionConnection} isLoading showAccountIdentity />
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={headingStyle}>Production contexts to keep honest</h2>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', lineHeight: 1.55, maxWidth: 820 }}>
          These are the prop combinations that show up in the live connectors panel. They are included
          here so future extraction work does not only optimize for the default chip.
        </p>
        <div style={{ ...reviewCardStyle, display: 'grid', gap: 14 }}>
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>Grouped list chips without repeated icons or badges</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <ConnectionChip connection={notionConnection} showIcon={false} showBadge={false} showAccountIdentity />
              <ConnectionChip connection={linearConnection} showIcon={false} showBadge={false} attentionState="needs-attention" />
            </div>
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>Clickable and expanded selector state</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <ConnectionChip connection={notionConnection} onClick={() => undefined} tabIndex={0} />
              <ConnectionChip connection={linearConnection} isExpanded onClick={() => undefined} aria-selected />
            </div>
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>Plain error state without an explicit attention override</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <ConnectionChip connection={errorConnection} showAccountIdentity />
            </div>
          </div>
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={headingStyle}>Target taxonomy to review against</h2>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))' }}>
          <TaxonomyCard
            title="Provider chip"
            job="Identifies the service or connector."
            example="Notion, Linear, Slack, Rebel Browser."
          >
            <TaxonomyPill icon={<Plug size={14} />} label="Notion" tone="provider" />
          </TaxonomyCard>
          <TaxonomyCard
            title="Identity chip"
            job="Answers which account, workspace, or team is connected."
            example="[Mindstone-email], Mindstone workspace."
          >
            <TaxonomyPill icon={<UserRound size={14} />} label="Mindstone" tone="identity" />
          </TaxonomyCard>
          <TaxonomyCard
            title="Status chip"
            job="Communicates passive connection state."
            example="Connected, inactive, syncing, disconnected."
          >
            <TaxonomyPill icon={<CheckCircle2 size={14} />} label="Connected" tone="status" />
          </TaxonomyCard>
          <TaxonomyCard
            title="Attention chip"
            job="Signals that the user needs to do something."
            example="Needs attention, reconnect required, permissions needed."
          >
            <TaxonomyPill icon={<AlertTriangle size={14} />} label="Needs attention" tone="attention" />
          </TaxonomyCard>
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={headingStyle}>Composition rule</h2>
        <div style={{ ...reviewCardStyle, display: 'grid', gap: 12, lineHeight: 1.55 }}>
          <div style={{ color: 'var(--color-text-primary)', fontWeight: 650 }}>
            A connector chip should answer one question clearly.
          </div>
          <div style={{ color: 'var(--color-text-secondary)' }}>
            If the UI needs to say "Notion, connected as [Mindstone-email], but needs attention",
            that is probably a composed row or card state, not one overloaded pill.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <TaxonomyPill icon={<Plug size={14} />} label="Notion" tone="provider" />
            <TaxonomyPill icon={<UserRound size={14} />} label="[Mindstone-email]" tone="identity" />
            <TaxonomyPill icon={<AlertTriangle size={14} />} label="Needs attention" tone="attention" />
          </div>
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={headingStyle}>What this page is not</h2>
        <div style={{ ...reviewCardStyle, display: 'grid', gap: 8, color: 'var(--color-text-secondary)', lineHeight: 1.55 }}>
          <div>It is not a new shared <code>ChipBase</code> atom.</div>
          <div>It is not a promise that the current production <code>ConnectionChip</code> should keep every semantic job forever.</div>
          <div>It is the review surface for deciding which chip jobs should split apart before implementation catches up.</div>
        </div>
      </section>
    </div>
  ),
};
