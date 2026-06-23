import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { FileLocation } from '@rebel/shared';
import { Button } from '@renderer/components/ui';
import {
  DrawerApprovalTrustRow,
  type DrawerApprovalTrustRowProps,
} from './DrawerApprovalTrustRow';
import styles from './DrawerApprovalTrustRow.stories.module.css';

interface TrustRowScenario {
  id: string;
  title: string;
  timeLabel: string;
  riskLabel: string;
  reviewPrimary: boolean;
  row: DrawerApprovalTrustRowProps;
}

const lowRiskLocation: FileLocation = {
  kind: 'in-space',
  spaceName: 'Chief-of-Staff',
  spaceWorkspacePath: '/spaces/chief-of-staff',
  spaceRelativePath: '2026/05/briefing-note.md',
  workspaceRelativePath: 'spaces/chief-of-staff/2026/05/briefing-note.md',
  fileName: 'briefing-note.md',
  absolutePath: '/workspace/spaces/chief-of-staff/2026/05/briefing-note.md',
};

const longDestinationLocation: FileLocation = {
  kind: 'in-space',
  spaceName: 'Executive Team Space',
  spaceWorkspacePath: '/spaces/executive-team-space',
  spaceRelativePath: 'projects/fy27/planning/quarterly/board-prep/customer-voice-synthesis.md',
  workspaceRelativePath: 'spaces/executive-team-space/projects/fy27/planning/quarterly/board-prep/customer-voice-synthesis.md',
  fileName: 'customer-voice-synthesis.md',
  absolutePath: '/workspace/spaces/executive-team-space/projects/fy27/planning/quarterly/board-prep/customer-voice-synthesis.md',
};

const hierarchyScenarios: TrustRowScenario[] = [
  {
    id: 'save-primary',
    title: 'Save weekly customer update to Chief-of-Staff',
    timeLabel: '2m ago',
    riskLabel: 'Low risk',
    reviewPrimary: false,
    row: {
      destinationLocation: lowRiskLocation,
      audienceSharing: 'private',
      reversibility: 'Can edit after saving',
    },
  },
  {
    id: 'review-primary',
    title: 'Save incident timeline to company workspace for leadership review',
    timeLabel: '5m ago',
    riskLabel: 'Needs review',
    reviewPrimary: true,
    row: {
      destinationLocation: lowRiskLocation,
      audienceSharing: 'company-wide',
      reversibility: 'Hard to undo',
    },
  },
];

const fallbackScenarios: TrustRowScenario[] = [
  {
    id: 'message',
    title: 'Send launch update in Slack',
    timeLabel: 'Just now',
    riskLabel: 'Medium risk',
    reviewPrimary: true,
    row: {
      destinationLabel: '#launch-ops',
      audienceLabel: 'Shared workspace',
      reversibility: 'Can edit after posting',
      riskCue: 'Leaves Rebel',
    },
  },
  {
    id: 'tool',
    title: 'Run command to update project notes',
    timeLabel: '1m ago',
    riskLabel: 'Higher-risk approval',
    reviewPrimary: true,
    row: {
      destinationLabel: 'Runs command on your device',
      audienceLabel: 'Only you',
      reversibility: 'Runs once',
      riskCue: 'Hard to undo',
    },
  },
  {
    id: 'long-destination',
    title: 'Save customer voice synthesis',
    timeLabel: '12m ago',
    riskLabel: 'Needs review',
    reviewPrimary: true,
    row: {
      destinationLocation: longDestinationLocation,
      audienceSharing: 'restricted',
      reversibility: 'Can edit after saving',
    },
  },
];

function CompactTrustCard({
  title,
  timeLabel,
  riskLabel,
  reviewPrimary,
  row,
}: TrustRowScenario): JSX.Element {
  return (
    <article className={styles.card}>
      <div className={styles.header}>
        <span className={styles.timeRow}>
          <span className={styles.time}>{timeLabel}</span>
          <span className={styles.riskHint}>{riskLabel}</span>
        </span>
        <p className={styles.title}>{title}</p>
      </div>
      <DrawerApprovalTrustRow {...row} />
      <div className={styles.actions}>
        <Button type="button" variant={reviewPrimary ? 'default' : 'secondary'} size="sm">
          Review
        </Button>
        <Button type="button" variant={reviewPrimary ? 'secondary' : 'default'} size="sm">
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm">
          Cancel
        </Button>
      </div>
    </article>
  );
}

function ThemeSurface({
  theme,
  title,
  entries,
}: {
  theme: 'light' | 'dark';
  title: string;
  entries: TrustRowScenario[];
}): JSX.Element {
  useEffect(() => {
    document.body.classList.toggle('light', theme === 'light');
    return () => {
      document.body.classList.remove('light');
    };
  }, [theme]);

  return (
    <div className={styles.page}>
      <section className={styles.themeColumn}>
        <h3 className={styles.themeLabel}>{title}</h3>
        <div className={styles.cardList}>
          {entries.map((entry) => (
            <CompactTrustCard key={entry.id} {...entry} />
          ))}
        </div>
      </section>
    </div>
  );
}

const meta = {
  title: 'Inbox/DrawerApprovalTrustRow',
  component: DrawerApprovalTrustRow,
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
  },
} satisfies Meta<typeof DrawerApprovalTrustRow>;

export default meta;

type Story = StoryObj<typeof meta>;

export const EmbeddedCardHierarchyLight: Story = {
  render: () => (
    <ThemeSurface
      theme="light"
      title="Embedded card hierarchy (light)"
      entries={hierarchyScenarios}
    />
  ),
};

export const EmbeddedCardHierarchyDark: Story = {
  render: () => (
    <ThemeSurface
      theme="dark"
      title="Embedded card hierarchy (dark)"
      entries={hierarchyScenarios}
    />
  ),
};

export const ToolAndMessageFallbacks: Story = {
  render: () => (
    <ThemeSurface
      theme="light"
      title="Tool and message fallbacks"
      entries={fallbackScenarios}
    />
  ),
};
