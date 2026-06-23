import { useCallback, useEffect, useId, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ExternalLink,
  PlugZap,
  RefreshCw,
  Slack,
  Unplug,
} from 'lucide-react';
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  InlineToggle,
  Notice,
  Spinner,
} from '@renderer/components/ui';
import type { CloudInstanceConfig } from '@shared/types/settings';
import { useSettingsSafe } from '../SettingsProvider';
import {
  useSlackCloudConnection,
  type SlackCloudConnectionState,
  type UseSlackCloudConnectionResult,
} from '../hooks/useSlackCloudConnection';
import styles from './ConnectSlackCard.module.css';
import { ConfirmReplaceSlackDialog } from './ConfirmReplaceSlackDialog';
import { SlackByokSetupWizard } from './SlackByokSetupWizard';

const ADAPTER_ID = 'slack-mention';

type ProvisionMode = NonNullable<CloudInstanceConfig['provisionMode']>;

export interface SlackLocalFallbackState {
  enabled: boolean;
  loading?: boolean;
  onToggle: (enabled: boolean) => void | Promise<void>;
}

export interface ConnectSlackCardProps {
  connection?: UseSlackCloudConnectionResult;
  provisionMode?: ProvisionMode;
  cloudStatus?: CloudInstanceConfig['lastKnownStatus'] | null;
  cloudBaseUrl?: string | null;
  localFallback?: SlackLocalFallbackState;
}

const STATUS_LABEL: Record<SlackCloudConnectionState['status'], string> = {
  checking: 'Checking',
  disconnected: 'Disconnected',
  connecting: 'Connecting',
  connected: 'Connected',
  disconnecting: 'Disconnecting',
  'reconnect-needed': 'Reconnect needed',
  'setup-error': 'Setup error',
};

function isCloudReachable(status: CloudInstanceConfig['lastKnownStatus'] | null | undefined): boolean {
  return status === 'running' || status === 'warm';
}

export function formatRelativeTime(lastSeenAt: string | null): string {
  if (!lastSeenAt) return 'Ready for new mentions';
  const timestamp = Date.parse(lastSeenAt);
  if (!Number.isFinite(timestamp)) return 'Ready for new mentions';

  const diffSeconds = Math.round((timestamp - Date.now()) / 1_000);
  const absSeconds = Math.abs(diffSeconds);
  if (absSeconds < 45) return 'just now';

  const formatter = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
  if (absSeconds < 60 * 60) {
    return formatter.format(Math.round(diffSeconds / 60), 'minute');
  }
  if (absSeconds < 60 * 60 * 24) {
    return formatter.format(Math.round(diffSeconds / (60 * 60)), 'hour');
  }
  return formatter.format(Math.round(diffSeconds / (60 * 60 * 24)), 'day');
}

