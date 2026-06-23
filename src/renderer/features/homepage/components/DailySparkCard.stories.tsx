import { useEffect, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { DailySpark } from '@core/dailySparkTypes';
import { DailySparkCard } from './DailySparkCard';

function makeSpark(overrides: Partial<DailySpark> & Pick<DailySpark, 'format' | 'layout' | 'body'>): DailySpark {
  return {
    id: 'story-spark',
    weekStartIso: '2026-05-11',
    dayIso: '2026-05-12',
    revealedAt: undefined,
    dismissedAt: undefined,
    captionOverride: undefined,
    feedback: undefined,
    ...overrides,
  };
}

const noop = () => undefined;

function ThemeWrapper({ theme, children }: { theme: 'light' | 'dark'; children: ReactNode }) {
  useEffect(() => {
    document.body.classList.remove(theme === 'light' ? 'dark' : 'light');
    document.body.classList.add(theme);
    return () => {
      document.body.classList.remove(theme);
    };
  }, [theme]);
  return (
    <div
      className={theme}
      style={{
        background: 'var(--color-background)',
        color: 'var(--color-text-primary)',
        padding: 16,
        minWidth: 480,
      }}
    >
      {children}
    </div>
  );
}

function ThemePair({ spark, isFirstAppearance = false }: { spark: DailySpark; isFirstAppearance?: boolean }) {
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <ThemeWrapper theme="light">
        <DailySparkCard
          spark={spark}
          isFirstAppearance={isFirstAppearance}
          onDismissToday={noop}
          onLessLikeThis={noop}
          onOpenSettings={noop}
        />
      </ThemeWrapper>
      <ThemeWrapper theme="dark">
        <DailySparkCard
          spark={{ ...spark, id: `${spark.id}-dark` }}
          isFirstAppearance={isFirstAppearance}
          onDismissToday={noop}
          onLessLikeThis={noop}
          onOpenSettings={noop}
        />
      </ThemeWrapper>
    </div>
  );
}

const meta: Meta<typeof DailySparkCard> = {
  title: 'Homepage/DailySparkCard',
  component: DailySparkCard,
  parameters: { layout: 'padded', controls: { disable: true } },
};

export default meta;
type Story = StoryObj<typeof DailySparkCard>;

export const Single: Story = {
  render: () => (
    <ThemePair
      spark={makeSpark({
        id: 'single-dry',
        format: 'dry_one_liner',
        layout: 'single',
        body: 'Six meetings, one whiteboard, no survivors.',
      })}
    />
  ),
};

export const PoemLimerick: Story = {
  render: () => (
    <ThemePair
      spark={makeSpark({
        id: 'poem-limerick',
        format: 'limerick',
        layout: 'poem',
        body: [
          'A planner with deadlines galore,',
          'Found three on the calendar floor.',
          'She picked one to keep,',
          'Let the others go cheap,',
          'And quietly closed the back door.',
        ].join('\n'),
      })}
    />
  ),
};

export const PoemHaiku: Story = {
  render: () => (
    <ThemePair
      spark={makeSpark({
        id: 'poem-haiku',
        format: 'haiku',
        layout: 'poem',
        body: ['Three sprint reviews stack', 'Notes drift like origami', 'Coffee gives up too'].join('\n'),
      })}
    />
  ),
};

export const StructuredMockWeatherReport: Story = {
  render: () => (
    <ThemePair
      spark={makeSpark({
        id: 'structured-weather',
        format: 'mock_weather_report',
        layout: 'structured',
        body: [
          'Forecast: scattered standups, 80% chance of follow-ups.',
          'High of three priorities, dropping to two by Friday.',
          'Cold front of decisions moving in from finance.',
        ].join('\n'),
      })}
    />
  ),
};

export const StructuredTelegramStyle: Story = {
  render: () => (
    <ThemePair
      spark={makeSpark({
        id: 'structured-telegram',
        format: 'telegram_style',
        layout: 'structured',
        body: [
          'Weekly status. Stop.',
          'Roadmap drafted. Stop.',
          'Reviewers awaited. Stop.',
        ].join('\n'),
      })}
    />
  ),
};

export const FirstAppearance: Story = {
  render: () => (
    <ThemePair
      isFirstAppearance
      spark={makeSpark({
        id: 'first-appearance',
        format: 'dry_one_liner',
        layout: 'single',
        body: 'Day three. Meet Daily Spark — a short personal note shaped by your week. One per day. Quiet by design.',
        captionOverride: 'New: Daily Spark',
      })}
    />
  ),
};

export const GentleSommelierNote: Story = {
  render: () => (
    <ThemePair
      spark={makeSpark({
        id: 'gentle-sommelier',
        format: 'sommelier_note',
        layout: 'single',
        body: [
          'A week with quiet tannins and a long finish.',
          'Best decanted; not for pairing with new commitments.',
        ].join('\n'),
      })}
    />
  ),
};
