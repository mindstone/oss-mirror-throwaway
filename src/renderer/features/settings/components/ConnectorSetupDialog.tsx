import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '@renderer/components/ui';
import type { OAuthSetupGuidance } from '@shared/ipc/schemas/common';
import styles from './ConnectorSetupDialog.module.css';

/**
 * Public, OSS-facing connector setup guide (created by Stage 6). Kept in lockstep with
 * `CONNECTOR_SETUP_DOCS_PATH` in `src/core/services/oauthConnectorSetup.ts`; duplicated here as a
 * renderer-local constant so this component does not import `@core`. The dialog links to the
 * per-connector anchor inside that doc as its "Setup guide" secondary action.
 */
const CONNECTOR_SETUP_DOCS_URL =
  'https://github.com/mindstone/rebel-app/blob/main/docs/connectors/CONNECTOR_SETUP.md';

const openExternal = (url: string) => {
  window.open(url, '_blank', 'noopener,noreferrer');
};

/**
 * Placeholder value suffix for an env var in the copyable credential block (chief-designer F2):
 * a `*_SECRET` var gets `=your_client_secret`, every other var gets `=your_client_id`. This makes
 * the copied snippet a usable template (`SLACK_CLIENT_ID=your_client_id`) instead of a bare
 * `SLACK_CLIENT_ID=` the operator might paste as-is.
 */
const envVarAssignment = (name: string): string =>
  /SECRET$/.test(name) ? `${name}=your_client_secret` : `${name}=your_client_id`;

export interface ConnectorSetupDialogProps {
  /** Structured guidance payload to render; when null the dialog is closed. */
  guidance: OAuthSetupGuidance | null;
  open: boolean;
  /** Called with `false` when the dialog requests close (Escape / outside / Close button). */
  onOpenChange: (open: boolean) => void;
}

/** A read-only, fully-selectable code line with a "Copy" button (chief-designer F5). */
function CopyableValue({
  value,
  label,
  copyAriaLabel,
  testId,
}: {
  value: string;
  /** Visible button label, e.g. "Copy redirect URI". */
  label: string;
  /** aria-label that MUST include the provider name. */
  copyAriaLabel: string;
  testId?: string;
}) {
  const [copied, setCopied] = useState(false);
  // Surfaced on clipboard rejection (permissions / non-secure context); mirrors the
  // SlackByokSetupWizard precedent so the failure is visible + announced, not silently swallowed.
  const [copyError, setCopyError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyError(null);
      setCopied(true);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1800);
    } catch (err) {
      // Clipboard can reject (permissions / non-secure context). Surface an announced error;
      // the value stays user-selectable below so the user can still copy manually.
      setCopied(false);
      setCopyError(
        err instanceof Error && err.message
          ? `Couldn’t copy automatically — ${err.message}. Select the text above to copy it manually.`
          : 'Couldn’t copy automatically. Select the text above to copy it manually.',
      );
    }
  }, [value]);

  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return (
    <div className={styles.copyField}>
      <div className={styles.copyRow}>
        <code className={styles.code} data-testid={testId}>
          {value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void onCopy()}
          aria-label={copied ? `Copied — ${copyAriaLabel}` : copyAriaLabel}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? 'Copied' : label}
        </Button>
      </div>
      {/* Announce the "Copied" confirmation (visual button-label change alone isn't read by AT). */}
      <span className={styles.srOnly} role="status" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
      {copyError ? (
        <p
          className={styles.copyError}
          role="alert"
          data-testid={testId ? `${testId}-error` : undefined}
        >
          {copyError}
        </p>
      ) : null}
    </div>
  );
}

interface StepProps {
  index: number;
  title: string;
  children: ReactNode;
}

const Step = ({ index, title, children }: StepProps) => (
  <section className={styles.step}>
    <span className={styles.stepBadge} aria-hidden>
      {index}
    </span>
    <div className={styles.stepBody}>
      <h3 className={styles.stepTitle}>{title}</h3>
      {children}
    </div>
  </section>
);

/**
 * Modal recovery surface for a connector that is broken-by-default because no OAuth client
 * credentials are configured (chief-designer F3: modal, NOT inline expansion). Two modes by
 * `selfServe`: a "register an OAuth app" walkthrough, or honest "limited-access" copy (Plaud).
 *
 * Adds the a11y behaviors the shared `Dialog` does NOT provide (chief-designer F2): initial focus,
 * tab containment (focus trap), return focus to the invoking control on close, and
 * `aria-labelledby` + `aria-describedby`. Focus-trap pattern mirrors the Cloud storage resize
 * dialog (`CloudTab.tsx`).
 */
