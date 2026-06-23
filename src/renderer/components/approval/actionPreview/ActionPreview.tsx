import type { ActionEffectKind, ActionPreviewModel } from '@rebel/shared';
import {
  AlertTriangle,
  Bot,
  Database,
  FileText,
  Globe,
  Loader2,
  MessageSquare,
  Terminal,
  Wrench,
} from 'lucide-react';
import { Button } from '@renderer/components/ui';
import { DetailsAccordion } from '@renderer/components/approval/primitives/DetailsAccordion';
import { GenericStructuredPreview } from './GenericStructuredPreview';
import { getActionPreviewBodyRenderer } from './rendererRegistry';
import styles from './ActionPreview.module.css';

export type ActionPreviewState = 'ready' | 'loading' | 'error' | 'resolving' | 'no-longer-waiting';

const EFFECT_SUMMARY_COPY: Record<ActionEffectKind, string> = {
  document: 'Rebel is preparing a document update and waiting for your go-ahead.',
  message: 'Review the message before Rebel sends it.',
  'data-capture': 'Rebel is about to save captured notes and wants a final check from you.',
  command: 'Rebel is about to run a local command and is waiting for your approval.',
  'external-record': 'Rebel is about to update an external record and paused to confirm details.',
  browser: 'Rebel is about to perform a browser action and paused for your confirmation.',
  generic: 'Rebel paused this tool action so you can review it before anything runs.',
};

const EFFECT_TITLE_COPY: Record<ActionEffectKind, string> = {
  document: 'Update file',
  message: 'Send message',
  'data-capture': 'Save captured information',
  command: 'Run local task',
  'external-record': 'Update external record',
  browser: 'Run browser action',
  generic: 'Review action',
};

const KNOWN_EFFECT_KINDS: readonly ActionEffectKind[] = [
  'document',
  'message',
  'data-capture',
  'command',
  'external-record',
  'browser',
  'generic',
];

export const CARD_WITHHELD_COPY = 'Content hidden for privacy';

function isKnownEffectKind(value: string): value is ActionEffectKind {
  return KNOWN_EFFECT_KINDS.includes(value as ActionEffectKind);
}

function normalizeEffectKind(effectKind: ActionEffectKind | string): ActionEffectKind {
  if (!isKnownEffectKind(effectKind)) {
    return 'generic';
  }
  return effectKind;
}

export function getActionPreviewTitle(model: ActionPreviewModel): string {
  const normalizedEffectKind = normalizeEffectKind(model.effectKind);
  const modelTitle = model.title.trim();
  if (normalizedEffectKind === 'message') {
    if (modelTitle.toLowerCase().includes('slack')) return 'Send Slack message';
    if (modelTitle.toLowerCase().includes('email')) return 'Send email';
    return 'Send message';
  }

  if (normalizedEffectKind === 'data-capture') {
    return modelTitle || 'Save captured information';
  }

  if (modelTitle.length > 0 && modelTitle.length <= 80) {
    return modelTitle;
  }

  return EFFECT_TITLE_COPY[normalizedEffectKind];
}

export function getActionPreviewSummary(effectKind: ActionEffectKind | string): string {
  return EFFECT_SUMMARY_COPY[normalizeEffectKind(effectKind)];
}

function getEffectIcon(effectKind: ActionEffectKind | string) {
  switch (normalizeEffectKind(effectKind)) {
    case 'document':
      return FileText;
    case 'message':
      return MessageSquare;
    case 'data-capture':
      return Database;
    case 'command':
      return Terminal;
    case 'external-record':
      return Globe;
    case 'browser':
      return Bot;
    case 'generic':
    default:
      return Wrench;
  }
}

const SAFETY_PROMPT_BLOCKED_PREFIX = 'Safety Rules blocked:';

// The raw safety reason is phrased for the system ("Safety Rules blocked: …"),
// which reads as an alarm to a non-technical person. Strip that framing so the
// user-facing copy stays calm and plain while keeping the explanation.
export function plainifyActionPreviewReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.startsWith(SAFETY_PROMPT_BLOCKED_PREFIX)) {
    return trimmed.slice(SAFETY_PROMPT_BLOCKED_PREFIX.length).trim();
  }
  return trimmed;
}

export function getActionPreviewReasonText(reason?: string): string | null {
  if (!reason || reason.trim().length === 0) return null;
  const plain = plainifyActionPreviewReason(reason);
  return plain.length > 0 ? plain : null;
}

function buildWhyCopy(reason?: string): string {
  const plain = getActionPreviewReasonText(reason);
  if (plain) {
    return plain;
  }

  return 'Rebel paused so you can confirm before it goes ahead.';
}

