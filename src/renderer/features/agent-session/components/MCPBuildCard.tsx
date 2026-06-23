import { memo, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  Clock3,
  ExternalLink,
  PartyPopper,
  RefreshCw,
  Sparkles,
  Wrench,
  XCircle,
} from 'lucide-react';
import { Button, IconButton, Tooltip } from '@renderer/components/ui';
import { cn } from '@renderer/lib/utils';
import type { UserQuestionBatch } from '@shared/types';
import type { SubmittedSubstatus } from '@shared/utils/contributionStateMapping';
import { formatConnectorDisplayName } from '@shared/utils/formatConnectorDisplayName';
import loadingGif from '@renderer/assets/animations/loading.gif';
import { safeParseDetail } from '../utils/safeParseDetail';
import styles from './MCPBuildCard.module.css';

const REBEL_MASCOT_URL = 'https://storage.googleapis.com/mindstone-public-assets/rebel/rebel6.svg';

export type MCPBuildTool = {
  name: string;
  status?: 'pending' | 'pass' | 'fail';
  error?: string;
};

export type MCPBuildCardState =
  | {
      phase: 'testing-error';
      connectorName: string;
      tools: MCPBuildTool[];
      autoFixMessage?: string;
      /**
       * Raw last-transition error from the contribution store. Rendered on
       * the testing-error card as a muted hint so the user can see why the
       * testing gate rejected a premature `ready_to_submit`. May be a raw
       * string or a JSON-serialized evidence-insufficient payload from the
       * bridge evidence gate (Stage 2.5). Optional.
       */
      lastTransitionError?: string;
    }
  | {
      /**
       * Neutral progress state for Phase 4 (implementing) and Phase 6
       * (testing). No user action required — this card is informational
       * only so the long silent stretches of the build flow still have a
       * visible anchor.
       */
      phase: 'building';
      subphase: 'implementing' | 'testing';
      connectorName: string;
      tools: MCPBuildTool[];
    }
  | { phase: 'submit-prompt'; connectorName: string; tools: MCPBuildTool[] }
  | { phase: 'submitting'; connectorName: string }
  | {
      phase: 'github-check';
      connectorName: string;
      /**
       * The user's Rebel name (typically `userFirstName` from settings).
       * When present, it's shown on the "Use my Rebel name" option label so
       * the user knows how they'll be attributed. When missing, the option
       * falls back to a generic label. Stage 1 of
       * `docs/plans/260420_oss_mcp_backend_relay.md`.
       */
      rebelName?: string;
    }
  | {
      phase: 'submitted';
      connectorName: string;
      /** Optional helper text that varies by contribution substatus. */
      helperText?: string;
      /** Optional substatus for semantic identification of the submitted sub-phase. */
      substatus?: SubmittedSubstatus;
      /** Optional author attribution once the contribution has been submitted. */
      authorName?: string;
      /** GitHub PR URL for "View on GitHub" action. */
      prUrl?: string;
    };

function getSubmittedStatusLabel(state: Extract<MCPBuildCardState, { phase: 'submitted' }>): string {
  switch (state.substatus) {
    case 'pending_approval':
      return 'Waiting on a reviewer';
    case 'checks_failed':
      return 'Checks came back with notes';
    case 'changes_needed':
      return 'Reviewer asked for tweaks';
    case 'approved':
      return 'Approved';
    case 'published':
      return 'Live';
    case 'rejected':
      return 'Not accepted';
    default:
      return 'Under review';
  }
}

function getSubmittedStatusIcon(state: Extract<MCPBuildCardState, { phase: 'submitted' }>) {
  switch (state.substatus) {
    case 'checks_failed':
    case 'rejected':
      return XCircle;
    case 'changes_needed':
      return Wrench;
    case 'approved':
      return CheckCircle2;
    case 'published':
      return PartyPopper;
    default:
      return Clock3;
  }
}

function shouldShowSubmittedStatusIcon(
  state: Extract<MCPBuildCardState, { phase: 'submitted' }>,
): boolean {
  return state.substatus !== undefined && state.substatus !== 'under_review';
}

