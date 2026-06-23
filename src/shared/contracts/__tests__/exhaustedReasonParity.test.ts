/**
 * REBEL-5BM prevention guard — `ExhaustedReason` lockstep across the recovery
 * event contract.
 *
 * Stage 1 fixed an INSTANCE of a recurring class: `long_context_fallback_failed`
 * lived in the canonical `ExhaustedReason` type but was missing from the event
 * zod enums, so `makeRecoveryFailedEvent` threw synchronously / the event was
 * silently dropped. This test prevents the CLASS:
 *
 *   1. Runtime set-equality of the `ExhaustedReason` value set across every zod
 *      enum that enumerates it (recoveryEvents, IPC schema, manifest schema).
 *   2. Compile-time exhaustiveness — adding a value to the canonical
 *      `ExhaustedReason` union (or the inline `recovery:failed` union in
 *      `@shared/types`) WITHOUT adding it to the schemas fails `lint:ts`.
 *   3. Runtime round-trip — every reason parses through `RecoveryOutboundEventSchema`,
 *      the IPC `AgentEventSchema`, and the manifest schema (the runtime half of
 *      catching the `long_context_fallback_failed`-style throw/drop).
 *
 * If this test (or `lint:ts`) fails after you touched a recovery reason, you
 * forgot to update one of the lockstep surfaces — see the planning doc
 * `docs/plans/260531_rebel-5bm_recovery_mislabel_fix.md` Research Notes table A.
 */
import { describe, expect, it } from 'vitest';

import { exhaustedReasonSchema, RecoveryOutboundEventSchema } from '@core/services/recovery/recoveryEvents';
import type { ExhaustedReason } from '@core/services/recovery/recoveryStateMachine';
import {
  AgentEventSchema,
  RecoveryExhaustedReasonSchema as IpcRecoveryExhaustedReasonSchema,
} from '@shared/ipc/schemas/agent';
import {
  AgentEventSchemaFromManifest,
  RecoveryExhaustedReasonSchema as ManifestRecoveryExhaustedReasonSchema,
} from '@shared/contracts/agentEventManifest';
import type { AgentEvent } from '@shared/types';

// ---------------------------------------------------------------------------
// Compile-time exhaustiveness. `Equal<A, B>` is `true` only when A and B are the
// SAME union (tuple-wrapped to defeat distributivity so we compare sets, not
// members). Each `const _x: Equal<...> = true` below is a TYPE ERROR (fails
// `tsc -p tsconfig.* --noEmit`, i.e. `lint:ts`) the moment the canonical
// `ExhaustedReason` union drifts from a runtime/inline surface in EITHER
// direction. The `expect(...).toBe(true)` calls keep the consts "used" so lint
// does not flag them, and double as a trivially-passing runtime assertion.
// ---------------------------------------------------------------------------
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type EventsSchemaReason = (typeof exhaustedReasonSchema.options)[number];
type IpcSchemaReason = (typeof IpcRecoveryExhaustedReasonSchema.options)[number];
type ManifestSchemaReason = (typeof ManifestRecoveryExhaustedReasonSchema.options)[number];
type InlineUnionReason = Extract<AgentEvent, { type: 'recovery:failed' }>['exhaustedReason'];

const _eventsSchemaCoversCanonical: Equal<ExhaustedReason, EventsSchemaReason> = true;
const _ipcSchemaCoversCanonical: Equal<ExhaustedReason, IpcSchemaReason> = true;
const _manifestSchemaCoversCanonical: Equal<ExhaustedReason, ManifestSchemaReason> = true;
const _inlineUnionCoversCanonical: Equal<ExhaustedReason, InlineUnionReason> = true;

const ALL_EXHAUSTED_REASONS = exhaustedReasonSchema.options;

const recoveryFailedBase = {
  turnId: 'turn-parity',
  sessionId: 'session-parity',
  originalSessionId: 'original-session-parity',
  depth: 0,
  attempt: 0,
  totalCalls: 1,
  timestamp: 1_700_000_000_000,
} as const;

function sortedSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

describe('ExhaustedReason lockstep guard (REBEL-5BM prevention)', () => {
  it('compile-time: every runtime/inline surface is exactly the canonical ExhaustedReason union', () => {
    // These assertions are trivially true at runtime; their real teeth are the
    // type annotations above, which fail `lint:ts` on drift.
    expect(_eventsSchemaCoversCanonical).toBe(true);
    expect(_ipcSchemaCoversCanonical).toBe(true);
    expect(_manifestSchemaCoversCanonical).toBe(true);
    expect(_inlineUnionCoversCanonical).toBe(true);
  });

  it('runtime: all three zod enums enumerate exactly the same ExhaustedReason set', () => {
    const eventsReasons = sortedSet(exhaustedReasonSchema.options);
    const ipcReasons = sortedSet(IpcRecoveryExhaustedReasonSchema.options);
    const manifestReasons = sortedSet(ManifestRecoveryExhaustedReasonSchema.options);

    // toEqual prints the offending diff (extra/missing members) on failure.
    expect(ipcReasons, 'IPC schema enum drifted from recoveryEvents enum').toEqual(eventsReasons);
    expect(manifestReasons, 'manifest schema enum drifted from recoveryEvents enum').toEqual(eventsReasons);
  });

  it.each(ALL_EXHAUSTED_REASONS)(
    'runtime: reason %s round-trips through RecoveryOutboundEventSchema + IPC + manifest schemas',
    (reason) => {
      const event = {
        type: 'recovery:failed' as const,
        ...recoveryFailedBase,
        error: `Recovery failed: ${reason}`,
        exhaustedReason: reason,
      };

      // RecoveryOutboundEventSchema.parse is what makeRecoveryFailedEvent calls;
      // a missing reason here is the exact `long_context_fallback_failed` throw.
      expect(RecoveryOutboundEventSchema.parse(event)).toMatchObject({ exhaustedReason: reason });
      expect(AgentEventSchema.parse(event)).toMatchObject({ exhaustedReason: reason });
      expect(AgentEventSchemaFromManifest.parse(event)).toMatchObject({ exhaustedReason: reason });
    },
  );

  it('runtime: a bogus reason is rejected by every schema (enums stay closed)', () => {
    const bogus = {
      type: 'recovery:failed' as const,
      ...recoveryFailedBase,
      error: 'Recovery failed: not_a_real_reason',
      exhaustedReason: 'not_a_real_reason',
    };

    expect(RecoveryOutboundEventSchema.safeParse(bogus).success).toBe(false);
    expect(AgentEventSchema.safeParse(bogus).success).toBe(false);
    expect(AgentEventSchemaFromManifest.safeParse(bogus).success).toBe(false);
  });
});
