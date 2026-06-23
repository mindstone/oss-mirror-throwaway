import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { OperatorMetadata } from '@shared/ipc/channels/operators';
import { Badge, Button } from '@renderer/components/ui';
import styles from './OperatorsPanel.module.css';
import { OperatorCard } from './components/OperatorCard';
import { OperatorsTabs, type OperatorsTabValue } from './components/OperatorsTabs';

const bundledOperator: OperatorMetadata = {
  id: '/workspace/rebel-system::brand-critic',
  operatorSlug: 'brand-critic',
  spacePath: '/workspace/rebel-system',
  sourceSpacePath: '/workspace/rebel-system',
  category: 'bundled',
  name: 'Brand Critic',
  description: 'Keeps the message honest.',
  consult_when: 'When claims need taste.',
  kind: 'operator',
  roles: ['operator'],
  operatorFileAbsolutePath: '/workspace/rebel-system/operators/brand-critic/OPERATOR.md',
  groundingPath: '/workspace/rebel-system/operators/brand-critic/grounding.md',
  diaryPath: '/workspace/rebel-system/operators/brand-critic/diary.md',
};

const customerVoice: OperatorMetadata = {
  ...bundledOperator,
  id: '/workspace/Chief-of-Staff::customer-voice',
  operatorSlug: 'customer-voice',
  category: 'space',
  name: 'Customer Voice',
  spacePath: '/workspace/Chief-of-Staff',
  sourceSpacePath: '/workspace/Chief-of-Staff',
  description: 'Speaks for the user when claims and copy need pressure-testing.',
  consult_when: 'When pricing or onboarding changes.',
  operatorFileAbsolutePath: '/workspace/Chief-of-Staff/operators/customer-voice/OPERATOR.md',
  groundingPath: '/workspace/Chief-of-Staff/operators/customer-voice/grounding.md',
  diaryPath: '/workspace/Chief-of-Staff/operators/customer-voice/diary.md',
};

const liveCoach: OperatorMetadata = {
  ...customerVoice,
  id: '/workspace/Chief-of-Staff::sales-coach',
  operatorSlug: 'sales-coach',
  name: 'Sales Coach',
  description: 'Steers live meeting momentum.',
  consult_when: '',
  roles: ['live_meeting'],
  operatorFileAbsolutePath: '/workspace/Chief-of-Staff/operators/sales-coach/OPERATOR.md',
};

function PanelPreview() {
  const [tab, setTab] = useState<OperatorsTabValue>('operators');
  const noop = () => undefined;
  const operators = tab === 'operators' ? [customerVoice, bundledOperator] : [liveCoach];
  return (
    <div className={styles.panel}>
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <div>
            <p className={styles.heroKicker}>Operators</p>
            <h2 className={styles.heroTitle}>3 perspectives available</h2>
            <p className={styles.heroDescription}>
              Rebel can ask Operators for a second opinion when the work needs one.
              Think specialist colleagues, minus the calendar wrestling.
            </p>
          </div>
        </div>
        <div className={styles.heroStats}>
          <Badge variant="secondary">2 operators</Badge>
          <Badge variant="secondary">1 live coach</Badge>
        </div>
      </section>
      <OperatorsTabs
        value={tab}
        onValueChange={setTab}
        operatorsCount={2}
        liveCoachesCount={1}
      />
      <section className={styles.operatorsGrid}>
        {operators.map((op) => (
          <OperatorCard
            key={op.id}
            operator={op}
            state={op.category === 'bundled' ? { kind: 'bundled' } : { kind: 'activated', personalised: false, personalising: false }}
            spaceLabel={op.category === 'bundled' ? 'Bundled' : 'Chief-of-Staff'}
            activationTargets={op.category === 'bundled' ? [
              { sourceSpacePath: '/workspace/Chief-of-Staff', label: 'Chief-of-Staff', isChiefOfStaff: true },
              { sourceSpacePath: '/workspace/work/acme/Launch', label: 'Launch' },
            ] : []}
            defaultActivationTargetSpacePath="/workspace/Chief-of-Staff"
            onActivate={noop}
            onPersonalise={noop}
            onOpenInstructions={noop}
            onToggleLiveMeeting={noop}
            onRename={op.category === 'space' ? noop : undefined}
            onDuplicate={op.category === 'space' && op.roles.includes('operator') ? noop : undefined}
            onHistory={op.category === 'space' && op.roles.includes('operator') ? noop : undefined}
            onRemove={op.category === 'space' ? noop : undefined}
          />
        ))}
      </section>
      <Button variant="ghost" size="xs">Refresh</Button>
    </div>
  );
}

const meta: Meta<typeof PanelPreview> = {
  title: 'Operators/Operators Panel',
  component: PanelPreview,
  parameters: { layout: 'fullscreen' },
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
