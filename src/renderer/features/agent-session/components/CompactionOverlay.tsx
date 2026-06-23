import { memo, useEffect, useState, useCallback } from 'react';
import type { ExhaustedReason } from '@renderer/features/agent-session/store/sessionStore';
import styles from './CompactionOverlay.module.css';

export type CompactionPhase =
  | 'idle'
  | 'compacting'
  | 'revealing'
  | 'continuing'
  | 'skeleton'
  | 'recovery_model'
  | 'unavailable'
  | 'error';

export type CompactionOverlayProps = {
  isOpen: boolean;
  phase: CompactionPhase;
  statusMessage: string;
  depth: number;
  onDismiss: () => void;
  /**
   * Terminal exhaustion reason for the `error` phase. Drives reason-aware copy:
   * `agent_loop_error_after_recovery` (compaction succeeded, the post-recovery
   * step failed) gets a distinct, accurate message instead of the misleading
   * "still too large" copy. Null/other reasons keep the existing copy.
   */
  reason?: ExhaustedReason | null;
};

type PhaseContent = {
  headline: string;
  subtext: string;
  subtextRetry?: string;
  progress?: string;
  /**
   * Label for the error/unavailable-phase action button. The button's ACTION is
   * always dismiss/close (`onDismiss`) — this only changes the wording so it
   * matches the copy (e.g. "Close" when the subtext tells the user to re-send
   * from the composer). Defaults to "Start fresh" when unset.
   */
  buttonLabel?: string;
};

const DEFAULT_ERROR_BUTTON_LABEL = 'Start fresh';

const PHASE_CONTENT: Record<CompactionPhase, PhaseContent> = {
  idle: {
    headline: '',
    subtext: ''
  },
  compacting: {
    headline: 'Tidying the conversation',
    subtext: "This conversation got large, so I'm keeping the important parts and clearing the scaffolding. Same mission, less furniture.",
    subtextRetry: "Still a little bulky. I'm packing lighter and keeping the essentials.",
    progress: 'Creating your conversation snapshot...'
  },
  revealing: {
    headline: 'All packed',
    subtext: 'Got everything we need. Picking up where we left off.',
    subtextRetry: 'Packed lighter this time. Continuing.'
  },
  continuing: {
    headline: "And we're back",
    subtext: 'Fresh workspace, same mission. Continuing with your request.'
  },
  skeleton: {
    headline: 'Keeping the core thread',
    subtext: "I'm trimming older tool work and keeping your request, the useful results, and the latest summary. Ask me to redo any detail that matters."
  },
  recovery_model: {
    headline: 'Using the recovery model',
    subtext: "The usual cleanup still left too much on the desk, so I'm using the recovery model to finish this turn. Quietly dramatic, mostly useful."
  },
  unavailable: {
    headline: 'Recovery model unavailable',
    subtext: "I couldn't use the recovery model this time. It may be disconnected, rate-limited, or not set up. I won't pretend otherwise."
  },
  error: {
    headline: 'This conversation needs a fresh start',
    subtext: "I kept the important parts and tried the recovery model, but this thread is still too large to continue safely. Start a new conversation with the essentials and I'll pick it up from there."
  }
};

// Reason-specific copy for the `error` phase (highest priority). Each reason
// here gets bespoke wording. `agent_loop_error_after_recovery` means compaction
// SUCCEEDED but the post-recovery step (provider/connection) failed (REBEL-5BM).
const ERROR_REASON_CONTENT: Partial<Record<ExhaustedReason, PhaseContent>> = {
  agent_loop_error_after_recovery: {
    headline: 'That cleanup worked. The next step tripped.',
    subtext: "I kept the important parts and retried your request, but the model or connection hit a snag — usually temporary. Close this and send your message again; I'll pick up from the preserved context.",
    // Action stays dismiss/close (context is preserved); label says "Close" so it
    // matches the "send your message again" guidance rather than "Start fresh".
    buttonLabel: 'Close'
  }
};

// Error-copy bucket for each terminal exhaustion reason.
type ErrorCopyBucket =
  // Genuine size/capacity failure — keep the "this conversation is too large /
  // needs a fresh start" copy (`PHASE_CONTENT.error`, "Start fresh" button).
  | 'size'
  // Everything else (provider/connection/profile/abort/edge) — accurate copy that
  // does NOT falsely claim the conversation is too large (`NEUTRAL_ERROR_CONTENT`).
  | 'neutral';

// EXHAUSTIVE classification of every `ExhaustedReason` into a copy bucket. This is
// the kill-by-construction guard (REBEL-5BM follow-up — 260607_invert_overlay_error_copy
// + 260607_reason_aware_recovery_overlay_copy): because it is an exhaustive
// `Record<ExhaustedReason, ...>` (not the prior allow-list `Set`), adding a new
// `ExhaustedReason` union member fails to COMPILE here until it explicitly picks
// 'size' or 'neutral'. A new recovery reason can therefore never silently inherit
// the wrong copy. Bespoke per-reason wording (`ERROR_REASON_CONTENT`) still layers
// on top of the bucket. Size reasons VERIFIED against recoveryPipeline.ts +
// recoveryStateMachine.ts (2026-05-31):
//   - summary_generation_failed: compaction/skeleton produced no usable summary.
//   - depth_limit_reached: exhausted the depth ladder; still overflowing.
//   - attempt_limit_reached: sibling capacity-exhaustion reason (future wiring).
const ERROR_COPY_BUCKET: Record<ExhaustedReason, ErrorCopyBucket> = {
  summary_generation_failed: 'size',
  depth_limit_reached: 'size',
  attempt_limit_reached: 'size',
  no_qualifying_profile: 'neutral',
  rate_limited: 'neutral',
  recovery_disabled: 'neutral',
  no_messages_to_compact: 'neutral',
  agent_loop_error_before_recovery: 'neutral',
  agent_loop_error_after_recovery: 'neutral',
  long_context_fallback_failed: 'neutral',
  aborted: 'neutral',
};

