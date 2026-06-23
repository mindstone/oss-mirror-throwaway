import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetChildProcessGoneThrottle,
  shouldCaptureChildProcessGoneThrottled,
  shouldCaptureProcessGone,
  toTelemetrySafeUrl,
} from '../processGoneCapture';

describe('shouldCaptureProcessGone', () => {
  it('skips the benign clean-exit teardown', () => {
    expect(shouldCaptureProcessGone('clean-exit')).toBe(false);
  });

  it('captures crash-class reasons (the blank-screen / app-bricked class)', () => {
    for (const reason of ['crashed', 'oom', 'killed', 'launch-failed', 'integrity-failure', 'abnormal-exit']) {
      expect(shouldCaptureProcessGone(reason)).toBe(true);
    }
  });

  it('surfaces an unknown/absent reason (rare, high-signal)', () => {
    expect(shouldCaptureProcessGone(undefined)).toBe(true);
    expect(shouldCaptureProcessGone(null)).toBe(true);
    expect(shouldCaptureProcessGone('')).toBe(true);
  });
});

describe('shouldCaptureChildProcessGoneThrottled', () => {
  afterEach(() => _resetChildProcessGoneThrottle());

  it('captures the first event for a key, then throttles within the window', () => {
    const t0 = 1_000_000;
    expect(shouldCaptureChildProcessGoneThrottled('GPU:crashed', t0)).toBe(true);
    // a GPU crash-loop: subsequent crashes within 5 min are suppressed
    expect(shouldCaptureChildProcessGoneThrottled('GPU:crashed', t0 + 1_000)).toBe(false);
    expect(shouldCaptureChildProcessGoneThrottled('GPU:crashed', t0 + 60_000)).toBe(false);
  });

  it('re-captures after the throttle window elapses', () => {
    const t0 = 2_000_000;
    expect(shouldCaptureChildProcessGoneThrottled('GPU:crashed', t0)).toBe(true);
    expect(shouldCaptureChildProcessGoneThrottled('GPU:crashed', t0 + 5 * 60_000 + 1)).toBe(true);
  });

  it('throttles per (type+reason) key independently', () => {
    const t0 = 3_000_000;
    expect(shouldCaptureChildProcessGoneThrottled('GPU:crashed', t0)).toBe(true);
    // a different process type / reason is a distinct signal
    expect(shouldCaptureChildProcessGoneThrottled('Utility:oom', t0 + 1)).toBe(true);
  });
});

describe('toTelemetrySafeUrl', () => {
  it('drops query and hash (potential signed-URL tokens)', () => {
    expect(toTelemetrySafeUrl('https://example.com/path?sig=SECRET&code=abc#access=TOKEN')).toBe(
      'https://example.com/path',
    );
  });

  it('keeps scheme + host + path for ordinary URLs', () => {
    expect(toTelemetrySafeUrl('http://localhost:5184/index.html')).toBe('http://localhost:5184/index.html');
  });

  it('collapses data:/blob: URLs to the scheme only (their path IS the payload)', () => {
    expect(toTelemetrySafeUrl('data:text/html;charset=utf-8,%3Chtml%3Esecret%3C/html%3E')).toBe('data:<omitted>');
    expect(toTelemetrySafeUrl('blob:https://x/9f-uuid')).toBe('blob:<omitted>');
  });

  it('never returns the raw value for unparseable input', () => {
    expect(toTelemetrySafeUrl('not a url at all')).toBe('<non-url>');
    expect(toTelemetrySafeUrl(undefined)).toBeUndefined();
    expect(toTelemetrySafeUrl(null)).toBeUndefined();
    expect(toTelemetrySafeUrl('')).toBeUndefined();
  });
});
