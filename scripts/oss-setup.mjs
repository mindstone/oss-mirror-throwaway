#!/usr/bin/env node
// One-shot, cross-platform bootstrap that takes a fresh OSS clone to a runnable
// dev app. `npm run setup` wraps this.
//
// Why this exists: a fresh public-mirror clone has no single "get running"
// command — it needs submodule init + a root install + two separate builds, in
// the right order, and the path isn't written down anywhere. This script IS that
// path. It targets the `npm run dev` flow (packaged builds chain their own extra
// steps via `package`'s `prebuild`, which is already OSS-clean).
//
// The ordered steps (investigated — this is the minimum a fresh clone needs):
//   0. Prereq checks (Node >= 20, npm, git) — fail loud with a remedy, never auto-install.
//   1. `git submodule update --init --recursive` — pulls rebel-system + super-mcp
//      (the only two OSS submodules). Wrapped in a bounded network retry.
//   2. Scaffold .env.local from .env.example (mechanical; no secret prompts).
//   3. Root `npm ci` — delegated to ensureDepsFresh() so the install fingerprint
//      is memoized and `npm run dev` won't surprise-reinstall afterwards.
//   4. `npm run build:super-mcp` — builds the super-mcp router (its own npm ci + build).
//   5. `node scripts/build-bundled-mcps.mjs` — builds the bundled connectors in
//      resources/mcp/ -> resources/mcp-generated/ (needs root node_modules for esbuild).
//
// Design rules: zero prompts (AI-key entry lives in the app's onboarding, which
// validates better); no bash-isms (pure Node — runs the same on macOS, Windows,
// Linux); npm resolves to npm.cmd on Windows; every failure is loud and actionable.
//
// NOTE: `npm run dev` also depends on a separate fix to the `predev` hook (it
// currently references the mirror-stripped `mcp-servers` submodule). That fix is
// tracked independently; this script gets the clone to the state where dev works
// once predev is OSS-clean.

import { existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
// NOTE: ensure-deps-fresh.mjs is imported dynamically inside installRootDeps()
// (not at the top) so the Node-version prereq check runs and prints its friendly
// remedy first — before any module-graph parse that a very old Node might choke on.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const NPM = IS_WIN ? 'npm.cmd' : 'npm';

// ── tiny logging helpers (kept dependency-free) ──────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
};
let stepNo = 0;
const totalSteps = 6; // prereqs + submodules + .env.local + deps + super-mcp + bundled MCPs
function step(msg) {
  stepNo += 1;
  console.log(`\n${C.bold}${C.cyan}[${stepNo}/${totalSteps}] ${msg}${C.reset}`);
}
function info(msg) { console.log(`   ${msg}`); }
function ok(msg) { console.log(`   ${C.green}✓${C.reset} ${msg}`); }

// fail — print an actionable remedy (style cribbed from scripts/check-super-mcp.js)
// and exit non-zero. No silent failure, no auto-install.
function fail(title, remedyLines = []) {
  console.error(`\n${C.red}✖ ${title}${C.reset}`);
  for (const line of remedyLines) console.error(`   ${line}`);
  console.error('');
  process.exit(1);
}

// run — spawn a command synchronously with inherited stdio. On Windows, .cmd
// shims (npm.cmd) require a shell, so set shell:true there. Returns the result;
// the caller decides whether a non-zero exit is fatal.
function run(cmd, args, { label, timeoutMs } = {}) {
  if (label) info(`$ ${label}`);
  return spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: IS_WIN && cmd.endsWith('.cmd'),
    timeout: timeoutMs,
  });
}

