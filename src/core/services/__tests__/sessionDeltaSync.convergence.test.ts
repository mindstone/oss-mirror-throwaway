import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import type { AgentSession } from '@shared/types';
import { getCatchUpEvents } from '@core/services/cloudSessionMergeService';
import {
  DeltaSyncTriplet,
  createTriplet,
  tripletFixtures,
} from './_helpers/inMemoryDeltaSyncTriplet';

type DeltaSyncModel = {
  tombstoned: boolean;
  operations: number;
};

abstract class TripletCommand implements fc.AsyncCommand<DeltaSyncModel, DeltaSyncTriplet> {
  check(model: Readonly<DeltaSyncModel>): boolean {
    return !model.tombstoned;
  }

  abstract run(model: DeltaSyncModel, real: DeltaSyncTriplet): Promise<void>;
}

class DesktopAppendCommand extends TripletCommand {
  constructor(private readonly count: number) {
    super();
  }

  async run(model: DeltaSyncModel, real: DeltaSyncTriplet): Promise<void> {
    real.desktopAppend(this.count);
    model.operations += 1;
  }

  toString(): string {
    return `DesktopAppend(${this.count})`;
  }
}

class DesktopOutboxDrainCommand extends TripletCommand {
  async run(model: DeltaSyncModel, real: DeltaSyncTriplet): Promise<void> {
    await real.desktopOutboxDrain();
    model.operations += 1;
  }

  toString(): string {
    return 'DesktopOutboxDrain';
  }
}

class DesktopPullCommand extends TripletCommand {
  async run(model: DeltaSyncModel, real: DeltaSyncTriplet): Promise<void> {
    await real.desktopPull();
    model.operations += 1;
  }

  toString(): string {
    return 'DesktopPull';
  }
}

class CloudNativeAppendCommand extends TripletCommand {
  async run(model: DeltaSyncModel, real: DeltaSyncTriplet): Promise<void> {
    await real.cloudNativeAppend(1, 'cloud');
    model.operations += 1;
  }

  toString(): string {
    return 'CloudNativeAppend';
  }
}

class CloudNativeAppendInflightStampingRaceCommand extends TripletCommand {
  async run(model: DeltaSyncModel, real: DeltaSyncTriplet): Promise<void> {
    await real.cloudNativeAppendInflightStampingRace();
    model.operations += 1;
  }

  toString(): string {
    return 'CloudNativeAppendInflightStampingRace(F20)';
  }
}

class MobilePatchCommand extends TripletCommand {
  async run(model: DeltaSyncModel, real: DeltaSyncTriplet): Promise<void> {
    await real.mobilePatch({ title: `Mobile title ${model.operations}` });
    model.operations += 1;
  }

  toString(): string {
    return 'MobilePatch';
  }
}

class MobilePullCommand extends TripletCommand {
  async run(model: DeltaSyncModel, real: DeltaSyncTriplet): Promise<void> {
    await real.mobilePull();
    model.operations += 1;
  }

  toString(): string {
    return 'MobilePull';
  }
}

class DesktopRetryWithLostResponseCommand extends TripletCommand {
  async run(model: DeltaSyncModel, real: DeltaSyncTriplet): Promise<void> {
    if (!real.getStateForAssertion().desktop.outbox.pending) real.desktopAppend(1);
    await real.desktopRetryWithLostResponse();
    model.operations += 1;
  }

  toString(): string {
    return 'DesktopRetryWithLostResponse';
  }
}

class TombstoneCommand extends TripletCommand {
  async run(model: DeltaSyncModel, real: DeltaSyncTriplet): Promise<void> {
    await real.tombstone();
    model.tombstoned = true;
    model.operations += 1;
  }

  toString(): string {
    return 'Tombstone';
  }
}

class CursorRotationCommand extends TripletCommand {
  async run(model: DeltaSyncModel, real: DeltaSyncTriplet): Promise<void> {
    real.cursorRotation();
    model.operations += 1;
  }

  toString(): string {
    return 'CursorRotation';
  }
}

class DestructiveOpCommand extends TripletCommand {
  async run(model: DeltaSyncModel, real: DeltaSyncTriplet): Promise<void> {
    await real.desktopOutboxDrain();
    real.destructiveOp('truncate');
    await real.desktopOutboxDrain();
    model.operations += 1;
  }