function getSubmittedStatusToneClassName(state: Extract<MCPBuildCardState, { phase: 'submitted' }>): string {
  switch (state.substatus) {
    case 'checks_failed':
    case 'changes_needed':
      return styles.statusBadgeWarning;
    case 'approved':
    case 'published':
      return styles.statusBadgeSuccess;
    case 'rejected':
      return styles.statusBadgeDanger;
    default:
      return styles.statusBadgeNeutral;
  }
}

export interface MCPBuildCardActionHandlers {
  onRunTest?: () => void;
  onReRunTest?: () => void;
  /** Open a support channel so the user can get help from the Mindstone team. */
  onContactTeam?: () => void;
  /**
   * "Add to the community" primary action. Returns `true` when the caller
   * has consumed the click (e.g. advanced to the attribution picker); `false`
   * when the click was a no-op (missing contribution record, session switched
   * mid-flight). The picker component uses this to decide whether to dismiss
   * the submit-prompt batch — Stage 1.1 C1 of 260420 OSS MCP backend relay.
   */
  onSubmitToCommunity?: () => void | Promise<void | boolean>;
  /**
   * Submit via the Mindstone relay using the user's Rebel name. Wired to the
   * "Use my Rebel name" option in the footer attribution picker when a Rebel
   * name is available. Resolves to `true` when the submission actually
   * completed (the picker may then be dismissed); `false` on any recoverable
   * failure — missing name, session switch, reAuthRequired, validation
   * errors — so the picker stays visible for retry. Stage 1.1 C1 of 260420
   * OSS MCP backend relay.
   *
   * 260424 PR-template revamp follow-up (addendum #2): the inline form that
   * previously collected Summary / Motivation / Notes was removed — the
   * agent-supplied `prTitle`/`prBody` and formatter defaults are now the
   * single source of PR content, so the handler no longer accepts form
   * values.
   */
  onUseRebelName?: () => Promise<boolean>;
  /**
   * Submit via the Mindstone relay anonymously (no attribution name).
   * Returns `true` on terminal success; `false` when the picker should
   * stay visible for retry. Stage 1.1 C1.
   */
  onAnonymous?: () => Promise<boolean>;
  /**
   * Submit via the direct GitHub fork/push/PR path. When the user is not
   * yet authenticated, the caller kicks off the OAuth flow before submit.
   * Kept as `onGitHubYes` for continuity with the prior 2-option card.
   * Returns `true` on terminal success, `false` on recoverable failure.
   * Stage 1.1 C1.
   */
  onGitHubYes?: () => Promise<boolean>;
  /** Action for changes_requested/ci_fail substatus — spawns a follow-up session. */
  onMakeChanges?: () => void;
  /** Trigger a GitHub status refresh. Server debounce (5 min) prevents excessive API calls. */
  onRefreshStatus?: () => void;
  /** Whether a refresh is currently in flight. */
  isRefreshing?: boolean;
  /** Open the GitHub PR in the default browser. */
  onViewOnGitHub?: (prUrl: string) => void;
  /** Open the connector's settings card in Settings. */
  onViewInSettings?: (connectorName: string) => void;
}

export interface MCPBuildCardProps extends MCPBuildCardActionHandlers {
  state: MCPBuildCardState;
  /** Visual variant: 'inline' for conversation flow, 'footer' for input area replacement */
  variant?: 'inline' | 'footer';
  /** True for OSS builds, where contribution sharing is not available. */
  isOssBuild?: boolean;
  // 260424 PR-template revamp follow-up (addendum #2): the Stage 5a
  // `enableContributionRelay` prop used to toggle the inline
  // `github-check` card between the 3-way picker and the 2-option
  // GitHub/Skip fallback. With the inline card removed (phase returns
  // null), the card no longer needs the flag. The flag still controls
  // the footer question batch — see `BuildMcpBuildQuestionBatchOptions`
  // below.
}

export interface BuildMcpBuildQuestionBatchOptions {
  /**
   * Stage 5a of `docs/plans/260420_oss_mcp_backend_relay.md`: when
   * `false`, the `github-check` batch collapses back to the pre-Stage-1
   * two-option card (`github-yes` / `github-skip`). When `true` or
   * `undefined` (legacy default), the three-option picker (Rebel name /
   * GitHub / Anonymous) is emitted. Only affects the `github-check`
   * branch; other phases are unchanged.
   */
  enableContributionRelay?: boolean;
  /** True for OSS builds, where the share question batch should be hidden. */
  isOssBuild?: boolean;
}

