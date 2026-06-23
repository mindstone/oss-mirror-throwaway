/**
 * QuickActions — popup quick-action buttons (Stage 6c).
 *
 * Renders three buttons when the extension is paired and connected:
 *   1. "Summarise this page"   → intent `summarise`
 *   2. "Ask about this"        → intent `ask` (opens a small inline composer)
 *   3. "Save to notes"         → intent `save_to_notes`
 *
 * Each button captures `{ tabId, windowId, url, title }` from
 * `chrome.tabs.query({ active: true, currentWindow: true })` at click time
 * (R18 / D21) and then POSTs via `sendIntent` to the App Bridge. The user
 * sees a brief inline status while the request is in flight.
 *
 * Visibility: the caller passes `visible` — we never render this block when
 * the extension isn't paired or hasn't reached `connected`. The Popup is the
 * source of truth for connection state.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 6c)
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { captureTabContext, sendIntent, type IntentKind, type SendIntentResult } from '../lib/intents';
import styles from './QuickActions.module.css';

interface QuickActionsProps {
  /** When false, the component renders nothing — caller gates on paired+connected. */
  visible: boolean;
  /** Stable per-install clientId stored alongside the pairing token. */
  clientId: string | null;
  /**
   * Paired app token (post-review A4). Required for every /intent/* call —
   * when `null`, QuickActions surfaces a pairing prompt instead of firing
   * intents. The popup passes whatever it read from `chrome.storage.local`.
   */
  token: string | null;
  /** Optional test hook: override the intents module's `sendIntent`. */
  sendIntentImpl?: typeof sendIntent;
  /** Optional test hook: override the tabContext capture. */
  captureTabContextImpl?: typeof captureTabContext;
  /** Optional test hook: override the content-script pageContext fetcher. */
  fetchPageContextImpl?: typeof fetchPageContext;
  /** Callback when an intent succeeds — consumed by tests; not required. */
  onIntentSuccess?: (intent: IntentKind, result: Extract<SendIntentResult, { ok: true }>) => void;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'pending'; intent: IntentKind }
  | { kind: 'success'; intent: IntentKind; message: string }
  | { kind: 'error'; intent: IntentKind; message: string };

interface PageContextSnapshot {
  title?: string;
  url?: string;
  selection?: string;
  text?: string;
}

/**
 * Pull as much page context as the content script can safely share. Runs via
 * `chrome.scripting.executeScript` (world: MAIN) to avoid a full content
 * script injection — we only need text + selection + title + url.
 *
 * Public so tests can stub it independently of intents.ts.
 */
export async function fetchPageContext(tabId: number): Promise<PageContextSnapshot | null> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const body = document.body as HTMLElement | null;
        const text =
          (body?.innerText ?? document.documentElement?.textContent ?? '').slice(0, 50_000);
        const selection = (window.getSelection?.()?.toString() ?? '').slice(0, 20_000);
        return {
          title: document.title ?? '',
          url: location.href,
          text,
          selection,
        };
      },
    });
    if (!result || typeof result.result !== 'object' || result.result === null) return null;
    return result.result as PageContextSnapshot;
  } catch {
    // chrome.scripting refuses on chrome:// / about: / the Web Store.
    // Don't hard-fail the intent — send with whatever we already have from
    // the tabContext (title + url) and let Rebel ask for more.
    return null;
  }
}

function statusClassName(status: Status): string {
  if (status.kind === 'error') return `${styles.status} ${styles.statusError}`;
  if (status.kind === 'pending') return `${styles.status} ${styles.statusPending}`;
  return `${styles.status} ${styles.statusInfo}`;
}

function describeStatus(status: Status): string | null {
  switch (status.kind) {
    case 'idle':
      return null;
    case 'pending':
      return intentCopy(status.intent).pendingCopy;
    case 'success':
      return status.message;
    case 'error':
      return status.message;
  }
}

interface IntentCopy {
  label: string;
  pendingCopy: string;
  successCopy: string;
}

function intentCopy(intent: IntentKind): IntentCopy {
  switch (intent) {
    case 'summarise':
      return {
        label: 'Summarise this page',
        pendingCopy: 'Asking Rebel to summarise…',
        successCopy: 'Sent to Rebel. Opening the conversation.',
      };
    case 'ask':
      return {
        label: 'Ask about this',
        pendingCopy: 'Sending your question to Rebel…',
        successCopy: 'Sent to Rebel.',
      };
    case 'save_to_notes':
      return {
        label: 'Save to notes',
        pendingCopy: 'Saving the page to Rebel…',
        successCopy: 'Saved to Rebel.',
      };
    case 'chat':
      // `chat` is the side-panel intent and isn't rendered in QuickActions,
      // but we handle it here so the exhaustive switch type-checks after
      // the IntentKind union grew to include it.
      return {
        label: 'Chat with Rebel',
        pendingCopy: 'Opening the chat panel…',
        successCopy: 'Chat ready.',
      };
  }
}

