import type { Meta, StoryObj } from '@storybook/react';
import { MessageWorkDisclosure } from './MessageWorkDisclosure';
import { deriveTurnActivityRecap, type TurnActivityRecapInput } from '../utils/turnActivityRecap';

const meta = {
  title: 'Agent Session/MessageWorkDisclosure',
  component: MessageWorkDisclosure,
  // Default args satisfy the component's required props at the type level; each
  // story below overrides presentation via `render` (and renders the real recap).
  args: {
    label: '3 files · 12 tools · 1m 20s',
    children: 'Full step list renders here when expanded.',
  },
  parameters: {
    layout: 'padded',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'Collapsed, default-closed disclosure shown under a finished assistant message. Its label is the calm one-line activity recap derived from the per-turn counts (files · tools · duration, with a muted "hiccup" term only when there were errors). The chevron expands the full step list. These stories render the real recap strings via `deriveTurnActivityRecap` so the previews stay honest to the actual output.',
      },
    },
  },
} satisfies Meta<typeof MessageWorkDisclosure>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Builds an in-context disclosure from raw turn counts, using the real recap
 * derivation so the visible label and the screen-reader label match production.
 */
function RecapDisclosure({ input }: { input: TurnActivityRecapInput }) {
  const recap = deriveTurnActivityRecap(input);
  return (
    <div style={{ maxWidth: 560 }}>
      <p style={{ margin: '0 0 var(--space-2)', color: 'var(--color-text)' }}>
        Pulled your Q3 numbers from Slack and drafted the update.
      </p>
      <MessageWorkDisclosure label={recap.label} ariaLabel={recap.ariaLabel}>
        <div style={{ color: 'var(--color-text-muted)' }}>Full step list renders here when expanded.</div>
      </MessageWorkDisclosure>
    </div>
  );
}

/** Files lead the line: `3 files · 12 tools · 1m 20s`. */
export const FilesToolsDuration: Story = {
  render: () => <RecapDisclosure input={{ filesTouched: 3, toolCount: 12, durationMs: 80_000, errors: 0 }} />,
};

/** No files this turn, so tools lead: `12 tools · 1m 20s`. */
export const ToolsDuration: Story = {
  render: () => <RecapDisclosure input={{ filesTouched: 0, toolCount: 12, durationMs: 80_000, errors: 0 }} />,
};

/** A trivial-but-timed turn: `Took 18s`. */
export const DurationOnly: Story = {
  render: () => <RecapDisclosure input={{ filesTouched: 0, toolCount: 0, durationMs: 18_000, errors: 0 }} />,
};

/** Singular everywhere: `1 file · 1 tool · 5s`. */
export const Singular: Story = {
  render: () => <RecapDisclosure input={{ filesTouched: 1, toolCount: 1, durationMs: 5_000, errors: 0 }} />,
};

/** Plural everywhere: `3 files · 2 tools · 5s`. */
export const Plural: Story = {
  render: () => <RecapDisclosure input={{ filesTouched: 3, toolCount: 2, durationMs: 5_000, errors: 0 }} />,
};

/** Errors surface only as a muted, last `1 hiccup` term (never destructive/red). */
export const WithHiccup: Story = {
  render: () => <RecapDisclosure input={{ filesTouched: 3, toolCount: 12, durationMs: 80_000, errors: 1 }} />,
};

/** Multiple errors pluralise to `N hiccups`, still muted and last. */
export const WithHiccups: Story = {
  render: () => <RecapDisclosure input={{ filesTouched: 0, toolCount: 12, durationMs: 80_000, errors: 3 }} />,
};