export function buildMcpBuildQuestionBatch(
  state: MCPBuildCardState,
  sessionId: string,
  options?: BuildMcpBuildQuestionBatchOptions,
): UserQuestionBatch | null {
  // Stage 5a: default to the 3-way picker so pre-Stage-5a callers
  // without the options arg keep the Stage 1 behaviour.
  const relayEnabled = options?.enableContributionRelay ?? true;
  const isOssBuild = options?.isOssBuild === true;

  // Stage 1.2 R3 (260420 OSS MCP backend relay): batch IDs include
  // `sessionId` so two sessions working on a connector with the same name
  // don't collide on dismissal state. Without this, answering (or
  // dismissing) the picker in session A also suppressed it in session B.
  // `sessionId` is the primary key; connector name and phase remain as
  // stable sub-keys for round-tripping across state transitions.
  const idBase = `mcp-build:${sessionId}:${state.connectorName}`;
  // Display-time title-case for user-facing strings (`apple-shortcuts` →
  // `Apple Shortcuts`). The raw `state.connectorName` stays the identifier
  // used for `idBase` and `onViewInSettings`, so matching/section-ID
  // lookups remain stable.
  const displayName = formatConnectorDisplayName(state.connectorName);
  if (state.phase === 'testing-error') {
    const resultLines = state.tools
      .map((t) => {
        const icon = t.status === 'pass' ? '✓' : t.status === 'fail' ? '✗' : '○';
        return `${icon} ${t.name}${t.error ? ` — ${t.error}` : ''}`;
      })
      .join('\n');
    const contextParts = [resultLines];
    if (state.autoFixMessage) contextParts.push(state.autoFixMessage);

    return {
      batchId: `${idBase}:testing-error`,
      toolUseId: `${idBase}:testing-error`,
      turnId: `${idBase}:testing-error`,
      sessionId,
      timestamp: Number.MAX_SAFE_INTEGER - 1,
      questions: [
        {
          id: 'mcp-build-testing-error-question',
          header: `${displayName} tool`,
          question: 'A few things need attention',
          context: contextParts.join('\n\n'),
          multiSelect: false,
          options: [
            {
              id: 're-run-check',
              label: 'Try again',
              description: 'Run the check again once the fixes are in.',
            },
            {
              id: 'contact-team',
              label: 'Contact the Mindstone team for help',
              description: 'Get in touch so we can help sort it out.',
            },
          ],
        },
      ],
    };
  }

  if (state.phase === 'submit-prompt') {
    if (isOssBuild) return null;

    return {
      batchId: `${idBase}:submit-prompt`,
      toolUseId: `${idBase}:submit-prompt`,
      turnId: `${idBase}:submit-prompt`,
      sessionId,
      timestamp: Number.MAX_SAFE_INTEGER - 1,
      questions: [
        {
          id: 'mcp-build-submit-question',
          header: `Your ${displayName} tool is ready`,
          question: 'Want to share it, or keep it private?',
          context: `Your ${displayName} tool works. Share it so other people can use it too, or keep it on your machine for now.`,
          multiSelect: false,
          options: [
            {
              id: 'add-to-community',
              label: 'Share it with everyone',
              description: 'Share it so other people can use it too.',
            },
            {
              id: 'keep-private',
              label: 'Keep it private',
              description: "Stay on your machine. You can share it later if you change your mind.",
            },
          ],
        },
      ],
    };
  }

  if (state.phase === 'github-check') {
    if (isOssBuild) return null;

    const rebelLabel = state.rebelName
      ? `Use my Rebel name (${state.rebelName})`
      : 'Use my Rebel name';
    // Stage 5a: when the relay flag is off (stable default), collapse
    // the picker back to the pre-Stage-1 2-option card so non-technical
    // users on stable see the known-working GitHub flow with a clean
    // "Skip for now" escape hatch. The 3-way picker ships to beta first.
    const githubCheckOptions = relayEnabled
      ? [
          {
            id: 'rebel-name',
            label: rebelLabel,
            description: 'Put your Rebel name on it. No GitHub needed.',
          },
          {
            id: 'github-yes',
            label: 'Use my GitHub account',
            description:
              "Put your GitHub name on it. We'll help you sign in if needed.",
          },
          {
            id: 'anonymous',
            label: 'Share anonymously',
            description: 'Share without a name attached.',
          },
        ]
      : [
          {
            id: 'github-yes',
            label: 'Use my GitHub account',
            description:
              "Put your GitHub name on it. We'll help you sign in if needed.",
          },
          {
            id: 'github-skip',
            label: 'Skip for now',
            description: 'You can connect your GitHub account later from Settings.',
          },
        ];
    const githubCheckContext = relayEnabled
      ? "We'll share your tool so other people can use it."
      : "We'll share your tool. GitHub lets us put your name on it.";
    return {
      batchId: `${idBase}:github-check`,
      toolUseId: `${idBase}:github-check`,
      turnId: `${idBase}:github-check`,
      sessionId,
      timestamp: Number.MAX_SAFE_INTEGER - 1,
      questions: [
        {
          id: 'mcp-build-github-question',
          // 260424 PR-template revamp follow-up (addendum #2): the
          // inline "One more thing" form was removed — the footer
          // picker now submits directly. "Share your tool" is a
          // cleaner framing now that there's no following step.
          header: 'Share your tool',
          question: relayEnabled
            ? 'Which name should we use when we share this?'
            : 'Use GitHub for this?',
          context: githubCheckContext,
          multiSelect: false,
          options: githubCheckOptions,
        },
      ],
    };
  }

  return null;
}

