import type { Meta, StoryObj } from '@storybook/react';
import type { CSSProperties, ReactNode } from 'react';
import type { ActionPreviewModel } from '@rebel/shared';
import { ActionPreview } from './ActionPreview';
import { ActionPreviewDialog } from './ActionPreviewDialog';
import styles from './ActionPreview.stories.module.css';

function buildModel(overrides: Partial<ActionPreviewModel> = {}): ActionPreviewModel {
  return {
    effectKind: 'generic',
    title: 'Review action',
    contentVisibility: 'safe',
    blastRadius: {
      where: [{ label: 'Slack channel', evidence: 'explicit' }],
      whoCanSeeIt: [{ label: 'Shared workspace', evidence: 'explicit' }],
      afterwards: [{ label: 'Can edit after posting', evidence: 'derived' }],
    },
    reversibility: 'Can edit after posting',
    riskReasons: [],
    structuredArgs: [
      { key: 'channel', value: '#leadership' },
      { key: 'text', value: 'Weekly update is ready to send.' },
    ],
    safeRawArgs: {
      channel: '#leadership',
      text: 'Weekly update is ready to send.',
    },
    ...overrides,
  };
}

function PreviewFrame({
  children,
  maxWidth = 780,
}: {
  children: ReactNode;
  maxWidth?: number;
}) {
  return (
    <div
      className={styles.previewFrame}
      style={{ '--preview-frame-max-width': `${maxWidth}px` } as CSSProperties}
    >
      {children}
    </div>
  );
}

// Decision-first rebuild (2026-06): the Action Preview is one calm confirmation
// surface — a single framed artifact (the message/file being sent), inline
// sentence-case metadata, a plain "why" line, and a quiet receipts disclosure.
// The blast-radius pill strip is intentionally NOT used here; it remains the
// correct summary primitive for the memory/file preview dialogs only.
const meta = {
  title: 'Approval/ActionPreview',
  component: ActionPreview,
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
  },
} satisfies Meta<typeof ActionPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DrawerCardLowRiskInline: Story = {
  render: () => (
    <PreviewFrame>
      <ActionPreview
        model={buildModel({
          effectKind: 'document',
          title: 'Save to Chief-of-Staff',
          blastRadius: {
            where: [{ label: 'Chief-of-Staff', evidence: 'derived' }],
            whoCanSeeIt: [{ label: 'Private to you', evidence: 'explicit' }],
            afterwards: [{ label: 'Can edit after saving', evidence: 'derived' }],
          },
          reversibility: 'Can edit after saving',
          structuredArgs: [
            { key: 'summary', value: 'Captured notes from the partner sync.' },
            { key: 'filePath', value: '/chief-of-staff/meeting-notes.md' },
          ],
          safeRawArgs: {
            summary: 'Captured notes from the partner sync.',
            filePath: '/chief-of-staff/meeting-notes.md',
          },
        })}
        reason="You asked Rebel to save this meeting summary for later."
      />
    </PreviewFrame>
  ),
};

export const DrawerCardMediumRiskInline: Story = {
  render: () => (
    <PreviewFrame>
      <ActionPreview
        model={buildModel({
          effectKind: 'message',
          title: 'Send Slack message',
          riskReasons: ['Shared', 'Leaves Rebel'],
          blastRadius: {
            where: [{ label: '#launch-ops', evidence: 'explicit' }],
            whoCanSeeIt: [{ label: 'Shared workspace', evidence: 'explicit' }],
            afterwards: [{ label: 'Can edit after posting', evidence: 'derived' }],
          },
        })}
        reason="This message goes to a shared channel."
        state="resolving"
        stateMessage="Still checking recipient details..."
      />
    </PreviewFrame>
  ),
};

