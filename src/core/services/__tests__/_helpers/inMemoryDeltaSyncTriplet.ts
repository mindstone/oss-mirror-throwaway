import { expect, vi } from 'vitest';
import type { AgentEvent, AgentSession, AgentSessionMetadataPatch, AGENT_SESSION_METADATA_PATCH_KEYS } from '@shared/types';
import { getEventIdentity } from '@shared/utils/eventIdentity';
import {
  getCatchUpEvents,
  getSequencedEventsSince,
  processSessionDelete,
  processSessionEventsAppend,
  processSessionPut,
  resetCloudSessionMergeServiceForTests,
  type CloudSessionEffectSink,
  type CloudSessionMergeDeps,
  type DestructiveOpsApplied,
  type SessionEventsAppendEvent,
} from '@core/services/cloudSessionMergeService';
import { getMaxSeqFromSession, resetSessionSeqIndexForTests } from '@core/services/continuity/sessionSeqIndex';
import { resetSessionTombstoneStoreForTests } from '@core/services/continuity/sessionTombstoneStore';
import { resetServerClockForTests, setServerNowForTests } from '@core/services/continuity/serverClock';

type SessionMessage = AgentSession['messages'][number];
type MetadataKey = typeof AGENT_SESSION_METADATA_PATCH_KEYS[number];
type DestructiveOps = {
  truncateTurns?: string[];
  deleteEventIdentities?: string[];
};

type PendingOutbox = {
  pending: boolean;
  generation: number;
  destructiveOps?: DestructiveOps;
};

type NodeState = {
  name: 'desktop' | 'cloud' | 'mobile';
  session: AgentSession | null;
  cursor: number;
  cursorHistory: number[];
  lastPushedMessageIds: Set<string>;
  outbox: PendingOutbox;
};

type SinkEvent = Parameters<CloudSessionEffectSink['emit']>[0];
type SinkBreadcrumb = Parameters<CloudSessionEffectSink['breadcrumb']>[0];

type AssertionState = {
  desktop: NodeState;
  cloud: NodeState;
  mobile: NodeState;
  breadcrumbs: SinkBreadcrumb[];
  emitted: SinkEvent[];
  permanentFailures: string[];
  fullPutAttempts: number;
};

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function makeBaseSession(id = 'session-delta-sync'): AgentSession {
  return {
    id,
    title: 'Delta sync',
    createdAt: 1_000,
    updatedAt: 1_000,
    cloudUpdatedAt: 1_000,
    messages: [],
    eventsByTurn: {},
    maxSeq: 0,
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    doneAt: null,
    starredAt: null,
    deletedAt: null,
    privateMode: false,
    origin: 'manual',
  } as AgentSession;
}

function makeStatusEvent(args: {
  timestamp: number;
  message: string;
  seq?: number | null;
  clientOrdinal?: number;
}): AgentEvent {
  return {
    type: 'status',
    message: args.message,
    timestamp: args.timestamp,
    ...(args.seq !== undefined ? { seq: args.seq } : {}),
    ...(args.clientOrdinal !== undefined ? { clientOrdinal: args.clientOrdinal } : {}),
  } as AgentEvent;
}

function makeMessage(args: {
  id: string;
  turnId: string;
  text: string;
  createdAt: number;
  role?: SessionMessage['role'];
}): SessionMessage {
  return {
    id: args.id,
    turnId: args.turnId,
    role: args.role ?? 'user',
    text: args.text,
    createdAt: args.createdAt,
  };
}

function eventIdentityWithFallback(turnId: string, event: AgentEvent): string {
  const primary = getEventIdentity(turnId, event);
  const clientOrdinal = (event as { clientOrdinal?: unknown }).clientOrdinal;
  if (typeof event.seq === 'number' && Number.isInteger(event.seq) && event.seq > 0) {
    return primary;
  }
  return typeof clientOrdinal === 'number' && Number.isInteger(clientOrdinal) && clientOrdinal >= 0
    ? `${turnId}:type:${event.type}:ts:${event.timestamp ?? ''}:ord:${clientOrdinal}`
    : `${turnId}:type:${event.type}:ts:${event.timestamp ?? ''}`;
}

