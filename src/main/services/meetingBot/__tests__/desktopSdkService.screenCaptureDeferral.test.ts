/**
 * RC-5 deferral pin: initializeDesktopSdk must NOT request Screen Recording
 * eagerly at startup.
 *
 * Requesting `screen-capture` from the SDK at init popped the macOS "record this
 * computer's screen and audio" dialog ~45s after launch while the user was doing
 * something unrelated — it read as unprompted/alarming. Screen Recording is only
 * needed for LOCAL recording, so it is requested on-demand at the first
 * local-recording start (see localRecordingService.requestScreenCapturePermission).
 *
 * Driving initializeDesktopSdk() end-to-end requires the native Recall recorder
 * (the SDK is required() at runtime and its init() touches native code), which
 * isn't available in unit tests. So this pin is a source-contract assertion on
 * the init function body: it requests `accessibility` + `microphone` (still
 * needed for cloud-bot detection + mic input) but never `screen-capture`. The
 * companion behavioral pin lives in localRecordingService.screenCaptureDeferral.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SERVICE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../desktopSdkService.ts',
);
const source = readFileSync(SERVICE_PATH, 'utf8');

/** Extract the body of `export async function initializeDesktopSdk(...)` up to the
 * matching close brace, so assertions are scoped to startup init only. */
function initializeDesktopSdkBody(): string {
  const marker = 'export async function initializeDesktopSdk';
  const start = source.indexOf(marker);
  expect(start, 'initializeDesktopSdk should exist').toBeGreaterThanOrEqual(0);
  // Walk braces from the function's opening `{`.
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error('Could not find end of initializeDesktopSdk');
}

describe('initializeDesktopSdk — screen-capture deferral (source contract)', () => {
  const body = initializeDesktopSdkBody();

  it('still requests accessibility + microphone at init', () => {
    expect(body).toContain("requestPermission('accessibility')");
    expect(body).toContain("requestPermission('microphone')");
  });

  it('does NOT request screen-capture at init', () => {
    expect(body).not.toContain("requestPermission('screen-capture')");
    expect(body).not.toContain('requestPermission("screen-capture")');
  });

  it('the on-demand screen-capture helper lives in localRecordingService', () => {
    const localSource = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../localRecordingService.ts'),
      'utf8',
    );
    expect(localSource).toContain('export async function requestScreenCapturePermission');
    expect(localSource).toContain("requestPermission('screen-capture')");
  });

  it('the renderer-reached requestPermissions() invokes the deferred request before the Settings fallback', () => {
    // F1 (Codex review of 6e9463bd7): the renderer "record locally" flow calls
    // requestLocalRecordingPermissions() (=> requestPermissions) and returns early
    // if it fails, BEFORE startLocalRecording(). So the in-context SDK request must
    // live on THIS path or it's dead code. Pin: the screen-not-granted branch calls
    // requestScreenCapturePermission() and the System-Settings openExternal is only
    // the fallback after it (the SDK call precedes the Privacy_ScreenCapture open).
    // (vi.mock cannot intercept the installed SDK's runtime require() — confirmed
    // empirically — so this is pinned at the source level, like the init pin above.)
    const localSource = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../localRecordingService.ts'),
      'utf8',
    );
    const marker = 'export async function requestPermissions';
    const start = localSource.indexOf(marker);
    expect(start, 'requestPermissions should exist').toBeGreaterThanOrEqual(0);
    // Scope to the requestPermissions body (up to the next top-level export).
    const nextExport = localSource.indexOf('\nexport ', start + marker.length);
    const body = localSource.slice(start, nextExport === -1 ? undefined : nextExport);
    const requestIdx = body.indexOf('await requestScreenCapturePermission()');
    const settingsIdx = body.indexOf('Privacy_ScreenCapture');
    expect(requestIdx, 'requestPermissions must call requestScreenCapturePermission()').toBeGreaterThanOrEqual(0);
    expect(settingsIdx, 'requestPermissions still has the Settings fallback').toBeGreaterThanOrEqual(0);
    expect(requestIdx, 'SDK request must precede the Settings fallback').toBeLessThan(settingsIdx);
  });
});
