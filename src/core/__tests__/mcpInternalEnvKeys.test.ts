import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { INTERNAL_ENV_KEYS } from '@core/mcpInternalEnvKeys';

const SRC_ROOT = path.join(process.cwd(), 'src');
const SKIP_DIRS = new Set(['__fixtures__', '__tests__', 'dist', 'fixtures', 'node_modules', 'out']);
const SKIP_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];
const INTERNAL_ENV_KEY_PATTERN = /\b(MINDSTONE_REBEL_[A-Z0-9_]+)\b/g;

const collectInternalEnvKeyReferences = (
  dir: string,
  found: Map<string, Set<string>>,
): void => {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      collectInternalEnvKeyReferences(entryPath, found);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) {
      continue;
    }

    if (SKIP_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      continue;
    }

    const relativePath = path.relative(process.cwd(), entryPath);
    const content = fs.readFileSync(entryPath, 'utf8');
    for (const match of content.matchAll(INTERNAL_ENV_KEY_PATTERN)) {
      const envKey = match[1];
      if (!envKey) {
        continue;
      }
      const references = found.get(envKey) ?? new Set<string>();
      references.add(relativePath);
      found.set(envKey, references);
    }
  }
};

describe('INTERNAL_ENV_KEYS', () => {
  it('contains expected baseline keys', () => {
    for (const key of [
      'MCP_MODE',
      'ACCOUNTS_PATH',
      'CREDENTIALS_PATH',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'NODE_PATH',
      'LOG_MODE',
      'MCP_HOST_BRIDGE_STATE',
      'MINDSTONE_REBEL_BRIDGE_STATE', // retained for migration of pre-rename user configs
    ]) {
      expect(INTERNAL_ENV_KEYS.has(key)).toBe(true);
    }
  });

  it('contains every MINDSTONE_REBEL_* env key referenced in src/', () => {
    const found = new Map<string, Set<string>>();
    collectInternalEnvKeyReferences(SRC_ROOT, found);

    const missing = [...found.keys()]
      .filter((key) => !INTERNAL_ENV_KEYS.has(key))
      .sort((a, b) => a.localeCompare(b));

    const missingWithReferences = missing
      .map((key) => `${key} (${[...(found.get(key) ?? [])].sort().join(', ')})`)
      .join(', ');

    expect(
      missing,
      `Add to INTERNAL_ENV_KEYS in src/core/mcpInternalEnvKeys.ts: ${missingWithReferences}`,
    ).toEqual([]);
  });
  it('detects unquoted env-object keys', () => {
    const fixture = `
      const env = {
        MINDSTONE_REBEL_BRIDGE_STATE: process.env.MINDSTONE_REBEL_BRIDGE_STATE,
      };
    `;

    const matches = [...fixture.matchAll(INTERNAL_ENV_KEY_PATTERN)].map((match) => match[1]);

    expect(matches).toContain('MINDSTONE_REBEL_BRIDGE_STATE');
  });
});
