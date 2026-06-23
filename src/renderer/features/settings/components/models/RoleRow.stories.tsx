import type { Meta, StoryObj } from '@storybook/react';
import type { RoleAssignment, RoleStatus } from '@core/rebelCore/roleAssignment';
import type { AppSettings, ModelProfile } from '@shared/types';
import type { ModelChoice } from '@shared/types/modelChoice';
import { RoleRow } from './RoleRow';

const profiles: ModelProfile[] = [
  {
    id: 'profile-ready',
    name: 'Research Gateway',
    providerType: 'openai',
    routeSurface: 'api-key',
    serverUrl: 'https://example.test/v1',
    model: 'gpt-5.5',
    apiKey: 'fake-key',
    createdAt: 1,
    enabled: true,
  },
  {
    id: 'profile-incomplete',
    name: 'Needs Setup',
    providerType: 'other',
    serverUrl: '',
    model: 'future-model',
    createdAt: 2,
    enabled: false,
  },
];

const settings = {
  activeProvider: 'anthropic',
  localModel: { profiles },
  models: { apiKey: 'fake-key' },
} as AppSettings;

const catalogModels = [
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
];

const baseAssignment: RoleAssignment = {
  role: 'working',
  label: 'Main work',
  primary: { kind: 'profile', profileId: 'profile-ready' },
  fallback: null,
  status: { kind: 'ok', source: 'profile' },
  display: {
    modelLabel: 'Research Gateway',
    providerLabel: 'OpenAI',
    billingSource: 'pay-per-use',
  },
  fallbackDisplay: null,
  effectiveModelId: 'gpt-5.5',
  warning: null,
  warningCta: null,
};

function assignmentFor(
  name: string,
  primary: ModelChoice,
  status: RoleStatus,
  overrides: Partial<RoleAssignment> = {},
): RoleAssignment {
  const warning =
    status.kind === 'missing-profile'
      ? 'Selected profile is no longer available. Pick another model before Rebel can use this role.'
      : status.kind === 'incomplete-profile'
        ? 'Selected profile needs setup.'
        : status.kind === 'profile-unavailable-model-active'
          ? `Selected profile is unavailable. Using ${name} for now.`
        : status.kind === 'no-selection'
          ? 'No model selected.'
          : null;
  const warningCta = warning
    ? status.kind === 'incomplete-profile'
      ? 'Finish setup'
      : status.kind === 'profile-unavailable-model-active'
        ? 'Review profile'
        : 'Pick a model'
    : null;

  return {
    ...baseAssignment,
    primary,
    status,
    display: {
      modelLabel: name,
      providerLabel: status.kind === 'ok' ? 'Anthropic' : '',
      billingSource: status.kind === 'ok' ? 'pay-per-use' : null,
    },
    effectiveModelId: primary.kind === 'model' ? primary.modelId : null,
    warning,
    warningCta,
    ...overrides,
  };
}

const meta = {
  title: 'Settings/Models/RoleRow',
  component: RoleRow,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Unified role row for model selection, fallback, and inline status.',
      },
    },
  },
  args: {
    role: 'working',
    label: 'Main work',
    tooltip: 'The main AI model Rebel uses for conversations.',
    htmlFor: 'storybook-working-model',
    assignment: baseAssignment,
    onChangePrimary: () => {},
    onChangeFallback: () => {},
    onStatusCtaClick: () => {},
    catalogModels,
    fallbackCatalogModels: catalogModels,
    profiles,
    settings,
    codexConnected: false,
    activeProvider: 'anthropic',
  },
} satisfies Meta<typeof RoleRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OkProfile: Story = {};

export const OkModel: Story = {
  args: {
    assignment: assignmentFor('Claude Opus 4.7', { kind: 'model', modelId: 'claude-opus-4-7' }, { kind: 'ok', source: 'model' }),
  },
};

export const UncataloguedInlineTest: Story = {
  args: {
    assignment: {
      ...assignmentFor('future-private-model', { kind: 'model', modelId: 'future-private-model' }, { kind: 'ok', source: 'model' }),
      isUncatalogued: true,
    },
    onInlineTest: () => {},
  },
};

export const UncataloguedTestFailed: Story = {
  args: {
    assignment: {
      ...assignmentFor('future-private-model', { kind: 'model', modelId: 'future-private-model' }, { kind: 'ok', source: 'model' }),
      isUncatalogued: true,
    },
    onInlineTest: () => {},
    inlineTestState: {
      testing: false,
      result: {
        success: false,
        error: "That model didn't answer the tiny test prompt. Rude, but useful to know.",
      },
    },
  },
};

export const HealthyNoExtraUi: Story = {
  args: {
    assignment: {
      ...assignmentFor('Claude Sonnet 4.6', { kind: 'model', modelId: 'claude-sonnet-4-6' }, { kind: 'ok', source: 'model' }),
      isUncatalogued: false,
    },
    inlineTestState: undefined,
  },
};

export const NoSelection: Story = {
  args: {
    assignment: assignmentFor('No model selected', { kind: 'off' }, { kind: 'no-selection' }),
  },
};

export const MissingProfile: Story = {
  args: {
    assignment: assignmentFor('Unknown profile', { kind: 'profile', profileId: 'missing-profile' }, { kind: 'missing-profile', profileId: 'missing-profile' }),
  },
};

export const SecondaryFallbackWarning: Story = {
  args: {
    secondaryFallback: {
      label: 'When conversations get long, fall back to:',
      picker: {
        role: 'recovery',
        value: { kind: 'profile', profileId: 'missing-recovery-profile' },
        htmlFor: 'storybook-long-context-fallback-model',
        catalogModels,
        profiles,
        offLabel: 'Off',
      },
      onChange: () => {},
      warning: 'Recovery fallback is unavailable. Pick another fallback for long conversations.',
      warningCta: 'Pick fallback',
      onWarningCtaClick: () => {},
    },
  },
};

export const IncompleteProfile: Story = {
  args: {
    assignment: assignmentFor('Needs Setup', { kind: 'profile', profileId: 'profile-incomplete' }, { kind: 'incomplete-profile', profileId: 'profile-incomplete' }),
  },
};

export const Auto: Story = {
  args: {
    role: 'recovery',
    label: 'Recovery model',
    htmlFor: 'storybook-recovery-model',
    assignment: {
      ...assignmentFor('Automatic', { kind: 'auto' }, { kind: 'auto' }),
      role: 'recovery',
      label: 'Recovery',
    },
  },
};

export const Off: Story = {
  args: {
    role: 'thinking',
    label: 'Planner',
    htmlFor: 'storybook-thinking-model',
    assignment: {
      ...assignmentFor('Off', { kind: 'off' }, { kind: 'off' }),
      role: 'thinking',
      label: 'Planner',
    },
  },
};

export const LightTheme: Story = {
  decorators: [
    (StoryComponent) => (
      <div className="light" style={{ background: 'var(--color-background)', color: 'var(--color-text)', padding: 16 }}>
        <StoryComponent />
      </div>
    ),
  ],
};

export const DarkTheme: Story = {
  decorators: [
    (StoryComponent) => (
      <div className="dark" style={{ background: 'var(--color-background)', color: 'var(--color-text)', padding: 16 }}>
        <StoryComponent />
      </div>
    ),
  ],
};
