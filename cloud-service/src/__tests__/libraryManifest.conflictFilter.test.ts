import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildCloudManifest } from '../routes/library';

/**
 * REBEL-62A — server-side conflict-copy filter for the cloud manifest builder.
 *
 * The per-user Fly cloud-service is the canonical store the desktop peers sync
 * against. If a polluted manifest or a stale desktop ever uploaded a
 * Drive/Dropbox conflict copy (`foo (1).md` / `Project (1)/`) whose original
 * sibling is present, mirroring it back would re-seed every peer with the
 * runaway `(1) (1) …` fan-out. buildCloudManifest now excludes such copies,
 * sibling-gated, mirroring desktop cloudWorkspaceSync.
 */
describe('buildCloudManifest — Drive/Dropbox conflict-copy filter (REBEL-62A)', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-manifest-conflict-'));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  function writeFile(relativePath: string, content: string): void {
    const absolute = path.join(workspaceDir, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, 'utf8');
  }

  it('excludes a numbered conflict copy whose original sibling is present', async () => {
    writeFile('foo.md', 'original content');
    writeFile('foo (1).md', 'drive conflict copy');

    const manifest = await buildCloudManifest(workspaceDir);

    expect(manifest.entries).toHaveProperty('foo.md');
    expect(manifest.entries).not.toHaveProperty('foo (1).md');
  });

  it('keeps a standalone numbered file when no original sibling exists (gate open)', async () => {
    writeFile('Report (1).md', 'genuine standalone file, not a conflict copy');

    const manifest = await buildCloudManifest(workspaceDir);

    expect(manifest.entries).toHaveProperty('Report (1).md');
  });

  it('prunes a conflict-copy directory subtree whose original dir is present', async () => {
    writeFile('Project/inner.md', 'original project file');
    writeFile('Project (1)/inner.md', 'drive conflict copy of the dir');

    const manifest = await buildCloudManifest(workspaceDir);

    expect(manifest.entries).toHaveProperty('Project/inner.md');
    expect(manifest.entries).not.toHaveProperty('Project (1)/inner.md');
    // The whole subtree is pruned, not just same-named files.
    expect(Object.keys(manifest.entries).some((p) => p.startsWith('Project (1)/'))).toBe(false);
  });

  it('excludes a nested missing-intermediate copy via multi-level candidates', async () => {
    // `bar (1) (1).md`'s immediate intermediate (`bar (1).md`) is absent, but
    // the root original (`bar.md`) survives — the gate must still recognise it.
    writeFile('bar.md', 'root original');
    writeFile('bar (1) (1).md', 'nested conflict copy, intermediate deleted');

    const manifest = await buildCloudManifest(workspaceDir);

    expect(manifest.entries).toHaveProperty('bar.md');
    expect(manifest.entries).not.toHaveProperty('bar (1) (1).md');
  });
});
