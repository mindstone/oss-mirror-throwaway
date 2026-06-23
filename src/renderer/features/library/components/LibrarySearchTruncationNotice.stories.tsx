import type { Meta, StoryObj } from '@storybook/react';
import type { ReactNode } from 'react';
import { LibrarySearchTruncationNotice } from './LibrarySearchTruncationNotice';
import type { TruncationSignal } from '../search/useTruncationSignal';

const meta = {
  title: 'Library/Truncation Notice',
  component: LibrarySearchTruncationNotice,
  parameters: {
    layout: 'padded',
    controls: { disable: true },
  },
} satisfies Meta<typeof LibrarySearchTruncationNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

function ThemePair({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', width: 980, maxWidth: '100%' }}>
      <div className="light">{children}</div>
      <div className="dark">{children}</div>
    </div>
  );
}

function SurfaceMatrix({
  signal,
  onManageSpaces,
  dismissible = true,
}: {
  signal: TruncationSignal;
  onManageSpaces?: () => void;
  // cloud-degraded is non-dismissible in production; let those stories drop the
  // dismiss handler so the rendered story matches the real surface.
  dismissible?: boolean;
}) {
  const onDismiss = dismissible ? () => undefined : undefined;
  return (
    <ThemePair>
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <section style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <p style={{ margin: 0, fontWeight: 600 }}>Rail context (embedded)</p>
          <div style={{ width: 320, maxWidth: '100%' }}>
            <LibrarySearchTruncationNotice
              signal={signal}
              placement="embedded"
              onDismiss={onDismiss}
              onManageSpaces={onManageSpaces}
            />
          </div>
        </section>
        <section style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <p style={{ margin: 0, fontWeight: 600 }}>Main view context (inline)</p>
          <LibrarySearchTruncationNotice
            signal={signal}
            placement="inline"
            onDismiss={onDismiss}
            onManageSpaces={onManageSpaces}
          />
        </section>
      </div>
    </ThemePair>
  );
}

export const EngineCap: Story = {
  render: () => (
    <SurfaceMatrix
      signal={{
        kind: 'engine-cap',
        entriesTotal: 100_001,
        entriesIndexed: 100_000,
      }}
    />
  ),
};

export const TreeCap: Story = {
  render: () => <SurfaceMatrix signal={{ kind: 'tree' }} />,
};

export const BothCaps: Story = {
  render: () => (
    <SurfaceMatrix
      signal={{
        kind: 'both',
        entriesTotal: 145_000,
        entriesIndexed: 100_000,
      }}
    />
  ),
};

// A cloud space in scope is reconnecting, so results may be last-known. The
// cloud-degraded variant carries an info-tooltip (hover/focus the (i)) plus, when
// an onManageSpaces handler is wired, a "Manage in Settings" button. It is a live
// status, so it is non-dismissible (no X).

// Tooltip-only (no onManageSpaces) — the honest degradation: no dead button.
export const CloudDegradedSingle: Story = {
  render: () => (
    <SurfaceMatrix signal={{ kind: 'cloud-degraded', reconnectingSpaceCount: 1 }} dismissible={false} />
  ),
};

export const CloudDegradedMultiple: Story = {
  render: () => (
    <SurfaceMatrix signal={{ kind: 'cloud-degraded', reconnectingSpaceCount: 3 }} dismissible={false} />
  ),
};

// With onManageSpaces wired — the "Manage in Settings" button renders alongside
// the info tooltip. Hover/focus the (i) to see the detailed explanation.
export const CloudDegradedSingleWithManageSpaces: Story = {
  render: () => (
    <SurfaceMatrix
      signal={{ kind: 'cloud-degraded', reconnectingSpaceCount: 1 }}
      onManageSpaces={() => undefined}
      dismissible={false}
    />
  ),
};

export const CloudDegradedMultipleWithManageSpaces: Story = {
  render: () => (
    <SurfaceMatrix
      signal={{ kind: 'cloud-degraded', reconnectingSpaceCount: 3 }}
      onManageSpaces={() => undefined}
      dismissible={false}
    />
  ),
};
