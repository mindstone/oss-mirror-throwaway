/**
 * ErrorRecoveryCard - UI for error recovery evaluation flow
 *
 * Shows evaluation progress and results when Rebel analyzes whether
 * it can help fix an error. Part of the "Rebel using Rebel" feature.
 *
 * States:
 * - evaluating: Spinner with time-bucketed quips
 * - can_help: Success state with "Let Rebel fix it" button
 * - cannot_help: Honest message with "Ask Rebel anyway" escape hatch
 * - evaluation_failed: Error state with "Ask Rebel anyway" option
 */

import { useEffect, useState, useCallback } from 'react';
import { useVisibilityAwareInterval } from '../hooks/useVisibilityAwareInterval';
import { Loader2, CheckCircle, HelpCircle, AlertCircle, X, ExternalLink } from 'lucide-react';
import { Button } from './ui';
import type { SafeModeErrorCategory } from '@shared/types';
import styles from './ErrorRecoveryCard.module.css';

// Time-bucketed analysis quips matching Rebel's voice
const ANALYSIS_QUIPS = {
  intro: [
    'Taking a look...',
    'Checking the diagnostics...',
    'Examining the situation...',
  ],
  short: [
    'Inspecting the config files...',
    'Tracing the error\'s origins...',
    'Following the breadcrumbs...',
  ],
  medium: [
    'Running a deeper analysis...',
    'This one needs a closer look...',
    'Consulting the logs...',
    'The plot thickens. Give me a moment.',
  ],
  long: [
    'Still on the case. These things take time.',
    'A thorough investigation is underway.',
    'Complex issues deserve careful attention.',
    'Almost there. Your patience is noted.',
  ],
} as const;

type QuipBucket = keyof typeof ANALYSIS_QUIPS;

function getQuipBucket(elapsedMs: number): QuipBucket {
  if (elapsedMs < 5000) return 'intro';
  if (elapsedMs < 15000) return 'short';
  if (elapsedMs < 30000) return 'medium';
  return 'long';
}

function getRandomQuip(bucket: QuipBucket): string {
  const quips = ANALYSIS_QUIPS[bucket];
  return quips[Math.floor(Math.random() * quips.length)];
}

// Human-readable error category names
function getErrorCategoryLabel(category: SafeModeErrorCategory): string {
  const labels: Record<SafeModeErrorCategory, string> = {
    port_conflict: 'Port conflict',
    config_parse: 'Configuration error',
    network: 'Network issue',
    permission: 'Permission issue',
    process_crash: 'Process crash',
    timeout: 'Timeout',
    missing_bundle: 'Missing bundled tools',
    spawn_missing_executable: 'Missing executable',
    fs_exhaustion: 'Too many open files',
    health_timeout: 'Startup health timeout',
    unknown: 'Error',
  };
  return labels[category] ?? 'Error';
}

export type ErrorRecoveryStatus = 'idle' | 'evaluating' | 'can_help' | 'cannot_help' | 'evaluation_failed';

export interface ErrorRecoveryEvaluation {
  status: ErrorRecoveryStatus;
  canHelp: boolean;
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  suggestedAction?: string;
  error?: string;
}

interface ErrorRecoveryCardProps {
  status: ErrorRecoveryStatus;
  errorCategory: SafeModeErrorCategory;
  evaluation: ErrorRecoveryEvaluation | null;
  startedAt: number | null;
  onLetRebelFix: () => void;
  onAskAnyway: () => void;
  onDismiss: () => void;
  onOpenDiagnostics?: () => void;
  onOpenCommunity?: () => void;
}

