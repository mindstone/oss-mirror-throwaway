/**
 * PermissionGrantCard — the user's first trust moment with Rebel.
 *
 * Rendered inside the popup and at the top of the side panel when the
 * service worker has queued a pending permission entry (because an agent
 * dispatch hit `INJECTION_REFUSED`). The card is the single call site for
 * `chrome.permissions.request` — the grant must be a real user gesture, so
 * the SW cannot call it directly.
 *
 * Visual states (driven by internal React state + the `entry` prop shape):
 *
 *   - `idle`                    — default: title, body, Allow / Not now,
 *                                 revoke link, expandable "What this means".
 *   - `awaiting-chrome-prompt`  — after Allow clicked; button disabled with
 *                                 a subtle pulse; respects reduced-motion.
 *   - `denied`                  — Chrome prompt returned `false`; shows the
 *                                 softened v2.1 copy ("No problem…").
 *   - `request-failed`          — `chrome.permissions.request()` threw;
 *                                 offers retry + manual fallback link.
 *
 * The separate revoked-externally toast is NOT a card state — it's an
 * ephemeral toast rendered by popup.tsx / SidePanel.tsx when
 * `rebel.last-revoked.v1` appears in `chrome.storage.session`.
 *
 * Mechanical single-flight (plan §17): rapid repeated clicks on Allow
 * within one request-lifetime dispatch exactly one `chrome.permissions
 * .request` call. `isRequesting` disables the button (`aria-disabled`,
 * `pointer-events: none`, `disabled`) for the entire request window.
 *
 * All copy is verbatim from the plan's "Brand voice calibration" table.
 *
 * @see docs/plans/260424_browser_extension_bundling_and_permissions_fix.md
 *      — Brand voice calibration, Key Decisions §10 §17, Acceptance UI.
 */

import { useCallback, useRef, useState, type ReactElement } from 'react';
import { displayOriginForUser } from './originMatch';
import type { PendingPermissionEntry } from './permissionState';
import styles from './PermissionGrantCard.module.css';

/**
 * Verbatim brand-voice copy. Exported for test spot-checks so the strings
 * stay honest if anyone edits them. Do not paraphrase — each line is
 * calibrated against docs/project/BRAND_VOICE.md.
 */
export const CARD_COPY = {
  title: (displayOrigin: string) => `Let Rebel work on ${displayOrigin}`,
  body: (displayOrigin: string) =>
    `When you ask me to, I can read the page and interact with it on ${displayOrigin} — fill out forms, click buttons, pull out information you need. This access persists until you revoke it. Don't grant on sites with private data you wouldn't want a digital assistant to see.`,
  whatThisMeansSummary: 'What this means',
  whatThisMeansBody:
    "I can see what's visible, interact with fields and buttons you point me at, and pull out text you ask for. I can't install things, send email from your account, or keep reading after you close the tab.",
  primaryIdle: (displayOrigin: string) => `Allow on ${displayOrigin}`,
  primaryAwaiting: 'Waiting for Chrome…',
  primaryDenied: (displayOrigin: string) => `Allow on ${displayOrigin}`,
  primaryFailed: 'Try again',
  secondaryDismiss: 'Not now',
  revokeLink: "You can change this in your browser's extension settings →",
  deniedBody: (displayOrigin: string) =>
    `No problem. If you change your mind, you can enable Rebel on ${displayOrigin} anytime from the popup.`,
  requestFailedBody:
    "Chrome wouldn't let me ask right now. This sometimes happens on managed browsers or unusual pages. You can try again, or enable access manually in your browser's extension settings →",
  successToast: "Thanks. Re-ask Rebel and I'll get on with it.",
  revokedToast: (displayOrigin: string) =>
    `Rebel's access to ${displayOrigin} was removed. No hard feelings.`,
  sidepanelBannerTitle: 'One thing before I can help here',
} as const;