export function ConnectorSetupDialog({ guidance, open, onOpenChange }: ConnectorSetupDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // The control that was focused when the dialog opened, so we can restore focus on close.
  const invokerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  const getFocusable = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog) return [] as HTMLElement[];
    return Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(
      (element) =>
        !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true',
    );
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [getFocusable],
  );

  // Capture the invoking control + set initial focus when opening; restore focus on close.
  useEffect(() => {
    if (open) {
      invokerRef.current = (document.activeElement as HTMLElement | null) ?? null;
      const id = window.setTimeout(() => {
        getFocusable()[0]?.focus();
      }, 0);
      return () => window.clearTimeout(id);
    }
    // On close, return focus to whatever invoked the dialog (if still in the DOM).
    const invoker = invokerRef.current;
    if (invoker && document.contains(invoker)) {
      invoker.focus();
    }
    invokerRef.current = null;
    return undefined;
  }, [open, getFocusable]);

  if (!open || !guidance) return null;

  const { displayName, provider, selfServe, setupUrl, envVars, redirectUris, redirectNote } =
    guidance;
  const docsUrl = `${CONNECTOR_SETUP_DOCS_URL}#${provider}`;

  const close = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} ariaLabelledBy={titleId} ariaDescribedBy={descId}>
      <DialogContent
        ref={dialogRef}
        size="lg"
        onKeyDown={handleKeyDown}
        data-testid="connector-setup-dialog"
        data-self-serve={selfServe ? 'true' : 'false'}
      >
        {selfServe ? (
          <>
            <DialogHeader onClose={close}>
              <DialogTitle id={titleId}>{displayName} needs an OAuth app</DialogTitle>
              <DialogDescription id={descId}>
                This connector needs OAuth client credentials before anyone can connect. Create an
                app with {displayName}, add the redirect URI below, then provide the credentials to
                this app&apos;s environment.
              </DialogDescription>
            </DialogHeader>

            <DialogBody className={styles.body}>
              <Step index={1} title="Create the OAuth app">
                <p className={styles.stepText}>
                  Open {displayName}&apos;s developer console and create a new OAuth app or connected
                  app. Use a name you will recognize later.
                </p>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={() => openExternal(setupUrl)}
                  data-testid="connector-setup-open-console"
                >
                  <ExternalLink aria-hidden />
                  Open console
                </Button>
              </Step>

              <Step index={2} title="Add the redirect URI">
                {redirectUris.length > 0 ? (
                  <>
                    <p className={styles.stepText}>
                      In the app&apos;s redirect or callback settings, paste{' '}
                      {redirectUris.length > 1 ? 'these exact URIs' : 'this exact URI'}.
                    </p>
                    {redirectUris.map((uri, idx) => (
                      <CopyableValue
                        key={uri}
                        value={uri}
                        label="Copy redirect URI"
                        copyAriaLabel={`Copy ${displayName} redirect URI`}
                        testId={`connector-setup-redirect-uri-${idx}`}
                      />
                    ))}
                    {redirectNote && (
                      <p className={styles.note} data-testid="connector-setup-redirect-note">
                        {redirectNote}
                      </p>
                    )}
                  </>
                ) : (
                  // Google Desktop-app loopback: no specific URI to register — note only, no empty
                  // copy field (chief-designer / packet rule).
                  <p className={styles.note} data-testid="connector-setup-redirect-note">
                    {redirectNote ??
                      'No redirect URI needs to be registered for this connector.'}
                  </p>
                )}
              </Step>

              <Step index={3} title="Set the credentials">
                <p className={styles.stepText}>
                  Add these variables to the environment used to start this app. If you run from
                  source, put them in <code className={styles.inlineCode}>.env.local</code> at the
                  repo root.
                </p>
                <CopyableValue
                  value={envVars.map(envVarAssignment).join('\n')}
                  label="Copy env vars"
                  copyAriaLabel={`Copy ${displayName} environment variables`}
                  testId="connector-setup-env-vars"
                />
              </Step>

              <Step index={4} title="Restart and connect again">
                <p className={styles.stepText}>
                  Restart the app so it reads the new credentials, then return here and connect{' '}
                  {displayName} again.
                </p>
              </Step>
            </DialogBody>

            <DialogFooter className={styles.footer}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => openExternal(docsUrl)}
                data-testid="connector-setup-docs"
              >
                Setup guide
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={close}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          // selfServe = false (Plaud): honest limited-access copy — no register-an-app steps.
          <>
            <DialogHeader onClose={close}>
              <DialogTitle id={titleId}>{displayName} OAuth access is limited</DialogTitle>
              <DialogDescription id={descId}>
                {displayName}&apos;s OAuth API isn&apos;t generally self-serve yet. Access is gated
                behind a waitlist or beta, so you can&apos;t register your own OAuth app for it right
                now.
              </DialogDescription>
            </DialogHeader>

            <DialogBody className={styles.body}>
              <p className={styles.stepText}>
                Once {displayName} grants OAuth access, this app will be able to connect. Until then,
                check {displayName}&apos;s OAuth documentation for how to request access.
              </p>
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={() => openExternal(setupUrl)}
                data-testid="connector-setup-open-docs"
              >
                <ExternalLink aria-hidden />
                Open {displayName} OAuth docs
              </Button>
            </DialogBody>

            <DialogFooter className={styles.footer}>
              <Button type="button" variant="outline" size="sm" onClick={close}>
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

ConnectorSetupDialog.displayName = 'ConnectorSetupDialog';
