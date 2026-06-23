// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@renderer/test-utils';

// Capture every showToast call so we can drive the action/cancel buttons.
const showToast = vi.fn();
vi.mock('@renderer/components/ui/Toast', () => ({
  useToast: () => ({ showToast, toasts: [], dismissToast: vi.fn() }),
}));

import {
  useConflictCleanupToast,
  buildCleanupOfferDescription,
  buildCleanupDoneDescription,
} from '../useConflictCleanupToast';

type ToastArg = {
  title: string;
  description?: string;
  variant?: string;
  action?: { label: string; onClick: () => void };
  cancel?: { label: string; onClick: () => void };
};

const SUMMARY = {
  runId: 'run-1',
  spaceRootAbsPath: '/core/space-a',
  spaceName: 'A',
  quarantineCount: 5,
  needsReviewCount: 1,
  sample: ['notes/a (1).md'],
};

let broadcastListener: ((info: typeof SUMMARY) => void) | null = null;
const unsubscribe = vi.fn();
const cleanupExecute = vi.fn();

function installWindowApis() {
  broadcastListener = null;
  (window as any).api = {
    onConflictCleanupAvailable: (cb: (info: typeof SUMMARY) => void) => {
      broadcastListener = cb;
      return unsubscribe;
    },
  };
  (window as any).spaceMaintenanceApi = {
    cleanupExecute: (...args: unknown[]) => cleanupExecute(...args),
  };
}

/** Drive a broadcast through the registered listener inside React act(). */
function emit(info: Partial<typeof SUMMARY> = {}) {
  act(() => {
    broadcastListener?.({ ...SUMMARY, ...info });
  });
}

const lastToast = (): ToastArg => showToast.mock.calls.at(-1)?.[0] as ToastArg;

describe('useConflictCleanupToast — behaviour (Opus MA#2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installWindowApis();
  });

  afterEach(() => {
    delete (window as any).api;
    delete (window as any).spaceMaintenanceApi;
  });

  it('shows the offer toast on a conflict-cleanup:available broadcast', () => {
    renderHook(() => useConflictCleanupToast());
    emit();
    expect(showToast).toHaveBeenCalledTimes(1);
    const t = lastToast();
    expect(t.title).toBe('Tidy up duplicate files?');
    expect(t.action?.label).toBe('Move 5 to cleanup folder');
    expect(t.cancel?.label).toBe('Not now');
  });

  it('does NOT show a confirm toast when quarantineCount <= 0', () => {
    renderHook(() => useConflictCleanupToast());
    emit({ quarantineCount: 0 });
    expect(showToast).not.toHaveBeenCalled();
  });

  it('dedups: a second broadcast for the same runId does not re-toast', () => {
    renderHook(() => useConflictCleanupToast());
    emit();
    emit(); // same runId
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('a different runId DOES toast again', () => {
    renderHook(() => useConflictCleanupToast());
    emit();
    emit({ runId: 'run-2' });
    expect(showToast).toHaveBeenCalledTimes(2);
  });

  it('confirm button → calls cleanupExecute with {runId, spaceRootAbsPath} then success toast', async () => {
    cleanupExecute.mockResolvedValue({ quarantined: 5, skipped: 0, errors: [] });
    renderHook(() => useConflictCleanupToast());
    emit();

    await act(async () => {
      lastToast().action?.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(cleanupExecute).toHaveBeenCalledWith({
      runId: 'run-1',
      spaceRootAbsPath: '/core/space-a',
    });
    const done = lastToast();
    expect(done.variant).toBe('success');
    expect(done.title).toBe('Cleanup done');
  });

  it('error result (quarantined 0 + errors) → warning toast, no crash', async () => {
    cleanupExecute.mockResolvedValue({
      quarantined: 0,
      skipped: 0,
      errors: ['lease contended'],
    });
    renderHook(() => useConflictCleanupToast());
    emit();

    await act(async () => {
      lastToast().action?.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    const errToast = lastToast();
    expect(errToast.variant).toBe('warning');
    expect(errToast.title).toBe("Cleanup didn't finish");
    expect(errToast.description).toContain('Nothing was deleted');
  });

  it('thrown/rejected cleanupExecute → warning toast, no crash', async () => {
    cleanupExecute.mockRejectedValue(new Error('boom'));
    renderHook(() => useConflictCleanupToast());
    emit();

    await act(async () => {
      lastToast().action?.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    const errToast = lastToast();
    expect(errToast.variant).toBe('warning');
    expect(errToast.description).toContain('your files are safe');
  });

  it('"Not now" cancel is a no-op (no execute call)', () => {
    renderHook(() => useConflictCleanupToast());
    emit();
    act(() => {
      lastToast().cancel?.onClick();
    });
    expect(cleanupExecute).not.toHaveBeenCalled();
  });

  it('unsubscribes the broadcast listener on unmount', () => {
    const { unmount } = renderHook(() => useConflictCleanupToast());
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('useConflictCleanupToast', () => {
  describe('exports', () => {
    it('exports the hook + message builders', () => {
      expect(typeof useConflictCleanupToast).toBe('function');
      expect(typeof buildCleanupOfferDescription).toBe('function');
      expect(typeof buildCleanupDoneDescription).toBe('function');
    });
  });

  describe('buildCleanupOfferDescription', () => {
    const base = {
      runId: 'r',
      spaceRootAbsPath: '/x',
      spaceName: 'S',
      quarantineCount: 0,
      needsReviewCount: 0,
      sample: [],
    };

    it('states the duplicate count', () => {
      const msg = buildCleanupOfferDescription({ ...base, quarantineCount: 12 });
      expect(msg).toContain('12 duplicate files');
      expect(msg).not.toContain('need your review');
    });

    it('uses singular when one file', () => {
      const msg = buildCleanupOfferDescription({ ...base, quarantineCount: 1 });
      expect(msg).toContain('1 duplicate file');
    });

    it('mentions needs-review count when present', () => {
      const msg = buildCleanupOfferDescription({
        ...base,
        quarantineCount: 12,
        needsReviewCount: 3,
      });
      expect(msg).toContain('3 more need your review');
    });
  });

  describe('buildCleanupDoneDescription', () => {
    it('states moved count + quarantine folder', () => {
      const msg = buildCleanupDoneDescription(12, 0);
      expect(msg).toContain('Moved 12 files');
      expect(msg).toContain('.rebel/conflicts-cleanup/');
      expect(msg).not.toContain('still need review');
    });

    it('mentions remaining review count', () => {
      const msg = buildCleanupDoneDescription(12, 3);
      expect(msg).toContain('3 still need review');
    });
  });
});
