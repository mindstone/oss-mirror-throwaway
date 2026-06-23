import { describe, it, expect } from 'vitest';
import { runProbe } from '../processProbe';

describe('processProbe', () => {
  it('returns exitCode 0 with stdout for a successful command', async () => {
    const result = await runProbe('node', ['-e', 'process.stdout.write("hello")']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello');
    expect(result.stderr).toBe('');
  });

  it('returns non-zero exitCode without rejecting', async () => {
    const result = await runProbe('node', ['-e', 'process.exit(42)']);
    expect(result.exitCode).toBe(42);
  });

  it('captures stderr from non-zero exit', async () => {
    const result = await runProbe('node', [
      '-e',
      'process.stderr.write("oops"); process.exit(1)',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('oops');
  });

  it('throws on ENOENT (command not found)', async () => {
    await expect(
      runProbe('__nonexistent_binary_abc123__', []),
    ).rejects.toThrow();
  });

  it('throws on timeout', async () => {
    await expect(
      runProbe('node', ['-e', 'setTimeout(() => {}, 60000)'], { timeout: 100 }),
    ).rejects.toThrow();
  });

  it('merges env with process.env', async () => {
    const result = await runProbe('node', [
      '-e',
      'process.stdout.write(process.env.PROBE_TEST_VAR || "missing")',
    ], { env: { PROBE_TEST_VAR: 'present' } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('present');
  });

  it('preserves process.env when custom env is provided', async () => {
    const result = await runProbe('node', [
      '-e',
      'process.stdout.write(process.env.HOME ? "has-home" : "no-home")',
    ], { env: { PROBE_TEST_VAR: 'x' } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('has-home');
  });
});