export interface ActionPreviewProps {
  model: ActionPreviewModel;
  toolName?: string;
  reason?: string;
  state?: ActionPreviewState;
  stateMessage?: string;
  errorMessage?: string;
  onRetry?: () => void;
  className?: string;
  showHeader?: boolean;
  showWhy?: boolean;
  withheldCopy?: string;
  revealedContent?: string | null;
}

export const ActionPreview = ({
  model,
  toolName,
  reason,
  state = 'ready',
  stateMessage,
  errorMessage,
  onRetry,
  className,
  showHeader = true,
  showWhy = true,
  withheldCopy = CARD_WITHHELD_COPY,
  revealedContent,
}: ActionPreviewProps) => {
  const title = getActionPreviewTitle(model);
  const summaryCopy = getActionPreviewSummary(model.effectKind);
  const whyCopy = buildWhyCopy(reason);
  const EffectIcon = getEffectIcon(model.effectKind);
  const BodyRenderer = getActionPreviewBodyRenderer(model.effectKind);
  const shouldRenderStructuredContent = model.contentVisibility === 'safe';
  const shouldRenderBody = state === 'ready' || state === 'resolving';
  const hasRevealedContent = revealedContent !== null && revealedContent !== undefined;
  const isRecoveryError = state === 'error' && model.contentVisibility !== 'safe';

  return (
    <article className={`${styles.root}${className ? ` ${className}` : ''}`} data-testid="action-preview">
      {showHeader ? (
        <header className={styles.header}>
          <div className={styles.effectIconTile} aria-hidden>
            <EffectIcon size={18} />
          </div>
          <div className={styles.headerCopy}>
            <h3 className={styles.title}>{title}</h3>
            <p className={styles.description}>{summaryCopy}</p>
          </div>
        </header>
      ) : null}

      {state === 'resolving' && (
        <p className={styles.resolvingNote} data-testid="action-preview-resolving">
          {stateMessage ?? 'Still checking recipient details...'}
        </p>
      )}

      <section className={styles.bodyRegion} data-testid={`action-preview-body-${model.effectKind}`}>
        {state === 'loading' ? (
          <div className={styles.statusState} data-testid="action-preview-loading">
            <Loader2 size={16} className={styles.spinner} />
            <p>{stateMessage ?? 'Loading preview details...'}</p>
          </div>
        ) : null}

        {state === 'error' ? (
          <div className={styles.statusState} role="alert" data-testid="action-preview-error">
            <p data-testid={isRecoveryError ? 'action-preview-recovery-error' : undefined}>
              {errorMessage ?? 'Rebel hit a snag while loading more details.'}
            </p>
            {onRetry ? (
              <Button
                variant="outline"
                size="sm"
                onClick={onRetry}
                data-testid={isRecoveryError ? 'action-preview-recovery-retry-button' : 'action-preview-retry-button'}
              >
                Retry
              </Button>
            ) : null}
          </div>
        ) : null}

        {state === 'no-longer-waiting' ? (
          <div className={styles.statusState} data-testid="action-preview-no-longer-waiting">
            <AlertTriangle size={16} aria-hidden />
            <p>{stateMessage ?? 'This approval is no longer waiting for a decision.'}</p>
          </div>
        ) : null}

        {shouldRenderBody
          ? (
            hasRevealedContent
              ? (
                <section className={styles.genericPreview} data-testid="action-preview-revealed-content-section">
                  <h4 className={styles.sectionTitle}>Revealed content</h4>
                  {revealedContent === ''
                    ? (
                      <p className={styles.emptyRows} data-testid="action-preview-revealed-content-empty">
                        No content to show.
                      </p>
                    )
                    : (
                      <pre className={styles.rowValue} data-testid="action-preview-revealed-content">
                        {revealedContent}
                      </pre>
                    )}
                </section>
              )
              : (
                shouldRenderStructuredContent
                  ? <BodyRenderer model={model} />
                  : <GenericStructuredPreview model={model} withheldCopy={withheldCopy} />
              )
          )
          : null}
      </section>

      {showWhy ? (
        <p className={styles.whyCopy} data-testid="action-preview-why">{whyCopy}</p>
      ) : null}

      <div className={styles.receipts} data-testid="action-preview-receipts">
        <DetailsAccordion
          toolName={toolName}
          params={shouldRenderStructuredContent ? model.safeRawArgs : undefined}
          defaultExpanded={false}
          toggleTestId="action-preview-receipts-toggle"
        />
      </div>
    </article>
  );
};
