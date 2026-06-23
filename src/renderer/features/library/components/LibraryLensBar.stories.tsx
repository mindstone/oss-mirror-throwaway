import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Info, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@renderer/components/ui';
import { LibraryLensBar, type LibraryLensOverflowAction } from './LibraryLensBar';
import type { LibraryLens, LibrarySortOption } from '../types/lens';
import type { FacetOption } from '../hooks/useFilterFacets';
import { FILTER_SPECS, VIEW_SPECS } from '../types/lens';

const meta = {
  title: 'Library/Library Lens Bar',
  component: LibraryLensBar,
  parameters: {
    layout: 'padded',
    controls: { disable: true },
  },
} satisfies Meta<typeof LibraryLensBar>;

export default meta;
type Story = StoryObj<typeof meta>;

type HarnessProps = {
  initialLens: LibraryLens;
  facets?: readonly FacetOption[];
  initialSearch?: string;
  initialSort?: LibrarySortOption;
  orientationTipDismissed?: boolean;
  revealedFoldersCount?: number;
  disabled?: boolean;
  showActions?: boolean;
};

function LensBarHarness({
  initialLens,
  facets = [],
  initialSearch = '',
  initialSort = 'name',
  orientationTipDismissed = false,
  revealedFoldersCount,
  disabled = false,
  showActions = false,
}: HarnessProps) {
  const [lens, setLens] = useState<LibraryLens>(initialLens);
  const [searchQuery, setSearchQuery] = useState(initialSearch);
  const [sortBy, setSortBy] = useState<LibrarySortOption>(initialSort);
  const [tipDismissed, setTipDismissed] = useState(orientationTipDismissed);

  const overflowActions: readonly LibraryLensOverflowAction[] = showActions
    ? [
      {
        id: 'info',
        label: 'Show Library info',
        icon: Info,
        onClick: () => undefined,
        indicator: 'indexing',
      },
      {
        id: 'refresh',
        label: 'Refresh files',
        icon: RefreshCw,
        onClick: () => undefined,
      },
    ]
    : [];

  return (
    <LibraryLensBar
      lens={lens}
      facets={facets}
      searchQuery={searchQuery}
      sortBy={sortBy}
      primaryActions={showActions ? (
        <Button type="button" size="sm" variant="default">
          <Plus size={16} />
          <span>Add memory</span>
        </Button>
      ) : undefined}
      overflowActions={overflowActions}
      setBrowseLens={(next) => {
        setLens((previous) => (typeof next === 'function' ? next(previous) : next));
      }}
      onSearchQueryChange={setSearchQuery}
      onSortByChange={setSortBy}
      orientationTipDismissed={tipDismissed}
      dismissOrientationTip={() => setTipDismissed(true)}
      revealedFoldersCount={revealedFoldersCount}
      disabled={disabled}
    />
  );
}

function ThemePair({ children, width }: { children: ReactNode; width?: number }) {
  const style = {
    display: 'grid',
    gap: 'var(--space-4)',
    width: width ?? 1000,
    maxWidth: '100%',
  } as const;

  return (
    <div style={style}>
      <div className="light">{children}</div>
      <div className="dark">{children}</div>
    </div>
  );
}

export const Default: Story = {
  render: () => (
    <ThemePair>
      <LensBarHarness initialLens={{ filter: 'spaces', view: 'folders' }} />
    </ThemePair>
  ),
};

export const AllAxisCombinations: Story = {
  render: () => (
    <ThemePair>
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        {(Object.keys(FILTER_SPECS) as Array<keyof typeof FILTER_SPECS>).flatMap((filter) => (
          (Object.keys(VIEW_SPECS) as Array<keyof typeof VIEW_SPECS>).map((view) => (
            <LensBarHarness
              key={`${filter}-${view}`}
              initialLens={{ filter, view }}
              orientationTipDismissed
            />
          ))
        ))}
      </div>
    </ThemePair>
  ),
};

export const HoverFocusActiveDisabled: Story = {
  render: () => (
    <ThemePair>
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <LensBarHarness initialLens={{ filter: 'skills', view: 'cards' }} orientationTipDismissed />
        <LensBarHarness initialLens={{ filter: 'memory', view: 'cards' }} orientationTipDismissed disabled />
      </div>
    </ThemePair>
  ),
};

