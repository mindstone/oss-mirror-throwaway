import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { MeetingCompanionBanner } from './MeetingCompanionBanner';
import type { OperatorMetadata } from '@shared/ipc/channels/operators';

const skepticalEngineer: OperatorMetadata = {
  id: '/workspace/Chief-of-Staff::skeptical-engineer',
  operatorSlug: 'skeptical-engineer',
  spacePath: '/workspace/Chief-of-Staff',
  sourceSpacePath: '/workspace/Chief-of-Staff',
  category: 'space',
  name: 'Sales Coach',
  description: 'Helps you steer live calls in the moment.',
  consult_when: 'When the room needs framing support.',
  kind: 'operator',
  roles: ['live_meeting'],
  operatorFileAbsolutePath: '/workspace/Chief-of-Staff/operators/skeptical-engineer/OPERATOR.md',
  groundingPath: '/workspace/Chief-of-Staff/operators/skeptical-engineer/grounding.md',
  diaryPath: '/workspace/Chief-of-Staff/operators/skeptical-engineer/diary.md',
};

const brandCritic: OperatorMetadata = {
  id: '/workspace/Chief-of-Staff::brand-critic',
  operatorSlug: 'brand-critic',
  spacePath: '/workspace/Chief-of-Staff',
  sourceSpacePath: '/workspace/Chief-of-Staff',
  category: 'space',
  name: 'Brand Critic',
  description: 'Finds the parts that sound like a committee had feelings.',
  consult_when: 'When copy needs a sterner mirror.',
  kind: 'operator',
  roles: ['operator'],
  operatorFileAbsolutePath: '/workspace/Chief-of-Staff/operators/brand-critic/OPERATOR.md',
  groundingPath: '/workspace/Chief-of-Staff/operators/brand-critic/grounding.md',
  diaryPath: '/workspace/Chief-of-Staff/operators/brand-critic/diary.md',
};

const execStrategyCoach: OperatorMetadata = {
  id: '/workspace/rebel-system::exec-strategy-coach',
  operatorSlug: 'exec-strategy-coach',
  spacePath: '/workspace/rebel-system',
  sourceSpacePath: '/workspace/rebel-system',
  category: 'bundled',
  name: 'Exec Strategy Coach',
  description: 'Keeps the agenda moving and decisions crisp.',
  consult_when: 'When leadership alignment matters most.',
  kind: 'operator',
  roles: ['operator', 'live_meeting'],
  operatorFileAbsolutePath: '/workspace/rebel-system/operators/exec-strategy-coach/OPERATOR.md',
  groundingPath: '/workspace/rebel-system/operators/exec-strategy-coach/grounding.md',
  diaryPath: '/workspace/rebel-system/operators/exec-strategy-coach/diary.md',
};

const meta: Meta<typeof MeetingCompanionBanner> = {
  title: 'Components/MeetingCompanionBanner',
  component: MeetingCompanionBanner,
  parameters: {
    layout: 'padded',
  },
  args: {
    meetingTitle: 'Weekly Sync',
    meetingUrl: 'https://zoom.us/j/123456789',
    isRecording: true,
    captionsActive: true,
    selectedCoach: null,
    isOnline: true,
    onSelectCoach: () => {},
    operatorRegistryOverride: { operators: [skepticalEngineer], loading: false },
    // eslint-disable-next-line no-console -- Storybook stub: prints prop invocations to the dev console for visual inspection
    onAskSparkSubmit: (prompt, label) => console.log('Ask Spark Submitted:', { prompt, label }),
  },
};

export default meta;
type Story = StoryObj<typeof MeetingCompanionBanner>;

export const Default: Story = {
  args: {
    triggerState: {
      pulsing: false,
      lastTriggerAt: null,
      lastSpeaker: null,
      rateLimited: false,
      rateLimitResetsAt: null,
      awaitingTurn: false,
      lastDropReason: null,
    },
  },
};

export const ZeroOperators: Story = {
  args: {
    operatorRegistryOverride: { operators: [], loading: false },
    presenceMode: 'silent',
    onOpenOperatorsPanel: () => undefined,
  },
};

export const SingleOperator: Story = {
  args: {
    operatorRegistryOverride: { operators: [skepticalEngineer], loading: false },
    presenceMode: 'coach',
  },
};

export const MultipleOperators: Story = {
  args: {
    operatorRegistryOverride: {
      operators: [skepticalEngineer, brandCritic, execStrategyCoach],
      loading: false,
    },
    presenceMode: 'coach',
  },
};

export const FirstUseNotice: Story = {
  args: {
    // Note: To truly see this, you may need to clear localStorage in Storybook
    // localStorage.removeItem('meeting.askSpark.onboardingDismissed');
  },
  decorators: [
    (Story) => {
      localStorage.removeItem('meeting.askSpark.onboardingDismissed');
      return <Story />;
    },
  ],
};

export const Pulsing: Story = {
  args: {
    triggerState: {
      pulsing: true,
      lastTriggerAt: Date.now(),
      lastSpeaker: 'Alex',
      rateLimited: false,
      rateLimitResetsAt: null,
      awaitingTurn: false,
      lastDropReason: null,
    },
  },
  decorators: [
    (Story) => {
      localStorage.setItem('meeting.askSpark.onboardingDismissed', 'true');
      return <Story />;
    },
  ],
};

export const AwaitingTurn: Story = {
  args: {
    triggerState: {
      pulsing: false,
      lastTriggerAt: Date.now() - 5000,
      lastSpeaker: 'Alex',
      rateLimited: false,
      rateLimitResetsAt: null,
      awaitingTurn: true,
      lastDropReason: null,
    },
  },
  decorators: [
    (Story) => {
      localStorage.setItem('meeting.askSpark.onboardingDismissed', 'true');
      return <Story />;
    },
  ],
};

export const Offline: Story = {
  args: {
    isOnline: false,
    triggerState: {
      pulsing: false,
      lastTriggerAt: null,
      lastSpeaker: null,
      rateLimited: false,
      rateLimitResetsAt: null,
      awaitingTurn: false,
      lastDropReason: null,
    },
  },
  decorators: [
    (Story) => {
      localStorage.setItem('meeting.askSpark.onboardingDismissed', 'true');
      return <Story />;
    },
  ],
};

export const RateLimited: Story = {
  args: {
    triggerState: {
      pulsing: false,
      lastTriggerAt: null,
      lastSpeaker: null,
      rateLimited: true,
      rateLimitResetsAt: Date.now() + 60000,
      awaitingTurn: false,
      lastDropReason: null,
    },
  },
  decorators: [
    (Story) => {
      localStorage.setItem('meeting.askSpark.onboardingDismissed', 'true');
      return <Story />;
    },
  ],
};

export const DroppedTrigger: Story = {
  args: {
    triggerState: {
      pulsing: false,
      lastTriggerAt: Date.now() - 2000,
      lastSpeaker: 'user',
      rateLimited: false,
      rateLimitResetsAt: null,
      awaitingTurn: false,
      lastDropReason: 'action-timeout',
    },
  },
  decorators: [
    (Story) => {
      localStorage.setItem('meeting.askSpark.onboardingDismissed', 'true');
      return <Story />;
    },
  ],
};
