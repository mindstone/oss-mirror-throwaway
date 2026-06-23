#!/usr/bin/env npx tsx
/**
 * Fails when the checked-out super-mcp submodule commit is not the commit the
 * superproject records for the super-mcp gitlink.
 *
 * This is intentionally fast and offline: it only asks git for the gitlink SHA
 * and the nested checkout HEAD. It does not fetch, build, or inspect source.
 */
import { spawnSync } from 'node:child_process';

const SUBMODULE_PATH = 'super-mcp';
const SHA_RE = /^[0-9a-f]{40}$/;

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface RecordedPointer {
  readonly sha: string;
  readonly source: string;
}

function runGit(args: readonly string[]): CommandResult {
  // Strip inherited GIT_* env vars. Inside a git hook (e.g. pre-push) git sets
  // GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE/GIT_COMMON_DIR for the SUPERPROJECT;
  // those would override `git -C super-mcp ...` so it resolves the superproject
  // repo instead of the submodule, producing a false mismatch. Sanitising makes
  // the check behave identically inside and outside hooks.
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_PREFIX;
  // git-exec-allow: sanitized git runner preserves status and stderr for parity checks
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function die(message: string): never {
  console.error(`[check-super-mcp-gitsha-parity] ERROR: ${message}`);
  process.exit(1);
}

function normalizeSha(label: string, value: string): string {
  const sha = value.trim();
  if (!SHA_RE.test(sha)) {
    die(`${label} did not resolve to a 40-character git SHA: ${JSON.stringify(value.trim())}`);
  }
  return sha;
}

function readRecordedPointer(): RecordedPointer {
  const indexResult = runGit(['rev-parse', `:${SUBMODULE_PATH}`]);
  if (indexResult.status === 0) {
    return {
      sha: normalizeSha('superproject index gitlink', indexResult.stdout),
      source: `git rev-parse :${SUBMODULE_PATH}`,
    };
  }

  const treeResult = runGit(['ls-tree', 'HEAD', SUBMODULE_PATH]);
  if (treeResult.status !== 0 || treeResult.stdout.trim().length === 0) {
    die(
      `unable to read superproject gitlink for ${SUBMODULE_PATH}. ` +
      `rev-parse stderr: ${indexResult.stderr.trim() || '<empty>'}; ` +
      `ls-tree stderr: ${treeResult.stderr.trim() || '<empty>'}`,
    );
  }

  const [mode, type, sha] = treeResult.stdout.trim().split(/\s+/);
  if (mode !== '160000' || type !== 'commit') {
    die(`${SUBMODULE_PATH} is not recorded as a git submodule in HEAD: ${treeResult.stdout.trim()}`);
  }

  return {
    sha: normalizeSha('superproject HEAD gitlink', sha ?? ''),
    source: `git ls-tree HEAD ${SUBMODULE_PATH}`,
  };
}

function readCheckedOutHead(): string {
  const result = runGit(['-C', SUBMODULE_PATH, 'rev-parse', 'HEAD']);
  if (result.status !== 0) {
    die(
      `unable to read checked-out ${SUBMODULE_PATH} HEAD. ` +
      `Run: git submodule update --init ${SUBMODULE_PATH}. ` +
      `stderr: ${result.stderr.trim() || '<empty>'}`,
    );
  }
  return normalizeSha(`${SUBMODULE_PATH} checkout HEAD`, result.stdout);
}

function main(): void {
  const recorded = readRecordedPointer();
  const checkedOutHead = readCheckedOutHead();

  if (recorded.sha !== checkedOutHead) {
    console.error('[check-super-mcp-gitsha-parity] super-mcp gitSha mismatch');
    console.error(`  recorded (${recorded.source}): ${recorded.sha}`);
    console.error(`  checked out (git -C ${SUBMODULE_PATH} rev-parse HEAD): ${checkedOutHead}`);
    console.error(`  fix: git submodule update --init ${SUBMODULE_PATH}`);
    process.exit(1);
  }

  console.log(
    `[check-super-mcp-gitsha-parity] OK ${SUBMODULE_PATH} ${checkedOutHead} matches ${recorded.source}`,
  );
}

main();
