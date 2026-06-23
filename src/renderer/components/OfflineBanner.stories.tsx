import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { OfflineBanner } from './OfflineBanner';
import type { DebouncedOnlineStatus } from '../hooks/useDebouncedOnlineStatus';

/**
 * OfflineBanner is a full-width top banner shown only on a LONG-sustained
 * offline outage (~45s), driven by the shared debounced status passed in from
 * App.tsx. At rest and on short outages it renders nothing (the header
 * OfflineIndicator covers those).
 *
 * These stories drive the REAL component with crafted status props (no
 * hand-copied markup). The banner is `position: fixed`, so each panel applies a
 * `transform` to become its containing block — that keeps the fixed banner
 * inside the story panel for review.
 */

const LONG_SUSTAINED_OFFLINE: DebouncedOnlineStatus = {
  isOnline: false,
  isSustainedOffline: true,
  isLongSustainedOffline: true,
};

const ONLINE: DebouncedOnlineStatus = {
  isOnline: true,
  isSustainedOffline: false,
  isLongSustainedOffline: false,
};

const meta = {
  title: 'Components/OfflineBanner',
  component: OfflineBanner,
  // `status` is a required prop; a meta-level default satisfies the CSF3
  // required-args type. Each story's `render` passes the status it shows.
  args: { status: ONLINE },
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
  },
} satisfies Meta<typeof OfflineBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

const themePanel = (mode: 'light' | 'dark'): React.CSSProperties => ({
  position: 'relative',
  // A transform makes this the containing block for the banner's position:fixed,
  // so the full-width banner stays inside the panel for review.
  transform: 'translateZ(0)',
  minHeight: 72,
  padding: 20,
  background: mode === 'dark' ? '#0f172a' : '#f8fafc',
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
  // `.dark`/`.light` class drives the banner's theme tokens; banner uses
  // :global(.dark) for its dark-mode amber.
  <div className={mode} style={themePanel(mode)}>
    {children}
    <h3 style={{ margin: '40px 0 0', fontSize: 12, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.5 }}>
      {mode} — {label}
    </h3>
  </div>
);

/** Long-sustained offline: the banner is visible, light + dark. */
export const LongSustainedOffline: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16 }}>
      {(['light', 'dark'] as const).map((mode) => (
        <ThemeSurface key={mode} mode={mode} label="banner shown (~45s offline)">
          <OfflineBanner status={LONG_SUSTAINED_OFFLINE} />
        </ThemeSurface>
      ))}
    </div>
  ),
};

/** At rest / short outage: nothing renders (header dot covers it). */
export const RestingAndShortOutage: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16 }}>
      {(['light', 'dark'] as const).map((mode) => (
        <ThemeSurface key={mode} mode={mode} label="no banner (online or short blip)">
          <OfflineBanner status={ONLINE} />
          <p style={{ margin: 0, fontSize: 13, opacity: 0.7 }}>
            (OfflineBanner returns null — nothing renders above.)
          </p>
        </ThemeSurface>
      ))}
    </div>
  ),
};
