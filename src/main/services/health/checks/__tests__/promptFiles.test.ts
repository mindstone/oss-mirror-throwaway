import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  configurePromptFileService,
  PROMPT_REGISTRY,
  _resetForTesting,
} from '@core/services/promptFileService';

import { checkPromptFilesExist, checkPromptFilesRender } from '../promptFiles';

// ---------------------------------------------------------------------------
// Helpers — real temp-dir fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

function createPromptFile(relativePath: string, content: string): void {
  const fullPath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
}

const makePrompt = (opts?: { variables?: string[]; critical?: boolean; body?: string }) => {
  const vars = opts?.variables ?? [];
  const critical = opts?.critical ?? false;
  const body = opts?.body ?? 'You are a helpful assistant.';
  return `---
description: Test prompt
service: test.ts
variables: [${vars.map((v) => `"${v}"`).join(', ')}]
critical: ${critical}
---
${body}`;
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-health-test-'));
  _resetForTesting();
  PROMPT_REGISTRY.clear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// =============================================================================
// checkPromptFilesExist
// =============================================================================

describe('checkPromptFilesExist', () => {
  it('returns skip when service is not configured', async () => {
    const result = await checkPromptFilesExist();
    expect(result.status).toBe('skip');
  });

  it('returns pass when no prompts are registered', async () => {
    configurePromptFileService(tmpDir);
    const result = await checkPromptFilesExist();
    expect(result.status).toBe('pass');
    expect(result.message).toContain('No prompt files registered');
  });

  it('returns pass when all registered prompts exist', async () => {
    createPromptFile('test/a.md', makePrompt());
    createPromptFile('test/b.md', makePrompt());

    PROMPT_REGISTRY.set('test/a', {
      id: 'test/a', variables: [], critical: false, service: 'test.ts',
    });
    PROMPT_REGISTRY.set('test/b', {
      id: 'test/b', variables: [], critical: false, service: 'test.ts',
    });

    configurePromptFileService(tmpDir);
    const result = await checkPromptFilesExist();
    expect(result.status).toBe('pass');
    expect(result.message).toContain('2 prompt file(s) present');
  });

  it('returns warn for missing non-critical prompt', async () => {
    PROMPT_REGISTRY.set('test/missing', {
      id: 'test/missing', variables: [], critical: false, service: 'test.ts',
    });

    configurePromptFileService(tmpDir);
    const result = await checkPromptFilesExist();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('1 missing');
  });

  it('returns fail for missing critical prompt', async () => {
    PROMPT_REGISTRY.set('safety/critical', {
      id: 'safety/critical', variables: [], critical: true, service: 'test.ts',
    });

    configurePromptFileService(tmpDir);
    const result = await checkPromptFilesExist();
    expect(result.status).toBe('fail');
    expect(result.message).toContain('1 missing');
  });

  it('detects empty files', async () => {
    createPromptFile('test/empty.md', '');
    PROMPT_REGISTRY.set('test/empty', {
      id: 'test/empty', variables: [], critical: false, service: 'test.ts',
    });

    configurePromptFileService(tmpDir);
    const result = await checkPromptFilesExist();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('1 empty');
  });
});

// =============================================================================
// checkPromptFilesRender
// =============================================================================

describe('checkPromptFilesRender', () => {
  it('returns skip when service is not configured', async () => {
    const result = await checkPromptFilesRender();
    expect(result.status).toBe('skip');
  });

  it('returns pass when no prompts are registered', async () => {
    configurePromptFileService(tmpDir);
    const result = await checkPromptFilesRender();
    expect(result.status).toBe('pass');
  });

  it('returns pass when all prompts render successfully', async () => {
    createPromptFile('test/ok.md', makePrompt());
    PROMPT_REGISTRY.set('test/ok', {
      id: 'test/ok', variables: [], critical: false, service: 'test.ts',
    });

    configurePromptFileService(tmpDir);
    const result = await checkPromptFilesRender();
    expect(result.status).toBe('pass');
    expect(result.message).toContain('1 prompt(s) parse and render');
  });

  it('returns warn for template prompts with render errors (non-critical)', async () => {
    // Template that uses an undeclared variable
    createPromptFile('test/bad-render.md', makePrompt({
      body: 'Hello {{ undeclared_var }}.',
    }));
    PROMPT_REGISTRY.set('test/bad-render', {
      id: 'test/bad-render', variables: [], critical: false, service: 'test.ts',
    });

    configurePromptFileService(tmpDir);
    const result = await checkPromptFilesRender();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('render error');
  });

  it('returns fail for critical prompt with render error', async () => {
    createPromptFile('safety/bad.md', makePrompt({
      critical: true,
      body: 'Hello {{ undeclared_var }}.',
    }));
    PROMPT_REGISTRY.set('safety/bad', {
      id: 'safety/bad', variables: [], critical: true, service: 'test.ts',
    });

    configurePromptFileService(tmpDir);
    const result = await checkPromptFilesRender();
    expect(result.status).toBe('fail');
  });

  it('renders template prompts with dummy variables', async () => {
    createPromptFile('test/template.md', makePrompt({
      variables: ['name', 'count'],
      body: 'Hello {{ name }}, you have {{ count }} items.',
    }));
    PROMPT_REGISTRY.set('test/template', {
      id: 'test/template', variables: ['name', 'count'], critical: false, service: 'test.ts',
    });

    configurePromptFileService(tmpDir);
    const result = await checkPromptFilesRender();
    expect(result.status).toBe('pass');
  });

  it('warns about unreferenced variables in frontmatter', async () => {
    createPromptFile('test/extra-var.md', makePrompt({
      variables: ['name', 'unused_var'],
      body: 'Hello {{ name }}.',
    }));
    PROMPT_REGISTRY.set('test/extra-var', {
      id: 'test/extra-var', variables: ['name', 'unused_var'], critical: false, service: 'test.ts',
    });

    configurePromptFileService(tmpDir);
    const result = await checkPromptFilesRender();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('unreferenced variables');
  });

  it('detects parse errors (invalid frontmatter)', async () => {
    createPromptFile('test/bad-fm.md', 'Just plain text, no frontmatter.');
    PROMPT_REGISTRY.set('test/bad-fm', {
      id: 'test/bad-fm', variables: [], critical: false, service: 'test.ts',
    });

    configurePromptFileService(tmpDir);
    const result = await checkPromptFilesRender();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('parse error');
  });
});
