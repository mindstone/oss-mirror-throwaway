import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireAndForget } from '../fireAndForget';

describe('fireAndForget', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('is a no-op for resolving promises', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fireAndForget(Promise.resolve('ok'), 'Test:resolves');
    // Wait a microtask.
    await new Promise((r) => setTimeout(r, 0));
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('logs rejected promises with the web-companion prefix + label', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('boom');
    fireAndForget(Promise.reject(error), 'Test:rejects');
    await new Promise((r) => setTimeout(r, 0));
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith('[web-companion:Test:rejects]', error);
  });

  it('is a no-op for synchronous void (e.g. RR7 BrowserRouter navigate)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fireAndForget(undefined, 'Test:voidsynchronous');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('logs rejections from thenables (not just native Promises)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('thenable boom');
    const thenable: PromiseLike<never> = {
      then: (_onFulfilled, onRejected) => {
        onRejected?.(error);
        return thenable as unknown as PromiseLike<never>;
      },
    };
    fireAndForget(thenable as unknown as Promise<unknown>, 'Test:thenable');
    await new Promise((r) => setTimeout(r, 0));
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith('[web-companion:Test:thenable]', error);
  });
});
