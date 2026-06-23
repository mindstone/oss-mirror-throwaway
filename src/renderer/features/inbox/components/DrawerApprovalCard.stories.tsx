import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { DrawerApprovalCard, type DrawerApprovalCardProps } from './DrawerApprovalCard';
import type { PendingApprovalItem } from '../hooks/usePendingApprovals';
import type { StagedFileItem } from '../hooks/useStagedFiles';
import styles from './DrawerApprovalCard.stories.module.css';

interface ApprovalScenario {
  id: string;
  title: string;
  note: string;
  props: DrawerApprovalCardProps;
}

const noop = (): void => {};

function buildToolApproval(overrides: Partial<PendingApprovalItem> = {}): PendingApprovalItem {
  return {
    id: 'tool:story-approval',
    type: 'tool',
    title: 'Story approval',
    description: 'Rebel wants your OK before continuing.',
    timestamp: Date.now() - 90_000,
    sessionId: 'session-story',
    riskLevel: 'medium',
    packageName: 'Story fixture',
    toolApproval: {
      toolUseID: 'tool-story',
      turnId: 'turn-story',
      toolName: 'mcp__super-mcp-router__use_tool',
      input: {},
      reason: 'Safety Rules blocked: This action contacts someone outside Rebel.',
      blockedBy: 'safety_prompt',
    },
    ...overrides,
  };
}

const slackChannelApproval = buildToolApproval({
  id: 'tool:story-slack-channel',
  description: 'Rebel wants to send a Slack update in #launch-ops.',
  packageName: 'Slack',
  toolApproval: {
    toolUseID: 'tool-story-slack',
    turnId: 'turn-story',
    toolName: 'mcp__super-mcp-router__use_tool',
    input: {
      package_id: 'slack',
      tool_id: 'post_slack_message',
      args: {
        channel: 'C123LAUNCH',
        channel_name: 'launch-ops',
        text: 'Quick update: the beta notes are ready for review. I will send the doc link once approvals finish.',
      },
    },
    effectiveToolId: 'post_slack_message',
    reason: 'Safety Rules blocked: Slack messages require approval before Rebel contacts the team.',
    blockedBy: 'safety_prompt',
  },
});

const slackDmApproval = buildToolApproval({
  id: 'tool:story-slack-dm',
  description: 'Rebel wants to send a direct Slack message to Team Member.',
  packageName: 'Slack',
  riskLevel: 'high',
  toolApproval: {
    toolUseID: 'tool-story-slack-dm',
    turnId: 'turn-story',
    toolName: 'mcp__super-mcp-router__use_tool',
    input: {
      package_id: 'slack',
      tool_id: 'open_slack_dm',
      args: {
        user: 'U123LIAM',
        recipient_display_name: 'Team Member',
        text: 'Can you sanity-check the customer quote before I send it to the launch channel?',
      },
    },
    effectiveToolId: 'open_slack_dm',
    reason: 'Safety Rules blocked: Slack direct messages require approval before Rebel contacts a person.',
    blockedBy: 'safety_prompt',
  },
});

const emailApproval = buildToolApproval({
  id: 'tool:story-email',
  description: 'Rebel wants to send an email.',
  packageName: 'Gmail',
  riskLevel: 'high',
  toolApproval: {
    toolUseID: 'tool-story-email',
    turnId: 'turn-story',
    toolName: 'mcp__super-mcp-router__use_tool',
    input: {
      package_id: 'gmail',
      tool_id: 'send_email',
      args: {
        to: 'amira@example.com',
        subject: 'Follow-up from today',
        body: 'Hi Amira,\n\nThanks for the call. Here is the summary and the two decisions we discussed.',
      },
    },
    effectiveToolId: 'send_email',
    reason: 'Safety Rules blocked: Email sends require approval before Rebel contacts someone.',
    blockedBy: 'safety_prompt',
  },
});

