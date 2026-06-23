import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { resetSessionMutexForTests } from '@core/services/sessionMutex';

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-workspace-sync',
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => loggerMock,
}));

import { CloudWorkspaceSync, isSensitivePath } from '../cloudWorkspaceSync';
import type { CloudManifest, SyncClient } from '../cloudWorkspaceSync';

const MANIFEST_PATH = path.join('/tmp/test-cloud-workspace-sync', 'sessions', 'cloud-workspace-manifest.json');
const WORKSPACE_DIR = '/tmp/test-cloud-workspace-sync/workspace';

function makeClient(opts?: { postFails?: boolean }): SyncClient & { post: ReturnType<typeof vi.fn> } {
  return {
    post: vi.fn().mockImplementation((endpoint: string) => {
      if (opts?.postFails) return Promise.reject(new Error('network error'));
      // Return empty manifest for pull-phase calls
      if (endpoint === '/api/library/manifest') return Promise.resolve({ entries: {}, complete: true, reasons: [] });
      return Promise.resolve({ path: 'test', updatedAt: Date.now() });
    }),
  };
}

function makeCloudManifest(entries: CloudManifest['entries'] = {}, complete = true, reasons: readonly string[] = []): CloudManifest {
  return { entries, complete, reasons };
}

function createWorkspaceFile(relativePath: string, content: string): void {
  const fullPath = path.join(WORKSPACE_DIR, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function cleanupDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
}

function manifestPaths(manifest: ReadonlyMap<string, unknown>): string[] {
  return Array.from(manifest.keys()).sort();
}

describe('CloudWorkspaceSync', () => {
  let sync: CloudWorkspaceSync;

  beforeEach(() => {
    sync = new CloudWorkspaceSync();
    cleanupDir('/tmp/test-cloud-workspace-sync');
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    loggerMock.info.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
    loggerMock.debug.mockClear();
  });

  afterEach(() => {
    sync._resetForTesting();
    resetSessionMutexForTests();
    cleanupDir('/tmp/test-cloud-workspace-sync');
  });

  // ---------------------------------------------------------------------------
  // buildLocalManifest
  // ---------------------------------------------------------------------------

  describe('buildLocalManifest', () => {
    it('builds manifest for a simple workspace', async () => {
      createWorkspaceFile('hello.txt', 'Hello, world!');
      createWorkspaceFile('sub/nested.txt', 'Nested content');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.size).toBe(2);
      expect(manifest.has('hello.txt')).toBe(true);
      expect(manifest.has(path.join('sub', 'nested.txt'))).toBe(true);

      const entry = manifest.get('hello.txt')!;
      expect(entry.mtime).toBeGreaterThan(0);
      expect(entry.size).toBe(13); // 'Hello, world!' length
      expect(entry.hash).toHaveLength(16);
    });

    it('skips node_modules directory', async () => {
      createWorkspaceFile('src/app.ts', 'code');
      createWorkspaceFile('node_modules/pkg/index.js', 'module');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('src/app.ts')).toBe(true);
      expect(manifest.has('node_modules/pkg/index.js')).toBe(false);
    });

    it('skips .git directory', async () => {
      createWorkspaceFile('readme.md', 'readme');
      createWorkspaceFile('.git/HEAD', 'ref: refs/heads/main');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('readme.md')).toBe(true);
      expect(manifest.has('.git/HEAD')).toBe(false);
    });

    it('skips .DS_Store files', async () => {
      createWorkspaceFile('readme.md', 'readme');
      createWorkspaceFile('.DS_Store', 'binary');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('readme.md')).toBe(true);
      expect(manifest.has('.DS_Store')).toBe(false);
    });

    it('skips .rebel/tool-outputs directory (ephemeral materialized MCP outputs)', async () => {
      createWorkspaceFile('.rebel/tool-outputs/260403_1200_pkg_tool_abc123.json', '{"large": "data"}');
      createWorkspaceFile('.rebel/history/session.json', '{"keep": true}');
      createWorkspaceFile('notes.md', 'real content');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('notes.md')).toBe(true);
      expect(manifest.has('.rebel/history/session.json')).toBe(true);
      expect(manifest.has('.rebel/tool-outputs/260403_1200_pkg_tool_abc123.json')).toBe(false);
    });

    it('skips .rebel/conflicts-cleanup directory (REBEL-62A quarantine, excluded from sync)', async () => {
      createWorkspaceFile('.rebel/conflicts-cleanup/2026-06-01/notes (1).md', 'quarantined copy');
      createWorkspaceFile('notes.md', 'real content');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('notes.md')).toBe(true);
      expect(manifest.has('.rebel/conflicts-cleanup/2026-06-01/notes (1).md')).toBe(false);
    });

    it('skips .pending.md staging artifacts (managed by cloudStagingBridge)', async () => {
      createWorkspaceFile('Chief-of-Staff/memory/pending/260223_120000_notes.pending.md',
        '---\npending_destination: notes.md\n---\ncontent');
      createWorkspaceFile('notes.md', 'real content');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('notes.md')).toBe(true);
      expect(manifest.has('Chief-of-Staff/memory/pending/260223_120000_notes.pending.md')).toBe(false);
    });

    // REBEL-62A: Drive/Dropbox conflict-copy exclusion (sibling-gated).
    it('excludes a Google-Drive numbered copy when its original sibling exists (numbered-copy)', async () => {
      createWorkspaceFile('memory/topics/foo.md', 'original');
      createWorkspaceFile('memory/topics/foo (1).md', 'drive conflict copy');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('memory/topics/foo.md')).toBe(true);
      expect(manifest.has('memory/topics/foo (1).md')).toBe(false);
    });

    it('excludes a Dropbox conflicted copy when its original sibling exists (dropbox-conflict)', async () => {
      createWorkspaceFile('memory/Report.md', 'original');
      createWorkspaceFile("memory/Report (conflicted copy 2025-01-15 Josh's MacBook).md", 'dropbox conflict');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('memory/Report.md')).toBe(true);
      expect(manifest.has("memory/Report (conflicted copy 2025-01-15 Josh's MacBook).md")).toBe(false);
    });

    it('RETAINS a standalone numbered file when there is no original sibling (false-positive guard)', async () => {
      createWorkspaceFile('memory/Report (1).md', 'legitimate standalone, no Report.md');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('memory/Report (1).md')).toBe(true);
    });

    it('RETAINS the original even when a conflict copy is present alongside it', async () => {
      createWorkspaceFile('memory/topics/foo.md', 'original');
      createWorkspaceFile('memory/topics/foo (1).md', 'drive conflict copy');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('memory/topics/foo.md')).toBe(true);
    });

    it('does not cross directories: a conflict copy whose original lives elsewhere is RETAINED', async () => {
      // foo.md is in a sibling directory, not the same dir as the copy.
      createWorkspaceFile('memory/topics/foo.md', 'original elsewhere');
      createWorkspaceFile('memory/other/foo (1).md', 'numbered file, no local original');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('memory/topics/foo.md')).toBe(true);
      expect(manifest.has('memory/other/foo (1).md')).toBe(true);
    });

    it('skips files larger than 50MB', async () => {
      createWorkspaceFile('small.txt', 'small');
      // Create a file that appears large via stat — we mock the size check
      // by creating a real file > 50MB would be too slow, so we test the limit
      // indirectly via the push path. The walk skips based on fs.statSync.

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);
      expect(manifest.has('small.txt')).toBe(true);
    });

    it('respects .gitignore patterns', async () => {
      createWorkspaceFile('.gitignore', '*.log\nbuild/\n');
      createWorkspaceFile('app.ts', 'code');
      createWorkspaceFile('error.log', 'error');
      createWorkspaceFile('build/output.js', 'built');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('app.ts')).toBe(true);
      expect(manifest.has('.gitignore')).toBe(true);
      expect(manifest.has('error.log')).toBe(false);
      expect(manifest.has(path.join('build', 'output.js'))).toBe(false);
    });

    it('handles missing .gitignore gracefully', async () => {
      createWorkspaceFile('app.ts', 'code');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);
      expect(manifest.has('app.ts')).toBe(true);
    });

    it('reuses hash from last manifest when mtime unchanged', async () => {
      createWorkspaceFile('stable.txt', 'unchanged');

      // First build — hashes the file
      const { manifest: manifest1 } = await sync.buildLocalManifest(WORKSPACE_DIR);
      const entry1 = manifest1.get('stable.txt')!;

      // Simulate that the file was pushed (update last-pushed manifest)
      sync._getLastPushedManifest().set('stable.txt', { ...entry1 });

      // Second build — should reuse hash since mtime didn't change
      const { manifest: manifest2 } = await sync.buildLocalManifest(WORKSPACE_DIR);
      const entry2 = manifest2.get('stable.txt')!;

      expect(entry2.hash).toBe(entry1.hash);
      expect(entry2.mtime).toBe(entry1.mtime);
    });

    it('detects symlink cycles and skips them', async () => {
      createWorkspaceFile('real.txt', 'real');
      const linkPath = path.join(WORKSPACE_DIR, 'loop');
      try {
        fs.symlinkSync(WORKSPACE_DIR, linkPath);
      } catch {
        // Symlinks may not be supported (e.g., Windows without elevated privileges)
        return;
      }

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('real.txt')).toBe(true);
      // The symlink cycle should be detected and skipped (no infinite recursion)
    });

    it('follows directory symlinks pointing outside workspace', async () => {
      // Create a directory outside the workspace with a skill-like file
      const externalDir = '/tmp/test-cloud-workspace-sync/external-skills';
      fs.mkdirSync(path.join(externalDir, 'my-skill'), { recursive: true });
      fs.writeFileSync(path.join(externalDir, 'my-skill', 'SKILL.md'), '---\nname: my-skill\n---\n# My Skill');

      createWorkspaceFile('local.txt', 'local file');

      // Symlink from workspace to external directory
      const linkPath = path.join(WORKSPACE_DIR, 'skills-link');
      try {
        fs.symlinkSync(externalDir, linkPath);
      } catch {
        // Symlinks may not be supported (e.g., Windows without elevated privileges)
        return;
      }

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('local.txt')).toBe(true);
      // Directory symlink to external path should be followed
      expect(manifest.has('skills-link/my-skill/SKILL.md')).toBe(true);

      // Cleanup external dir
      fs.rmSync(externalDir, { recursive: true, force: true });
    });

    it('follows file symlinks pointing outside workspace', async () => {
      // Create a file outside the workspace
      const externalFile = '/tmp/test-cloud-workspace-sync/external-agents.md';
      fs.writeFileSync(externalFile, '# External AGENTS.md');

      // Symlink from workspace to external file
      const linkPath = path.join(WORKSPACE_DIR, 'AGENTS.md');
      try {
        fs.symlinkSync(externalFile, linkPath);
      } catch {
        return;
      }

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('AGENTS.md')).toBe(true);

      fs.unlinkSync(externalFile);
    });

    it('skips broken symlinks gracefully', async () => {
      createWorkspaceFile('real.txt', 'real content');

      // Create a symlink pointing to a non-existent target
      const linkPath = path.join(WORKSPACE_DIR, 'broken-link');
      try {
        fs.symlinkSync('/tmp/test-cloud-workspace-sync/does-not-exist', linkPath);
      } catch {
        return;
      }

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('real.txt')).toBe(true);
      expect(manifest.has('broken-link')).toBe(false);
    });

    it('respects ALWAYS_SKIP_DIRS inside symlinked directories', async () => {
      const externalDir = '/tmp/test-cloud-workspace-sync/external-project';
      fs.mkdirSync(path.join(externalDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(externalDir, 'src', 'app.ts'), 'code');
      fs.mkdirSync(path.join(externalDir, 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(externalDir, 'node_modules', 'pkg', 'index.js'), 'module');

      const linkPath = path.join(WORKSPACE_DIR, 'project-link');
      try {
        fs.symlinkSync(externalDir, linkPath);
      } catch {
        return;
      }

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('project-link/src/app.ts')).toBe(true);
      // node_modules inside symlinked dir should be skipped
      expect(manifest.has('project-link/node_modules/pkg/index.js')).toBe(false);

      fs.rmSync(externalDir, { recursive: true, force: true });
    });

    it('respects .gitignore patterns inside symlinked directories', async () => {
      const externalDir = '/tmp/test-cloud-workspace-sync/external-with-ignored';
      fs.mkdirSync(path.join(externalDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(externalDir, 'src', 'app.ts'), 'code');
      fs.mkdirSync(path.join(externalDir, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(externalDir, 'logs', 'debug.log'), 'log output');

      // Create workspace .gitignore that matches "logs/"
      createWorkspaceFile('.gitignore', 'logs/\n');

      const linkPath = path.join(WORKSPACE_DIR, 'ext-link');
      try {
        fs.symlinkSync(externalDir, linkPath);
      } catch {
        return;
      }

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('ext-link/src/app.ts')).toBe(true);
      // logs/ should be matched by .gitignore
      expect(manifest.has('ext-link/logs/debug.log')).toBe(false);

      fs.rmSync(externalDir, { recursive: true, force: true });
    });

    it('skips symlinks to sensitive directories (via isSensitivePath)', () => {
      const home = '/fake/home';
      // Directories that should be blocked
      expect(isSensitivePath('/fake/home/.ssh', home)).toBe(true);
      expect(isSensitivePath('/fake/home/.ssh/id_rsa', home)).toBe(true);
      expect(isSensitivePath('/fake/home/.aws', home)).toBe(true);
      expect(isSensitivePath('/fake/home/.aws/credentials', home)).toBe(true);
      expect(isSensitivePath('/fake/home/.gnupg/pubring.kbx', home)).toBe(true);
      expect(isSensitivePath('/fake/home/.kube/config', home)).toBe(true);
      expect(isSensitivePath('/fake/home/.docker/config.json', home)).toBe(true);
      expect(isSensitivePath('/fake/home/.config/gcloud/credentials.json', home)).toBe(true);

      // Paths that should NOT be blocked
      expect(isSensitivePath('/fake/home/Documents/workspace', home)).toBe(false);
      expect(isSensitivePath('/fake/home/Dropbox/skills', home)).toBe(false);
      expect(isSensitivePath('/other/path/.ssh', home)).toBe(false);
    });

    // REBEL-62A F2: extra non-Rebel conflict labels, sibling-gated exclusion.
    it('excludes a "Copy of foo.md" duplicate when its original sibling exists (copy-of)', async () => {
      createWorkspaceFile('memory/foo.md', 'original');
      createWorkspaceFile('memory/Copy of foo.md', 'generic copy');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('memory/foo.md')).toBe(true);
      expect(manifest.has('memory/Copy of foo.md')).toBe(false);
    });

    it('excludes a "foo copy.md" duplicate when its original sibling exists (copy-suffix)', async () => {
      createWorkspaceFile('memory/foo.md', 'original');
      createWorkspaceFile('memory/foo copy.md', 'generic copy suffix');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('memory/foo.md')).toBe(true);
      expect(manifest.has('memory/foo copy.md')).toBe(false);
    });

    it('excludes a "foo-conflict-<date>.md" copy when its original sibling exists (sync-conflict)', async () => {
      createWorkspaceFile('memory/foo.md', 'original');
      createWorkspaceFile('memory/foo-conflict-20250101.md', 'sync conflict marker');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('memory/foo.md')).toBe(true);
      expect(manifest.has('memory/foo-conflict-20250101.md')).toBe(false);
    });

    it('excludes a nested "foo (1) (1).md" copy when its immediate sibling "foo (1).md" exists (nested numbered-copy)', async () => {
      // The fan-out is contained at every nesting level: `foo (1) (1).md`
      // derives the IMMEDIATE sibling `foo (1).md` (not `foo.md`), so it is
      // excluded whenever that intermediate copy is present.
      createWorkspaceFile('memory/foo (1).md', 'intermediate copy (present)');
      createWorkspaceFile('memory/foo (1) (1).md', 'nested drive copy');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('memory/foo (1).md')).toBe(true);
      expect(manifest.has('memory/foo (1) (1).md')).toBe(false);
    });

    it('excludes a Google-Drive numbered folder copy when its original sibling directory exists', async () => {
      createWorkspaceFile('Project/notes.md', 'original');
      createWorkspaceFile('Project (1)/notes.md', 'drive folder conflict copy');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('Project/notes.md')).toBe(true);
      expect(manifest.has('Project (1)/notes.md')).toBe(false);
    });

    it('retains a standalone numbered folder when there is no original sibling directory', async () => {
      createWorkspaceFile('Report (1)/x.md', 'legitimate standalone folder');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('Report (1)/x.md')).toBe(true);
    });

    it('handles empty workspace', async () => {
      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);
      expect(manifest.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // pullChangedFiles — stale-cloud conflict-copy filter (REBEL-62A F1)
  //
  // Directly guards the PULL-side filter (cloudWorkspaceSync.ts:1228-1248),
  // independent of the push-side filter. Scenario: an un-updated peer (or an
  // older state) has already polluted the CLOUD manifest with both the original
  // `foo.md` AND its Drive conflict copy `foo (1).md`. The updated peer pulling
  // that manifest must refuse the conflict copy: no /api/library/read, no local
  // write, no lastPushedManifest record. This test FAILS if the pull-side filter
  // block is removed (the copy is absent locally, so without the filter it would
  // be classified `new` and pulled — this /tmp workspace resolves to
  // cloud_authoritative, so there is no Drive-settle deferral masking the pull).
  // ---------------------------------------------------------------------------

  describe('pullChangedFiles stale-cloud conflict-copy filter', () => {
    it('does not pull a Drive conflict copy from a polluted cloud manifest whose original sibling is present', async () => {
      const ORIGINAL_REL = 'memory/topics/foo.md';
      const CONFLICT_REL = 'memory/topics/foo (1).md';

      // Local workspace has the ORIGINAL but NOT the conflict copy.
      createWorkspaceFile(ORIGINAL_REL, 'original fact');
      expect(fs.existsSync(path.join(WORKSPACE_DIR, CONFLICT_REL))).toBe(false);

      // Polluted cloud manifest contains BOTH the original and the conflict copy.
      const cloudManifest = makeCloudManifest({
        [ORIGINAL_REL]: { hash: 'hash-original', size: 13 },
        [CONFLICT_REL]: { hash: 'hash-conflict-copy', size: 21 },
      });

      const calls: Array<{ endpoint: string; path?: string }> = [];
      const client: SyncClient & { post: ReturnType<typeof vi.fn> } = {
        post: vi.fn().mockImplementation((endpoint: string, body?: { path?: string }) => {
          calls.push({ endpoint, path: body?.path });
          if (endpoint === '/api/library/manifest') return Promise.resolve(cloudManifest);
          if (endpoint === '/api/library/read' && body?.path) {
            // Should never be reached for the conflict copy.
            return Promise.resolve({ content: 'conflict copy content from cloud' });
          }
          return Promise.resolve({});
        }),
      };

      const result = await sync.pullChangedFiles(client, WORKSPACE_DIR, cloudManifest);

      // (a) No content fetch for the conflict copy.
      expect(calls.some((c) => c.endpoint === '/api/library/read' && c.path === CONFLICT_REL)).toBe(false);

      // (b) The conflict copy is NOT written to the local workspace.
      expect(fs.existsSync(path.join(WORKSPACE_DIR, CONFLICT_REL))).toBe(false);

      // (c) The conflict copy is NOT recorded in lastPushedManifest.
      expect(sync._getLastPushedManifest().has(CONFLICT_REL)).toBe(false);

      // The original (already on disk, not in lastPushed) is skipped, not pulled.
      expect(result.pulled).toBe(0);
    });

    it('pulls a standalone Drive-numbered file when no original sibling is present', async () => {
      const CONFLICT_SHAPED_REL = 'memory/topics/foo (1).md';

      expect(fs.existsSync(path.join(WORKSPACE_DIR, 'memory/topics/foo.md'))).toBe(false);
      expect(fs.existsSync(path.join(WORKSPACE_DIR, CONFLICT_SHAPED_REL))).toBe(false);

      const cloudManifest = makeCloudManifest({
        [CONFLICT_SHAPED_REL]: { hash: 'hash-standalone-numbered-file', size: 25 },
      });

      const client: SyncClient & { post: ReturnType<typeof vi.fn> } = {
        post: vi.fn().mockImplementation((endpoint: string, body?: { path?: string }) => {
          if (endpoint === '/api/library/read' && body?.path === CONFLICT_SHAPED_REL) {
            return Promise.resolve({ content: 'standalone numbered file' });
          }
          return Promise.resolve({});
        }),
      };

      const result = await sync.pullChangedFiles(client, WORKSPACE_DIR, cloudManifest);

      expect(client.post).toHaveBeenCalledWith('/api/library/read', { path: CONFLICT_SHAPED_REL });
      expect(fs.readFileSync(path.join(WORKSPACE_DIR, CONFLICT_SHAPED_REL), 'utf8')).toBe('standalone numbered file');
      expect(sync._getLastPushedManifest().has(CONFLICT_SHAPED_REL)).toBe(true);
      expect(result.pulled).toBe(1);
    });

    it('does not pull a file under a Drive folder conflict copy when the original folder is present', async () => {
      const ORIGINAL_REL = 'Projects/Client/notes.md';
      const CONFLICT_REL = 'Projects/Client (1)/notes.md';

      createWorkspaceFile(ORIGINAL_REL, 'original notes');
      expect(fs.existsSync(path.join(WORKSPACE_DIR, CONFLICT_REL))).toBe(false);

      const cloudManifest = makeCloudManifest({
        [ORIGINAL_REL]: { hash: 'hash-original', size: 14 },
        [CONFLICT_REL]: { hash: 'hash-conflict-copy', size: 21 },
      });

      const calls: Array<{ endpoint: string; path?: string }> = [];
      const client: SyncClient & { post: ReturnType<typeof vi.fn> } = {
        post: vi.fn().mockImplementation((endpoint: string, body?: { path?: string }) => {
          calls.push({ endpoint, path: body?.path });
          if (endpoint === '/api/library/read' && body?.path === CONFLICT_REL) {
            return Promise.resolve({ content: 'folder conflict content from cloud' });
          }
          return Promise.resolve({});
        }),
      };

      const result = await sync.pullChangedFiles(client, WORKSPACE_DIR, cloudManifest);

      expect(calls.some((c) => c.endpoint === '/api/library/read' && c.path === CONFLICT_REL)).toBe(false);
      expect(fs.existsSync(path.join(WORKSPACE_DIR, CONFLICT_REL))).toBe(false);
      expect(sync._getLastPushedManifest().has(CONFLICT_REL)).toBe(false);
      expect(result.pulled).toBe(0);
    });

    it('pulls a file under a standalone numbered folder when no original folder sibling is present', async () => {
      const CONFLICT_SHAPED_REL = 'Projects/Client (1)/notes.md';

      expect(fs.existsSync(path.join(WORKSPACE_DIR, 'Projects/Client'))).toBe(false);
      expect(fs.existsSync(path.join(WORKSPACE_DIR, CONFLICT_SHAPED_REL))).toBe(false);

      const cloudManifest = makeCloudManifest({
        [CONFLICT_SHAPED_REL]: { hash: 'hash-standalone-numbered-folder', size: 25 },
      });

      const client: SyncClient & { post: ReturnType<typeof vi.fn> } = {
        post: vi.fn().mockImplementation((endpoint: string, body?: { path?: string }) => {
          if (endpoint === '/api/library/read' && body?.path === CONFLICT_SHAPED_REL) {
            return Promise.resolve({ content: 'standalone numbered folder file' });
          }
          return Promise.resolve({});
        }),
      };

      const result = await sync.pullChangedFiles(client, WORKSPACE_DIR, cloudManifest);

      expect(client.post).toHaveBeenCalledWith('/api/library/read', { path: CONFLICT_SHAPED_REL });
      expect(fs.readFileSync(path.join(WORKSPACE_DIR, CONFLICT_SHAPED_REL), 'utf8')).toBe(
        'standalone numbered folder file',
      );
      expect(sync._getLastPushedManifest().has(CONFLICT_SHAPED_REL)).toBe(true);
      expect(result.pulled).toBe(1);
    });
  });

  describe('buildLocalManifest migration parity', () => {
    it('preserves gitignore, local-artifact skips, and empty-file inclusion', async () => {
      createWorkspaceFile('.gitignore', '*.log\nbuild/\n');
      createWorkspaceFile('app.ts', 'code');
      createWorkspaceFile('error.log', 'error');
      createWorkspaceFile('build/output.js', 'built');
      createWorkspaceFile('draft.pending.md', 'pending');
      createWorkspaceFile('notes.conflict-cloud.md', 'conflict');
      createWorkspaceFile('.DS_Store', 'metadata');
      createWorkspaceFile('empty.txt', '');

      const result = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(result.complete).toBe(true);
      expect(result.reasons).toEqual([]);
      expect(manifestPaths(result.manifest)).toEqual(['.gitignore', 'app.ts', 'empty.txt']);
      expect(result.manifest.get('empty.txt')?.size).toBe(0);
    });

    it('follows external directory symlinks and skips symlinks into sensitive paths', async () => {
      createWorkspaceFile('local.txt', 'local');

      const externalDir = '/tmp/test-cloud-workspace-sync/external-project';
      fs.mkdirSync(path.join(externalDir, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(externalDir, 'docs', 'note.md'), 'external note', 'utf8');

      const fakeHome = '/tmp/test-cloud-workspace-sync/fake-home';
      const sensitiveDir = path.join(fakeHome, '.ssh');
      fs.mkdirSync(sensitiveDir, { recursive: true });
      fs.writeFileSync(path.join(sensitiveDir, 'secret.txt'), 'secret', 'utf8');
      fs.writeFileSync(path.join(sensitiveDir, 'id_rsa'), 'private key', 'utf8');

      const originalHome = process.env.HOME;
      process.env.HOME = fs.realpathSync(fakeHome);
      try {
        try {
          fs.symlinkSync(externalDir, path.join(WORKSPACE_DIR, 'external-link'));
          fs.symlinkSync(sensitiveDir, path.join(WORKSPACE_DIR, 'ssh-link'));
          fs.symlinkSync(path.join(sensitiveDir, 'id_rsa'), path.join(WORKSPACE_DIR, 'id-rsa-link'));
        } catch {
          return;
        }

        const result = await sync.buildLocalManifest(WORKSPACE_DIR);

        expect(result.complete).toBe(true);
        expect(result.reasons).toEqual([]);
        expect(manifestPaths(result.manifest)).toEqual([
          'external-link/docs/note.md',
          'local.txt',
        ]);
      } finally {
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
      }
    });

    it('skips broken symlinks without marking the manifest incomplete', async () => {
      createWorkspaceFile('real.txt', 'real content');
      try {
        fs.symlinkSync('/tmp/test-cloud-workspace-sync/missing-target', path.join(WORKSPACE_DIR, 'broken-link'));
      } catch {
        return;
      }

      const result = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(result.complete).toBe(true);
      expect(result.reasons).toEqual([]);
      expect(manifestPaths(result.manifest)).toEqual(['real.txt']);
    });

    it('reuses a cached hash when mtime and size are unchanged', async () => {
      createWorkspaceFile('stable.txt', 'stable content');
      const stat = fs.statSync(path.join(WORKSPACE_DIR, 'stable.txt'));
      sync._getLastPushedManifest().set('stable.txt', {
        mtime: Math.floor(stat.mtimeMs),
        size: stat.size,
        hash: 'cached-hash',
      });

      const result = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(result.complete).toBe(true);
      expect(result.manifest.get('stable.txt')?.hash).toBe('cached-hash');
    });

    it('skips files larger than 50MB', async () => {
      createWorkspaceFile('small.txt', 'small');
      const largeFilePath = path.join(WORKSPACE_DIR, 'large.bin');
      fs.writeFileSync(largeFilePath, '', 'utf8');
      const fd = fs.openSync(largeFilePath, 'w');
      try {
        fs.ftruncateSync(fd, 50 * 1024 * 1024 + 1);
      } finally {
        fs.closeSync(fd);
      }

      const result = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(result.complete).toBe(true);
      expect(manifestPaths(result.manifest)).toEqual(['small.txt']);
    });

    it.skipIf(process.platform === 'win32')('reports permission-denied subdirectories as incomplete', async () => {
      createWorkspaceFile('readable/ok.md', 'ok');
      createWorkspaceFile('unreadable/hidden.md', 'hidden');
      const unreadableDir = path.join(WORKSPACE_DIR, 'unreadable');

      let chmodSucceeded = false;
      try {
        fs.chmodSync(unreadableDir, 0o000);
        try {
          fs.readdirSync(unreadableDir);
        } catch {
          chmodSucceeded = true;
        }
      } catch {
        // Not all environments support chmod-based unreadable fixtures.
      }

      try {
        if (!chmodSucceeded) return;

        const result = await sync.buildLocalManifest(WORKSPACE_DIR);

        expect(result.complete).toBe(false);
        expect(result.reasons).toContain('permission');
        expect(manifestPaths(result.manifest)).toEqual(['readable/ok.md']);
      } finally {
        try {
          fs.chmodSync(unreadableDir, 0o755);
        } catch {
          // ignore
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // getChangedFiles
  // ---------------------------------------------------------------------------

  describe('getChangedFiles', () => {
    it('returns all files when no previous manifest exists', async () => {
      createWorkspaceFile('a.txt', 'aaa');
      createWorkspaceFile('b.txt', 'bbb');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);
      const changed = sync.getChangedFiles(manifest);

      expect(changed).toHaveLength(2);
      expect(changed.sort()).toEqual(['a.txt', 'b.txt']);
    });

    it('returns only files with changed hashes', async () => {
      createWorkspaceFile('unchanged.txt', 'same');
      createWorkspaceFile('changed.txt', 'old');

      const { manifest: manifest1 } = await sync.buildLocalManifest(WORKSPACE_DIR);

      // Simulate pushing all files (copy manifest1 into last-pushed)
      for (const [k, v] of manifest1) {
        sync._getLastPushedManifest().set(k, { ...v });
      }

      // Modify one file and bump its mtime so the mtime-first comparison detects the change
      createWorkspaceFile('changed.txt', 'new');
      const futureTime = new Date(Date.now() + 2000);
      fs.utimesSync(path.join(WORKSPACE_DIR, 'changed.txt'), futureTime, futureTime);

      const { manifest: manifest2 } = await sync.buildLocalManifest(WORKSPACE_DIR);
      const changed = sync.getChangedFiles(manifest2);

      expect(changed).toEqual(['changed.txt']);
    });

    it('detects new files', async () => {
      createWorkspaceFile('existing.txt', 'exists');

      const { manifest: manifest1 } = await sync.buildLocalManifest(WORKSPACE_DIR);
      for (const [k, v] of manifest1) {
        sync._getLastPushedManifest().set(k, { ...v });
      }

      // Add a new file
      createWorkspaceFile('new-file.txt', 'brand new');

      const { manifest: manifest2 } = await sync.buildLocalManifest(WORKSPACE_DIR);
      const changed = sync.getChangedFiles(manifest2);

      expect(changed).toEqual(['new-file.txt']);
    });

    it('returns empty when nothing changed', async () => {
      createWorkspaceFile('stable.txt', 'stable');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);
      for (const [k, v] of manifest) {
        sync._getLastPushedManifest().set(k, { ...v });
      }

      const changed = sync.getChangedFiles(manifest);
      expect(changed).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getDeletedFiles
  // ---------------------------------------------------------------------------

  describe('getDeletedFiles', () => {
    it('returns files in lastPushedManifest but not in local', async () => {
      createWorkspaceFile('keep.txt', 'keep');
      createWorkspaceFile('delete-me.txt', 'gone');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      // Simulate both files were previously pushed
      for (const [k, v] of manifest) {
        sync._getLastPushedManifest().set(k, { ...v });
      }

      // Remove 'delete-me.txt' from local manifest to simulate deletion
      const localWithDeletion: Map<string, { mtime: number; size: number; hash: string }> = new Map(manifest);
      localWithDeletion.delete('delete-me.txt');

      const deleted = sync.getDeletedFiles(localWithDeletion);
      expect(deleted).toEqual(['delete-me.txt']);
    });

    it('returns empty when all files still exist', async () => {
      createWorkspaceFile('a.txt', 'aaa');
      createWorkspaceFile('b.txt', 'bbb');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      for (const [k, v] of manifest) {
        sync._getLastPushedManifest().set(k, { ...v });
      }

      const deleted = sync.getDeletedFiles(manifest);
      expect(deleted).toHaveLength(0);
    });

    it('returns empty when lastPushedManifest is empty', async () => {
      createWorkspaceFile('a.txt', 'aaa');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      const deleted = sync.getDeletedFiles(manifest);
      expect(deleted).toHaveLength(0);
    });

    it('returns all files when local manifest is empty', async () => {
      // Simulate previously pushed files
      sync._getLastPushedManifest().set('old-a.txt', { mtime: 1000, size: 3, hash: 'abc1234567890123' });
      sync._getLastPushedManifest().set('old-b.txt', { mtime: 1000, size: 3, hash: 'def4567890123456' });

      const emptyLocal: Map<string, { mtime: number; size: number; hash: string }> = new Map();

      const deleted = sync.getDeletedFiles(emptyLocal);
      expect(deleted.sort()).toEqual(['old-a.txt', 'old-b.txt']);
    });
  });

  // ---------------------------------------------------------------------------
  // getCloudMissingFiles
  // ---------------------------------------------------------------------------

  describe('getCloudMissingFiles', () => {
    it('returns files in lastPushedManifest and local but missing from cloud', async () => {
      createWorkspaceFile('synced.txt', 'synced');
      createWorkspaceFile('lost.txt', 'lost on cloud');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      // Simulate both files were previously pushed
      for (const [k, v] of manifest) {
        sync._getLastPushedManifest().set(k, { ...v });
      }

      // Cloud only has 'synced.txt' — 'lost.txt' went missing
      const cloudEntries: Record<string, { hash: string; size: number }> = {};
      const syncedEntry = manifest.get('synced.txt')!;
      cloudEntries['synced.txt'] = { hash: syncedEntry.hash, size: syncedEntry.size };

      const missing = sync.getCloudMissingFiles(manifest, makeCloudManifest(cloudEntries));
      expect(missing).toEqual(['lost.txt']);
    });

    it('returns empty when cloud has all pushed files', async () => {
      createWorkspaceFile('a.txt', 'aaa');
      createWorkspaceFile('b.txt', 'bbb');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      for (const [k, v] of manifest) {
        sync._getLastPushedManifest().set(k, { ...v });
      }

      // Cloud has both files
      const cloudEntries: Record<string, { hash: string; size: number }> = {};
      for (const [k, v] of manifest) {
        cloudEntries[k] = { hash: v.hash, size: v.size };
      }

      const missing = sync.getCloudMissingFiles(manifest, makeCloudManifest(cloudEntries));
      expect(missing).toHaveLength(0);
    });

    it('excludes files deleted locally (not in local manifest)', async () => {
      createWorkspaceFile('keep.txt', 'keep');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      // Simulate two files were previously pushed, but one is no longer local
      for (const [k, v] of manifest) {
        sync._getLastPushedManifest().set(k, { ...v });
      }
      sync._getLastPushedManifest().set('deleted-locally.txt', { mtime: 1000, size: 5, hash: 'abc1234567890123' });

      // Cloud is missing both, but only 'keep.txt' should be returned
      const cloudEntries: Record<string, { hash: string; size: number }> = {};

      const missing = sync.getCloudMissingFiles(manifest, makeCloudManifest(cloudEntries));
      expect(missing).toEqual(['keep.txt']);
    });

    it('returns empty when lastPushedManifest is empty', async () => {
      createWorkspaceFile('a.txt', 'aaa');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);
      const cloudEntries: Record<string, { hash: string; size: number }> = {};

      const missing = sync.getCloudMissingFiles(manifest, makeCloudManifest(cloudEntries));
      expect(missing).toHaveLength(0);
    });

    it('excludes zero-byte files (cloud manifest intentionally omits them)', async () => {
      createWorkspaceFile('real.txt', 'content');
      createWorkspaceFile('empty.txt', '');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      for (const [k, v] of manifest) {
        sync._getLastPushedManifest().set(k, { ...v });
      }

      // Cloud has neither — but empty.txt should NOT be reported as missing
      const cloudEntries: Record<string, { hash: string; size: number }> = {};

      const missing = sync.getCloudMissingFiles(manifest, makeCloudManifest(cloudEntries));
      expect(missing).toEqual(['real.txt']);
    });
  });

  // ---------------------------------------------------------------------------
  // deleteFiles
  // ---------------------------------------------------------------------------

  describe('deleteFiles', () => {
    it('calls POST /api/library/delete-file for each truly deleted file', async () => {
      // Files must NOT exist on disk for deletion to proceed
      const client = makeClient();
      const deletedFiles = ['removed-a.txt', 'removed-b.txt'];

      const result = await sync.deleteFiles(client, deletedFiles, WORKSPACE_DIR);

      expect(result).toEqual({ deleted: 2, pruned: 0 });
      expect(client.post).toHaveBeenCalledTimes(2);
      expect(client.post).toHaveBeenCalledWith('/api/library/delete-file', { path: 'removed-a.txt' });
      expect(client.post).toHaveBeenCalledWith('/api/library/delete-file', { path: 'removed-b.txt' });
    });

    it('prunes files that still exist locally (filtered from manifest) and removes from lastPushedManifest', async () => {
      // Create a file that exists on disk but is not in the local manifest
      // (e.g., grew past size limit)
      createWorkspaceFile('still-exists.txt', 'I am still here');
      sync._getLastPushedManifest().set('still-exists.txt', { mtime: 1000, size: 15, hash: 'abc1234567890123' });

      const client = makeClient();
      const result = await sync.deleteFiles(client, ['still-exists.txt'], WORKSPACE_DIR);

      expect(result).toEqual({ deleted: 0, pruned: 1 });
      expect(client.post).not.toHaveBeenCalled();
      // Pruned entry should be removed from lastPushedManifest
      expect(sync._getLastPushedManifest().has('still-exists.txt')).toBe(false);
    });

    it('removes from lastPushedManifest on success', async () => {
      sync._getLastPushedManifest().set('to-delete.txt', { mtime: 1000, size: 3, hash: 'abc1234567890123' });
      sync._getLastPushedManifest().set('to-keep.txt', { mtime: 1000, size: 3, hash: 'def4567890123456' });

      const client = makeClient();
      await sync.deleteFiles(client, ['to-delete.txt'], WORKSPACE_DIR);

      expect(sync._getLastPushedManifest().has('to-delete.txt')).toBe(false);
      expect(sync._getLastPushedManifest().has('to-keep.txt')).toBe(true);
    });

    it('continues on individual failures', async () => {
      sync._getLastPushedManifest().set('fail.txt', { mtime: 1000, size: 3, hash: 'abc1234567890123' });
      sync._getLastPushedManifest().set('succeed.txt', { mtime: 1000, size: 3, hash: 'def4567890123456' });

      const client = makeClient();
      let callCount = 0;
      client.post.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('network error'));
        return Promise.resolve({ success: true });
      });

      const result = await sync.deleteFiles(client, ['fail.txt', 'succeed.txt'], WORKSPACE_DIR);

      expect(result.deleted).toBe(1);
      // Failed file stays in manifest
      expect(sync._getLastPushedManifest().has('fail.txt')).toBe(true);
      // Successful file removed from manifest
      expect(sync._getLastPushedManifest().has('succeed.txt')).toBe(false);
    });

    it('returns zeros for empty array', async () => {
      const client = makeClient();
      const result = await sync.deleteFiles(client, [], WORKSPACE_DIR);

      expect(result).toEqual({ deleted: 0, pruned: 0 });
      expect(client.post).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // pushChangedFiles
  // ---------------------------------------------------------------------------

  describe('pushChangedFiles', () => {
    it('pushes files to cloud via upload-file endpoint', async () => {
      createWorkspaceFile('push-me.txt', 'content to push');
      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);
      const changed = sync.getChangedFiles(manifest);

      const client = makeClient();
      const result = await sync.pushChangedFiles(client, changed, WORKSPACE_DIR, manifest);

      expect(result.pushed).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);
      expect(client.post).toHaveBeenCalledWith('/api/library/upload-file', {
        path: 'push-me.txt',
        content: expect.any(String),
        encoding: 'base64',
      });
    });

    it('updates last-pushed manifest on success', async () => {
      createWorkspaceFile('tracked.txt', 'track me');
      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);
      const changed = sync.getChangedFiles(manifest);

      const client = makeClient();
      await sync.pushChangedFiles(client, changed, WORKSPACE_DIR, manifest);

      const lastPushed = sync._getLastPushedManifest();
      expect(lastPushed.has('tracked.txt')).toBe(true);
    });

    it('reports failures without stopping other files', async () => {
      createWorkspaceFile('file-a.txt', 'aaa');
      createWorkspaceFile('file-b.txt', 'bbb');
      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);
      const changed = sync.getChangedFiles(manifest);

      // First call fails, second succeeds
      const client = makeClient();
      let callCount = 0;
      client.post.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('network error'));
        return Promise.resolve({ path: 'test', updatedAt: Date.now() });
      });

      const result = await sync.pushChangedFiles(client, changed, WORKSPACE_DIR, manifest);

      expect(result.pushed).toBe(1);
      expect(result.failed).toBe(1);
    });

    it('pushes files concurrently (up to PUSH_CONCURRENCY)', async () => {
      // Create more files than the concurrency limit
      for (let i = 0; i < 8; i++) {
        createWorkspaceFile(`file-${i}.txt`, `content-${i}`);
      }
      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);
      const changed = sync.getChangedFiles(manifest);
      expect(changed.length).toBe(8);

      // Track concurrent in-flight calls
      let maxConcurrent = 0;
      let currentConcurrent = 0;
      const resolvers: Array<() => void> = [];

      const client = makeClient();
      client.post.mockImplementation((endpoint: string) => {
        if (endpoint === '/api/library/manifest') return Promise.resolve({ entries: {}, complete: true, reasons: [] });
        currentConcurrent++;
        if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
        return new Promise<void>((resolve) => {
          resolvers.push(() => {
            currentConcurrent--;
            resolve();
          });
        });
      });

      const resultPromise = sync.pushChangedFiles(client, changed, WORKSPACE_DIR, manifest);

      // Wait for the first batch of concurrent calls to be initiated
      await new Promise((r) => setTimeout(r, 50));
      expect(maxConcurrent).toBe(5); // PUSH_CONCURRENCY = 5

      // Resolve all pending calls
      while (resolvers.length > 0) {
        resolvers.shift()!();
        await new Promise((r) => setTimeout(r, 5));
      }

      const result = await resultPromise;
      expect(result.pushed).toBe(8);
      expect(result.failed).toBe(0);
    });

    it('batch-updates manifest only after all concurrent pushes complete', async () => {
      createWorkspaceFile('a.txt', 'aaa');
      createWorkspaceFile('b.txt', 'bbb');
      createWorkspaceFile('c.txt', 'ccc');
      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);
      const changed = sync.getChangedFiles(manifest);

      // Track when manifest is checked during push
      const manifestSnapshots: number[] = [];
      const client = makeClient();
      client.post.mockImplementation((endpoint: string) => {
        if (endpoint === '/api/library/manifest') return Promise.resolve({ entries: {}, complete: true, reasons: [] });
        // Record manifest state during each push call
        manifestSnapshots.push(sync._getLastPushedManifest().size);
        return Promise.resolve({ path: 'test', updatedAt: Date.now() });
      });

      await sync.pushChangedFiles(client, changed, WORKSPACE_DIR, manifest);

      // During all push calls, manifest should still be at 0 (batch update happens after)
      expect(manifestSnapshots.every((s) => s === 0)).toBe(true);
      // After completion, all 3 files should be in manifest
      expect(sync._getLastPushedManifest().size).toBe(3);
    });

    it('handles partial failures in concurrent push (successful files update manifest)', async () => {
      createWorkspaceFile('ok-1.txt', 'ok1');
      createWorkspaceFile('fail-1.txt', 'fail1');
      createWorkspaceFile('ok-2.txt', 'ok2');
      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);
      const changed = sync.getChangedFiles(manifest);

      const client = makeClient();
      client.post.mockImplementation((_endpoint: string, body: unknown) => {
        const b = body as { path?: string };
        if (b?.path?.startsWith('fail-')) return Promise.reject(new Error('network error'));
        return Promise.resolve({ path: 'test', updatedAt: Date.now() });
      });

      const result = await sync.pushChangedFiles(client, changed, WORKSPACE_DIR, manifest);

      expect(result.pushed).toBe(2);
      expect(result.failed).toBe(1);
      // Successful files are in manifest, failed file is not
      expect(sync._getLastPushedManifest().has('ok-1.txt')).toBe(true);
      expect(sync._getLastPushedManifest().has('ok-2.txt')).toBe(true);
      expect(sync._getLastPushedManifest().has('fail-1.txt')).toBe(false);
    });

    it('skips files exceeding 7MB upload limit', async () => {
      createWorkspaceFile('small.txt', 'small');
      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      // Artificially inflate the manifest entry size to exceed 7MB
      const entry = manifest.get('small.txt')!;
      manifest.set('small.txt', { ...entry, size: 8 * 1024 * 1024 });

      const changed = sync.getChangedFiles(manifest);
      const client = makeClient();
      const result = await sync.pushChangedFiles(client, changed, WORKSPACE_DIR, manifest);

      expect(result.skipped).toBe(1);
      expect(result.pushed).toBe(0);
      expect(client.post).not.toHaveBeenCalled();
    });

    it('pushes only the reduced effective push set and runs TOCTOU on that set', async () => {
      createWorkspaceFile('small.txt', 'small');
      const smallEntry = { mtime: 1, size: 5, hash: 'small-hash' };
      const bigEntry = { mtime: 1, size: 8 * 1024 * 1024, hash: 'big-hash' };

      const buildLocalManifest = vi.spyOn(sync, 'buildLocalManifest')
        .mockResolvedValueOnce({
          manifest: new Map([
            ['big.bin', bigEntry],
            ['small.txt', smallEntry],
          ]),
          complete: true,
          reasons: [],
        })
        .mockResolvedValueOnce({
          manifest: new Map([
            ['big.bin', { ...bigEntry, mtime: 2, hash: 'big-hash-changed' }],
            ['small.txt', smallEntry],
          ]),
          complete: true,
          reasons: [],
        });

      const client = makeClient();
      const result = await sync.forceSync(client, WORKSPACE_DIR);

      const uploadCalls = client.post.mock.calls.filter(([endpoint]) => endpoint === '/api/library/upload-file');
      expect(result.pushed).toBe(1);
      expect(uploadCalls).toHaveLength(1);
      expect((uploadCalls[0][1] as { path: string }).path).toBe('small.txt');
      expect(buildLocalManifest).toHaveBeenCalledTimes(2);
      expect(loggerMock.debug).toHaveBeenCalledWith(
        expect.objectContaining({ total: 2, suppressed: 1, effective: 1 }),
        'Workspace push oversized memo summary',
      );
    });

    it('pushes immediately when an oversized memoized file shrinks below the upload limit', async () => {
      createWorkspaceFile('draft.bin', 'small now');
      const oversizedEntry = { mtime: 1, size: 8 * 1024 * 1024, hash: 'oversized-hash' };
      const smallEntry = { mtime: 2, size: 9, hash: 'small-hash' };

      vi.spyOn(sync, 'buildLocalManifest')
        .mockResolvedValueOnce({
          manifest: new Map([['draft.bin', oversizedEntry]]),
          complete: true,
          reasons: [],
        })
        .mockResolvedValueOnce({
          manifest: new Map([['draft.bin', smallEntry]]),
          complete: true,
          reasons: [],
        })
        .mockResolvedValueOnce({
          manifest: new Map([['draft.bin', smallEntry]]),
          complete: true,
          reasons: [],
        });

      const firstClient = makeClient();
      await sync.forceSync(firstClient, WORKSPACE_DIR);
      expect(firstClient.post.mock.calls.some(([endpoint]) => endpoint === '/api/library/upload-file')).toBe(false);

      const secondClient = makeClient();
      const result = await sync.forceSync(secondClient, WORKSPACE_DIR);

      const uploadCalls = secondClient.post.mock.calls.filter(([endpoint]) => endpoint === '/api/library/upload-file');
      const oversizedWarns = loggerMock.warn.mock.calls.filter(([, message]) => message === 'Skipping file exceeding upload size limit');
      expect(result.pushed).toBe(1);
      expect(uploadCalls).toHaveLength(1);
      expect((uploadCalls[0][1] as { path: string }).path).toBe('draft.bin');
      expect(oversizedWarns).toHaveLength(1);
    });

    it('does not run a second workspace walk when all push candidates are memo-suppressed oversized files', async () => {
      const oversizedEntry = { mtime: 1, size: 8 * 1024 * 1024, hash: 'oversized-hash' };
      const buildLocalManifest = vi.spyOn(sync, 'buildLocalManifest').mockResolvedValue({
        manifest: new Map([['big.bin', oversizedEntry]]),
        complete: true,
        reasons: [],
      });

      const firstClient = makeClient();
      await sync.forceSync(firstClient, WORKSPACE_DIR);
      const secondClient = makeClient();
      await sync.forceSync(secondClient, WORKSPACE_DIR);

      const uploadCalls = [
        ...firstClient.post.mock.calls,
        ...secondClient.post.mock.calls,
      ].filter(([endpoint]) => endpoint === '/api/library/upload-file');
      const oversizedWarns = loggerMock.warn.mock.calls.filter(([, message]) => message === 'Skipping file exceeding upload size limit');
      const debugSummaries = loggerMock.debug.mock.calls.filter(([, message]) => message === 'Workspace push oversized memo summary');

      expect(buildLocalManifest).toHaveBeenCalledTimes(2);
      expect(uploadCalls).toHaveLength(0);
      expect(oversizedWarns).toHaveLength(1);
      expect(debugSummaries).toHaveLength(2);
      expect(debugSummaries[0][0]).toEqual(expect.objectContaining({ total: 1, suppressed: 1, effective: 0 }));
      expect(debugSummaries[1][0]).toEqual(expect.objectContaining({ total: 1, suppressed: 1, effective: 0 }));
    });

    it('aborts the rest of the batch when the cloud host is unreachable', async () => {
      // Reproduces the in-the-wild 232s mutex hang: when the cloud host is
      // down, every per-file upload was running to its 30s timeout and the
      // workspace mutex was held the entire time. Now: the first
      // CLOUD_UNREACHABLE flips an abort flag and remaining files skip.
      for (let i = 1; i <= 12; i++) {
        createWorkspaceFile(`file-${i}.txt`, `content-${i}`);
      }
      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);
      const changed = sync.getChangedFiles(manifest);

      const client = makeClient();
      // Mimic the real CloudServiceError shape (duck-typed by isCloudServiceError).
      const unreachable = Object.assign(new Error('Cloud unreachable (rebel-cloud-test.fly.dev)'), {
        name: 'CloudServiceError',
        code: 'CLOUD_UNREACHABLE',
      });
      client.post.mockImplementation(() => Promise.reject(unreachable));

      const result = await sync.pushChangedFiles(client, changed, WORKSPACE_DIR, manifest);

      expect(result.pushed).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.aborted).toBeGreaterThan(0);
      // PUSH_CONCURRENCY upload attempts (5 by default) may be in flight when
      // the abort flag flips; the rest should never call post.
      expect(client.post.mock.calls.length).toBeLessThan(changed.length);
      // Nothing made it into the persisted manifest.
      expect(sync._getLastPushedManifest().size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // completeness gating
  // ---------------------------------------------------------------------------

  describe('completeness gating', () => {
    it('complete === false → zero deletes and no lastPushedManifest prunes', async () => {
      sync._getLastPushedManifest().set('missing-a.txt', { mtime: 1, size: 1, hash: 'missing-a-hash' });
      sync._getLastPushedManifest().set('missing-b.txt', { mtime: 1, size: 1, hash: 'missing-b-hash' });

      vi.spyOn(sync, 'buildLocalManifest').mockResolvedValue({
        manifest: new Map(),
        complete: false,
        reasons: ['permission'],
      });

      const client = makeClient();
      await sync.forceSync(client, WORKSPACE_DIR);

      expect(client.post.mock.calls.some(([endpoint]) => endpoint === '/api/library/delete-file')).toBe(false);
      expect(sync._getLastPushedManifest().has('missing-a.txt')).toBe(true);
      expect(sync._getLastPushedManifest().has('missing-b.txt')).toBe(true);
    });

    it('does not merge cloud-missing files into filesToPush when local manifest is incomplete', async () => {
      const skillEntry = { mtime: 1, size: 10, hash: 'skill-hash' };
      const otherEntry = { mtime: 1, size: 10, hash: 'other-hash' };
      sync._getLastPushedManifest().set('skill.md', skillEntry);
      sync._getLastPushedManifest().set('other.md', otherEntry);

      vi.spyOn(sync, 'buildLocalManifest').mockResolvedValue({
        manifest: new Map([
          ['skill.md', skillEntry],
          ['other.md', otherEntry],
        ]),
        complete: false,
        reasons: ['permission'],
      });

      const client = makeClient();
      client.post.mockImplementation((endpoint: string) => {
        if (endpoint === '/api/library/manifest') {
          return Promise.resolve(makeCloudManifest({ 'other.md': { hash: otherEntry.hash, size: otherEntry.size } }));
        }
        return Promise.resolve({ path: 'test', updatedAt: Date.now() });
      });

      await sync.forceSync(client, WORKSPACE_DIR);

      const skillUploads = client.post.mock.calls.filter(([endpoint, body]) => (
        endpoint === '/api/library/upload-file'
        && (body as { path?: string } | undefined)?.path === 'skill.md'
      ));
      expect(skillUploads).toHaveLength(0);
    });

    it('does not merge cloud-missing files into filesToPush when cloud manifest is incomplete', async () => {
      const lostEntry = { mtime: 1, size: 10, hash: 'lost-hash' };
      sync._getLastPushedManifest().set('lost.md', lostEntry);

      vi.spyOn(sync, 'buildLocalManifest').mockResolvedValue({
        manifest: new Map([['lost.md', lostEntry]]),
        complete: true,
        reasons: [],
      });

      const client = makeClient();
      client.post.mockImplementation((endpoint: string) => {
        if (endpoint === '/api/library/manifest') {
          return Promise.resolve(makeCloudManifest({}, false, ['permission']));
        }
        return Promise.resolve({ path: 'test', updatedAt: Date.now() });
      });

      await sync.forceSync(client, WORKSPACE_DIR);

      const lostUploads = client.post.mock.calls.filter(([endpoint, body]) => (
        endpoint === '/api/library/upload-file'
        && (body as { path?: string } | undefined)?.path === 'lost.md'
      ));
      expect(lostUploads).toHaveLength(0);
    });

    it('parses legacy cloud manifest responses as incomplete (fail-closed) for one-release compatibility', async () => {
      const legacyEntries = { 'legacy.md': { hash: 'legacy-hash', size: 10 } };
      const client = {
        post: vi.fn().mockResolvedValue(legacyEntries),
      };

      const manifest = await sync.fetchCloudManifest(client);

      expect(manifest).toEqual({
        entries: legacyEntries,
        complete: false,
        reasons: ['legacy-shape'],
      });
    });

    it('does not misparse legacy responses for workspaces containing a top-level file named "entries"', async () => {
      // Legacy shape Record<string, {hash,size}> with a file literally named 'entries'.
      // Without the discriminator-on-`complete` check this would satisfy the new-envelope
      // shape test and corrupt sync state. See Phase 7 review.
      const legacyEntriesCollision = {
        entries: { hash: 'collision-hash', size: 42 },
        'other.md': { hash: 'other-hash', size: 10 },
      };
      const client = {
        post: vi.fn().mockResolvedValue(legacyEntriesCollision),
      };

      const manifest = await sync.fetchCloudManifest(client);

      expect(manifest).toEqual({
        entries: legacyEntriesCollision,
        complete: false,
        reasons: ['legacy-shape'],
      });
    });

    it('treats stripped-field responses (envelope without complete) as legacy and fails closed', async () => {
      // CDN / proxy / middleware that strips unknown fields could drop `complete`/`reasons`.
      // Without discriminator-on-`complete`, an env.complete ?? true default would re-open
      // the bug class. Phase 7 review.
      const strippedEnvelope = {
        entries: { 'a.md': { hash: 'h', size: 1 } },
        // no `complete` field
      };
      const client = {
        post: vi.fn().mockResolvedValue(strippedEnvelope),
      };

      const manifest = await sync.fetchCloudManifest(client);

      expect(manifest?.complete).toBe(false);
      expect(manifest?.reasons).toEqual(['legacy-shape']);
    });

    it('returns null for non-object responses (null/undefined/string/number/boolean)', async () => {
      // First guard in fetchCloudManifest rejects falsy and non-object responses outright.
      // Lock that contract: a malformed transport should never produce a usable manifest.
      // See docs/plans/260503_post_wave1_invariant_locking_bundle.md § Stage 2.
      const adversarialResponses: unknown[] = [null, undefined, 'oops', 42, true];
      for (const response of adversarialResponses) {
        const client = { post: vi.fn().mockResolvedValue(response) };
        expect(await sync.fetchCloudManifest(client)).toBeNull();
      }
    });

    it('treats wrong-type discriminator (complete as a non-boolean) as legacy/incomplete', async () => {
      // The discriminator is strictly `typeof === 'boolean'`. A coerced string ('true')
      // sneaks past a naive `'complete' in raw` check; the typeof guard catches it and
      // routes to the fail-closed legacy branch. Same for numeric/null/undefined values.
      const wrongTypeValues: unknown[] = ['true', 1, 0, null];
      for (const completeValue of wrongTypeValues) {
        const client = {
          post: vi.fn().mockResolvedValue({
            entries: { 'a.md': { hash: 'h', size: 1 } },
            complete: completeValue,
          }),
        };

        const manifest = await sync.fetchCloudManifest(client);
        expect(manifest?.complete).toBe(false);
        expect(manifest?.reasons).toEqual(['legacy-shape']);
      }
    });

    it('preserves explicit complete:false from a well-formed envelope (does not coerce to true)', async () => {
      // Defensive: the parser must never default `complete` to true. If the cloud sends
      // an explicit `complete: false`, downstream destructive ops (cloud-missing repair)
      // must remain gated. See executeSyncCore's `cloudComplete = cloudManifest?.complete ?? false`.
      const client = {
        post: vi.fn().mockResolvedValue({
          entries: { 'a.md': { hash: 'h', size: 1 } },
          complete: false,
          reasons: ['cloud-permission'],
        }),
      };

      const manifest = await sync.fetchCloudManifest(client);

      expect(manifest?.complete).toBe(false);
      expect(manifest?.reasons).toEqual(['cloud-permission']);
      expect(manifest?.entries).toEqual({ 'a.md': { hash: 'h', size: 1 } });
    });

    it('parses well-formed envelope and ignores unknown extra fields (forward-compat)', async () => {
      // Server may add new envelope fields in future versions. Parser must accept the
      // current shape and pass through entries/complete/reasons faithfully without
      // tripping on unknown siblings.
      const client = {
        post: vi.fn().mockResolvedValue({
          entries: { 'a.md': { hash: 'h', size: 1 } },
          complete: true,
          reasons: [],
          schemaVersion: 'v2-future',
          renderedAt: 12345,
        }),
      };

      const manifest = await sync.fetchCloudManifest(client);

      expect(manifest?.complete).toBe(true);
      expect(manifest?.entries).toEqual({ 'a.md': { hash: 'h', size: 1 } });
      expect(manifest?.reasons).toEqual([]);
    });

    it('passes through malformed inner-entry shapes (cloudComplete is the safety net, not inner validation)', async () => {
      // Documents the current contract: the envelope discriminator (`complete: boolean`)
      // is the only structural validation; inner entries are NOT deep-validated. This is
      // currently safe because (1) destructive ops gate on cloudComplete, and
      // (2) downstream hash/size comparisons fail-close on type mismatches. If we ever
      // tighten this with Zod/zod-like inner-entry validation, this test becomes a
      // forcing function -- update it to assert the new fail-closed contract.
      const client = {
        post: vi.fn().mockResolvedValue({
          entries: {
            'good.md': { hash: 'h', size: 1 },
            // intentionally malformed: wrong primitive types
            'bad.md': { hash: 123, size: 'oops' },
          },
          complete: true,
          reasons: [],
        }),
      };

      const manifest = await sync.fetchCloudManifest(client);

      expect(manifest?.complete).toBe(true);
      // Pass-through, not validation. Asserts the negative explicitly.
      expect(manifest?.entries['bad.md']).toEqual({ hash: 123, size: 'oops' });
    });

    it('blocks cloud-missing repair when fetchCloudManifest returns null (network/shape failure)', async () => {
      // Integration: when the manifest fetch fails outright (transport error, non-object
      // response), the cloud-missing repair gate (`localComplete && cloudComplete &&
      // cloudManifest`) must short-circuit so we don't re-push entries from
      // lastPushedManifest that we can't currently see in cloud. Mirrors the
      // explicit-complete:false case above but exercises the null-manifest branch.
      const lostEntry = { mtime: 1, size: 10, hash: 'lost-hash' };
      sync._getLastPushedManifest().set('lost.md', lostEntry);

      vi.spyOn(sync, 'buildLocalManifest').mockResolvedValue({
        manifest: new Map([['lost.md', lostEntry]]),
        complete: true,
        reasons: [],
      });

      const client = makeClient();
      client.post.mockImplementation((endpoint: string) => {
        if (endpoint === '/api/library/manifest') return Promise.resolve(null);
        return Promise.resolve({ path: 'test', updatedAt: Date.now() });
      });

      await sync.forceSync(client, WORKSPACE_DIR);

      const lostUploads = client.post.mock.calls.filter(([endpoint, body]) => (
        endpoint === '/api/library/upload-file'
        && (body as { path?: string } | undefined)?.path === 'lost.md'
      ));
      expect(lostUploads).toHaveLength(0);
    });

    it('does not retry TOCTOU when the fresh manifest is incomplete', async () => {
      createWorkspaceFile('tracked.txt', 'v1');
      const stat = fs.statSync(path.join(WORKSPACE_DIR, 'tracked.txt'));
      const localEntry = { mtime: Math.floor(stat.mtimeMs), size: stat.size, hash: 'local-hash' };

      vi.spyOn(sync, 'buildLocalManifest')
        .mockResolvedValueOnce({
          manifest: new Map([['tracked.txt', localEntry]]),
          complete: true,
          reasons: [],
        })
        .mockResolvedValueOnce({
          manifest: new Map([['tracked.txt', { ...localEntry, hash: 'fresh-partial-hash' }]]),
          complete: false,
          reasons: ['unreadable'],
        });

      const client = makeClient();
      await sync.forceSync(client, WORKSPACE_DIR);

      const uploadCalls = client.post.mock.calls.filter(([endpoint]) => endpoint === '/api/library/upload-file');
      expect(uploadCalls).toHaveLength(1);
    });

    it.skipIf(process.platform === 'win32')('reports an unreadable directory as an incomplete permission-truncated manifest', async () => {
      createWorkspaceFile('readable/ok.md', 'ok');
      createWorkspaceFile('unreadable/hidden.md', 'hidden');
      const unreadableDir = path.join(WORKSPACE_DIR, 'unreadable');

      let chmodSucceeded = false;
      try {
        fs.chmodSync(unreadableDir, 0o000);
        try {
          fs.readdirSync(unreadableDir);
        } catch {
          chmodSucceeded = true;
        }
      } catch {
        // Not all environments support chmod-based unreadable fixtures.
      }

      try {
        if (!chmodSucceeded) return;

        const result = await sync.buildLocalManifest(WORKSPACE_DIR);

        expect(result.complete).toBe(false);
        expect(result.reasons).toEqual(['permission']);
        expect(result.manifest.has('readable/ok.md')).toBe(true);
        expect(result.manifest.has('unreadable/hidden.md')).toBe(false);
      } finally {
        try {
          fs.chmodSync(unreadableDir, 0o755);
        } catch {
          // ignore
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // syncIfNeeded
  // ---------------------------------------------------------------------------

  describe('syncIfNeeded', () => {
    it('syncs changed files on first call', async () => {
      createWorkspaceFile('sync-me.txt', 'sync content');

      const client = makeClient();
      await sync.syncIfNeeded(client, WORKSPACE_DIR);

      // 1 upload-file push + 1 manifest pull = 2
      expect(client.post).toHaveBeenCalledTimes(2);
      expect(sync._getLastSyncAt()).toBeGreaterThan(0);
    });

    it('throttles subsequent calls within 5 minutes', async () => {
      createWorkspaceFile('file.txt', 'content');

      const client = makeClient();
      await sync.syncIfNeeded(client, WORKSPACE_DIR);
      const firstSyncAt = sync._getLastSyncAt();

      // Second call should be throttled
      await sync.syncIfNeeded(client, WORKSPACE_DIR);
      expect(sync._getLastSyncAt()).toBe(firstSyncAt);
      // 1 push + 1 manifest from first sync only; second is throttled
      expect(client.post).toHaveBeenCalledTimes(2);
    });

    it('records lastSyncAt even when no files changed', async () => {
      // Empty workspace — nothing to push, but still fetches cloud manifest
      const client = makeClient();
      await sync.syncIfNeeded(client, WORKSPACE_DIR);

      expect(sync._getLastSyncAt()).toBeGreaterThan(0);
      // 1 manifest pull only (no push)
      expect(client.post).toHaveBeenCalledTimes(1);
    });

    it('handles delete-only scenarios (no changed files, only deletions)', async () => {
      // Push a file first
      createWorkspaceFile('will-delete.txt', 'temporary');
      const client = makeClient();
      await sync.syncIfNeeded(client, WORKSPACE_DIR);

      // 1 upload-file push + 1 manifest pull = 2
      expect(client.post).toHaveBeenCalledTimes(2);
      expect(sync._getLastPushedManifest().has('will-delete.txt')).toBe(true);

      // Delete the file from workspace
      fs.rmSync(path.join(WORKSPACE_DIR, 'will-delete.txt'));

      // Reset throttle so syncIfNeeded runs again
      sync._resetForTesting();
      // Re-seed the lastPushedManifest (reset clears it)
      sync._getLastPushedManifest().set('will-delete.txt', { mtime: 1000, size: 9, hash: 'abc1234567890123' });

      const client2 = makeClient();
      await sync.syncIfNeeded(client2, WORKSPACE_DIR);

      // Should have called delete-file endpoint
      expect(client2.post).toHaveBeenCalledWith('/api/library/delete-file', { path: 'will-delete.txt' });
      expect(sync._getLastPushedManifest().has('will-delete.txt')).toBe(false);
    });

    it('prevents concurrent syncs', async () => {
      createWorkspaceFile('file.txt', 'content');

      const resolvers: Array<() => void> = [];
      const client = {
        post: vi.fn().mockImplementation((endpoint: string) => {
          if (endpoint === '/api/library/manifest') return Promise.resolve({ entries: {}, complete: true, reasons: [] });
          return new Promise<void>((r) => { resolvers.push(r); });
        }),
      };

      // Start first sync (don't await — it will block on push)
      const first = sync.syncIfNeeded(client, WORKSPACE_DIR);

      // Yield to let first sync reach the blocking push call
      await new Promise((r) => setTimeout(r, 50));

      // Second call should return immediately (concurrent guard)
      const secondResult = await sync.syncIfNeeded(client, WORKSPACE_DIR);

      // Let the first sync complete
      resolvers.forEach((r) => r());
      await first;

      // 1 push + 1 manifest from first sync; second is blocked by concurrent guard
      expect(client.post).toHaveBeenCalledTimes(2);
      expect(secondResult).toBe('in_progress');
    });

    it('serialises concurrent syncs across instances for the same workspace', async () => {
      createWorkspaceFile('file.txt', 'content');

      const secondSync = new CloudWorkspaceSync();
      const resolvers: Array<() => void> = [];
      let maxConcurrent = 0;
      let currentConcurrent = 0;
      const client = {
        post: vi.fn().mockImplementation((endpoint: string) => {
          if (endpoint === '/api/library/manifest') return Promise.resolve({ entries: {}, complete: true, reasons: [] });
          currentConcurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
          return new Promise<void>((resolve) => {
            resolvers.push(() => {
              currentConcurrent -= 1;
              resolve();
            });
          });
        }),
      };

      const firstPromise = sync.forceSync(client, WORKSPACE_DIR);
      await vi.waitFor(() => {
        const uploadCalls = client.post.mock.calls.filter(([endpoint]) => endpoint === '/api/library/upload-file');
        expect(uploadCalls).toHaveLength(1);
      });
      const secondPromise = secondSync.forceSync(client, WORKSPACE_DIR);
      await new Promise((r) => setTimeout(r, 20));

      expect(maxConcurrent).toBe(1);
      expect(client.post.mock.calls.filter(([endpoint]) => endpoint === '/api/library/upload-file')).toHaveLength(1);

      resolvers.shift()?.();
      await vi.waitFor(() => {
        expect(client.post.mock.calls.filter(([endpoint]) => endpoint === '/api/library/upload-file')).toHaveLength(2);
        expect(resolvers).toHaveLength(1);
      });
      resolvers.shift()?.();

      await Promise.all([firstPromise, secondPromise]);
      expect(maxConcurrent).toBe(1);
      secondSync._resetForTesting();
    });

    it('retries with a fresh manifest when a file changes during sync commit', async () => {
      createWorkspaceFile('tracked.txt', 'v1');

      const client = {
        post: vi.fn().mockImplementation((endpoint: string, body?: unknown) => {
          if (endpoint === '/api/library/manifest') return Promise.resolve({ entries: {}, complete: true, reasons: [] });
          if (endpoint === '/api/library/upload-file') {
            const uploadCount = client.post.mock.calls.filter(([calledEndpoint]) => calledEndpoint === '/api/library/upload-file').length;
            if (uploadCount === 1) {
              createWorkspaceFile('tracked.txt', 'v2');
              const nextMtime = new Date(Date.now() + 5_000);
              fs.utimesSync(path.join(WORKSPACE_DIR, 'tracked.txt'), nextMtime, nextMtime);
            }
            return Promise.resolve({ path: 'tracked.txt', updatedAt: Date.now(), body });
          }
          return Promise.resolve({});
        }),
      };

      await sync.forceSync(client, WORKSPACE_DIR);

      const uploadCalls = client.post.mock.calls.filter(([endpoint]) => endpoint === '/api/library/upload-file');
      expect(uploadCalls).toHaveLength(2);
      const lastUploadBody = uploadCalls[1]?.[1] as { content: string };
      expect(Buffer.from(lastUploadBody.content, 'base64').toString('utf8')).toBe('v2');
    });
  });

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  describe('persistence', () => {
    it('persists manifest to disk on flush and reloads', async () => {
      createWorkspaceFile('persist.txt', 'persisted content');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);
      const entry = manifest.get('persist.txt')!;
      sync._getLastPushedManifest().set('persist.txt', entry);
      sync.flush();

      expect(fs.existsSync(MANIFEST_PATH)).toBe(true);

      // Create fresh instance and reload
      const fresh = new CloudWorkspaceSync();
      fresh.load();
      const reloaded = fresh._getLastPushedManifest();
      expect(reloaded.has('persist.txt')).toBe(true);
      expect(reloaded.get('persist.txt')!.hash).toBe(entry.hash);
      fresh._resetForTesting();
    });

    it('handles missing manifest file gracefully', () => {
      sync.load();
      expect(sync._getLastPushedManifest().size).toBe(0);
    });

    it('handles corrupt manifest file gracefully', () => {
      fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
      fs.writeFileSync(MANIFEST_PATH, 'not-json', 'utf8');

      sync.load();
      expect(sync._getLastPushedManifest().size).toBe(0);
    });

    it('filters out invalid entries on load', () => {
      fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
      fs.writeFileSync(
        MANIFEST_PATH,
        JSON.stringify({
          'valid.txt': { mtime: 1000, size: 100, hash: 'abc123def456gh' },
          'invalid.txt': { mtime: 'not-a-number', size: 100, hash: 'abc' },
          'missing-hash.txt': { mtime: 1000, size: 100 },
        }),
        'utf8',
      );

      sync.load();
      const manifest = sync._getLastPushedManifest();
      expect(manifest.size).toBe(1);
      expect(manifest.has('valid.txt')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // .gitignore matching
  // ---------------------------------------------------------------------------

  describe('.gitignore matching', () => {
    it('skips wildcard patterns like *.log', async () => {
      createWorkspaceFile('.gitignore', '*.log\n');
      createWorkspaceFile('app.ts', 'code');
      createWorkspaceFile('debug.log', 'log content');
      createWorkspaceFile('sub/other.log', 'nested log');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('app.ts')).toBe(true);
      expect(manifest.has('debug.log')).toBe(false);
      expect(manifest.has(path.join('sub', 'other.log'))).toBe(false);
    });

    it('skips directory patterns with trailing slash', async () => {
      createWorkspaceFile('.gitignore', 'vendor/\n');
      createWorkspaceFile('src/app.ts', 'code');
      createWorkspaceFile('vendor/lib.js', 'vendor code');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has(path.join('src', 'app.ts'))).toBe(true);
      expect(manifest.has(path.join('vendor', 'lib.js'))).toBe(false);
    });

    it('ignores comment lines in .gitignore', async () => {
      createWorkspaceFile('.gitignore', '# this is a comment\n*.log\n');
      createWorkspaceFile('app.ts', 'code');
      createWorkspaceFile('error.log', 'error');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);

      expect(manifest.has('app.ts')).toBe(true);
      expect(manifest.has('error.log')).toBe(false);
    });

    it('ignores empty lines in .gitignore', async () => {
      createWorkspaceFile('.gitignore', '\n*.log\n\n');
      createWorkspaceFile('error.log', 'error');

      const { manifest } = await sync.buildLocalManifest(WORKSPACE_DIR);
      expect(manifest.has('error.log')).toBe(false);
    });
  });
});
