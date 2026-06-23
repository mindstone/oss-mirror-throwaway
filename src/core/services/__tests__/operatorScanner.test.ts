import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanOperators } from '../operatorScanner';

let tempRoot: string;
const syncedBody = 'This Operator has enough markdown body content to be treated as a fully synced file.';

async function writeOperator(spacePath: string, slug: string, frontmatter: string, body = syncedBody): Promise<void> {
  const dir = path.join(spacePath, 'operators', slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'OPERATOR.md'), `---\n${frontmatter}\n---\n${body}\n`, 'utf-8');
}

describe('operatorScanner', () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-scanner-'));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('loads folder-based OPERATOR.md files from spaces', async () => {
    const spacePath = path.join(tempRoot, 'Acme');
    await writeOperator(
      spacePath,
      'skeptical-engineer',
      [
        'name: Skeptical Engineer',
        'description: Pressure-tests technical plans',
        'consult_when: The plan has implementation or risk trade-offs',
        'kind: operator',
      ].join('\n'),
    );

    const result = await scanOperators([spacePath]);

    expect(result.failures).toEqual([]);
    expect(result.operators).toHaveLength(1);
    expect(result.operators[0]).toMatchObject({
      operatorSlug: 'skeptical-engineer',
      spacePath,
      sourceSpacePath: spacePath,
      category: 'space',
      name: 'Skeptical Engineer',
      kind: 'operator',
      roles: ['operator'],
      body: syncedBody,
    });
    expect(result.operators[0].groundingPath).toBe(path.join(spacePath, 'operators', 'skeptical-engineer', 'grounding.md'));
  });

  it('maps role-aware frontmatter fields to scanner metadata', async () => {
    const spacePath = path.join(tempRoot, 'Acme');
    await writeOperator(
      spacePath,
      'sales-coach',
      [
        'name: Sales Coach',
        'description: Real-time sales coaching',
        'consult_when: Strategic deal coaching requests',
        'kind: operator',
        'roles: [operator, live_meeting]',
        'proactive_interval_minutes: 2',
        'use_cases: [discovery, objections]',
        'consultation_prompt: Consult prompt from frontmatter',
        'live_prompt: Live coaching prompt from frontmatter',
        'display_name: Sales Coach (Enterprise)',
      ].join('\n'),
      'Fallback markdown body for compatibility.',
    );

    const result = await scanOperators([spacePath]);

    expect(result.failures).toEqual([]);
    expect(result.operators).toHaveLength(1);
    expect(result.operators[0]).toMatchObject({
      operatorSlug: 'sales-coach',
      roles: ['operator', 'live_meeting'],
      proactiveIntervalMinutes: 2,
      useCases: ['discovery', 'objections'],
      consultationPrompt: 'Consult prompt from frontmatter',
      livePrompt: 'Live coaching prompt from frontmatter',
      displayName: 'Sales Coach (Enterprise)',
    });
    expect(result.operators[0].frontmatter).toMatchObject({
      proactive_interval_minutes: 2,
      use_cases: ['discovery', 'objections'],
      consultation_prompt: 'Consult prompt from frontmatter',
      live_prompt: 'Live coaching prompt from frontmatter',
      display_name: 'Sales Coach (Enterprise)',
    });
    expect(result.operators[0]).not.toHaveProperty('proactive_interval_minutes');
    expect(result.operators[0]).not.toHaveProperty('use_cases');
    expect(result.operators[0]).not.toHaveProperty('consultation_prompt');
    expect(result.operators[0]).not.toHaveProperty('live_prompt');
    expect(result.operators[0]).not.toHaveProperty('display_name');
  });

  it('detect-log-suppresses malformed and unsynced-stub files while loading siblings', async () => {
    const spacePath = path.join(tempRoot, 'Acme');
    await writeOperator(
      spacePath,
      'brand-critic',
      [
        'name: Brand Critic',
        'description: Spots copy that sounds like a committee',
        'consult_when: Messaging tone or positioning matters',
        'kind: operator',
      ].join('\n'),
    );
    await writeOperator(
      spacePath,
      'wrong-kind',
      [
        'name: Skill Pretender',
        'description: Wrong discriminator',
        'consult_when: Never',
        'kind: skill',
      ].join('\n'),
    );
    const stubDir = path.join(spacePath, 'operators', 'stub');
    await fs.mkdir(stubDir, { recursive: true });
    await fs.writeFile(path.join(stubDir, 'OPERATOR.md'), '', 'utf-8');

    const result = await scanOperators([spacePath]);

    expect(result.operators.map((operator) => operator.operatorSlug)).toEqual(['brand-critic']);
    expect(result.failures.map((failure) => failure.errorCode).sort()).toEqual(['unsynced-stub', 'wrong-kind']);
  });

  it('tolerates operator-role files missing consultation_prompt and body, surfacing a warning instead of failing', async () => {
    const spacePath = path.join(tempRoot, 'Acme');
    await writeOperator(
      spacePath,
      'missing-consultation-prompt',
      [
        'name: Missing Consultation Prompt',
        'description: Tolerant parse path keeps the persona available.',
        'consult_when: Never',
        'kind: operator',
      ].join('\n'),
      '',
    );

    const result = await scanOperators([spacePath]);

    expect(result.failures).toEqual([]);
    expect(result.operators).toHaveLength(1);
    expect(result.operators[0]?.warnings ?? []).toEqual(
      expect.arrayContaining([
        expect.stringContaining('consultation_prompt is missing'),
      ]),
    );
  });

  it('tolerates operator-role files missing consult_when, surfacing a warning instead of failing', async () => {
    const spacePath = path.join(tempRoot, 'Acme');
    await writeOperator(
      spacePath,
      'missing-consult-when',
      [
        'name: Missing Consult Trigger',
        'description: Tolerant parse path keeps the persona available.',
        'kind: operator',
        'roles: [operator]',
        'consultation_prompt: Fallback consultation prompt.',
      ].join('\n'),
      'Body content goes here.',
    );

    const result = await scanOperators([spacePath]);

    expect(result.failures).toEqual([]);
    expect(result.operators).toHaveLength(1);
    expect(result.operators[0]?.consult_when).toBe('');
    expect(result.operators[0]?.warnings ?? []).toEqual(
      expect.arrayContaining([
        expect.stringContaining('consult_when is missing'),
      ]),
    );
  });

  it('loads operator-role files with empty body when consultation_prompt is present', async () => {
    const spacePath = path.join(tempRoot, 'Acme');
    await writeOperator(
      spacePath,
      'frontmatter-only',
      [
        'name: Frontmatter Only',
        'description: Uses consultation prompt in frontmatter',
        'consult_when: When strategy is unclear',
        'kind: operator',
        'consultation_prompt: Use this prompt as fallback when markdown body is empty.',
      ].join('\n'),
      '',
    );

    const result = await scanOperators([spacePath]);

    expect(result.failures).toEqual([]);
    expect(result.operators).toHaveLength(1);
    expect(result.operators[0]).toMatchObject({
      operatorSlug: 'frontmatter-only',
      body: '',
      consultationPrompt: 'Use this prompt as fallback when markdown body is empty.',
      roles: ['operator'],
    });
  });

  it.each([
    ['slug with separator', 'bad::slug'],
    ['slug with uppercase', 'BadSlug'],
    ['slug with spaces', 'bad slug'],
    ['slug with unicode', 'brand-critiqué'],
  ])('rejects invalid operator slugs: %s', async (_label, slug) => {
    const spacePath = path.join(tempRoot, 'Acme');
    await writeOperator(
      spacePath,
      slug,
      [
        'name: Invalid Slug',
        'description: Should not load',
        'consult_when: Never',
        'kind: operator',
      ].join('\n'),
    );

    const result = await scanOperators([spacePath]);

    expect(result.operators).toEqual([]);
    expect(result.failures).toMatchObject([
      { operatorSlug: slug, errorCode: 'invalid-slug' },
    ]);
  });

  it('rejects OPERATOR.md files outside the exact <space>/operators/<slug>/OPERATOR.md shape', async () => {
    const spacePath = path.join(tempRoot, 'Acme');
    await fs.mkdir(path.join(spacePath, 'operators'), { recursive: true });
    await fs.writeFile(path.join(spacePath, 'operators', 'OPERATOR.md'), 'root-level operator', 'utf-8');
    await fs.mkdir(path.join(spacePath, 'operators', 'nested', 'too-deep'), { recursive: true });
    await fs.writeFile(path.join(spacePath, 'operators', 'nested', 'too-deep', 'OPERATOR.md'), 'nested operator', 'utf-8');

    const result = await scanOperators([spacePath]);

    expect(result.operators).toEqual([]);
    expect(result.failures.map((failure) => failure.errorCode).sort()).toEqual([
      'invalid-path-shape',
      'invalid-path-shape',
    ]);
  });

  it('follows symlinked operator directories via safeWalkDirectory', async () => {
    const realSpacePath = path.join(tempRoot, 'RealSpace');
    const linkedSpacePath = path.join(tempRoot, 'LinkedSpace');
    await writeOperator(
      realSpacePath,
      'customer-voice',
      [
        'name: Customer Voice',
        'description: Keeps customer reality in the room',
        'consult_when: Product, sales, or support impact is unclear',
        'kind: operator',
      ].join('\n'),
    );
    await fs.symlink(realSpacePath, linkedSpacePath, 'dir');

    const result = await scanOperators([linkedSpacePath]);

    expect(result.failures).toEqual([]);
    expect(result.operators).toHaveLength(1);
    expect(result.operators[0].spacePath).toBe(path.resolve(linkedSpacePath));
    expect(result.operators[0].operatorSlug).toBe('customer-voice');
  });

  it('categorizes rebel-system operators as bundled', async () => {
    const bundledPath = path.join(tempRoot, 'rebel-system');
    await writeOperator(
      bundledPath,
      'brand-critic',
      [
        'name: Brand Critic',
        'description: Spots copy that sounds like a committee',
        'consult_when: Messaging tone or positioning matters',
        'kind: operator',
      ].join('\n'),
    );

    const result = await scanOperators([bundledPath]);

    expect(result.failures).toEqual([]);
    expect(result.operators[0]).toMatchObject({
      operatorSlug: 'brand-critic',
      sourceSpacePath: path.resolve(bundledPath),
      category: 'bundled',
    });
  });
});