// runWithRetry — bounded retry with linear backoff, for network-flaky steps
// (mirrors the net_retry intent in scripts/worktree-postinit.sh, in portable
// Node). spawnSync's `timeout` kills a wedged transfer so a stalled clone can't
// hang the bootstrap indefinitely.
function runWithRetry(cmd, args, { label, attempts = 3, timeoutMs }) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    info(`${C.dim}attempt ${attempt}/${attempts}${C.reset}`);
    last = run(cmd, args, { label, timeoutMs });
    if (!last.error && last.status === 0) return last;
    const reason = last.error
      ? (last.error.code === 'ETIMEDOUT' ? 'timed out' : last.error.message)
      : `exited with code ${last.status}`;
    console.error(`   ${C.yellow}attempt ${attempt} failed (${reason})${C.reset}`);
    if (attempt < attempts) {
      const waitMs = attempt * 3000;
      // Busy-free backoff via a blocking child (no extra deps, portable).
      spawnSync(process.execPath, ['-e', `setTimeout(()=>{}, ${waitMs})`], { stdio: 'ignore' });
    }
  }
  return last;
}

// commandWorks — probe that a tool is on PATH and runnable.
function commandWorks(cmd, args = ['--version']) {
  const r = spawnSync(cmd, args, { stdio: 'ignore', shell: IS_WIN && cmd.endsWith('.cmd') });
  return !r.error && r.status === 0;
}

// ── Step 0: prerequisite checks (fail loud, no auto-install) ─────────────────
function checkPrereqs() {
  step('Checking prerequisites');

  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isNaN(major) || major < 20) {
    fail(`Node.js ${process.versions.node} is too old — Rebel needs Node 20 or newer.`, [
      'Install a current Node LTS, then re-run `npm run setup`:',
      `  ${C.cyan}https://nodejs.org/${C.reset}  (or use nvm / fnm / volta)`,
    ]);
  }
  ok(`Node ${process.versions.node}`);

  if (!commandWorks(NPM)) {
    fail('npm was not found on your PATH.', [
      'npm ships with Node.js — reinstall Node from https://nodejs.org/',
      'and make sure `npm --version` works in a fresh terminal.',
    ]);
  }
  ok('npm');

  if (!commandWorks('git')) {
    fail('git was not found on your PATH.', [
      'Install git, then re-run `npm run setup`:',
      `  ${C.cyan}https://git-scm.com/downloads${C.reset}`,
    ]);
  }
  ok('git');

  // Submodule init needs a real git checkout (a downloaded tarball/zip won't work).
  // git-exec-allow: exit-status-only probe (stdio:'ignore', no output capture → no maxBuffer risk); this bootstrap script deliberately avoids importing the repo's TS git-exec tooling so it runs on a bare fresh clone.
  const inGitRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: REPO_ROOT, stdio: 'ignore',
  });
  if (inGitRepo.status !== 0) {
    fail('This does not look like a git clone.', [
      'Rebel uses git submodules, so it must be cloned (not downloaded as a zip):',
      `  ${C.cyan}git clone --recurse-submodules <repo-url>${C.reset}`,
    ]);
  }
  ok('git checkout');
}

// ── Step 1: submodules ───────────────────────────────────────────────────────
function initSubmodules() {
  step('Initialising submodules (rebel-system, super-mcp)');
  const r = runWithRetry('git', ['submodule', 'update', '--init', '--recursive'], {
    label: 'git submodule update --init --recursive',
    attempts: 3,
    timeoutMs: 300_000,
  });
  if (r.error || r.status !== 0) {
    fail('Could not initialise git submodules after 3 attempts.', [
      'This is usually a network hiccup or a missing clone. Check your connection and try:',
      `  ${C.cyan}git submodule update --init --recursive${C.reset}`,
      'then re-run `npm run setup`.',
    ]);
  }
  ok('Submodules initialised');
}

// ── Step 2: .env.local scaffold ───────────────────────────────────────────────
function scaffoldEnvLocal() {
  step('Setting up .env.local');
  const envLocal = join(REPO_ROOT, '.env.local');
  const envExample = join(REPO_ROOT, '.env.example');
  if (existsSync(envLocal)) {
    ok('.env.local already exists — left untouched');
    return;
  }
  if (!existsSync(envExample)) {
    // .env.example is tracked and always present in a clean checkout. Missing it
    // signals an incomplete clone, but it's not fatal for dev (settings live in
    // the app UI), so warn loudly rather than abort.
    info(`${C.yellow}⚠ .env.example not found — your checkout may be incomplete. Skipping .env.local.${C.reset}`);
    return;
  }
  copyFileSync(envExample, envLocal);
  ok('.env.local created from .env.example (defaults are fine; no secrets required)');
}

