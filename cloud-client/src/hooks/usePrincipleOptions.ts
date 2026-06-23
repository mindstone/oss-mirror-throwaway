/**
 * usePrincipleOptions
 *
 * Shared hook encapsulating the multi-choice principle selection state machine.
 * Moved from `src/renderer/components/approval/hooks/usePrincipleOptions.ts`
 * in Stage 4 of the cross-surface approval consolidation plan
 * (`docs/plans/260416_centralize_approval_and_diff_viewing_ux.md`).
 *
 * Key differences from the pre-Stage-4 renderer version:
 *  - Takes an `ApprovalTransport` parameter instead of reaching into
 *    `window.safetyPromptApi.*` / `window.settingsApi.*`. Desktop injects the
 *    `desktopApprovalTransport`; mobile injects `mobileApprovalTransport`. All
 *    the behaviour (generation retry, trusted-tool confirmation, persistence)
 *    is preserved verbatim; only the IPC call sites changed.
 *  - Persistence (previously `window.safetyPromptApi.update(...)`) now routes
 *    through `transport.safetyPrompt.update(...)` — the single write path
 *    required by D10. Desktop's local-mode adapter still writes locally; cloud
 *    mode routes the same call through cloud-service.
 *
 * Lifecycle:
 * 1. Caller invokes startGeneration() to trigger option generation (guarded — only fires once)
 * 2. User selects an option (or enters free text for "Other")
 * 3. User clicks Confirm:
 *    - trusted_tool scope:
 *      - non-memory tools → transitions to confirming_trust (inline confirmation)
 *      - memory_write → applies directly via transport.safetyPrompt.applySelection
 *    - other scopes → calls transport.safetyPrompt.applySelection
 * 4. On unmount, guards against state updates on unmounted component
 */

import { useState, useCallback, useEffect, useRef } from 'react';

import type {
  ApprovalTransport,
  BlockedActionContext,
  PrincipleDirection,
  PrincipleOption,
  PrincipleOptionScope,
} from '../transport/approvalTransport';

// Re-export for consumer convenience (preserves the previous renderer API).
export type { PrincipleOption, PrincipleOptionScope, PrincipleDirection };

type GenerationState = 'idle' | 'loading' | 'loaded' | 'error';
type ApplyState = 'idle' | 'applying' | 'confirming_trust' | 'applied' | 'error';

/**
 * BlockedActionContext subset the hook consumes. Kept narrow so tests and
 * callers don't need to assemble the full transport-shape for every blocked
 * action; this matches the pre-Stage-4 renderer signature.
 */
type HookBlockedAction = Pick<
  BlockedActionContext,
  'toolName' | 'toolInput' | 'blockReason' | 'spaceDescription'
>;

export interface UsePrincipleOptionsArgs {
  /**
   * Transport adapter — platform-specific IPC bridge. Desktop passes the
   * `desktopApprovalTransport` (via the renderer re-export wrapper); mobile
   * builds a `mobileApprovalTransport` from `@rebel/cloud-client.ipcCall`.
   */
  transport: ApprovalTransport;
  /** The blocked action context (toolName, input, reason) */
  blockedAction: HookBlockedAction | null;
  /** The effective tool ID for trustedTools writes (falls back to toolName) */
  effectiveToolId: string | null;
  /** Package name for trustedTools serverHint */
  packageName?: string;
  /** Called when the user approves the action (after principle applied or trusted tool added) */
  onApprove: () => void;
  /** Direction: 'allow' generates allow principles, 'deny' generates block principles. Default: 'allow'. */
  direction?: PrincipleDirection;
  /** Called when the user denies the action (after deny principle applied). Only used when direction='deny'. */
  onDeny?: () => void;
}

export interface UsePrincipleOptionsReturn {
  /** Current generation state */
  generationState: GenerationState;
  /** Generated options (3 items) */
  options: PrincipleOption[];
  /** Generation error message */
  generationError: string | null;
  /** Currently selected option index, or 'other' */
  selectedOption: number | 'other' | null;
  /** Free-text input for "Other" */
  otherText: string;
  /** Apply state */
  applyState: ApplyState;
  /** Apply error message */
  applyError: string | null;
  /** The applied principle update data (when applyState === 'applied') */
  appliedUpdate: { summary: string; proposedPrinciple: string; fullUpdatedPrompt: string } | null;
  /** Select an option */
  selectOption: (index: number | 'other') => void;
  /** Set the "Other" free text */
  setOtherText: (text: string) => void;
  /** Confirm the selection (triggers apply or trust confirmation) */
  confirmSelection: () => void;
  /** Confirm trusted tool escalation (second confirmation) */
  confirmTrustedTool: () => void;
  /** Cancel trusted tool confirmation (back to selection) */
  cancelTrustedTool: () => void;
  /** Go back to initial card state (deselect) */
  goBack: () => void;
  /** Retry option generation */
  retryGeneration: () => void;
  /** Resolve once without updating rules — calls onApprove (allow) or onDeny (deny) based on direction */
  resolveOnce: () => void;
  /** @deprecated Use `resolveOnce` instead. Alias kept for backward compatibility. */
  approveOnce: () => void;
  /** Retry apply after failure */
  retryApply: () => void;
  /** Start option generation (guarded — only runs once unless retried) */
  startGeneration: () => void;
  /** The principle direction ('allow' or 'deny') */
  direction: PrincipleDirection;
}

