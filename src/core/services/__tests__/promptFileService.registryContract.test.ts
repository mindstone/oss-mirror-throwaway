import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  _resetForTesting,
  configurePromptFileService,
  parsePromptFile,
  PROMPT_REGISTRY,
  resolvePromptPath,
  warmAllPrompts,
} from '../promptFileService';
import type { PromptFrontmatter, PromptMetadata } from '../promptFileService';

const repoRoot = path.resolve(__dirname, '../../../../');
const promptsRoot = path.join(repoRoot, 'rebel-system/prompts');

interface RegistryFrontmatterMismatch {
  id: string;
  field: 'variables' | 'service' | 'critical';
  registryValue: unknown;
  frontmatterValue: unknown;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function findRegistryFrontmatterMismatches(
  id: string,
  registryEntry: Pick<PromptMetadata, 'variables' | 'service' | 'critical'>,
  frontmatter: Pick<PromptFrontmatter, 'variables' | 'service' | 'critical'>,
): RegistryFrontmatterMismatch[] {
  const mismatches: RegistryFrontmatterMismatch[] = [];
  const registryVariables = sortedUnique(registryEntry.variables);
  const frontmatterVariables = sortedUnique(frontmatter.variables);

  if (JSON.stringify(registryVariables) !== JSON.stringify(frontmatterVariables)) {
    mismatches.push({
      id,
      field: 'variables',
      registryValue: registryVariables,
      frontmatterValue: frontmatterVariables,
    });
  }

  if (registryEntry.service !== frontmatter.service) {
    mismatches.push({
      id,
      field: 'service',
      registryValue: registryEntry.service,
      frontmatterValue: frontmatter.service,
    });
  }

  if (registryEntry.critical !== frontmatter.critical) {
    mismatches.push({
      id,
      field: 'critical',
      registryValue: registryEntry.critical,
      frontmatterValue: frontmatter.critical,
    });
  }

  return mismatches;
}

function listPromptMarkdownFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listPromptMarkdownFiles(fullPath);
    }
    if (entry.isFile() && entry.name.endsWith('.md')) {
      return [fullPath];
    }
    return [];
  });
}

function promptIdForFile(filePath: string): string {
  return path.relative(promptsRoot, filePath).replace(/\\/g, '/').replace(/\.md$/, '');
}

describe('PROMPT_REGISTRY frontmatter contract', () => {
  beforeAll(() => {
    _resetForTesting();
    configurePromptFileService(promptsRoot);
  });

  afterAll(() => {
    _resetForTesting();
  });

  it('resolves and warms every registered prompt file', async () => {
    const missing = Array.from(PROMPT_REGISTRY.keys())
      .map((id) => ({ id, filePath: resolvePromptPath(id) }))
      .filter(({ filePath }) => !fs.existsSync(filePath))
      .map(({ id, filePath }) => `${id} -> ${path.relative(repoRoot, filePath)}`);

    expect(missing).toEqual([]);
    await expect(warmAllPrompts()).resolves.not.toThrow();
  });

  it('keeps registry variables, service, and criticality in sync with prompt frontmatter', () => {
    const mismatches = Array.from(PROMPT_REGISTRY.entries()).flatMap(([id, registryEntry]) => {
      const raw = fs.readFileSync(resolvePromptPath(id), 'utf8');
      const { frontmatter } = parsePromptFile(raw);
      return findRegistryFrontmatterMismatches(id, registryEntry, frontmatter);
    });

    expect(mismatches).toEqual([]);
  });

  it('registers every critical prompt declared in rebel-system frontmatter', () => {
    const unregisteredCriticalPrompts = listPromptMarkdownFiles(promptsRoot)
      .filter((filePath) => path.basename(filePath) !== 'README.md')
      .flatMap((filePath) => {
        const raw = fs.readFileSync(filePath, 'utf8');
        const { frontmatter } = parsePromptFile(raw);
        const id = promptIdForFile(filePath);
        return frontmatter.critical && !PROMPT_REGISTRY.has(id) ? [id] : [];
      });

    expect(unregisteredCriticalPrompts).toEqual([]);
  });

  it('fails comparison logic when frontmatter drifts from a registry entry', () => {
    const mismatches = findRegistryFrontmatterMismatches(
      'safety/example',
      {
        variables: ['REPLY_CONTENT'],
        service: 'src/main/services/inboundTriggers/oldHook.ts',
        critical: true,
      },
      {
        variables: ['REPLY_CONTENT', 'SURFACE_KIND'],
        service: 'src/main/services/inboundTriggers/newHook.ts',
        critical: false,
      },
    );

    expect(mismatches.map((mismatch) => mismatch.field)).toEqual([
      'variables',
      'service',
      'critical',
    ]);
  });
});
