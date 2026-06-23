#!/usr/bin/env node
/**
 * Post-build assertion: the Sentry DSN must be baked into BOTH built bundles
 * (main process AND renderer) of a commercial release build.
 *
 * Why: the OSS content scrub (2888e33ae) removed the hardcoded DSN and made it
 * env-driven (`VITE_SENTRY_DSN` inlined by Vite at build time). The 2026-06
 * beta shipped telemetry-dead because no workflow injected the env var — bug
 * reports failed silently in the field. This guard kills that class: a release
 * build without the DSN fails loudly at build time.
 * See docs/project/ERROR_MONITORING_AND_SENTRY.md.
 *
 * Usage: node scripts/check-built-bundle-sentry-dsn.mjs [rootDir]
 *   rootDir defaults to cwd; the script asserts the marker appears in at least
 *   one file under `<rootDir>/.vite/build/` AND at least one file under
 *   `<rootDir>/.vite/renderer/main_window/`.
 *
 * IMPORTANT: searches recursively across ALL files in those dirs —
 * `.vite/build/bootstrap.js` is a ~265-byte entry shim; the real code lives in
 * hashed chunks (e.g. bootstrap-<hash>.js). Spike-verified 2026-06-10.
 *
 * Escape hatch (OSS / telemetry-free builds, NOT used by release.yml):
 *   REBEL_SKIP_SENTRY_BUNDLE_CHECK=1 skips the check with a notice.
 *
 * No dependencies — plain node (>=16).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Host fragment of the Mindstone Sentry ingest endpoint. The DSN itself is a
// public identifier, but we keep the full literal out of repo text (OSS
// mirror hygiene) — the host fragment is enough to assert it was inlined.
const MARKER = 'ingest.us.sentry.io';

if (process.env.REBEL_SKIP_SENTRY_BUNDLE_CHECK === '1') {
  console.log(
    '[check-built-bundle-sentry-dsn] SKIPPED via REBEL_SKIP_SENTRY_BUNDLE_CHECK=1 (telemetry-free build).'
  );
  process.exit(0);
}

const rootDir = path.resolve(process.argv[2] ?? process.cwd());

const targets = [
  {
    label: 'main-process bundle',
    dir: path.join(rootDir, '.vite', 'build'),
  },
  {
    label: 'renderer bundle',
    dir: path.join(rootDir, '.vite', 'renderer', 'main_window'),
  },
];

/** Recursively list all regular files under dir. */
const listFiles = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
};

let failed = false;

for (const { label, dir } of targets) {
  if (!existsSync(dir)) {
    console.error(
      `::error::[check-built-bundle-sentry-dsn] ${label} directory not found: ${dir} — did the Forge build run?`
    );
    failed = true;
    continue;
  }

  const files = listFiles(dir);
  const hit = files.find((file) => {
    try {
      return readFileSync(file, 'utf8').includes(MARKER);
    } catch {
      return false;
    }
  });

  if (hit) {
    console.log(
      `[check-built-bundle-sentry-dsn] OK — ${label}: "${MARKER}" found in ${path.relative(rootDir, hit)}`
    );
  } else {
    console.error(
      `::error::[check-built-bundle-sentry-dsn] ${label} is missing the Sentry DSN: no file under ${path.relative(rootDir, dir)} (${files.length} files scanned) contains "${MARKER}". Commercial builds must ship with Sentry telemetry — was VITE_SENTRY_DSN set on the Forge build step? See docs/project/ERROR_MONITORING_AND_SENTRY.md.`
    );
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

console.log('[check-built-bundle-sentry-dsn] All bundles contain the Sentry DSN.');
