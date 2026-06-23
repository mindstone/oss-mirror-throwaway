import { useState, type ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { DocumentTabBar } from './DocumentTabBar';

const tabs = [
  { id: 'one', path: '/workspace/notes/one.md', title: 'one.md' },
  { id: 'two', path: '/workspace/notes/two.md', title: 'two.md' },
  { id: 'three', path: '/workspace/notes/three.md', title: 'three.md' },
];

function DocumentTabBarStory(args: ComponentProps<typeof DocumentTabBar>) {
  const [activeTabId, setActiveTabId] = useState<string | null>(args.activeTabId);
  return (
    <div style={{ background: '#0f1423', padding: 12 }}>
      <DocumentTabBar
        {...args}
        activeTabId={activeTabId}
        onTabClick={setActiveTabId}
      />
    </div>
  );
}

const meta = {
  title: 'Feature/Document Editor/DocumentTabBar',
  component: DocumentTabBar,
  render: (args) => <DocumentTabBarStory {...args} />,
  args: {
    tabs,
    activeTabId: 'one',
    onTabClick: () => {},
    onTabClose: () => {},
    onTabMouseDown: () => {},
    onOpenFileDialog: () => {},
  },
} satisfies Meta<typeof DocumentTabBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