export const DrawerCardHighRiskInline: Story = {
  render: () => (
    <PreviewFrame>
      <ActionPreview
        model={buildModel({
          effectKind: 'external-record',
          title: 'Update external record',
          blastRadius: {
            where: [{ label: 'HubSpot', evidence: 'derived' }],
            whoCanSeeIt: [{ label: 'Shared workspace', evidence: 'explicit' }],
            afterwards: [{ label: 'Hard to undo', evidence: 'derived' }],
          },
          reversibility: 'Hard to undo',
          riskReasons: ['Leaves Rebel', 'Hard to undo'],
          structuredArgs: [
            { key: 'recordId', value: 'contact_2891' },
            { key: 'field', value: 'Deal stage' },
            { key: 'value', value: 'Negotiation' },
          ],
          safeRawArgs: {
            recordId: 'contact_2891',
            field: 'Deal stage',
            value: 'Negotiation',
          },
        })}
      />
    </PreviewFrame>
  ),
};

export const MessagePreviewSlackChannelDialog: Story = {
  render: () => (
    <PreviewFrame maxWidth={920}>
      <ActionPreviewDialog
        open={true}
        onOpenChange={() => undefined}
        model={buildModel({
          effectKind: 'message',
          title: 'Send Slack message',
          blastRadius: {
            where: [{ label: '#leadership', evidence: 'explicit' }],
            whoCanSeeIt: [],
            afterwards: [{ label: 'Can edit after posting', evidence: 'derived' }],
          },
          riskReasons: ['Shared', 'Leaves Rebel'],
          structuredArgs: [
            { key: 'text', value: 'Weekly update is ready to post.' },
            {
              key: 'blocks',
              value: JSON.stringify([
                {
                  type: 'section',
                  text: { type: 'mrkdwn', text: '*Weekly update*: revenue target remains on track.' },
                },
              ]),
            },
          ],
          safeRawArgs: {
            channel: '#leadership',
            text: 'Weekly update is ready to post.',
            blocks: [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: '*Weekly update*: revenue target remains on track.' },
              },
            ],
          },
        })}
        reason="This message leaves Rebel and reaches a shared audience."
      />
    </PreviewFrame>
  ),
};

export const MessagePreviewSlackDmDialog: Story = {
  render: () => (
    <PreviewFrame maxWidth={920}>
      <ActionPreviewDialog
        open={true}
        onOpenChange={() => undefined}
        model={buildModel({
          effectKind: 'message',
          title: 'Send Slack message',
          blastRadius: {
            where: [{ label: 'Direct message', evidence: 'derived' }],
            whoCanSeeIt: [{ label: 'Just Morgan', evidence: 'explicit' }],
            afterwards: [{ label: 'Can edit after posting', evidence: 'derived' }],
          },
          riskReasons: ['Leaves Rebel'],
          structuredArgs: [
            { key: 'recipient', value: '@morgan' },
            { key: 'text', value: 'Can we move the customer kickoff to 3pm?' },
          ],
          safeRawArgs: {
            recipient: '@morgan',
            text: 'Can we move the customer kickoff to 3pm?',
          },
        })}
      />
    </PreviewFrame>
  ),
};

export const DecisionCtaHierarchyDialog: Story = {
  render: () => (
    <PreviewFrame maxWidth={920}>
      <ActionPreviewDialog
        open={true}
        onOpenChange={() => undefined}
        model={buildModel({
          effectKind: 'message',
          title: 'Send Slack message',
          blastRadius: {
            where: [{ label: 'Direct message', evidence: 'derived' }],
            whoCanSeeIt: [{ label: 'Just Morgan', evidence: 'explicit' }],
            afterwards: [{ label: 'Can edit after posting', evidence: 'derived' }],
          },
          riskReasons: ['Leaves Rebel'],
          structuredArgs: [
            { key: 'recipient', value: '@morgan' },
            { key: 'text', value: 'Can we move the customer kickoff to 3pm?' },
          ],
          safeRawArgs: {
            recipient: '@morgan',
            text: 'Can we move the customer kickoff to 3pm?',
          },
        })}
        reason="Slack direct messages need your okay first."
        onDiscard={() => undefined}
        onAllow={() => undefined}
        onAllowAndRemember={() => undefined}
        allowLabel="Allow once"
        discardLabel="Don't allow"
        showAllowAndRemember={true}
      />
    </PreviewFrame>
  ),
};

