// @vitest-environment happy-dom
 

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DailySpark } from '@core/dailySparkTypes';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@renderer/components/ui', async () => {
  const actual = await vi.importActual<typeof import('@renderer/components/ui')>('@renderer/components/ui');
  return {
    ...actual,
    IconButton: React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
      ({ children, ...props }, ref) => (
        <button ref={ref} {...props}>{children}</button>
      ),
    ),
  };
});

vi.mock('@floating-ui/react', async () => {
  const actual = await vi.importActual<typeof import('@floating-ui/react')>('@floating-ui/react');
  return actual;
});

import { DailySparkCard } from '../DailySparkCard';

function makeSpark(overrides: Partial<DailySpark> & Pick<DailySpark, 'format' | 'layout' | 'body'>): DailySpark {
  return {
    id: 'test-spark',
    weekStartIso: '2026-05-11',
    dayIso: '2026-05-12',
    ...overrides,
  };
}

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function mountCard(props: React.ComponentProps<typeof DailySparkCard>): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<DailySparkCard {...props} />);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('DailySparkCard', () => {
  let mounted: Mounted | null = null;
  const onDismissToday = vi.fn();
  const onLessLikeThis = vi.fn();
  const onOpenSettings = vi.fn();

  beforeEach(() => {
    onDismissToday.mockReset();
    onLessLikeThis.mockReset();
    onOpenSettings.mockReset();
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
  });

  it('renders a single-layout body as one paragraph', () => {
    const spark = makeSpark({
      id: 'single',
      format: 'dry_one_liner',
      layout: 'single',
      body: 'Six meetings, one whiteboard, no survivors.',
    });
    mounted = mountCard({
      spark,
      isFirstAppearance: false,
      onDismissToday,
      onLessLikeThis,
      onOpenSettings,
    });
    const body = mounted.container.querySelector('[data-testid="daily-spark-body"]');
    expect(body?.textContent).toContain('Six meetings, one whiteboard, no survivors.');
    expect(body?.querySelectorAll('br').length ?? 0).toBe(0);
  });

  it('preserves \\n as <br /> for poem layouts', () => {
    const spark = makeSpark({
      id: 'poem',
      format: 'haiku',
      layout: 'poem',
      body: 'three soft lines\nstacked\nfor today',
    });
    mounted = mountCard({
      spark,
      isFirstAppearance: false,
      onDismissToday,
      onLessLikeThis,
      onOpenSettings,
    });
    const body = mounted.container.querySelector('[data-testid="daily-spark-body"]');
    expect(body).not.toBeNull();
    // two <br /> for three lines
    expect(body?.querySelectorAll('br').length).toBe(2);
    expect(body?.textContent).toContain('three soft lines');
    expect(body?.textContent).toContain('stacked');
    expect(body?.textContent).toContain('for today');
  });

  it('preserves line breaks for telegram-style structured layout', () => {
    const spark = makeSpark({
      id: 'telegram',
      format: 'telegram_style',
      layout: 'structured',
      body: 'Weekly status. Stop.\nRoadmap drafted. Stop.\nReviewers awaited. Stop.',
    });
    mounted = mountCard({
      spark,
      isFirstAppearance: false,
      onDismissToday,
      onLessLikeThis,
      onOpenSettings,
    });
    const body = mounted.container.querySelector('[data-testid="daily-spark-body"]');
    expect(body?.querySelectorAll('br').length).toBe(2);
  });

  it('renders the default caption "Daily Spark"', () => {
    const spark = makeSpark({
      id: 'caption-default',
      format: 'haiku',
      layout: 'poem',
      body: 'a\nb\nc',
    });
    mounted = mountCard({
      spark,
      isFirstAppearance: false,
      onDismissToday,
      onLessLikeThis,
      onOpenSettings,
    });
    expect(mounted.container.textContent).toContain('Daily Spark');
  });

  it('renders captionOverride when first appearance', () => {
    const spark = makeSpark({
      id: 'caption-override',
      format: 'dry_one_liner',
      layout: 'single',
      body: 'Day three. Meet Daily Spark.',
      captionOverride: 'New: Daily Spark',
    });
    mounted = mountCard({
      spark,
      isFirstAppearance: true,
      onDismissToday,
      onLessLikeThis,
      onOpenSettings,
    });
    const captionEl = mounted.container.querySelector(`#daily-spark-caption-${spark.id}`);
    expect(captionEl?.textContent).toBe('New: Daily Spark');
  });

  it('ignores captionOverride when not the first appearance', () => {
    const spark = makeSpark({
      id: 'caption-only-on-first',
      format: 'dry_one_liner',
      layout: 'single',
      body: 'Body',
      captionOverride: 'Something else',
    });
    mounted = mountCard({
      spark,
      isFirstAppearance: false,
      onDismissToday,
      onLessLikeThis,
      onOpenSettings,
    });
    const captionEl = mounted.container.querySelector(`#daily-spark-caption-${spark.id}`);
    expect(captionEl?.textContent).toBe('Daily Spark');
  });

  it('renders an sr-only weekday prefix derived from dayIso', () => {
    const spark = makeSpark({
      id: 'a11y-weekday',
      dayIso: '2026-05-12', // Tuesday
      format: 'haiku',
      layout: 'poem',
      body: 'a\nb\nc',
    });
    mounted = mountCard({
      spark,
      isFirstAppearance: false,
      onDismissToday,
      onLessLikeThis,
      onOpenSettings,
    });
    const srOnly = mounted.container.querySelector('span[class*="srOnly"]');
    expect(srOnly?.textContent ?? '').toMatch(/Daily Spark, Tuesday\./);
  });

  it('marks the decorative accent rail aria-hidden', () => {
    const spark = makeSpark({
      id: 'a11y-rail',
      format: 'haiku',
      layout: 'poem',
      body: 'a\nb\nc',
    });
    mounted = mountCard({
      spark,
      isFirstAppearance: false,
      onDismissToday,
      onLessLikeThis,
      onOpenSettings,
    });
    const rail = mounted.container.querySelector('span[aria-hidden="true"]');
    expect(rail).not.toBeNull();
  });

  it('opens menu on options click and wires Hide today → onDismissToday', () => {
    const spark = makeSpark({
      id: 'menu-hide-today',
      format: 'haiku',
      layout: 'poem',
      body: 'a\nb\nc',
    });
    mounted = mountCard({
      spark,
      isFirstAppearance: false,
      onDismissToday,
      onLessLikeThis,
      onOpenSettings,
    });

    const trigger = mounted.container.querySelector<HTMLButtonElement>('[data-testid="daily-spark-options"]');
    expect(trigger).not.toBeNull();
    act(() => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const hideButton = document.querySelector<HTMLButtonElement>('[data-testid="daily-spark-menu-hide-today"]');
    expect(hideButton).not.toBeNull();
    act(() => {
      hideButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onDismissToday).toHaveBeenCalledTimes(1);
  });

  it('wires Less like this → onLessLikeThis', () => {
    const spark = makeSpark({
      id: 'menu-less-like-this',
      format: 'limerick',
      layout: 'poem',
      body: 'a\nb',
    });
    mounted = mountCard({
      spark,
      isFirstAppearance: false,
      onDismissToday,
      onLessLikeThis,
      onOpenSettings,
    });
    const trigger = mounted.container.querySelector<HTMLButtonElement>('[data-testid="daily-spark-options"]');
    act(() => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const item = document.querySelector<HTMLButtonElement>('[data-testid="daily-spark-menu-less-like-this"]');
    act(() => {
      item?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onLessLikeThis).toHaveBeenCalledTimes(1);
  });

  it('wires Daily Spark settings → onOpenSettings', () => {
    const spark = makeSpark({
      id: 'menu-settings',
      format: 'sommelier_note',
      layout: 'single',
      body: 'A week with quiet tannins.',
    });
    mounted = mountCard({
      spark,
      isFirstAppearance: false,
      onDismissToday,
      onLessLikeThis,
      onOpenSettings,
    });
    const trigger = mounted.container.querySelector<HTMLButtonElement>('[data-testid="daily-spark-options"]');
    act(() => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const item = document.querySelector<HTMLButtonElement>('[data-testid="daily-spark-menu-settings"]');
    act(() => {
      item?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('does NOT use aria-live on the card', () => {
    const spark = makeSpark({
      id: 'a11y-no-live',
      format: 'haiku',
      layout: 'poem',
      body: 'a\nb\nc',
    });
    mounted = mountCard({
      spark,
      isFirstAppearance: false,
      onDismissToday,
      onLessLikeThis,
      onOpenSettings,
    });
    const card = mounted.container.querySelector('[data-testid="daily-spark-card"]');
    expect(card?.getAttribute('aria-live')).toBeNull();
  });
});
