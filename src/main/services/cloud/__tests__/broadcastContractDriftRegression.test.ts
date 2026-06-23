/**
 * 260405 broadcast contract-drift regression anchor.
 *
 * ## What this pins (the genuine 260405 surface)
 * The REAL escaped bug `260405_memory_approval_ipc_crash`
 * (docs-private/postmortems/260405_memory_approval_ipc_crash_postmortem.md) fired
 * on the cloud-catch-up **broadcast/event** path: a FLAT persisted memory-approval
 * payload (top-level `filePath`/`spaceName`, NO nested `destination`) was dispatched
 * on `memory:write-approval-request`, and the renderer consumer
 * (`usePendingApprovals.ts`) crashed dereferencing `request.destination.path`.
 *
 * The invoke-harness anchor (`contractDriftRegression.test.ts`) reconstructs only the
 * INVOKE analog of this drift on a synthetic channel. THIS anchor exercises the REAL
 * cloud-ingress seam (`cloudEventChannel.dispatchToRenderer`) on the REAL channel +
 * REAL schema (`MemoryWriteApprovalRequestBroadcastSchema`), which is the actual
 * 260405 surface (`cloudEventChannel.test.ts` vi.mocks the sink, so a parse at the
 * INGRESS is the only thing that fires there).
 *
 * The crux of feeding the FLAT payload: `dispatchToRenderer('memory:write-approval-
 * request', [flat])` does NOT run `normalizeMemoryApproval` — that laundering shim
 * runs ONLY on the catch-up route (cloudEventChannel.ts:469). On the direct WS-push
 * dispatch path the flat payload reaches the ingress parse unchanged, so the seam
 * sees the genuine flat shape and rejects it on the required nested `destination`.
 *
 * ## HONEST-CLAIM banner
 * This is a CI/dev **regression guard**, NOT a "would-have-caught": the strict
 * `MemoryWriteApprovalRequestBroadcastSchema` (with `destination` required) postdates
 * the production fix `ff8813a78`, and BOTH prod surfaces are OFF by construction —
 * deployed cloud runs `NODE_ENV=production` and packaged desktop leaves NODE_ENV
 * unset, so `isContractEnforcementOn()` is false in both. In prod, users on the
 * 260405 path are protected only by `normalizeMemoryApproval` + the `ff8813a78`
 * consumer fallbacks, NOT by this seam. The value here is locking the regression so
 * a future producer/schema change that re-opens the flat-vs-nested gap goes red in
 * CI/dev.
 */

import { ZodError } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryWriteApprovalRequestBroadcastSchema } from '@rebel/shared';
import { isContractEnforcementOn } from '@shared/ipc/contractEnforcement';

const mockSend = vi.fn();

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({
    sendToAllWindows: mockSend,
    sendToFocusedWindow: vi.fn(),
  }),
}));

import { cloudEventChannel } from '../cloudEventChannel';

const CHANNEL = 'memory:write-approval-request';

/**
 * The genuine FLAT `PersistedMemoryApprovalRequest` shape (pendingApprovalsStore.ts:41):
 * top-level `filePath`/`spaceName`, NO nested `destination`. This is the exact 260405
 * payload that crashed the renderer.
 */
const FLAT_PERSISTED_PAYLOAD = {
  toolUseId: 'mem-1',
  originalTurnId: 'turn-1',
  originalSessionId: 'session-1',
  turnId: 'bg-turn-1',
  sessionId: 'bg-session-1',
  filePath: '/workspace/work/notes.md',
  spaceName: 'work',
  summary: 'Save notes',
  content: 'note body',
  timestamp: 1_700_000_000_000,
};

/** The contract-valid NESTED shape the renderer consumer expects. */
const VALID_NESTED_PAYLOAD = {
  toolUseId: 'mem-1',
  originalTurnId: 'turn-1',
  originalSessionId: 'session-1',
  destination: { path: '/workspace/work/notes.md', spaceName: 'work', isNew: false },
  summary: 'Save notes',
  timestamp: 1_700_000_000_000,
};

