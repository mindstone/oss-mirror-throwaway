import type { ModelProfile } from '@shared/types';

/**
 * Whether reasoning/thinking emission must be suppressed for a model profile.
 *
 * The single signal is `thinkingCompatibility === 'incompatible'` — auto-detected
 * by the profile "Test" button (a probe request carrying `reasoning_effort` was
 * rejected for a thinking-shaped param) or by a runtime auto-mark. Rebel does NOT
 * offer a manual "turn thinking off" preference; suppression is purely a
 * capability verdict, so it self-heals if a fresh Test later succeeds.
 *
 * This exists because an OpenAI-protocol custom gateway (`providerType:'other'`)
 * that proxies to a native provider can mistranslate `reasoning_effort` into a
 * native thinking shape the model rejects (e.g. a litellm→Vertex proxy emitting
 * the legacy `thinking.type:"enabled"` for an Opus-4.8 that requires adaptive →
 * 400; Sentry REBEL-5RJ).
 *
 * Centralising the predicate here — in shared, depending only on the
 * `ModelProfile` type — lets BOTH the egress paths (the direct `OpenAIClient` and
 * the desktop local proxy, via `@core/rebelCore/modelLimits` which re-exports
 * these) AND the renderer (the read-only thinking display) and the planner
 * routing catalogue honour the same verdict identically, so the wire and the UI
 * can't drift.
 *
 * Pure / RN-safe — no Electron, no I/O, no logger.
 *
 * @see docs/project/CUSTOM_GATEWAY_COMPATIBILITY.md
 */
export function shouldSuppressProfileReasoning(
  profile: Pick<ModelProfile, 'thinkingCompatibility'>,
): boolean {
  return profile.thinkingCompatibility === 'incompatible';
}

/**
 * Resolve the reasoning effort a profile should emit at egress, honouring the
 * suppression gate in {@link shouldSuppressProfileReasoning}. Returns the
 * profile's configured `reasoningEffort` when reasoning is allowed, or
 * `undefined` when it must be suppressed (so callers can omit `reasoning_effort`
 * from the wire request entirely).
 *
 * Use this anywhere a request body — or a user-facing thinking display — is
 * built from a `ModelProfile`, instead of reading `profile.reasoningEffort`
 * directly: that raw read is the REBEL-5RJ class of bug (a suppressed profile
 * leaking `reasoning_effort` on the wire, or a profile table advertising a
 * thinking level that is actually suppressed).
 *
 * Pure / RN-safe — no Electron, no I/O, no logger.
 *
 * @see docs/project/CUSTOM_GATEWAY_COMPATIBILITY.md
 */
export function resolveProfileReasoningEffort(
  profile: Pick<ModelProfile, 'thinkingCompatibility' | 'reasoningEffort'>,
): ModelProfile['reasoningEffort'] | undefined {
  return shouldSuppressProfileReasoning(profile) ? undefined : profile.reasoningEffort;
}
