import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, type ReactNode } from 'react';
import { SpaceCard } from './SpaceCard';
import type { EnrichedSpaceInfo } from './spaceTypes';

/**
 * SpaceCard stories focused on the Stage-8 per-space cloud sync-status signal
 * (260619_cloud-symlink-indexing): the "Reconnecting" / "Not found" badge + banner
 * across the three locked Chief-Designer states, in both light and dark themes.
 */
const meta = {
  title: 'Settings/Space Card',
  component: SpaceCard,
  parameters: {
    layout: 'padded',
    controls: { disable: true },
  },
} satisfies Meta<typeof SpaceCard>;

export default meta;
type Story = StoryObj<typeof meta>;

function makeCloudSpace(overrides: Partial<EnrichedSpaceInfo> = {}): EnrichedSpaceInfo {
  return {
    name: 'Company Memories',
    path: 'work/Mindstone/Company Memories',
    absolutePath: '/workspace/work/Mindstone/Company Memories',
    type: 'company',
    isSymlink: true,
    hasReadme: true,
    description: 'Shared company knowledge synced from Google Drive.',
    sharing: 'restricted',
    organisationName: 'Mindstone',
    storageProvider: 'google_drive',
    sourcePath: '~/Library/CloudStorage/GoogleDrive/Shared drives/Company Memories',
    status: 'ok',
    ...overrides,
  };
}

const noop = () => undefined;

const baseProps = {
  onEdit: noop,
  onOpenInWorkspace: noop,
  onRevealInFolder: noop,
  onEditReadme: noop,
  onRemove: noop,
  onMigrateLegacyAgentsMd: noop,
  onReCheckSync: noop,
};

function BodyTheme({ theme, children }: { theme: 'light' | 'dark'; children: ReactNode }) {
  useEffect(() => {
    document.body.classList.add(theme);
    return () => {
      document.body.classList.remove(theme);
    };
  }, [theme]);
  return <>{children}</>;
}

function ThemePair({ space, hasPriorIndex = true }: { space: EnrichedSpaceInfo; hasPriorIndex?: boolean }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', width: 640, maxWidth: '100%' }}>
      <BodyTheme theme="light">
        <div className="light">
          <SpaceCard space={space} hasPriorIndex={hasPriorIndex} {...baseProps} />
        </div>
      </BodyTheme>
      <BodyTheme theme="dark">
        <div className="dark">
          <SpaceCard space={space} hasPriorIndex={hasPriorIndex} {...baseProps} />
        </div>
      </BodyTheme>
    </div>
  );
}

/** Inert default — healthy cloud space shows no sync signal. */
export const Healthy: Story = {
  render: () => <ThemePair space={makeCloudSpace({ syncStatus: 'healthy' })} />,
};

/** State A — reconnecting with a prior index ("showing your last-known files"). */
export const ReconnectingWithIndex: Story = {
  render: () => <ThemePair space={makeCloudSpace({ syncStatus: 'reconnecting' })} hasPriorIndex />,
};

/** State B — reconnecting with no prior index (honest "empty for now"). */
export const ReconnectingNoIndex: Story = {
  render: () => <ThemePair space={makeCloudSpace({ syncStatus: 'reconnecting' })} hasPriorIndex={false} />,
};

/** State C — structurally gone (warning tone, Reconnect / Remove, no recovery promise). */
export const NotFound: Story = {
  render: () => <ThemePair space={makeCloudSpace({ syncStatus: 'not_found' })} />,
};
