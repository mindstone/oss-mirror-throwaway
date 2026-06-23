/**
 * Unit coverage for the startup-dialog gate. The two existing install-hygiene
 * dialogs keep their own early-return (which short-circuits this wrapper in
 * automation at runtime), so the wrapper's no-op path is proven HERE rather than
 * via the env-guarded packaged launch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isAutomatedOrHeadlessContext: vi.fn<() => boolean>(() => false),
  showMessageBox: vi.fn<(o: unknown) => Promise<{ response: number; checkboxChecked: boolean }>>(() =>
    Promise.resolve({ response: 0, checkboxChecked: false }),
  ),
  showErrorBox: vi.fn<(title: string, content: string) => void>(() => {}),
}));

vi.mock('electron', () => ({
  dialog: {
    showMessageBox: (o: unknown) => mocks.showMessageBox(o),
    showErrorBox: (title: string, content: string) => mocks.showErrorBox(title, content),
  },
}));
vi.mock('@core/logger', () => ({ createScopedLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../../utils/testIsolation', () => ({
  isAutomatedOrHeadlessContext: () => mocks.isAutomatedOrHeadlessContext(),
}));

import { showStartupMessageBox, showStartupErrorBox } from '../startupDialog';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isAutomatedOrHeadlessContext.mockReturnValue(false);
  mocks.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false });
});

afterEach(() => vi.clearAllMocks());

describe('showStartupMessageBox', () => {
  it('delegates to dialog.showMessageBox in a normal user context', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: true });
    const r = await showStartupMessageBox({ message: 'hi', buttons: ['A', 'B'], cancelId: 1 });
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ response: 1, checkboxChecked: true });
  });

  it('NO-OPs (never calls the native modal) in an automated/headless context', async () => {
    mocks.isAutomatedOrHeadlessContext.mockReturnValue(true);
    const r = await showStartupMessageBox({ message: 'hi', buttons: ['Go', 'Not now'], cancelId: 1 });
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    // Returns the dialog's own cancel/decline response.
    expect(r).toEqual({ response: 1, checkboxChecked: false });
  });

  it('defaults the no-op response to 0 when no cancelId is given', async () => {
    mocks.isAutomatedOrHeadlessContext.mockReturnValue(true);
    const r = await showStartupMessageBox({ message: 'hi', buttons: ['Only'] });
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(r.response).toBe(0);
  });
});

describe('showStartupErrorBox', () => {
  it('delegates to dialog.showErrorBox in a normal user context', () => {
    showStartupErrorBox('Rebel startup failed', 'details');
    expect(mocks.showErrorBox).toHaveBeenCalledTimes(1);
    expect(mocks.showErrorBox).toHaveBeenCalledWith('Rebel startup failed', 'details');
  });

  it('NO-OPs (never shows the native error box) in an automated/headless context', () => {
    // This closes the chronic-E2E launch-hang residual: the startup-failure showErrorBox is an
    // equally-blocking [NSAlert runModal] and was previously gated by a separate, narrower
    // bootstrap-local predicate that missed --rebel-test. The SSOT now covers it.
    mocks.isAutomatedOrHeadlessContext.mockReturnValue(true);
    showStartupErrorBox('Rebel startup failed', 'details');
    expect(mocks.showErrorBox).not.toHaveBeenCalled();
  });

  it('is best-effort — a throwing error box never propagates (must not mask the startup failure)', () => {
    mocks.showErrorBox.mockImplementation(() => {
      throw new Error('dialog backend unavailable');
    });
    expect(() => showStartupErrorBox('Rebel startup failed', 'details')).not.toThrow();
  });
});
