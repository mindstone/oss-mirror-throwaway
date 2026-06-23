/**
 * Stage-4 curated request-fixture overrides + un-sampleable exemptions.
 *
 * ## Why this exists
 * The bounded sampler (`sampleRequest.ts`) produces the smallest value that
 * passes `schema.parse`. A handful of channels carry a **cross-field `.refine`**
 * (e.g. "either `sessionId` OR `filePath` must be set") over an all-`.optional()`
 * object: the smallest passing object the sampler builds is `{}`, which the
 * refine rejects. A `.refine`/`.superRefine` is an **opaque check function** —
 * invisible to structural introspection — so the sampler CANNOT satisfy it by
 * construction. Those channels are *expected* override entries (testability F2),
 * not sampler failures.
 *
 * ## Two maps, two meanings
 * - {@link requestOverrides} — a hand-authored contract-valid request for a
 *   channel the sampler can't auto-produce. The Stage-4 test feeds these through
 *   `request.parse` exactly like an auto-sample (they must still parse).
 * - {@link UNSAMPLEABLE} — channels deliberately NOT covered by request fixtures,
 *   each with a typed reason. These are the loud, reviewed exemptions; a channel
 *   the sampler throws on that is on neither list is a hard failure.
 *
 * ## Off-ramp (architecture F8)
 * If the measured auto-pass rate lands low, the plan's response is to **shrink
 * the covered subset** (cover fewer channels well — the Stage-6/7 coverage guard
 * makes the shrink visible), NOT to hand-author dozens of overrides. Keep this
 * map small and intentional.
 */

import type { IpcChannelName } from '@shared/ipc/contracts';

/**
 * Per-channel hand-authored request fixtures, keyed by channel id. Each must be
 * a value that PASSES the channel's `request` schema (the Stage-4 test asserts
 * `request.parse(override)` succeeds for every entry).
 *
 * Seeded with the cross-field-`.refine` channels measured in the corpus
 * (`app.ts` ×3, `cloud.ts` ×1) whose minimal sampler output (`{}`) the refine
 * rejects.
 */
export const requestOverrides: Partial<Record<IpcChannelName, unknown>> = {
  // app.ts — `.refine(sessionId || filePath)` over an all-optional object.
  'app:show-notification': {
    title: '',
    body: '',
    filePath: '/tmp/a',
  },
  // app.ts — `.refine(dataUrl || filePath)`.
  'app:copy-image-to-clipboard': {
    filePath: '/tmp/a',
  },
  // app.ts — `.refine(dataUrl || filePath)`.
  'app:save-image-as': {
    filePath: '/tmp/a',
  },
  // cloud.ts — `.refine(flyApiToken || apiToken || providerId in {digitalocean,mindstone})`.
  'cloud:provision': {
    providerId: 'mindstone',
  },
  // export.ts — `data: z.instanceof(ArrayBuffer)` is a `z.custom` check whose
  // class is opaque to introspection (`def.fn`, no class ref); the sampler
  // cannot construct it by shape. An empty ArrayBuffer is the minimal valid,
  // structured-cloneable value.
  'export:save-file': {
    data: new ArrayBuffer(0),
    fileName: '',
    filters: [],
  },
};

/** A typed, reasoned exemption: a channel deliberately NOT request-fixtured. */
export interface UnsampleableReason {
  /** One-line human reason a fixture is intentionally absent. */
  reason: string;
}

/**
 * Channels intentionally excluded from request fixtures, with reasons. Starts
 * empty: the Stage-4 measurement determines whether any channel needs to land
 * here. A channel the sampler throws on that is in neither this map nor
 * {@link requestOverrides} is a HARD failure (never a silent skip).
 *
 * If this map grows large, prefer the off-ramp (shrink the covered subset) over
 * accumulating exemptions.
 */
export const UNSAMPLEABLE: Partial<Record<IpcChannelName, UnsampleableReason>> = {};
