import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createReadmeHash,
  evaluateChiefOfStaffReadmeHygiene,
  evaluateChiefOfStaffReadmeHygieneFile,
} from '../chiefOfStaffHygieneEligibilityService';

describe('chiefOfStaffHygieneEligibilityService', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-hygiene-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns a healthy no-op for a concise signpost-style README', () => {
    const result = evaluateChiefOfStaffReadmeHygiene(`# Chief of Staff

## Profile
Melissa works on Rebel product strategy and design.

## AI working context
- See memory/topics/product-strategy.md for current product direction.
- See memory/topics/customer-research.md for recent research themes.
`);

    expect(result.eligible).toBe(false);
    expect(result.triggerReasons).toEqual([]);
    expect(result.noOpReason).toBe('healthy');
    expect(result.metrics.byteSize).toBeGreaterThan(0);
    expect(result.metrics.readmeHash).toHaveLength(64);
    expect(result.riskIndicators).toEqual([]);
  });

  it('detects oversized README and excessive section triggers without rewriting content', () => {
    const longReference = 'Detailed project note. '.repeat(160);
    const result = evaluateChiefOfStaffReadmeHygiene(`# Chief of Staff

## Project Reference
${longReference}
`, {
      thresholds: {
        maxReadmeBytes: 500,
        maxSectionCharacters: 1_000,
      },
    });

    expect(result.eligible).toBe(true);
    expect(result.triggerReasons).toEqual([
      'readme_size_exceeded',
      'section_length_exceeded',
    ]);
    expect(result.noOpReason).toBeNull();
    expect(result.metrics.longestSections[0]).toMatchObject({
      heading: 'Project Reference',
    });
  });

  it('detects repeated instruction blocks as an automatic hygiene trigger', () => {
    const instructionBlock = `Rebel must always keep answers concise and should never invent company policy. These platform instructions are useful, but duplicated instruction text bloats the always-loaded profile context and should be represented once.`;
    const result = evaluateChiefOfStaffReadmeHygiene(`# Chief of Staff

## Instructions A
${instructionBlock}

## Instructions B
${instructionBlock}
`, {
      thresholds: {
        duplicateInstructionBlockMinCharacters: 80,
      },
    });

    expect(result.eligible).toBe(true);
    expect(result.triggerReasons).toContain('duplicate_instruction_block');
    expect(result.metrics.duplicateInstructionBlocks).toEqual([
      expect.objectContaining({ occurrences: 2 }),
    ]);
  });

  it('detects stale current-priority sections using dated content', () => {
    const result = evaluateChiefOfStaffReadmeHygiene(`# Chief of Staff

## Current Priorities
- 2026-01-01: Launch plan from a previous quarter.
`, {
      now: new Date('2026-05-19T12:00:00.000Z'),
      thresholds: {
        staleCurrentSectionAgeDays: 30,
      },
    });

    expect(result.eligible).toBe(true);
    expect(result.triggerReasons).toContain('stale_current_section');
    expect(result.metrics.staleCurrentSections).toEqual([
      {
        heading: 'Current Priorities',
        isoDate: '2026-01-01',
        ageDays: 138,
      },
    ]);
  });

  it('reports risky long profile sections separately from trigger reasons', () => {
    const result = evaluateChiefOfStaffReadmeHygiene(`# Chief of Staff

## Identity
${'Stable profile fact. '.repeat(120)}
`, {
      thresholds: {
        maxSectionCharacters: 500,
      },
    });

    expect(result.eligible).toBe(true);
    expect(result.triggerReasons).toContain('section_length_exceeded');
    expect(result.riskIndicators).toEqual([
      expect.objectContaining({
        kind: 'long_identity_or_profile_section',
        heading: 'Identity',
      }),
    ]);
  });

  it('uses last-run README hash to avoid daily churn', () => {
    const readme = `# Chief of Staff

## Reference
${'Detailed note. '.repeat(100)}
`;
    const result = evaluateChiefOfStaffReadmeHygiene(readme, {
      lastRunReadmeHash: createReadmeHash(readme),
      thresholds: {
        maxReadmeBytes: 200,
      },
    });

    expect(result.eligible).toBe(false);
    expect(result.triggerReasons).toContain('readme_size_exceeded');
    expect(result.noOpReason).toBe('unchanged_since_last_run');
  });

  it('can evaluate a README file path and handles missing files as no-ops', async () => {
    const readmePath = path.join(tmpDir, 'Chief-of-Staff', 'README.md');
    await fs.mkdir(path.dirname(readmePath), { recursive: true });
    const readmeContent = '# Chief of Staff\n\n## Notes\nSmall.\n';
    await fs.writeFile(readmePath, readmeContent);

    const fileResult = await evaluateChiefOfStaffReadmeHygieneFile(readmePath);
    const missingResult = await evaluateChiefOfStaffReadmeHygieneFile(path.join(tmpDir, 'missing.md'));

    expect(fileResult.noOpReason).toBe('healthy');
    await expect(fs.readFile(readmePath, 'utf8')).resolves.toBe(readmeContent);
    expect(missingResult).toMatchObject({
      eligible: false,
      noOpReason: 'missing_readme',
      error: null,
    });
  });
});
