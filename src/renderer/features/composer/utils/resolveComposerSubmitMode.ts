import type { QueueMode } from '@renderer/features/agent-session/hooks/useMessageQueue';

type ResolveComposerSubmitModeOptions = {
  isBusy: boolean;
  isEditing: boolean;
};

/**
 * Resolves the default submit behavior for the composer.
 *
 * Invariants pinned by Stage 4 regression tests:
 *
 * 1. Edit/re-run operations always behave like "send now" (interrupt) even if
 *    the agent is currently busy. Edits are not queueable because
 *    rerunEditedMessage truncates the conversation — letting the current run
 *    finish would produce output against history the user is invalidating.
 *
 * 2. When the agent is busy and the user is NOT editing, the action for the
 *    primary submit button, plain Enter, AND Alt+Enter MUST be 'queue' — never
 *    'sendNow'. Send-now is only invokable via the explicit secondary button.
 *    (Before 2026-06-06, Alt+Enter forced send-now from the keyboard; that path
 *    was removed because it re-introduced the accidental-supersede footgun this
 *    invariant exists to prevent.) Protects users from accidentally superseding
 *    (and losing) the active turn's response from the keyboard.
 */
export function resolveComposerSubmitMode(
  options: ResolveComposerSubmitModeOptions
): QueueMode | undefined {
  if (options.isEditing) return 'sendNow';
  return options.isBusy ? 'queue' : undefined;
}

/**
 * Resolves what an Alt/Option+Enter keypress should submit, or `null` when the
 * shortcut should NOT intercept (let the key fall through to the default
 * handler).
 *
 * Since 2026-06-06 Alt+Enter while busy QUEUES (it never sends-now). It used to
 * force send-now+interrupt, but that re-introduced the accidental-supersede
 * footgun `resolveComposerSubmitMode` invariant #2 guards against. Send-now is
 * button-only. When the agent is idle (or there's no text) the shortcut does not
 * intercept — the default key handling applies.
 */
export function resolveAltEnterSubmitMode(
  options: { isBusy: boolean; hasText: boolean }
): QueueMode | null {
  if (!options.isBusy || !options.hasText) return null;
  return 'queue';
}
