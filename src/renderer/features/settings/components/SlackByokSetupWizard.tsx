import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Notice,
  Textarea,
} from '@renderer/components/ui';
import { useAppNavigationSafe } from '@renderer/hooks/useAppNavigation';
import { SLACK_BOT_SCOPES, SLACK_USER_SCOPES } from '@shared/utils/slackOAuthScopes';
import type { SlackConnectError } from '../hooks/useSlackCloudConnection';
import styles from './SlackByokSetupWizard.module.css';

export interface SlackByokCredentialsInput {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
}

type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;
type CopyKey = 'redirect' | 'botScopes' | 'userScopes' | 'eventUrl' | 'eventNames';

interface WizardState extends SlackByokCredentialsInput {
  step: WizardStep;
  appReference: string;
  copyClicked: Record<CopyKey, boolean>;
}

export interface SlackByokSetupWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cloudBaseUrl: string;
  connectByok: (creds: SlackByokCredentialsInput) => Promise<void>;
  initialStep?: WizardStep;
  initialAppReference?: string;
  initialCredentials?: Partial<SlackByokCredentialsInput>;
  initialCopyClicked?: Partial<WizardState['copyClicked']>;
  showValidationOnMount?: boolean;
}

const SCOPE_HELP: Array<{ scope: string; purpose: string }> = [
  { scope: 'channels:history / groups:history / im:history / mpim:history', purpose: 'Read the thread Rebel was mentioned in.' },
  { scope: 'channels:read / groups:read / im:read / mpim:read', purpose: 'Identify the Slack place that sent the mention.' },
  { scope: 'chat:write', purpose: 'Reply in the thread.' },
  { scope: 'users:read / users:read.email', purpose: 'Resolve who mentioned Rebel.' },
  { scope: 'files:read, reactions:*, reminders:write, bookmarks:write', purpose: 'Match the desktop Slack connection permissions.' },
];

const STEP_TITLE: Record<WizardStep, string> = {
  1: 'Create a Slack app',
  2: 'Paste app credentials',
  3: 'Add the redirect URL and permissions',
  4: 'Allow people to message Rebel directly',
  5: 'Turn on Slack events',
  6: 'Authorise Slack',
};

const SIDEBAR_PATH = 'Basic Information → OAuth & Permissions → App Home → Event Subscriptions → Authorise';
const STEP_DESCRIPTION = 'Move down Slack\'s left sidebar once: Basic Information, OAuth & Permissions, App Home, Event Subscriptions, then authorise. Slack named the pages; we\'re just surviving them.';
const REQUIRED_EVENT_NAMES = [
  'app_mention',
  'message.channels',
  'message.groups',
  'message.im',
  'message.mpim',
  'tokens_revoked',
] as const;
const APP_ID_REGEX = /^A[A-Za-z0-9]{8,12}$/;
const APP_ID_URL_REGEX = /^https:\/\/api\.slack\.com\/apps\/(A[A-Za-z0-9]{8,12})(?:[/?#].*)?$/;

function initialState(props: SlackByokSetupWizardProps): WizardState {
  return {
    step: props.initialStep ?? 1,
    appReference: props.initialAppReference ?? '',
    clientId: props.initialCredentials?.clientId ?? '',
    clientSecret: props.initialCredentials?.clientSecret ?? '',
    signingSecret: props.initialCredentials?.signingSecret ?? '',
    copyClicked: {
      redirect: props.initialCopyClicked?.redirect ?? false,
      botScopes: props.initialCopyClicked?.botScopes ?? false,
      userScopes: props.initialCopyClicked?.userScopes ?? false,
      eventUrl: props.initialCopyClicked?.eventUrl ?? false,
      eventNames: props.initialCopyClicked?.eventNames ?? false,
    },
  };
}

function normalizeCloudBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function validateClientId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Required';
  if (!/^\d+\.\d+$/.test(trimmed)) return 'Client ID looks like 12345.67890';
  return null;
}

function validateSecret(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Required';
  if (trimmed.length < 10) return 'Looks too short to be valid';
  return null;
}

function parseSlackAppId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (APP_ID_REGEX.test(trimmed)) return trimmed;
  const urlMatch = trimmed.match(APP_ID_URL_REGEX);
  return urlMatch ? urlMatch[1] : null;
}