export const MessagePreviewSlackDmUnresolvedDialog: Story = {
  render: () => (
    <PreviewFrame maxWidth={920}>
      <ActionPreviewDialog
        open={true}
        onOpenChange={() => undefined}
        model={buildModel({
          effectKind: 'message',
          title: 'Send Slack message',
          blastRadius: {
            where: [{ label: 'Direct message', evidence: 'derived' }],
            whoCanSeeIt: [],
            afterwards: [{ label: 'Can edit after posting', evidence: 'derived' }],
          },
          riskReasons: ['Leaves Rebel'],
          structuredArgs: [
            { key: 'text', value: 'Quick reminder: please review the prep notes before 4pm.' },
          ],
          safeRawArgs: {
            text: 'Quick reminder: please review the prep notes before 4pm.',
          },
        })}
        state="resolving"
        stateMessage="Still checking recipient details..."
      />
    </PreviewFrame>
  ),
};

export const MessagePreviewWithheldDialog: Story = {
  render: () => (
    <PreviewFrame maxWidth={920}>
      <ActionPreviewDialog
        open={true}
        onOpenChange={() => undefined}
        model={buildModel({
          effectKind: 'message',
          title: 'Send Slack message',
          contentVisibility: 'withheld',
          blastRadius: {
            where: [{ label: '#leadership', evidence: 'explicit' }],
            whoCanSeeIt: [],
            afterwards: [{ label: 'Can edit after posting', evidence: 'derived' }],
          },
          riskReasons: ['Shared', 'Leaves Rebel'],
          structuredArgs: [
            { key: 'text', value: 'Sensitive text should not be rendered.' },
          ],
          safeRawArgs: {},
        })}
      />
    </PreviewFrame>
  ),
};

export const DataCapturePreviewDialog: Story = {
  render: () => (
    <PreviewFrame maxWidth={920}>
      <ActionPreviewDialog
        open={true}
        onOpenChange={() => undefined}
        model={buildModel({
          effectKind: 'data-capture',
          title: 'Save to Chief-of-Staff',
          blastRadius: {
            where: [{ label: 'Chief-of-Staff', evidence: 'derived' }],
            whoCanSeeIt: [{ label: 'Company-wide', evidence: 'explicit' }],
            afterwards: [{ label: 'Can edit after saving', evidence: 'derived' }],
          },
          reversibility: 'Can edit after saving',
          riskReasons: ['Shared'],
          structuredArgs: [
            { key: 'what will be saved', value: 'Board prep source capture from this morning.' },
            { key: 'excerpt 1', value: 'Revenue risk appears concentrated in EMEA pipeline.' },
            { key: 'excerpt 2', value: 'Hiring freeze recommendation is limited to G&A roles.' },
          ],
          safeRawArgs: {
            where: 'Chief-of-Staff',
            path: '/memory/chief-of-staff/260529_1430_meeting_q3-review.md',
            sharing: 'Company-wide',
            isNew: true,
            summary: 'Board prep source capture from this morning.',
            excerpts: [
              'Revenue risk appears concentrated in EMEA pipeline.',
              'Hiring freeze recommendation is limited to G&A roles.',
            ],
          },
        })}
      />
    </PreviewFrame>
  ),
};

export const DataCapturePreviewDialogExpanded: Story = {
  render: () => (
    <PreviewFrame maxWidth={920}>
      <ActionPreviewDialog
        open={true}
        onOpenChange={() => undefined}
        model={buildModel({
          effectKind: 'data-capture',
          title: 'Save to Chief-of-Staff',
          blastRadius: {
            where: [{ label: 'Chief-of-Staff', evidence: 'derived' }],
            whoCanSeeIt: [{ label: 'Shared workspace', evidence: 'explicit' }],
            afterwards: [{ label: 'Can edit after saving', evidence: 'derived' }],
          },
          reversibility: 'Can edit after saving',
          riskReasons: ['Shared'],
          structuredArgs: [
            { key: 'what will be saved', value: 'Source-capture excerpt bundle from customer calls.' },
            { key: 'excerpt 1', value: 'Customers repeatedly asked for weekly scorecards.' },
            { key: 'excerpt 2', value: 'Follow-up requests center on onboarding analytics.' },
          ],
          safeRawArgs: {
            where: 'Chief-of-Staff',
            path: '/memory/chief-of-staff/260529_1130_meeting_customer-feedback.md',
            sharing: 'Shared workspace',
            isNew: true,
            summary: 'Source-capture excerpt bundle from customer calls.',
            excerpts: [
              'Customers repeatedly asked for weekly scorecards.',
              'Follow-up requests center on onboarding analytics.',
            ],
          },
        })}
      />
    </PreviewFrame>
  ),
  play: async ({ canvasElement }) => {
    const toggle = canvasElement.querySelector('[data-testid="data-capture-preview-excerpts-toggle"]');
    if (toggle) {
      (toggle as HTMLButtonElement).click();
    }
  },
};

