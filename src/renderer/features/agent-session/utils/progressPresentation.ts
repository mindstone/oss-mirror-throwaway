/**
 * Single source-of-truth presentation derivation for `ContextualProgressCard`.
 *
 * The card decides *how to render a finishing / finished turn* by reading a
 * handful of independent booleans (`isComplete`, `isThinking`, `isPaused`,
 * `silentStop.classification`, `isInterrupted`, `activity.hasError`) across
 * ~8 separate render branches plus four `!isInterrupted` CSS-class gates. Each
 * new terminal state previously forced edits at every branch — the exact bug
 * class a reviewer caught mid-prior-task (the "MA-2" silent inheritance of
 * complete-styling at four CSS sites).
 *
 * `deriveProgressPresentation` collapses that duplicated ladder into one place.
 * It computes a single discriminant `ProgressRenderState` (via the **as-coded
 * icon-ladder precedence**) and then resolves **each presentation slot via its
 * own ladder** — because the slots genuinely do NOT share one precedence:
 *
 *  - the icon ladder reads the FULL ladder
 *    (`silentStop → interrupted → complete → hasError → paused → subAgents →
 *    thinking → fallback`);
 *  - `headerText` reads a SHORTER ladder (`interrupted → paused → complete →
 *    else`) with no `silentStop`/`hasError` arm — so a silent-stop turn shows
 *    the complete/thinking header, not a silentStop-specific one (invariant #5);
 *  - `liveText` reads a SHORTER ladder (`interrupted → complete → else`) with no
 *    `paused`/`hasError`/`silentStop` arm — those fall through to the live
 *    status line (invariant #6).
 *
 * A static `Record<ProgressRenderState, Presentation>` keyed map cannot express
 * those shorter ladders without papering the silent-stop / paused rows with
 * "same as complete/thinking" fallthrough cells — the very mirror-copy drift the
 * refactor exists to prevent. A function that resolves each slot in one place is
 * both smaller and a truer model (Arbitrator Decision 2).
 *
 * The discriminant `switch` is locked with `assertNever` (Runtime Safety F4) and
 * the return type is **total** (every slot always populated) so a half-filled
 * state is a `tsc` error, not a blank slot at runtime.
 *
 * **Behaviour-preserving.** This encodes the EXISTING render behaviour; zero
 * intended visual change. The headline risk is silent drift, which the
 * per-state unit tests + the `data-state` contract are designed to contain.
 *
 * @see docs/plans/260528_terminal-state-presentation-health/PLAN.md (Stage 2)
 */

