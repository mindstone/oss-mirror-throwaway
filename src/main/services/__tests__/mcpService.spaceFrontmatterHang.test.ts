/**
 * MA1 (no-regret turn-path fix) — `buildSpaceSummaries`' per-space README read runs
 * on the AWAITED turn path (`resolveSystemPrompt` → `generateEnvContext` →
 * `buildSpaceSummaries`). For a CLOUD-backed space whose FUSE mount is dead, the
 * read used to be SYNCHRONOUS (`existsSync`/`readFileSync`) and froze the MAIN
 * thread (event loop) so the turn never started. The fix makes the read async +
 * cloud-budget-bounded; a dead cloud mount degrades (the space keeps its
 * config-derived description) instead of blocking, while LOCAL reads stay on the
 * cheap fast path and preserve frontmatter content.
 *
 * Test mechanics mirror `fileTreeService.cloudBound.test.ts`:
 * - mock `node:fs.readlinkSync` so the workspace space symlink classifies as cloud
 *   (real `@core` cloud detector runs on the mocked target);
 * - mock `node:fs/promises` so the cloud space's `readFile` NEVER resolves (dead
 *   mount) while local reads resolve immediately;
 * - fake timers drive past the cloud budget — without the bound the promise never
 *   settles and the test times out (the regression).
 *
 * @see docs/plans/260619_cloud-symlink-indexing/PLAN.md — MA1
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import {
  DEFAULT_VOICE_ACTIVATION_HOTKEY,
  DEFAULT_VOICE_ACTIVATION_VOICE_MODE,
} from '@shared/types';

// A genuinely cloud-classified target (provider-agnostic CloudStorage mount).
const CLOUD_TARGET =
  '/Users/test/Library/CloudStorage/GoogleDrive-user@example.com/Shared drives/Company Memories';
const WORKSPACE_ROOT = path.resolve('/workspace');

function makeEinval(): NodeJS.ErrnoException {
  const err = new Error('EINVAL: invalid argument, readlink') as NodeJS.ErrnoException;
  err.code = 'EINVAL';
  return err;
}
function makeEnoent(): NodeJS.ErrnoException {
  const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}
function makeEacces(): NodeJS.ErrnoException {
  const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
  err.code = 'EACCES';
  return err;
}

// readlinkSync: the `CloudSpace` space symlink resolves to a cloud target; the
// `LocalSpace` symlink + everything else is "not a symlink" (EINVAL) so the chain
// bottoms out as a provably-local terminus.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: actual,
    readlinkSync: (p: string) => {
      if (typeof p === 'string' && p.endsWith(`${path.sep}CloudSpace`)) return CLOUD_TARGET;
      throw makeEinval();
    },
  };
});

// fs/promises: a read whose path is UNDER the dead cloud target (or the cloud
// space dir) NEVER resolves; local reads resolve with content. readdir of the
// (local) workspace root resolves immediately.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const LOCAL_README = ['---', 'rebel_space_description: Local notes', '---', ''].join('\n');
  const readFile = vi.fn(async (p: unknown) => {
    const s = String(p);
    if (s.includes(`${path.sep}CloudSpace${path.sep}`)) {
      // Dead FUSE mount — readFile blocks forever in the kernel.
      return new Promise<string>(() => {});
    }
    if (s.includes(`${path.sep}LocalSpace${path.sep}README.md`)) return LOCAL_README;
    // PermSpace: README is PRESENT-but-unreadable (EACCES); its AGENTS.md WOULD have
    // content. The fix must NOT fall back to legacy on a non-absent README error
    // (GPT F2) → the space gets no frontmatter (null), not the legacy content.
    if (s.includes(`${path.sep}PermSpace${path.sep}README.md`)) throw makeEacces();
    if (s.includes(`${path.sep}PermSpace${path.sep}AGENTS.md`)) {
      return ['---', 'rebel_space_description: LEGACY (must not be used)', '---', ''].join('\n');
    }
    // Any other README/AGENTS read → ENOENT (no frontmatter file).
    throw makeEnoent();
  });
  const readdir = vi.fn(async () => {
    // Workspace root is local → resolves instantly. Entries unused by these tests.
    return [] as unknown as string[];
  });
  // mcpService imports the DEFAULT (`import fs from 'node:fs/promises'`), so the
  // overrides must live on `default` too, not only the named exports.
  return {
    ...actual,
    default: { ...actual, readFile, readdir },
    readFile,
    readdir,
  };
});

const { buildSpaceSummaries } = await import('../mcpService');

const baseSettings: AppSettings = {
  coreDirectory: WORKSPACE_ROOT,
  mcpConfigFile: null,
  onboardingCompleted: false,
  userEmail: null,
  onboardingFirstCompletedAt: null,
  voice: {
    provider: 'openai-whisper',
    openaiApiKey: null,
    elevenlabsApiKey: null,
    model: 'whisper-1',
    ttsVoice: null,
    activationHotkey: DEFAULT_VOICE_ACTIVATION_HOTKEY,
    activationHotkeyVoiceMode: DEFAULT_VOICE_ACTIVATION_VOICE_MODE,
  },
  models: {
    apiKey: 'test-key',
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-sonnet-4-5',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: true,
    extendedContext: true,
    thinkingEffort: 'high',
  },
  diagnostics: { debugBreadcrumbsUntil: null },
};

describe('buildSpaceSummaries — MA1 cloud README read does not freeze the turn path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a DEAD cloud space README does NOT block — summaries resolve, space retained with config description', async () => {
    vi.useFakeTimers();
    const promise = buildSpaceSummaries({
      ...baseSettings,
      spaces: [
        {
          name: 'Company Memories',
          path: 'CloudSpace',
          type: 'company',
          companyName: 'Acme',
          isSymlink: true,
          createdAt: 1,
        },
      ],
    });
    // Without the bound this promise NEVER settles (dead readFile). Drive past the
    // cloud budget so the bounded read abandons and the build completes.
    await vi.advanceTimersByTimeAsync(60_000);
    const { spaces } = await promise;

    // Chief-of-Staff is synthesized + the cloud space is retained (not dropped).
    const cloudSpace = spaces.find((s) => s.name === 'Company Memories');
    expect(cloudSpace).toBeDefined();
    // The README was unreadable (timed out) → falls back to the config-derived
    // description, NOT frontmatter content (which never arrived).
    expect(cloudSpace?.description).toBe('Acme - Company Memories');
  });

  it('a LOCAL space README is read on the fast path and its frontmatter is preserved', async () => {
    // No fake timers needed — local read resolves immediately.
    const { spaces } = await buildSpaceSummaries({
      ...baseSettings,
      spaces: [
        {
          name: 'Local Notes',
          path: 'LocalSpace',
          type: 'personal',
          isSymlink: false,
          createdAt: 1,
        },
      ],
    });
    const local = spaces.find((s) => s.name === 'Local Notes');
    expect(local).toBeDefined();
    // Frontmatter description preserved (proves the local read still happens + parses).
    expect(local?.description).toBe('Local notes');
  });

  it('a dead cloud space does not delay a healthy local space in the same workspace', async () => {
    vi.useFakeTimers();
    const promise = buildSpaceSummaries({
      ...baseSettings,
      spaces: [
        { name: 'Local Notes', path: 'LocalSpace', type: 'personal', isSymlink: false, createdAt: 1 },
        {
          name: 'Company Memories',
          path: 'CloudSpace',
          type: 'company',
          companyName: 'Acme',
          isSymlink: true,
          createdAt: 2,
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const { spaces } = await promise;

    expect(spaces.find((s) => s.name === 'Local Notes')?.description).toBe('Local notes');
    expect(spaces.find((s) => s.name === 'Company Memories')?.description).toBe('Acme - Company Memories');
  });

  it('a PRESENT-but-unreadable README (EACCES) does NOT fall back to legacy AGENTS.md (GPT F2 semantics)', async () => {
    // No fake timers — EACCES rejects immediately (not a hang).
    const { spaces } = await buildSpaceSummaries({
      ...baseSettings,
      spaces: [
        {
          name: 'Locked Space',
          path: 'PermSpace',
          type: 'personal',
          isSymlink: false,
          createdAt: 1,
        },
      ],
    });
    const locked = spaces.find((s) => s.name === 'Locked Space');
    expect(locked).toBeDefined();
    // README was unreadable (EACCES) and we must NOT use the legacy AGENTS.md content
    // → the config-derived description, NOT 'LEGACY (must not be used)'.
    expect(locked?.description).toBe('Company - Locked Space');
    expect(locked?.description).not.toContain('LEGACY');
  });
});
