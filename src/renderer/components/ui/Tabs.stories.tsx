import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui';

const meta = {
  title: 'Design System/Atoms/Tabs',
  component: Tabs,
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'Canonical content-tabs gallery. Use this for the shared `Tabs` atom; compare app navigation and filter patterns under `Navigation Controls` so the visual family stays aligned.',
      },
    },
  },
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 24, maxWidth: 720, padding: 24 }}>
      <section style={{ display: 'grid', gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Tabs</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
          Shared content-tabs component. These switch between related panels inside one surface.
          App navigation and filter-style controls live under `Navigation Controls` so
          their visual language can match without overloading this atom.
        </p>
      </section>
      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>How this should be used</h2>
        <div
          style={{
            display: 'grid',
            gap: 8,
            padding: 16,
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.08)',
            background: 'rgba(255,255,255,0.03)',
            lineHeight: 1.55,
          }}
        >
          <div><strong>Tabs</strong> - switch between tightly related content views inside the same surface.</div>
          <div><strong>Use shared Tabs for</strong> settings subtabs, dialogs, diagnostics, and other generic content switching.</div>
          <div><strong>Not for</strong> app-wide navigation, inbox temporal filters, Library lens chips (`Show` / `View as`), or pinned conversation tabs. Those belong to the broader navigation-control family and should visually align with this atom.</div>
        </div>
      </section>
      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Where it is used now</h2>
        <div
          style={{
            display: 'grid',
            gap: 8,
            padding: 16,
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.08)',
            background: 'rgba(255,255,255,0.03)',
            lineHeight: 1.55,
          }}
        >
          <div>Used for in-surface organization in settings, diagnostics, modal views, and other content areas.</div>
          <div>The app-shell navigation chips, library scope buttons, inbox temporal tabs, and pinned conversation tabs should be reviewed together under `Navigation Controls` before any consolidation.</div>
        </div>
      </section>
      {(['default', 'pills', 'underline'] as const).map((variant) => (
        <section key={variant} style={{ display: 'grid', gap: 12 }}>
          <div style={{ color: 'var(--color-text-secondary)', textTransform: 'capitalize' }}>{variant}</div>
          <Tabs defaultValue="overview">
            <TabsList variant={variant}>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <p style={{ margin: '12px 0 0', color: 'var(--color-text-secondary)' }}>
                Use tab variants to balance density and emphasis.
              </p>
            </TabsContent>
            <TabsContent value="activity">
              <p style={{ margin: '12px 0 0', color: 'var(--color-text-secondary)' }}>
                Good preview surface for interaction states and focus behavior.
              </p>
            </TabsContent>
            <TabsContent value="history">
              <p style={{ margin: '12px 0 0', color: 'var(--color-text-secondary)' }}>
                Useful when checking longer labels and keyboard navigation.
              </p>
            </TabsContent>
          </Tabs>
        </section>
      ))}
    </div>
  ),
};
