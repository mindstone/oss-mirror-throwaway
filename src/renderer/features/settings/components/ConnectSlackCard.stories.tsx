import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, type ComponentProps, type ReactNode } from 'react';
import {
  ConfirmDisconnectSlackDialog,
  ConnectSlackCard,
  SlackLocalFallbackDisclosure,
  type ConnectSlackCardProps,
  type SlackLocalFallbackState,
} from './ConnectSlackCard';
import { ConfirmReplaceSlackDialog } from './ConfirmReplaceSlackDialog';
import { SlackByokSetupWizard } from './SlackByokSetupWizard';
import type {
  SlackCloudConnectionState,
  UseSlackCloudConnectionResult,
} from '../hooks/useSlackCloudConnection';

const meta = {
  title: 'Settings/Connect Slack Card',
  component: ConnectSlackCard,
  parameters: {
    layout: 'centered',
    controls: { disable: true },
  },
} satisfies Meta<typeof ConnectSlackCard>;

export default meta;
type Story = StoryObj<typeof meta>;

function state(
  status: SlackCloudConnectionState['status'],
  overrides: Partial<SlackCloudConnectionState> = {},
): SlackCloudConnectionState {
  return {
    status,
    workspace: status === 'connected' || status === 'disconnecting' || status === 'reconnect-needed'
      ? { teamId: 'T1', teamName: 'Acme Slack', lastSeenAt: '2026-05-03T11:58:00.000Z' }
      : null,
    error: status === 'setup-error'
      ? { code: 'OAUTH_FAILED', message: 'Slack said no. Unhelpful, but at least clear.' }
      : null,
    ...overrides,
  };
}

function connection(value: SlackCloudConnectionState): UseSlackCloudConnectionResult {
  return {
    status: value.status,
    workspace: value.workspace,
    error: value.error,
    connect: async () => undefined,
    connectByok: async () => undefined,
    cancel: () => undefined,
    disconnect: async () => undefined,
    retry: async () => undefined,
    refresh: async () => undefined,
  };
}

const fallbackOff: SlackLocalFallbackState = {
  enabled: false,
  onToggle: () => undefined,
};

const fallbackOn: SlackLocalFallbackState = {
  enabled: true,
  onToggle: () => undefined,
};

function ThemePair(args: ConnectSlackCardProps) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', width: 520, maxWidth: '100%' }}>
      <div className="light">
        <ConnectSlackCard {...args} />
      </div>
      <div className="dark">
        <ConnectSlackCard {...args} />
      </div>
    </div>
  );
}

function story(args: ConnectSlackCardProps): Story {
  return {
    render: () => <ThemePair {...args} />,
  };
}

function BodyTheme({ theme, children }: { theme: 'light' | 'dark'; children: ReactNode }) {
  useEffect(() => {
    document.body.classList.add(theme);
    return () => {
      document.body.classList.remove(theme);
    };
  }, [theme]);
  return <>{children}</>;
}

export const Checking = story({
  connection: connection(state('checking')),
  localFallback: fallbackOff,
  cloudStatus: 'running',
});

export const DisconnectedManaged = story({
  connection: connection(state('disconnected')),
  localFallback: fallbackOff,
  cloudStatus: 'running',
  provisionMode: 'managed',
});

export const ByokDisconnected = story({
  connection: connection(state('disconnected')),
  localFallback: fallbackOff,
  cloudStatus: 'running',
  provisionMode: 'byok',
  cloudBaseUrl: 'https://cloud.example.test',
});

export const Connecting = story({
  connection: connection(state('connecting')),
  localFallback: fallbackOff,
  cloudStatus: 'running',
});

export const ConnectedWithLastActivity = story({
  connection: connection(state('connected')),
  localFallback: fallbackOff,
  cloudStatus: 'running',
});

export const ByokConnected = story({
  connection: connection(state('connected')),
  localFallback: fallbackOff,
  cloudStatus: 'running',
  provisionMode: 'byok',
  cloudBaseUrl: 'https://cloud.example.test',
});

export const ConnectedNoActivityYet = story({
  connection: connection(state('connected', {
    workspace: { teamId: 'T1', teamName: 'Acme Slack', lastSeenAt: null },
  })),
  localFallback: fallbackOff,
  cloudStatus: 'running',
});

export const Disconnecting = story({
  connection: connection(state('disconnecting')),
  localFallback: fallbackOff,
  cloudStatus: 'running',
});

export const ReconnectNeeded = story({
  connection: connection(state('reconnect-needed')),
  localFallback: fallbackOff,
  cloudStatus: 'running',
});

function setupErrorStory(code: string, message: string): Story {
  return story({
    connection: connection(state('setup-error', { error: { code, message } })),
    localFallback: fallbackOff,
    cloudStatus: 'running',
    cloudBaseUrl: 'https://cloud.example.test',
  });
}

export const SetupErrorOauthFailed = setupErrorStory('OAUTH_FAILED', 'Slack setup failed before the handshake completed.');
export const SetupErrorOauthTimeout = setupErrorStory('OAUTH_TIMEOUT', 'The browser setup did not finish.');
export const SetupErrorNetworkUnreachable = setupErrorStory('NETWORK_UNREACHABLE', 'The cloud could not be reached.');
export const SetupErrorRateLimited = setupErrorStory('RATE_LIMITED', 'Slack setup is temporarily rate-limited.');
export const SetupErrorScopeMismatch = setupErrorStory('SCOPE_MISMATCH', 'Slack did not grant the permissions Rebel needs.');