function useLocalSlackFallbackState(disabled: boolean): SlackLocalFallbackState {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (disabled) return undefined;
    let cancelled = false;
    const api = window.inboundTriggersApi;
    if (!api) {
      setLoading(false);
      return () => { cancelled = true; };
    }
    api.getAdapterState({ adapterId: ADAPTER_ID })
      .then((state) => {
        if (!cancelled) setEnabled(state?.enabled ?? false);
      })
      .catch((err) => {
        console.warn('Failed to read Slack local fallback state', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [disabled]);

  const onToggle = useCallback(async (nextEnabled: boolean) => {
    const api = window.inboundTriggersApi;
    if (!api) return;
    setEnabled(nextEnabled);
    try {
      await api.setAdapterEnabled({ adapterId: ADAPTER_ID, enabled: nextEnabled });
    } catch (err) {
      setEnabled(!nextEnabled);
      console.warn('Failed to toggle Slack local fallback', err);
    }
  }, []);

  return { enabled, loading, onToggle };
}

export function ConnectSlackCard(props: ConnectSlackCardProps = {}) {
  if (props.connection) {
    return <ConnectSlackCardView {...props} connection={props.connection} />;
  }
  return <ConnectSlackCardWithHook {...props} />;
}

function ConnectSlackCardWithHook(props: Omit<ConnectSlackCardProps, 'connection'>) {
  const connection = useSlackCloudConnection();
  return <ConnectSlackCardView {...props} connection={connection} />;
}

export function ConnectSlackCardView({
  connection,
  provisionMode,
  cloudStatus,
  cloudBaseUrl,
  localFallback,
}: ConnectSlackCardProps & { connection: UseSlackCloudConnectionResult }) {
  const settingsContext = useSettingsSafe();
  const fallbackState = useLocalSlackFallbackState(Boolean(localFallback));
  const effectiveProvisionMode = provisionMode ?? settingsContext?.settings?.cloudInstance?.provisionMode ?? 'managed';
  const effectiveCloudStatus = cloudStatus ?? settingsContext?.settings?.cloudInstance?.lastKnownStatus ?? null;
  const effectiveCloudBaseUrl = cloudBaseUrl ?? settingsContext?.settings?.cloudInstance?.cloudUrl ?? 'not configured';
  const effectiveFallback = localFallback ?? fallbackState;
  const [disconnectDialogOpen, setDisconnectDialogOpen] = useState(false);
  const [replaceDialogOpen, setReplaceDialogOpen] = useState(false);
  const [byokWizardOpen, setByokWizardOpen] = useState(false);
  const [, setRelativeTimeTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setRelativeTimeTick((tick) => tick + 1), 60_000);
    const onFocus = () => {
      setRelativeTimeTick((tick) => tick + 1);
      void connection.refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [connection]);

  const connectionState: SlackCloudConnectionState = {
    status: connection.status,
    workspace: connection.workspace,
    error: connection.error,
  };
  const connectedMeta = connection.workspace
    ? `${connection.workspace.teamName} · ${formatRelativeTime(connection.workspace.lastSeenAt)}`
    : 'Ready for new mentions';
  const showFallback = !isCloudReachable(effectiveCloudStatus) || effectiveFallback.enabled;
  const showDuplicateWarning = isCloudReachable(effectiveCloudStatus)
    && effectiveFallback.enabled
    && connection.status === 'connected';

  return (
    <section className={styles.card} aria-label="Slack connection">
      <SlackCardHeader status={connection.status} />
      <SlackStatusBody
        state={connectionState}
        connectedMeta={connectedMeta}
        cloudBaseUrl={effectiveCloudBaseUrl}
        isByok={effectiveProvisionMode !== 'managed'}
      />
      <SlackCardActions
        state={connectionState}
        provisionMode={effectiveProvisionMode}
        onConnect={() => {
          if (effectiveProvisionMode === 'managed') {
            void connection.connect();
            return;
          }
          setByokWizardOpen(true);
        }}
        onCancel={connection.cancel}
        onDisconnectClick={() => setDisconnectDialogOpen(true)}
        onReplaceClick={() => setReplaceDialogOpen(true)}
        showReplace={effectiveProvisionMode !== 'managed'}
      />
      {showDuplicateWarning && (
        <p className={styles.duplicateWarning}>
          <Circle size={10} aria-hidden="true" />
          Both Slack paths active. Disable the fallback to avoid duplicate replies.
        </p>
      )}
      {showFallback && (
        <SlackLocalFallbackDisclosure
          fallback={effectiveFallback}
          expandedByDefault={false}
        />
      )}
      <ConfirmDisconnectSlackDialog
        open={disconnectDialogOpen}
        onOpenChange={setDisconnectDialogOpen}
        onConfirm={() => {
          setDisconnectDialogOpen(false);
          void connection.disconnect();
        }}
      />
      <ConfirmReplaceSlackDialog
        open={replaceDialogOpen}
        slackName={connection.workspace?.teamName ?? 'Slack'}
        onOpenChange={setReplaceDialogOpen}
        onConfirm={() => {
          setReplaceDialogOpen(false);
          void (async () => {
            await connection.disconnect();
            if (effectiveProvisionMode === 'managed') {
              await connection.connect();
            } else {
              setByokWizardOpen(true);
            }
          })();
        }}
      />
      <SlackByokSetupWizard
        open={byokWizardOpen}
        onOpenChange={setByokWizardOpen}
        cloudBaseUrl={effectiveCloudBaseUrl}
        connectByok={connection.connectByok}
      />
    </section>
  );
}

function SlackCardHeader({ status }: { status: SlackCloudConnectionState['status'] }) {
  const variant = status === 'connected'
    ? 'success'
    : status === 'setup-error'
      ? 'destructive'
      : status === 'reconnect-needed'
        ? 'warning'
        : status === 'checking' || status === 'connecting' || status === 'disconnecting'
          ? 'info'
          : 'muted';
  return (
    <div className={styles.header}>
      <div className={styles.headerTitle}>
        <Slack size={18} aria-hidden="true" />
        <span>Respond in Slack when mentioned</span>
      </div>
      <Badge variant={variant} size="sm">{STATUS_LABEL[status]}</Badge>
    </div>
  );
}

function SlackStatusBody({
  state,
  connectedMeta,
  cloudBaseUrl,
  isByok,
}: {
  state: SlackCloudConnectionState;
  connectedMeta: string;
  cloudBaseUrl: string;
  isByok: boolean;
}) {
  if (state.status === 'checking') {
    return (
      <div className={styles.body} role="status" aria-live="polite">
        <h3 className={styles.heading}><Spinner size="sm" /> Checking Slack connection…</h3>
      </div>
    );
  }

  if (state.status === 'connecting') {
    return (
      <div className={styles.body} role="status" aria-live="polite">
        <h3 className={styles.heading}>Authorising in your browser...</h3>
        <p className={styles.description}>Finish in the Slack tab that just opened. We&apos;ll wait.</p>
      </div>
    );
  }

  if (state.status === 'connected') {
    return (
      <div className={styles.body} role="status" aria-live="polite">
        <h3 className={styles.heading}><CheckCircle2 size={18} aria-hidden="true" /> Slack connected</h3>
        <p className={styles.metadata}>{connectedMeta}</p>
        {state.error && (
          <Notice tone="error" role="alert" placement="inline" density="compact" title="Slack hit a snag">
            {state.error.message}
          </Notice>
        )}
      </div>
    );
  }

  if (state.status === 'disconnecting') {
    return (
      <div className={styles.body} role="status" aria-live="polite">
        <h3 className={styles.heading}><Spinner size="sm" /> Slack connected</h3>
        <p className={styles.description}>Disconnecting Slack...</p>
      </div>
    );
  }

  if (state.status === 'reconnect-needed') {
    return (
      <div className={styles.body} role="status" aria-live="polite">
        <h3 className={styles.heading}><RefreshCw size={18} aria-hidden="true" /> Slack needs reconnecting</h3>
        <SlackReconnectNotice />
      </div>
    );
  }

  if (state.status === 'setup-error') {
    return (
      <div className={styles.body} role="status" aria-live="polite">
        <h3 className={styles.heading}><AlertCircle size={18} aria-hidden="true" /> Couldn&apos;t connect Slack</h3>
        <Notice tone="error" role="alert" placement="inline">
          The setup did not finish. Try again, or open the details if you want the unglamorous version.
        </Notice>
        <SlackErrorDetailsDisclosure error={state.error} cloudBaseUrl={cloudBaseUrl} />
      </div>
    );
  }

  return (
    <div className={styles.body} role="status" aria-live="polite">
      <h3 className={styles.heading}>{isByok ? 'Set up your Slack connection' : 'Connect Slack'}</h3>
      <p className={styles.description}>
        {isByok
          ? 'Create your own Slack connection for this cloud. Setup takes about 5 minutes.'
          : 'Mention Rebel in a Slack thread and get a real reply, in the thread. Setup takes about a minute.'}
      </p>
      <p className={styles.trustLine}>Only when mentioned. Disconnect anytime.</p>
    </div>
  );
}

function SlackReconnectNotice() {
  return (
    <Notice tone="warning" placement="inline">
      Slack stopped sharing new mentions with Rebel. Reconnect and we&apos;ll get back to threads.
    </Notice>
  );
}

function SlackCardActions({
  state,
  provisionMode,
  onConnect,
  onCancel,
  onDisconnectClick,
  onReplaceClick,
  showReplace,
}: {
  state: SlackCloudConnectionState;
  provisionMode: ProvisionMode;
  onConnect: () => void;
  onCancel: () => void;
  onDisconnectClick: () => void;
  onReplaceClick: () => void;
  showReplace: boolean;
}) {
  if (state.status === 'checking' || state.status === 'disconnecting') {
    return null;
  }
  if (state.status === 'connecting') {
    return (
      <div className={styles.actions}>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    );
  }
  if (state.status === 'connected') {
    return (
      <div className={styles.actions}>
        {showReplace ? (
          <Button type="button" variant="ghost" size="sm" onClick={onReplaceClick} aria-haspopup="dialog">
            Replace
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={onDisconnectClick} aria-haspopup="dialog">
          <Unplug size={14} aria-hidden="true" />
          Disconnect
        </Button>
      </div>
    );
  }
  if (state.status === 'reconnect-needed') {
    return (
      <div className={styles.actions}>
        <Button type="button" variant="default" onClick={onConnect}>
          <RefreshCw size={14} aria-hidden="true" />
          Reconnect Slack
        </Button>
      </div>
    );
  }
  if (state.status === 'setup-error') {
    return (
      <div className={styles.actions}>
        <Button type="button" variant="default" onClick={onConnect}>
          <ExternalLink size={14} aria-hidden="true" />
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div className={styles.actions}>
      <Button type="button" variant="default" onClick={onConnect}>
        <PlugZap size={14} aria-hidden="true" />
        {provisionMode === 'managed' ? 'Connect Slack' : 'Get started'}
      </Button>
    </div>
  );
}

function supportMessageForError(error: SlackCloudConnectionState['error']): string {
  switch (error?.code) {
    case 'OAUTH_TIMEOUT':
      return 'The browser setup did not finish.';
    case 'NETWORK_UNREACHABLE':
      return 'The cloud could not be reached.';
    case 'RATE_LIMITED':
      return 'Slack setup is temporarily rate-limited.';
    case 'SCOPE_MISMATCH':
      return 'Slack did not grant the permissions Rebel needs.';
    case 'OAUTH_FAILED':
    default:
      return error?.message ?? 'Slack setup did not finish.';
  }
}

function redactSupportText(value: string): string {
  const secretKeys = 'client_secret|signing_secret|bot_token|oauth_code|refresh_token|clientSecret|signingSecret|botToken|oauthCode|refreshToken';
  return value
    .replace(new RegExp(`(^|[{,]\\s*)(["']?)(${secretKeys})\\2\\s*:\\s*(["'])(.*?)\\4`, 'gim'), '$1$2$3$2: "[redacted-$3]"')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]+\b/g, '[redacted-token]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/g, 'Bearer [redacted]')
    .replace(new RegExp(`\\b(${secretKeys}|code)=([^\\s&]+)`, 'gi'), '$1=[redacted-$1]')
    .replace(/([?&]code=)[^&\s]+/gi, '$1[redacted-oauth-code]')
    .replace(/(?:\{[\s\S]{3000,}\}|\[[\s\S]{3000,}\])/g, (match) => `[redacted-payload-${match.length} chars]`);
}

function SlackErrorDetailsDisclosure({
  error,
  cloudBaseUrl,
}: {
  error: SlackCloudConnectionState['error'];
  cloudBaseUrl: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const disclosureBodyId = useId();
  const details = supportMessageForError(error);
  const copyDetails = useCallback(async () => {
    const blob = redactSupportText([
      'Slack setup error',
      `Code: ${error?.code ?? 'UNKNOWN'}`,
      `Message: ${details}`,
      `Time: ${new Date().toISOString()}`,
      `Cloud base: ${cloudBaseUrl}`,
      'Provision mode: managed',
    ].join('\n'));
    await navigator.clipboard.writeText(blob);
  }, [cloudBaseUrl, details, error?.code]);

  return (
    <div className={styles.disclosure}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={styles.disclosureToggle}
        aria-controls={disclosureBodyId}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        What happened?
      </Button>
      {expanded && (
        <div id={disclosureBodyId} className={styles.disclosureBody}>
          <p>{details}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void copyDetails()}>
            Copy details to share with support
          </Button>
        </div>
      )}
    </div>
  );
}

export function SlackLocalFallbackDisclosure({
  fallback,
  expandedByDefault,
}: {
  fallback: SlackLocalFallbackState;
  expandedByDefault: boolean;
}) {
  const [expanded, setExpanded] = useState(expandedByDefault);
  const disclosureBodyId = useId();
  return (
    <div className={styles.localFallback}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={styles.disclosureToggle}
        aria-controls={disclosureBodyId}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        Advanced - run from this computer instead
      </Button>
      {expanded && (
        <div id={disclosureBodyId} className={styles.disclosureBody}>
          <p>Slower, but useful if your Rebel cloud is not available.</p>
          <InlineToggle
            checked={fallback.enabled}
            disabled={fallback.loading}
            onCheckedChange={(checked) => void fallback.onToggle(checked)}
            label="Respond from this computer"
          />
        </div>
      )}
    </div>
  );
}

export function ConfirmDisconnectSlackDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader onClose={() => onOpenChange(false)}>
          <DialogTitle>Disconnect Slack?</DialogTitle>
          <DialogDescription>
            Rebel will stop replying to new Slack mentions until you connect Slack again.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p className={styles.dialogBody}>Existing conversations stay put. New thread replies pause. Dramatic, but manageable.</p>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>Disconnect</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