// Neutral DEFAULT for the error phase — used for every reason that is NOT a
// genuine size failure and has no bespoke copy: provider/connection failures
// (long_context_fallback_failed), aborts, null/unknown, and any future reason.
// Accurate without falsely claiming the conversation is too large. Dismiss/close
// action (context preserved); the user re-sends from the composer.
const NEUTRAL_ERROR_CONTENT: PhaseContent = {
  headline: "That step didn't complete.",
  subtext: "I kept the important parts, but the last step didn't finish — often a temporary model or connection issue. Close this and try again; I'll pick up from the preserved context.",
  buttonLabel: 'Close'
};

// Resolve error-phase content. Priority: bespoke reason copy > size copy > neutral.
// "Too large" is OPT-IN via the exhaustive ERROR_COPY_BUCKET classifier above, so a
// reason only reads as a size problem when it is explicitly bucketed 'size'.
//
// OPEN-UNION SAFETY: `ExhaustedReason` is derived from `AgentEvent`, which arrives
// over IPC/stream + JSON, so a runtime `reason` value outside the compile-time union
// is possible — INCLUDING prototype keys (`__proto__`, `constructor`, `toString`).
// Both maps are plain objects, so a bare `MAP[reason]` would return an INHERITED
// member (e.g. `Object.prototype.toString`) for such keys and bypass the intended
// neutral fallback. Guard every lookup with `Object.hasOwn` so only genuine own-keys
// match; null/undefined/unmatched/prototype-key all fall through to
// NEUTRAL_ERROR_CONTENT. We deliberately do NOT `assertNever` the incoming reason
// value (that would crash the overlay on an unexpected runtime value); the
// compile-time exhaustiveness lives in the ERROR_COPY_BUCKET literal, not here.
function resolveErrorContent(reason: ExhaustedReason | null | undefined): PhaseContent {
  const specific = reason && Object.hasOwn(ERROR_REASON_CONTENT, reason) ? ERROR_REASON_CONTENT[reason] : undefined;
  if (specific) return specific;
  const bucket = reason && Object.hasOwn(ERROR_COPY_BUCKET, reason) ? ERROR_COPY_BUCKET[reason] : undefined;
  if (bucket === 'size') return PHASE_CONTENT.error;
  return NEUTRAL_ERROR_CONTENT;
}

const CompactionOverlayComponent = ({
  isOpen,
  phase,
  statusMessage,
  depth,
  onDismiss,
  reason
}: CompactionOverlayProps) => {
  const [isExiting, setIsExiting] = useState(false);

  const handleDismiss = useCallback(() => {
    setIsExiting(true);
    setTimeout(() => {
      onDismiss();
    }, 400);
  }, [onDismiss]);

  // Reset exit state when overlay opens, trigger exit when phase becomes idle
  useEffect(() => {
    if (isOpen && phase !== 'idle') {
      setIsExiting(false);
    }
  }, [isOpen, phase]);

  if (!isOpen) {
    return null;
  }

  // For the error phase, resolve reason-aware copy via the allow-list (bespoke
  // reason copy > genuine size copy > neutral default). Other phases are unchanged.
  const content = phase === 'error' ? resolveErrorContent(reason) : PHASE_CONTENT[phase];
  const isRetry = depth > 1;
  const headline = content.headline || statusMessage;
  const subtext = (isRetry && content.subtextRetry) ? content.subtextRetry : content.subtext;
  const progressText = content.progress || 'Processing...';
  const errorButtonLabel = content.buttonLabel ?? DEFAULT_ERROR_BUTTON_LABEL;
  const showSpinner = phase === 'compacting' || phase === 'skeleton' || phase === 'recovery_model';
  const crystalPhase =
    phase === 'error' || phase === 'unavailable'
      ? 'error'
      : phase === 'revealing' || phase === 'continuing'
        ? 'revealing'
        : 'compacting';

  return (
    <div 
      className={styles.overlay} 
      data-phase={isExiting ? 'exiting' : phase}
      role="dialog"
      aria-modal="true"
      aria-labelledby="compaction-headline"
    >
      {/* Background blobs */}
      <div className={styles.blobs}>
        <div className={styles.blob1} />
        <div className={styles.blob2} />
      </div>

      {/* Central content */}
      <div className={styles.content}>
        {/* Crystal orb */}
        <div className={styles.crystalOrb} data-phase={crystalPhase}>
          <div className={styles.crystalGlow} />
          <div className={styles.crystalCore} />
          {/* Compression particles */}
          <div className={styles.particles}>
            <div className={styles.particle} />
            <div className={styles.particle} />
            <div className={styles.particle} />
            <div className={styles.particle} />
            <div className={styles.particle} />
            <div className={styles.particle} />
          </div>
        </div>

        {/* Status text */}
        <div className={styles.status}>
          <h2 id="compaction-headline" className={styles.headline}>
            {headline}
          </h2>
          <p className={styles.subtext}>
            {subtext}
          </p>
          {showSpinner && (
            <div className={styles.progress}>
              <div className={styles.spinner} />
              <span>{progressText}</span>
            </div>
          )}
        </div>

        {(phase === 'error' || phase === 'unavailable') && (
          <button
            type="button"
            className={styles.continueButton}
            onClick={handleDismiss}
          >
            {errorButtonLabel}
          </button>
        )}
      </div>
    </div>
  );
};

export const CompactionOverlay = memo(CompactionOverlayComponent);
CompactionOverlay.displayName = 'CompactionOverlay';
