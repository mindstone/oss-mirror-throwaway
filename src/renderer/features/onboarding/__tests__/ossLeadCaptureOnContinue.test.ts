import { describe, expect, it, vi } from 'vitest';
import { fireOssLeadCaptureOnContinue } from '../ossLeadCaptureOnContinue';

describe('fireOssLeadCaptureOnContinue', () => {
  it('fires captureOssLead with name + email when OSS and email present', () => {
    const captureOssLead = vi.fn().mockResolvedValue(undefined);
    fireOssLeadCaptureOnContinue({
      isOss: true,
      draft: { userFirstName: 'Alex', userEmail: 'alex@example.com' },
      api: { captureOssLead },
    });
    expect(captureOssLead).toHaveBeenCalledWith({ firstName: 'Alex', email: 'alex@example.com' });
  });

  it('omits firstName when only an email is present', () => {
    const captureOssLead = vi.fn().mockResolvedValue(undefined);
    fireOssLeadCaptureOnContinue({
      isOss: true,
      draft: { userEmail: 'alex@example.com' },
      api: { captureOssLead },
    });
    expect(captureOssLead).toHaveBeenCalledWith({ email: 'alex@example.com' });
  });

  it('does NOT fire in a commercial (non-OSS) build', () => {
    const captureOssLead = vi.fn();
    fireOssLeadCaptureOnContinue({
      isOss: false,
      draft: { userFirstName: 'Alex', userEmail: 'alex@example.com' },
      api: { captureOssLead },
    });
    expect(captureOssLead).not.toHaveBeenCalled();
  });

  it('does NOT fire when email is empty (name-only submission)', () => {
    const captureOssLead = vi.fn();
    fireOssLeadCaptureOnContinue({
      isOss: true,
      draft: { userFirstName: 'Alex', userEmail: '' },
      api: { captureOssLead },
    });
    expect(captureOssLead).not.toHaveBeenCalled();
  });

  it('does NOT fire when there is no draft', () => {
    const captureOssLead = vi.fn();
    fireOssLeadCaptureOnContinue({ isOss: true, draft: null, api: { captureOssLead } });
    expect(captureOssLead).not.toHaveBeenCalled();
  });

  // Load-bearing regression: a HUNG egress (promise that never resolves) must
  // not block the caller. The helper returns synchronously without awaiting.
  it('returns synchronously even when captureOssLead hangs forever', () => {
    const captureOssLead = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const start = Date.now();
    fireOssLeadCaptureOnContinue({
      isOss: true,
      draft: { userEmail: 'alex@example.com' },
      api: { captureOssLead },
    });
    // The call returned (we got here); it did not await the hung promise.
    expect(captureOssLead).toHaveBeenCalledTimes(1);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('swallows a rejecting egress without throwing to the caller', async () => {
    const captureOssLead = vi.fn().mockRejectedValue(new Error('boom'));
    expect(() =>
      fireOssLeadCaptureOnContinue({
        isOss: true,
        draft: { userEmail: 'alex@example.com' },
        api: { captureOssLead },
      }),
    ).not.toThrow();
    // Let the internal .catch settle so there's no unhandled rejection.
    await Promise.resolve();
    await Promise.resolve();
  });
});