const memoryApproval: PendingApprovalItem = {
  id: 'memory:story-company-wide',
  type: 'memory',
  title: 'Memory approval',
  description: 'Rebel wants to save a memory',
  timestamp: Date.now() - 240_000,
  sessionId: 'session-story-memory',
  memoryApproval: {
    toolUseId: 'memory-story',
    originalSessionId: 'session-story-memory',
    filePath: '/workspace/spaces/general/launch-plan.md',
    spaceName: 'General',
    spacePath: '/workspace/spaces/general',
    summary: 'Launch positioning notes and customer quote guidance.',
    content: 'Launch positioning notes and customer quote guidance.',
    contentPreview: 'Launch positioning notes and customer quote guidance.',
    sharing: 'company-wide',
    blockedBy: 'safety_prompt',
    sensitivityReason: 'This save may be visible to the broader company.',
  },
};

const stagedFile: StagedFileItem = {
  id: 'staged-file-story',
  realPath: '/workspace/spaces/customer-success/projects/acme-renewal/very-long-renewal-briefing-note.md',
  fileName: 'very-long-renewal-briefing-note.md',
  spaceName: 'Customer Success',
  spacePath: '/workspace/spaces/customer-success',
  sessionId: 'session-story-file',
  baseHash: 'new-file',
  summary: 'Creates a renewal briefing with stakeholder notes, risks, and the recommended follow-up.',
  stagedAt: Date.now() - 420_000,
  sensitivity: 'medium',
  sharing: 'restricted',
  blockedBy: 'safety_prompt',
};

const scenarios: ApprovalScenario[] = [
  {
    id: 'slack-channel',
    title: 'Slack channel message',
    note: 'Checks channel destination, grey chips, and Preview message.',
    props: { approval: slackChannelApproval, onOpenActionPreview: noop, onApprove: noop, onDismiss: noop },
  },
  {
    id: 'slack-dm',
    title: 'Slack direct message',
    note: 'Checks recipient clarity without exposing raw Slack IDs.',
    props: { approval: slackDmApproval, onOpenActionPreview: noop, onApprove: noop, onDismiss: noop },
  },
  {
    id: 'email',
    title: 'Email send',
    note: 'Checks To/preview affordance and hard-to-reverse cue.',
    props: { approval: emailApproval, onOpenActionPreview: noop, onApprove: noop, onDismiss: noop },
  },
  {
    id: 'memory',
    title: 'Save to company-wide space',
    note: 'Checks neutral grey destination and Company-wide chip treatment.',
    props: { approval: memoryApproval, onOpenActionPreview: noop, onApprove: noop, onDismiss: noop },
  },
  {
    id: 'staged-file',
    title: 'Long saved destination',
    note: 'Checks wrapping and density at drawer width.',
    props: { stagedFile, onOpenActionPreview: noop, onSave: noop, onKeepPrivate: noop },
  },
];

function ScenarioCard({ scenario }: { scenario: ApprovalScenario }): JSX.Element {
  return (
    <section className={styles.scenario}>
      <header className={styles.scenarioHeader}>
        <h3 className={styles.scenarioTitle}>{scenario.title}</h3>
        <p className={styles.scenarioNote}>{scenario.note}</p>
      </header>
      <DrawerApprovalCard approvalId={scenario.props.approval?.id ?? scenario.props.stagedFile?.id} {...scenario.props} />
    </section>
  );
}

function ApprovalReviewSurface({ theme }: { theme: 'light' | 'dark' }): JSX.Element {
  useEffect(() => {
    document.body.classList.toggle('light', theme === 'light');
    return () => {
      document.body.classList.remove('light');
    };
  }, [theme]);

  return (
    <div className={styles.page}>
      <div className={styles.intro}>
        <p className={styles.eyebrow}>Approval card review surface</p>
        <h2 className={styles.title}>Production card examples for message, email, and saved-content approvals</h2>
        <p className={styles.description}>
          These fixtures render the real drawer approval card at drawer width, so chip contrast,
          preview affordances, and action hierarchy can be reviewed together.
        </p>
      </div>
      <div className={styles.columns}>
        {scenarios.map((scenario) => (
          <ScenarioCard key={scenario.id} scenario={scenario} />
        ))}
      </div>
    </div>
  );
}

const meta = {
  title: 'Inbox/DrawerApprovalCard',
  component: DrawerApprovalCard,
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
  },
} satisfies Meta<typeof DrawerApprovalCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ApprovalPreviewExamplesLight: Story = {
  render: () => <ApprovalReviewSurface theme="light" />,
};

export const ApprovalPreviewExamplesDark: Story = {
  render: () => <ApprovalReviewSurface theme="dark" />,
};