/**
 * Humanize the raw `lastTransitionError` string for inline display on the
 * testing-error card.
 *
 * Evidence-insufficient rejections from the bridge evidence gate (Stage 2.5)
 * arrive as JSON-serialized payloads describing why `ready_to_submit` was
 * rejected — those get a friendly, user-facing sentence. Other rejections
 * (plain-string transition errors) are passed through unchanged.
 *
 * Returns `null` if nothing meaningful can be rendered.
 */
function formatLastTransitionError(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    const parseResult = safeParseDetail(trimmed);
    if (parseResult.ok) {
      const parsed = parseResult.value as {
        reason?: string;
        observedPath?: string;
        expectedPathPrefix?: string;
      };
      if (parsed && typeof parsed === 'object' && parsed.reason === 'evidence-insufficient') {
        return 'I got ahead of myself. Trying it properly now.';
      }
      if (parsed && typeof parsed === 'object' && parsed.reason === 'non-canonical-path') {
        return 'Rebel saved the files in the wrong folder. Moving them now and trying again.';
      }
      if (parsed && typeof parsed === 'object' && parsed.reason === 'missing_se_evidence') {
        const chatSafeGuidance =
          typeof (parsed as { chatSafeGuidance?: unknown }).chatSafeGuidance === 'string'
            ? (parsed as { chatSafeGuidance: string }).chatSafeGuidance
            : 'Let me think this through properly before I share it.';
        return chatSafeGuidance;
      }
    }
    // not-ok (too-large / malformed) or no matching reason → fall through to raw
  }
  return trimmed;
}

