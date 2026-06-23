import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import semver from 'semver';

import type { AutopilotConfig } from '../config.ts';

let currentReleasePromise: Promise<string | null> | null = null;

function normalizeRelease(rawValue: unknown): string | null {
  if (typeof rawValue !== 'string') {
    return null;
  }

  const parsed = semver.parse(rawValue.trim());
  if (!parsed) {
    return null;
  }

  return `v${parsed.version}`;
}

function findPackageJsonFrom(startDir: string): string | null {
  let currentDir = startDir;
  while (true) {
    const candidate = path.join(currentDir, 'package.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

async function readCurrentRelease(config: AutopilotConfig): Promise<string | null> {
  const override = process.env.AUTOPILOT_CURRENT_RELEASE?.trim();
  if (override) {
    return normalizeRelease(override);
  }

  const packageJsonPath = fs.existsSync(path.join(config.repoRoot, 'package.json'))
    ? path.join(config.repoRoot, 'package.json')
    : findPackageJsonFrom(path.dirname(fileURLToPath(import.meta.url)));
  if (!packageJsonPath) {
    return null;
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
    return normalizeRelease(packageJson.version);
  } catch {
    return null;
  }
}

export function getCurrentRelease(config: AutopilotConfig): Promise<string | null> {
  currentReleasePromise ??= readCurrentRelease(config);
  return currentReleasePromise;
}
