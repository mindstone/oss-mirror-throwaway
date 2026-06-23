import { describe, it, expect } from 'vitest';
import { classifyUploadFailureCategory } from '../offlineQueue/classifyUploadFailureCategory';

describe('classifyUploadFailureCategory', () => {
  it.each([401, 403])('maps %i to auth', (status) => {
    expect(classifyUploadFailureCategory(status)).toBe('auth');
  });

  // Genuinely-permanent: re-sending the same bytes won't help.
  it.each([400, 413, 415, 422])('maps %i to permanent', (status) => {
    expect(classifyUploadFailureCategory(status)).toBe('permanent');
  });

  // Transient 4xx — REBEL-6BJ / FOX-3516: must be retryable, NOT permanent.
  it.each([404, 408, 425, 429])('maps transient %i to temporary', (status) => {
    expect(classifyUploadFailureCategory(status)).toBe('temporary');
  });

  it.each([500, 502, 503, 504])('maps %i (server error) to temporary', (status) => {
    expect(classifyUploadFailureCategory(status)).toBe('temporary');
  });

  // Conservative default: any other / unknown 4xx is retryable rather than
  // destroying a recording.
  it.each([402, 405, 410, 418, 451])('maps unknown 4xx %i to temporary (conservative)', (status) => {
    expect(classifyUploadFailureCategory(status)).toBe('temporary');
  });

  it('never returns defer (attempt-neutral would cause endless retries)', () => {
    for (let status = 400; status < 600; status += 1) {
      expect(classifyUploadFailureCategory(status)).not.toBe('defer');
    }
  });
});
