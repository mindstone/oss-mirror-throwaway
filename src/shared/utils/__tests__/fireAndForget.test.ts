import { describe, expect, it, vi } from 'vitest';
import { fireAndForget } from '../fireAndForget';

describe('fireAndForget', () => {
  it('does not log when promise resolves', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    fireAndForget(Promise.resolve(), 'resolving');

    // Flush microtask queue
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('logs rejection with correct label format', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('boom');

    fireAndForget(Promise.reject(boom), 'testLabel');

    // Flush microtask queue
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith('[fireAndForget:testLabel]', boom);
    errorSpy.mockRestore();
  });

  it('handles void/undefined value without error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Should not throw
    fireAndForget(undefined, 'voidValue');
    fireAndForget(undefined as unknown as void, 'explicitVoid');

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('catches rejection from sync-created rejected promise', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('sync reject');

    fireAndForget(Promise.reject(err), 'syncReject');

    await new Promise<void>((r) => setTimeout(r, 0));

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith('[fireAndForget:syncReject]', err);
    errorSpy.mockRestore();
  });
});