export const DataCaptureModifiedRoutesToDiffNote: Story = {
  render: () => (
    <PreviewFrame maxWidth={920}>
      <div className={styles.counterExampleCard}>
        <h3 className={styles.counterExampleTitle}>Modified captures route to diff</h3>
        <p className={styles.counterExampleCopy}>
          Non-new source-capture changes stay on the document diff path instead of this DataCapture body.
        </p>
      </div>
    </PreviewFrame>
  ),
};

export const GenericStructuredPreviewDialog: Story = {
  render: () => (
    <PreviewFrame maxWidth={920}>
      <ActionPreviewDialog
        open={true}
        onOpenChange={() => undefined}
        model={buildModel({
          effectKind: 'generic',
          title: 'Run tool action',
          blastRadius: {
            where: [{ label: 'Runs on your device', evidence: 'derived' }],
            whoCanSeeIt: [],
            afterwards: [{ label: 'Runs once', evidence: 'derived' }],
          },
          reversibility: 'Runs once',
          structuredArgs: [
            { key: 'command', value: 'npm run report:daily -- --team growth' },
            { key: 'cwd', value: '/workspace/reports' },
          ],
          safeRawArgs: {
            command: 'npm run report:daily -- --team growth',
            cwd: '/workspace/reports',
            metadata: { traceId: 'abc-123' },
          },
        })}
      />
    </PreviewFrame>
  ),
};

export const WithheldSensitiveContent: Story = {
  render: () => (
    <PreviewFrame>
      <ActionPreview
        model={buildModel({
          effectKind: 'data-capture',
          title: 'Save captured information',
          contentVisibility: 'withheld',
          structuredArgs: [],
          safeRawArgs: {
            destination: 'Chief-of-Staff',
          },
        })}
      />
    </PreviewFrame>
  ),
};

export const LoadingAndErrorBody: Story = {
  render: () => (
    <PreviewFrame>
      <ActionPreview
        model={buildModel({ effectKind: 'message', title: 'Send Slack message' })}
        state="loading"
      />
      <ActionPreview
        model={buildModel({ effectKind: 'message', title: 'Send Slack message' })}
        state="error"
        errorMessage="Could not load extra recipient details right now."
      />
      <ActionPreview
        model={buildModel({ effectKind: 'message', title: 'Send Slack message' })}
        state="resolving"
        stateMessage="Still checking recipient details..."
      />
      <ActionPreview
        model={buildModel({ effectKind: 'message', title: 'Send Slack message' })}
        state="no-longer-waiting"
      />
    </PreviewFrame>
  ),
};

export const OverflowLongLabels: Story = {
  render: () => (
    <PreviewFrame>
      <ActionPreview
        model={buildModel({
          title: 'Send Slack message',
          blastRadius: {
            where: [{
              label: '#really-long-channel-name-that-keeps-going-with-additional-context',
              evidence: 'explicit',
            }],
            whoCanSeeIt: [{
              label: 'Just Alex and the extended finance planning review committee',
              evidence: 'derived',
            }],
            afterwards: [{ label: 'Can edit after posting', evidence: 'derived' }],
          },
          structuredArgs: [
            {
              key: 'text',
              value: 'Posting the quarterly update with the detailed appendix attached for async review.',
            },
          ],
        })}
      />
    </PreviewFrame>
  ),
};

