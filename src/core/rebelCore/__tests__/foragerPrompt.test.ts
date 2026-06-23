import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  FORAGER_AGENT_NAME,
  FORAGER_MAX_TURNS,
  FORAGER_SYSTEM_PROMPT,
  buildForagerAgentDef,
} from '../foragerPrompt';
import {
  configurePromptFileService,
  _resetForTesting,
} from '@core/services/promptFileService';

// Set up a temp directory with the forager prompt file so buildForagerAgentDef() works
let tmpDir: string;

beforeEach(() => {
  _resetForTesting();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forager-prompt-test-'));
  const promptDir = path.join(tmpDir, 'agent');
  fs.mkdirSync(promptDir, { recursive: true });
  fs.writeFileSync(path.join(promptDir, 'forager.md'), `---
description: Forager agent prompt
service: src/core/rebelCore/foragerPrompt.ts
variables: []
---
${FORAGER_SYSTEM_PROMPT}`, 'utf-8');
  configurePromptFileService(tmpDir);
});

afterEach(() => {
  _resetForTesting();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('foragerPrompt', () => {
  it('buildForagerAgentDef returns model haiku', () => {
    const definition = buildForagerAgentDef();

    expect(definition.model).toBe('haiku');
  });

  it('buildForagerAgentDef returns lightweight true', () => {
    const definition = buildForagerAgentDef();

    expect(definition.lightweight).toBe(true);
  });

  it('buildForagerAgentDef returns maxTurns 10', () => {
    const definition = buildForagerAgentDef();

    expect(definition.maxTurns).toBe(FORAGER_MAX_TURNS);
    expect(definition.maxTurns).toBe(10);
  });

  it('buildForagerAgentDef returns maxDurationMs 60000', () => {
    const definition = buildForagerAgentDef();

    expect(definition.maxDurationMs).toBe(60_000);
  });

  it('FORAGER_SYSTEM_PROMPT is under 350 rough tokens', () => {
    const roughTokenCount = FORAGER_SYSTEM_PROMPT.trim().split(/\s+/).length;

    expect(roughTokenCount).toBeLessThan(350);
  });

  it('FORAGER_SYSTEM_PROMPT contains security guardrails', () => {
    expect(FORAGER_SYSTEM_PROMPT).toContain('untrusted');
    expect(FORAGER_SYSTEM_PROMPT).toContain('credentials');
  });

  it('FORAGER_SYSTEM_PROMPT contains extractive instruction', () => {
    expect(FORAGER_SYSTEM_PROMPT).toContain('EXACT QUOTES');
  });

  it('FORAGER_AGENT_NAME equals forager', () => {
    expect(FORAGER_AGENT_NAME).toBe('forager');
  });
});
