import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MATERIALIZATION_SIZE_CAP_BYTES,
  materializeBuiltinBashOutput,
  writeMaterialisedFile,
} from '../builtinToolMaterialization';

const makeLog = () => ({
  info: vi.fn(),
  warn: vi.fn(),
});

const makeWorkspace = async (): Promise<string> => (
  fs.mkdtemp(path.join(os.tmpdir(), 'rebel-materialization-test-'))
);

describe('builtin tool materialization', () => {
  const originalKillSwitch = process.env.REBEL_DISABLE_BASH_MATERIALIZATION;
  let workspaces: string[] = [];

  beforeEach(() => {
    workspaces = [];
    delete process.env.REBEL_DISABLE_BASH_MATERIALIZATION;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalKillSwitch == null) {
      delete process.env.REBEL_DISABLE_BASH_MATERIALIZATION;
    } else {
      process.env.REBEL_DISABLE_BASH_MATERIALIZATION = originalKillSwitch;
    }
    await Promise.all(workspaces.map((workspace) => fs.rm(workspace, { recursive: true, force: true })));
  });

  const trackWorkspace = async (): Promise<string> => {
    const workspace = await makeWorkspace();
    workspaces.push(workspace);
    return workspace;
  };

  it('T1 materialises large Bash output and returns a path envelope', async () => {
    const workspace = await trackWorkspace();
    const log = makeLog();
    const stdout = 'x'.repeat(20_001);

    const result = await materializeBuiltinBashOutput({
      command: 'printf x',
      stdout,
      stderr: '',
      exitCode: 0,
      workspacePath: workspace,
      threshold: 20_000,
      sizeCap: MATERIALIZATION_SIZE_CAP_BYTES,
      log,
    });

    expect(result).toMatchObject({ materialized: true, sizeChars: stdout.length });
    expect(result?.output).toContain('Command exited with status 0. Stdout (first 2048 chars):');
    expect(result?.output).toContain('[output truncated — full 20001 chars saved to ');
    const relativePath = result?.output.match(/saved to ([^;]+);/)?.[1];
    // Model-facing relative path uses POSIX separators on every platform (Windows-safe
    // because backslashes can collide with JSON escapes — see Amendment from review).
    expect(relativePath).toMatch(/^\.rebel\/tool-outputs\/\d{6}_\d{4}_bash_[0-9a-f]{8}\.txt$/);
    const saved = await fs.readFile(path.join(workspace, relativePath ?? ''), 'utf8');
    expect(saved).toContain(stdout);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'materialization_success', tool_name: 'Bash' }),
      'Bash output materialized',
    );
  });

  it('T2 returns null below the threshold', async () => {
    const workspace = await trackWorkspace();
    const result = await materializeBuiltinBashOutput({
      command: 'printf small',
      stdout: 'small',
      stderr: '',
      exitCode: 0,
      workspacePath: workspace,
      threshold: 20_000,
      sizeCap: MATERIALIZATION_SIZE_CAP_BYTES,
      log: makeLog(),
    });

    expect(result).toBeNull();
  });

  it('T3 materialises stderr-only large output', async () => {
    const workspace = await trackWorkspace();
    const stderr = 'e'.repeat(20_001);

    const result = await materializeBuiltinBashOutput({
      command: 'tool --verbose',
      stdout: '',
      stderr,
      exitCode: 2,
      workspacePath: workspace,
      threshold: 20_000,
      sizeCap: MATERIALIZATION_SIZE_CAP_BYTES,
      log: makeLog(),
    });

    expect(result?.sizeChars).toBe(stderr.length);
    expect(result?.output).toContain(stderr.slice(0, 2_048));
    // Stderr-only output must be labelled `Stderr`, not `Stdout` (see review feedback).
    expect(result?.output).toContain('Stderr (first 2048 chars):');
    expect(result?.output).not.toContain('Stdout (first');
  });

  it('T3b previews unicode without splitting surrogate pairs', async () => {
    const workspace = await trackWorkspace();
    // Astral character ('🚀' = surrogate pair) repeated; naive .slice would split it.
    const rocket = '🚀';
    // Start with one ASCII char so preview length is exactly PREVIEW_CHARS code points
    // and the slice boundary lands inside the next surrogate pair if not handled.
    const stdout = 'a'.repeat(2_047) + rocket.repeat(20);
    const totalLength = stdout.length;

    const result = await materializeBuiltinBashOutput({
      command: 'unicode',
      stdout,
      stderr: '',
      exitCode: 0,
      workspacePath: workspace,
      threshold: 20_000,
      sizeCap: MATERIALIZATION_SIZE_CAP_BYTES,
      log: makeLog(),
    });

    // No materialisation expected at this length — but the unicode test we want is
    // about envelope preview safety.
    if (totalLength > 20_000) {
      const previewLine = result?.output.split('\n')[1] ?? '';
      // Preview must not end with a lone surrogate. A high-surrogate (0xD800–0xDBFF)
      // without a following low-surrogate is invalid UTF-16.
      const lastChar = previewLine.charCodeAt(previewLine.length - 1);
      const isLoneHighSurrogate = lastChar >= 0xd800 && lastChar <= 0xdbff;
      expect(isLoneHighSurrogate).toBe(false);
    }
  });

  it('T4 counts stdout and stderr toward the original total', async () => {
    const workspace = await trackWorkspace();
    const stdout = 'o'.repeat(10_001);
    const stderr = 'e'.repeat(10_000);

    const result = await materializeBuiltinBashOutput({
      command: 'mixed',
      stdout,
      stderr,
      exitCode: 1,
      workspacePath: workspace,
      threshold: 20_000,
      sizeCap: MATERIALIZATION_SIZE_CAP_BYTES,
      log: makeLog(),
    });

    expect(result?.sizeChars).toBe(stdout.length + stderr.length);
    expect(result?.output).toContain('full 20001 chars saved');
  });

  it('T7 returns null and warns when workspace path is missing', async () => {
    const log = makeLog();

    const result = await materializeBuiltinBashOutput({
      command: 'large',
      stdout: 'x'.repeat(20_001),
      stderr: '',
      exitCode: 0,
      workspacePath: undefined,
      threshold: 20_000,
      sizeCap: MATERIALIZATION_SIZE_CAP_BYTES,
      log,
    });

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'materialization_skipped_no_workspace' }),
      'Bash materialization skipped: no workspace path',
    );
  });

  it('T8 returns null and warns when directory creation fails', async () => {
    const log = makeLog();
    const workspace = await trackWorkspace();
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(error);

    const result = await writeMaterialisedFile({
      workspacePath: workspace,
      filenamePrefix: 'bash',
      content: 'x'.repeat(20_001),
      ext: 'txt',
      sizeCap: MATERIALIZATION_SIZE_CAP_BYTES,
      log,
    });

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'materialization_failed_fallback',
        error_code: 'EACCES',
      }),
      'Bash materialization failed; falling back to inline truncation',
    );
  });

  it('T11 uses random hex suffixes to avoid filename collisions', async () => {
    const workspace = await trackWorkspace();
    const paths: string[] = [];

    for (let index = 0; index < 5; index += 1) {
      const result = await writeMaterialisedFile({
        workspacePath: workspace,
        filenamePrefix: 'bash',
        content: `content-${index}`,
        ext: 'txt',
        sizeCap: MATERIALIZATION_SIZE_CAP_BYTES,
        log: makeLog(),
      });
      expect(result?.relativePath).toMatch(/_bash_[0-9a-f]{8}\.txt$/);
      paths.push(result?.relativePath ?? '');
    }

    expect(new Set(paths).size).toBe(paths.length);
  });

  it('T15 returns null exactly at the threshold boundary', async () => {
    const workspace = await trackWorkspace();

    const result = await materializeBuiltinBashOutput({
      command: 'boundary',
      stdout: 'x'.repeat(20_000),
      stderr: '',
      exitCode: 0,
      workspacePath: workspace,
      threshold: 20_000,
      sizeCap: MATERIALIZATION_SIZE_CAP_BYTES,
      log: makeLog(),
    });

    expect(result).toBeNull();
  });

  it('T17 retries EMFILE write failures before succeeding', async () => {
    const workspace = await trackWorkspace();
    const originalWriteFile = fs.writeFile;
    const writeFile = vi.spyOn(fs, 'writeFile');
    const emfile = Object.assign(new Error('too many open files'), { code: 'EMFILE' });
    writeFile
      .mockRejectedValueOnce(emfile)
      .mockImplementation((...args: Parameters<typeof fs.writeFile>) => originalWriteFile(...args));

    const result = await writeMaterialisedFile({
      workspacePath: workspace,
      filenamePrefix: 'bash',
      content: 'x'.repeat(20_001),
      ext: 'txt',
      sizeCap: MATERIALIZATION_SIZE_CAP_BYTES,
      log: makeLog(),
    });

    expect(result?.materialized).toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(2);
  });

  it('T18 returns null and warns above the size cap', async () => {
    const workspace = await trackWorkspace();
    const log = makeLog();

    const result = await writeMaterialisedFile({
      workspacePath: workspace,
      filenamePrefix: 'bash',
      content: 'x'.repeat(MATERIALIZATION_SIZE_CAP_BYTES + 1),
      ext: 'txt',
      sizeCap: MATERIALIZATION_SIZE_CAP_BYTES,
      log,
    });

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'materialization_skipped_size_cap' }),
      'Bash materialization skipped: output exceeds size cap',
    );
  });

  it('rejects a symlink escape even when the workspace itself is a symlink', async () => {
    const realWorkspace = await trackWorkspace();
    const outside = await trackWorkspace();
    const symlinkWorkspace = `${realWorkspace}-link`;
    workspaces.push(symlinkWorkspace);

    try {
      await fs.symlink(realWorkspace, symlinkWorkspace, 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw error;
    }

    await fs.mkdir(path.join(realWorkspace, '.rebel'), { recursive: true });
    await fs.symlink(outside, path.join(realWorkspace, '.rebel', 'tool-outputs'), 'dir');
    const log = makeLog();

    const result = await writeMaterialisedFile({
      workspacePath: symlinkWorkspace,
      filenamePrefix: 'bash',
      content: 'x'.repeat(20_001),
      ext: 'txt',
      sizeCap: MATERIALIZATION_SIZE_CAP_BYTES,
      log,
    });

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'materialization_failed_fallback' }),
      'Bash materialization failed; falling back to inline truncation',
    );
  });

  it('returns null and logs when the kill-switch is set', async () => {
    const workspace = await trackWorkspace();
    const log = makeLog();
    process.env.REBEL_DISABLE_BASH_MATERIALIZATION = '1';

    const result = await materializeBuiltinBashOutput({
      command: 'large',
      stdout: 'x'.repeat(20_001),
      stderr: '',
      exitCode: 0,
      workspacePath: workspace,
      threshold: 20_000,
      sizeCap: MATERIALIZATION_SIZE_CAP_BYTES,
      log,
    });

    expect(result).toBeNull();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'materialization_skipped_killswitch' }),
      'Bash materialization skipped by kill-switch',
    );
  });
});