export const LongWorkspaceNameTruncation = story({
  connection: connection(state('connected', {
    workspace: {
      teamId: 'T1',
      teamName: 'The Acme International Department of Lengthy Workspace Names and Related Committees',
      lastSeenAt: '2026-05-03T11:58:00.000Z',
    },
  })),
  localFallback: fallbackOff,
  cloudStatus: 'running',
});

export const LongErrorMessage = story({
  connection: connection(state('setup-error', {
    error: {
      code: 'OAUTH_FAILED',
      message: 'Slack setup failed after a long and deeply unglamorous sequence of redirects, retries, and one final refusal from the relay.',
    },
  })),
  localFallback: fallbackOff,
  cloudStatus: 'running',
});

export const MissingWorkspaceMetadata = story({
  connection: connection(state('connected', { workspace: null })),
  localFallback: fallbackOff,
  cloudStatus: 'running',
});

export const LocalFallbackDisclosureCollapsed: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--space-4)', width: 520, maxWidth: '100%' }}>
      <div className="light">
        <SlackLocalFallbackDisclosure
          fallback={fallbackOff}
          expandedByDefault={false}
        />
      </div>
      <div className="dark">
        <SlackLocalFallbackDisclosure
          fallback={fallbackOff}
          expandedByDefault={false}
        />
      </div>
    </div>
  ),
};

export const LocalFallbackDisclosureExpandedToggleOn: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--space-4)', width: 520, maxWidth: '100%' }}>
      <div className="light">
        <SlackLocalFallbackDisclosure
          fallback={fallbackOn}
          expandedByDefault
        />
      </div>
      <div className="dark">
        <SlackLocalFallbackDisclosure
          fallback={fallbackOn}
          expandedByDefault
        />
      </div>
    </div>
  ),
};

export const ConfirmDisconnectSlackDialogOpen: Story = {
  render: () => (
    <BodyTheme theme="light">
      <ConfirmDisconnectSlackDialog
        open
        onOpenChange={() => undefined}
        onConfirm={() => undefined}
      />
    </BodyTheme>
  ),
};

function WizardThemePair(props: Omit<ComponentProps<typeof SlackByokSetupWizard>, 'open' | 'onOpenChange' | 'connectByok' | 'cloudBaseUrl'>): Story {
  return {
    render: () => (
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <div className="light">
          <SlackByokSetupWizard
            open
            onOpenChange={() => undefined}
            cloudBaseUrl="https://cloud.example.test"
            connectByok={async () => undefined}
            {...props}
          />
        </div>
        <div className="dark">
          <SlackByokSetupWizard
            open
            onOpenChange={() => undefined}
            cloudBaseUrl="https://cloud.example.test"
            connectByok={async () => undefined}
            {...props}
          />
        </div>
      </div>
    ),
  };
}

export const SlackByokSetupWizardStep1 = WizardThemePair({ initialStep: 1 });
export const SlackByokSetupWizardStep2 = WizardThemePair({ initialStep: 2, initialAppReference: 'A1234567890' });
export const SlackByokSetupWizardStep3 = WizardThemePair({
  initialStep: 3,
  initialAppReference: 'A1234567890',
  initialCredentials: { clientId: '123.456', clientSecret: 'client-secret', signingSecret: 'signing-secret' },
});
export const SlackByokSetupWizardStep4Events = WizardThemePair({
  initialStep: 4,
  initialAppReference: 'A1234567890',
  initialCredentials: { clientId: '123.456', clientSecret: 'client-secret', signingSecret: 'signing-secret' },
});
export const SlackByokSetupWizardStep5Ready = WizardThemePair({
  initialStep: 5,
  initialAppReference: 'A1234567890',
  initialCredentials: { clientId: '123.456', clientSecret: 'client-secret', signingSecret: 'signing-secret' },
  initialCopyClicked: { redirect: true, botScopes: true, userScopes: true, eventUrl: true, eventNames: true },
});
export const SlackByokSetupWizardValidationErrors = WizardThemePair({
  initialStep: 2,
  initialAppReference: 'A1234567890',
  initialCredentials: { clientId: 'not-right', clientSecret: '', signingSecret: '' },
  showValidationOnMount: true,
});

export const ConfirmReplaceSlackDialogOpen: Story = {
  render: () => (
    <BodyTheme theme="light">
      <ConfirmReplaceSlackDialog
        open
        slackName="Acme Slack"
        onOpenChange={() => undefined}
        onConfirm={() => undefined}
      />
    </BodyTheme>
  ),
};

export const ConfirmReplaceSlackDialogLight: Story = ConfirmReplaceSlackDialogOpen;

export const ConfirmReplaceSlackDialogDark: Story = {
  render: () => (
    <BodyTheme theme="dark">
      <ConfirmReplaceSlackDialog
        open
        slackName="Acme Slack"
        onOpenChange={() => undefined}
        onConfirm={() => undefined}
      />
    </BodyTheme>
  ),
};
