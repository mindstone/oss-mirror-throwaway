import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  CaptureResult,
  ScreenshotCaptureService,
} from '@core/screenshotCaptureService';

describe('ScreenshotCaptureService boundary (Stage 2 contract)', () => {
  let setScreenshotCaptureService: typeof import('@core/screenshotCaptureService').setScreenshotCaptureService;
  let getScreenshotCaptureService: typeof import('@core/screenshotCaptureService').getScreenshotCaptureService;

  beforeEach(async () => {
    // Reset the module-level singleton between tests so we can observe
    // initial state (null) and singleton-set behaviour independently.
    vi.resetModules();
    const mod = await import('@core/screenshotCaptureService');
    setScreenshotCaptureService = mod.setScreenshotCaptureService;
    getScreenshotCaptureService = mod.getScreenshotCaptureService;
  });

  it('returns null (not undefined, not throws) on a fresh module load before any set* call', () => {
    let result: ScreenshotCaptureService | null | undefined;
    expect(() => {
      result = getScreenshotCaptureService();
    }).not.toThrow();

    expect(result).toBeNull();
    expect(result).not.toBeUndefined();
    // Strict equality with null — guards against returning {} or other falsy values.
    expect(result === null).toBe(true);
  });

  it('returns the same impl reference after setScreenshotCaptureService (singleton invariant)', () => {
    const impl: ScreenshotCaptureService = {
      captureRebelWindow: vi.fn(
        async (): Promise<CaptureResult> => ({
          kind: 'error',
          errorCode: 'screenshot-not-supported-on-this-surface',
        }),
      ),
    };

    setScreenshotCaptureService(impl);

    const first = getScreenshotCaptureService();
    const second = getScreenshotCaptureService();

    // Reference identity, not structural equality — would fail if the getter
    // ever started cloning, wrapping, or boxing the impl.
    expect(first).toBe(impl);
    expect(second).toBe(impl);
    expect(first).toBe(second);
  });

  it('treats CaptureResult as a true discriminated union — narrowing by `kind` exposes only the variant fields', () => {
    // This test would fail to compile (and therefore fail under our strict
    // TS lint ratchet) if `CaptureResult` were widened to a non-discriminated
    // shape, e.g. an intersection or `kind: string`.
    const ok: CaptureResult = {
      kind: 'ok',
      path: '/tmp/foo.png',
      width: 1024,
      height: 768,
      theme: 'light',
      bytes: 12_345,
      currentSurface: 'home',
      base64Data: 'abc',
      mimeType: 'image/png',
    };
    const err: CaptureResult = {
      kind: 'error',
      errorCode: 'capture-busy',
    };

    function describeResult(result: CaptureResult): string {
      if (result.kind === 'ok') {
        // Narrowed: `path` must exist on this branch.
        const path: string = result.path;
        // @ts-expect-error errorCode is not on the 'ok' variant — narrowing must exclude it.
        const _shouldNotExist: unknown = result.errorCode;
        return path;
      }
      // Narrowed: `errorCode` must exist on this branch.
      const code: string = result.errorCode;
      // @ts-expect-error path is not on the 'error' variant — narrowing must exclude it.
      const _shouldNotExist: unknown = result.path;
      return code;
    }

    expect(describeResult(ok)).toBe('/tmp/foo.png');
    expect(describeResult(err)).toBe('capture-busy');
  });
});
