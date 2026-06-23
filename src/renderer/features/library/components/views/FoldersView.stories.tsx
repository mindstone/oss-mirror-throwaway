import type { Meta, StoryObj } from '@storybook/react';
import type { ReactNode } from 'react';
import { FoldersView } from './FoldersView';
import { SAMPLE_SPACES, SAMPLE_TREE, makeTreeViewProps } from './viewFixtures';

const meta = {
  title: 'Library/Views/Folders View',
  component: FoldersView,
  parameters: {
    layout: 'padded',
    controls: { disable: true },
  },
} satisfies Meta<typeof FoldersView>;

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

const baseProps = {
  treeViewProps: makeTreeViewProps(),
  spacesData: SAMPLE_SPACES,
  favoriteFilePaths: [
    '/workspace/Chief-of-Staff/memory/weekly-summary.md',
  ],
} as const;

export const Default: Story = {
  render: () => (
    <ThemePair>
      <FoldersView
        filter="everything"
        searchQuery=""
        tree={SAMPLE_TREE}
        {...baseProps}
      />
    </ThemePair>
  ),
};

export const Sparse: Story = {
  render: () => (
    <ThemePair>
      <FoldersView
        filter="spaces"
        searchQuery="roadmap"
        tree={SAMPLE_TREE}
        {...baseProps}
      />
    </ThemePair>
  ),
};

export const EmptyLibrary: Story = {
  render: () => (
    <ThemePair>
      <FoldersView
        filter="everything"
        searchQuery=""
        tree={[]}
        {...baseProps}
      />
    </ThemePair>
  ),
};

export const SearchNoResults: Story = {
  render: () => (
    <ThemePair>
      <FoldersView
        filter="skills"
        searchQuery="nothing-here"
        tree={SAMPLE_TREE}
        {...baseProps}
      />
    </ThemePair>
  ),
};

export const ErrorAndLoading: Story = {
  render: () => (
    <ThemePair>
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <FoldersView
          filter="everything"
          searchQuery=""
          tree={[]}
          loading
          {...baseProps}
        />
        <FoldersView
          filter="everything"
          searchQuery=""
          tree={[]}
          error="Could not read workspace tree."
          {...baseProps}
        />
      </div>
    </ThemePair>
  ),
};