export const BothThemesInContext: Story = {
  render: () => (
    <div className={styles.themesGrid}>
      <div className={`light ${styles.themePanel}`}>
        <ActionPreview
          model={buildModel({
            effectKind: 'message',
            title: 'Send Slack message',
            blastRadius: {
              where: [{ label: '#launch-ops', evidence: 'explicit' }],
              whoCanSeeIt: [],
              afterwards: [{ label: 'Can edit after posting', evidence: 'derived' }],
            },
            riskReasons: ['Shared', 'Leaves Rebel'],
            structuredArgs: [{ key: 'text', value: 'Light theme message preview body example.' }],
            safeRawArgs: { text: 'Light theme message preview body example.' },
          })}
        />
        <ActionPreview
          model={buildModel({
            effectKind: 'data-capture',
            title: 'Save to Chief-of-Staff',
            blastRadius: {
              where: [{ label: 'Chief-of-Staff', evidence: 'derived' }],
              whoCanSeeIt: [{ label: 'Shared workspace', evidence: 'explicit' }],
              afterwards: [{ label: 'Can edit after saving', evidence: 'derived' }],
            },
            reversibility: 'Can edit after saving',
            riskReasons: ['Shared'],
            structuredArgs: [{ key: 'what will be saved', value: 'Light theme source capture summary.' }],
            safeRawArgs: {
              where: 'Chief-of-Staff',
              path: '/memory/chief-of-staff/260529_1130_meeting_customer-feedback.md',
              sharing: 'Shared workspace',
              isNew: true,
              summary: 'Light theme source capture summary.',
              excerpts: ['Customers requested more onboarding analytics detail.'],
            },
          })}
        />
      </div>
      <div className={`dark ${styles.themePanel}`}>
        <ActionPreview
          model={buildModel({
            effectKind: 'message',
            title: 'Send Slack message',
            blastRadius: {
              where: [{ label: '#launch-ops', evidence: 'explicit' }],
              whoCanSeeIt: [],
              afterwards: [{ label: 'Can edit after posting', evidence: 'derived' }],
            },
            riskReasons: ['Shared', 'Leaves Rebel'],
            structuredArgs: [{ key: 'text', value: 'Dark theme message preview body example.' }],
            safeRawArgs: { text: 'Dark theme message preview body example.' },
          })}
        />
        <ActionPreview
          model={buildModel({
            effectKind: 'data-capture',
            title: 'Save to Chief-of-Staff',
            blastRadius: {
              where: [{ label: 'Chief-of-Staff', evidence: 'derived' }],
              whoCanSeeIt: [{ label: 'Shared workspace', evidence: 'explicit' }],
              afterwards: [{ label: 'Can edit after saving', evidence: 'derived' }],
            },
            reversibility: 'Can edit after saving',
            riskReasons: ['Shared'],
            structuredArgs: [{ key: 'what will be saved', value: 'Dark theme source capture summary.' }],
            safeRawArgs: {
              where: 'Chief-of-Staff',
              path: '/memory/chief-of-staff/260529_1130_meeting_customer-feedback.md',
              sharing: 'Shared workspace',
              isNew: true,
              summary: 'Dark theme source capture summary.',
              excerpts: ['Enterprise feedback highlights workflow automation gaps.'],
            },
          })}
        />
      </div>
    </div>
  ),
};

export const KeepLocalCounterExamples: Story = {
  render: () => (
    <PreviewFrame>
      <div className={styles.counterExampleCard}>
        <h3 className={styles.counterExampleTitle}>Counter-example: composer context chips stay local</h3>
        <p className={styles.counterExampleCopy}>
          This story keeps non-approval chip treatments local instead of forcing them into BlastRadiusStrip.
        </p>
      </div>
      <div className={styles.counterExampleCard}>
        <h3 className={styles.counterExampleTitle}>Counter-example: connector status chips stay local</h3>
        <p className={styles.counterExampleCopy}>
          Approval blast-radius chips remain scoped to approval trust decisions.
        </p>
      </div>
    </PreviewFrame>
  ),
};