function MCPBuildCardComponent({
  state,
  onRunTest: _onRunTest,
  onReRunTest,
  onSubmitToCommunity,
  onMakeChanges,
  onRefreshStatus,
  isRefreshing,
  onViewOnGitHub,
  onViewInSettings,
  variant = 'inline',
  isOssBuild = false,
}: MCPBuildCardProps) {
  const isFooter = variant === 'footer';
  const [submittedMascotFailed, setSubmittedMascotFailed] = useState(false);
  // Display-time title-case for user-facing strings (`apple-shortcuts` →
  // `Apple Shortcuts`). Identity uses (`onViewInSettings`, `idBase`) still
  // reach for `state.connectorName` so downstream logic (section-ID
  // lookup, batch keys) stays keyed on the raw connector slug.
  const displayName = formatConnectorDisplayName(state.connectorName);

  if (state.phase === 'testing-error') {
    const transitionErrorCopy = formatLastTransitionError(state.lastTransitionError);
    return (
      <section
        className={styles.card}
        role="region"
        aria-live="polite"
        aria-label={`${displayName} tool check results`}
      >
        <header className={styles.header}>
          <Sparkles size={16} className={styles.headerIcon} aria-hidden />
          <div>
            <p className={styles.title}>{displayName} tool</p>
            <p className={styles.subtitle}>Check results</p>
          </div>
        </header>

        <div className={styles.body}>
          {transitionErrorCopy && (
            <p className={styles.helperText}>{transitionErrorCopy}</p>
          )}
          <ul className={styles.toolList}>
            {state.tools.map((tool) => {
              const Icon =
                tool.status === 'pass'
                  ? CheckCircle2
                  : tool.status === 'fail'
                    ? XCircle
                    : Clock3;
              return (
                <li
                  key={tool.name}
                  className={cn(
                    styles.toolResultRow,
                    tool.status === 'fail' && styles.toolResultRowError,
                  )}
                >
                  <Icon
                    size={14}
                    className={cn(
                      styles.toolStatusIcon,
                      tool.status === 'pass' && styles.toolStatusIconPass,
                      tool.status === 'fail' && styles.toolStatusIconFail,
                    )}
                    aria-hidden
                  />
                  <span className={styles.toolName}>{tool.name}</span>
                  {tool.error && <span className={styles.toolError}>{tool.error}</span>}
                </li>
              );
            })}
          </ul>
          {state.autoFixMessage && (
            <p className={styles.autoFixMessage}>
              <Wrench size={14} aria-hidden />
              <span>{state.autoFixMessage}</span>
            </p>
          )}
        </div>

        <div className={styles.actions}>
          <Button size="sm" onClick={onReRunTest} disabled={!onReRunTest}>
            Try again
          </Button>
        </div>
      </section>
    );
  }

  if (state.phase === 'building') {
    const isTesting = state.subphase === 'testing';
    const title = isTesting
      ? `Trying out your ${displayName} tool`
      : `Building your ${displayName} tool`;
    const subtitle = isTesting
      ? 'Trying each part of the tool with real examples'
      : 'Putting the pieces together from the plan';
    const helperText = isTesting
      ? "We're trying each new action with realistic examples to make sure it actually works. This usually takes a minute or two. You'll see the share option once everything works."
      : "We're putting the pieces together. You'll see the share option once it works.";
    const ariaLabel = isTesting
      ? `Trying out your ${displayName} tool`
      : `Building your ${displayName} tool`;

    return (
      <section
        className={cn(styles.card, isFooter && styles.cardFooter)}
        role="region"
        aria-live="polite"
        aria-label={ariaLabel}
      >
        <header className={styles.header}>
          <img
            src={loadingGif}
            alt=""
            aria-hidden="true"
            className={styles.submittingSpinner}
          />
          <div>
            <p className={styles.title}>{title}</p>
            <p className={styles.subtitle}>{subtitle}</p>
          </div>
        </header>

        <div className={styles.body}>
          <p className={styles.helperText}>{helperText}</p>
        </div>
      </section>
    );
  }

  if (state.phase === 'submit-prompt') {
    if (isOssBuild) return null;

    return (
      <section
        className={cn(styles.card, styles.cardSuccess, isFooter && styles.cardFooter)}
        role="region"
        aria-live="polite"
        aria-label={`${displayName} tool ready to share`}
      >
        <header className={styles.header}>
          <CheckCircle2 size={16} className={styles.headerIconSuccess} aria-hidden />
          <div>
            <p className={styles.title}>{displayName} tool</p>
            <p className={styles.subtitle}>Everything worked</p>
          </div>
        </header>

        <div className={styles.body}>
          <p className={styles.helperText}>
            Your {displayName} tool works. Want to share it so other people can use it too?
          </p>
        </div>

        <div className={styles.actions}>
          <Button size="sm" onClick={onSubmitToCommunity} disabled={!onSubmitToCommunity}>
            Share it with everyone
          </Button>
        </div>
      </section>
    );
  }

  if (state.phase === 'submitting') {
    return (
      <section
        className={cn(styles.card, isFooter && styles.cardFooter)}
        role="region"
        aria-live="polite"
        aria-label={`Sending out your ${displayName} tool`}
      >
        <header className={styles.header}>
          <img
            src={loadingGif}
            alt=""
            aria-hidden="true"
            className={styles.submittingSpinner}
          />
          <div>
            <p className={styles.title}>Sending out {displayName}</p>
            <p className={styles.subtitle}>Putting it where the reviewers can see it</p>
          </div>
        </header>

        <div className={styles.body}>
          <p className={styles.helperText}>
            This usually takes 20–30 seconds.
          </p>
        </div>
      </section>
    );
  }

  if (state.phase === 'github-check') {
    // 260424 PR-template revamp follow-up (addendum #2): the inline
    // `github-check` card has been removed. The footer question batch
    // (emitted by `buildMcpBuildQuestionBatch`) is the only attribution
    // surface — picking an option there submits the PR directly with
    // auto-generated summary/body, no intermediate form.
    //
    // Returning null means the conversation transcript has no inline
    // marker for the attribution step; the footer question batch is the
    // action surface and the `submitting` → `submitted` phases still
    // emit their inline cards, so there is no gap in the visible flow.
    return null;
  }

  // submitted phase — helperText varies by substatus
  const submittedHelperText = state.helperText
    ?? "A reviewer is taking a look now to make sure everything works well and is ready to share. We'll let you know as soon as it's available to everyone.";

  const showMakeChangesAction = state.substatus === 'changes_needed' || state.substatus === 'checks_failed';
  const { prUrl } = state;
  const SubmittedStatusIcon = getSubmittedStatusIcon(state);
  const submittedStatusLabel = getSubmittedStatusLabel(state);
  const showSubmittedStatusIcon = shouldShowSubmittedStatusIcon(state);

  return (
    <section
      className={cn(styles.card, styles.cardCelebration)}
      role="region"
      aria-live="polite"
      aria-label={`${displayName} tool sent for review`}
      data-substatus={state.substatus}
    >
      <header className={cn(styles.header, styles.submittedHeader)}>
        <div className={styles.submittedIdentity}>
          <div className={styles.submittedAvatar} aria-hidden="true">
            {!submittedMascotFailed ? (
              <img
                src={REBEL_MASCOT_URL}
                alt=""
                className={styles.submittedMascot}
                onError={() => setSubmittedMascotFailed(true)}
              />
            ) : (
              <Bot size={18} className={styles.submittedAvatarFallback} />
            )}
          </div>
          <div className={styles.submittedTitleBlock}>
            <p className={styles.title}>Sent for review</p>
            {state.authorName && (
              <p className={styles.submittedByline}>by {state.authorName}</p>
            )}
          </div>
        </div>
        <div
          className={cn(styles.statusCluster, getSubmittedStatusToneClassName(state))}
          aria-live="polite"
        >
          <div className={styles.statusBadge}>
            {showSubmittedStatusIcon && <SubmittedStatusIcon size={12} aria-hidden />}
            <span>{submittedStatusLabel}</span>
          </div>
          {onRefreshStatus && (
            <>
              <span className={styles.statusDivider} aria-hidden="true" />
              <Tooltip content="Check for updates">
                <IconButton
                  size="xs"
                  className={styles.refreshButton}
                  onClick={onRefreshStatus}
                  disabled={isRefreshing}
                  aria-label="Check for updates"
                >
                  <RefreshCw
                    size={14}
                    className={cn(isRefreshing && styles.refreshSpin)}
                    aria-hidden
                  />
                </IconButton>
              </Tooltip>
            </>
          )}
        </div>
      </header>

      <div className={styles.body}>
        <p className={styles.helperText}>{submittedHelperText}</p>
        {isRefreshing && (
          <p className={styles.refreshHint} aria-live="polite">
            Checking for the latest update…
          </p>
        )}
      </div>

      <div className={styles.actions}>
        {showMakeChangesAction && (
          <Button size="sm" onClick={onMakeChanges} disabled={!onMakeChanges}>
            Make the tweaks
          </Button>
        )}
        {prUrl && onViewOnGitHub && (
          <Tooltip content="Open the review thread on GitHub">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onViewOnGitHub(prUrl)}
            >
              <ExternalLink size={14} aria-hidden />
              View on GitHub
            </Button>
          </Tooltip>
        )}
        {onViewInSettings && (
          <Tooltip content="Open this tool in Settings">
            <Button
              variant={showMakeChangesAction ? 'secondary' : 'default'}
              size="sm"
              onClick={() => onViewInSettings(state.connectorName)}
            >
              View in Settings
            </Button>
          </Tooltip>
        )}
      </div>
    </section>
  );
}

MCPBuildCardComponent.displayName = 'MCPBuildCard';

export const MCPBuildCard = memo(MCPBuildCardComponent);