  toString(): string {
    return 'DestructiveOp(F44)';
  }
}

function commandArbitrary(): fc.Arbitrary<fc.AsyncCommand<DeltaSyncModel, DeltaSyncTriplet>> {
  return fc.oneof(
    fc.integer({ min: 1, max: 3 }).map((count) => new DesktopAppendCommand(count)),
    fc.constant(new DesktopOutboxDrainCommand()),
    fc.constant(new DesktopPullCommand()),
    fc.constant(new CloudNativeAppendCommand()),
    fc.constant(new CloudNativeAppendInflightStampingRaceCommand()),
    fc.constant(new MobilePatchCommand()),
    fc.constant(new MobilePullCommand()),
    fc.constant(new DesktopRetryWithLostResponseCommand()),
    fc.constant(new TombstoneCommand()),
    fc.constant(new CursorRotationCommand()),
    fc.constant(new DestructiveOpCommand()),
  );
}

function getRunCount(): number {
  const parsed = Number(process.env.FAST_CHECK_NUM_RUNS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 100;
}

function cloneSession(session: AgentSession): AgentSession {
  return JSON.parse(JSON.stringify(session)) as AgentSession;
}

describe('session delta sync convergence', () => {
  it('converges for stateful desktop/cloud/mobile command sequences', async () => {
    await fc.assert(
      fc.asyncProperty(fc.commands([commandArbitrary()], { maxCommands: 20 }), async (commands) => {
        const real = createTriplet();
        const model: DeltaSyncModel = { tombstoned: false, operations: 0 };
        await fc.asyncModelRun(() => ({ model, real }), commands);
        await real.settle();
        real.expectConverged();
      }),
      {
        numRuns: getRunCount(),
        interruptAfterTimeLimit: process.env.FAST_CHECK_NUM_RUNS ? undefined : 30_000,
        verbose: true,
      },
    );
  });

  it('regression 1: mobile-origin cloud turn interleaves with desktop delta push', async () => {
    const triplet = createTriplet();
    triplet.desktopAppend(1, 'desktop-interleaved');
    await triplet.desktopOutboxDrain({ deferResponse: true });
    await triplet.cloudNativeAppend(1, 'mobile');

    await triplet.settle();

    triplet.expectConverged();
    expect(triplet.getStateForAssertion().cloud.session?.messages.some((message) => message.id.startsWith('mobile-message'))).toBe(true);

    // Pinned fast-check seed 2032647188: desktop-local message, cloud-native
    // turn, then mobile metadata patch converges after settle.
    const desktopCloudPatch = createTriplet();
    desktopCloudPatch.desktopAppend(1);
    await desktopCloudPatch.cloudNativeAppend(1, 'cloud');
    await desktopCloudPatch.mobilePatch({ title: 'Pinned desktop/cloud/mobile patch' });
    await desktopCloudPatch.settle();
    desktopCloudPatch.expectConverged();
  });

  it('regression 2 (F20): in-flight desktop POST and cloud-native stamping race keep non-overlapping seqs', async () => {
    const triplet = createTriplet();

    await triplet.cloudNativeAppendInflightStampingRace();
    await triplet.settle();

    triplet.expectConverged();
    const seqs = tripletFixtures.sortedEvents(triplet.getStateForAssertion().cloud.session).map(({ event }) => event.seq);
    expect(new Set(seqs).size).toBe(seqs.length);

    // Pinned fast-check seed -355230488: repeated F20 race with an intervening mobile pull.
    const repeatedRace = createTriplet();
    await repeatedRace.cloudNativeAppendInflightStampingRace();
    await repeatedRace.mobilePull();
    await repeatedRace.cloudNativeAppendInflightStampingRace();
    await repeatedRace.settle();
    repeatedRace.expectConverged();
  });

  it('regression 3: tombstone arriving mid-push suppresses all three surfaces', async () => {
    const triplet = createTriplet();
    triplet.desktopAppend(1, 'tombstone-race');
    await triplet.desktopOutboxDrain({ deferResponse: true });

    await triplet.tombstone();
    await triplet.settle();

    expect(triplet.getStateForAssertion().desktop.session).toBeNull();
    expect(triplet.getStateForAssertion().cloud.session).toBeNull();
    expect(triplet.getStateForAssertion().mobile.session).toBeNull();
  });

  it('regression 4 (F23): permanent failure of one oversized event does not brick the batch', async () => {
    const triplet = createTriplet();
    triplet.desktopAppendOversizedAndSmall();

    await triplet.desktopOutboxDrain();
    await triplet.settle();

    triplet.expectConverged();
    expect(triplet.getStateForAssertion().permanentFailures).toHaveLength(1);
    expect(tripletFixtures.sortedEvents(triplet.getStateForAssertion().cloud.session).some(({ event }) => {
      const message = 'message' in event ? event.message : '';
      return String(message).startsWith('oversized:');
    })).toBe(false);
  });

  it('regression 5 (F22): cursorless existing oversized-session bootstrap seeds by pull instead of full PUT', async () => {
    const triplet = createTriplet();
    const cloud = tripletFixtures.makeBaseSession('oversized-bootstrap');
    cloud.eventsByTurn = {
      giant: [tripletFixtures.makeStatusEvent({ timestamp: 2_000, message: `simulated-28mb-existing:${'x'.repeat(1024)}`, seq: 1 })],
    };
    cloud.messages = [tripletFixtures.makeMessage({ id: 'existing-message', turnId: 'giant', text: 'existing', createdAt: 2_000 })];
    cloud.maxSeq = 1;
    triplet.seedCloudSession(cloud);
    triplet.seedDesktopSession(cloud, 0);
    triplet.desktopAppend(1, 'post-bootstrap-local');

    await triplet.desktopOutboxDrain();
    await triplet.settle();

    triplet.expectConverged();
    expect(triplet.getStateForAssertion().fullPutAttempts).toBe(0);
    expect(triplet.getStateForAssertion().desktop.cursor).toBe(triplet.getStateForAssertion().cloud.session?.maxSeq);
  });

  it('regression 6 (R1/F36): mobile-origin cloud-native message appears in desktop catch-up messageDelta', async () => {
    const triplet = createTriplet();
    await triplet.cloudNativeAppend(1, 'mobile');

    const preview = await triplet.previewDesktopCatchUp();
    await triplet.desktopPull();

    expect(preview.kind).toBe('events');
    if (preview.kind === 'events') {
      expect(preview.messageDelta?.some((message) => message.id.startsWith('mobile-message'))).toBe(true);
    }
    expect(triplet.getStateForAssertion().desktop.session?.messages.some((message) => message.id.startsWith('mobile-message'))).toBe(true);
  });

  it('regression 7 (R2/F32): backup/restore lying cursor is detected and recovered', async () => {
    const triplet = createTriplet();
    triplet.desktopAppend(1, 'lying-cursor');
    triplet.setDesktopCursor(100);

    await triplet.desktopOutboxDrain();
    await triplet.settle();

    triplet.expectConverged();
    expect(triplet.getStateForAssertion().breadcrumbs.some((breadcrumb) => breadcrumb.message === 'session-delta-push:lying-cursor-detected')).toBe(true);
  });

  it('regression 8 (R3/F26+0c): old-client same identity different content keeps cloud event and emits breadcrumb', async () => {
    const triplet = createTriplet();
    const cloud = tripletFixtures.makeBaseSession('old-client-collision');
    cloud.eventsByTurn = {
      T1: [tripletFixtures.makeStatusEvent({ timestamp: 5_000, message: 'cloud kept', seq: 1, clientOrdinal: 0 })],
    };
    cloud.maxSeq = 1;
    triplet.seedCloudSession(cloud);
    const desktop = cloneSession(cloud);
    desktop.eventsByTurn.T1[0] = { ...desktop.eventsByTurn.T1[0], message: 'cloud kept ' } as typeof desktop.eventsByTurn.T1[number];
    triplet.seedDesktopSession(desktop, 1);

    await triplet.fullPutFromDesktopWithDifferentContent();
    await triplet.desktopPull();
    await triplet.mobilePull();

    const keptEvent = triplet.getStateForAssertion().cloud.session?.eventsByTurn.T1?.[0];
    expect(keptEvent && 'message' in keptEvent ? keptEvent.message : undefined).toBe('cloud kept');
    expect(triplet.getStateForAssertion().breadcrumbs.some((breadcrumb) => breadcrumb.message === 'event-overwrite-prevented')).toBe(true);
  });

  it('regression 9 (R4/F35): message deletion propagates via messageDeletes', async () => {
    const triplet = createTriplet();
    triplet.desktopAppend(1, 'message-delete');
    await triplet.desktopOutboxDrain();
    const messageId = triplet.getStateForAssertion().desktop.session?.messages[0]?.id;
    expect(messageId).toBeDefined();

    triplet.deleteDesktopMessage(messageId ?? '');
    await triplet.desktopOutboxDrain();
    await triplet.settle();

    triplet.expectConverged();
    expect(triplet.getStateForAssertion().cloud.session?.messages.some((message) => message.id === messageId)).toBe(false);
  });

  it('regression 10 (R5/F44): destructive turn truncation propagates', async () => {
    const triplet = createTriplet();
    triplet.desktopAppend(2, 'truncate-me');
    await triplet.desktopOutboxDrain();

    triplet.destructiveOp('truncate');
    await triplet.desktopOutboxDrain();
    await triplet.settle();

    triplet.expectConverged();
    expect(triplet.getStateForAssertion().cloud.session?.eventsByTurn['truncate-me']).toEqual([]);
    expect(triplet.getStateForAssertion().breadcrumbs.some((breadcrumb) => breadcrumb.message === 'session-delta-push:destructive-op-applied')).toBe(true);

    // Pinned fast-check seeds 1325791376, -921371949, and -15825713: destructive
    // ops around pull, retry, and mobile metadata patch converge without orphan messages.
    const destructivePull = createTriplet();
    destructivePull.destructiveOp('truncate');
    await destructivePull.desktopPull();
    await destructivePull.settle();
    destructivePull.expectConverged();

    const doubleDestructive = createTriplet();
    doubleDestructive.destructiveOp('truncate');
    await doubleDestructive.desktopOutboxDrain();
    doubleDestructive.destructiveOp('delete');
    await doubleDestructive.desktopOutboxDrain();
    await doubleDestructive.settle();
    doubleDestructive.expectConverged();

    const destructivePatch = createTriplet();
    await destructivePatch.desktopPull();
    destructivePatch.destructiveOp('delete');
    await destructivePatch.desktopOutboxDrain();
    await destructivePatch.mobilePatch({ title: 'Pinned destructive/mobile patch' });
    await destructivePatch.settle();
    destructivePatch.expectConverged();

    const destructiveLostRetry = createTriplet();
    // Pinned fast-check seed 1990146980: destructive op followed by a multi-event
    // desktop append whose first POST applies but the response is lost.
    destructiveLostRetry.destructiveOp('truncate');
    await destructiveLostRetry.desktopOutboxDrain();
    destructiveLostRetry.desktopAppend(2);
    await destructiveLostRetry.desktopRetryWithLostResponse();
    await destructiveLostRetry.settle();
    destructiveLostRetry.expectConverged();
  });

  it('regression 11 (R6/F57): cloud-side truncate while desktop is offline is applied by final catch-up page', async () => {
    const triplet = createTriplet();
    const session = tripletFixtures.makeBaseSession('cloud-side-truncate');
    session.eventsByTurn = {
      T1: Array.from({ length: 5 }, (_, index) => tripletFixtures.makeStatusEvent({ timestamp: 6_000 + index, message: `T1-${index}`, seq: index + 1 })),
      T2: Array.from({ length: 3 }, (_, index) => tripletFixtures.makeStatusEvent({ timestamp: 7_000 + index, message: `T2-${index}`, seq: index + 6 })),
    };
    session.maxSeq = 8;
    triplet.seedCloudSession(session);
    triplet.seedDesktopSession(session, 8);

    await triplet.cloudSideTruncate('T1');
    const catchUp = await getCatchUpEvents(
      {
        getSession: async () => triplet.getStateForAssertion().cloud.session,
        upsertSession: async () => undefined,
        deleteSession: async () => undefined,
        getActiveTurnController: () => undefined,
        listSessions: () => [],
        readContinuityStateMap: async () => null,
      },
      { sessionId: 'cloud-side-truncate', sinceSeq: 8, limit: 5_000 },
    );
    await triplet.desktopPull();

    expect(catchUp.kind).toBe('events');
    if (catchUp.kind === 'events') {
      expect(catchUp.destructiveOpsApplied?.truncatedTurns).toContain('T1');
    }
    expect(triplet.getStateForAssertion().desktop.session?.eventsByTurn.T1).toEqual([]);
  });
});
