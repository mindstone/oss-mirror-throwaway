import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';
import { MultiRebelWorkspaceNotice, type MultiRebelWorkspaceNoticeProps } from './MultiRebelWorkspaceNotice';

const meta = {
  title: 'Settings/Messaging/MultiRebelWorkspaceNotice',
  component: MultiRebelWorkspaceNotice,
  parameters: {
    layout: 'centered',
    controls: { disable: true },
  },
} satisfies Meta<typeof MultiRebelWorkspaceNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

function ThemePair(args: MultiRebelWorkspaceNoticeProps) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', width: 720, maxWidth: '100%' }}>
      <div className="light">
        <MultiRebelWorkspaceNotice {...args} />
      </div>
      <div className="dark">
        <MultiRebelWorkspaceNotice {...args} />
      </div>
    </div>
  );
}

function story(args: MultiRebelWorkspaceNoticeProps): Story {
  return {
    render: () => <ThemePair {...args} />,
  };
}

export const Hidden = story({
  peerInstanceCount: 1,
});

export const Shown = story({
  peerInstanceCount: 2,
});
