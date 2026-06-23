#!/usr/bin/env node
/**
 * Post-build assertion for meeting-bot backend config delivery.
 *
 * Commercial desktop builds must have the private Worker host and the
 * build-time auth key baked into the main-process bundle. OSS builds must have
 * neither the private Worker host nor a contextual meeting-bot key-shaped
 * literal. The key value is never printed.
 *
 * Usage:
 *   node scripts/check-built-bundle-meeting-bot-config.mjs [rootDir] [commercial|oss]
 *   node scripts/check-built-bundle-meeting-bot-config.mjs [commercial|oss]
 *
 * rootDir defaults to cwd. mode defaults to `commercial`, matching release.yml.
 *
 * Escape hatch (temporary transition before the release secret is installed):
 *   REBEL_SKIP_MEETING_BOT_CONFIG_CHECK=1 skips the check with a notice.
 *
 * No dependencies — plain node (>=16).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const CHECK_NAME = 'check-built-bundle-meeting-bot-config';
const HOST_FRAGMENT = ['mindstone-learning', 'workers', 'dev'].join('.');
const MODES = new Set(['commercial', 'oss']);

const normalizeValue = (value) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const EXPECTED_AUTH_KEY = normalizeValue(
  process.env.MAIN_VITE_MEETING_BOT_BACKEND_AUTH_KEY ??
    process.env.MEETING_BOT_BACKEND_AUTH_KEY,
);

// Broad only for commercial fallback when the exact key is not available to
// the check step. OSS uses the contextual regex below to avoid false positives
// from unrelated base64 literals in dependencies.
const BASE64_KEY_LITERAL_RE = /["'`]([A-Za-z0-9+/]{40,}={0,2})["'`]/g;
const CONTEXTUAL_MEETING_BOT_KEY_LITERAL_RE =
  /(?:MEETING_BOT_BACKEND_AUTH_KEY|BACKEND_AUTH_KEY|MINDSTONE_AUTH_SECRET|meetingBotBackendAuthKey|authKey)\W{0,160}["'`]([A-Za-z0-9+/]{40,}={0,2})["'`]/g;

if (process.env.REBEL_SKIP_MEETING_BOT_CONFIG_CHECK === '1') {
  console.log(
    `[${CHECK_NAME}] SKIPPED via REBEL_SKIP_MEETING_BOT_CONFIG_CHECK=1 (temporary meeting-bot-config transition).`,
  );
  process.exit(0);
}

const args = process.argv.slice(2);
let rootDir = process.cwd();
let mode = process.env.REBEL_MEETING_BOT_CONFIG_BUNDLE_MODE ?? 'commercial';

if (args[0]) {
  if (MODES.has(args[0])) {
    mode = args[0];
  } else {
    rootDir = args[0];
    if (args[1]) {
      mode = args[1];
    }
  }
}

if (!MODES.has(mode)) {
  console.error(
    `::error::[${CHECK_NAME}] Unknown mode "${mode}". Expected "commercial" or "oss".`,
  );
  process.exit(1);
}

rootDir = path.resolve(rootDir);

const mainBundleDirs = [
  path.join(rootDir, '.vite', 'build'),
  path.join(rootDir, 'out', 'main'),
].filter((dir) => existsSync(dir));

const rendererBundleDirs = [
  path.join(rootDir, '.vite', 'renderer'),
  path.join(rootDir, 'out', 'renderer'),
].filter((dir) => existsSync(dir));

if (mainBundleDirs.length === 0) {
  console.error(
    `::error::[${CHECK_NAME}] No main-process bundle directory found. Looked for .vite/build and out/main under ${rootDir}. Did the build run?`,
  );
  process.exit(1);
}

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

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

const mainFiles = mainBundleDirs.flatMap(listFiles);
const rendererFiles = rendererBundleDirs.flatMap(listFiles);

const findHit = (filesToSearch, predicate) => {
  for (const file of filesToSearch) {
    const content = readText(file);
    const result = predicate(content, file);
    if (result) {
      return { file, result };
    }
  }
  return null;
};

const relative = (file) => path.relative(rootDir, file);

const isPlausibleBase64Key = (value) =>
  value.length >= 40 &&
  value.length <= 256 &&
  value.length % 4 === 0 &&
  /^[A-Za-z0-9+/]+={0,2}$/.test(value);

const findBase64KeyLiteral = (content, regex) => {
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const value = match[1];
    if (isPlausibleBase64Key(value)) {
      return true;
    }
  }
  return false;
};

const assertExpectedKeyAbsentFromRenderer = () => {
  if (!EXPECTED_AUTH_KEY) {
    console.log(
      `[${CHECK_NAME}] Renderer exact-key absence check skipped; no expected auth key was provided.`,
    );
    return;
  }

  if (rendererBundleDirs.length === 0) {
    console.log(
      `[${CHECK_NAME}] Renderer exact-key absence check skipped; no renderer bundle directory found.`,
    );
    return;
  }

  const rendererKeyHit = findHit(rendererFiles, (content) =>
    content.includes(EXPECTED_AUTH_KEY),
  );
  if (rendererKeyHit) {
    console.error(
      `::error::[${CHECK_NAME}] renderer bundle contains the injected meeting-bot auth key in ${relative(rendererKeyHit.file)} (${EXPECTED_AUTH_KEY.length} characters; value redacted). The key must remain main-bundle-only.`,
    );
    process.exit(1);
  }

  console.log(
    `[${CHECK_NAME}] OK — renderer bundle does not contain the injected meeting-bot auth key (${rendererFiles.length} files scanned; value redacted).`,
  );
};

if (mode === 'commercial') {
  const hostHit = findHit(mainFiles, (content) => content.includes(HOST_FRAGMENT));
  if (!hostHit) {
    console.error(
      `::error::[${CHECK_NAME}] commercial main bundle is missing the meeting-bot Worker host marker. Was the private provider bundled?`,
    );
    process.exit(1);
  }

  let keyHit;
  if (EXPECTED_AUTH_KEY) {
    keyHit = findHit(mainFiles, (content) => content.includes(EXPECTED_AUTH_KEY));
    if (!keyHit) {
      console.error(
        `::error::[${CHECK_NAME}] commercial main bundle is missing the injected meeting-bot auth key (${EXPECTED_AUTH_KEY.length} characters; value redacted). Was MAIN_VITE_MEETING_BOT_BACKEND_AUTH_KEY set on the Forge build step?`,
      );
      process.exit(1);
    }
  } else {
    keyHit = findHit(mainFiles, (content) =>
      content.includes(HOST_FRAGMENT) && findBase64KeyLiteral(content, BASE64_KEY_LITERAL_RE),
    );
    if (!keyHit) {
      console.error(
        `::error::[${CHECK_NAME}] commercial main bundle contains the meeting-bot Worker host but no key-shaped literal near that provider. Pass MAIN_VITE_MEETING_BOT_BACKEND_AUTH_KEY to make this assertion exact.`,
      );
      process.exit(1);
    }
  }

  assertExpectedKeyAbsentFromRenderer();

  console.log(
    `[${CHECK_NAME}] OK — commercial main bundle contains meeting-bot Worker host in ${relative(hostHit.file)} and an inlined auth key marker in ${relative(keyHit.file)} (value redacted).`,
  );
  process.exit(0);
}

assertExpectedKeyAbsentFromRenderer();

const hostHit = findHit(mainFiles, (content) => content.includes(HOST_FRAGMENT));
if (hostHit) {
  console.error(
    `::error::[${CHECK_NAME}] OSS main bundle contains the private meeting-bot Worker host marker in ${relative(hostHit.file)}.`,
  );
  process.exit(1);
}

const keyHit = findHit(mainFiles, (content) =>
  findBase64KeyLiteral(content, CONTEXTUAL_MEETING_BOT_KEY_LITERAL_RE),
);
if (keyHit) {
  console.error(
    `::error::[${CHECK_NAME}] OSS main bundle contains a contextual meeting-bot key-shaped literal in ${relative(keyHit.file)} (value redacted).`,
  );
  process.exit(1);
}

console.log(
  `[${CHECK_NAME}] OK — OSS main bundle contains no private meeting-bot Worker host or contextual key-shaped literal (${mainFiles.length} files scanned).`,
);