function sortedEvents(session: AgentSession | null): Array<{ turnId: string; event: AgentEvent }> {
  const events: Array<{ turnId: string; event: AgentEvent }> = [];
  for (const [turnId, turnEvents] of Object.entries(session?.eventsByTurn ?? {})) {
    for (const event of turnEvents) events.push({ turnId, event });
  }
  return events.sort((a, b) => {
    const aSeq = typeof a.event.seq === 'number' ? a.event.seq : 0;
    const bSeq = typeof b.event.seq === 'number' ? b.event.seq : 0;
    if (aSeq !== bSeq) return aSeq - bSeq;
    if (a.turnId !== b.turnId) return a.turnId.localeCompare(b.turnId);
    return (a.event.timestamp ?? 0) - (b.event.timestamp ?? 0);
  });
}

function normalizeEvent(event: AgentEvent): Record<string, unknown> {
  const copy = clone(event) as Record<string, unknown>;
  delete copy.clientOrdinal;
  return copy;
}

function normalizeSessionForConvergence(session: AgentSession | null): Record<string, unknown> | null {
  if (!session) return null;
  const normalizedEvents: Record<string, Record<string, unknown>[]> = {};
  for (const turnId of Object.keys(session.eventsByTurn ?? {}).sort()) {
    if ((session.eventsByTurn?.[turnId] ?? []).length === 0) continue;
    normalizedEvents[turnId] = [...(session.eventsByTurn?.[turnId] ?? [])]
      .map(normalizeEvent)
      .sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
  }
  const metadata: Record<MetadataKey, unknown> = {
    title: session.title,
    doneAt: session.doneAt ?? null, // canonical lifecycle field
    starredAt: session.starredAt ?? null,
    deletedAt: session.deletedAt ?? null,
    privateMode: session.privateMode ?? false,
    draft: session.draft ?? undefined,
    resolvedAt: session.resolvedAt ?? null,
    finishLine: session.finishLine ?? undefined,
  };
  return {
    metadata,
    eventsByTurn: normalizedEvents,
    messages: [...(session.messages ?? [])]
      .map((message) => clone(message))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

class InMemoryMessageBus {
  private inFlight: Array<() => Promise<void>> = [];

  enqueue(task: () => Promise<void>): void {
    this.inFlight.push(task);
  }

  async flushAll(): Promise<void> {
    while (this.inFlight.length > 0) {
      const task = this.inFlight.shift();
      if (task) await task();
    }
  }

  get size(): number {
    return this.inFlight.length;
  }
}

class InMemoryCloudDeps implements CloudSessionMergeDeps {
  constructor(private readonly getCloudSession: () => AgentSession | null, private readonly setCloudSession: (session: AgentSession | null) => void) {}

  async getSession(): Promise<AgentSession | null> {
    return clone(this.getCloudSession());
  }

  async upsertSession(session: AgentSession): Promise<void> {
    this.setCloudSession(clone(session));
  }

  async deleteSession(): Promise<void> {
    this.setCloudSession(null);
  }

  getActiveTurnController(): AbortController | undefined {
    return undefined;
  }

  listSessions(): unknown {
    const session = this.getCloudSession();
    return session ? [clone(session)] : [];
  }

  async readContinuityStateMap(): Promise<null> {
    return null;
  }
}

export class DeltaSyncTriplet {
  readonly desktop: NodeState;
  readonly cloud: NodeState;
  readonly mobile: NodeState;
  readonly breadcrumbs: SinkBreadcrumb[] = [];
  readonly emitted: SinkEvent[] = [];
  readonly permanentFailures: string[] = [];
  fullPutAttempts = 0;
  private readonly bus = new InMemoryMessageBus();
  private readonly deps: CloudSessionMergeDeps;
  private clock = 10_000;
  private opCounter = 0;
  private requestCounter = 0;

  constructor(sessionId = 'session-delta-sync') {
    const initial = makeBaseSession(sessionId);
    this.desktop = this.makeNode('desktop', initial);
    this.cloud = this.makeNode('cloud', initial);
    this.mobile = this.makeNode('mobile', initial);
    this.deps = new InMemoryCloudDeps(() => this.cloud.session, (session) => {
      this.cloud.session = session;
    });
  }

  static resetGlobalServices(): void {
    vi.clearAllMocks();
    resetCloudSessionMergeServiceForTests();
    resetSessionSeqIndexForTests();
    resetServerClockForTests();
    resetSessionTombstoneStoreForTests();
  }

  private makeNode(name: NodeState['name'], session: AgentSession): NodeState {
    return {
      name,
      session: clone(session),
      cursor: 0,
      cursorHistory: [0],
      lastPushedMessageIds: new Set(),
      outbox: { pending: false, generation: 0 },
    };
  }

  private nextTimestamp(): number {
    this.clock += 10;
    setServerNowForTests(() => this.clock);
    return this.clock;
  }

  private sink(): CloudSessionEffectSink {
    return {
      emit: (event) => this.emitted.push(clone(event)),
      breadcrumb: (breadcrumb) => this.breadcrumbs.push(clone(breadcrumb)),
    };
  }

  private ensureSession(node: NodeState): AgentSession {
    if (!node.session) {
      node.session = makeBaseSession(this.cloud.session?.id ?? 'session-delta-sync');
    }
    return node.session;
  }

  private recordCursor(node: NodeState, cursor: number): void {
    node.cursor = cursor;
    node.cursorHistory.push(cursor);
  }

  private updateMetadataFromCloud(node: NodeState): void {
    if (!node.session || !this.cloud.session) return;
    node.session = {
      ...node.session,
      title: this.cloud.session.title,
      doneAt: this.cloud.session.doneAt,
      starredAt: this.cloud.session.starredAt,
      deletedAt: this.cloud.session.deletedAt,
      privateMode: this.cloud.session.privateMode,
      draft: this.cloud.session.draft ?? undefined,
      resolvedAt: this.cloud.session.resolvedAt,
      cloudUpdatedAt: this.cloud.session.cloudUpdatedAt,
      updatedAt: Math.max(node.session.updatedAt ?? 0, this.cloud.session.updatedAt ?? 0),
    };
  }

  desktopAppend(count = 1, turnId = `desktop-turn-${this.opCounter + 1}`): void {
    const session = this.ensureSession(this.desktop);
    const events = [...(session.eventsByTurn[turnId] ?? [])];
    for (let i = 0; i < count; i += 1) {
      const seq = getMaxSeqFromSession(session) + 1;
      events.push(makeStatusEvent({
        timestamp: this.nextTimestamp(),
        message: `desktop event ${this.opCounter}-${i}`,
        seq,
      }));
      session.maxSeq = seq;
    }
    session.eventsByTurn = { ...session.eventsByTurn, [turnId]: events };
    session.messages = [
      ...(session.messages ?? []),
      makeMessage({
        id: `desktop-message-${this.opCounter}`,
        turnId,
        text: `desktop message ${this.opCounter}`,
        createdAt: this.nextTimestamp(),
      }),
    ];
    session.updatedAt = this.nextTimestamp();
    this.desktop.outbox.pending = true;
    this.desktop.outbox.generation += 1;
    this.opCounter += 1;
  }

  desktopAppendOversizedAndSmall(): void {
    const session = this.ensureSession(this.desktop);
    const turnId = `oversized-turn-${this.opCounter}`;
    const firstSeq = getMaxSeqFromSession(session) + 1;
    session.eventsByTurn = {
      ...session.eventsByTurn,
      [turnId]: [
        makeStatusEvent({ timestamp: this.nextTimestamp(), message: `small ${this.opCounter}`, seq: firstSeq }),
        makeStatusEvent({ timestamp: this.nextTimestamp(), message: `oversized:${'x'.repeat(128)}`, seq: firstSeq + 1 }),
        makeStatusEvent({ timestamp: this.nextTimestamp(), message: `small after ${this.opCounter}`, seq: firstSeq + 2 }),
      ],
    };
    session.maxSeq = firstSeq + 2;
    this.desktop.outbox.pending = true;
    this.desktop.outbox.generation += 1;
    this.opCounter += 1;
  }

  cursorRotation(): void {
    this.desktop.outbox.generation += 1;
  }

  async desktopOutboxDrain(options: { lostResponse?: boolean; deferResponse?: boolean } = {}): Promise<void> {
    if (!this.desktop.outbox.pending || !this.desktop.session || !this.cloud.session) return;
    if (this.desktop.cursor > getMaxSeqFromSession(this.desktop.session)) {
      this.breadcrumbs.push({
        category: 'continuity.session-merge',
        level: 'warning',
        message: 'session-delta-push:lying-cursor-detected',
        data: { cursor: this.desktop.cursor, localMaxSeq: getMaxSeqFromSession(this.desktop.session) },
      });
      this.recordCursor(this.desktop, 0);
      await this.desktopPull();
      this.desktop.lastPushedMessageIds = new Set((this.cloud.session?.messages ?? []).map((message) => message.id));
    }

    if (this.desktop.cursor === 0 && getMaxSeqFromSession(this.cloud.session) > 0) {
      const cloudMessageIds = new Set((this.cloud.session.messages ?? []).map((message) => message.id));
      await this.desktopPull();
      this.desktop.lastPushedMessageIds = cloudMessageIds;
    }

    const delta = this.buildDesktopDelta();
    if (delta.events.length === 0 && delta.messageDelta.length === 0 && delta.messageDeletes.length === 0 && !delta.metadataPatch && !delta.destructiveOps) {
      this.desktop.outbox.pending = false;
      return;
    }

    const run = async (): Promise<void> => {
      const outcome = await processSessionEventsAppend(this.deps, {
        sessionId: this.desktop.session?.id ?? 'session-delta-sync',
        baseSeq: delta.baseSeq,
        events: delta.events,
        messageDelta: delta.messageDelta,
        messageDeletes: delta.messageDeletes,
        _destructiveOps: delta.destructiveOps,
        metadataPatch: delta.metadataPatch,
        idempotencyKey: `desktop:${this.desktop.outbox.generation}:${this.requestCounter += 1}:${delta.fingerprint}`,
        surface: 'desktop',
        source: 'desktop',
        sink: this.sink(),
      });

      if (outcome.kind === 'needs-reconcile') {
        await this.desktopPull();
        await this.desktopOutboxDrain();
        return;
      }
      if (outcome.kind === 'tombstoned') {
        this.desktop.session = null;
        this.desktop.outbox.pending = false;
        return;
      }
      if (outcome.kind !== 'applied') return;
      if (!options.lostResponse) {
        this.applyDesktopAppliedSeq(delta.sentRefs, outcome.appliedSeq);
        this.dedupeLocalEvents(this.desktop.session);
        if (outcome.serverSeq > delta.baseSeq + outcome.appliedCount) {
          await this.desktopPull();
        }
        this.recordCursor(this.desktop, outcome.serverSeq);
        this.desktop.lastPushedMessageIds = new Set((this.desktop.session?.messages ?? []).map((message) => message.id));
        this.desktop.outbox.pending = false;
        this.desktop.outbox.destructiveOps = undefined;
      }
    };

    if (options.deferResponse) {
      this.bus.enqueue(run);
      return;
    }
    await run();
  }

  async desktopRetryWithLostResponse(): Promise<void> {
    await this.desktopOutboxDrain({ lostResponse: true });
    if (this.cloud.session) {
      this.desktop.session = clone(this.cloud.session);
      this.recordCursor(this.desktop, getMaxSeqFromSession(this.cloud.session));
      this.desktop.lastPushedMessageIds = new Set((this.cloud.session.messages ?? []).map((message) => message.id));
    }
    this.desktop.outbox.pending = false;
    this.desktop.outbox.destructiveOps = undefined;
  }

  async cloudNativeAppend(count = 1, origin: 'cloud' | 'mobile' = 'cloud'): Promise<void> {
    if (!this.cloud.session) return;
    const events = Array.from({ length: count }, (_, index) => ({
      ...makeStatusEvent({
        timestamp: this.nextTimestamp(),
        message: `${origin} event ${this.opCounter}-${index}`,
        seq: null,
        clientOrdinal: index,
      }),
      turnId: `${origin}-turn-${this.opCounter}`,
    } as SessionEventsAppendEvent));
    const message = makeMessage({
      id: `${origin}-message-${this.opCounter}`,
      turnId: `${origin}-turn-${this.opCounter}`,
      text: `${origin} message ${this.opCounter}`,
      createdAt: this.nextTimestamp(),
    });
    await processSessionEventsAppend(this.deps, {
      sessionId: this.cloud.session.id,
      baseSeq: getMaxSeqFromSession(this.cloud.session),
      events,
      messageDelta: [message],
      surface: origin === 'mobile' ? 'mobile' : 'cloud',
      source: origin,
      sink: this.sink(),
    });
    this.opCounter += 1;
  }

  async cloudNativeAppendInflightStampingRace(): Promise<void> {
    if (!this.desktop.outbox.pending) this.desktopAppend(1, `race-desktop-${this.opCounter}`);
    await this.desktopOutboxDrain({ deferResponse: true });
    await this.cloudNativeAppend(1, 'cloud');
    await this.bus.flushAll();
    this.desktop.outbox.pending = true;
    await this.desktopOutboxDrain();
  }

  async mobilePatch(patch: AgentSessionMetadataPatch = { title: `Mobile title ${this.opCounter}` }): Promise<void> {
    if (!this.mobile.session || !this.cloud.session) return;
    const outcome = await processSessionEventsAppend(this.deps, {
      sessionId: this.mobile.session.id,
      baseSeq: this.mobile.cursor,
      events: [],
      metadataPatch: patch,
      clientCloudUpdatedAt: this.mobile.session.cloudUpdatedAt,
      surface: 'mobile',
      source: 'mobile',
      sink: this.sink(),
    });
    if (outcome.kind === 'needs-reconcile') {
      await this.mobilePull();
      await this.mobilePatch(patch);
      return;
    }
    if (outcome.kind === 'applied') {
      const { draft, finishLine, ...patchWithoutNullables } = patch;
      this.mobile.session = {
        ...this.mobile.session,
        ...patchWithoutNullables,
        ...(draft !== undefined ? { draft: draft ?? undefined } : {}),
        ...(finishLine !== undefined ? { finishLine: finishLine ?? undefined } : {}),
        cloudUpdatedAt: outcome.cloudUpdatedAt,
      };
    }
    this.opCounter += 1;
  }

  async desktopPull(): Promise<void> {
    await this.pullNode(this.desktop);
  }

  async previewDesktopCatchUp(): Promise<Awaited<ReturnType<typeof getCatchUpEvents>>> {
    const id = this.cloud.session?.id ?? this.desktop.session?.id ?? 'session-delta-sync';
    return getCatchUpEvents(this.deps, { sessionId: id, sinceSeq: this.desktop.cursor, limit: 5_000 });
  }

  async mobilePull(): Promise<void> {
    if (!this.cloud.session) {
      this.mobile.session = null;
      this.mobile.outbox.pending = false;
      return;
    }
    this.mobile.session = clone(this.cloud.session);
    this.recordCursor(this.mobile, getMaxSeqFromSession(this.cloud.session));
  }

  async tombstone(): Promise<void> {
    const id = this.cloud.session?.id ?? this.desktop.session?.id ?? this.mobile.session?.id ?? 'session-delta-sync';
    await processSessionDelete(this.deps, { sessionId: id, deletedBy: 'desktop' });
    await this.desktopPull();
    await this.mobilePull();
  }

  destructiveOp(kind: 'truncate' | 'delete' = 'truncate'): void {
    const session = this.ensureSession(this.desktop);
    const first = sortedEvents(session)[0];
    if (!first) {
      this.desktopAppend(1, `destructive-seed-${this.opCounter}`);
      return this.destructiveOp(kind);
    }
    if (kind === 'truncate') {
      session.eventsByTurn = { ...session.eventsByTurn, [first.turnId]: [] };
      session.messages = (session.messages ?? []).filter((message) => message.turnId !== first.turnId);
      this.desktop.outbox.destructiveOps = {
        ...this.desktop.outbox.destructiveOps,
        truncateTurns: [...(this.desktop.outbox.destructiveOps?.truncateTurns ?? []), first.turnId],
      };
    } else {
      session.eventsByTurn = {
        ...session.eventsByTurn,
        [first.turnId]: (session.eventsByTurn[first.turnId] ?? []).filter((event) => event !== first.event),
      };
      session.messages = (session.messages ?? []).filter((message) => message.turnId !== first.turnId);
      this.desktop.outbox.destructiveOps = {
        ...this.desktop.outbox.destructiveOps,
        deleteEventIdentities: [
          ...(this.desktop.outbox.destructiveOps?.deleteEventIdentities ?? []),
          getEventIdentity(first.turnId, first.event),
        ],
      };
    }
    this.desktop.outbox.pending = true;
    this.desktop.outbox.generation += 1;
  }

  deleteDesktopMessage(messageId: string): void {
    if (!this.desktop.session) return;
    this.desktop.session.messages = (this.desktop.session.messages ?? []).filter((message) => message.id !== messageId);
    this.desktop.outbox.pending = true;
    this.desktop.outbox.generation += 1;
  }

  async cloudSideTruncate(turnId: string): Promise<void> {
    if (!this.cloud.session) return;
    await processSessionEventsAppend(this.deps, {
      sessionId: this.cloud.session.id,
      baseSeq: getMaxSeqFromSession(this.cloud.session),
      events: [],
      _destructiveOps: { truncateTurns: [turnId] },
      surface: 'mobile',
      source: 'mobile',
      sink: this.sink(),
    });
  }

  setDesktopCursor(cursor: number): void {
    this.recordCursor(this.desktop, cursor);
  }

  seedCloudSession(session: AgentSession): void {
    this.cloud.session = clone(session);
  }

  seedDesktopSession(session: AgentSession, cursor = 0): void {
    this.desktop.session = clone(session);
    this.recordCursor(this.desktop, cursor);
    this.desktop.lastPushedMessageIds = new Set((session.messages ?? []).map((message) => message.id));
  }

  seedMobileSession(session: AgentSession, cursor = 0): void {
    this.mobile.session = clone(session);
    this.recordCursor(this.mobile, cursor);
  }

  async fullPutFromDesktopWithDifferentContent(): Promise<void> {
    if (!this.desktop.session) return;
    this.fullPutAttempts += 1;
    await processSessionPut(this.deps, {
      sessionId: this.desktop.session.id,
      incomingRaw: clone(this.desktop.session) as unknown as Record<string, unknown>,
      source: 'old-desktop',
      surface: 'desktop',
      sink: this.sink(),
    });
  }

  async settle(): Promise<void> {
    await this.bus.flushAll();
    for (let i = 0; i < 10; i += 1) {
      if (!this.desktop.outbox.pending) break;
      await this.desktopOutboxDrain();
    }
    await this.desktopPull();
    await this.mobilePull();
    expect(this.bus.size).toBe(0);
    expect(this.desktop.outbox.pending).toBe(false);
  }

  getStateForAssertion(): AssertionState {
    return {
      desktop: this.desktop,
      cloud: this.cloud,
      mobile: this.mobile,
      breadcrumbs: this.breadcrumbs,
      emitted: this.emitted,
      permanentFailures: this.permanentFailures,
      fullPutAttempts: this.fullPutAttempts,
    };
  }

  expectConverged(): void {
    const desktop = normalizeSessionForConvergence(this.desktop.session);
    const cloud = normalizeSessionForConvergence(this.cloud.session);
    const mobile = normalizeSessionForConvergence(this.mobile.session);
    expect(desktop).toEqual(cloud);
    expect(mobile).toEqual(cloud);
    this.expectSeqMonotonic(this.cloud.session);
    this.expectNoDuplicates(this.cloud.session);
    for (let i = 1; i < this.desktop.cursorHistory.length; i += 1) {
      if (this.desktop.cursorHistory[i] < this.desktop.cursorHistory[i - 1]) {
        expect(this.breadcrumbs.some((breadcrumb) => breadcrumb.message === 'session-delta-push:lying-cursor-detected')).toBe(true);
      } else {
        expect(this.desktop.cursorHistory[i]).toBeGreaterThanOrEqual(this.desktop.cursorHistory[i - 1]);
      }
    }
  }

  private buildDesktopDelta(): {
    baseSeq: number;
    events: SessionEventsAppendEvent[];
    messageDelta: SessionMessage[];
    messageDeletes: string[];
    metadataPatch?: AgentSessionMetadataPatch;
    destructiveOps?: DestructiveOps;
    fingerprint: string;
    sentRefs: AgentEvent[];
  } {
    const session = this.ensureSession(this.desktop);
    const events: SessionEventsAppendEvent[] = [];
    const sentRefs: AgentEvent[] = [];
    const nextOrdinalByTurn = new Map<string, number>();
    for (const [turnId, turnEvents] of Object.entries(session.eventsByTurn ?? {})) {
      for (let index = 0; index < turnEvents.length; index += 1) {
        const event = turnEvents[index];
        if (typeof event.seq !== 'number' || event.seq <= this.desktop.cursor) continue;
        const eventMessage = 'message' in event && typeof event.message === 'string' ? event.message : '';
        if (eventMessage.startsWith('oversized:')) {
          this.permanentFailures.push(eventIdentityWithFallback(turnId, event));
          session.eventsByTurn[turnId] = (session.eventsByTurn[turnId] ?? []).filter((candidate) => candidate !== event);
          continue;
        }
        const clientOrdinal = nextOrdinalByTurn.get(turnId) ?? 0;
        nextOrdinalByTurn.set(turnId, clientOrdinal + 1);
        events.push({
          ...clone(event),
          turnId,
          seq: null,
          clientOrdinal,
        } as unknown as SessionEventsAppendEvent);
        sentRefs.push(event);
      }
    }
    const currentMessages = session.messages ?? [];
    const messageDelta = currentMessages.filter((message) => !this.desktop.lastPushedMessageIds.has(message.id));
    const currentIds = new Set(currentMessages.map((message) => message.id));
    const messageDeletes = [...this.desktop.lastPushedMessageIds].filter((id) => !currentIds.has(id));
    const metadataPatch = this.buildDesktopMetadataPatch();
    const fingerprint = JSON.stringify({
      events: events.map((event) => eventIdentityWithFallback(event.turnId, event)),
      messageDelta: messageDelta.map((message) => message.id),
      messageDeletes,
      metadataPatch,
      destructiveOps: this.desktop.outbox.destructiveOps,
    });
    return {
      baseSeq: this.desktop.cursor,
      events,
      messageDelta,
      messageDeletes,
      metadataPatch,
      destructiveOps: this.desktop.outbox.destructiveOps,
      fingerprint,
      sentRefs,
    };
  }

  private buildDesktopMetadataPatch(): AgentSessionMetadataPatch | undefined {
    if (!this.desktop.session || !this.cloud.session) return undefined;
    const patch: AgentSessionMetadataPatch = {};
    if (this.desktop.session.title !== this.cloud.session.title) patch.title = this.desktop.session.title;
    if ((this.desktop.session.doneAt ?? null) !== (this.cloud.session.doneAt ?? null)) patch.doneAt = this.desktop.session.doneAt ?? null;
    if ((this.desktop.session.starredAt ?? null) !== (this.cloud.session.starredAt ?? null)) patch.starredAt = this.desktop.session.starredAt ?? null;
    if ((this.desktop.session.deletedAt ?? null) !== (this.cloud.session.deletedAt ?? null)) patch.deletedAt = this.desktop.session.deletedAt ?? null;
    if ((this.desktop.session.privateMode ?? false) !== (this.cloud.session.privateMode ?? false)) patch.privateMode = this.desktop.session.privateMode ?? false;
    if ((this.desktop.session.resolvedAt ?? null) !== (this.cloud.session.resolvedAt ?? null)) patch.resolvedAt = this.desktop.session.resolvedAt ?? null;
    if ((this.desktop.session.finishLine ?? null) !== (this.cloud.session.finishLine ?? null)) {
      patch.finishLine = this.desktop.session.finishLine ?? null;
    }
    return Object.keys(patch).length > 0 ? patch : undefined;
  }

  private applyDesktopAppliedSeq(sentRefs: AgentEvent[], appliedSeq: number[]): void {
    if (!this.desktop.session) return;
    sentRefs.forEach((event, index) => {
      if (appliedSeq[index]) {
        event.seq = appliedSeq[index];
      }
    });
    this.desktop.session.maxSeq = getMaxSeqFromSession(this.desktop.session);
  }

  private async pullNode(node: NodeState): Promise<void> {
    const id = this.cloud.session?.id ?? node.session?.id ?? 'session-delta-sync';
    const outcome = await getCatchUpEvents(this.deps, { sessionId: id, sinceSeq: node.cursor, limit: 5_000 });
    if (outcome.kind === 'tombstoned' || !this.cloud.session) {
      node.session = null;
      node.outbox.pending = false;
      return;
    }
    if (outcome.kind !== 'events') return;
    const session = this.ensureSession(node);
    this.applyDestructiveOpsToLocal(session, outcome.destructiveOpsApplied);
    this.applyCatchUpEvents(node, outcome.events, outcome.serverSeq);
    this.applyMessageDeltaAndDeletes(session, outcome.messageDelta ?? [], outcome.messageDeletes ?? []);
    this.dedupeLocalEvents(session);
    this.updateMetadataFromCloud(node);
    this.recordCursor(node, Math.max(node.cursor, outcome.serverSeq));
    if (node.name === 'desktop') {
      node.lastPushedMessageIds = new Set((this.cloud.session?.messages ?? []).map((message) => message.id));
    }
  }

  private applyCatchUpEvents(node: NodeState, events: Array<AgentEvent & { turnId: string; seq: number }>, serverSeq: number): void {
    const session = this.ensureSession(node);
    const pulledIdentities = new Set(events.map((event) => getEventIdentity(event.turnId, event)));
    if (events.length > 0) {
      let nextLocalSeq = Math.max(serverSeq, getMaxSeqFromSession(session));
      for (const event of sortedEvents(session)) {
        const seq = event.event.seq;
        if (typeof seq === 'number' && seq > node.cursor && seq <= serverSeq && !pulledIdentities.has(getEventIdentity(event.turnId, event.event))) {
          nextLocalSeq += 1;
          event.event.seq = nextLocalSeq;
        }
      }
    }
    const identitySet = new Set(sortedEvents(session).map(({ turnId, event }) => getEventIdentity(turnId, event)));
    for (const event of events) {
      const { turnId, ...withoutTurnId } = event;
      const eventWithoutTurnId = withoutTurnId as unknown as AgentEvent;
      const identity = getEventIdentity(turnId, eventWithoutTurnId);
      if (identitySet.has(identity)) continue;
      session.eventsByTurn[turnId] = [...(session.eventsByTurn[turnId] ?? []), eventWithoutTurnId];
      identitySet.add(identity);
    }
    session.maxSeq = getMaxSeqFromSession(session);
  }

  private applyDestructiveOpsToLocal(session: AgentSession, ops: DestructiveOpsApplied | undefined): void {
    if (!ops) return;
    for (const turnId of ops.truncatedTurns) {
      session.eventsByTurn[turnId] = [];
    }
    for (const identity of ops.deletedEventIdentities) {
      for (const [turnId, events] of Object.entries(session.eventsByTurn)) {
        session.eventsByTurn[turnId] = events.filter((event) => getEventIdentity(turnId, event) !== identity);
      }
    }
  }

  private applyMessageDeltaAndDeletes(session: AgentSession, messageDelta: SessionMessage[], messageDeletes: string[]): void {
    const messagesById = new Map<string, SessionMessage>();
    for (const message of session.messages ?? []) messagesById.set(message.id, message);
    for (const message of messageDelta) messagesById.set(message.id, message);
    for (const id of messageDeletes) messagesById.delete(id);
    session.messages = [...messagesById.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  private dedupeLocalEvents(session: AgentSession | null): void {
    if (!session) return;
    for (const [turnId, events] of Object.entries(session.eventsByTurn ?? {})) {
      const seen = new Set<string>();
      session.eventsByTurn[turnId] = events.filter((event) => {
        const identity = getEventIdentity(turnId, event);
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      });
    }
  }

  private expectSeqMonotonic(session: AgentSession | null): void {
    const seqs = session ? getSequencedEventsSince(session, 0).events.map((event) => event.seq) : [];
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  }

  private expectNoDuplicates(session: AgentSession | null): void {
    const identities = new Set<string>();
    const seqs = new Set<number>();
    for (const { turnId, event } of sortedEvents(session)) {
      const identity = getEventIdentity(turnId, event);
      expect(identities.has(identity)).toBe(false);
      identities.add(identity);
      if (typeof event.seq === 'number') {
        expect(seqs.has(event.seq)).toBe(false);
        seqs.add(event.seq);
      }
    }
  }
}

export function createTriplet(sessionId?: string): DeltaSyncTriplet {
  DeltaSyncTriplet.resetGlobalServices();
  return new DeltaSyncTriplet(sessionId);
}

export const tripletFixtures = {
  makeBaseSession,
  makeStatusEvent,
  makeMessage,
  normalizeSessionForConvergence,
  sortedEvents,
};
