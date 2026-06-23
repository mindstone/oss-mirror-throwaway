import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSlackRecentSenderPrincipalKey,
  createSlackRecentSendersStore,
} from '../slackRecentSendersStore';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function createHarness(nowStart = 1_000) {
  let now = nowStart;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-recent-senders-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'slackRecentSenders.json');
  const store = createSlackRecentSendersStore({
    now: () => now,
    log: { error: vi.fn() } as any,
    storeFactory: () => ({ path: filePath } as any),
  });
  return {
    store,
    filePath,
    tick() {
      now += 1;
      return now;
    },
  };
}

describe('slackRecentSendersStore', () => {
  it('inserts a new sender attempt', () => {
    const { store } = createHarness();
    const persisted = store.recordAttempt({
      transport: 'slack',
      teamId: 'T1',
      principalKind: 'human',
      authorId: 'u123abc',
      channelId: 'C1',
      channelType: 'channel',
      displayName: 'Ada',
      handle: 'ada',
    });

    expect(persisted.principalKey).toBe('slack:T1:human:U123ABC');
    expect(persisted.authorId).toBe('u123abc');
    expect(persisted.normalizedAuthorId).toBe('U123ABC');
    expect(persisted.teamId).toBe('T1');
    expect(persisted.attemptCount).toBe(1);
    expect(persisted.channelIds).toEqual(['C1']);
    expect(persisted.lastChannelType).toBe('channel');
    expect(store.list('T1')).toHaveLength(1);
  });

  it('updates existing sender attempts and appends channel ids', () => {
    const { store, tick } = createHarness();
    store.recordAttempt({
      transport: 'slack',
      teamId: 'T1',
      principalKind: 'human',
      authorId: 'u123abc',
      channelId: 'C1',
      channelType: 'im',
    });
    tick();
    const updated = store.recordAttempt({
      transport: 'slack',
      teamId: 'T1',
      principalKind: 'human',
      authorId: 'U123ABC',
      channelId: 'C2',
      channelType: 'channel',
      displayName: 'Updated',
    });

    expect(updated.attemptCount).toBe(2);
    expect(updated.lastChannelType).toBe('channel');
    expect(updated.authorId).toBe('U123ABC');
    expect(updated.normalizedAuthorId).toBe('U123ABC');
    expect(updated.channelIds.sort()).toEqual(['C1', 'C2']);
    expect(updated.displayName).toBe('Updated');
  });

  it('normalizes author-id variants onto the same principal key', () => {
    const { store } = createHarness();
    store.recordAttempt({
      transport: 'slack',
      teamId: 'T1',
      principalKind: 'human',
      authorId: 'uabc123',
      channelId: 'C1',
      channelType: 'im',
    });
    store.recordAttempt({
      transport: 'slack',
      teamId: 'T1',
      principalKind: 'human',
      authorId: '  UAbC123  ',
      channelId: 'C1',
      channelType: 'im',
    });

    const senders = store.list('T1');
    expect(senders).toHaveLength(1);
    expect(senders[0].attemptCount).toBe(2);
    expect(senders[0].principalKey).toBe('slack:T1:human:UABC123');
  });

  it('evicts the oldest sender when team cardinality exceeds 50', () => {
    const { store, tick } = createHarness();
    for (let index = 1; index <= 51; index += 1) {
      store.recordAttempt({
        transport: 'slack',
        teamId: 'T1',
        principalKind: 'human',
        authorId: `u${index}`,
        channelId: `C${index}`,
        channelType: 'channel',
      });
      tick();
    }

    const senders = store.list('T1');
    expect(senders).toHaveLength(50);
    const evictedKey = buildSlackRecentSenderPrincipalKey({
      transport: 'slack',
      teamId: 'T1',
      principalKind: 'human',
      normalizedAuthorId: 'U1',
    });
    expect(senders.some((sender) => sender.principalKey === evictedKey)).toBe(false);
  });

  it('persists data to disk', () => {
    const { store, filePath } = createHarness();
    store.recordAttempt({
      transport: 'slack',
      teamId: 'T1',
      principalKind: 'human',
      authorId: 'u555',
      channelId: 'C9',
      channelType: 'channel',
    });

    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(persisted.entries).toHaveLength(1);
    expect(persisted.entries[0].principalKey).toBe('slack:T1:human:U555');
  });
});
