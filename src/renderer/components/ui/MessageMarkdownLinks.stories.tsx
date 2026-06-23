// MessageMarkdown lives outside the shared UI primitives, but these stories are
// co-located here so Storybook can review its transcript link patterns.
import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, type ReactNode } from 'react';
import { MessageMarkdown } from '../MessageMarkdown';

const comparisonMarkdown = `The shareable spec/criteria page is here:
[Hiring criteria - Production Engineer](https://example.com/hiring-criteria)

Rebel memory also points to that as the active reference from the hiring frontdoor:
[Overview.md](rebel://space/General/Overview.md)

Useful backup if you're sharing internal context:
- Team interview plan: [Team-Interview-Prep.md](rebel://space/General/Team-Interview-Prep.md)
- Private note: [diary.md](library://Chief-of-Staff/diary.md)
- Long internal reference: [260609-senior-product-engineer-scorecard-with-a-very-long-name.md](rebel://space/General/260609-senior-product-engineer-scorecard-with-a-very-long-name.md)`;

function StoryFrame({ narrow = false }: { narrow?: boolean }) {
  return (
    <div
      style={{
        maxWidth: narrow ? 420 : 760,
        padding: 'var(--space-6)',
        background: 'var(--color-bg-page)',
        color: 'var(--color-text-primary)',
      }}
    >
      <div
        style={{
          display: 'grid',
          gap: 'var(--space-3)',
          padding: 'var(--space-4)',
          border: '1px solid var(--color-border-soft)',
          borderRadius: 'var(--radius-lg)',
          background: 'var(--color-surface-1)',
        }}
      >
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)' }}>
          External links and internal file references should read as one link family. Scope labels are metadata.
        </p>
        <MessageMarkdown content={comparisonMarkdown} onOpenFile={() => Promise.resolve()} />
      </div>
    </div>
  );
}

function BodyTheme({ children, theme }: { children: ReactNode; theme: 'dark' | 'light' }) {
  useEffect(() => {
    document.body.classList.remove(theme === 'dark' ? 'light' : 'dark');
    document.body.classList.add(theme);

    return () => {
      document.body.classList.remove(theme);
    };
  }, [theme]);

  return (
    <div className={theme} style={{ minHeight: '100vh', background: 'var(--color-bg-page)' }}>
      {children}
    </div>
  );
}

const meta = {
  title: 'Components/MessageMarkdown/Links',
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'In-context review surface for MessageMarkdown external links, internal file references, inline scope metadata, truncation, and dense list usage.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const LinkComparisonDark: Story = {
  decorators: [
    (StoryComponent) => (
      <BodyTheme theme="dark">
        <StoryComponent />
      </BodyTheme>
    ),
  ],
  render: () => <StoryFrame />,
};

export const LinkComparisonLight: Story = {
  decorators: [
    (StoryComponent) => (
      <BodyTheme theme="light">
        <StoryComponent />
      </BodyTheme>
    ),
  ],
  render: () => <StoryFrame />,
};

export const NarrowWrappingDark: Story = {
  decorators: [
    (StoryComponent) => (
      <BodyTheme theme="dark">
        <StoryComponent />
      </BodyTheme>
    ),
  ],
  render: () => <StoryFrame narrow />,
};