function appReferenceError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Paste the Slack app page URL or App ID so Rebel can open the right Slack pages.';
  }
  if (parseSlackAppId(trimmed)) return null;
  return 'That doesn\'t look like a Slack app URL or App ID. It usually starts with "A".';
}

function slackConnectErrorFromUnknown(err: unknown): SlackConnectError {
  if (err && typeof err === 'object') {
    const { code, message, field, retryAfterSeconds } = err as {
      code?: unknown;
      message?: unknown;
      field?: unknown;
      retryAfterSeconds?: unknown;
    };
    if (typeof code === 'string' && typeof message === 'string') {
      return {
        code,
        message,
        field: field === 'clientId' || field === 'clientSecret' || field === 'signingSecret' ? field : undefined,
        retryAfterSeconds: typeof retryAfterSeconds === 'number' ? retryAfterSeconds : undefined,
      };
    }
    if ((field === 'clientId' || field === 'clientSecret' || field === 'signingSecret') && typeof message === 'string') {
      return { code: 'INVALID_FIELD', field, message };
    }
  }

  return {
    code: 'OAUTH_FAILED',
    message: err instanceof Error ? err.message : 'Slack setup did not finish.',
  };
}

function copySuccessMessage(key: CopyKey | null): string | null {
  switch (key) {
    case 'redirect':
      return 'Redirect URL copied.';
    case 'botScopes':
      return 'Bot scopes copied.';
    case 'userScopes':
      return 'User scopes copied.';
    case 'eventUrl':
      return 'Event URL copied.';
    case 'eventNames':
      return 'Event names copied. Slack still makes you add them one at a time. Naturally.';
    default:
      return null;
  }
}

