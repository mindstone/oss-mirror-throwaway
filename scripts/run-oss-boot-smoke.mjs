#!/usr/bin/env node
/**
 * run-oss-boot-smoke — the `npm run validate:oss-boot-smoke` entry point.
 *
 * One command, faithful target: builds the TRANSFORMED OSS MIRROR forge bundle
 * (scripts/build-oss-mirror-bundle.mjs) then launches it through the launch gate
 * (scripts/check-oss-boot-smoke.ts) to assert the main process boots past bootstrap with no
 * load-time boundary crash.
 *
 * The mirror bundle is the faithful public-build target (transform substitutions + dependency
 * stripping + `private/`→stub), NOT the `mv private`-detached canonical checkout. See
 * scripts/build-oss-mirror-bundle.mjs and docs/project/OSS_BUILD_SMOKE_RUNBOOK.md for why.
 *
 * USAGE
 *   npm run validate:oss-boot-smoke                       # build mirror bundle + launch
 *   npm run validate:oss-boot-smoke -- --main <path>      # skip build, launch an existing bundle
 *   npm run validate:oss-boot-smoke -- --force-deps       # rebuild workdir node_modules
 *   (any extra args after --main/--force-deps/--keep-build are forwarded to the launch gate,
 *    e.g. --timeout-ms / --min-alive-ms)
 *
 * Exit 0 = booted past bootstrap; non-zero = boot crash / build failure.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);

// If the caller supplies --main, honour it and skip the build entirely (manual / CI use where
// a bundle already exists). Otherwise build the mirror bundle first.
const mainIdx = argv.indexOf('--main');
let mainEntry = null;
let passthrough = [...argv];

if (mainIdx !== -1) {
  const raw = argv[mainIdx + 1];
  if (!raw) {
    console.error('[oss-boot-smoke] --main requires a path argument');
    process.exit(1);
  }
  // Resolve against the ORIGINAL cwd now — the gate runs with a different cwd below, so a
  // relative --main would otherwise be re-resolved against the wrong root.
  mainEntry = path.resolve(process.cwd(), raw);
} else {
  // Forward build-relevant flags to the builder; everything else goes to the launch gate.
  const buildFlags = passthrough.filter((a) => a === '--force-deps' || a === '--keep-build');
  passthrough = passthrough.filter((a) => a !== '--force-deps' && a !== '--keep-build');

  console.error('[oss-boot-smoke] building faithful OSS mirror bundle...');
  const build = spawnSync('node', [path.join(__dirname, 'build-oss-mirror-bundle.mjs'), ...buildFlags], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
  });
  if (build.status !== 0) {
    console.error(`[oss-boot-smoke] mirror build failed (exit ${build.status})`);
    process.exit(build.status ?? 1);
  }
  const stdout = build.stdout?.toString() ?? '';
  const match = stdout.split('\n').reverse().find((l) => l.startsWith('OSS_MIRROR_BUNDLE='));
  if (!match) {
    console.error('[oss-boot-smoke] could not parse OSS_MIRROR_BUNDLE=<path> from build output');
    console.error('--- build stdout ---\n' + stdout);
    process.exit(1);
  }
  mainEntry = match.slice('OSS_MIRROR_BUNDLE='.length).trim();
  console.error(`[oss-boot-smoke] built bundle: ${mainEntry}`);
}

// Launch the gate against the resolved bundle. Run from the BUNDLE's source root so the
// launch gate resolves node_modules/.bin/electron from the mirror workdir.
const bundleSourceRoot = path.dirname(path.dirname(path.dirname(mainEntry))); // <root>/.vite/build/bootstrap.js
const gateArgs = ['tsx', path.join(__dirname, 'check-oss-boot-smoke.ts'), '--main', mainEntry];
// Append any passthrough flags that aren't --main / its value.
for (let i = 0; i < passthrough.length; i++) {
  if (passthrough[i] === '--main') {
    i++; // skip --main and its value (already consumed)
    continue;
  }
  gateArgs.push(passthrough[i]);
}

console.error(`[oss-boot-smoke] launching gate from ${bundleSourceRoot}`);
const gate = spawnSync('npx', gateArgs, {
  cwd: bundleSourceRoot,
  stdio: 'inherit',
  env: process.env,
});
process.exit(gate.status ?? 1);
