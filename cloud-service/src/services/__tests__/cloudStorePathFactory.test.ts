/**
 * cloudStorePathOnlyFactory — corrupt-safe path resolution (F1 sweep).
 *
 * Path-only cloud stores (Slack workspace / BYOK / OAuth-state / pending-inbound /
 * recent-senders) need ONLY the backing file's `.path`. The old default factory
 * eagerly constructed the shim to read `.path`; now that the shim THROWS on a
 * corrupt-but-real file (F1), an eager construct-for-path would crash the cloud
 * server on boot. This factory resolves the path WITHOUT constructing, so a
 * corrupt file can never crash path resolution, and the resolved path matches
 * exactly what the shim/conf would write.
 *
 * Temp dirs only (REBEL_USER_DATA). Red→green: revert the default factories back
 * to `(opts) => createStore(opts)` and the "corrupt file does not throw" path
 * resolution crashes via the shim throw.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('cloudStorePathOnlyFactory', () => {
  const originalUserData = process.env.REBEL_USER_DATA;
  let userDataDir = '';

  beforeEach(() => {
    vi.resetModules();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-cloud-pathfactory-'));
    process.env.REBEL_USER_DATA = userDataDir;
  });

  afterEach(() => {
    vi.resetModules();
    if (originalUserData === undefined) {
      delete process.env.REBEL_USER_DATA;
    } else {
      process.env.REBEL_USER_DATA = originalUserData;
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  });

  it('resolves the SAME on-disk path the shim would write (parity, slash-name)', async () => {
    const { cloudStorePathOnlyFactory } = await import('../cloudStorePathFactory');
    const { Store } = await import('../../electronStoreShim');

    const name = 'slack/recentSenders';
    const handle = cloudStorePathOnlyFactory({ name, defaults: {} });

    // Construct the real shim (absent file → fresh init) and compare its .path.
    const real = new Store({ name, defaults: {} });
    expect(handle.path).toBe(real.path);
    expect(handle.path).toBe(path.join(userDataDir, 'slack', 'recentSenders.json'));
  });

  it('resolves the path WITHOUT constructing — a corrupt file does NOT throw', async () => {
    const { cloudStorePathOnlyFactory } = await import('../cloudStorePathFactory');

    // Seed a corrupt backing file: constructing the shim over it would throw.
    const filePath = path.join(userDataDir, 'slack');
    fs.mkdirSync(filePath, { recursive: true });
    const corrupt = path.join(filePath, 'workspace.json');
    fs.writeFileSync(corrupt, '{ not valid json');

    // Path resolution must not read/parse the file, so it must not throw.
    let resolved = '';
    expect(() => {
      resolved = cloudStorePathOnlyFactory({ name: 'slack/workspace', defaults: {} }).path;
    }).not.toThrow();
    expect(resolved).toBe(corrupt);
    // The corrupt file is untouched (never read, never written).
    expect(fs.readFileSync(corrupt, 'utf8')).toBe('{ not valid json');
  });

  it('data methods throw on misuse (it is a path handle, not a data store)', async () => {
    const { cloudStorePathOnlyFactory } = await import('../cloudStorePathFactory');
    const handle = cloudStorePathOnlyFactory({ name: 'slack/oauthStates', defaults: {} });

    expect(() => handle.get('k' as never)).toThrow(/path-only/);
    expect(() => handle.set('k' as never, 1 as never)).toThrow(/path-only/);
    expect(() => handle.store).toThrow(/path-only/);
  });
});
