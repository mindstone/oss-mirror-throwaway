#!/usr/bin/env npx tsx
/**
 * Validates that git's core.hooksPath points to .husky/_ (Husky v9 default).
 *
 * Husky's CLI treats any argument as a target directory, so running
 * `npx husky --version` accidentally creates a `--version/` directory and
 * sets core.hooksPath to `--version/_` — silently disabling all git hooks
 * (pre-commit merge guard, pre-push validation).
 *
 * Run via: npx tsx scripts/check-husky-hooks-path.ts
 * Part of validate:fast pipeline.
 */
import { execFileSync } from 'child_process';

function main(): void {
  console.log('🪝 Husky Hooks Path Check');
  console.log('=========================\n');

  let hooksPath: string;
  try {
    // git-exec-allow: small config lookup preserves existing hooks-path failure handling
    hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      encoding: 'utf-8',
    }).trim();
  } catch (err: unknown) {
    const code = (err as { status?: number }).status;
    if (code === 1) {
      // Exit code 1 = key not set. This is a misconfiguration since
      // `npm ci` runs the `prepare` script which initializes husky.
      console.error('❌ core.hooksPath is not set.');
      console.error('');
      console.error('   Fix: npm run prepare');
      console.error('');
      process.exit(1);
    }
    // Any other failure (git not installed, not a repo, etc.)
    console.error('❌ Failed to read core.hooksPath from git config.');
    console.error(`   ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  if (hooksPath === '.husky/_') {
    console.log('✅ core.hooksPath = .husky/_ (correct)\n');
    return;
  }

  console.error(`❌ core.hooksPath is '${hooksPath}' (expected '.husky/_')`);
  console.error('');
  console.error('   This means git hooks (pre-commit merge guard, pre-push validation)');
  console.error('   are silently NOT running.');
  console.error('');
  console.error('   Fix: git config core.hooksPath .husky/_');
  console.error('   Or:  npm run prepare');
  console.error('');
  process.exit(1);
}

main();