export function SlackByokSetupWizard(props: SlackByokSetupWizardProps) {
  const navigation = useAppNavigationSafe();
  const [state, setState] = useState<WizardState>(() => initialState(props));
  const [showValidation, setShowValidation] = useState(Boolean(props.showValidationOnMount));
  const [showStep1Validation, setShowStep1Validation] = useState(Boolean(props.showValidationOnMount));
  const [submitting, setSubmitting] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<CopyKey | null>(null);
  const [connectError, setConnectError] = useState<SlackConnectError | null>(null);
  const [serverFieldError, setServerFieldError] = useState<{ field: keyof SlackByokCredentialsInput; message: string } | null>(null);
  const [showScopeHelp, setShowScopeHelp] = useState(false);
  const [focusedSecret, setFocusedSecret] = useState<'clientSecret' | 'signingSecret' | null>(null);

  const titleId = useId();
  const appReferenceInputId = useId();
  const appReferenceErrorId = useId();
  const clientIdInputId = useId();
  const clientSecretInputId = useId();
  const signingSecretInputId = useId();
  const clientIdErrorId = useId();
  const clientSecretErrorId = useId();
  const signingSecretErrorId = useId();

  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const appReferenceRef = useRef<HTMLInputElement | null>(null);
  const clientIdRef = useRef<HTMLInputElement | null>(null);

  const normalizedCloudBaseUrl = normalizeCloudBaseUrl(props.cloudBaseUrl);
  const redirectUrl = `${normalizedCloudBaseUrl}/api/integrations/slack/oauth/callback`;
  const eventUrl = `${normalizedCloudBaseUrl}/api/integrations/slack/events`;
  const botScopeText = SLACK_BOT_SCOPES.join('\n');
  const userScopeText = SLACK_USER_SCOPES.join('\n');
  const eventNamesText = REQUIRED_EVENT_NAMES.join('\n');
  const parsedAppId = useMemo(() => parseSlackAppId(state.appReference), [state.appReference]);
  const basicInformationUrl = parsedAppId ? `https://api.slack.com/apps/${parsedAppId}/general` : 'https://api.slack.com/apps';
  const oauthPermissionsUrl = parsedAppId ? `https://api.slack.com/apps/${parsedAppId}/oauth` : 'https://api.slack.com/apps';
  const appHomeUrl = parsedAppId ? `https://api.slack.com/apps/${parsedAppId}/app-home` : 'https://api.slack.com/apps';
  const eventSubscriptionsUrl = parsedAppId ? `https://api.slack.com/apps/${parsedAppId}/event-subscriptions` : 'https://api.slack.com/apps';

  const step1Error = showStep1Validation ? appReferenceError(state.appReference) : null;
  const step1Success = state.appReference.trim().length > 0 && !step1Error && parsedAppId;

  const clientIdError = validateClientId(state.clientId);
  const clientSecretError = validateSecret(state.clientSecret);
  const signingSecretError = validateSecret(state.signingSecret);
  const credentialsValid = !clientIdError && !clientSecretError && !signingSecretError;
  const credentialsReady = credentialsValid && !serverFieldError;
  const fieldErrors = useMemo(() => ({
    clientId: serverFieldError?.field === 'clientId' ? serverFieldError.message : (showValidation ? clientIdError : null),
    clientSecret: serverFieldError?.field === 'clientSecret' ? serverFieldError.message : (showValidation ? clientSecretError : null),
    signingSecret: serverFieldError?.field === 'signingSecret' ? serverFieldError.message : (showValidation ? signingSecretError : null),
  }), [clientIdError, clientSecretError, serverFieldError, showValidation, signingSecretError]);
  const copySuccess = copySuccessMessage(copyFeedback);

  useEffect(() => {
    if (!props.open) return;
    setState(initialState(props));
    setShowValidation(Boolean(props.showValidationOnMount));
    setShowStep1Validation(Boolean(props.showValidationOnMount));
    setSubmitting(false);
    setCopyError(null);
    setCopyFeedback(null);
    setConnectError(null);
    setServerFieldError(null);
    setShowScopeHelp(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting props (entire object) and initialState; reset should fire only when the modal opens/closes (props.open transition), not when the parent re-renders with structurally-identical props
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const frame = window.requestAnimationFrame(() => {
      if (state.step === 1) {
        appReferenceRef.current?.focus();
        return;
      }
      if (state.step === 2) {
        clientIdRef.current?.focus();
        return;
      }
      titleRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [props.open, state.step]);

  const close = useCallback(() => {
    props.onOpenChange(false);
  }, [props]);

  const copyText = useCallback(async (text: string, key: CopyKey) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyError(null);
      setCopyFeedback(key);
      setState((current) => ({
        ...current,
        copyClicked: { ...current.copyClicked, [key]: true },
      }));
    } catch (err) {
      setCopyFeedback(null);
      setCopyError(err instanceof Error ? err.message : 'Clipboard copy failed.');
    }
  }, []);

  const updateField = useCallback((field: keyof SlackByokCredentialsInput, value: string) => {
    setState((current) => ({ ...current, [field]: value }));
    setServerFieldError((current) => (current?.field === field ? null : current));
    setConnectError((current) => {
      if (!current) return null;
      if (current.code === 'INVALID_FIELD' || current.code === 'OAUTH_FAILED') return null;
      return current;
    });
    if (field === 'clientId' || showValidation) setShowValidation(true);
  }, [showValidation]);

  const next = useCallback(() => {
    if (state.step === 1) {
      setShowStep1Validation(true);
      if (!parseSlackAppId(state.appReference)) {
        return;
      }
    }
    if (state.step === 2) {
      setShowValidation(true);
      if (!credentialsReady) {
        return;
      }
    }

    setCopyError(null);
    setCopyFeedback(null);
    setState((current) => ({ ...current, step: Math.min(current.step + 1, 6) as WizardStep }));
  }, [credentialsReady, state.appReference, state.step]);

  const back = useCallback(() => {
    if (submitting) return;
    setState((current) => ({ ...current, step: Math.max(current.step - 1, 1) as WizardStep }));
  }, [submitting]);

  const openCloudSettings = useCallback(() => {
    if (navigation) {
      void navigation.navigate({ type: 'settings', tab: 'cloud' });
    }
    props.onOpenChange(false);
  }, [navigation, props]);

  const connect = useCallback(async () => {
    setShowValidation(true);
    if (!credentialsReady) {
      setState((current) => ({ ...current, step: 2 }));
      return;
    }

    setSubmitting(true);
    setConnectError(null);
    setCopyError(null);

    try {
      await props.connectByok({
        clientId: state.clientId.trim(),
        clientSecret: state.clientSecret.trim(),
        signingSecret: state.signingSecret.trim(),
      });
      props.onOpenChange(false);
    } catch (err) {
      const error = slackConnectErrorFromUnknown(err);
      setConnectError(error);
      if (error.code === 'INVALID_FIELD') {
        if (error.field) {
          setServerFieldError({ field: error.field, message: error.message });
        }
        setState((current) => ({ ...current, step: 2 }));
      } else if (error.code === 'OAUTH_FAILED') {
        setState((current) => ({ ...current, step: 2 }));
      } else {
        setState((current) => ({ ...current, step: 6 }));
      }
    } finally {
      setSubmitting(false);
    }
  }, [credentialsReady, props, state.clientId, state.clientSecret, state.signingSecret]);

  const connectErrorNotice = (() => {
    if (!connectError) return null;

    if (connectError.code === 'NETWORK_UNREACHABLE') {
      return (
        <Notice
          tone="error"
          placement="inline"
          title="Couldn't reach Rebel Cloud"
          actions={[
            { label: 'Try again', onClick: () => void connect(), loading: submitting },
            { label: 'Open Cloud settings', onClick: openCloudSettings, variant: 'secondary' },
          ]}
        >
          <span className={styles.noticeBody}>
            {'Diagnostic code: NETWORK_UNREACHABLE\nCouldn\'t reach the Rebel cloud. Check your internet, then try again. If it keeps failing, open Settings → Cloud to verify your cloud connection.'}
          </span>
        </Notice>
      );
    }

    if (connectError.code === 'OAUTH_TIMEOUT') {
      return (
        <Notice
          tone="error"
          placement="inline"
          title="Slack did not finish authorising"
          actions={[{ label: 'Try authorising again', onClick: () => void connect(), loading: submitting }]}
        >
          <span className={styles.noticeBody}>
            {'Diagnostic code: OAUTH_TIMEOUT\nSlack didn\'t finish authorising in 5 minutes. Close the browser tab, then try again from Authorise Slack.'}
          </span>
        </Notice>
      );
    }

    if (connectError.code === 'INVALID_FIELD') {
      return (
        <Notice tone="error" placement="inline" title="Check the highlighted field">
          <span className={styles.noticeBody}>
            {'Diagnostic code: INVALID_FIELD\nSlack did not accept one of the app credentials. Fix the highlighted field, then continue.'}
          </span>
        </Notice>
      );
    }

    if (connectError.code === 'RATE_LIMITED') {
      return (
        <Notice
          tone="error"
          placement="inline"
          title="Slack needs a minute"
          actions={[{ label: 'Try again', onClick: () => void connect(), loading: submitting }]}
        >
          <span className={styles.noticeBody}>
            {'Diagnostic code: RATE_LIMITED\nSlack setup is temporarily rate-limited. Wait about a minute, then try again. Bureaucracy has entered the chat.'}
          </span>
        </Notice>
      );
    }

    return (
      <Notice
        tone="error"
        placement="inline"
        title="Slack rejected the setup"
        actions={[
          {
            label: 'Open Basic Information',
            onClick: () => {
              void window.appApi.openUrl(basicInformationUrl);
              setState((current) => ({ ...current, step: 2 }));
            },
          },
          {
            label: 'Review credentials',
            onClick: () => setState((current) => ({ ...current, step: 2 })),
            variant: 'secondary',
          },
        ]}
      >
        <span className={styles.noticeBody}>
          {'Diagnostic code: OAUTH_FAILED\nSlack rejected the setup. Double-check the Client ID, Client Secret, and Signing Secret in Slack\'s Basic Information page.'}
        </span>
      </Notice>
    );
  })();

  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!open) close(); }} ariaLabelledBy={titleId}>
      <DialogContent size="lg">
        <DialogHeader onClose={close}>
          <div className={styles.progress} aria-label={`Step ${state.step} of 6`}>
            <span>{state.step} of 6</span>
            <span className={styles.dots} aria-hidden="true">
              {[1, 2, 3, 4, 5, 6].map((step) => (
                <span key={step} className={`${styles.dot} ${step === state.step ? styles.dotActive : ''}`} />
              ))}
            </span>
          </div>
          <p className={styles.sidebarPath}>{SIDEBAR_PATH}</p>
          <DialogTitle id={titleId} ref={titleRef} tabIndex={-1}>{STEP_TITLE[state.step]}</DialogTitle>
          <DialogDescription>{STEP_DESCRIPTION}</DialogDescription>
        </DialogHeader>

        <DialogBody className={styles.body}>
          {connectError ? <div className={styles.noticeSlot}>{connectErrorNotice}</div> : null}

          {state.step === 1 ? (
            <>
              <p className={styles.muted}>
                First, make a Slack app in the workspace where Rebel should reply. In Slack&apos;s developer site, choose Create New App → From scratch, name it Rebel, then pick the workspace.
              </p>
              <p className={styles.muted}>
                After Slack opens the new app, copy the page URL from your browser — or the App ID from Basic Information — and paste it here. Rebel only uses this to open the right Slack pages during setup.
              </p>
              <Button type="button" variant="ghost" size="sm" className={styles.helpButton} onClick={() => void window.appApi.openUrl('https://api.slack.com/apps?new_app=1')}>
                Open Slack app creator
                <ExternalLink size={13} aria-hidden="true" />
              </Button>
              <div className={styles.fieldGroup}>
                <Label htmlFor={appReferenceInputId}>Slack app URL or App ID</Label>
                <Input
                  id={appReferenceInputId}
                  ref={appReferenceRef}
                  value={state.appReference}
                  onChange={(event) => setState((current) => ({ ...current, appReference: event.target.value }))}
                  onBlur={() => setShowStep1Validation(true)}
                  placeholder="https://api.slack.com/apps/A1234567890/general"
                  error={Boolean(step1Error)}
                  aria-describedby={step1Error ? appReferenceErrorId : undefined}
                />
                {step1Error ? <p id={appReferenceErrorId} className={styles.error}>{step1Error}</p> : null}
                {step1Success ? <p className={styles.success}>Got it. Future Slack links will open this app directly.</p> : null}
              </div>
            </>
          ) : null}

          {state.step === 2 ? (
            <>
              <p className={styles.findInSlack}>Find this in Slack</p>
              <p className={styles.muted}>
                You should be on Slack&apos;s Basic Information page. Find these in Basic Information → App Credentials.
              </p>
              <p className={styles.muted}>
                Copy these three values from Slack and paste them here. They all live on the same Slack page, mercifully.
              </p>
              <Button type="button" variant="ghost" size="sm" className={styles.helpButton} onClick={() => void window.appApi.openUrl(basicInformationUrl)}>
                Open Basic Information
                <ExternalLink size={13} aria-hidden="true" />
              </Button>
              <div className={styles.fieldGroup}>
                <Label htmlFor={clientIdInputId}>Client ID</Label>
                <Input
                  id={clientIdInputId}
                  ref={clientIdRef}
                  value={state.clientId}
                  onChange={(event) => updateField('clientId', event.target.value)}
                  onBlur={() => setShowValidation(true)}
                  error={Boolean(fieldErrors.clientId)}
                  aria-describedby={fieldErrors.clientId ? clientIdErrorId : undefined}
                />
                {fieldErrors.clientId ? <p id={clientIdErrorId} className={styles.error}>{fieldErrors.clientId}</p> : null}
              </div>
              <div className={styles.fieldGroup}>
                <Label htmlFor={clientSecretInputId}>Client Secret</Label>
                <Input
                  id={clientSecretInputId}
                  type={focusedSecret === 'clientSecret' ? 'text' : 'password'}
                  value={state.clientSecret}
                  onFocus={() => setFocusedSecret('clientSecret')}
                  onBlur={() => { setFocusedSecret(null); setShowValidation(true); }}
                  onChange={(event) => updateField('clientSecret', event.target.value)}
                  error={Boolean(fieldErrors.clientSecret)}
                  aria-describedby={fieldErrors.clientSecret ? clientSecretErrorId : undefined}
                />
                {fieldErrors.clientSecret ? <p id={clientSecretErrorId} className={styles.error}>{fieldErrors.clientSecret}</p> : null}
              </div>
              <div className={styles.fieldGroup}>
                <Label htmlFor={signingSecretInputId}>Signing Secret</Label>
                <Input
                  id={signingSecretInputId}
                  type={focusedSecret === 'signingSecret' ? 'text' : 'password'}
                  value={state.signingSecret}
                  onFocus={() => setFocusedSecret('signingSecret')}
                  onBlur={() => { setFocusedSecret(null); setShowValidation(true); }}
                  onChange={(event) => updateField('signingSecret', event.target.value)}
                  error={Boolean(fieldErrors.signingSecret)}
                  aria-describedby={fieldErrors.signingSecret ? signingSecretErrorId : undefined}
                />
                {fieldErrors.signingSecret ? <p id={signingSecretErrorId} className={styles.error}>{fieldErrors.signingSecret}</p> : null}
              </div>
              <p className={styles.muted}>Rebel sends these to your cloud when you connect. They are not saved in this app window.</p>
            </>
          ) : null}

          {state.step === 3 ? (
            <>
              <p className={styles.findInSlack}>Find this in Slack</p>
              <p className={styles.muted}>
                In Slack, open OAuth &amp; Permissions. Add the redirect URL first, then paste the bot and user scopes below. Same page. A rare administrative kindness.
              </p>
              <Button type="button" variant="ghost" size="sm" className={styles.helpButton} onClick={() => void window.appApi.openUrl(oauthPermissionsUrl)}>
                Open OAuth &amp; Permissions
                <ExternalLink size={13} aria-hidden="true" />
              </Button>
              <div className={styles.fieldGroup}>
                <Label htmlFor="slack-byok-redirect-url">Redirect URL</Label>
                <p className={styles.muted}>Find this in Slack under OAuth &amp; Permissions → Redirect URLs → Add New Redirect URL.</p>
                <div className={styles.copyRow}>
                  <Input id="slack-byok-redirect-url" className={styles.readonly} value={redirectUrl} readOnly />
                  <Button type="button" variant="outline" onClick={() => void copyText(redirectUrl, 'redirect')}>
                    <Copy size={14} aria-hidden="true" />
                    Copy redirect URL
                  </Button>
                </div>
              </div>
              <div className={styles.fieldGroup}>
                <Label htmlFor="slack-byok-bot-scopes">Bot Token Scopes</Label>
                <p className={styles.muted}>Add these under Scopes → Bot Token Scopes.</p>
                <div className={styles.copyRow}>
                  <Textarea id="slack-byok-bot-scopes" className={styles.textarea} value={botScopeText} readOnly />
                  <Button type="button" variant="outline" onClick={() => void copyText(botScopeText, 'botScopes')}>
                    <Copy size={14} aria-hidden="true" />
                    Copy bot scopes
                  </Button>
                </div>
              </div>
              <div className={styles.fieldGroup}>
                <Label htmlFor="slack-byok-user-scopes">User Token Scopes</Label>
                <p className={styles.muted}>Add these under Scopes → User Token Scopes. Slack keeps bot and user scopes separate, because apparently one list would have been too merciful.</p>
                <div className={styles.copyRow}>
                  <Textarea id="slack-byok-user-scopes" className={styles.textarea} value={userScopeText} readOnly />
                  <Button type="button" variant="outline" onClick={() => void copyText(userScopeText, 'userScopes')}>
                    <Copy size={14} aria-hidden="true" />
                    Copy user scopes
                  </Button>
                </div>
              </div>
              <Button type="button" variant="ghost" size="sm" className={styles.helpButton} onClick={() => setShowScopeHelp((value) => !value)}>
                What does each permission do?
              </Button>
              {showScopeHelp ? (
                <dl className={styles.details}>
                  {SCOPE_HELP.map((item) => (
                    <div key={item.scope} className={styles.detailsRow}>
                      <dt>{item.scope}</dt>
                      <dd>{item.purpose}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              <p className={styles.muted}>Click Save Changes in Slack before continuing.</p>
            </>
          ) : null}

          {state.step === 4 ? (
            <>
              <p className={styles.findInSlack}>Find this in Slack</p>
              <p className={styles.muted}>
                Open App Home in Slack. This is where you let people send Rebel direct messages. Without this, Slack hides the message box on Rebel&apos;s profile and DMs never arrive.
              </p>
              <Button type="button" variant="ghost" size="sm" className={styles.helpButton} onClick={() => void window.appApi.openUrl(appHomeUrl)}>
                Open App Home
                <ExternalLink size={13} aria-hidden="true" />
              </Button>
              <ol className={styles.steps}>
                <li>Scroll to <strong>Show Tabs</strong>.</li>
                <li>Tick <strong>Messages Tab</strong>.</li>
                <li>Tick <strong>Allow users to send Slash commands and messages from the messages tab</strong>.</li>
                <li>Click <strong>Save Changes</strong> at the bottom.</li>
              </ol>
              <Notice tone="info" placement="inline" title="Why this matters">
                Slack ships custom apps with DMs disabled by default. If you skip this, Rebel will appear in your Slack workspace but the DM input box will be greyed out and people will not be able to message it.
              </Notice>
            </>
          ) : null}

          {state.step === 5 ? (
            <>
              <p className={styles.findInSlack}>Find this in Slack</p>
              <p className={styles.muted}>
                This lets Slack tell Rebel when someone mentions it. No events, no thread replies; tragic and avoidable.
              </p>
              <Button type="button" variant="ghost" size="sm" className={styles.helpButton} onClick={() => void window.appApi.openUrl(eventSubscriptionsUrl)}>
                Open Event Subscriptions
                <ExternalLink size={13} aria-hidden="true" />
              </Button>
              <div className={styles.fieldGroup}>
                <Label htmlFor="slack-byok-event-url">Request URL</Label>
                <p className={styles.muted}>In Slack, turn on Enable Events, then paste this into Request URL. Slack should show Verified.</p>
                <div className={styles.copyRow}>
                  <Input id="slack-byok-event-url" className={styles.readonly} value={eventUrl} readOnly />
                  <Button type="button" variant="outline" onClick={() => void copyText(eventUrl, 'eventUrl')}>
                    <Copy size={14} aria-hidden="true" />
                    Copy event URL
                  </Button>
                </div>
              </div>
              <div className={styles.fieldGroup}>
                <Label htmlFor="slack-byok-event-names">Subscribe to bot events</Label>
                <p className={styles.muted}>Add these events in Slack under Subscribe to bot events, then click Save Changes.</p>
                <div className={styles.copyRow}>
                  <Textarea id="slack-byok-event-names" className={styles.textarea} value={eventNamesText} readOnly />
                  <Button type="button" variant="outline" onClick={() => void copyText(eventNamesText, 'eventNames')}>
                    <Copy size={14} aria-hidden="true" />
                    Copy event names
                  </Button>
                </div>
              </div>
            </>
          ) : null}

          {state.step === 6 ? (
            <>
              <p className={styles.muted}>
                Last step. Rebel will open Slack in your browser so you can approve this app for your workspace.
              </p>
              <Notice tone="info" placement="inline" title="What Slack will ask">
                Slack will ask you to allow Rebel to read relevant messages, see who mentioned it, and reply in threads. Choose the same workspace you used when creating the app.
              </Notice>
              <dl className={styles.summary}>
                <div className={styles.detailsRow}>
                  <dt>Slack app</dt>
                  <dd>{parsedAppId ?? '—'}</dd>
                </div>
                <div className={styles.detailsRow}>
                  <dt>Client ID</dt>
                  <dd>{state.clientId.trim()}</dd>
                </div>
                <div className={styles.detailsRow}>
                  <dt>Cloud</dt>
                  <dd>{normalizedCloudBaseUrl}</dd>
                </div>
                <div className={styles.detailsRow}>
                  <dt>Secrets</dt>
                  <dd>Sent to your cloud when you connect, not stored in this app window.</dd>
                </div>
              </dl>
              {submitting ? (
                <p className={styles.muted} role="status">
                  Finish approval in the Slack tab that opened. Rebel will wait here for up to 5 minutes.
                </p>
              ) : null}
            </>
          ) : null}

          {copySuccess ? <p className={styles.success}>{copySuccess}</p> : null}
          {copyError ? <p className={styles.error} role="alert">{copyError}</p> : null}
        </DialogBody>

        <DialogFooter>
          {state.step === 1 ? (
            <Button type="button" variant="ghost" onClick={close} disabled={submitting}>Cancel</Button>
          ) : (
            <Button type="button" variant="ghost" onClick={back} disabled={submitting}>Back</Button>
          )}

          {state.step === 1 ? (
            <Button type="button" onClick={next} disabled={submitting}>
              Next: app credentials
            </Button>
          ) : null}
          {state.step === 2 ? (
            <Button type="button" onClick={next} disabled={submitting || !credentialsReady}>
              Next: OAuth &amp; Permissions
            </Button>
          ) : null}
          {state.step === 3 ? (
            <Button type="button" onClick={next} disabled={submitting}>
              Next: App Home
            </Button>
          ) : null}
          {state.step === 4 ? (
            <Button type="button" onClick={next} disabled={submitting}>
              Next: events
            </Button>
          ) : null}
          {state.step === 5 ? (
            <Button type="button" onClick={next} disabled={submitting}>
              I saved events in Slack
            </Button>
          ) : null}
          {state.step === 6 ? (
            <Button type="button" onClick={() => void connect()} disabled={submitting || !credentialsReady}>
              {submitting ? 'Waiting for Slack…' : 'Connect Slack'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
