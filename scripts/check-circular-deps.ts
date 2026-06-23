#!/usr/bin/env tsx
/**
 * Checks for circular dependencies using Madge.
 *
 * - Renderer: enforced at zero (fails if any cycles found)
 * - Main: enforced at zero (fails if any cycles found)
 *
 * The two madge invocations are independent (different tsconfigs, different
 * source trees) and run in parallel via Promise.allSettled. We use allSettled
 * (not Promise.all) so a failure on one side does NOT short-circuit the other —
 * matches the "collect all failures" intent of a validator and prevents masking
 * a regression in one project by an earlier failure in the other.
 *
 * Usage: npx tsx scripts/check-circular-deps.ts
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const MAIN_CYCLE_BASELINE = 0;

async function runMadge(
  label: string,
  tsconfig: string,
  dir: string,
  exclude?: string,
): Promise<string[][]> {
  const args = [
    'madge',
    '--circular',
    '--ts-config',
    tsconfig,
    '--extensions',
    'ts,tsx',
    dir,
  ];
  if (exclude) {
    args.push('--exclude', exclude);
  }
  args.push('--json', '--no-spinner');
  try {
    const { stdout } = await execFileAsync('npx', args, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(stdout) as string[][];
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string };
    if (execErr.stdout) {
      try {
        return JSON.parse(execErr.stdout) as string[][];
      } catch {
        console.error(`Madge produced non-JSON output for ${label} (${dir}):`);
        console.error(execErr.stdout);
        if (execErr.stderr) console.error(execErr.stderr);
        throw new Error(`madge non-JSON output for ${label}`);
      }
    }
    throw err;
  }
}

async function main(): Promise<void> {
  console.log('Checking circular dependencies (renderer + main, in parallel)...');

  // Renderer: must be zero.
  // We exclude cloud-client internals — any cycle WITHIN @rebel/cloud-client is
  // pre-existing and owned by that package's own test suite (cd cloud-client && npm test).
  // A cycle INTRODUCED by the renderer (src/renderer/... → src/renderer/...) still
  // surfaces here because madge's entry point is `src/renderer`.
  const [rendererResult, mainResult] = await Promise.allSettled([
    runMadge('renderer', 'tsconfig.renderer.json', 'src/renderer', 'cloud-client/src'),
    runMadge('main', 'tsconfig.node.json', 'src/main'),
  ]);

  let failed = false;

  if (rendererResult.status === 'rejected') {
    console.error('\u2718 Renderer madge invocation failed:');
    console.error(rendererResult.reason);
    failed = true;
  } else {
    const rendererCycles = rendererResult.value;
    if (rendererCycles.length > 0) {
      console.error(`\u2718 Renderer has ${rendererCycles.length} circular dependencies (expected 0):`);
      for (const cycle of rendererCycles) {
        console.error(`  ${cycle.join(' \u2192 ')}`);
      }
      failed = true;
    } else {
      console.log('\u2714 Renderer: 0 circular dependencies');
    }
  }

  if (mainResult.status === 'rejected') {
    console.error('\u2718 Main madge invocation failed:');
    console.error(mainResult.reason);
    failed = true;
  } else {
    const mainCycles = mainResult.value;
    if (mainCycles.length > MAIN_CYCLE_BASELINE) {
      console.error(
        `\u2718 Main has ${mainCycles.length} circular dependencies (expected ${MAIN_CYCLE_BASELINE}). ` +
        `Fix before committing.`,
      );
      for (const cycle of mainCycles) {
        console.error(`  ${cycle.join(' \u2192 ')}`);
      }
      failed = true;
    } else {
      console.log(`\u2714 Main: ${mainCycles.length} circular dependencies`);
    }
  }

  if (failed) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('Unexpected error in check-circular-deps:', err);
  process.exit(1);
});