/** Surface the card is rendered in — used for instrumentation logs. */
export type CardSurface = 'popup' | 'sidepanel';

/** Card runtime state. Distinct from plan-level `reason` enum. */
type CardState = 'idle' | 'awaiting-chrome-prompt' | 'denied' | 'request-failed';

export interface PermissionGrantCardProps {
  entry: PendingPermissionEntry;
  /**
   * Called after `chrome.permissions.request` resolves `true`. The parent
   * is responsible for clearing the pending entry, logging grant-time
   * breadcrumbs, and showing the success toast.
   */
  onAllow: (origin: string) => Promise<void> | void;
  /** Optional dismiss handler ("Not now"). */
  onDismiss?: () => void;
  surface: CardSurface;
}

/**
 * Derive the Chrome match pattern for `chrome.permissions.request`. We
 * re-derive here rather than threading it from the SW because
 * `PendingPermissionEntry.origin` is already canonicalised and we only
 * need the trailing `/*`.
 */
function matchPatternForOrigin(origin: string): string {
  return origin.endsWith('/*') ? origin : `${origin}/*`;
}

/** Tiny inline shield-check SVG — popup bundle is self-contained. */
function ShieldCheckIcon(): ReactElement {
  return (
    <svg
      className={styles.shieldIcon}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/** Generic globe SVG used when the favicon fetch fails or is unavailable. */
function GlobeIcon(): ReactElement {
  return (
    <svg
      className={styles.faviconFallback}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

interface FaviconProps {
  origin: string;
}

/**
 * Favicon rendered at 20x20 CSS px. We request 32x32 via the
 * `_favicon` runtime URL so HiDPI displays stay crisp, and fall back to
 * an inline globe SVG if the image fails to load (or the `favicon`
 * permission isn't available).
 */
function Favicon({ origin }: FaviconProps): ReactElement {
  const [errored, setErrored] = useState(false);
  const runtime = (globalThis as typeof globalThis & {
    chrome?: { runtime?: { getURL?: (path: string) => string } };
  }).chrome?.runtime;
  let src: string | null = null;
  if (runtime?.getURL) {
    try {
      src = runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(origin)}&size=32`);
    } catch {
      src = null;
    }
  }

  if (errored || !src) {
    return (
      <span className={styles.faviconWrap} data-testid="favicon-fallback">
        <GlobeIcon />
      </span>
    );
  }

  return (
    <span className={styles.faviconWrap}>
      <img
        src={src}
        alt=""
        width={20}
        height={20}
        className={styles.favicon}
        onError={() => setErrored(true)}
        data-testid="favicon-img"
      />
    </span>
  );
}

export function PermissionGrantCard(
  props: PermissionGrantCardProps,
): ReactElement {
  const { entry, onAllow, onDismiss, surface } = props;
  const displayOrigin = displayOriginForUser(entry.origin);
  const matchPattern = matchPatternForOrigin(entry.origin);

  // Mechanical single-flight — see §17. `isRequestingRef` guards against
  // rapid repeated clicks that land before React has flushed the `disabled`
  // state to the DOM; the state+ref pair is what makes the second click a
  // true no-op rather than merely visually deterred.
  const [isRequesting, setIsRequesting] = useState(false);
  const isRequestingRef = useRef(false);
  const [state, setState] = useState<CardState>('idle');

  const handleAllow = useCallback(async (): Promise<void> => {
    if (isRequestingRef.current) return;
    isRequestingRef.current = true;
    setIsRequesting(true);
    setState('awaiting-chrome-prompt');
    try {
      const permissions = (globalThis as typeof globalThis & {
        chrome?: {
          permissions?: {
            request?: (options: { origins: string[] }) => Promise<boolean>;
          };
        };
      }).chrome?.permissions;
      if (!permissions?.request) {
        // No permissions API surface available — treat as request-failed so
        // the user gets actionable copy (the manual extension-settings link)
        // instead of a silent no-op.
        setState('request-failed');
        return;
      }
      const granted = await permissions.request({ origins: [matchPattern] });
      if (granted) {
        await onAllow(entry.origin);
        // Parent clears the pending entry which unmounts this card; no need
        // to transition back to `idle` here.
        return;
      }
      setState('denied');
    } catch {
      setState('request-failed');
    } finally {
      isRequestingRef.current = false;
      setIsRequesting(false);
    }
  }, [entry.origin, matchPattern, onAllow]);

  const handleNotNow = useCallback((): void => {
    if (onDismiss) onDismiss();
  }, [onDismiss]);

  const primaryLabel = isRequesting
    ? CARD_COPY.primaryAwaiting
    : state === 'request-failed'
      ? CARD_COPY.primaryFailed
      : state === 'denied'
        ? CARD_COPY.primaryDenied(displayOrigin)
        : CARD_COPY.primaryIdle(displayOrigin);

  const isAwaiting = state === 'awaiting-chrome-prompt' && isRequesting;

  // Body copy swaps by state — denied/request-failed use their own wording;
  // idle uses the core disclosure copy.
  const bodyCopy =
    state === 'denied'
      ? CARD_COPY.deniedBody(displayOrigin)
      : state === 'request-failed'
        ? CARD_COPY.requestFailedBody
        : CARD_COPY.body(displayOrigin);

  return (
    <section
      className={styles.card}
      data-state={state}
      data-surface={surface}
      data-testid="permission-grant-card"
      aria-labelledby={`rebel-pg-title-${encodeURIComponent(entry.origin)}`}
    >
      <header className={styles.header}>
        <span className={styles.shieldIconWrap} aria-hidden="true">
          <ShieldCheckIcon />
        </span>
        <Favicon origin={entry.origin} />
        <h2
          id={`rebel-pg-title-${encodeURIComponent(entry.origin)}`}
          className={styles.title}
        >
          {CARD_COPY.title(displayOrigin)}
        </h2>
      </header>

      <p className={styles.body}>{bodyCopy}</p>

      {/*
       * DOM order is deliberately: buttonRow → revokeLink → details (summary).
       * That matches the spec'd keyboard tab order (Allow → Not now →
       * Revoke link → summary) so keyboard users reach the primary action
       * first. CSS `order` on each child repositions them visually so the
       * disclosure still appears between the body and the button row and
       * the revoke link sits at the bottom of the card. See the module
       * CSS file for the matching `order` values.
       */}
      <div className={styles.buttonRow}>
        {/*
         * DOM order within the row: Allow → Not now.
         * Visual order: Not now on the left, Allow on the right — achieved
         * via `flex-direction: row-reverse` in the CSS module.
         * This lets keyboard users tab to the primary action first while
         * the default Western mouse-user pattern (dismiss-left, primary-right)
         * is preserved visually.
         */}
        <button
          type="button"
          className={[
            styles.primary,
            isAwaiting ? styles.primaryPulsing : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={handleAllow}
          disabled={isRequesting}
          aria-disabled={isRequesting}
          aria-label={`Allow Rebel on ${displayOrigin}`}
          style={isRequesting ? { pointerEvents: 'none' } : undefined}
          data-testid="permission-allow"
        >
          {primaryLabel}
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={handleNotNow}
          data-testid="permission-not-now"
        >
          {CARD_COPY.secondaryDismiss}
        </button>
      </div>

      <a
        className={styles.revokeLink}
        href="chrome://extensions"
        target="_blank"
        rel="noreferrer noopener"
        data-testid="permission-revoke-link"
      >
        {CARD_COPY.revokeLink}
      </a>

      <details className={styles.details}>
        <summary className={styles.summary}>
          {CARD_COPY.whatThisMeansSummary}
        </summary>
        <p className={styles.detailsBody}>{CARD_COPY.whatThisMeansBody}</p>
      </details>
    </section>
  );
}

export default PermissionGrantCard;