/**
 * Extracts the block reason from a "Safety Rules blocked:" prefixed string.
 */
function extractBlockReason(reason: string): string {
  const prefix = 'Safety Rules blocked:';
  return reason.startsWith(prefix) ? reason.slice(prefix.length).trim() : reason;
}

export function usePrincipleOptions({
  transport,
  blockedAction,
  effectiveToolId,
  packageName,
  onApprove,
  direction: directionProp = 'allow',
  onDeny,
}: UsePrincipleOptionsArgs): UsePrincipleOptionsReturn {
  const direction = directionProp;
  const [generationState, setGenerationState] = useState<GenerationState>('idle');
  const [options, setOptions] = useState<PrincipleOption[]>([]);
  const [generationError, setGenerationError] = useState<string | null>(null);

  const [selectedOption, setSelectedOption] = useState<number | 'other' | null>(null);
  const [otherText, setOtherText] = useState('');

  const [applyState, setApplyState] = useState<ApplyState>('idle');
  const [applyError, setApplyError] = useState<string | null>(null);
  const [appliedUpdate, setAppliedUpdate] = useState<{
    summary: string;
    proposedPrinciple: string;
    fullUpdatedPrompt: string;
  } | null>(null);

  const generationTriggeredRef = useRef(false);
  const mountedRef = useRef(true);
  // Track the last pending apply args for retry
  const lastApplyArgsRef = useRef<{ label: string; scope: PrincipleOptionScope } | null>(null);
  // Track whether the last failed action was a trusted tool confirmation
  const lastActionWasTrustRef = useRef(false);

  // Guard against state updates after unmount
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Internal generation logic — always fires when called
  const triggerGeneration = useCallback(() => {
    if (!blockedAction) return;

    setGenerationState('loading');
    setGenerationError(null);
    setOptions([]);

    const blockReason = extractBlockReason(blockedAction.blockReason);

    const generateApi = direction === 'deny'
      ? transport.safetyPrompt.generateDenyOptions
      : transport.safetyPrompt.generateOptions;

    generateApi({
      toolName: blockedAction.toolName,
      toolInput: blockedAction.toolInput,
      blockReason,
      spaceDescription: blockedAction.spaceDescription,
    })
      .then((result) => {
        if (!mountedRef.current) return;
        // F-D-R2-5 (260417_approval_consolidation_closeout): an explicit
        // `error` string from the LLM surface is still an error; however
        // zero options + no error is a legitimate "loaded but empty"
        // state (the picker renders a free-text fallback so the user
        // can still type their own rule). Previously this path collapsed
        // to `error`, which made the zero-options branch dead code.
        if (result.error) {
          setGenerationError(result.error);
          setGenerationState('error');
        } else {
          setOptions(result.options ?? []);
          setGenerationState('loaded');
        }
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return;
        const message = err instanceof Error ? err.message : 'Unable to generate options';
        setGenerationError(message);
        setGenerationState('error');
      });
  }, [blockedAction, direction, transport]);

  // Guarded generation start — safe to call multiple times, only triggers once
  const startGeneration = useCallback(() => {
    if (generationTriggeredRef.current) return;
    generationTriggeredRef.current = true;
    triggerGeneration();
  }, [triggerGeneration]);

  const selectOption = useCallback((index: number | 'other') => {
    setSelectedOption(index);
    // Reset apply state when selection changes
    setApplyState('idle');
    setApplyError(null);
  }, []);

  const setOtherTextValue = useCallback((text: string) => {
    setOtherText(text);
  }, []);

  const goBack = useCallback(() => {
    setSelectedOption(null);
    setOtherText('');
    setApplyState('idle');
    setApplyError(null);
    setAppliedUpdate(null);
    lastApplyArgsRef.current = null;
  }, []);

  const retryGeneration = useCallback(() => {
    generationTriggeredRef.current = false;
    triggerGeneration();
  }, [triggerGeneration]);

  const resolveOnce = useCallback(() => {
    if (direction === 'deny') {
      onDeny?.();
    } else {
      onApprove();
    }
  }, [direction, onApprove, onDeny]);

  /** Apply a non-trusted-tool selection (or trusted_tool for deny direction) */
  const doApply = useCallback(
    (label: string, scope: PrincipleOptionScope) => {
      if (!blockedAction) return;

      lastApplyArgsRef.current = { label, scope };
      lastActionWasTrustRef.current = false;
      setApplyState('applying');
      setApplyError(null);

      const blockReason = extractBlockReason(blockedAction.blockReason);

      const applyApi = direction === 'deny'
        ? transport.safetyPrompt.applyDenySelection
        : transport.safetyPrompt.applySelection;

      applyApi({
        blockedAction: {
          toolName: blockedAction.toolName,
          toolInput: blockedAction.toolInput,
          blockReason,
          spaceDescription: blockedAction.spaceDescription,
        },
        selectedLabel: label,
        scope,
      })
        .then(async (result) => {
          if (!mountedRef.current) return;
          if (result.update) {
            setAppliedUpdate(result.update);
            // Persist via the transport — D10 single write path. On desktop
            // (local mode) this writes to safety-prompt.json directly; on cloud
            // mode or mobile this writes via cloud-service. Block the "applied"
            // UI transition on success so the user knows the durable rule was
            // NOT created if persistence fails.
            try {
              await transport.safetyPrompt.update({
                prompt: result.update.fullUpdatedPrompt,
                updatedBy: 'system',
              });
            } catch (err) {
              console.error('Failed to update safety rules:', err);
              if (!mountedRef.current) return;
              setApplyError('Failed to save the rule update — please retry');
              setApplyState('error');
              return;
            }
            if (!mountedRef.current) return;
            setApplyState('applied');
            if (direction === 'deny') {
              onDeny?.();
            } else {
              onApprove();
            }
          } else {
            setApplyError(result.error || 'Failed to apply selection');
            setApplyState('error');
          }
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) return;
          const message = err instanceof Error ? err.message : 'Failed to apply selection';
          setApplyError(message);
          setApplyState('error');
        });
    },
    [blockedAction, direction, onApprove, onDeny, transport],
  );

  const confirmSelection = useCallback(() => {
    if (selectedOption === null || applyState !== 'idle') return;

    let label: string;
    let scope: PrincipleOptionScope;

    if (selectedOption === 'other') {
      if (!otherText.trim()) return;
      label = otherText.trim();
      scope = 'specific'; // "Other" free text treated as specific scope
    } else {
      const opt = options[selectedOption];
      if (!opt) return;
      label = opt.label;
      scope = opt.scope;
    }

    if (scope === 'trusted_tool' && blockedAction?.toolName !== 'memory_write') {
      // Transition to trust confirmation step
      setApplyState('confirming_trust');
      return;
    }

    doApply(label, scope);
  }, [selectedOption, otherText, options, doApply, applyState, blockedAction]);

  const confirmTrustedTool = useCallback(async () => {
    if (applyState !== 'confirming_trust') return;

    // For deny direction, skip the settings API entirely and route to LLM principle generation
    if (direction === 'deny') {
      const opt = typeof selectedOption === 'number' ? options[selectedOption] : null;
      if (opt) {
        doApply(opt.label, 'trusted_tool');
      }
      return;
    }

    const toolId = effectiveToolId || blockedAction?.toolName;
    if (!toolId) return;

    lastActionWasTrustRef.current = true;
    setApplyState('applying');
    setApplyError(null);

    try {
      await transport.settings.addTrustedTool({
        toolId,
        displayName: blockedAction?.toolName,
        serverHint: packageName,
      });

      if (!mountedRef.current) return;
      setApplyState('applied');
      onApprove();
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : 'Failed to add trusted tool';
      setApplyError(message);
      setApplyState('error');
    }
  }, [applyState, direction, selectedOption, options, doApply, effectiveToolId, blockedAction, packageName, onApprove, transport]);

  const cancelTrustedTool = useCallback(() => {
    setApplyState('idle');
  }, []);

  const retryApply = useCallback(() => {
    if (lastActionWasTrustRef.current) {
      // Re-enter the trust confirmation flow for retry
      setApplyState('confirming_trust');
      setApplyError(null);
    } else if (lastApplyArgsRef.current) {
      doApply(lastApplyArgsRef.current.label, lastApplyArgsRef.current.scope);
    }
  }, [doApply]);

  return {
    generationState,
    options,
    generationError,
    selectedOption,
    otherText,
    applyState,
    applyError,
    appliedUpdate,
    selectOption,
    setOtherText: setOtherTextValue,
    confirmSelection,
    confirmTrustedTool,
    cancelTrustedTool,
    goBack,
    retryGeneration,
    resolveOnce,
    approveOnce: resolveOnce,
    retryApply,
    startGeneration,
    direction,
  };
}
