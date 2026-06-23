import { describe, expect, it } from 'vitest';
import { findGitExecMaxbufferViolations } from '../check-git-exec-maxbuffer.js';

describe('findGitExecMaxbufferViolations', () => {
  it("flags raw execSync('git ...') string commands", () => {
    const violations = findGitExecMaxbufferViolations(`
      import { execSync } from 'node:child_process';
      const output = execSync('git status --short', { encoding: 'utf8' });
    `);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(3);
  });

  it('flags raw execSync template literal git commands', () => {
    const violations = findGitExecMaxbufferViolations(`
      import { execSync } from 'node:child_process';
      const output = execSync(\`git diff \${baseRef} --name-only\`);
    `);

    expect(violations).toHaveLength(1);
  });

  it("flags raw execFileSync('git', ...) array commands", () => {
    const violations = findGitExecMaxbufferViolations(`
      import { execFileSync } from 'node:child_process';
      const output = execFileSync('git', ['ls-files'], { encoding: 'utf8' });
    `);

    expect(violations).toHaveLength(1);
  });

  it("flags raw spawnSync('git', ...) array commands", () => {
    const violations = findGitExecMaxbufferViolations(`
      import { spawnSync } from 'node:child_process';
      const result = spawnSync('git', args, { encoding: 'utf8' });
    `);

    expect(violations).toHaveLength(1);
  });

  it('flags multiline raw spawnSync git commands', () => {
    const violations = findGitExecMaxbufferViolations(`
      import { spawnSync } from 'node:child_process';
      const result = spawnSync(
        'git',
        args,
        { encoding: 'utf8' },
      );
    `);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(3);
  });

  it('does not flag gitCapture helper calls', () => {
    const violations = findGitExecMaxbufferViolations(`
      import { gitCapture } from './lib/git-exec.js';
      const output = gitCapture(['ls-files'], { cwd });
    `);

    expect(violations).toHaveLength(0);
  });

  it('does not flag a valid same-line escape hatch', () => {
    const violations = findGitExecMaxbufferViolations(`
      import { execSync } from 'node:child_process';
      const output = execSync('git rev-parse HEAD'); // git-exec-allow: one bounded sha lookup
    `);

    expect(violations).toHaveLength(0);
  });

  it('does not flag a valid escape hatch immediately above the invocation', () => {
    const violations = findGitExecMaxbufferViolations(`
      import { execFileSync } from 'node:child_process';
      // git-exec-allow: one bounded config lookup
      const output = execFileSync('git', ['config', '--get', 'core.hooksPath']);
    `);

    expect(violations).toHaveLength(0);
  });

  it('still flags a weak-rationale escape hatch', () => {
    const violations = findGitExecMaxbufferViolations(`
      import { spawnSync } from 'node:child_process';
      // git-exec-allow: TODO migrate this later
      const result = spawnSync('git', args, { encoding: 'utf8' });
    `);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain('weak placeholder');
  });

  it('flags backtick-delimited git as the execFileSync program name', () => {
    // Asymmetry-closer: the string-form regex already caught backtick
    // `execSync(\`git ...\`)`; the array-form regex must also catch a backtick
    // program name. See guard regex DIRECT_ARRAY_GIT_CAPTURE_REGEX.
    const violations = findGitExecMaxbufferViolations(
      'const out = execFileSync(`git`, ["ls-files"]);',
    );

    expect(violations).toHaveLength(1);
  });

  // --- Documented scope boundary (intentional false-negatives) ---
  //
  // The guard is a regex SOURCE scan, not an AST data-flow rule. Git commands
  // assembled into a variable or run through a wrapper function are OUT OF
  // SCOPE by design — see the "Known limitation" header in
  // check-git-exec-maxbuffer.ts. Those patterns are kept safe a different way:
  // the wrapper (e.g. merge-integrity.ts `defaultGitRunner`,
  // generate-boundary-checklist.ts) centralizes DEFAULT_GIT_MAXBUFFER itself.
  // These tests pin that boundary so a future reader knows the misses are
  // deliberate, not bugs — and so a change that accidentally starts flagging
  // every dynamic exec (false-positive blowup) fails here.
  it('does NOT flag a git command assembled into a variable (out of scope)', () => {
    const violations = findGitExecMaxbufferViolations(`
      import { execSync } from 'node:child_process';
      const cmd = 'git ls-files --others --exclude-standard';
      const out = execSync(cmd, { encoding: 'utf8' });
    `);

    // Intentional miss: bound at the wrapper/call site instead.
    expect(violations).toHaveLength(0);
  });

  it('does NOT flag a wrapper that execs a command parameter (out of scope)', () => {
    const violations = findGitExecMaxbufferViolations(`
      import { execSync } from 'node:child_process';
      function gitRunner(command: string): string {
        return execSync(command, { encoding: 'utf8' }).trim();
      }
    `);

    // Intentional miss: gitRunner centralizes the maxBuffer policy itself.
    expect(violations).toHaveLength(0);
  });
});
