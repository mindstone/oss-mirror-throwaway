#!/usr/bin/env tsx
/**
 * Local mirror of the Cloud Service CI lane (.github/workflows/cloud-ci.yml).
 *
 * WHY: `cloud-ci` is NOT on the desktop beta's publish path (the cloud-service ships
 * separately via sftp/Fly), and it is not a per-PR-required gate — so it can rot red on
 * `dev` unnoticed (a "detector outage"). This wrapper lets the RELEASE_TO_BETA §5.1
 * pre-push de-risk and the DAILY_AUTOMATED_REVIEW cloud-lane check run that coverage
 * locally and fast.
 *
 * SPEED: the CI lane takes ~8.5 min end-to-end, but that is almost entirely cold `npm ci`
 * + runner start. The actual build+test compute is ~40-60s, so we run it locally with the
 * build-independent suites in PARALLEL.
 *
 * CORRECTNESS: exit codes are aggregated — a single red suite fails the whole command with
 * a non-zero exit and a named summary. It never reports green on a failed suite (no silent
 * success). Captured output is printed for failing suites only (a green run stays quiet).
 *
 * PREREQUISITES (same as any local test run): deps installed in repo root + cloud-service +
 * cloud-client, and the rebel-system submodule present (the cloud-service project's
 * promptBootstrapParity test resolves real rebel-system/prompts content).
 *
 * NOTE: tuned for a POSIX shell (the cloud-ci lane itself is ubuntu-only); it relies on
 * `/bin/sh` quoting semantics for the --exclude glob.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Result {
  label: string;
  code: number;
  ms: number;
  output: string;
  skipped?: boolean;
}

function run(
  label: string,
  cmd: string,
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<Result> {
  const start = Date.now();
  process.stdout.write(`▶  ${label}: started\n`);
  return new Promise((resolveP) => {
    const child = spawn(cmd, {
      cwd: opts.cwd ? resolve(repoRoot, opts.cwd) : repoRoot,
      env: { ...process.env, ...opts.env },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => {
      output += d.toString();
    });
    child.stderr.on('data', (d) => {
      output += d.toString();
    });
    child.on('close', (code) => {
      const ms = Date.now() - start;
      const ok = code === 0;
      process.stdout.write(
        `${ok ? '✓' : '✗'}  ${label}: ${ok ? 'passed' : `FAILED (exit ${code})`} in ${(ms / 1000).toFixed(1)}s\n`,
      );
      resolveP({ label, code: code ?? 1, ms, output });
    });
    child.on('error', (err) => {
      const ms = Date.now() - start;
      process.stdout.write(`✗  ${label}: spawn error: ${err.message}\n`);
      resolveP({ label, code: 1, ms, output: String(err) });
    });
  });
}

async function main(): Promise<void> {
  const overallStart = Date.now();
  process.stdout.write('Cloud-CI local mirror — running the .github/workflows/cloud-ci.yml lane locally\n\n');

  // Kick off the build and the three build-INDEPENDENT suites concurrently. Only the
  // cloud-client e2e suite depends on the built cloud-service bundle, so it waits on build.
  const buildP = run('build cloud-service', 'node cloud-service/build.mjs');
  const csP = run('cloud-service tests', 'npx vitest run --project=cloud-service');
  const policyP = run(
    'cloud policy tests',
    'npx vitest run --project=desktop src/shared/__tests__/cloudChannelPolicies src/shared/__tests__/cloudSettingsPolicy',
  );
  const ccUnitP = run('cloud-client unit tests', "npx vitest run --exclude '**/e2e.integration*'", {
    cwd: 'cloud-client',
  });

  const build = await buildP;
  let e2e: Result;
  if (build.code === 0) {
    e2e = await run('cloud-client e2e (mock)', 'npx vitest run src/__tests__/e2e.integration.test.ts', {
      cwd: 'cloud-client',
      env: { REBEL_MOCK_AGENT_TURNS: '1' },
    });
  } else {
    // Fail-closed: a skipped e2e on a broken build counts as a failure, never a silent pass.
    e2e = {
      label: 'cloud-client e2e (mock)',
      code: 1,
      ms: 0,
      output: 'SKIPPED — cloud-service build failed (e2e needs cloud-service/dist/server.mjs)',
      skipped: true,
    };
    process.stdout.write('✗  cloud-client e2e (mock): SKIPPED (build failed)\n');
  }

  const results: Result[] = [build, await csP, await policyP, await ccUnitP, e2e];
  const failed = results.filter((r) => r.code !== 0);

  for (const r of failed) {
    process.stdout.write(`\n===== ${r.label} output =====\n${r.output}\n`);
  }

  const totalS = ((Date.now() - overallStart) / 1000).toFixed(1);
  process.stdout.write(
    `\nCloud-CI local mirror: ${results.length - failed.length}/${results.length} suites passed in ${totalS}s\n`,
  );
  if (failed.length) {
    process.stdout.write(`FAILED: ${failed.map((r) => r.label).join(', ')}\n`);
    process.exit(1);
  }
  process.stdout.write('All cloud-ci suites green locally ✓\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