// ── Step 3: root dependencies ─────────────────────────────────────────────────
async function installRootDeps() {
  step('Installing dependencies (npm ci)');
  // ensureDepsFresh() runs `npm ci` when node_modules is absent or stale, then
  // memoizes the install fingerprint so `npm run dev` won't reinstall. It calls
  // process.exit on failure (fail-loud), which is exactly what we want here.
  const { ensureDepsFresh } = await import('./ensure-deps-fresh.mjs');
  ensureDepsFresh(REPO_ROOT);

  // ensureDepsFresh is a dev-hook freshness helper with skip escape hatches: it
  // returns WITHOUT installing when CI or REBEL_SKIP_DEPS_FRESH=1 is set. Setup is
  // a mandatory bootstrap, so a silent skip would leave node_modules absent and
  // make step 5 (esbuild bundling) fail with a confusing error. Verify the install
  // actually happened and fail loud here instead.
  const nodeModules = join(REPO_ROOT, 'node_modules');
  const esbuild = join(nodeModules, 'esbuild');
  if (!existsSync(nodeModules) || !existsSync(esbuild)) {
    fail('Dependencies were not installed.', [
      'Setup found no root node_modules. This happens when CI=1 or',
      'REBEL_SKIP_DEPS_FRESH=1 is set (both make the install step skip).',
      'Unset them and install manually, then re-run `npm run setup`:',
      `  ${C.cyan}npm ci${C.reset}`,
    ]);
  }
  ok('Root dependencies installed');
}

// ── Step 4: super-mcp ──────────────────────────────────────────────────────────
function buildSuperMcp() {
  step('Building super-mcp router');
  const r = run(NPM, ['run', 'build:super-mcp'], { label: 'npm run build:super-mcp' });
  if (r.error || r.status !== 0) {
    fail('Failed to build super-mcp.', [
      'Re-run it directly to see the full output:',
      `  ${C.cyan}npm run build:super-mcp${C.reset}`,
      'Make sure the super-mcp submodule checked out (step 1) and your network is up.',
    ]);
  }
  ok('super-mcp built');
}

// ── Step 5: bundled MCP connectors ─────────────────────────────────────────────
function buildBundledMcps() {
  step('Building bundled MCP connectors');
  const r = run(process.execPath, ['scripts/build-bundled-mcps.mjs'], {
    label: 'node scripts/build-bundled-mcps.mjs',
  });
  if (r.error || r.status !== 0) {
    fail('Failed to build the bundled MCP connectors.', [
      'Re-run it directly to see the full output:',
      `  ${C.cyan}node scripts/build-bundled-mcps.mjs${C.reset}`,
    ]);
  }
  ok('Bundled connectors built');
}

// ── Epilogue ──────────────────────────────────────────────────────────────────
function printNextSteps() {
  console.log(`\n${C.bold}${C.green}✓ Setup complete.${C.reset}\n`);
  console.log(`${C.bold}Next steps${C.reset}`);
  console.log(`  1. Start the app in development mode:`);
  console.log(`       ${C.cyan}npm run dev${C.reset}`);
  console.log(`  2. When it opens, go to ${C.bold}Settings → Agents${C.reset} and add your AI key`);
  console.log(`     (Anthropic, OpenRouter, or ChatGPT) — at least one is enough to start.`);
  console.log(`  3. Pick a workspace folder so Rebel has somewhere to work.`);
  console.log('');
  console.log(`${C.dim}Rebel ships with no keys of its own — you bring your own. Full open-build`);
  console.log(`guide: rebel-system/help-for-humans/fair-source-and-open-source-build.md${C.reset}`);
  console.log('');
}

async function main() {
  console.log(`${C.bold}Mindstone Rebel — open-source setup${C.reset}`);
  checkPrereqs();
  initSubmodules();
  scaffoldEnvLocal();
  await installRootDeps();
  buildSuperMcp();
  buildBundledMcps();
  printNextSteps();
}

main().catch((err) => {
  fail('Setup failed unexpectedly.', [String(err && err.stack ? err.stack : err)]);
});
