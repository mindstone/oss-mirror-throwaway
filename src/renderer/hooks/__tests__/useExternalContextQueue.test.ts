/**
 * Stage 7 — tests for `useExternalContextQueue` store logic.
 *
 * The React subscription hook itself is a thin `useEffect` wrapper that
 * relies on the preload IPC factories; we verify the reducer behaviour
 * of the underlying Zustand store directly since testing-library is not
 * installed in this repo (see useDialogStates.test.ts for the same
 * pattern).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  useExternalContextQueueStore,
  type ExternalContextEntry,
} from '../useExternalContextQueue';

const getSession = (id: string): ExternalContextEntry | undefined =>
  useExternalContextQueueStore.getState().bySession[id];

describe('useExternalContextQueueStore', () => {
  beforeEach(() => {
    useExternalContextQueueStore.getState().reset();
  });

  it('recordArrival sets tabContext and lastReceivedAt (queueSize stays 0)', () => {
    useExternalContextQueueStore.getState().recordArrival({
      sessionId: 's1',
      appId: 'browser-extension',
      tabContext: { tabId: 42, url: 'https://stripe.com', title: 'Stripe' },
      receivedAt: 1_700_000_000_000,
    });
    const snapshot = getSession('s1');
    expect(snapshot).toMatchObject({
      appId: 'browser-extension',
      tabContext: { tabId: 42, url: 'https://stripe.com', title: 'Stripe' },
      queueSize: 0,
      lastReceivedAt: 1_700_000_000_000,
    });
  });

  it('recordArrival twice: second tabContext overwrites first, timestamps advance', () => {
    const store = useExternalContextQueueStore.getState();
    store.recordArrival({
      sessionId: 's1',
      appId: 'browser-extension',
      tabContext: { tabId: 1, url: 'https://a.com' },
      receivedAt: 1_000,
    });
    store.recordArrival({
      sessionId: 's1',
      appId: 'browser-extension',
      tabContext: { tabId: 2, url: 'https://b.com' },
      receivedAt: 2_000,
    });
    const snap = getSession('s1');
    expect(snap?.tabContext?.url).toBe('https://b.com');
    expect(snap?.lastReceivedAt).toBe(2_000);
  });

  it('recordArrival stores additive Office documentContext without clobbering browser state', () => {
    const store = useExternalContextQueueStore.getState();
    store.recordArrival({
      sessionId: 's1',
      appId: 'office-addin',
      documentContext: { host: 'word', title: 'Quarterly Plan.docx' },
      receivedAt: 3_000,
    });
    const snap = getSession('s1');
    expect(snap?.documentContext).toEqual({ host: 'word', title: 'Quarterly Plan.docx' });
    expect(snap?.appId).toBe('office-addin');
  });

  it('recordBuffered keeps Office documentContext visible through drain updates', () => {
    const store = useExternalContextQueueStore.getState();
    store.recordBuffered({
      sessionId: 's1',
      appId: 'office-addin',
      text: 'Summarise this draft',
      queueSize: 2,
      documentContext: { host: 'word', title: 'Quarterly Plan.docx' },
      receivedAt: 3_100,
    });
    store.recordDrained({
      sessionId: 's1',
      flushedCount: 2,
      remaining: 0,
    });
    const snap = getSession('s1');
    expect(snap?.documentContext).toEqual({ host: 'word', title: 'Quarterly Plan.docx' });
    expect(snap?.queueSize).toBe(0);
    expect(snap?.lastBufferedPreview).toBeUndefined();
  });

  it('clears stale browser context when an Office update becomes the latest source', () => {
    const store = useExternalContextQueueStore.getState();
    store.recordArrival({
      sessionId: 's1',
      appId: 'browser-extension',
      tabContext: { tabId: 1, url: 'https://example.com', title: 'Example' },
      receivedAt: 1_000,
    });
    store.recordBuffered({
      sessionId: 's1',
      appId: 'office-addin',
      text: 'Summarise this draft',
      queueSize: 1,
      documentContext: { host: 'word', title: 'Quarterly Plan.docx' },
      receivedAt: 2_000,
    });

    const snap = getSession('s1');
    expect(snap?.appId).toBe('office-addin');
    expect(snap?.tabContext).toBeUndefined();
    expect(snap?.documentContext).toEqual({ host: 'word', title: 'Quarterly Plan.docx' });
  });

  it('clears stale Office context when a browser update becomes the latest source', () => {
    const store = useExternalContextQueueStore.getState();
    store.recordArrival({
      sessionId: 's1',
      appId: 'office-addin',
      documentContext: { host: 'word', title: 'Quarterly Plan.docx' },
      receivedAt: 1_000,
    });
    store.recordBuffered({
      sessionId: 's1',
      appId: 'browser-extension',
      text: 'Ask about this page',
      queueSize: 1,
      tabContext: { tabId: 2, url: 'https://docs.example.com', title: 'Docs' },
      receivedAt: 2_000,
    });

    const snap = getSession('s1');
    expect(snap?.appId).toBe('browser-extension');
    expect(snap?.documentContext).toBeUndefined();
    expect(snap?.tabContext).toEqual({
      tabId: 2,
      url: 'https://docs.example.com',
      title: 'Docs',
    });
  });

  it('recordArrival without tabContext keeps the previously-set tabContext', () => {
    const store = useExternalContextQueueStore.getState();
    store.recordArrival({
      sessionId: 's1',
      appId: 'browser-extension',
      tabContext: { tabId: 9, url: 'https://example.com' },
      receivedAt: 100,
    });
    store.recordArrival({
      sessionId: 's1',
      appId: 'browser-extension',
      receivedAt: 200,
    });
    const snap = getSession('s1');
    expect(snap?.tabContext?.url).toBe('https://example.com');
    expect(snap?.lastReceivedAt).toBe(200);
  });

  it('recordBuffered increments queueSize, stores preview, clamps preview to 120 chars', () => {
    const store = useExternalContextQueueStore.getState();
    const longText = 'x'.repeat(1000);
    store.recordBuffered({
      sessionId: 's1',
      appId: 'browser-extension',
      text: longText,
      queueSize: 1,
      receivedAt: 1_000,
    });
    const snap = getSession('s1');
    expect(snap?.queueSize).toBe(1);
    expect(snap?.lastBufferedPreview?.length).toBe(120);
    expect(snap?.lastReceivedAt).toBe(1_000);
  });

  it('recordBuffered: N updates reflect authoritative queueSize from main', () => {
    const store = useExternalContextQueueStore.getState();
    for (let i = 1; i <= 5; i++) {
      store.recordBuffered({
        sessionId: 's1',
        appId: 'browser-extension',
        text: `msg-${i}`,
        queueSize: i,
        receivedAt: i * 100,
      });
    }
    const snap = getSession('s1');
    expect(snap?.queueSize).toBe(5);
    expect(snap?.lastBufferedPreview).toBe('msg-5');
    expect(snap?.lastReceivedAt).toBe(500);
  });

  it('recordBuffered preserves tabContext from an earlier arrival', () => {
    const store = useExternalContextQueueStore.getState();
    store.recordArrival({
      sessionId: 's1',
      appId: 'browser-extension',
      tabContext: { tabId: 3, url: 'https://docs.anthropic.com' },
      receivedAt: 100,
    });
    store.recordBuffered({
      sessionId: 's1',
      appId: 'browser-extension',
      text: 'later message',
      queueSize: 1,
      receivedAt: 200,
    });
    const snap = getSession('s1');
    expect(snap?.tabContext?.url).toBe('https://docs.anthropic.com');
    expect(snap?.queueSize).toBe(1);
    expect(snap?.lastBufferedPreview).toBe('later message');
  });

  it('recordDrained to 0: clears queueSize and preview but keeps tabContext', () => {
    const store = useExternalContextQueueStore.getState();
    store.recordArrival({
      sessionId: 's1',
      appId: 'browser-extension',
      tabContext: { tabId: 1, url: 'https://stripe.com' },
      receivedAt: 1,
    });
    store.recordBuffered({
      sessionId: 's1',
      appId: 'browser-extension',
      text: 'held for you',
      queueSize: 2,
      receivedAt: 2,
    });
    store.recordDrained({
      sessionId: 's1',
      flushedCount: 2,
      remaining: 0,
    });
    const snap = getSession('s1');
    expect(snap?.queueSize).toBe(0);
    expect(snap?.lastBufferedPreview).toBeUndefined();
    // tabContext survives drain so BrowserContextChip keeps rendering
    expect(snap?.tabContext?.url).toBe('https://stripe.com');
  });

  it('recordDrained with remaining>0: preserves preview for still-held messages', () => {
    const store = useExternalContextQueueStore.getState();
    store.recordBuffered({
      sessionId: 's1',
      appId: 'browser-extension',
      text: 'alpha',
      queueSize: 3,
      receivedAt: 1,
    });
    store.recordDrained({
      sessionId: 's1',
      flushedCount: 2,
      remaining: 1,
    });
    const snap = getSession('s1');
    expect(snap?.queueSize).toBe(1);
    expect(snap?.lastBufferedPreview).toBe('alpha');
  });

  it('recordDrained for unknown session is a no-op', () => {
    const store = useExternalContextQueueStore.getState();
    store.recordDrained({ sessionId: 'missing', flushedCount: 0, remaining: 0 });
    expect(getSession('missing')).toBeUndefined();
  });

  it('clearForSession removes the entry', () => {
    const store = useExternalContextQueueStore.getState();
    store.recordArrival({
      sessionId: 's1',
      appId: 'browser-extension',
      receivedAt: 1,
    });
    expect(getSession('s1')).toBeDefined();
    store.clearForSession('s1');
    expect(getSession('s1')).toBeUndefined();
  });

  it('multiple sessions do not interfere', () => {
    const store = useExternalContextQueueStore.getState();
    store.recordBuffered({
      sessionId: 's1',
      appId: 'browser-extension',
      text: 'one',
      queueSize: 1,
      receivedAt: 1,
    });
    store.recordBuffered({
      sessionId: 's2',
      appId: 'browser-extension',
      text: 'two',
      queueSize: 2,
      receivedAt: 2,
    });
    expect(getSession('s1')?.queueSize).toBe(1);
    expect(getSession('s2')?.queueSize).toBe(2);
    store.recordDrained({ sessionId: 's1', flushedCount: 1, remaining: 0 });
    expect(getSession('s1')?.queueSize).toBe(0);
    expect(getSession('s2')?.queueSize).toBe(2);
  });

  it('reset wipes the whole store (test-only)', () => {
    const store = useExternalContextQueueStore.getState();
    store.recordArrival({
      sessionId: 's1',
      appId: 'browser-extension',
      receivedAt: 1,
    });
    store.recordArrival({
      sessionId: 's2',
      appId: 'browser-extension',
      receivedAt: 1,
    });
    store.reset();
    expect(Object.keys(useExternalContextQueueStore.getState().bySession)).toHaveLength(0);
  });
});