export default function QuickActions(props: QuickActionsProps): ReactElement | null {
  const {
    visible,
    clientId,
    token,
    sendIntentImpl = sendIntent,
    captureTabContextImpl = captureTabContext,
    fetchPageContextImpl = fetchPageContext,
    onIntentSuccess,
  } = props;

  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [askOpen, setAskOpen] = useState(false);
  const [askText, setAskText] = useState('');
  const unmountedRef = useRef(false);

  useEffect(() => {
    return (): void => {
      unmountedRef.current = true;
    };
  }, []);

  const runIntent = useCallback(
    async (intent: IntentKind, userText?: string): Promise<void> => {
      if (!clientId || !token) {
        setStatus({
          kind: 'error',
          intent,
          message: 'Extension is not paired yet. Pair it first, then try again.',
        });
        return;
      }
      setStatus({ kind: 'pending', intent });
      const tabContext = await captureTabContextImpl();
      if (!tabContext) {
        setStatus({
          kind: 'error',
          intent,
          message: "Couldn't see an active tab. Click a page tab and try again.",
        });
        return;
      }
      const pageSnapshot = await fetchPageContextImpl(tabContext.tabId);
      const pageContext: PageContextSnapshot = {};
      if (tabContext.title) pageContext.title = tabContext.title;
      if (tabContext.url) pageContext.url = tabContext.url;
      if (pageSnapshot?.title) pageContext.title = pageSnapshot.title;
      if (pageSnapshot?.url) pageContext.url = pageSnapshot.url;
      if (pageSnapshot?.selection) pageContext.selection = pageSnapshot.selection;
      // For save_to_notes we fall back to full page text when there's no selection.
      if (intent === 'save_to_notes') {
        if (pageSnapshot?.selection) {
          pageContext.selection = pageSnapshot.selection;
        } else if (pageSnapshot?.text) {
          pageContext.text = pageSnapshot.text;
        }
      } else if (pageSnapshot?.text) {
        pageContext.text = pageSnapshot.text;
      }

      const result = await sendIntentImpl({
        clientId,
        token,
        intent,
        tabContext,
        pageContext,
        ...(userText ? { userText } : {}),
      });

      if (unmountedRef.current) return;
      if (result.ok) {
        setStatus({
          kind: 'success',
          intent,
          message: intentCopy(intent).successCopy,
        });
        onIntentSuccess?.(intent, result);
      } else {
        setStatus({ kind: 'error', intent, message: result.message });
      }
    },
    [clientId, token, captureTabContextImpl, fetchPageContextImpl, sendIntentImpl, onIntentSuccess],
  );

  const busy = status.kind === 'pending';

  const handleSummarise = useCallback(() => {
    void runIntent('summarise');
  }, [runIntent]);

  const handleSave = useCallback(() => {
    void runIntent('save_to_notes');
  }, [runIntent]);

  const handleAskToggle = useCallback(() => {
    setAskOpen((open) => !open);
  }, []);

  const handleAskSubmit = useCallback(
    (ev: React.FormEvent): void => {
      ev.preventDefault();
      const trimmed = askText.trim();
      if (!trimmed) return;
      void runIntent('ask', trimmed).then(() => {
        if (!unmountedRef.current) {
          setAskText('');
          setAskOpen(false);
        }
      });
    },
    [askText, runIntent],
  );

  const statusMessage = useMemo(() => describeStatus(status), [status]);

  if (!visible) return null;

  return (
    <div
      className={styles.root}
      data-testid="quick-actions"
      aria-label="Rebel quick actions"
    >
      <span className={styles.label}>Quick actions</span>
      <div className={styles.buttonRow}>
        <button
          type="button"
          className={styles.button}
          onClick={handleSummarise}
          disabled={busy}
          data-testid="quick-action-summarise"
        >
          {intentCopy('summarise').label}
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={handleAskToggle}
          disabled={busy}
          data-testid="quick-action-ask-toggle"
          aria-expanded={askOpen}
        >
          {intentCopy('ask').label}
        </button>
        {askOpen && (
          <form
            className={styles.askForm}
            onSubmit={handleAskSubmit}
            data-testid="quick-action-ask-form"
          >
            <textarea
              className={styles.askInput}
              placeholder="What would you like to know about this page?"
              value={askText}
              onChange={(e) => setAskText(e.target.value)}
              disabled={busy}
              data-testid="quick-action-ask-input"
              rows={3}
            />
            <div className={styles.askActions}>
              <button
                type="button"
                className={styles.askSecondary}
                onClick={() => {
                  setAskText('');
                  setAskOpen(false);
                }}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={styles.askPrimary}
                disabled={busy || askText.trim().length === 0}
                data-testid="quick-action-ask-send"
              >
                Send
              </button>
            </div>
          </form>
        )}
        <button
          type="button"
          className={styles.button}
          onClick={handleSave}
          disabled={busy}
          data-testid="quick-action-save"
        >
          {intentCopy('save_to_notes').label}
        </button>
      </div>

      {statusMessage && (
        <div
          className={statusClassName(status)}
          data-testid="quick-action-status"
          data-kind={status.kind}
          role={status.kind === 'error' ? 'alert' : 'status'}
        >
          {statusMessage}
        </div>
      )}
    </div>
  );
}
