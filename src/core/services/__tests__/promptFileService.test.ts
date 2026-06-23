import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// The lazy fallback in `ensureConfigured()` (REBEL-63K) calls
// `getSystemSettingsPath()` to resolve the default prompts root. We spy on the
// sibling module so we can point it at a controllable temp dir and exercise the
// auto-resolve path without depending on the real rebel-system submodule layout.
// `vi.spyOn` (rather than `vi.mock`) sidesteps the alias-vs-relative module-id
// duplication that otherwise leaves the consumer holding the unmocked binding.
import * as systemSettingsSync from '../systemSettingsSync';

import {
  configurePromptFileService,
  getPrompt,
  getRawPrompt,
  getPromptMetadata,
  warmAllPrompts,
  getCriticalPromptWarmStatus,
  invalidatePromptCache,
  parsePromptFile,
  renderPromptTemplate,
  PROMPT_REGISTRY,
  _resetForTesting,
} from '../promptFileService';

// ---------------------------------------------------------------------------
// Helpers — real temp-dir fixtures (no fs mocks)
// ---------------------------------------------------------------------------

let tmpDir: string;

function createPromptFile(relativePath: string, content: string): string {
  const fullPath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

const VALID_FRONTMATTER = `---
description: Test prompt
service: src/core/services/testService.ts
variables: []
---`;

const TEMPLATE_FRONTMATTER = `---
description: Template prompt
service: src/core/services/testService.ts
variables:
  - name
  - count
---`;

let systemSettingsPathSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-file-test-'));
  _resetForTesting();
  // Clear any test entries from the registry
  PROMPT_REGISTRY.clear();
  // Default the lazy-fallback root to a path that does NOT exist, so any test
  // that doesn't explicitly configure (or override this spy) fails loud rather
  // than silently resolving to the real rebel-system dir. Tests exercising the
  // auto-resolve path set their own return value.
  systemSettingsPathSpy = vi
    .spyOn(systemSettingsSync, 'getSystemSettingsPath')
    .mockReturnValue(path.join(tmpDir, '__no_such_root__'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  systemSettingsPathSpy.mockRestore();
});

// =============================================================================
// parsePromptFile (pure helper)
// =============================================================================

describe('parsePromptFile', () => {
  it('parses valid frontmatter and body', () => {
    const raw = `---
description: Generates titles
service: src/core/services/titleService.ts
variables: []
model_hint: haiku
---
You are a senior UX writer.`;

    const result = parsePromptFile(raw);
    expect(result.frontmatter.description).toBe('Generates titles');
    expect(result.frontmatter.service).toBe('src/core/services/titleService.ts');
    expect(result.frontmatter.variables).toEqual([]);
    expect(result.frontmatter.model_hint).toBe('haiku');
    expect(result.frontmatter.critical).toBe(false);
    expect(result.body).toBe('You are a senior UX writer.');
  });

  it('parses critical prompts', () => {
    const raw = `---
description: Safety eval
service: src/core/safetyPromptLogic.ts
variables: []
critical: true
---
Evaluate this for safety.`;

    const result = parsePromptFile(raw);
    expect(result.frontmatter.critical).toBe(true);
  });

  it('parses prompts with variables', () => {
    const raw = `---
description: Quip generator
service: src/core/services/quipService.ts
variables:
  - quips_per_request
---
Generate {{ quips_per_request }} quips.`;

    const result = parsePromptFile(raw);
    expect(result.frontmatter.variables).toEqual(['quips_per_request']);
  });

  it('normalizes CRLF to LF', () => {
    const raw = '---\r\ndescription: Test\r\nservice: test.ts\r\nvariables: []\r\n---\r\nHello world.\r\n';
    const result = parsePromptFile(raw);
    expect(result.body).toBe('Hello world.');
    expect(result.body).not.toContain('\r');
  });

  it('throws on missing frontmatter', () => {
    expect(() => parsePromptFile('Just a plain prompt.')).toThrow('Invalid frontmatter');
  });

  it('throws on invalid frontmatter (missing required fields)', () => {
    const raw = `---
description: Missing service
---
Some body.`;

    expect(() => parsePromptFile(raw)).toThrow('Invalid frontmatter');
  });

  it('throws on empty body', () => {
    const raw = `---
description: Empty body
service: test.ts
variables: []
---
`;

    expect(() => parsePromptFile(raw)).toThrow('Prompt body is empty');
  });
});

// =============================================================================
// renderPromptTemplate (pure helper)
// =============================================================================

describe('renderPromptTemplate', () => {
  it('renders with no variables', () => {
    const result = renderPromptTemplate('Hello world.');
    expect(result).toBe('Hello world.');
  });

  it('renders with variables', () => {
    const result = renderPromptTemplate('Hello {{ name }}, you have {{ count }} items.', {
      name: 'Alice',
      count: 5,
    });
    expect(result).toBe('Hello Alice, you have 5 items.');
  });

  it('throws on undefined variable (strict mode)', () => {
    expect(() => renderPromptTemplate('Hello {{ missing_var }}.')).toThrow();
  });

  it('handles Nunjucks conditionals', () => {
    const template = '{% if verbose %}Detailed mode{% else %}Brief mode{% endif %}';
    expect(renderPromptTemplate(template, { verbose: true })).toBe('Detailed mode');
    expect(renderPromptTemplate(template, { verbose: false })).toBe('Brief mode');
  });

  it('handles Nunjucks loops', () => {
    const template = '{% for item in items %}{{ item }} {% endfor %}';
    expect(renderPromptTemplate(template, { items: ['a', 'b', 'c'] })).toBe('a b c ');
  });
});

// =============================================================================
// configurePromptFileService
// =============================================================================

describe('configurePromptFileService', () => {
  it('does not throw when directory does not exist (logs warning)', () => {
    const nonExistent = path.join(tmpDir, 'nonexistent');
    expect(() => configurePromptFileService(nonExistent)).not.toThrow();
  });

  it('configures successfully when directory exists', () => {
    expect(() => configurePromptFileService(tmpDir)).not.toThrow();
  });
});

// =============================================================================
// getPrompt
// =============================================================================

describe('getPrompt', () => {
  // REBEL-63K: a prompt read before explicit configuration must NOT throw the
  // old "not configured" error. Instead `ensureConfigured()` lazily resolves the
  // default prompts root (`getSystemSettingsPath()/prompts`), memoizes it, and
  // serves the prompt. This makes the "read before configure" state
  // unrepresentable on every surface (desktop init-order race + cloud, which
  // never wires configure at all).
  it('auto-resolves the default prompts root when unconfigured (REBEL-63K)', () => {
    // Settings root contains a `prompts/` subdir with a valid prompt file.
    const settingsRoot = path.join(tmpDir, 'rebel-system');
    const promptsDir = path.join(settingsRoot, 'prompts');
    fs.mkdirSync(path.join(promptsDir, 'agent'), { recursive: true });
    fs.writeFileSync(
      path.join(promptsDir, 'agent', 'forager.md'),
      `${VALID_FRONTMATTER}\nYou are the forager.`,
      'utf-8',
    );
    systemSettingsPathSpy.mockReturnValue(settingsRoot);

    // Service is unconfigured (beforeEach -> _resetForTesting()).
    expect(() => getPrompt('agent/forager')).not.toThrow();
    expect(getPrompt('agent/forager')).toBe('You are the forager.');

    // F1: lock the memoization cost invariant. `getSystemSettingsPath()` does a
    // `readdirSync` in dev mode, so re-resolving the root per call would be a real
    // regression. After two reads above the spy must have been hit at most once —
    // `ensureConfigured()` memoizes `promptsRootPath` on the first read.
    expect(systemSettingsPathSpy).toHaveBeenCalledTimes(1);
  });

  it('fails loud when unconfigured and the default prompts dir is missing', () => {
    // systemSettingsPathSpy defaults (beforeEach) to a non-existent root, so
    // <root>/prompts does not exist.
    const expectedMissing = path.join(tmpDir, '__no_such_root__', 'prompts');

    let caught: Error | undefined;
    try {
      getPrompt('agent/forager');
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    // Must name the resolved path and signal the prompts dir was not found...
    expect(caught?.message).toContain(expectedMissing);
    expect(caught?.message).toContain('default prompts directory not found');
    // ...and must NOT be the old "not configured" message or a silent success.
    expect(caught?.message).not.toContain('not configured');
  });

  it('loads and returns a simple prompt', () => {
    createPromptFile('test/simple.md', `${VALID_FRONTMATTER}\nYou are a helpful assistant.`);
    configurePromptFileService(tmpDir);

    const result = getPrompt('test/simple');
    expect(result).toBe('You are a helpful assistant.');
  });

  it('loads and renders a template prompt', () => {
    createPromptFile(
      'test/template.md',
      `${TEMPLATE_FRONTMATTER}\nHello {{ name }}, you have {{ count }} items.`,
    );
    configurePromptFileService(tmpDir);

    const result = getPrompt('test/template', { name: 'Bob', count: 3 });
    expect(result).toBe('Hello Bob, you have 3 items.');
  });

  it('caches raw template, renders differently per call', () => {
    createPromptFile(
      'test/cached.md',
      `${TEMPLATE_FRONTMATTER}\nHello {{ name }}.`,
    );
    configurePromptFileService(tmpDir);

    const result1 = getPrompt('test/cached', { name: 'Alice' });
    const result2 = getPrompt('test/cached', { name: 'Bob' });

    expect(result1).toBe('Hello Alice.');
    expect(result2).toBe('Hello Bob.');
  });

  it('throws on missing file', () => {
    configurePromptFileService(tmpDir);
    expect(() => getPrompt('nonexistent/prompt')).toThrow('file not found');
  });

  it('throws on render error (missing variable)', () => {
    createPromptFile(
      'test/missing-var.md',
      `${TEMPLATE_FRONTMATTER}\nHello {{ name }} and {{ missing }}.`,
    );
    configurePromptFileService(tmpDir);

    expect(() => getPrompt('test/missing-var', { name: 'Alice' })).toThrow(
      /Failed to render prompt/,
    );
  });
});

// =============================================================================
// getRawPrompt
// =============================================================================

describe('getRawPrompt', () => {
  it('returns raw template without rendering', () => {
    createPromptFile(
      'test/raw.md',
      `${TEMPLATE_FRONTMATTER}\nEvaluate {{user_message}} for safety.`,
    );
    configurePromptFileService(tmpDir);

    const raw = getRawPrompt('test/raw');
    expect(raw).toBe('Evaluate {{user_message}} for safety.');
    expect(raw).toContain('{{user_message}}');
  });
});

// =============================================================================
// getPromptMetadata
// =============================================================================

describe('getPromptMetadata', () => {
  it('returns parsed frontmatter', () => {
    createPromptFile('test/meta.md', `---
description: Test metadata
service: src/core/services/test.ts
variables:
  - foo
model_hint: opus
critical: true
---
Some body.`);
    configurePromptFileService(tmpDir);

    const meta = getPromptMetadata('test/meta');
    expect(meta.description).toBe('Test metadata');
    expect(meta.service).toBe('src/core/services/test.ts');
    expect(meta.variables).toEqual(['foo']);
    expect(meta.model_hint).toBe('opus');
    expect(meta.critical).toBe(true);
  });
});

// =============================================================================
// warmAllPrompts
// =============================================================================

describe('warmAllPrompts', () => {
  it('succeeds with empty registry', async () => {
    configurePromptFileService(tmpDir);
    await expect(warmAllPrompts()).resolves.not.toThrow();
  });

  it('returns a structured outcome (empty registry)', async () => {
    configurePromptFileService(tmpDir);
    const outcome = await warmAllPrompts();
    expect(outcome).toEqual({ warmed: 0, failed: 0, criticalFailed: 0, failures: [] });
  });

  it('loads all registered prompts', async () => {
    createPromptFile('test/a.md', `${VALID_FRONTMATTER}\nPrompt A.`);
    createPromptFile('test/b.md', `${VALID_FRONTMATTER}\nPrompt B.`);

    PROMPT_REGISTRY.set('test/a', {
      id: 'test/a',
      variables: [],
      critical: false,
      service: 'test.ts',
    });
    PROMPT_REGISTRY.set('test/b', {
      id: 'test/b',
      variables: [],
      critical: false,
      service: 'test.ts',
    });

    configurePromptFileService(tmpDir);
    const outcome = await warmAllPrompts();

    // Structured outcome reflects the two successful warms.
    expect(outcome.warmed).toBe(2);
    expect(outcome.failed).toBe(0);
    expect(outcome.criticalFailed).toBe(0);
    expect(outcome.failures).toEqual([]);

    // Verify they're cached by getting them (no file read needed)
    expect(getPrompt('test/a')).toBe('Prompt A.');
    expect(getPrompt('test/b')).toBe('Prompt B.');
  });

  it('throws on critical prompt failure', async () => {
    PROMPT_REGISTRY.set('test/missing-critical', {
      id: 'test/missing-critical',
      variables: [],
      critical: true,
      service: 'test.ts',
    });

    configurePromptFileService(tmpDir);
    await expect(warmAllPrompts()).rejects.toThrow('critical prompt(s) failed');
  });

  it('warns but does not throw on non-critical failure', async () => {
    PROMPT_REGISTRY.set('test/missing-noncritical', {
      id: 'test/missing-noncritical',
      variables: [],
      critical: false,
      service: 'test.ts',
    });

    configurePromptFileService(tmpDir);
    const outcome = await warmAllPrompts();
    expect(outcome.failed).toBe(1);
    expect(outcome.criticalFailed).toBe(0);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toMatchObject({ id: 'test/missing-noncritical', critical: false });
  });
});

// =============================================================================
// getCriticalPromptWarmStatus — the seam the cloud /api/health detailed
// readiness check reads (checkCriticalPrompts).
// =============================================================================

describe('getCriticalPromptWarmStatus', () => {
  it('reports hasRun:false before warm has run', () => {
    // beforeEach -> _resetForTesting() clears the status.
    const status = getCriticalPromptWarmStatus();
    expect(status).toEqual({ hasRun: false, ok: false, failedCriticalIds: [] });
  });

  it('reports hasRun:true / ok:true after warm with an empty PROMPT_REGISTRY', async () => {
    // beforeEach clears PROMPT_REGISTRY, so this exercises the empty-registry
    // early-return path: warmAllPrompts() records an empty failedCriticalIds
    // (ranAt set), and the health check reads it as "ran, nothing failed".
    expect(PROMPT_REGISTRY.size).toBe(0);
    configurePromptFileService(tmpDir);
    await warmAllPrompts();

    expect(getCriticalPromptWarmStatus()).toEqual({
      hasRun: true,
      ok: true,
      failedCriticalIds: [],
    });
  });

  it('returns a cloned failedCriticalIds array (caller cannot mutate stored state)', async () => {
    PROMPT_REGISTRY.set('test/missing-critical', {
      id: 'test/missing-critical',
      variables: [],
      critical: true,
      service: 'test.ts',
    });
    configurePromptFileService(tmpDir);
    await expect(warmAllPrompts()).rejects.toThrow();

    const first = getCriticalPromptWarmStatus();
    expect(first.failedCriticalIds).toEqual(['test/missing-critical']);
    // Mutate the returned array — the stored health state must be unaffected.
    first.failedCriticalIds.push('test/tampered');
    first.failedCriticalIds.length = 0;

    expect(getCriticalPromptWarmStatus().failedCriticalIds).toEqual(['test/missing-critical']);
  });

  it('reports ok:true when all critical prompts warmed', async () => {
    createPromptFile('test/critical-ok.md', `${VALID_FRONTMATTER}\nCritical prompt.`);
    PROMPT_REGISTRY.set('test/critical-ok', {
      id: 'test/critical-ok',
      variables: [],
      critical: true,
      service: 'test.ts',
    });

    configurePromptFileService(tmpDir);
    await warmAllPrompts();

    expect(getCriticalPromptWarmStatus()).toEqual({
      hasRun: true,
      ok: true,
      failedCriticalIds: [],
    });
  });

  it('records the failed critical id BEFORE the throw (cloud guard swallows the throw)', async () => {
    PROMPT_REGISTRY.set('test/missing-critical', {
      id: 'test/missing-critical',
      variables: [],
      critical: true,
      service: 'test.ts',
    });

    configurePromptFileService(tmpDir);
    // warmAllPrompts() throws on a critical failure — but the module status must
    // already be recorded (this is what makes the health check observable even
    // though the cloud bootstrap guard catches and discards the throw).
    await expect(warmAllPrompts()).rejects.toThrow('critical prompt(s) failed');

    const status = getCriticalPromptWarmStatus();
    expect(status.hasRun).toBe(true);
    expect(status.ok).toBe(false);
    expect(status.failedCriticalIds).toEqual(['test/missing-critical']);
  });

  it('a non-critical failure does NOT mark the status not-ok', async () => {
    PROMPT_REGISTRY.set('test/missing-noncritical', {
      id: 'test/missing-noncritical',
      variables: [],
      critical: false,
      service: 'test.ts',
    });

    configurePromptFileService(tmpDir);
    await warmAllPrompts();

    expect(getCriticalPromptWarmStatus()).toEqual({
      hasRun: true,
      ok: true,
      failedCriticalIds: [],
    });
  });

  it('_resetForTesting() resets the status back to hasRun:false', async () => {
    PROMPT_REGISTRY.set('test/missing-critical', {
      id: 'test/missing-critical',
      variables: [],
      critical: true,
      service: 'test.ts',
    });
    configurePromptFileService(tmpDir);
    await expect(warmAllPrompts()).rejects.toThrow();
    expect(getCriticalPromptWarmStatus().hasRun).toBe(true);

    _resetForTesting();
    expect(getCriticalPromptWarmStatus()).toEqual({
      hasRun: false,
      ok: false,
      failedCriticalIds: [],
    });
  });
});

// =============================================================================
// invalidatePromptCache
// =============================================================================

describe('invalidatePromptCache', () => {
  it('clears a single prompt cache entry', () => {
    createPromptFile('test/inv.md', `${VALID_FRONTMATTER}\nOriginal.`);
    configurePromptFileService(tmpDir);

    // Load to cache
    expect(getPrompt('test/inv')).toBe('Original.');

    // Update file on disk
    createPromptFile('test/inv.md', `${VALID_FRONTMATTER}\nUpdated.`);

    // Still cached
    expect(getPrompt('test/inv')).toBe('Original.');

    // Invalidate
    invalidatePromptCache('test/inv');

    // Now reads updated file
    expect(getPrompt('test/inv')).toBe('Updated.');
  });

  it('clears all cache entries when called without argument', () => {
    createPromptFile('test/c1.md', `${VALID_FRONTMATTER}\nC1.`);
    createPromptFile('test/c2.md', `${VALID_FRONTMATTER}\nC2.`);
    configurePromptFileService(tmpDir);

    getPrompt('test/c1');
    getPrompt('test/c2');

    createPromptFile('test/c1.md', `${VALID_FRONTMATTER}\nC1 updated.`);
    createPromptFile('test/c2.md', `${VALID_FRONTMATTER}\nC2 updated.`);

    invalidatePromptCache();

    expect(getPrompt('test/c1')).toBe('C1 updated.');
    expect(getPrompt('test/c2')).toBe('C2 updated.');
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe('edge cases', () => {
  it('handles multiline prompt bodies', () => {
    createPromptFile('test/multiline.md', `${VALID_FRONTMATTER}
Line 1.
Line 2.
Line 3.`);
    configurePromptFileService(tmpDir);

    const result = getPrompt('test/multiline');
    expect(result).toContain('Line 1.');
    expect(result).toContain('Line 2.');
    expect(result).toContain('Line 3.');
  });

  it('handles prompt with CRLF line endings', () => {
    const content = '---\r\ndescription: CRLF test\r\nservice: test.ts\r\nvariables: []\r\n---\r\nHello {{ name }}.\r\n';
    createPromptFile('test/crlf.md', content);
    configurePromptFileService(tmpDir);

    const result = getPrompt('test/crlf', { name: 'World' });
    expect(result).toBe('Hello World.');
    expect(result).not.toContain('\r');
  });

  it('handles deeply nested prompt paths', () => {
    createPromptFile('safety/eval/deep/nested.md', `${VALID_FRONTMATTER}\nDeep prompt.`);
    configurePromptFileService(tmpDir);

    expect(getPrompt('safety/eval/deep/nested')).toBe('Deep prompt.');
  });
});