/** Reach the private cloud-ingress dispatch boundary where the parse throws. */
function dispatch(channel: string, args: unknown[]): void {
  (cloudEventChannel as unknown as { dispatchToRenderer(c: string, a: unknown[]): void })
    .dispatchToRenderer(channel, args);
}

afterEach(() => {
  vi.unstubAllEnvs();
  mockSend.mockClear();
});

describe('260405 broadcast contract-drift regression — cloud-ingress seam', () => {
  describe('gate ON (NODE_ENV="test")', () => {
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv('REBEL_CONTRACT_ENFORCE', '');
    });

    it('GATE PRECONDITION: enforcement is ON under NODE_ENV="test"', () => {
      // The whole regression depends on the seam being live; pin it so a future
      // change to the gate idiom turns THIS test red, not silently a-OK.
      expect(isContractEnforcementOn()).toBe(true);
    });

    it('THE ANCHOR: the FLAT 260405 payload throws ZodError naming `destination` at the cloud-ingress seam', () => {
      // The direct dispatch path does NOT run normalizeMemoryApproval (that runs
      // only on the catch-up route), so the genuine flat shape reaches the ingress
      // parse — exactly the 260405 surface, on the real channel + real schema.
      let caught: unknown;
      try {
        dispatch(CHANNEL, [FLAT_PERSISTED_PAYLOAD]);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ZodError);
      expect((caught as ZodError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: expect.arrayContaining(['destination']) }),
        ]),
      );
      // Rejected BEFORE the sink — the renderer never receives the crashing shape.
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('the valid NESTED payload is forwarded clean to the sink (no false positive)', () => {
      expect(() => dispatch(CHANNEL, [VALID_NESTED_PAYLOAD])).not.toThrow();
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(CHANNEL, VALID_NESTED_PAYLOAD);
    });
  });

  describe('SEAM-OFF proof (NODE_ENV="production")', () => {
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('REBEL_CONTRACT_ENFORCE', '');
    });

    it('with the gate OFF, the IDENTICAL flat payload SAILS THROUGH to the sink', () => {
      // Proves the anchor depends on the seam/gate, not a bare Zod call: in
      // deployed-cloud prod (NODE_ENV=production) the seam is OFF, so the flat
      // payload is forwarded exactly as the pre-fix production behaviour did.
      expect(isContractEnforcementOn()).toBe(false);
      expect(() => dispatch(CHANNEL, [FLAT_PERSISTED_PAYLOAD])).not.toThrow();
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(CHANNEL, FLAT_PERSISTED_PAYLOAD);
    });
  });

  describe('`destination`-required mutation-to-red guard (first-class invariant)', () => {
    // WHY this is load-bearing: the schema deliberately keeps the FLAT legacy fields
    // (filePath/spaceName/spacePath/…) OPTIONAL so catch-up records normalized by
    // normalizeMemoryApproval still parse. The ONLY thing that makes the flat 260405
    // payload fail is `destination` being REQUIRED. If a future change loosens it to
    // `.optional()` to "tolerate flat catch-up", the whole anchor above silently goes
    // green-for-nothing — this guard turns red first, flagging the defang.
    it('rejects a payload missing `destination` (so a `.optional()` loosening turns this red)', () => {
      const result = MemoryWriteApprovalRequestBroadcastSchema.safeParse(FLAT_PERSISTED_PAYLOAD);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: expect.arrayContaining(['destination']) }),
          ]),
        );
      }
    });

    it('accepts the same payload once a nested `destination` is supplied (pins that destination is the sole crux)', () => {
      const withDestination = {
        ...FLAT_PERSISTED_PAYLOAD,
        destination: { path: '/workspace/work/notes.md', spaceName: 'work', isNew: false },
      };
      expect(MemoryWriteApprovalRequestBroadcastSchema.safeParse(withDestination).success).toBe(true);
    });
  });
});
