/**
 * Regression tests for the raw-string path-guard evasion class.
 *
 * Several memory-write safety guards string-matched a RAW (un-normalized) file
 * path before canonicalization, so `/./`, `/../`, `//` and trailing-slash
 * spellings could evade them. Because the shared bash write-target extractor
 * returns RAW targets, those spellings reached the guards unchanged.
 *
 * Two evasions drive a SECURITY decision in the "dangerous" direction:
 *   - Bug 1 (plugin): `…/plugins/demo/../demo/index.tsx` evaded
 *     `detectPluginSourceFile` → bypassed the rebel_plugins_create AST/compile
 *     validation redirect.
 *   - Bug 2 (pending): `…/memory/./pending/x.md` evaded `isMemoryPendingPath` →
 *     a direct write into the managed staging folder was not denied.
 * Three more (found by the required sweep) evaded auto-approve allow-folder
 * containment checks (temp / inbox), letting a traversal path that resolves
 * OUTSIDE the trusted folder be auto-approved:
 *   - `classifyUnmatchedPath` temp + inbox branches
 *   - `isInboxPath`
 *
 * The fix normalizes the path inside each guard (Option E) and unifies the two
 * write-target extractors (Option A). See
 * docs/plans/260614_investigate-bashwritetargets/PLAN.md.
 *
 * These tests feed the exact evasion inputs through the real guards/hook and
 * assert the evasions are now CAUGHT, while legitimate paths still classify
 * correctly (no over-blocking).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HookJSONOutput, SyncHookJSONOutput } from '@core/agentRuntimeTypes';
import { isSyncHookOutput } from '@core/agentRuntimeTypes';
import { createMemoryWriteHook, testingGuards } from '../memoryWriteHook';
import * as spaceService from '../../spaceService';
import * as settingsStore from '@core/services/settingsStore';
import { getPlatformConfig } from '@core/platform';

const USER_DATA = '/users/test/Library/Application Support/mindstone-rebel';
const HOME = '/users/test';
const INBOX_DIR = `${USER_DATA}/inbox`;

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({ sendToAllWindows: vi.fn(), sendToFocusedWindow: vi.fn() }),
}));
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@core/platform', () => ({
  getPlatformConfig: vi.fn(() => ({ userDataPath: USER_DATA, homePath: HOME })),
}));
vi.mock('@core/safetyPromptLogic', () => ({
  evaluateSafetyPrompt: vi.fn().mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'ok' }),
  shouldAllow: vi.fn().mockReturnValue(true),
}));
vi.mock('@core/safetyPromptStore', () => ({
  getSafetyPrompt: vi.fn().mockReturnValue('default'),
  getSafetyPromptVersion: vi.fn().mockReturnValue(1),
  isMigrationComplete: vi.fn().mockReturnValue(true),
}));
vi.mock('@core/safetyActivityLogStore', () => ({ addEvaluationEntry: vi.fn() }));
vi.mock('../cosPendingService');
vi.mock('../../spaceService');
vi.mock('@core/services/settingsStore');
vi.mock('../automationContextLookup', () => ({
  getAutomationContext: vi.fn().mockReturnValue({ automationId: 'a', automationName: 'A' }),
}));
vi.mock('../../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    recordSecurityDenial: vi.fn(),
    recordToolCall: vi.fn(),
    incrementAutomationSafetyBlock: vi.fn(),
    getAutomationSafetyBlockCount: vi.fn().mockReturnValue(0),
    getTurnPrompt: vi.fn(),
  },
}));
vi.mock('@core/utils/logRedaction', () => ({
  containsCredentialPatterns: vi.fn().mockReturnValue({ detected: false, reasons: [] }),
}));

function getOut(result: HookJSONOutput): NonNullable<SyncHookJSONOutput['hookSpecificOutput']> | undefined {
  if (!isSyncHookOutput(result)) return undefined;
  return result.hookSpecificOutput;
}

const signal = new AbortController().signal;

beforeEach(() => {
  vi.clearAllMocks();
  // Restore the default platform mock (clearAllMocks wipes the implementation).
  vi.mocked(getPlatformConfig).mockReturnValue({ userDataPath: USER_DATA, homePath: HOME } as ReturnType<typeof getPlatformConfig>);
  vi.mocked(settingsStore.getSettings).mockReturnValue({
    coreDirectory: '/workspace',
    spaces: [],
    spaceSafetyLevels: {},
  } as unknown as ReturnType<typeof settingsStore.getSettings>);
});

// ===========================================================================
// Unit-level guard tests (precise red→green on the normalization fix)
// ===========================================================================
describe('isMemoryPendingPath — traversal evasion is caught', () => {
  it('catches the `/./` evasion (Bug 2)', () => {
    // Pre-fix: `.includes('/memory/pending/')` on the raw path returned false.
    expect(testingGuards.isMemoryPendingPath('Chief-of-Staff/memory/./pending/pwn.md')).toBe(true);
  });
  it('catches `//` and `/../`-into-back spellings', () => {
    expect(testingGuards.isMemoryPendingPath('Chief-of-Staff/memory//pending/x.md')).toBe(true);
    expect(testingGuards.isMemoryPendingPath('Chief-of-Staff/memory/sub/../pending/x.md')).toBe(true);
  });
  it('catches a relative target that STARTS with memory/pending (no leading slash)', () => {
    // Pre-fix: `.includes('/memory/pending/')` missed this (no leading slash).
    expect(testingGuards.isMemoryPendingPath('memory/pending/x.md')).toBe(true);
  });
  it('still matches the normal mid-path and absolute forms', () => {
    expect(testingGuards.isMemoryPendingPath('/workspace/Chief-of-Staff/memory/pending/x.md')).toBe(true);
    expect(testingGuards.isMemoryPendingPath('Chief-of-Staff/memory/pending/x.md')).toBe(true);
  });
  it('does not over-match unrelated paths', () => {
    expect(testingGuards.isMemoryPendingPath('Chief-of-Staff/memory/topics/x.md')).toBe(false);
    expect(testingGuards.isMemoryPendingPath('Chief-of-Staff/pending/x.md')).toBe(false);
    expect(testingGuards.isMemoryPendingPath('notes/memory-pending-summary.md')).toBe(false);
  });
});

describe('isInboxPath — traversal evasion is caught', () => {
  it('rejects a traversal path that resolves OUTSIDE inbox', () => {
    // Pre-fix: raw `.startsWith(inboxDir + '/')` was true → auto-approved while
    // actually resolving to <userData>/trusted-tools.
    expect(testingGuards.isInboxPath(`${INBOX_DIR}/../trusted-tools/pwn.json`)).toBe(false);
    expect(testingGuards.isInboxPath(`${INBOX_DIR}/../../etc/pwn`)).toBe(false);
  });
  it('still accepts legitimate inbox paths (incl. inert `/./`)', () => {
    expect(testingGuards.isInboxPath(`${INBOX_DIR}/item.json`)).toBe(true);
    expect(testingGuards.isInboxPath(`${INBOX_DIR}/./item.json`)).toBe(true);
    expect(testingGuards.isInboxPath(INBOX_DIR)).toBe(true);
  });
  it('does not match a sibling dir that shares the inbox prefix', () => {
    expect(testingGuards.isInboxPath(`${USER_DATA}/inbox-archive/x.json`)).toBe(false);
  });
});

describe('classifyUnmatchedPath — traversal evasion does not yield an auto-approved classification', () => {
  const core = '/workspace';
  it('does not classify an inbox-traversal path as inbox', () => {
    const { classification } = testingGuards.classifyUnmatchedPath(`${INBOX_DIR}/../trusted-tools/pwn.json`, core);
    expect(classification).not.toBe('inbox');
  });
  it('does not classify a temp-traversal path as temp', () => {
    const { classification } = testingGuards.classifyUnmatchedPath('/tmp/../etc/pwn', core);
    expect(classification).not.toBe('temp');
  });
  it('still classifies a legitimate inbox path as inbox', () => {
    const { classification } = testingGuards.classifyUnmatchedPath(`${INBOX_DIR}/item.json`, core);
    expect(classification).toBe('inbox');
  });
  it('still classifies a legitimate temp path as temp', () => {
    const { classification } = testingGuards.classifyUnmatchedPath('/tmp/scratch.txt', core);
    expect(classification).toBe('temp');
  });
});

describe('detectPluginSourceFile — traversal evasion is caught', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-rawguard-plugin-'));
  });

  it('detects the plugin via the `/../` evasion spelling (Bug 1)', async () => {
    const pluginDir = path.join(tempDir, 'work/Private/plugins/demo');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'manifest.json'), '{"id":"demo"}');
    await fs.writeFile(path.join(pluginDir, 'index.tsx'), 'export default () => null;');

    // The evasion spelling: …/plugins/demo/../demo/index.tsx. Build it by string
    // concatenation, NOT path.join — path.join would pre-collapse the `..` and the
    // test would no longer exercise the raw-string evasion the bash extractor
    // actually emits. Pre-fix the regex matched on the raw path and returned null.
    const evasionPath = `${tempDir}/work/Private/plugins/demo/../demo/index.tsx`;
    const result = await testingGuards.detectPluginSourceFile(evasionPath, tempDir);
    expect(result.pluginId).toBe('demo');
  });

  it('still returns null for a genuinely non-plugin path', async () => {
    const notesDir = path.join(tempDir, 'work/Private/notes');
    await fs.mkdir(notesDir, { recursive: true });
    const result = await testingGuards.detectPluginSourceFile(path.join(notesDir, 'x.md'), tempDir);
    expect(result.pluginId).toBeNull();
  });
});

// ===========================================================================
// Residual 1 — bashCommandTargetsLockedPath substring evasion
// ===========================================================================
// The checkpoint deny layer (gate ~2342) blocks Bash commands that reference a
// checkpoint-locked shared-skill file. It is a heuristic backstop for scripting
// bypasses the bash extractor can't parse (python path.write_text(), perl). It
// stored the locked path and substring-scanned the RAW command — so a `/./`,
// `//`, `..`-segment or trailing-slash spelling inside the command evaded it.
// A miss fails OPEN into the normal ladder, so this is a backstop hardening, not
// a silent-auto-approve fix; we still close the lexical evasion.
describe('bashCommandTargetsLockedPath — lexical substring evasion is caught', () => {
  const turnId = 't-locked';
  const core = '/workspace';
  const lockedRel = 'chief-of-staff/skills/foo/skill.md';

  beforeEach(async () => {
    testingGuards.clearCheckpointLockedState(turnId);
    // Lock the (relative) shared-skill path. lockPathForCheckpoint reads the file
    // for hashing; it tolerates a missing file (records '__absent__').
    await testingGuards.lockPathForCheckpoint(turnId, lockedRel, core);
  });

  it('catches the `/./` evasion spelling in the command', () => {
    // Pre-fix: raw `.includes('chief-of-staff/skills/foo/skill.md')` was false.
    const cmd = `echo hi > chief-of-staff/skills/foo/./skill.md`;
    expect(testingGuards.bashCommandTargetsLockedPath(turnId, cmd).locked).toBe(true);
  });

  it('catches `//` and `..`-segment evasion spellings', () => {
    expect(
      testingGuards.bashCommandTargetsLockedPath(turnId, `echo hi > chief-of-staff/skills/foo//skill.md`).locked,
    ).toBe(true);
    expect(
      testingGuards.bashCommandTargetsLockedPath(turnId, `echo hi > chief-of-staff/skills/bar/../foo/skill.md`).locked,
    ).toBe(true);
  });

  it('catches the evasion via the parsed-write-target path even with leading ./', () => {
    expect(
      testingGuards.bashCommandTargetsLockedPath(turnId, `echo hi > ./chief-of-staff/skills/foo/skill.md`).locked,
    ).toBe(true);
  });

  it('still matches the exact, non-evasive form', () => {
    expect(
      testingGuards.bashCommandTargetsLockedPath(turnId, `cat chief-of-staff/skills/foo/skill.md`).locked,
    ).toBe(true);
  });

  it('does not match an unrelated command', () => {
    expect(
      testingGuards.bashCommandTargetsLockedPath(turnId, `echo hi > chief-of-staff/skills/other/skill.md`).locked,
    ).toBe(false);
    expect(testingGuards.bashCommandTargetsLockedPath(turnId, `ls -la`).locked).toBe(false);
  });

  it('catches shell-quoting / backslash-escape spellings (Codex BLOCKER #2, backstop)', () => {
    // The extractor does not unquote these; the dequoted+collapsed backstop does.
    expect(
      testingGuards.bashCommandTargetsLockedPath(turnId, `echo hi > chief-of-staff/skills/foo/"skill.md"`).locked,
    ).toBe(true);
    expect(
      testingGuards.bashCommandTargetsLockedPath(turnId, `echo hi > chief-of-staff/skills/foo/skill\\.md`).locked,
    ).toBe(true);
  });
});

// ===========================================================================
// Residual 2 — symlink escape + Windows-case containment hardening
// ===========================================================================
describe('isPathContainedWithin — symlink escape is rejected', () => {
  let base: string;
  let inboxDir: string;
  let outside: string;

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-symlink-contain-'));
    inboxDir = path.join(base, 'inbox');
    outside = path.join(base, 'trusted-tools');
    await fs.mkdir(inboxDir, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
  });

  it('rejects a target whose parent is a symlink escaping the container', async () => {
    // inbox/escape -> ../trusted-tools ; target inbox/escape/pwn.json resolves OUTSIDE inbox.
    await fs.symlink(outside, path.join(inboxDir, 'escape'), 'dir');
    const target = `${inboxDir}/escape/pwn.json`; // leaf does not exist yet
    expect(testingGuards.isPathContainedWithin(target, inboxDir)).toBe(false);
  });

  it('accepts a legitimate not-yet-created leaf inside the container', () => {
    const target = `${inboxDir}/item.json`;
    expect(testingGuards.isPathContainedWithin(target, inboxDir)).toBe(true);
  });

  it('accepts a nested not-yet-created path inside the container', () => {
    const target = `${inboxDir}/a/b/c.json`;
    expect(testingGuards.isPathContainedWithin(target, inboxDir)).toBe(true);
  });

  it('rejects a sibling dir sharing the prefix', () => {
    expect(testingGuards.isPathContainedWithin(`${base}/inbox-archive/x.json`, inboxDir)).toBe(false);
  });

  it('rejects a BROKEN symlink leaf inside the container (Codex BLOCKER #1)', async () => {
    // `link` is a symlink to an outside path that does NOT exist. realpathSync
    // throws, but the component EXISTS as a symlink — a write to it follows the
    // link OUTSIDE inbox. Pre-fix the helper walked up and treated it as a
    // not-yet-created leaf → contained=true.
    await fs.symlink(path.join(outside, 'new-file.json'), path.join(inboxDir, 'link'), 'file');
    expect(testingGuards.isPathContainedWithin(`${inboxDir}/link`, inboxDir)).toBe(false);
  });

  it('rejects a write THROUGH a broken-symlink directory inside the container', async () => {
    // `escdir` -> ../trusted-tools-absent (a dir that does not exist). A nested
    // write `escdir/x.json` must not be classified as contained.
    await fs.symlink(path.join(base, 'trusted-tools-absent'), path.join(inboxDir, 'escdir'), 'dir');
    expect(testingGuards.isPathContainedWithin(`${inboxDir}/escdir/x.json`, inboxDir)).toBe(false);
  });
});

describe('isInboxPath — symlink escape is rejected (real symlink)', () => {
  // These exercise the symlink-aware second gate on the REAL platformConfig inbox
  // dir. The platform mock points userDataPath at USER_DATA which does not exist
  // on disk, so isPathContainedWithin falls back to its nearest existing ancestor
  // and the lexical pre-check governs — keep these scoped to a tmp inbox we create.
  let realInbox: string;
  let outside: string;

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-inbox-symlink-'));
    realInbox = path.join(base, 'inbox');
    outside = path.join(base, 'trusted-tools');
    await fs.mkdir(realInbox, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    vi.mocked(getPlatformConfig).mockReturnValue({
      userDataPath: base,
      homePath: HOME,
    } as ReturnType<typeof getPlatformConfig>);
  });

  it('rejects an inbox path that escapes via a symlinked subdir', async () => {
    await fs.symlink(outside, path.join(realInbox, 'escape'), 'dir');
    expect(testingGuards.isInboxPath(`${realInbox}/escape/pwn.json`)).toBe(false);
  });

  it('still accepts a real inbox path', () => {
    expect(testingGuards.isInboxPath(`${realInbox}/item.json`)).toBe(true);
  });
});

describe('classifyUnmatchedPath — mcp_servers symlink escape is not auto-approved (Codex SHOULD #3)', () => {
  let home: string;
  let mcpDir: string;
  let outside: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-mcp-symlink-'));
    mcpDir = path.join(home, 'mcp-servers');
    outside = path.join(home, 'secrets');
    await fs.mkdir(mcpDir, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    vi.mocked(getPlatformConfig).mockReturnValue({
      userDataPath: path.join(home, 'userData'),
      homePath: home,
    } as ReturnType<typeof getPlatformConfig>);
  });

  it('does not classify a symlink-escaping mcp-servers path as mcp_servers', async () => {
    await fs.symlink(outside, path.join(mcpDir, 'escape'), 'dir');
    const { classification } = testingGuards.classifyUnmatchedPath(`${mcpDir}/escape/pwn.json`, home);
    expect(classification).not.toBe('mcp_servers');
  });

  // The positive "legitimate mcp path → mcp_servers" case is confounded in tests:
  // the only writable home is under os.tmpdir(), so the earlier `temp` branch
  // legitimately wins. We assert the symlink-aware gate accepts a real mcp path
  // directly via isPathContainedWithin instead (the AND-condition my edit added).
  it('isPathContainedWithin accepts a legitimate mcp-servers child', () => {
    expect(testingGuards.isPathContainedWithin(`${mcpDir}/my-connector/index.ts`, mcpDir)).toBe(true);
  });
});

// ===========================================================================
// End-to-end hook tests (the deny gates, via a real Bash write command)
// ===========================================================================
describe('memoryWriteHook end-to-end — Bash write evasions are denied', () => {
  it('denies a Bash write to memory/pending via the `/./` evasion (Bug 2)', async () => {
    // Configure a CoS space so the raw bash target resolves to a real space and
    // the hook reaches the pending deny gate. The `/./` spelling must be denied.
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [{ path: 'chief-of-staff', type: 'chief-of-staff' }],
      spaceSafetyLevels: {},
    } as unknown as ReturnType<typeof settingsStore.getSettings>);
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([
      {
        name: 'Chief of Staff',
        path: 'chief-of-staff',
        absolutePath: '/workspace/chief-of-staff',
        type: 'chief-of-staff',
        isSymlink: false,
        hasReadme: true,
      },
    ] as unknown as Awaited<ReturnType<typeof spaceService.scanSpaces>>);
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(undefined);
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Private Space');

    const hook = createMemoryWriteHook({
      turnId: 't-pending',
      sessionId: 's-pending',
      originalTurnId: 'ot-pending',
      originalSessionId: 'os-pending',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'echo x > /workspace/chief-of-staff/memory/./pending/pwn.md' },
        tool_use_id: 'tu-pending',
      },
      'tu-pending',
      { signal },
    );

    const out = getOut(result);
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason ?? '').toContain('memory/pending/');
  });

  it('redirects a Bash write to a plugin source via the `/../` evasion to rebel_plugins_create (Bug 1)', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-rawguard-e2e-plugin-'));
    const spaceRel = 'work/private';
    const pluginDir = path.join(tempDir, spaceRel, 'plugins/demo');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'manifest.json'), '{"id":"demo"}');
    await fs.writeFile(path.join(pluginDir, 'index.tsx'), 'export default () => null;');

    // Configure a private space containing the plugin so the raw bash target
    // resolves to a real space and the hook reaches the plugin guard.
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: tempDir,
      spaces: [{ path: spaceRel, type: 'space', sharing: 'private' }],
      spaceSafetyLevels: {},
    } as unknown as ReturnType<typeof settingsStore.getSettings>);
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([
      {
        name: 'Private',
        path: spaceRel,
        absolutePath: path.join(tempDir, spaceRel),
        type: 'space',
        isSymlink: false,
        hasReadme: true,
      },
    ] as unknown as Awaited<ReturnType<typeof spaceService.scanSpaces>>);
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue({ sharing: 'private' } as unknown as Awaited<ReturnType<typeof spaceService.readSpaceReadmeFrontmatter>>);
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Private');

    const hook = createMemoryWriteHook({
      turnId: 't-plugin',
      sessionId: 's-plugin',
      originalTurnId: 'ot-plugin',
      originalSessionId: 'os-plugin',
      coreDirectory: tempDir,
    });

    // String-concatenate to preserve the `..` spelling (path.join would collapse it).
    const evasionTarget = `${tempDir}/${spaceRel}/plugins/demo/../demo/index.tsx`;
    const result = await hook(
      {
        tool_name: 'Bash',
        tool_input: { command: `echo 'malicious' > ${evasionTarget}` },
        tool_use_id: 'tu-plugin',
      },
      'tu-plugin',
      { signal },
    );

    const out = getOut(result);
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason ?? '').toContain('rebel_plugins_create');

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