export const NarrowWrapAtEightHundred: Story = {
  render: () => (
    <ThemePair width={800}>
      <LensBarHarness initialLens={{ filter: 'everything', view: 'cards' }} orientationTipDismissed />
    </ThemePair>
  ),
};

export const SearchAndSortPresent: Story = {
  render: () => (
    <ThemePair>
      <LensBarHarness
        initialLens={{ filter: 'everything', view: 'cards' }}
        initialSearch="atlas migration"
        initialSort="recent"
        orientationTipDismissed
      />
    </ThemePair>
  ),
};

export const OrientationTipVisibleAndDismissed: Story = {
  render: () => (
    <ThemePair>
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <LensBarHarness initialLens={{ filter: 'spaces', view: 'folders' }} />
        <LensBarHarness initialLens={{ filter: 'spaces', view: 'folders' }} orientationTipDismissed />
      </div>
    </ThemePair>
  ),
};

export const LensSentenceWithTransient: Story = {
  render: () => (
    <ThemePair>
      <LensBarHarness
        initialLens={{ filter: 'spaces', view: 'folders' }}
        revealedFoldersCount={3}
        orientationTipDismissed
      />
    </ThemePair>
  ),
};

export const WithFacets: Story = {
  render: () => (
    <ThemePair>
      <LensBarHarness
        initialLens={{ filter: 'skills', view: 'cards' }}
        orientationTipDismissed
        facets={[
          { id: 'all', label: 'All', count: 34, ariaLabel: 'Show all', tooltip: 'All · 34 skills' },
          {
            id: 'communication',
            label: 'Communication',
            count: 12,
            ariaLabel: 'Show communication skills',
            tooltip: 'Communication · 12 skills',
          },
          {
            id: 'research',
            label: 'Research',
            count: 9,
            ariaLabel: 'Show research skills',
            tooltip: 'Research · 9 skills',
          },
          {
            id: 'thinking',
            label: 'Thinking',
            count: 7,
            ariaLabel: 'Show thinking skills',
            tooltip: 'Thinking · 7 skills',
          },
        ]}
      />
    </ThemePair>
  ),
};

export const WithFacetsActive: Story = {
  render: () => (
    <ThemePair>
      <LensBarHarness
        initialLens={{ filter: 'skills', view: 'cards', facet: 'communication' }}
        orientationTipDismissed
        facets={[
          { id: 'all', label: 'All', count: 34, ariaLabel: 'Show all', tooltip: 'All · 34 skills' },
          {
            id: 'communication',
            label: 'Communication',
            count: 12,
            ariaLabel: 'Show communication skills',
            tooltip: 'Communication · 12 skills',
          },
          {
            id: 'research',
            label: 'Research',
            count: 9,
            ariaLabel: 'Show research skills',
            tooltip: 'Research · 9 skills',
          },
          {
            id: 'thinking',
            label: 'Thinking',
            count: 7,
            ariaLabel: 'Show thinking skills',
            tooltip: 'Thinking · 7 skills',
          },
        ]}
      />
    </ThemePair>
  ),
};

export const Compact: Story = {
  render: () => (
    <ThemePair width={520}>
      <LensBarHarness
        initialLens={{ filter: 'memory', view: 'cards' }}
        orientationTipDismissed
        showActions
        initialSearch="weekly summary"
        initialSort="recent"
        facets={[
          { id: 'all', label: 'All', count: 34, ariaLabel: 'Show all', tooltip: 'All · 34 memories' },
          {
            id: 'chief-of-staff',
            label: 'Chief of Staff',
            count: 12,
            ariaLabel: 'Show Chief of Staff memories',
            tooltip: 'Chief of Staff · 12 memories',
          },
          {
            id: 'mindstone',
            label: 'Mindstone',
            count: 9,
            ariaLabel: 'Show Mindstone memories',
            tooltip: 'Mindstone · 9 memories',
          },
        ]}
      />
    </ThemePair>
  ),
};
