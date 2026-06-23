// ImageError lives in MessageMarkdown.tsx (transcript-local, per chief-designer + design-system-reviewer guidance).
// Stories are co-located in ui/ to satisfy the centralized Storybook discovery glob (see scripts/storybookManifestContract.ts).
import type { Meta, StoryObj } from '@storybook/react';
import { ImageError } from '../MessageMarkdown';

const meta = {
  title: 'Components/MessageMarkdown/ImageError',
  component: ImageError,
  parameters: {
    layout: 'padded',
  },
  args: {
    code: 'unknown',
  },
} satisfies Meta<typeof ImageError>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WorkspaceEscape: Story = {
  args: {
    code: 'workspace-escape',
  },
};

export const IpcTimeout: Story = {
  args: {
    code: 'ipc-timeout',
  },
};

export const DecodeTimeout: Story = {
  args: {
    code: 'decode-timeout',
  },
};

export const Unknown: Story = {
  args: {
    code: 'unknown',
  },
};
