import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  rewriteChiefOfStaffReadmeSafeSections,
} from '../chiefOfStaffHygieneRewriteService';
import { CHIEF_OF_STAFF_DISTILLATION_PROMPT_VERSION } from '../chiefOfStaffHygieneDistillationService';
import type { ChiefOfStaffHygieneRunManifest } from '../chiefOfStaffHygieneBackupService';

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

describe('chiefOfStaffHygieneRewriteService', () => {
  let tmpDir: string;
  let coreDir: string;
  let readmePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-hygiene-rewrite-'));
    coreDir = path.join(tmpDir, 'library');
    readmePath = path.join(coreDir, 'Chief-of-Staff', 'README.md');
    await fs.mkdir(path.dirname(readmePath), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('moves long non-risk reference sections to private topics and leaves a signpost', async () => {
    const longReference = 'Detailed product context. '.repeat(120);
    const readme = `# Chief of Staff

## Profile
Stable profile facts stay here.

## Product Reference
${longReference}

## Frequently Useful
Short signpost.
`;
    await writeFile(readmePath, readme);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      runId: 'rewrite-1',
      now: new Date('2026-05-19T10:00:00.000Z'),
      thresholds: { maxSectionCharacters: 500 },
    });

    expect(result.changed).toBe(true);
    expect(result.filesCreated).toEqual([
      'Chief-of-Staff/memory/topics/auto-hygiene/product-reference.md',
    ]);
    const rewrittenReadme = await fs.readFile(readmePath, 'utf8');
    expect(rewrittenReadme).toContain('## Profile\nStable profile facts stay here.');
    expect(rewrittenReadme).toContain('## Product Reference');
    expect(rewrittenReadme).toContain('See `memory/topics/auto-hygiene/product-reference.md` for the detailed Product Reference notes.');
    expect(rewrittenReadme).not.toContain(longReference);

    const topic = await fs.readFile(
      path.join(coreDir, 'Chief-of-Staff', 'memory', 'topics', 'auto-hygiene', 'product-reference.md'),
      'utf8',
    );
    expect(topic).toContain('# Product Reference');
    expect(topic).toContain('Moved from `README.md` by Chief-of-Staff hygiene on 2026-05-19.');
    expect(topic).toContain(longReference.trim());

    const backup = await fs.readFile(result.backupPath!, 'utf8');
    expect(backup).toBe(readme);
    const manifest = JSON.parse(await fs.readFile(result.manifestPath!, 'utf8')) as ChiefOfStaffHygieneRunManifest;
    expect(manifest.afterHash).toBeDefined();
    expect(manifest.afterBytes).toBe(Buffer.byteLength(rewrittenReadme, 'utf8'));
    expect(manifest.filesCreated).toEqual(result.filesCreated);
    expect(manifest.filesRewritten).toHaveLength(1);
    expect(manifest.sectionsMoved).toEqual([
      expect.objectContaining({
        heading: 'Product Reference',
        topicPath: 'Chief-of-Staff/memory/topics/auto-hygiene/product-reference.md',
      }),
    ]);
  });

  it('rejects rewrite targets that traverse symlinks before writing backups or topics', async () => {
    const outsideDir = path.join(tmpDir, 'outside-chief');
    await writeFile(path.join(outsideDir, 'README.md'), `# Chief of Staff

## Reference
${'Detailed project note. '.repeat(100)}
`);
    const linkedDir = path.join(coreDir, 'Chief-of-Staff');
    await fs.rm(linkedDir, { recursive: true, force: true });
    try {
      await fs.symlink(outsideDir, linkedDir, 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw error;
    }

    await expect(rewriteChiefOfStaffReadmeSafeSections(coreDir, path.join(linkedDir, 'README.md'), {
      thresholds: { maxSectionCharacters: 300 },
    })).rejects.toThrow('must not traverse symlinks');
    await expect(fs.readdir(path.join(coreDir, '.rebel'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('is idempotent after the first rewrite', async () => {
    await writeFile(readmePath, `# Chief of Staff

## Reference
${'Detailed note. '.repeat(100)}
`);

    await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      runId: 'first',
      thresholds: { maxSectionCharacters: 300 },
    });
    const afterFirstReadme = await fs.readFile(readmePath, 'utf8');
    const topicPath = path.join(coreDir, 'Chief-of-Staff', 'memory', 'topics', 'auto-hygiene', 'reference.md');
    const afterFirstTopic = await fs.readFile(topicPath, 'utf8');

    const second = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      runId: 'second',
      thresholds: { maxSectionCharacters: 300 },
    });

    expect(second.changed).toBe(false);
    await expect(fs.readFile(readmePath, 'utf8')).resolves.toBe(afterFirstReadme);
    await expect(fs.readFile(topicPath, 'utf8')).resolves.toBe(afterFirstTopic);
  });

  it('aborts instead of overwriting when README changes during rewrite', async () => {
    await writeFile(readmePath, `# Chief of Staff

## Current product context
${'- Product roadmap context can move to private topic memory. '.repeat(20)}
`);

    await expect(rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
      distiller: async () => {
        // Await the append before returning so the README is observably
        // changed by the time the rewrite reaches its abort-check re-read.
        // The previous setTimeout(0) + non-awaited appendFile depended on
        // event-loop ordering between a macrotask and the abort-check
        // microtask chain, which raced on slower CI runners and let the
        // rewrite complete instead of aborting.
        await fs.appendFile(readmePath, '\n## Manual edit\nDo not lose this concurrent edit.\n');
        return null;
      },
    })).rejects.toThrow('changed during hygiene rewrite');

    await expect(fs.readFile(readmePath, 'utf8')).resolves.toContain('Do not lose this concurrent edit.');
    const runIds = await fs.readdir(path.join(coreDir, '.rebel', 'chief-of-staff-hygiene', 'runs'));
    expect(runIds).toHaveLength(1);
    const manifest = JSON.parse(await fs.readFile(
      path.join(coreDir, '.rebel', 'chief-of-staff-hygiene', 'runs', runIds[0], 'manifest.json'),
      'utf8',
    )) as ChiefOfStaffHygieneRunManifest;
    expect(manifest.failures).toContain('README changed during Chief-of-Staff hygiene rewrite; aborted before overwriting.');
  });

  it('archives stale current-priority sections inside private auto-hygiene topics', async () => {
    await writeFile(readmePath, `# Chief of Staff

## Current Priorities
2026-01-01

- Follow up on old launch admin.
- Move this out of the main README once stale.

## Useful
Still useful.
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      now: new Date('2026-05-19T10:00:00.000Z'),
      thresholds: { staleCurrentSectionAgeDays: 45 },
    });

    expect(result.changed).toBe(true);
    expect(result.filesCreated).toEqual([
      'Chief-of-Staff/memory/topics/auto-hygiene/archive/current-priorities.md',
    ]);
    const rewrittenReadme = await fs.readFile(readmePath, 'utf8');
    expect(rewrittenReadme).toContain(
      'Archived stale Current Priorities notes in `memory/topics/auto-hygiene/archive/current-priorities.md`.',
    );
    expect(rewrittenReadme).not.toContain('Follow up on old launch admin.');
    const archive = await fs.readFile(
      path.join(coreDir, 'Chief-of-Staff', 'memory', 'topics', 'auto-hygiene', 'archive', 'current-priorities.md'),
      'utf8',
    );
    expect(archive).toContain('Archived from `README.md` by Chief-of-Staff hygiene on 2026-05-19.');
    expect(archive).toContain('Follow up on old launch admin.');

    const second = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      now: new Date('2026-05-19T10:00:00.000Z'),
      thresholds: { staleCurrentSectionAgeDays: 45 },
    });
    expect(second.changed).toBe(false);
  });

  it('archives explicit expired sections without asking', async () => {
    await writeFile(readmePath, `# Chief of Staff

## Launch Project Notes
expires: 2026-05-01

- Project launch context for the now-finished rollout.

## Useful
Still useful.
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      now: new Date('2026-05-19T10:00:00.000Z'),
    });

    expect(result.changed).toBe(true);
    expect(result.filesCreated).toEqual([
      'Chief-of-Staff/memory/topics/auto-hygiene/archive/launch-project-notes.md',
    ]);
    const rewrittenReadme = await fs.readFile(readmePath, 'utf8');
    expect(rewrittenReadme).toContain(
      'Archived expired Launch Project Notes notes in `memory/topics/auto-hygiene/archive/launch-project-notes.md`.',
    );
    expect(rewrittenReadme).not.toContain('now-finished rollout');
  });

  it('archives expired work-context blocks and leaves future blocks in README', async () => {
    await writeFile(readmePath, `# Chief of Staff

## Current project context
- Project launch detail that is still active. expires: 260601
- Customer pilot detail that is now obsolete. expires: 260501
- Project roadmap detail without expiry stays put.
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      now: new Date('2026-05-19T10:00:00.000Z'),
    });

    expect(result.changed).toBe(true);
    expect(result.filesCreated).toEqual([
      'Chief-of-Staff/memory/topics/auto-hygiene/archive/current-project-context-expired.md',
    ]);
    const rewrittenReadme = await fs.readFile(readmePath, 'utf8');
    expect(rewrittenReadme).toContain('Project launch detail that is still active');
    expect(rewrittenReadme).toContain('Project roadmap detail without expiry stays put');
    expect(rewrittenReadme).not.toContain('Customer pilot detail that is now obsolete');
    const archive = await fs.readFile(
      path.join(coreDir, 'Chief-of-Staff', 'memory', 'topics', 'auto-hygiene', 'archive', 'current-project-context-expired.md'),
      'utf8',
    );
    expect(archive).toContain('Customer pilot detail that is now obsolete');
  });

  it('does not apply expiry markers to risky identity sections', async () => {
    await writeFile(readmePath, `# Chief of Staff

## Profile
- My project preference should stay here even with a marker. expires: 260501
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      now: new Date('2026-05-19T10:00:00.000Z'),
    });

    expect(result.changed).toBe(false);
    expect(result.skippedRiskyItems).toEqual([
      expect.objectContaining({ heading: 'Profile' }),
    ]);
    await expect(fs.readFile(readmePath, 'utf8')).resolves.toContain('My project preference should stay here');
  });

  it('partially extracts safe blocks from mixed current-context sections without asking', async () => {
    const safeBlock = '- Product launch detail that is useful background reference for upcoming roadmap work. '.repeat(20);
    await writeFile(readmePath, `# Chief of Staff

## Current operational facts
- My preference is to keep approval-sensitive personal facts in README.
${safeBlock}
- Goal-related facts stay in the README and should not move.
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
      now: new Date('2026-05-19T10:00:00.000Z'),
    });

    expect(result.changed).toBe(true);
    expect(result.filesCreated).toEqual([
      'Chief-of-Staff/memory/topics/auto-hygiene/current-operational-facts.md',
    ]);
    const rewrittenReadme = await fs.readFile(readmePath, 'utf8');
    expect(rewrittenReadme).toContain('My preference is to keep approval-sensitive personal facts in README.');
    expect(rewrittenReadme).toContain('Goal-related facts stay in the README and should not move.');
    expect(rewrittenReadme).toContain(
      'See `memory/topics/auto-hygiene/current-operational-facts.md` for the detailed Current operational facts notes.',
    );
    expect(rewrittenReadme).not.toContain('Product launch detail that is useful background');
    const topic = await fs.readFile(
      path.join(coreDir, 'Chief-of-Staff', 'memory', 'topics', 'auto-hygiene', 'current-operational-facts.md'),
      'utf8',
    );
    expect(topic).toContain('Product launch detail that is useful background');
    expect(topic).not.toContain('My preference is to keep approval-sensitive personal facts in README.');

  });

  it('keeps plural credential/security blocks in README during partial extraction', async () => {
    const safeBlock = '- Operational rollout detail that can move to a topic as background reference material. '.repeat(20);
    await writeFile(readmePath, `# Chief of Staff

## Current operational facts
- Store these credentials, tokens, passwords, secrets, security notes, and API-key rotation in the README.
${safeBlock}
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
    });

    expect(result.changed).toBe(true);
    const rewrittenReadme = await fs.readFile(readmePath, 'utf8');
    expect(rewrittenReadme).toContain('Store these credentials, tokens, passwords, secrets, security notes, and API-key rotation');
    const topic = await fs.readFile(
      path.join(coreDir, 'Chief-of-Staff', 'memory', 'topics', 'auto-hygiene', 'current-operational-facts.md'),
      'utf8',
    );
    expect(topic).toContain('Operational rollout detail that can move');
    expect(topic).not.toContain('credentials, tokens, passwords, secrets, security notes, and API-key rotation');
  });

  it('keeps ambiguous first-person blocks in README during partial extraction', async () => {
    const safeBlock = '- Product roadmap context that can move to a topic as background reference material. '.repeat(20);
    await writeFile(readmePath, `# Chief of Staff

## Current product context
- I want this vague personal note to stay in README until it is clearly classified.
${safeBlock}
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
    });

    expect(result.changed).toBe(true);
    const rewrittenReadme = await fs.readFile(readmePath, 'utf8');
    expect(rewrittenReadme).toContain('I want this vague personal note to stay in README');
    const topic = await fs.readFile(
      path.join(coreDir, 'Chief-of-Staff', 'memory', 'topics', 'auto-hygiene', 'current-product-context.md'),
      'utf8',
    );
    expect(topic).toContain('Product roadmap context');
    expect(topic).not.toContain('I want this vague personal note');
  });

  it('keeps topic-backed sharing-boundary work blocks pinned during partial extraction', async () => {
    const topicBackedSoftRisk = [
      '- **Security readiness work**: Shared meeting notes gap and security readiness context for an active product rollout. ',
      'The operational detail is already backed by a topic and should not remain fully pinned. ',
      'See [[topics/Security-Readiness-Rollout]]. ',
      'Additional product rollout, support handoff, customer success, research, and operational context repeats here. '.repeat(8),
    ].join('');
    await writeFile(readmePath, `# Chief of Staff

## Current operational facts
- Potential Washington DC move remains confidential and stays in PERSONAL only.

${topicBackedSoftRisk}
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
    });

    expect(result.changed).toBe(false);
    const rewrittenReadme = await fs.readFile(readmePath, 'utf8');
    expect(rewrittenReadme).toContain('Potential Washington DC move remains confidential');
    expect(rewrittenReadme).toContain('Security readiness work');
  });

  it('extracts setup and template cruft sections into private topics', async () => {
    await writeFile(readmePath, `# Chief of Staff

## Setup (first run)
- Ensure a Rebel workspace folder exists.
- Ensure subfolders exist: skills/, memory/, scripts/.

## Profile
Stable identity stays pinned.

## Variable Placeholders
If you encounter capitalized curly-brace variables, ask the user to provide them.
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath);

    expect(result.changed).toBe(true);
    expect(result.filesCreated).toEqual([
      'Chief-of-Staff/memory/topics/auto-hygiene/setup-first-run.md',
      'Chief-of-Staff/memory/topics/auto-hygiene/variable-placeholders.md',
    ]);
    const rewrittenReadme = await fs.readFile(readmePath, 'utf8');
    expect(rewrittenReadme).toContain('Stable identity stays pinned.');
    expect(rewrittenReadme).not.toContain('Ensure a Rebel workspace folder exists');
    expect(rewrittenReadme).not.toContain('capitalized curly-brace variables');
  });

  it('does not extract privacy or sharing-boundary sections as template cruft', async () => {
    await writeFile(readmePath, `# Chief of Staff

## Safety & Privacy
- Do not move private notes into shared spaces without explicit permission.
- Keep confidential user facts in Chief-of-Staff.
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 80 },
    });

    expect(result.changed).toBe(false);
    await expect(fs.readFile(readmePath, 'utf8')).resolves.toContain(
      'Do not move private notes into shared spaces without explicit permission.',
    );
  });

  it('keeps sharing and permission boundary facts pinned even when topic-backed', async () => {
    const boundaryBlock = [
      '- **Shared permissions boundary**: This product rollout context says private notes must not move to shared spaces without explicit permission. ',
      'See [[topics/Memory-Boundaries-UX-Sprint-Dec2025]]. ',
      'Additional product roadmap, operational context, customer support detail, and implementation notes repeat here. '.repeat(8),
    ].join('');
    await writeFile(readmePath, `# Chief of Staff

## Current operational facts
${boundaryBlock}
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
    });

    expect(result.changed).toBe(false);
    await expect(fs.readFile(readmePath, 'utf8')).resolves.toContain('private notes must not move to shared spaces');
  });

  it('compresses long topic-backed work-context blocks without relying on order', async () => {
    const roiDetail = [
      '- **ROI Dashboard (UPDATED 2026-05-11)**: Dashboard project detail for the active product roadmap. ',
      'The detailed personas, rollout decisions, data model notes, PostHog-first approach, timeline, team feedback loops, ',
      'and shared Space staging notes are useful background but do not need to stay pinned in full every turn. ',
      'This bottom-loaded important detail must be preserved even though it is not near the top. ',
      'The same detailed operating context continues with research findings, product constraints, dashboard rollout sequencing, ',
      'customer value proof notes, and design review context that should remain saved but not always loaded. ',
      'See [[topics/ROI-Dashboard-Initiative]]. [2026-05-11]',
    ].join('');
    const learningDetail = [
      '- **Learning Platform Bugs**: Project context for accumulated bugs after migration. ',
      'Important product detail sits at the bottom of the section and should still be retained through topic-backed compression, ',
      'not dropped because of position or a character budget. ',
      'The block includes migration follow-up, product testing notes, roadmap triage, and project context for future retrieval. ',
      'It is important, but topic memory is the right retrieval surface. ',
      'See [[topics/Learning-Platform-Launch-May2026]]. [2026-05-18]',
    ].join('');
    await writeFile(readmePath, `# Chief of Staff

## Current product context
${roiDetail}

- **Pinned preference**: My preference is for direct design critique to stay visible even when this line is long. ${'Keep this pinned. '.repeat(40)} See [[topics/Design-Preferences]].

${learningDetail}
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
      now: new Date('2026-05-19T10:00:00.000Z'),
    });

    expect(result.changed).toBe(true);
    expect(result.filesCreated).toEqual([
      'Chief-of-Staff/memory/topics/auto-hygiene/current-product-context.md',
    ]);
    const rewrittenReadme = await fs.readFile(readmePath, 'utf8');
    expect(rewrittenReadme).toContain(
      'See `memory/topics/auto-hygiene/current-product-context.md` for the detailed Current product context notes.',
    );
    expect(rewrittenReadme).toContain('My preference is for direct design critique to stay visible');

    const topic = await fs.readFile(
      path.join(coreDir, 'Chief-of-Staff', 'memory', 'topics', 'auto-hygiene', 'current-product-context.md'),
      'utf8',
    );
    expect(topic).toContain('Learning Platform Bugs');
  });

  it('moves long private work-context blocks even without existing topic or source references', async () => {
    const unbackedDetail = [
      '- **Unbacked product detail**: Project detail can be important even when it appears late in the section. ',
      'Without an existing topic or source reference, automatic hygiene creates the retrieval pointer itself. ',
      'The full wording is preserved in topic memory while the README becomes a short signpost. ',
      'This long work context repeats product roadmap, design review, customer rollout, migration, research, and support details. ',
      'More important product context appears at the bottom and remains preserved in the created topic. ',
    ].join('');
    await writeFile(readmePath, `# Chief of Staff

## Current product context
${unbackedDetail}
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
    });

    expect(result.changed).toBe(true);
    expect(result.filesCreated).toEqual([
      'Chief-of-Staff/memory/topics/auto-hygiene/current-product-context.md',
    ]);
    await expect(fs.readFile(readmePath, 'utf8')).resolves.toContain(
      'See `memory/topics/auto-hygiene/current-product-context.md` for the detailed Current product context notes.',
    );
    await expect(fs.readFile(readmePath, 'utf8')).resolves.not.toContain(
      'More important product context appears at the bottom',
    );
    await expect(fs.readFile(
      path.join(coreDir, 'Chief-of-Staff', 'memory', 'topics', 'auto-hygiene', 'current-product-context.md'),
      'utf8',
    )).resolves.toContain(
      'More important product context appears at the bottom',
    );
  });

  it('moves product-context sections wholesale when they are private and non-risky', async () => {
    await writeFile(readmePath, `# Chief of Staff

## Product context
${'Product roadmap context without a topic reference now gains a retrieval pointer through automatic hygiene. '.repeat(20)}
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
    });

    expect(result.changed).toBe(true);
    expect(result.filesCreated).toEqual([
      'Chief-of-Staff/memory/topics/auto-hygiene/product-context.md',
    ]);
    await expect(fs.readFile(readmePath, 'utf8')).resolves.toContain(
      'See `memory/topics/auto-hygiene/product-context.md` for the detailed Product context notes.',
    );
    await expect(fs.readFile(readmePath, 'utf8')).resolves.not.toContain(
      'Product roadmap context without a topic reference',
    );
    await expect(fs.readFile(
      path.join(coreDir, 'Chief-of-Staff', 'memory', 'topics', 'auto-hygiene', 'product-context.md'),
      'utf8',
    )).resolves.toContain(
      'Product roadmap context without a topic reference',
    );
  });

  it('distils mixed private work-context blocks when deterministic extraction would skip them', async () => {
    const mixedPrivateContext = [
      '- **Atlas rollout**: Private company/team rollout context for an active product integration. ',
      'The customer pilot has security, support, product roadmap, and operational sequencing details that should not stay fully pinned. ',
      'Priya owns technical validation, Luca owns commercial follow-up, the next action is the revised security questionnaire, ',
      'and the key risk is SSO timing slipping into the pilot window. ',
      'This private team context repeats implementation notes, rollout history, customer success background, and product decisions. ',
      'More operational rollout detail keeps the block large enough for structured distillation while still staying inside private memory. ',
      'The same private company context includes product research, support handoff notes, launch sequencing, and customer pilot history. ',
      'Additional private company rollout detail, support handoff context, customer pilot history, and product roadmap notes. '.repeat(6),
    ].join('');
    await writeFile(readmePath, `# Chief of Staff

## Current operational facts
${mixedPrivateContext}
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
      now: new Date('2026-05-19T10:00:00.000Z'),
      distiller: async (_request) => ({
        promptVersion: CHIEF_OF_STAFF_DISTILLATION_PROMPT_VERSION,
        bullets: [
          `Atlas rollout status: Priya owns validation; Luca owns follow-up; next action is the security questionnaire; risk is SSO timing for the pilot`,
        ],
      }),
    });

    expect(result.changed).toBe(true);
    expect(result.sectionsDistilled).toEqual([
      expect.objectContaining({
        heading: 'Current operational facts: Atlas rollout',
        promptVersion: CHIEF_OF_STAFF_DISTILLATION_PROMPT_VERSION,
      }),
    ]);
    expect(result.filesCreated).toEqual([
      'Chief-of-Staff/memory/topics/auto-hygiene/current-operational-facts-atlas-rollout.md',
    ]);
    const rewrittenReadme = await fs.readFile(readmePath, 'utf8');
    expect(rewrittenReadme).toContain(
      '- Atlas rollout status: Priya owns validation; Luca owns follow-up; next action is the security questionnaire; risk is SSO timing for the pilot See `memory/topics/auto-hygiene/current-operational-facts-atlas-rollout.md`.',
    );
    expect(rewrittenReadme).not.toContain('The customer pilot has security, support');
    const topic = await fs.readFile(
      path.join(coreDir, 'Chief-of-Staff', 'memory', 'topics', 'auto-hygiene', 'current-operational-facts-atlas-rollout.md'),
      'utf8',
    );
    expect(topic).toContain('Priya owns technical validation');
    expect(topic).toContain('Luca owns commercial follow-up');

    const manifest = JSON.parse(await fs.readFile(result.manifestPath!, 'utf8')) as ChiefOfStaffHygieneRunManifest;
    expect(manifest.sectionsDistilled).toEqual([
      expect.objectContaining({
        heading: 'Current operational facts: Atlas rollout',
        topicPath: 'Chief-of-Staff/memory/topics/auto-hygiene/current-operational-facts-atlas-rollout.md',
      }),
    ]);

    const second = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
      now: new Date('2026-05-19T10:00:00.000Z'),
      distiller: async () => {
        throw new Error('distiller should not run after idempotent rewrite');
      },
    });
    expect(second.changed).toBe(false);
  });

  it('distils private agent/prompt work context without treating it as stable instructions', async () => {
    const promptWorkContext = [
      '- **Agent prompt rollout**: Private team/company context for an active agent prompt migration. ',
      'This is product work context, not a stable instruction to Rebel. ',
      'Priya owns validation, Luca owns launch follow-up, the next action is to compare prompt eval output by 2026-05-22, ',
      'and the key risk is prompt drift during the pilot. ',
      'Additional agent prompt research, customer pilot notes, product roadmap context, support handoff, and engineering rollout detail. '.repeat(6),
    ].join('');
    await writeFile(readmePath, `# Chief of Staff

## Current product context
${promptWorkContext}
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
      distiller: async () => ({
        promptVersion: CHIEF_OF_STAFF_DISTILLATION_PROMPT_VERSION,
        bullets: [
          'Agent prompt rollout status active: Priya owns validation; Luca owns launch follow-up; next action is prompt eval comparison by 2026-05-22; risk is prompt drift',
        ],
      }),
    });

    expect(result.changed).toBe(true);
    expect(result.sectionsDistilled).toEqual([
      expect.objectContaining({
        heading: 'Current product context: Agent prompt rollout',
      }),
    ]);
    await expect(fs.readFile(readmePath, 'utf8')).resolves.not.toContain('Additional agent prompt research');
  });

  it('lets distillation shrink large mixed sections before partial extraction claims the whole section', async () => {
    const extractableSmallBlock = '- Product launch detail that is useful background reference for upcoming roadmap work. '.repeat(8);
    const distillableLargeBlock = [
      '- **Atlas rollout**: Private company/team rollout context for an active product integration. ',
      'Priya owns technical validation, Luca owns commercial follow-up, the next action is the revised security questionnaire by 2026-05-22, ',
      'and the key risk is SSO timing slipping into the pilot window. ',
      'Additional product roadmap, customer success, operational sequencing, research, and support context repeats here. '.repeat(12),
    ].join('');
    await writeFile(readmePath, `# Chief of Staff

## Current operational facts
${extractableSmallBlock}

${distillableLargeBlock}
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
      distiller: async () => ({
        promptVersion: CHIEF_OF_STAFF_DISTILLATION_PROMPT_VERSION,
        bullets: [
          'Atlas rollout status active: Priya owns validation; Luca owns follow-up; next action is security questionnaire by 2026-05-22; risk is SSO timing',
        ],
      }),
    });

    expect(result.changed).toBe(true);
    expect(result.sectionsDistilled).toHaveLength(1);
    expect(result.filesCreated[0]).toContain('current-operational-facts-');
    const rewrittenReadme = await fs.readFile(readmePath, 'utf8');
    expect(rewrittenReadme).toContain('Atlas rollout status active');
    expect(rewrittenReadme).not.toContain('See `memory/topics/auto-hygiene/current-operational-facts.md` for the detailed Current operational facts notes.');
  });

  it('falls back to lossless topic extraction when distillation rejects the output', async () => {
    const mixedPrivateContext = [
      '- **Atlas rollout**: Private company/team rollout context for an active product integration. ',
      'Priya owns technical validation, the next action is the revised security questionnaire, ',
      'and the key risk is SSO timing slipping into the pilot window. ',
      'Additional product roadmap, customer success, operational sequencing, research, and support context repeats here. ',
      'More private team context keeps this block above the structured distillation threshold. ',
      'The same private company context includes implementation history, design follow-up, launch sequencing, and customer pilot notes. ',
      'Additional private company rollout detail, support handoff context, customer pilot history, and product roadmap notes. '.repeat(6),
    ].join('');
    await writeFile(readmePath, `# Chief of Staff

## Current operational facts
${mixedPrivateContext}
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
      distiller: async () => null,
    });

    expect(result.changed).toBe(true);
    expect(result.sectionsDistilled).toEqual([]);
    expect(result.skippedRiskyItems).toEqual([
      expect.objectContaining({
        heading: 'Current operational facts',
        reason: 'distillation_output_rejected',
      }),
    ]);
    await expect(fs.readFile(readmePath, 'utf8')).resolves.toContain(
      'See `memory/topics/auto-hygiene/current-operational-facts.md` for the detailed Current operational facts notes.',
    );
    await expect(fs.readFile(
      path.join(coreDir, 'Chief-of-Staff', 'memory', 'topics', 'auto-hygiene', 'current-operational-facts.md'),
      'utf8',
    )).resolves.toContain('Priya owns technical validation');
  });

  it('rejects over-reduced distillation that drops active-work essentials', async () => {
    const mixedPrivateContext = [
      '- **Meridian onboarding**: Private company/team onboarding context for an active product integration. ',
      'Priya owns technical validation, Luca owns commercial follow-up, the next action is to send the revised security questionnaire by 2026-05-22, ',
      'and the key risk is SSO timing slipping into the pilot window. ',
      'Additional product roadmap, support handoff, operational sequencing, customer success, and research context repeats here. '.repeat(6),
    ].join('');
    await writeFile(readmePath, `# Chief of Staff

## Current operational facts
${mixedPrivateContext}
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
      distiller: async () => ({
        promptVersion: CHIEF_OF_STAFF_DISTILLATION_PROMPT_VERSION,
        bullets: ['Meridian onboarding status: active'],
      }),
    });

    expect(result.changed).toBe(true);
    expect(result.sectionsDistilled).toEqual([]);
    expect(result.skippedRiskyItems).toEqual([
      expect.objectContaining({
        heading: 'Current operational facts',
        reason: expect.stringContaining('distillation_output_rejected'),
      }),
    ]);
    await expect(fs.readFile(readmePath, 'utf8')).resolves.not.toContain('Priya owns technical validation');
    await expect(fs.readFile(
      path.join(coreDir, 'Chief-of-Staff', 'memory', 'topics', 'auto-hygiene', 'current-operational-facts.md'),
      'utf8',
    )).resolves.toContain('Priya owns technical validation');
  });

  it('rejects generic active-work placeholders that keep labels but drop concrete facts', async () => {
    const mixedPrivateContext = [
      '- **Meridian onboarding**: Private company/team onboarding context for an active product integration. ',
      'Priya owns technical validation, Luca owns commercial follow-up, the next action is to send the revised security questionnaire by 2026-05-22, ',
      'and the key risk is SSO timing slipping into the pilot window. ',
      'Additional product roadmap, support handoff, operational sequencing, customer success, and research context repeats here. '.repeat(6),
    ].join('');
    await writeFile(readmePath, `# Chief of Staff

## Current operational facts
${mixedPrivateContext}
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
      distiller: async () => ({
        promptVersion: CHIEF_OF_STAFF_DISTILLATION_PROMPT_VERSION,
        bullets: ['Owner TBD; next action follow-up by 2026-05-22; risk to monitor; status active'],
      }),
    });

    expect(result.changed).toBe(true);
    expect(result.sectionsDistilled).toEqual([]);
    expect(result.skippedRiskyItems).toEqual([
      expect.objectContaining({
        heading: 'Current operational facts',
        reason: expect.stringContaining('distillation_output_rejected'),
      }),
    ]);
    await expect(fs.readFile(readmePath, 'utf8')).resolves.not.toContain('SSO timing slipping into the pilot window');
    await expect(fs.readFile(
      path.join(coreDir, 'Chief-of-Staff', 'memory', 'topics', 'auto-hygiene', 'current-operational-facts.md'),
      'utf8',
    )).resolves.toContain('SSO timing slipping into the pilot window');
  });

  it('caps distillation candidates per run and defers the rest', async () => {
    const makeBlock = (name: string): string => [
      `- **${name}**: Private company/team context for an active product rollout. `,
      `${name} has product roadmap, customer success, research, operational sequencing, and support details that should move out of always-loaded context. `,
      `Priya owns validation for ${name}, the next action is the rollout checklist by 2026-05-22, and the key risk is pilot timing. `,
      'Additional private company rollout detail, support handoff context, customer pilot history, and product roadmap notes. '.repeat(5),
    ].join('');
    let distillerCalls = 0;
    await writeFile(readmePath, `# Chief of Staff

## Current operational facts
${makeBlock('Atlas rollout')}
${makeBlock('Meridian onboarding')}
${makeBlock('Nova pilot')}
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
      maxDistillationCandidates: 1,
      distiller: async () => {
        distillerCalls += 1;
        return {
          promptVersion: CHIEF_OF_STAFF_DISTILLATION_PROMPT_VERSION,
          bullets: ['Rollout status: Priya owns validation; next action is checklist by 2026-05-22; risk is pilot timing'],
        };
      },
    });

    expect(distillerCalls).toBe(1);
    expect(result.changed).toBe(true);
    expect(result.sectionsDistilled).toHaveLength(1);
    expect(result.skippedRiskyItems.filter((item) => item.reason === 'distillation_candidate_deferred')).toHaveLength(2);
  });

  it('prioritizes largest medium-sized distillation candidates first', async () => {
    const makeBlock = (name: string, repeats: number): string => [
      `- **${name}**: Private team context for active product work. `,
      `Priya owns validation for ${name}, the next action is the rollout checklist by 2026-05-22, and the key risk is pilot timing. `,
      'Additional product, support, research, and operational context. '.repeat(repeats),
    ].join('');
    await writeFile(readmePath, `# Chief of Staff

## Current operational facts
${makeBlock('Small pilot', 2)}
${makeBlock('Largest rollout', 5)}
${makeBlock('Medium migration', 3)}
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
      maxDistillationCandidates: 1,
      distiller: async () => ({
        promptVersion: CHIEF_OF_STAFF_DISTILLATION_PROMPT_VERSION,
        bullets: ['Active status: Priya owns validation; next action is rollout checklist by 2026-05-22; risk is pilot timing'],
      }),
    });

    expect(result.changed).toBe(true);
    expect(result.sectionsDistilled).toEqual([
      expect.objectContaining({
        heading: 'Current operational facts: Largest rollout',
      }),
    ]);
    expect(result.filesCreated).toEqual([
      'Chief-of-Staff/memory/topics/auto-hygiene/current-operational-facts-largest-rollout.md',
    ]);
    expect(result.skippedRiskyItems.filter((item) => item.reason === 'distillation_candidate_deferred')).toHaveLength(2);
  });

  it('keeps standalone personal topic-backed blocks pinned', async () => {
    const personalDetail = [
      '- **Personal relocation context**: Personal planning detail should remain pinned and not be compressed just because it links to a topic. ',
      'This is personal context with sensitive planning implications, so a short signpost would hide important boundary information. ',
      'The block is intentionally long enough to cross the compression threshold and includes work-context words like project and meeting. ',
      'See [[topics/Personal-Planning]]. [2026-05-19]',
    ].join('');
    await writeFile(readmePath, `# Chief of Staff

## Current operational facts
${personalDetail}
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
    });

    expect(result.changed).toBe(false);
    await expect(fs.readFile(readmePath, 'utf8')).resolves.toContain('Personal planning detail should remain pinned');
  });

  it('rejects generated topic paths that would traverse symlinks', async () => {
    const outsideTopics = path.join(tmpDir, 'outside-topics');
    await fs.mkdir(outsideTopics, { recursive: true });
    const topicRoot = path.join(coreDir, 'Chief-of-Staff', 'memory', 'topics');
    await fs.mkdir(topicRoot, { recursive: true });
    try {
      await fs.symlink(outsideTopics, path.join(topicRoot, 'auto-hygiene'), 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw error;
    }
    await writeFile(readmePath, `# Chief of Staff

## Reference
${'Detailed note. '.repeat(100)}
`);

    await expect(rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
    })).rejects.toThrow('must not traverse symlinks');
    await expect(fs.readdir(outsideTopics)).resolves.toEqual([]);
  });

  it('does not overwrite pre-existing or same-run colliding topic files', async () => {
    const existingTopic = path.join(
      coreDir,
      'Chief-of-Staff',
      'memory',
      'topics',
      'auto-hygiene',
      'project-reference.md',
    );
    await writeFile(existingTopic, '# Existing\nDo not replace this.\n');
    await writeFile(readmePath, `# Chief of Staff

## Project Reference
${'First detailed note. '.repeat(80)}

## Project: Reference
${'Second detailed note. '.repeat(80)}
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
    });

    expect(result.changed).toBe(true);
    expect(result.filesCreated).toEqual([
      'Chief-of-Staff/memory/topics/auto-hygiene/project-reference-2.md',
      'Chief-of-Staff/memory/topics/auto-hygiene/project-reference-3.md',
    ]);
    await expect(fs.readFile(existingTopic, 'utf8')).resolves.toBe('# Existing\nDo not replace this.\n');
    await expect(fs.readFile(path.join(path.dirname(existingTopic), 'project-reference-2.md'), 'utf8')).resolves.toContain(
      'First detailed note.',
    );
    await expect(fs.readFile(path.join(path.dirname(existingTopic), 'project-reference-3.md'), 'utf8')).resolves.toContain(
      'Second detailed note.',
    );
  });

  it('removes exact duplicate instruction blocks without touching the first copy', async () => {
    const instructionBlock = [
      'Rebel assistant should keep responses short, clear, and directly useful for the user.',
      'Rebel assistant should avoid unnecessary process notes and should preserve important context.',
      'Rebel assistant must not invent facts from weak evidence.',
    ].join('\n');
    await writeFile(readmePath, `# Chief of Staff

## Operating Notes
${instructionBlock}

## Repeated Operating Notes
${instructionBlock}

## Useful
Keep this.
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { duplicateInstructionBlockMinCharacters: 80 },
    });

    expect(result.changed).toBe(true);
    expect(result.filesCreated).toEqual([]);
    expect(result.sectionsMoved).toEqual([]);
    expect(result.duplicateBlocksRemoved).toBe(1);
    const rewrittenReadme = await fs.readFile(readmePath, 'utf8');
    expect(rewrittenReadme.match(/Rebel assistant should keep responses short/g)).toHaveLength(1);
    expect(rewrittenReadme).toContain('## Operating Notes');
    expect(rewrittenReadme).toContain('## Repeated Operating Notes');
    const manifest = JSON.parse(await fs.readFile(result.manifestPath!, 'utf8')) as ChiefOfStaffHygieneRunManifest;
    expect(manifest.duplicateBlocksRemoved).toBe(1);
  });

  it('skips risky profile and sharing-boundary sections instead of rewriting them', async () => {
    await writeFile(readmePath, `# Chief of Staff

## Identity
${'Stable identity fact. '.repeat(80)}

## Useful Context
${'My preference is to keep this always loaded. '.repeat(80)}

## Team Sharing Notes
${'This private note mentions shared team permissions. '.repeat(80)}

## Credentials
${'API reference details. '.repeat(80)}

## Security
${'Rotation notes. '.repeat(80)}

## API Keys
${'Integration reference details. '.repeat(80)}

## Privacy
${'Boundary notes. '.repeat(80)}
`);

    const result = await rewriteChiefOfStaffReadmeSafeSections(coreDir, readmePath, {
      thresholds: { maxSectionCharacters: 300 },
    });

    expect(result.changed).toBe(false);
    expect(result.backupPath).toBeNull();
    expect(result.skippedRiskyItems).toEqual([
      expect.objectContaining({ heading: 'Identity' }),
      expect.objectContaining({ heading: 'Useful Context' }),
      expect.objectContaining({ heading: 'Team Sharing Notes' }),
      expect.objectContaining({ heading: 'Credentials' }),
      expect.objectContaining({ heading: 'Security' }),
      expect.objectContaining({ heading: 'API Keys' }),
      expect.objectContaining({ heading: 'Privacy' }),
    ]);
  });

  it('rejects rewrite targets outside the workspace and non-README files', async () => {
    const outsideReadme = path.join(tmpDir, 'outside', 'README.md');
    const nonReadme = path.join(coreDir, 'Chief-of-Staff', 'notes.md');
    await writeFile(outsideReadme, '# Outside\n');
    await writeFile(nonReadme, 'notes');

    await expect(rewriteChiefOfStaffReadmeSafeSections(coreDir, outsideReadme)).rejects.toThrow(
      'must stay inside the workspace',
    );
    await expect(rewriteChiefOfStaffReadmeSafeSections(coreDir, nonReadme)).rejects.toThrow(
      'must be a README.md file',
    );
  });
});
