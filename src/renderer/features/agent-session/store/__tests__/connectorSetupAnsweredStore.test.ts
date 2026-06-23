// @vitest-environment happy-dom
/**
 * Tests for the session-scoped connector-setup answered registry.
 *
 * @see docs-private/investigations/260416_duplicate_connector_setup_card.md
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useConnectorSetupAnsweredStore } from '../connectorSetupAnsweredStore';

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';
const KEY_X = 'build:zendesk';
const KEY_Y = 'extend:slack';

describe('useConnectorSetupAnsweredStore', () => {
  beforeEach(() => {
    useConnectorSetupAnsweredStore.getState()._reset();
  });

  it('markPending -> isSuppressed is true', () => {
    const { markPending, isSuppressed } = useConnectorSetupAnsweredStore.getState();
    markPending(SESSION_A, KEY_X);
    expect(useConnectorSetupAnsweredStore.getState().isSuppressed(SESSION_A, KEY_X)).toBe(true);
    expect(isSuppressed(SESSION_A, KEY_X)).toBe(true);
  });

  it('markAnswered -> isSuppressed is true and pending is cleared', () => {
    const store = useConnectorSetupAnsweredStore.getState();
    store.markPending(SESSION_A, KEY_X);
    store.markAnswered(SESSION_A, KEY_X);

    const next = useConnectorSetupAnsweredStore.getState();
    expect(next.isSuppressed(SESSION_A, KEY_X)).toBe(true);
    expect(next.answered.get(SESSION_A)?.has(KEY_X)).toBe(true);
    expect(next.pending.get(SESSION_A)?.has(KEY_X) ?? false).toBe(false);
  });

  it('clearPending -> isSuppressed is false (when not answered)', () => {
    const store = useConnectorSetupAnsweredStore.getState();
    store.markPending(SESSION_A, KEY_X);
    store.clearPending(SESSION_A, KEY_X);

    expect(useConnectorSetupAnsweredStore.getState().isSuppressed(SESSION_A, KEY_X)).toBe(false);
  });

  it('clearPending does NOT remove answered state', () => {
    const store = useConnectorSetupAnsweredStore.getState();
    store.markAnswered(SESSION_A, KEY_X);
    store.clearPending(SESSION_A, KEY_X);

    expect(useConnectorSetupAnsweredStore.getState().isSuppressed(SESSION_A, KEY_X)).toBe(true);
  });

  it('is isolated per session', () => {
    const store = useConnectorSetupAnsweredStore.getState();
    store.markAnswered(SESSION_A, KEY_X);

    const next = useConnectorSetupAnsweredStore.getState();
    expect(next.isSuppressed(SESSION_A, KEY_X)).toBe(true);
    expect(next.isSuppressed(SESSION_B, KEY_X)).toBe(false);
  });

  it('is isolated per key within a session', () => {
    const store = useConnectorSetupAnsweredStore.getState();
    store.markAnswered(SESSION_A, KEY_X);

    const next = useConnectorSetupAnsweredStore.getState();
    expect(next.isSuppressed(SESSION_A, KEY_X)).toBe(true);
    expect(next.isSuppressed(SESSION_A, KEY_Y)).toBe(false);
  });

  it('returns new Map/Set references on write for zustand reactivity', () => {
    const store = useConnectorSetupAnsweredStore.getState();

    const beforeAnswered = useConnectorSetupAnsweredStore.getState().answered;
    store.markAnswered(SESSION_A, KEY_X);
    const afterAnswered = useConnectorSetupAnsweredStore.getState().answered;
    expect(afterAnswered).not.toBe(beforeAnswered);

    const beforePending = useConnectorSetupAnsweredStore.getState().pending;
    store.markPending(SESSION_A, KEY_Y);
    const afterPending = useConnectorSetupAnsweredStore.getState().pending;
    expect(afterPending).not.toBe(beforePending);
  });

  it('is a no-op (same reference) when marking the same pending key twice', () => {
    const store = useConnectorSetupAnsweredStore.getState();
    store.markPending(SESSION_A, KEY_X);

    const before = useConnectorSetupAnsweredStore.getState().pending;
    store.markPending(SESSION_A, KEY_X);
    const after = useConnectorSetupAnsweredStore.getState().pending;
    expect(after).toBe(before);
  });

  it('clears the outer session entry when the last key is removed', () => {
    const store = useConnectorSetupAnsweredStore.getState();
    store.markPending(SESSION_A, KEY_X);
    store.clearPending(SESSION_A, KEY_X);

    expect(useConnectorSetupAnsweredStore.getState().pending.has(SESSION_A)).toBe(false);
  });
});