export function ErrorRecoveryCard({
  status,
  errorCategory,
  evaluation,
  startedAt,
  onLetRebelFix,
  onAskAnyway,
  onDismiss,
  onOpenDiagnostics,
  onOpenCommunity,
}: ErrorRecoveryCardProps) {
  const [quip, setQuip] = useState(() => getRandomQuip('intro'));
  const [showSuccessFlash, setShowSuccessFlash] = useState(false);

  // Update quip based on elapsed time during evaluation
  // Uses visibility-aware interval: pauses when tab is hidden (quips are UI-only)
  useVisibilityAwareInterval(
    () => {
      if (status !== 'evaluating' || !startedAt) return;
      const elapsed = Date.now() - startedAt;
      const bucket = getQuipBucket(elapsed);
      setQuip(getRandomQuip(bucket));
    },
    5500, // foreground: 5.5s
    null, // background: pause when hidden
    [status, startedAt]
  );

  // Flash success animation when transitioning to can_help
  useEffect(() => {
    if (status === 'can_help') {
      setShowSuccessFlash(true);
      const timer = setTimeout(() => setShowSuccessFlash(false), 300);
      return () => clearTimeout(timer);
    }
  }, [status]);

  const handleDismiss = useCallback(() => {
    onDismiss();
  }, [onDismiss]);

  if (status === 'idle') return null;

  const categoryLabel = getErrorCategoryLabel(errorCategory);

  return (
    <div className={styles.cardWrapper}>
      <div className={styles.card}>
        <button
          className={styles.dismissButton}
          onClick={handleDismiss}
          aria-label="Dismiss"
        >
          <X size={16} />
        </button>

        <div className={styles.header}>
          {/* Icon based on status */}
          {status === 'evaluating' && (
            <div className={`${styles.iconWrapper} ${styles.evaluating}`}>
              <Loader2 size={18} className={styles.spinner} />
            </div>
          )}
          {status === 'can_help' && (
            <div className={`${styles.iconWrapper} ${styles.canHelp} ${showSuccessFlash ? styles.successFlash : ''}`}>
              <CheckCircle size={18} />
            </div>
          )}
          {status === 'cannot_help' && (
            <div className={`${styles.iconWrapper} ${styles.cannotHelp}`}>
              <HelpCircle size={18} />
            </div>
          )}
          {status === 'evaluation_failed' && (
            <div className={`${styles.iconWrapper} ${styles.failed}`}>
              <AlertCircle size={18} />
            </div>
          )}

          <div className={styles.content}>
            {/* Title based on status */}
            {status === 'evaluating' && (
              <>
                <h3 className={styles.title}>{categoryLabel}</h3>
                <p className={styles.summary}>
                  Rebel is figuring out if it can help...
                </p>
                <p className={styles.quip}>{quip}</p>
              </>
            )}

            {status === 'can_help' && evaluation && (
              <>
                <h3 className={styles.title}>{categoryLabel}</h3>
                <p className={styles.summary}>{evaluation.summary}</p>
              </>
            )}

            {status === 'cannot_help' && evaluation && (
              <>
                <h3 className={styles.title}>{categoryLabel}</h3>
                <p className={styles.summary}>{evaluation.summary}</p>
              </>
            )}

            {status === 'evaluation_failed' && (
              <>
                <h3 className={styles.title}>{categoryLabel}</h3>
                <p className={styles.summary}>
                  {evaluation?.error
                    ? 'Hit a snag while investigating. These things happen.'
                    : 'Couldn\'t complete the analysis. I can still try to help.'}
                </p>
              </>
            )}
          </div>
        </div>

        {/* Actions based on status */}
        <div className={styles.actions}>
          {status === 'can_help' && (
            <>
              <Button onClick={onLetRebelFix} size="sm">
                Let Rebel fix it
              </Button>
              <Button variant="ghost" onClick={handleDismiss} size="sm">
                I'll handle it myself
              </Button>
            </>
          )}

          {status === 'cannot_help' && (
            <>
              <Button variant="secondary" onClick={onAskAnyway} size="sm">
                Ask Rebel anyway
              </Button>
              {onOpenCommunity && (
                <Button variant="ghost" onClick={onOpenCommunity} size="sm">
                  <ExternalLink size={14} />
                  Get community help
                </Button>
              )}
              {onOpenDiagnostics && (
                <Button variant="ghost" onClick={onOpenDiagnostics} size="sm">
                  Check Diagnostics
                </Button>
              )}
            </>
          )}

          {status === 'evaluation_failed' && (
            <>
              <Button variant="secondary" onClick={onAskAnyway} size="sm">
                Ask Rebel anyway
              </Button>
              {onOpenDiagnostics && (
                <Button variant="ghost" onClick={onOpenDiagnostics} size="sm">
                  Check Diagnostics
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

ErrorRecoveryCard.displayName = 'ErrorRecoveryCard';
