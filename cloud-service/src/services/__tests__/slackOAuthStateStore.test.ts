import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { StoreFactory } from '@core/storeFactory';
import {
  createSlackOAuthStateStore,
  SLACK_OAUTH_MAX_ACTIVE_STATES,
  SLACK_OAUTH_STATE_TTL_MS,
} from '../slackOAuthStateStore';

const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLogger,
}));

describe('slackOAuthStateStore', () => {
  let tempDir: string;
  let storeFactory: StoreFactory;
  let statePath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T00:00:00Z'));
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-oauth-'));
    statePath = path.join(tempDir, 'slack', 'oauthStates.json');
    storeFactory = ((opts) => ({
      path: path.join(tempDir, `${opts.name}.json`),
      get: () => undefined,
      set: () => undefined,
      has: () => false,
      delete: () => undefined,
      clear: () => undefined,
      store: {},
    })) as StoreFactory;
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function putState(state: string, createdAt = Date.now()) {
    const store = createSlackOAuthStateStore({ storeFactory });
    store.put({ state, clientId: `client-${state}`, clientSecret: `secret-${state}`, createdAt });
    return store;
  }

  function writeStateFile(states: Record<string, unknown>, filePath = statePath): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({ states }, null, 2)}\n`, 'utf8');
  }

  it('expires states after the TTL', () => {
    const store = putState('s1', Date.now() - SLACK_OAUTH_STATE_TTL_MS - 1);
    expect(store.consume('s1')).toEqual({ status: 'expired' });
  });

  it('consumes a state exactly at the TTL boundary', () => {
    const createdAt = Date.now() - SLACK_OAUTH_STATE_TTL_MS;
    const store = putState('s1', createdAt);
    expect(store.consume('s1', createdAt + SLACK_OAUTH_STATE_TTL_MS).status).toBe('ok');
  });

  it('expires a state one millisecond after the TTL boundary', () => {
    const createdAt = Date.now() - SLACK_OAUTH_STATE_TTL_MS - 1;
    const store = putState('s1', createdAt);
    expect(store.consume('s1', createdAt + SLACK_OAUTH_STATE_TTL_MS + 1)).toEqual({ status: 'expired' });
  });

  it('enforces single-use semantics', () => {
    const store = putState('s1');
    expect(store.consume('s1').status).toBe('ok');
    expect(store.consume('s1')).toEqual({ status: 'used' });
  });

  it('persists the atomic used flip on consume', () => {
    const store = putState('s1');
    const consumed = store.consume('s1');
    expect(consumed.status).toBe('ok');
    const freshStore = createSlackOAuthStateStore({ storeFactory });
    expect(freshStore.consume('s1')).toEqual({ status: 'used' });
  });

  it('prunes expired entries on write', () => {
    const store = putState('old', Date.now() - SLACK_OAUTH_STATE_TTL_MS - 1);
    store.put({ state: 'new', clientId: 'client', clientSecret: 'secret', createdAt: Date.now() });
    expect(store.consume('old')).toEqual({ status: 'missing' });
    expect(store.consume('new').status).toBe('ok');
  });

  it('reports active count for max-active enforcement', () => {
    const store = createSlackOAuthStateStore({ storeFactory });
    for (let i = 0; i < SLACK_OAUTH_MAX_ACTIVE_STATES; i += 1) {
      store.put({ state: `s${i}`, clientId: 'client', clientSecret: 'secret', createdAt: Date.now() });
    }
    expect(store.activeCount()).toBe(SLACK_OAUTH_MAX_ACTIVE_STATES);
  });

  it('uses the main state store and removes a tmp file found alongside it', () => {
    writeStateFile({
      s1: { state: 's1', clientId: 'client', clientSecret: 'secret', createdAt: Date.now(), used: false },
    });
    writeStateFile({
      partial: { state: 'partial', clientId: 'client', clientSecret: 'secret', createdAt: Date.now(), used: false },
    }, `${statePath}.tmp`);
    const store = createSlackOAuthStateStore({ storeFactory });
    expect(store.activeCount()).toBe(1);
    expect(fs.existsSync(`${statePath}.tmp`)).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: statePath, tmpPath: `${statePath}.tmp` }),
      'tmp file found alongside main store; using main, removing tmp',
    );
  });

  it('treats an orphan tmp state store as empty and removes it', () => {
    writeStateFile({
      partial: { state: 'partial', clientId: 'client', clientSecret: 'secret', createdAt: Date.now(), used: false },
    }, `${statePath}.tmp`);
    const store = createSlackOAuthStateStore({ storeFactory });
    expect(store.activeCount()).toBe(0);
    expect(fs.existsSync(`${statePath}.tmp`)).toBe(false);
  });
});
