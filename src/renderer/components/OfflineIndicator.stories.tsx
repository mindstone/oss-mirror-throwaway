import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { OfflineIndicator } from './OfflineIndicator';
import { CloudSyncIndicator } from './CloudSyncIndicator';
import type { DebouncedOnlineStatus } from '../hooks/useDebouncedOnlineStatus';

/**
 * OfflineIndicator renders nothing at rest (online) and a calm WifiOff +
 * pulse-dot when offline is sustained. Status is owned by App.tsx and passed in,
 * so these stories drive the REAL component with crafted status props (no
 * hand-copied markup). The debounce/asymmetry logic is covered by
 * useDebouncedOnlineStatus.test.tsx.
 *
 * Shown in a header-cluster context next to CloudSyncIndicator so the reviewer
 * can judge it in-context, not pristine-standalone (per the UI review rule).
 */

const ONLINE: DebouncedOnlineStatus = {
  isOnline: true,
  isSustainedOffline: false,
  isLongSustainedOffline: false,
};

const SUSTAINED_OFFLINE: DebouncedOnlineStatus = {
  isOnline: false,
  isSustainedOffline: true,
  isLongSustainedOffline: false,
};

const meta = {
  title: 'Components/OfflineIndicator',
  component: OfflineIndicator,
  // `status` is a required prop (single shared signal owned by App.tsx); a
  // meta-level default satisfies the CSF3 required-args type. Each story's
  // `render` passes the status it actually wants to show.
  args: { status: ONLINE },
  parameters: {
    layout: 'centered',
    controls: { disable: true },
  },
} satisfies Meta<typeof OfflineIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

const headerCluster: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: 12,
  borderRadius: 12,
};

const themePanel = (mode: 'light' | 'dark'): React.CSSProperties => ({
  display: 'grid',
  gap: 12,
  padding: 20,
  borderRadius: 16,
  background: mode === 'dark' ? '#0f172a' : '#ffffff',
  color: mode === 'dark' ? '#f8fafc' : '#0f172a',
});

const ThemeSurface = ({
  mode,
  label,
  children,
}: {
  mode: 'light' | 'dark';
  label: string;
  children: React.ReactNode;
}) => (
  <div className={mode} style={themePanel(mode)}>
    <h3 style={{ margin: 0, fontSize: 12, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.5 }}>
      {mode} — {label}
    </h3>
    <div style={headerCluster}>{children}</div>
  </div>
);

/** Online (resting): the indicator renders nothing — zero nag. */
export const OnlineResting: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
      {(['light', 'dark'] as const).map((mode) => (
        <ThemeSurface key={mode} mode={mode} label="online (no dot)">
          <CloudSyncIndicator />
          <OfflineIndicator status={ONLINE} />
        </ThemeSurface>
      ))}
    </div>
  ),
};

/** Offline (sustained): calm WifiOff + amber pulse-dot, hover for the tooltip. */
export const SustainedOffline: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
      {(['light', 'dark'] as const).map((mode) => (
        <ThemeSurface key={mode} mode={mode} label="sustained offline (dot + tooltip on hover)">
          <OfflineIndicator status={SUSTAINED_OFFLINE} />
        </ThemeSurface>
      ))}
    </div>
  ),
};

/** In a header cluster next to the cloud indicator — judge it in-context. */
export const InHeaderCluster: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
      {(['light', 'dark'] as const).map((mode) => (
        <ThemeSurface key={mode} mode={mode} label="offline dot beside cloud indicator">
          <OfflineIndicator status={SUSTAINED_OFFLINE} />
          <CloudSyncIndicator />
        </ThemeSurface>
      ))}
    </div>
  ),
};
