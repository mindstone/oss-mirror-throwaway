import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify';
import type { ActionPreviewModel, GenericStructuredRow } from '@rebel/shared';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import styles from './MessagePreview.module.css';

const PRIVACY_COPY = 'Content hidden for privacy';
const RICH_MESSAGE_NOTE = 'This message includes rich formatting.';

// Strict ALLOW-LIST for an email-body preview inside a *security-review /
// approval* card. The body is untrusted (model / recipient-influenced), so the
// policy is "deny everything except inert basic formatting". The general
// DOMPurify "safe HTML" profile is intentionally NOT used: even with script
// XSS closed, it still preserves resource-loading and interactive HTML (remote
// <img src>, srcset, data: images, <button>/<input>) that an approval preview
// must never render — those trigger tracking/network fetches or spoofable
// controls inside the confirmation card. Tags below are limited to formatting
// that Rebel-drafted HTML emails legitimately use (incl. tables, which are
// common in emails).
const ALLOWED_TAGS = [
  'p', 'br', 'ul', 'ol', 'li',
  'strong', 'b', 'em', 'i', 'u', 's',
  'blockquote', 'pre', 'code', 'span',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
  // Links are kept so reviewers can inspect where an email body points; their
  // protocols are constrained to http/https/mailto by ALLOWED_URI_REGEXP below
  // (javascript:/data: hrefs are dropped). No src/style/class/id is allowed, so
  // an <a> cannot load remote resources or carry inline CSS.
  'a',
];

// Minimal attribute allow-list: links get href/title only. Explicitly excludes
// src/srcset (no remote/data resource loads), style (CSS exfiltration /
// UI-spoofing), class/id (no styling hooks), and every on* event handler.
const ALLOWED_ATTR = ['href', 'title'];

// Constrain URIs to http/https/mailto. This is DOMPurify's default-safe pattern
// with the relative/anchor escape hatches retained; it drops javascript:, data:
// and other active-content schemes on href.
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

const SANITIZE_CONFIG: DOMPurifyConfig = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOWED_URI_REGEXP,
};

// Upper bound on sanitize iterations (see sanitizeBodyHtml). Each iteration that
// makes progress strips at least one disallowed node, so a realistic body
// converges in a handful of passes; the cap is a safety valve against a
// pathological / non-converging input and is far above any plausible real body.
const MAX_SANITIZE_PASSES = 12;

/**
 * Sanitize an untrusted (model / recipient-influenced) HTML email body before
 * it is injected as markup.
 *
 * SECURITY GUARANTEE: the {@link SANITIZE_CONFIG} ALLOW-LIST is what makes this
 * safe — only inert formatting tags survive, no resource-loading or interactive
 * elements, and href is restricted to http/https/mailto. Anything not on the
 * list (script, img, button, input, style, iframe, svg, …) is dropped.
 *
 * Sanitize is run to a FIXED POINT (repeat until the output stops changing)
 * rather than a single pass. On some DOM implementations (verified under
 * happy-dom) DOMPurify's tree walk skips a node's following sibling when it
 * removes a disallowed element mid-traversal — so a single pass can leave a
 * disallowed sibling (and its on* attributes / data: src) un-cleaned, and even
 * a fixed two passes only peels one such node per pass. Re-running until the
 * markup is stable removes them all. The loop is bounded by MAX_SANITIZE_PASSES
 * and is idempotent on an already-clean tree (Chromium converges in one pass);
 * this is purely about closing the buggy-DOM leak, not the policy itself.
 */
function sanitizeBodyHtml(body: string): string {
  let previous = body;
  let current = DOMPurify.sanitize(body, SANITIZE_CONFIG);
  for (let pass = 1; pass < MAX_SANITIZE_PASSES && current !== previous; pass += 1) {
    previous = current;
    current = DOMPurify.sanitize(current, SANITIZE_CONFIG);
  }
  return current;
}

function pickRow(model: ActionPreviewModel, keys: string[]): GenericStructuredRow | null {
  for (const key of keys) {
    const match = model.structuredArgs.find((row) => row.key.toLowerCase() === key.toLowerCase());
    if (match && match.value.trim().length > 0) {
      return match;
    }
  }
  return null;
}

function pickRowValue(model: ActionPreviewModel, keys: string[]): string | null {
  return pickRow(model, keys)?.value ?? null;
}

function isSlackMessage(model: ActionPreviewModel, destination: string | null): boolean {
  const title = model.title.toLowerCase();
  return title.includes('slack')
    || destination === 'Slack channel'
    || destination === 'Direct message'
    || (destination?.startsWith('#') ?? false);
}

function getPrivateMessageRecipient(destination: string | null, audience: string | null): string | null {
  const normalizedDestination = destination?.trim() ?? '';
  const normalizedAudience = audience?.trim() ?? '';
  const audienceRecipient = normalizedAudience.match(/^just\s+(.+)$/i)?.[1]?.trim() ?? '';

  if (audienceRecipient) {
    if (!normalizedDestination || normalizedDestination.toLowerCase() === 'direct message') {
      return audienceRecipient;
    }
    if (normalizedDestination.toLowerCase() === audienceRecipient.toLowerCase()) {
      return normalizedDestination;
    }
  }

  return null;
}

