import { useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { Button, Card, CardContent, CardFooter, CardHeader, CardTitle, Notice } from '@renderer/components/ui';
import { tracking } from '@renderer/src/tracking';
import { useConnectSlackMcpAction } from '../../hooks/useConnectSlackMcpAction';
import { useConnectorSetupGuidance } from '../../hooks/useConnectorSetupGuidance';
import { ConnectorSetupDialog } from '../ConnectorSetupDialog';

const SLACK_REPLIES_HELP_HREF = 'rebel://library/rebel-system%2Fhelp-for-humans%2Ftalking-to-rebel-from-slack.md';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Slack connection failed. Try again.';
}

export function MessagingConnectSlackCTA() {
  const { connect, isInFlight } = useConnectSlackMcpAction();
  const setupGuidanceDialog = useConnectorSetupGuidance();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleConnectClick = async () => {
    setErrorMessage(null);
    tracking.settings.messagingPanelConnectCtaClicked();
    try {
      // Route a not-configured `setupGuidance` result to the shared ConnectorSetupDialog so a
      // broken-by-default Slack connector opens the setup dialog instead of dropping the guidance.
      await connect({ onSetupGuidance: setupGuidanceDialog.handleResult });
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  return (
    <>
    <Card variant="outlined" data-testid="messaging-connect-slack-cta">
      <CardHeader>
        <CardTitle>Connect Slack first</CardTitle>
      </CardHeader>
      <CardContent>
        <p style={{ margin: 0 }}>
          Rebel needs the Slack connector before it can listen for @mentions and reply in the thread.
        </p>
        <p style={{ margin: 'var(--space-2) 0 0', color: 'var(--color-text-secondary)' }}>
          Manage or disconnect Slack later in Connectors.
        </p>
      </CardContent>
      <CardFooter>
        <Button
          type="button"
          variant="default"
          onClick={() => void handleConnectClick()}
          disabled={isInFlight}
          aria-label={isInFlight ? 'Connecting to Slack…' : undefined}
        >
          {isInFlight ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
          {isInFlight ? 'Connecting…' : 'Connect Slack'}
        </Button>
        <a
          href={SLACK_REPLIES_HELP_HREF}
          style={{
            alignItems: 'center',
            color: 'var(--color-text-secondary)',
            display: 'inline-flex',
            gap: 'var(--space-1)',
            textDecoration: 'none',
          }}
        >
          How Slack replies work
          <ExternalLink size={12} aria-hidden="true" />
        </a>
      </CardFooter>
      {errorMessage ? (
        <div style={{ padding: '0 var(--space-6, 24px) var(--space-6, 24px)' }}>
          <Notice tone="error" role="alert" placement="inline" density="compact" title="Slack connection failed">
            {errorMessage}
          </Notice>
        </div>
      ) : null}
    </Card>
    <ConnectorSetupDialog
      guidance={setupGuidanceDialog.guidance}
      open={setupGuidanceDialog.isOpen}
      onOpenChange={setupGuidanceDialog.setOpen}
    />
    </>
  );
}
