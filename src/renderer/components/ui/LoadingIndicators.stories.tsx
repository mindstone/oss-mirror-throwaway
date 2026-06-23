import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import {
  Button,
  Card,
  CardContent,
  IconButton,
  RebelLoadingIndicator,
  Spinner,
} from '@renderer/components/ui';
import { Mic } from 'lucide-react';
import styles from './LoadingIndicators.stories.module.css';

const meta = {
  title: 'Design System/Mixed/Loading Indicators',
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'Loading taxonomy for Rebel: utility spinners for small mechanics, mascot loading for meaningful Rebel-is-working moments, and skeletons when the content shape is known.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Taxonomy: Story = {
  render: () => (
    <div className={styles.page}>
      <section className={styles.header}>
        <h1 className={styles.title}>Loading Indicators</h1>
        <p className={styles.intro}>
          Loading is not one component with three outfits. Use the smallest indicator that preserves
          the user's conclusion: a utility spinner means "this control is waiting", the mascot means
          "Rebel is working on this for you", and a skeleton means "the page shape is coming".
        </p>
      </section>

      <section className={styles.grid} aria-label="Loading indicator taxonomy">
        <Card variant="outlined">
          <CardContent className={styles.cardContent}>
            <div>
              <h2 className={styles.cardTitle}>Utility Spinner</h2>
              <p className={styles.cardDescription}>
                Use for compact, mechanical loading: retry buttons, dropdowns, small settings rows,
                and table or list cells.
              </p>
            </div>
            <div className={styles.sampleBox}>
              <div className={styles.spinnerSamples}>
                <div className={styles.compactRow}>
                  <Spinner size="xs" />
                  <span>xs, dense icon-control scale</span>
                </div>
                <div className={styles.compactRow}>
                  <Spinner size="sm" />
                  <span>sm, inline utility wait</span>
                </div>
                <div className={styles.compactRow}>
                  <Spinner size="md" label="Loading library files..." />
                </div>
                <div className={styles.compactRow}>
                  <Button size="xs" disabled aria-busy="true">
                    <Spinner size="xs" decorative />
                    Sending
                  </Button>
                  <IconButton size="xs" variant="ghost" aria-label="Processing voice input" aria-busy="true">
                    <Spinner size="xs" decorative />
                  </IconButton>
                  <IconButton size="xs" variant="ghost" aria-label="Start voice input">
                    <Mic size={15} aria-hidden />
                  </IconButton>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent className={styles.cardContent}>
            <div>
              <h2 className={styles.cardTitle}>Mascot Loader</h2>
              <p className={styles.cardDescription}>
                Use when Rebel is visibly thinking, preparing, generating, or doing work where a
                bit of reassurance helps.
              </p>
            </div>
            <div className={styles.sampleBox}>
              <div className={styles.mascotSamples}>
                <RebelLoadingIndicator
                  layout="stacked"
                  size="lg"
                  label="Rebel is thinking"
                  description="This is the mascot moment, not a table-cell spinner."
                />
                <div className={styles.mascotRow} aria-label="Mascot loader size and motion review">
                  <RebelLoadingIndicator size="sm" label="Preparing" />
                  <RebelLoadingIndicator size="md" label="Generating" description="Short inline copy." />
                  <RebelLoadingIndicator
                    size="md"
                    motion="static"
                    label="Static"
                    description="Reduced-motion and fallback state."
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent className={styles.cardContent}>
            <div>
              <h2 className={styles.cardTitle}>Skeleton</h2>
              <p className={styles.cardDescription}>
                Use fill-only placeholders when the layout is known and the user benefits from
                seeing the page structure arrive before real content. No stroke on the skeleton.
              </p>
            </div>
            <div className={`${styles.sampleBox} ${styles.skeletonSampleBox}`}>
              <div className={styles.skeletonPreview} aria-hidden="true">
                <div className={`${styles.skeletonLine} ${styles.skeletonLineShort}`} />
                <div className={`${styles.skeletonLine} ${styles.skeletonLineLong}`} />
                <div className={`${styles.skeletonLine} ${styles.skeletonLineMedium}`} />
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      <Card variant="outlined">
        <CardContent className={styles.cardContent}>
          <h2 className={styles.cardTitle}>Replacement Rule</h2>
          <ul className={styles.rules}>
            <li>Replace `spinner-small` with `Spinner` only for compact utility waits.</li>
            <li>Use `RebelLoadingIndicator` for agent-thinking, onboarding, generation, and setup waits.</li>
            <li>Use skeletons for page or card loading where the final content shape is predictable.</li>
            <li>Do not use the mascot for every tiny wait. If everything is delightful, nothing is.</li>
          </ul>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent className={styles.cardContent}>
          <h2 className={styles.cardTitle}>Review Checklist</h2>
          <p className={styles.cardDescription}>
            Before adopting the mascot loader in an app surface, check light and dark themes, inline
            and stacked layout, long-copy wrapping, image fallback, and reduced-motion behavior.
          </p>
        </CardContent>
      </Card>
    </div>
  ),
};