function pushText(value: unknown, output: string[]): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length > 0) {
    output.push(trimmed);
  }
}

function collectBlockText(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectBlockText(entry, output));
    return;
  }

  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;

  const textValue = record.text;
  if (typeof textValue === 'string') {
    pushText(textValue, output);
  } else if (textValue && typeof textValue === 'object' && !Array.isArray(textValue)) {
    pushText((textValue as Record<string, unknown>).text, output);
  }

  const fieldsValue = record.fields;
  if (Array.isArray(fieldsValue)) {
    for (const field of fieldsValue) {
      if (typeof field === 'string') {
        pushText(field, output);
        continue;
      }
      if (field && typeof field === 'object' && !Array.isArray(field)) {
        pushText((field as Record<string, unknown>).text, output);
      }
    }
  }

  const elementsValue = record.elements;
  if (Array.isArray(elementsValue) || (elementsValue && typeof elementsValue === 'object')) {
    collectBlockText(elementsValue, output);
  }
}

function deriveBlocksText(blocks: string | null): string | null {
  if (!blocks) return null;
  try {
    const parsed = JSON.parse(blocks) as unknown;
    const lines: string[] = [];
    collectBlockText(parsed, lines);
    const uniqueLines = Array.from(new Set(lines));
    if (uniqueLines.length === 0) return null;
    return uniqueLines.join('\n\n');
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'parse message preview blocks',
      reason: 'fall back when blocks JSON is malformed',
    });
    return null;
  }
}

export interface MessagePreviewProps {
  model: ActionPreviewModel;
}

export const MessagePreview = ({ model }: MessagePreviewProps) => {
  const destination = model.blastRadius.where[0]?.label ?? null;
  const audience = model.blastRadius.whoCanSeeIt[0]?.label ?? null;
  const subject = pickRowValue(model, ['subject']);
  const bodyRow = pickRow(model, ['body', 'text', 'message']);
  const body = bodyRow?.value ?? null;
  const bodyIsHtml = bodyRow?.isHtml === true;
  const blocks = pickRowValue(model, ['blocks']);
  const blocksText = deriveBlocksText(blocks);
  const safeToRenderContent = model.contentVisibility === 'safe';
  const isSlack = isSlackMessage(model, destination);
  const privateMessageRecipient = isSlack
    ? getPrivateMessageRecipient(destination, audience)
    : null;

  return (
    <section className={styles.root} data-testid="message-preview">
      {privateMessageRecipient ? (
        <p className={styles.metaLine} data-testid="message-preview-metadata">
          <span className={styles.metaItem} data-testid="message-preview-destination">
            <span className={styles.metaLabel}>Private message to</span>
            <span className={styles.metaValue}>{privateMessageRecipient}</span>
          </span>
        </p>
      ) : (destination || audience) ? (
        <p className={styles.metaLine} data-testid="message-preview-metadata">
          {destination ? (
            <span className={styles.metaItem} data-testid="message-preview-destination">
              <span className={styles.metaLabel}>To</span>
              <span className={styles.metaValue}>{destination}</span>
            </span>
          ) : null}
          {audience ? (
            <span className={styles.metaItem} data-testid="message-preview-audience">
              <span className={styles.metaLabel}>Visible to</span>
              <span className={styles.metaValue}>{audience}</span>
            </span>
          ) : null}
        </p>
      ) : null}

      <section className={styles.messageFrame} data-testid="message-preview-body">
        {!safeToRenderContent ? (
          <p className={styles.withheldCopy} data-testid="message-preview-withheld">
            {PRIVACY_COPY}
          </p>
        ) : (
          <div className={styles.messageContent}>
            {subject ? (
              <p className={styles.subjectLine} data-testid="message-preview-subject">
                <span className={styles.subjectLabel}>Subject:</span> {subject}
              </p>
            ) : null}
            {body && bodyIsHtml ? (
              <div
                className={styles.bodyText}
                data-testid="message-preview-text"
                // SECURITY: `body` is untrusted (model / recipient-influenced)
                // HTML. It is ALWAYS routed through sanitizeBodyHtml (DOMPurify
                // strict allow-list) before injection — never inject raw `body`.
                dangerouslySetInnerHTML={{ __html: sanitizeBodyHtml(body) }}
              />
            ) : body ? (
              <p className={styles.bodyText} data-testid="message-preview-text">{body}</p>
            ) : null}
            {blocksText ? (
              <p className={styles.bodyText} data-testid="message-preview-blocks-text">{blocksText}</p>
            ) : null}
            {blocks && !blocksText ? (
              <p className={styles.emptyCopy} data-testid="message-preview-rich-note">
                {RICH_MESSAGE_NOTE}
              </p>
            ) : null}
            {!body && !blocks && !blocksText ? (
              <p className={styles.emptyCopy} data-testid="message-preview-empty">
                No message content was provided.
              </p>
            ) : null}
          </div>
        )}
      </section>
    </section>
  );
};
