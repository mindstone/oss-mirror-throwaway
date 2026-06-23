#!/usr/bin/env node
/**
 * Conditional prompt-registry contract gate.
 *
 * Runs the focused PROMPT_REGISTRY ↔ rebel-system prompt-frontmatter test when
 * this branch touches prompt files, the host prompt registry/service, or the
 * rebel-system submodule pointer. Pointer changes are inspected inside the
 * submodule when possible, and conservatively run the gate when the range
 * cannot be inspected locally.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitCapture } from './lib/git-exec.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const submodulePath = path.join(repoRoot, 'rebel-system');
const contractTestPath = 'src/core/services/__tests__/promptFileService.registryContract.test.ts';

const HOST_CONTRACT_PATHS = new Set([
  'src/core/services/promptFileService.ts',
  contractTestPath,
]);

function git(args: readonly string[], cwd = repoRoot): string {
  return gitCapture([...args], { cwd });
}

function gitOrNull(args: readonly string[], cwd = repoRoot): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

function lines(output: string | null): string[] {
  return (output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/\\/g, '/'));
}

function resolveDiffRefSpec(): string | null {
  const githubBaseRef = process.env.GITHUB_BASE_REF?.trim();
  if (githubBaseRef) {
    return `origin/${githubBaseRef}...HEAD`;
  }

  const beforeSha = process.env.GITHUB_EVENT_BEFORE?.trim();
  if (beforeSha && !/^0+$/.test(beforeSha)) {
    return `${beforeSha}...HEAD`;
  }

  const mergeBase = gitOrNull(['merge-base', 'origin/dev', 'HEAD'])?.trim();
  if (mergeBase) {
    return `${mergeBase}...HEAD`;
  }

  if (gitOrNull(['rev-parse', '--verify', 'HEAD~1']) !== null) {
    return 'HEAD~1...HEAD';
  }

  return null;
}

function changedTopLevelPaths(refSpec: string | null): string[] | null {
  const localPaths = [
    ...lines(gitOrNull(['diff', '--name-only'])),
    ...lines(gitOrNull(['diff', '--cached', '--name-only'])),
    ...lines(gitOrNull(['ls-files', '--others', '--exclude-standard'])),
  ];

  if (refSpec === null) {
    return localPaths.length > 0 ? [...new Set(localPaths)] : null;
  }

  // The ref resolved syntactically but the diff itself failed (e.g. a shallow/CI
  // checkout where the base ref's objects aren't present). That is exactly when
  // we must fail CLOSED: signal "can't determine" (null) so shouldRunContractTest
  // runs the gate rather than silently skipping on a swallowed git error.
  const refDiff = gitOrNull(['diff', '--name-only', refSpec]);
  if (refDiff === null) {
    return null;
  }

  return [...new Set([
    ...lines(refDiff),
    ...localPaths,
  ])];
}

function changedSubmodulePromptPaths(refSpec: string): string[] | null {
  const rawDiff = gitOrNull(['diff', '--raw', refSpec, '--', 'rebel-system']);
  const rawLines = lines(rawDiff);
  if (rawLines.length === 0) return [];

  const promptChanges: string[] = [];
  for (const rawLine of rawLines) {
    const [metadata, changedPath] = rawLine.split('\t');
    if (changedPath !== 'rebel-system') continue;

    const parts = metadata.split(/\s+/);
    const oldSha = parts[2];
    const newSha = parts[3];
    if (!oldSha || !newSha || /^0+$/.test(oldSha) || /^0+$/.test(newSha)) {
      return null;
    }

    const submoduleDiff = gitOrNull(['diff', '--name-only', oldSha, newSha, '--', 'prompts'], submodulePath);
    if (submoduleDiff === null) {
      return null;
    }
    promptChanges.push(...lines(submoduleDiff).map((filePath) => `rebel-system/${filePath}`));
  }

  return promptChanges;
}

function hasLocalSubmodulePromptChanges(): boolean {
  if (!fs.existsSync(submodulePath)) return false;
  const changed = [
    ...lines(gitOrNull(['diff', '--name-only', '--', 'prompts'], submodulePath)),
    ...lines(gitOrNull(['diff', '--cached', '--name-only', '--', 'prompts'], submodulePath)),
    ...lines(gitOrNull(['ls-files', '--others', '--exclude-standard', 'prompts'], submodulePath)),
  ];
  return changed.length > 0;
}

function hasLocalTopLevelSubmoduleChange(): boolean {
  const changed = [
    ...lines(gitOrNull(['diff', '--name-only', '--', 'rebel-system'])),
    ...lines(gitOrNull(['diff', '--cached', '--name-only', '--', 'rebel-system'])),
  ];
  return changed.includes('rebel-system');
}

function shouldRunContractTest(): { run: boolean; reason: string } {
  const refSpec = resolveDiffRefSpec();
  const changedPaths = changedTopLevelPaths(refSpec);

  if (changedPaths === null) {
    return { run: true, reason: 'could not resolve a git diff range' };
  }

  const hostContractChange = changedPaths.find((filePath) => HOST_CONTRACT_PATHS.has(filePath));
  if (hostContractChange) {
    return { run: true, reason: `${hostContractChange} changed` };
  }

  const directPromptChange = changedPaths.find((filePath) => filePath.startsWith('rebel-system/prompts/'));
  if (directPromptChange) {
    return { run: true, reason: `${directPromptChange} changed` };
  }

  if (hasLocalSubmodulePromptChanges()) {
    return { run: true, reason: 'local rebel-system/prompts changes detected' };
  }

  if (changedPaths.includes('rebel-system')) {
    if (refSpec !== null) {
      const submodulePromptChanges = changedSubmodulePromptPaths(refSpec);
      if (submodulePromptChanges === null) {
        return {
          run: true,
          reason: 'rebel-system pointer changed and the submodule prompt range could not be inspected',
        };
      }
      if (submodulePromptChanges.length > 0) {
        return { run: true, reason: `${submodulePromptChanges[0]} changed in rebel-system pointer range` };
      }
    }
    if (hasLocalTopLevelSubmoduleChange()) {
      return { run: true, reason: 'local rebel-system pointer changed' };
    }
  }

  return { run: false, reason: 'no prompt registry contract inputs changed' };
}

function runContractTest(): number {
  const result = spawnSync(
    'npx',
    ['vitest', 'run', '--project=desktop', contractTestPath],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  );

  if (result.error) {
    console.error(`[prompt-registry-contract] failed to run vitest: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

const decision = shouldRunContractTest();
if (!decision.run) {
  console.log(`[prompt-registry-contract] skip: ${decision.reason}`);
  process.exit(0);
}

console.log(`[prompt-registry-contract] running: ${decision.reason}`);
process.exit(runContractTest());
