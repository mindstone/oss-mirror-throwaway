import type { Meta, StoryObj } from '@storybook/react';
import { FinishLineButton } from './FinishLineButton';

const meta = {
  title: 'Design System/Mixed/Composer/Finish Line Button',
  component: FinishLineButton,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Composer-strip button that opens the Finish line editor. Lives in the right-side `sessionControls`, peer to Files. Active when the user has set a finish line OR is currently editing one.',
      },
    },
  },
  tags: ['autodocs'],
} satisfies Meta<typeof FinishLineButton>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: {
    hasFinishLine: false,
    isEditing: false,
    onClick: () => undefined,
  },
};

export const Active: Story = {
  args: {
    hasFinishLine: true,
    isEditing: false,
    onClick: () => undefined,
  },
};

export const Editing: Story = {
  args: {
    hasFinishLine: false,
    isEditing: true,
    onClick: () => undefined,
  },
};

export const ActiveAndEditing: Story = {
  args: {
    hasFinishLine: true,
    isEditing: true,
    onClick: () => undefined,
  },
};

export const EmptyLight: Story = {
  args: {
    hasFinishLine: false,
    isEditing: false,
    onClick: () => undefined,
  },
  parameters: {
    backgrounds: { default: 'light' },
    themes: { themeOverride: 'light' },
  },
};

export const ActiveLight: Story = {
  args: {
    hasFinishLine: true,
    isEditing: false,
    onClick: () => undefined,
  },
  parameters: {
    backgrounds: { default: 'light' },
    themes: { themeOverride: 'light' },
  },
};
