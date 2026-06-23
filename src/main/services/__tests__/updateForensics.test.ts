/**
 * Stage 3 — bug-report update-forensics attachments.
 *
 * Tests `gatherUpdateForensics()` and `attachUpdateForensicsToScope()` in
 * isolation: real fs against a temp directory for the gather happy paths,
 * `vi.spyOn` for the throwing-fs branch, and a hand-rolled scope mock for
 * the attach path.
 *
 * See `docs/plans/260428_install_completion_contract.md` (Stage 3 / C3 / I3 / I4).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  attachUpdateForensicsToScope,
  gatherUpdateForensics,
  type UpdateForensicsBundle,
  type UpdateForensicsManifestEntry,
} from '../bugReportDiagnosticService';

// =============================================================================
// Helpers
// =============================================================================

const TEST_BUNDLE_ID = 'com.mindstone.rebel.test-forensics';

let tempUserData: string;
let tempShipItCacheDir: string;
let originalHome: string | undefined;

function manifestEntry(
  bundle: UpdateForensicsBundle,
  filename: string,
): UpdateForensicsManifestEntry | undefined {
  return bundle.manifest.find((entry) => entry.filename === filename);
}

function attachmentByFilename(bundle: UpdateForensicsBundle, filename: string) {
  return bundle.attachments.find((attachment) => attachment.filename === filename);
}

function asString(data: Buffer | string): string {
  return typeof data === 'string' ? data : data.toString('utf-8');
}

beforeAll(async () => {
  // Set up an isolated `$HOME` so the macOS ShipIt-cache lookup uses our tmp.
  originalHome = process.env.HOME;
});

beforeEach(async () => {
  tempUserData = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-update-forensics-userdata-'));
  // Use a separate fake "home" so `os.homedir()` returns a writable temp path.
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-update-forensics-home-'));
  process.env.HOME = fakeHome;
  tempShipItCacheDir = path.join(fakeHome, 'Library', 'Caches', `${TEST_BUNDLE_ID}.ShipIt`);
  await fs.mkdir(tempShipItCacheDir, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Clean up tempdirs (best effort).
  try {
    await fs.rm(tempUserData, { recursive: true, force: true });
  } catch {
    // ignore
  }
  if (process.env.HOME) {
    try {
      await fs.rm(process.env.HOME, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

// =============================================================================
// gatherUpdateForensics — userData files
// =============================================================================

describe('gatherUpdateForensics — userData files', () => {
  it('attaches all three userData JSON files when present', async () => {
    await fs.writeFile(
      path.join(tempUserData, 'auto-update-state.json'),
      JSON.stringify({ stuckInstall: null, watchdogOnDiskVersion: '0.4.33' }, null, 2),
    );
    await fs.writeFile(
      path.join(tempUserData, 'auto-update-watchdog-telemetry.json'),
      JSON.stringify({ openFired: true }),
    );
    await fs.writeFile(
      path.join(tempUserData, 'update-install-marker.json'),
      JSON.stringify({ fromVersion: '0.4.33', targetVersion: '0.4.34' }),
    );

    const bundle = await gatherUpdateForensics({
      userDataPath: tempUserData,
      bundleId: TEST_BUNDLE_ID,
    });

    expect(manifestEntry(bundle, 'auto-update-state.json')?.status).toBe('attached');
    expect(manifestEntry(bundle, 'auto-update-watchdog-telemetry.json')?.status).toBe('attached');
    expect(manifestEntry(bundle, 'update-install-marker.json')?.status).toBe('attached');

    const stateAttachment = attachmentByFilename(bundle, 'auto-update-state.json');
    expect(stateAttachment).toBeDefined();
    expect(stateAttachment?.contentType).toBe('application/json');
    // Round-trips as JSON
    const parsed = JSON.parse(asString(stateAttachment!.data));
    expect(parsed.watchdogOnDiskVersion).toBe('0.4.33');
  });

  it('records missing files in manifest without throwing', async () => {
    // No files written into tempUserData.
    const bundle = await gatherUpdateForensics({
      userDataPath: tempUserData,
      bundleId: TEST_BUNDLE_ID,
    });

    expect(manifestEntry(bundle, 'auto-update-state.json')?.status).toBe('missing');
    expect(manifestEntry(bundle, 'auto-update-watchdog-telemetry.json')?.status).toBe('missing');
    expect(manifestEntry(bundle, 'update-install-marker.json')?.status).toBe('missing');
    // No attachments for missing files
    expect(attachmentByFilename(bundle, 'auto-update-state.json')).toBeUndefined();
  });

  it('records failed status with error code when readFile throws', async () => {
    await fs.writeFile(
      path.join(tempUserData, 'auto-update-state.json'),
      JSON.stringify({ ok: true }),
    );

    const realReadFile = fs.readFile;
    const readFileSpy = vi.spyOn(fs, 'readFile').mockImplementationOnce(async (filePath, options) => {
      const filePathStr = typeof filePath === 'string' ? filePath : filePath.toString();
      if (filePathStr.endsWith('auto-update-state.json')) {
        const err = new Error('permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      // Restore real readFile for any other calls during this test.
      return realReadFile(filePath, options as Parameters<typeof realReadFile>[1]);
    });

    const bundle = await gatherUpdateForensics({
      userDataPath: tempUserData,
      bundleId: TEST_BUNDLE_ID,
    });

    const entry = manifestEntry(bundle, 'auto-update-state.json');
    expect(entry?.status).toBe('failed');
    expect(entry?.error).toBe('EACCES');
    expect(readFileSpy).toHaveBeenCalled();
  });

  it('attaches raw bytes as auto-update-state.raw.json on JSON parse failure', async () => {
    const corruptContent = '{not really json';
    await fs.writeFile(path.join(tempUserData, 'auto-update-state.json'), corruptContent);

    const bundle = await gatherUpdateForensics({
      userDataPath: tempUserData,
      bundleId: TEST_BUNDLE_ID,
    });

    const entry = manifestEntry(bundle, 'auto-update-state.json');
    expect(entry?.status).toBe('failed');
    expect(entry?.error).toBe('parse');

    const rawAttachment = attachmentByFilename(bundle, 'auto-update-state.raw.json');
    expect(rawAttachment).toBeDefined();
    expect(asString(rawAttachment!.data)).toBe(corruptContent);
  });

  it('caps raw bytes at 64 KB on JSON parse failure', async () => {
    // Write something > 64 KB that cannot parse as JSON.
    const oversized = '{' + 'x'.repeat(80 * 1024);
    await fs.writeFile(path.join(tempUserData, 'auto-update-state.json'), oversized);

    const bundle = await gatherUpdateForensics({
      userDataPath: tempUserData,
      bundleId: TEST_BUNDLE_ID,
    });

    const rawAttachment = attachmentByFilename(bundle, 'auto-update-state.raw.json');
    expect(rawAttachment).toBeDefined();
    const length = Buffer.byteLength(asString(rawAttachment!.data), 'utf-8');
    expect(length).toBeLessThanOrEqual(64 * 1024);
  });
});

// =============================================================================
// gatherUpdateForensics — privacy scrub
// =============================================================================

describe('gatherUpdateForensics — privacy scrub', () => {
  it('replaces $HOME and /Users/<x>/ patterns in attachments with ~/', async () => {
    const home = process.env.HOME ?? os.homedir();
    const sample = `error opening ${home}/Library/Caches/foo and /Users/someoneelse/Desktop/bar.log`;

    await fs.writeFile(path.join(tempUserData, 'update-install-marker.json'), sample);

    const bundle = await gatherUpdateForensics({
      userDataPath: tempUserData,
      bundleId: TEST_BUNDLE_ID,
    });

    const attached = attachmentByFilename(bundle, 'update-install-marker.json');
    const text = asString(attached!.data);
    // $HOME replaced with `~`
    expect(text).not.toContain(home);
    expect(text).toContain('~/Library/Caches/foo');
    // Literal /Users/<x>/ replaced with ~/
    expect(text).not.toContain('/Users/someoneelse/');
    expect(text).toContain('~/Desktop/bar.log');
  });

  it('scrubs even when $HOME is unset', async () => {
    delete process.env.HOME;
    const sample = 'log line referencing /Users/charlie/Documents/secret.txt';
    await fs.writeFile(path.join(tempUserData, 'update-install-marker.json'), sample);

    const bundle = await gatherUpdateForensics({
      userDataPath: tempUserData,
      bundleId: TEST_BUNDLE_ID,
    });

    const text = asString(attachmentByFilename(bundle, 'update-install-marker.json')!.data);
    expect(text).not.toContain('/Users/charlie/');
    expect(text).toContain('~/Documents/secret.txt');
  });
});

// =============================================================================
// gatherUpdateForensics — macOS ShipIt files
// =============================================================================

describe.runIf(process.platform === 'darwin')('gatherUpdateForensics — macOS ShipIt log/plist', () => {
  it('caps ShipIt_stderr.log at 200 KB and returns the LAST 200 KB', async () => {
    // 250 KB of distinct head + tail markers
    const head = 'HEAD_MARKER_'.repeat(2_000); // ~24 KB
    const filler = 'x'.repeat(220 * 1024);
    const tail = 'TAIL_MARKER_'.repeat(2_000);
    const fullContent = head + filler + tail;
    expect(fullContent.length).toBeGreaterThan(200 * 1024);

    await fs.writeFile(path.join(tempShipItCacheDir, 'ShipIt_stderr.log'), fullContent);

    const bundle = await gatherUpdateForensics({
      userDataPath: tempUserData,
      bundleId: TEST_BUNDLE_ID,
    });

    const attached = attachmentByFilename(bundle, 'ShipIt_stderr.log');
    expect(attached).toBeDefined();
    const text = asString(attached!.data);
    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThanOrEqual(200 * 1024);
    // Tail must be present, head must NOT (since file is 250 KB > 200 KB cap).
    expect(text).toContain('TAIL_MARKER_');
    expect(text).not.toContain('HEAD_MARKER_');
  });

  it('attaches whole ShipIt_stderr.log when smaller than 200 KB', async () => {
    const small = 'small log content';
    await fs.writeFile(path.join(tempShipItCacheDir, 'ShipIt_stderr.log'), small);

    const bundle = await gatherUpdateForensics({
      userDataPath: tempUserData,
      bundleId: TEST_BUNDLE_ID,
    });

    const attached = attachmentByFilename(bundle, 'ShipIt_stderr.log');
    expect(asString(attached!.data)).toBe(small);
  });

  it('records ShipIt_stderr.log as missing when absent', async () => {
    const bundle = await gatherUpdateForensics({
      userDataPath: tempUserData,
      bundleId: TEST_BUNDLE_ID,
    });

    expect(manifestEntry(bundle, 'ShipIt_stderr.log')?.status).toBe('missing');
    expect(attachmentByFilename(bundle, 'ShipIt_stderr.log')).toBeUndefined();
  });

  it('attaches XML ShipItState.plist with home-path scrub applied', async () => {
    const home = process.env.HOME ?? os.homedir();
    const xmlPlist = `<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>InstallationPath</key><string>${home}/Library/Caches/foo.ShipIt</string></dict></plist>`;
    await fs.writeFile(path.join(tempShipItCacheDir, 'ShipItState.plist'), xmlPlist);

    const bundle = await gatherUpdateForensics({
      userDataPath: tempUserData,
      bundleId: TEST_BUNDLE_ID,
    });

    const attached = attachmentByFilename(bundle, 'ShipItState.plist');
    expect(attached).toBeDefined();
    expect(attached?.contentType).toBe('application/x-plist');
    const text = asString(attached!.data);
    expect(text).not.toContain(home);
    expect(text).toContain('~/Library/Caches/foo.ShipIt');
  });

  it('attaches binary ShipItState.plist as Buffer without scrubbing', async () => {
    // bplist00 magic bytes → treated as binary, attached as-is.
    const binaryPlist = Buffer.from([
      0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30, // "bplist00"
      0xd1, 0x01, 0x02, 0x03, 0x04, // arbitrary binary garbage
    ]);
    await fs.writeFile(path.join(tempShipItCacheDir, 'ShipItState.plist'), binaryPlist);

    const bundle = await gatherUpdateForensics({
      userDataPath: tempUserData,
      bundleId: TEST_BUNDLE_ID,
    });

    const attached = attachmentByFilename(bundle, 'ShipItState.plist');
    expect(attached).toBeDefined();
    expect(Buffer.isBuffer(attached!.data)).toBe(true);
    expect((attached!.data as Buffer).slice(0, 8).toString('utf-8')).toBe('bplist00');
  });

  it('records ShipItState.plist as missing when absent', async () => {
    const bundle = await gatherUpdateForensics({
      userDataPath: tempUserData,
      bundleId: TEST_BUNDLE_ID,
    });

    expect(manifestEntry(bundle, 'ShipItState.plist')?.status).toBe('missing');
  });
});

// =============================================================================
// gatherUpdateForensics — non-darwin platforms
// =============================================================================

describe.runIf(process.platform !== 'darwin')('gatherUpdateForensics — non-darwin platforms', () => {
  it('does not include macOS-specific files in the manifest', async () => {
    const bundle = await gatherUpdateForensics({
      userDataPath: tempUserData,
      bundleId: TEST_BUNDLE_ID,
    });

    expect(manifestEntry(bundle, 'ShipIt_stderr.log')).toBeUndefined();
    expect(manifestEntry(bundle, 'ShipItState.plist')).toBeUndefined();
  });
});

// =============================================================================
// attachUpdateForensicsToScope
// =============================================================================

describe('attachUpdateForensicsToScope', () => {
  function makeBundle(): UpdateForensicsBundle {
    return {
      attachments: [
        { filename: 'auto-update-state.json', data: '{"ok":true}', contentType: 'application/json' },
        { filename: 'ShipIt_stderr.log', data: 'log line', contentType: 'text/plain' },
        { filename: 'ShipItState.plist', data: Buffer.from('bplist00 binary'), contentType: 'application/x-plist' },
      ],
      manifest: [
        { filename: 'auto-update-state.json', status: 'attached' },
        { filename: 'auto-update-watchdog-telemetry.json', status: 'missing' },
        { filename: 'ShipIt_stderr.log', status: 'attached' },
        { filename: 'ShipItState.plist', status: 'attached' },
      ],
    };
  }

  it('forwards each attachment to scope.addAttachment plus a manifest entry', () => {
    const addAttachment = vi.fn();
    const scope = { addAttachment };
    const bundle = makeBundle();

    attachUpdateForensicsToScope(scope, bundle);

    // 3 file attachments + 1 manifest = 4 calls
    expect(addAttachment).toHaveBeenCalledTimes(4);

    const filenames = addAttachment.mock.calls.map((call) => call[0].filename);
    expect(filenames).toEqual([
      'auto-update-state.json',
      'ShipIt_stderr.log',
      'ShipItState.plist',
      'update-forensics-manifest.json',
    ]);

    // Manifest entry is JSON-stringified
    const manifestCall = addAttachment.mock.calls.find(
      (call) => call[0].filename === 'update-forensics-manifest.json',
    );
    expect(manifestCall).toBeDefined();
    expect(manifestCall![0].contentType).toBe('application/json');
    const parsed = JSON.parse(manifestCall![0].data);
    expect(parsed).toHaveLength(4);
    expect(parsed[1]).toEqual({ filename: 'auto-update-watchdog-telemetry.json', status: 'missing' });
  });

  it('continues attaching subsequent items when one addAttachment throws', () => {
    let callCount = 0;
    const addAttachment = vi.fn(() => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error('Sentry SDK rejected attachment');
      }
    });
    const scope = { addAttachment };
    const bundle = makeBundle();

    expect(() => attachUpdateForensicsToScope(scope, bundle)).not.toThrow();

    // All 4 attachments still attempted (3 files + manifest)
    expect(addAttachment).toHaveBeenCalledTimes(4);
  });

  it('still attaches manifest when every file attachment throws', () => {
    const addAttachment = vi.fn((args: { filename: string }) => {
      if (args.filename !== 'update-forensics-manifest.json') {
        throw new Error('boom');
      }
    });
    const scope = { addAttachment };

    expect(() => attachUpdateForensicsToScope(scope, makeBundle())).not.toThrow();
    const manifestCall = addAttachment.mock.calls.find(
      (call) => call[0].filename === 'update-forensics-manifest.json',
    );
    expect(manifestCall).toBeDefined();
  });

  it('still attaches manifest even when bundle has no attachments', () => {
    const addAttachment = vi.fn();
    const scope = { addAttachment };
    const bundle: UpdateForensicsBundle = {
      attachments: [],
      manifest: [
        { filename: 'auto-update-state.json', status: 'failed', error: 'parse' },
      ],
    };

    attachUpdateForensicsToScope(scope, bundle);
    expect(addAttachment).toHaveBeenCalledTimes(1);
    expect(addAttachment.mock.calls[0]?.[0].filename).toBe('update-forensics-manifest.json');
  });
});
