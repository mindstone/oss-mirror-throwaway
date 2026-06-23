import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@renderer/components/ui';
import {
  STORYBOOK_STATUS_LANGUAGE,
  type StorybookStatusKey,
  type StorybookStatusPresentation,
} from './storybookStatusLanguage';

/**
 * FOX-3131 Stage 1 — this page is the browser's landing surface.
 *
 * It is intentionally not backed by the `storybookManifest` registry.
 * The manifest tracks actual Rebel UI families; this page is editorial
 * framing that explains how to read the browser. The corresponding
 * allowlist entry lives in `scripts/storybookManifestContract.ts`
 * under `ALLOWED_NON_MANIFEST_STORY_TITLES`.
 *
 * Status language is shared with `SourceOfTruth.stories.tsx` through
 * `storybookStatusLanguage.ts` so the browser-facing labels stay in
 * sync without expanding the manifest schema.
 */
const meta = {
  title: 'Design System/Start Here',
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'Landing page for the Rebel design-system browser. Explains what this browser is, how to read the status labels, how the browser maps to atom/molecule/organism review levels, and where to go next.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

interface StatusGuideEntry {
  machineValue: StorybookStatusKey;
  label: StorybookStatusPresentation['label'];
  blurb: StorybookStatusPresentation['blurb'];
  pillBackground: StorybookStatusPresentation['pillBackground'];
  pillColor: StorybookStatusPresentation['pillColor'];
}

const STATUS_GUIDE: StatusGuideEntry[] = [
  {
    machineValue: 'shared',
    ...STORYBOOK_STATUS_LANGUAGE.shared,
  },
  {
    machineValue: 'app-pattern',
    ...STORYBOOK_STATUS_LANGUAGE['app-pattern'],
  },
  {
    machineValue: 'missing',
    ...STORYBOOK_STATUS_LANGUAGE.missing,
  },
];

const NEXT_STEPS: ReadonlyArray<{ title: string; helper: string; storyTitle: string }> = [
  {
    title: 'Start with the Registry',
    helper: 'The map of every family currently registered in this browser, with a status label on each card.',
    storyTitle: 'Design System/Registry',
  },
  {
    title: 'Browse atoms first',
    helper:
      'Pages under Atoms show the smallest reusable building blocks, including buttons, inputs, toggles, tabs, and the select family.',
    storyTitle: 'Design System/Atoms/...',
  },
  {
    title: 'See molecules and mixed realities',
    helper:
      'Pages under Molecules show reusable compositions and product-pattern review surfaces, such as Navigation Controls. Mixed pages are reserved for cross-cutting realities that still do not fit neatly into one level.',
    storyTitle: 'Design System/Molecules/... · Design System/Mixed/...',
  },
  {
    title: 'Check unresolved realities',
    helper:
      'Where a family is only partly standardized, the page should still show the truthful current reality rather than pretending the system is cleaner than it is.',
    storyTitle: 'Design System/Atoms/Toggles',
  },
];

export const StartHere: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 28, padding: '32px 24px', maxWidth: 960 }}>
      <section style={{ display: 'grid', gap: 10 }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            alignSelf: 'start',
            padding: '4px 10px',
            borderRadius: 999,
            background: 'rgba(148,163,184,0.14)',
            color: 'var(--color-text-secondary)',
            fontSize: 12,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          Rebel UI browser
        </div>
        <h1 style={{ margin: 0, fontSize: 32, lineHeight: 1.2 }}>Start here</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', maxWidth: 720, lineHeight: 1.55 }}>
          This browser is designed to stay close to the UI Rebel has today. It is not a proposed
          redesign and not a generic component lab. When something is not yet shared or not yet
          covered here, the browser should say so rather than pretend the system is tidier than it is.
        </p>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2
          style={{
            margin: 0,
            fontSize: 12,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--color-text-secondary)',
          }}
        >
          What this browser is for
        </h2>
        <Card variant="outlined">
          <CardContent style={{ display: 'grid', gap: 10, padding: 20 }}>
            <p style={{ margin: 0, lineHeight: 1.55 }}>
              It is meant to answer four questions quickly, without reading source code:
            </p>
            <ul
              style={{
                margin: 0,
                paddingLeft: 20,
                display: 'grid',
                gap: 6,
                color: 'var(--color-text-secondary)',
                lineHeight: 1.55,
              }}
            >
              <li>What am I looking at?</li>
              <li>Is this a shared component, a repeated app pattern, or something still missing?</li>
              <li>Where does it come from in the product today?</li>
              <li>What should happen next — reuse it, review it, or promote it?</li>
            </ul>
          </CardContent>
        </Card>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2
          style={{
            margin: 0,
            fontSize: 12,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--color-text-secondary)',
          }}
        >
          Atomic review levels
        </h2>
        <Card variant="outlined">
          <CardContent style={{ display: 'grid', gap: 10, padding: 20, lineHeight: 1.55 }}>
            <p style={{ margin: 0 }}>
              The browser now uses atomic design language as a review tool:
            </p>
            <ul
              style={{
                margin: 0,
                paddingLeft: 20,
                display: 'grid',
                gap: 6,
                color: 'var(--color-text-secondary)',
                lineHeight: 1.55,
              }}
            >
              <li><strong>Atom</strong> - one reusable building block with one generic job.</li>
              <li><strong>Molecule</strong> - a small reusable composition of atoms.</li>
              <li><strong>Organism</strong> - a larger section-level structure made from molecules and atoms.</li>
              <li><strong>Mixed</strong> - a truthful review page that combines levels because the family is not yet cleanly separated in production.</li>
            </ul>
          </CardContent>
        </Card>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2
          style={{
            margin: 0,
            fontSize: 12,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--color-text-secondary)',
          }}
        >
          How to read the three status labels
        </h2>
        <p
          style={{
            margin: 0,
            color: 'var(--color-text-secondary)',
            maxWidth: 720,
            lineHeight: 1.55,
          }}
        >
          Every family in the browser carries one of three status labels. The Registry uses this
          wording directly, and family pages either use the same labels or explain the same status in
          page-specific copy.
        </p>
        <div
          style={{
            display: 'grid',
            gap: 12,
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          }}
        >
          {STATUS_GUIDE.map((entry) => (
            <Card key={entry.machineValue} variant="outlined">
              <CardHeader style={{ gap: 8 }}>
                <div
                  style={{
                    display: 'inline-flex',
                    alignSelf: 'start',
                    padding: '4px 10px',
                    borderRadius: 999,
                    background: entry.pillBackground,
                    color: entry.pillColor,
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {entry.label}
                </div>
                <CardTitle style={{ fontSize: 15 }}>{entry.label}</CardTitle>
                <CardDescription style={{ lineHeight: 1.55 }}>{entry.blurb}</CardDescription>
              </CardHeader>
              <CardContent style={{ paddingTop: 0 }}>
                <div
                  style={{
                    color: 'var(--color-text-secondary)',
                    fontSize: 12,
                    fontFamily: 'monospace',
                  }}
                >
                  internal value: {entry.machineValue}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2
          style={{
            margin: 0,
            fontSize: 12,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--color-text-secondary)',
          }}
        >
          Where to go next
        </h2>
        <div style={{ display: 'grid', gap: 12 }}>
          {NEXT_STEPS.map((step) => (
            <div
              key={step.title}
              style={{
                display: 'grid',
                gap: 4,
                padding: '14px 16px',
                borderRadius: 14,
                border: '1px solid var(--color-border-soft, rgba(148,163,184,0.18))',
                background: 'rgba(148,163,184,0.05)',
              }}
            >
              <div style={{ fontWeight: 600 }}>{step.title}</div>
              <div style={{ color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>{step.helper}</div>
              <div
                style={{
                  color: 'var(--color-text-secondary)',
                  fontSize: 12,
                  fontFamily: 'monospace',
                }}
              >
                {step.storyTitle}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2
          style={{
            margin: 0,
            fontSize: 12,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--color-text-secondary)',
          }}
        >
          What this browser is not
        </h2>
        <Card variant="outlined">
          <CardContent style={{ padding: 20, display: 'grid', gap: 8, lineHeight: 1.55 }}>
            <p style={{ margin: 0 }}>
              It is not a finished design system, a future spec, or an aspirational component library.
              It does not propose new components, new families, or new naming. If something is not in
              Rebel today, it is either absent or explicitly labelled <em>Not yet shared</em>.
            </p>
            <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
              Use the theme switcher in the Storybook toolbar to review dark and light mode. Some
              pages import exact app components directly, while others use the curated registry and
              generated inventory to explain what exists today.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  ),
};