import { classifyTurnEnding, type TurnEndingInput } from '@shared/utils/turnEndingClassification';
import { assertNever } from '@shared/utils/assertNever';
import type { TurnInterruptionSource } from '@shared/constants/turnInterruption';
import type { StopClassification } from './detectSilentStop';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The single discriminant the card's `data-state` attribute + tests anchor on.
 *
 * 7 reachable render states + `superseded` (byte-identical to `complete` today)
 * + the folded-in `error` orphan tone (invariant #10). Named `ProgressRenderState`
 * rather than `TerminalState` because `live` / `paused` / `error` are
 * non-terminal (reachable mid-turn).
 */
export type ProgressRenderState =
  | 'live'
  | 'complete'
  | 'paused'
  | 'interrupted'
  | 'silent_stopped_user'
  | 'silent_stopped_await'
  | 'silent_stopped_unexpected'
  | 'superseded'
  | 'error';

/**
 * Which icon the card should render. The card owns the actual JSX (lucide
 * components + CSS-module class references); this enum just selects the branch
 * structurally so the icon ladder is no longer duplicated in three renderers.
 *
 * `silentStop` is rendered via the classification-specific `renderSilentStopIcon`
 * helper (StopCircle / MessageSquare / AlertTriangle) — the discriminant already
 * encodes which silent-stop classification we are in, so no extra payload needed.
 */
export type ProgressIconKind =
  | 'silent_stop'   // → renderSilentStopIcon() (classification-specific)
  | 'interrupted'   // → WifiOff .statusIconError / liveIconError (amber) — TRANSIENT NETWORK error only
  | 'closed'        // → Power .statusIconError / liveIconError (amber) — app quit (shutdown / unknown source)
  | 'restarted'     // → RotateCcw .statusIconError / liveIconError (amber) — crash/kill recovery (startup-correction)
  | 'complete'      // → Check .statusIconDone / liveIconDone (green)
  | 'error'         // → AlertTriangle .statusIconError / liveIconError (amber)
  | 'paused'        // → Brain .statusIndicator / liveIconStatic
  | 'sub_agents'    // → assistant indicator
  | 'thinking'      // → loading GIF (collapsed/live) / null (expanded header)
  | 'fallback';     // → RefreshCw (collapsed) / Brain static (live) / null (expanded header)

/**
 * The headers the card can show (short ladder; no silentStop/hasError arm).
 */
export type ProgressHeaderText =
  | 'Rebel was interrupted'  // generic / transient-network OR pre-discriminator app-close
  | 'Rebel was closed'       // app-close interruption, source: 'shutdown'
  | 'Rebel restarted'        // app-close interruption, source: 'startup-correction'
  | 'Rebel paused'
  | 'How Rebel did this'
  | "Rebel’s thinking";

export interface ProgressPresentation {
  /** The single discriminant. Emitted as `data-state`; tests anchor here. */
  dataState: ProgressRenderState;
  /** Expanded-card header text (short ladder — invariant #5). */
  headerText: ProgressHeaderText;
  /**
   * `liveText` kind (short ladder — invariant #6). The card resolves the actual
   * node: `interrupted`/`complete` are fixed strings; `default` falls through to
   * the MCP-build JSX / `activity.statusLine` (+ tip Info icon) exactly as today.
   */
  liveTextKind: 'interrupted' | 'complete' | 'default';
  /** Icon-ladder result (full ladder) for the collapsed + expanded-header icon. */
  iconKind: ProgressIconKind;
  /**
   * Live-section indicator icon kind. Identical to `iconKind` EXCEPT it has no
   * `silent_stop` arm (renderLiveIndicator #6 omits it) — a `hasSilentStop` turn
   * shows the silent-stop icon in the collapsed/expanded *header* but falls
   * through to Check/WifiOff/Brain in the *live-section* icon. Existing
   * divergence; preserved byte-identical.
   */
  liveIconKind: ProgressIconKind;
  /** Expanded section-label text: `(isComplete || isInterrupted) ? 'Result' : 'Doing right now'`. */
  sectionLabelText: 'Result' | 'Doing right now';
  /**
   * The four `!isInterrupted` CSS gates, made structural (invariant #4). Each is
   * preserved as-coded — note `collapsedStatusComplete` additionally excludes
   * silentStop (`:510`) while `sectionLabelComplete`/`liveTextDone` do NOT
   * exclude it (`:599`/`:615`/`:637`). This silentStop+complete asymmetry is the
   * as-coded inconsistency flagged in invariant #13 — preserved, NOT fixed.
   */
  cssGates: {
    /** `.statusTextComplete` (collapsed): `isComplete && !isInterrupted && !silentStop.hasSilentStop`. */
    collapsedStatusComplete: boolean;
    /** `.sectionLabelComplete` (expanded label): `isComplete && !isInterrupted`. */
    sectionLabelComplete: boolean;
    /** `.liveTextDone` (×2 live-text gates): `isComplete && !isInterrupted`. */
    liveTextDone: boolean;
  };
}

export interface ProgressPresentationInputs {
  isThinking: boolean;
  isPaused: boolean;
  /** Sticky `hadActivity` (NOT the raw prop) — drives `isComplete`. */
  isComplete: boolean;
  /** `classifyTurnEnding(endedWith).kind === 'transient_error'`. */
  endedWith: TurnEndingInput;
  silentStop: {
    hasSilentStop: boolean;
    classification: StopClassification;
    /**
     * For the app-closed `interrupted` classification only: WHY the turn was cut
     * off (quit vs crash). Drives the source-aware header + non-network icon.
     * `undefined` for transient-network interruptions and pre-discriminator
     * sessions (→ generic "Rebel was interrupted" / Power icon).
     */
    interruptionSource?: TurnInterruptionSource;
  };
  /** Tool-level error in the current activity (orphan amber tone — invariant #10). */
  hasError: boolean;
  /** Whether ≥1 sub-agent is running (icon-ladder `sub_agents` arm). */
  hasRunningSubAgents: boolean;
}

// ---------------------------------------------------------------------------
// App-close source — distinguishes the two `interrupted` flavours
// ---------------------------------------------------------------------------

/**
 * Header-text selector for the `interrupted` render state:
 *  - `shutdown` / `startup-correction` — the app closed (quit vs crash); the
 *    header names WHAT happened ("Rebel was closed" / "Rebel restarted") and the
 *    UI must NOT imply a network problem (FOX-2771 follow-up).
 *  - `none` — no source-specific header override. Covers BOTH a genuine
 *    transient-network drop (`endedWith: 'transient_error'`, keeps WifiOff +
 *    "Connection dropped") AND an app-close interruption from a pre-discriminator
 *    session (source field absent). Both render the generic "Rebel was
 *    interrupted" header; the icon resolver separately picks Power-vs-WifiOff via
 *    `silentStop.classification === 'interrupted'`.
 */
type AppCloseSource = TurnInterruptionSource | 'none';

/**
 * Resolve the app-close source for the `interrupted` render state. Returns the
 * `shutdown`/`startup-correction` discriminator when the silent-stop classifier
 * said `interrupted`; `'none'` otherwise (transient-network OR pre-discriminator
 * app-close — both get the generic header). The icon resolver separately checks
 * `silentStop.classification === 'interrupted'` to pick network-vs-Power for the
 * `'none'` case.
 */
function deriveAppCloseSource(inputs: ProgressPresentationInputs): AppCloseSource {
  if (inputs.silentStop.classification !== 'interrupted') return 'none';
  return inputs.silentStop.interruptionSource ?? 'none';
}

// ---------------------------------------------------------------------------
// Discriminant — the single icon-ladder precedence
// ---------------------------------------------------------------------------

/**
 * Compute the discriminant `ProgressRenderState` once, using the **as-coded
 * icon-ladder precedence** from `renderCollapsedIndicator`/
 * `renderExpandedHeaderIndicator` (Map A §A.1):
 *
 *   silentStop.hasSilentStop → isInterrupted → isComplete → activity.hasError
 *   → isPaused → subAgents → isThinking → fallback
 *
 * Notes on precedence collisions (pinned by tests):
 *  - A production transient-error turn carries an `error` event → `detectSilentStop`
 *    → `error_exit` → `hasSilentStop: false`, so the silentStop arm is skipped and
 *    `interrupted` wins (invariant #2).
 *  - `isInterrupted` precedes `isComplete` (`isComplete` goes true on a terminal
 *    error turn — without the gate it inherits green-Check/Done = the MA-2 bug;
 *    invariant #3).
 *  - `superseded` falls through to `complete` byte-identical (invariant #8) but is
 *    its own discriminant so a future distinct treatment is a one-place edit.
 *  - `error` (orphan tool-error tone) sits BELOW interrupted/complete — icon-only
 *    amber, text falls through (invariant #10).
 */
function deriveRenderState(inputs: ProgressPresentationInputs): ProgressRenderState {
  // `isThinking`, `hasRunningSubAgents` are NOT read here — thinking, sub-agent,
  // and bare-fallback all collapse to the `live` discriminant (the icon ladder
  // re-derives which of those three icons to show via deriveIconKind). They are
  // part of the inputs only so the icon resolvers can read them.
  const { isPaused, isComplete, endedWith, silentStop, hasError } = inputs;

  const ending = classifyTurnEnding(endedWith).kind;
  const isInterrupted = ending === 'transient_error';

  // 1. silentStop (only when hasSilentStop === true; error_exit/superseded return false)
  if (silentStop.hasSilentStop) {
    switch (silentStop.classification) {
      case 'unexpected_stop':
        return 'silent_stopped_unexpected';
      case 'awaiting_user':
        return 'silent_stopped_await';
      // App-closed interruption (Stage 1a, FOX-2771): reuse the existing
      // `interrupted` render state (no green-Done inheritance) but the
      // presentation is source-aware — a NON-network icon (Power / RotateCcw)
      // and a "closed"/"restarted" header, never the WifiOff connectivity
      // metaphor (FOX-2771 follow-up). The card overrides the live-text copy.
      case 'interrupted':
        return 'interrupted';
      // `user_stopped` is the StopCircle .statusIconInfo default in renderSilentStopIcon.
      // (`none`/`superseded`/`error_exit` never reach here — hasSilentStop is false for them —
      // but they fall to the same StopCircle default as-coded if they ever did.)
      default:
        return 'silent_stopped_user';
    }
  }

  // 2. isInterrupted (transient_error)
  if (isInterrupted) return 'interrupted';

  // 3. isComplete — but superseded keeps its own discriminant (byte-identical to complete)
  if (isComplete) {
    return ending === 'superseded' ? 'superseded' : 'complete';
  }

  // 4. orphan tool-error tone (below interrupted/complete; non-terminal)
  if (hasError) return 'error';

  // 5. paused
  if (isPaused) return 'paused';

  // 6. sub-agents → the assistant indicator; modelled as part of `live` for
  //    text/label purposes (no distinct header/liveText). The icon ladder picks
  //    `sub_agents` separately (deriveIconKind reads hasRunningSubAgents).
  // 7. thinking / fallback → `live`.
  return 'live';
}

// ---------------------------------------------------------------------------
// Per-slot resolvers (each its own ladder — the asymmetry is honest here)
// ---------------------------------------------------------------------------

/**
 * `cardHeaderText` short ladder (#1): `isInterrupted → isPaused → isComplete →
 * else`. No silentStop arm, no hasError arm — so silent-stop / error / live all
 * share the same header (invariant #5).
 *
 * Deliberately reads the raw `isPaused`/`isComplete` booleans rather than the
 * `ProgressRenderState` discriminant: the header ladder is genuinely SHORTER than
 * the icon ladder (it has no silentStop/error/subAgents arms), so collapsing it
 * onto the discriminant would force silent-stop/error states to carry a header
 * value they don't actually own. Per-slot ladders keep the asymmetry honest.
 */
function deriveHeaderText(
  state: ProgressRenderState,
  isPaused: boolean,
  isComplete: boolean,
  appCloseSource: AppCloseSource,
): ProgressHeaderText {
  if (state === 'interrupted') {
    // App-close interruption: say WHAT happened (closed vs restarted) instead of
    // the network-implying generic. `none` (transient-network or
    // pre-discriminator) keeps the generic header.
    switch (appCloseSource) {
      case 'shutdown':
        return 'Rebel was closed';
      case 'startup-correction':
        return 'Rebel restarted';
      case 'none':
        return 'Rebel was interrupted';
      default:
        return assertNever(appCloseSource, 'deriveHeaderText');
    }
  }
  if (isPaused) return 'Rebel paused';
  if (isComplete) return 'How Rebel did this';
  return "Rebel’s thinking";
}

/**
 * `renderLiveTextContent` short ladder (#5): `isInterrupted → isComplete →
 * (mcpBuild) → else(statusLine)`. The mcpBuild + statusLine fall-through stays in
 * the component (it needs JSX + the `isTip` icon); we surface only which of the
 * three top arms applies.
 */
function deriveLiveTextKind(
  state: ProgressRenderState,
  isComplete: boolean,
): ProgressPresentation['liveTextKind'] {
  if (state === 'interrupted') return 'interrupted';
  // `superseded` is complete-equivalent; complete shows "Finished" too.
  if (isComplete) return 'complete';
  return 'default';
}

/**
 * The full icon ladder (collapsed #3 / expanded-header #4). `paused` shows Brain,
 * sub-agents show the assistant indicator, thinking shows the GIF, fallback the
 * RefreshCw / null. We re-derive sub-agents/thinking here (the discriminant
 * folds them into `live`).
 */
/**
 * Resolve the icon kind for the `interrupted` render state. App-close
 * interruptions (silent-stop classification `interrupted`) get a NON-network
 * icon — `RotateCcw` for crash recovery (`startup-correction`), `Power` for a
 * deliberate quit (`shutdown`) AND for pre-discriminator sessions (unknown
 * source) — because they are NOT connectivity events (FOX-2771 follow-up).
 * Genuine transient-network interruptions keep `WifiOff`.
 */
function deriveInterruptedIconKind(inputs: ProgressPresentationInputs): ProgressIconKind {
  if (inputs.silentStop.classification !== 'interrupted') return 'interrupted'; // transient-network → WifiOff
  return inputs.silentStop.interruptionSource === 'startup-correction' ? 'restarted' : 'closed';
}

function deriveIconKind(
  state: ProgressRenderState,
  inputs: ProgressPresentationInputs,
): ProgressIconKind {
  const { isThinking, hasRunningSubAgents } = inputs;
  switch (state) {
    case 'silent_stopped_user':
    case 'silent_stopped_await':
    case 'silent_stopped_unexpected':
      return 'silent_stop';
    case 'interrupted':
      return deriveInterruptedIconKind(inputs);
    case 'complete':
    case 'superseded':
      return 'complete';
    case 'error':
      return 'error';
    case 'paused':
      return 'paused';
    case 'live':
      if (hasRunningSubAgents) return 'sub_agents';
      if (isThinking) return 'thinking';
      return 'fallback';
    default:
      return assertNever(state, 'deriveIconKind');
  }
}

/**
 * The live-section indicator ladder (#6) — identical to {@link deriveIconKind}
 * EXCEPT no `silent_stop` arm. A `hasSilentStop` turn falls through to the
 * interrupted/complete/error/paused/subAgents/thinking arms here (existing
 * divergence; preserved). Because `hasSilentStop === true` means the discriminant
 * is one of the three `silent_stopped_*` states, we must recompute the lower arms
 * from the raw signals.
 */
function deriveLiveIconKind(
  state: ProgressRenderState,
  inputs: ProgressPresentationInputs,
): ProgressIconKind {
  const { isThinking, isPaused, isComplete, endedWith, hasError, hasRunningSubAgents } = inputs;

  // For non-silent-stop states the live icon matches the header icon.
  if (
    state !== 'silent_stopped_user' &&
    state !== 'silent_stopped_await' &&
    state !== 'silent_stopped_unexpected'
  ) {
    return deriveIconKind(state, inputs);
  }

  // Silent-stop turn: the live-section icon has NO silentStop arm, so replay the
  // shorter live ladder (`interrupted → complete → hasError → paused → subAgents
  // → thinking → fallback`) from the raw signals.
  if (classifyTurnEnding(endedWith).kind === 'transient_error') return 'interrupted';
  if (isComplete) return 'complete';
  if (hasError) return 'error';
  if (isPaused) return 'paused';
  if (hasRunningSubAgents) return 'sub_agents';
  if (isThinking) return 'thinking';
  return 'fallback';
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function deriveProgressPresentation(
  inputs: ProgressPresentationInputs,
): ProgressPresentation {
  const { isPaused, isComplete, endedWith, silentStop } = inputs;

  const dataState = deriveRenderState(inputs);
  const appCloseSource = deriveAppCloseSource(inputs);
  // Interrupted-for-presentation: the original transient-error signal OR the
  // app-closed silent-stop classification (Stage 1a) which also resolves to
  // the `interrupted` render state. Widening (never narrowing) the existing
  // `!isInterrupted` CSS gates so app-closed turns don't inherit the green
  // Done tint either.
  const isInterrupted =
    classifyTurnEnding(endedWith).kind === 'transient_error' || dataState === 'interrupted';

  return {
    dataState,
    headerText: deriveHeaderText(dataState, isPaused, isComplete, appCloseSource),
    liveTextKind: deriveLiveTextKind(dataState, isComplete),
    iconKind: deriveIconKind(dataState, inputs),
    liveIconKind: deriveLiveIconKind(dataState, inputs),
    // `(isComplete || isInterrupted) ? 'Result' : 'Doing right now'` (#8 text).
    sectionLabelText: (isComplete || isInterrupted) ? 'Result' : 'Doing right now',
    cssGates: {
      // `:510` — collapsed complete tint EXCLUDES silentStop (as-coded).
      collapsedStatusComplete: isComplete && !isInterrupted && !silentStop.hasSilentStop,
      // `:599` — expanded label complete tint does NOT exclude silentStop (as-coded; #13).
      sectionLabelComplete: isComplete && !isInterrupted,
      // `:615` / `:637` — live-text done tint does NOT exclude silentStop (as-coded; #13).
      liveTextDone: isComplete && !isInterrupted,
    },
  };
}
