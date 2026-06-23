import { describe, it, expect } from 'vitest';
import {
  computeSkillQualityScore,
  getSkillQualityBand,
  normaliseSkillQualityTotal,
  type SkillQualityInput,
  type DimensionName,
  type ExampleMeta,
} from '@core/skillQualityScore';

const daysAgoIso = (days: number): string => {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
};

const baseBodyText = `
# Overview
This skill prepares you for important meetings with confidence. It turns rough notes into a clear brief, captures risks, and surfaces opportunities that matter for decision-making. Use it when you need a fast, dependable preparation flow that balances strategy and practical action.

## Workflow
1. Gather relevant notes, documents, and context.
2. Extract key objectives, stakeholders, and decisions.
3. Summarise risks, opportunities, and open questions.

## How to adapt
- Tailor language for internal or external audiences.
- Add company-specific terms and recurring constraints.
`.trim();

const createExampleMetas = (includeCounterExample = true): ExampleMeta[] => [
  {
    path: 'internal-strategic.md',
    description: 'Internal strategic planning prep output',
    type: 'positive',
    hasFrontmatter: true,
    lastModifiedMs: Date.now() - 3 * 24 * 60 * 60 * 1000,
  },
  {
    path: 'internal-operational.md',
    description: 'Operational sync meeting prep output',
    type: 'positive',
    hasFrontmatter: true,
    lastModifiedMs: Date.now() - 8 * 24 * 60 * 60 * 1000,
  },
  {
    path: 'external-sales.md',
    description: 'External sales call prep output',
    type: includeCounterExample ? 'counter-example' : 'positive',
    hasFrontmatter: true,
    lastModifiedMs: Date.now() - 15 * 24 * 60 * 60 * 1000,
  },
  {
    path: 'external-strategic.md',
    description: 'External strategic partnership prep output',
    type: 'positive',
    hasFrontmatter: true,
    lastModifiedMs: Date.now() - 20 * 24 * 60 * 60 * 1000,
  },
  {
    path: 'partnership-review.md',
    type: 'positive',
    hasFrontmatter: false,
    lastModifiedMs: Date.now() - 30 * 24 * 60 * 60 * 1000,
  },
];

const createFullSkillInput = (): SkillQualityInput => ({
  name: 'meeting-prep',
  relativePath: 'rebel-system/skills/meetings/meeting-prep/SKILL.md',
  hasFrontmatter: true,
  frontmatter: {
    description:
      'Prepare for meetings with crisp objectives, context, talking points, and follow-up actions.',
    use_cases: ['Prepare for weekly planning calls', 'Prep for stakeholder updates'],
    tools_required: ['Calendar', 'Slack'],
    author: 'Team Rebel',
    contributed: ['Alex'],
    last_modified_at: daysAgoIso(10),
    dependencies: ['@research-notes'],
  },
  examples: [
    'internal-strategic.md',
    'internal-operational.md',
    'external-sales.md',
    'external-strategic.md',
    'partnership-review.md',
  ],
  exampleMetas: createExampleMetas(),
  bodyText: `${baseBodyText}\n\nFor deeper context, see rebel-system/skills/research/research-brief/SKILL.md`,
  usageCount: 12,
  lastUsedAt: daysAgoIso(2),
  sessionCount: 4,
  isExtended: true,
  hasOrphanedExtensions: false,
  hasExtensibilityNote: true,
});

const buildBodyWithLines = (lineCount: number): string => {
  const prefix = [
    '# Overview',
    'This extension keeps only personal preferences and formatting choices.',
    '## Workflow',
    '1. Keep only the personal delta from the base skill.',
    '2. Avoid rewriting the full base instructions.',
    '## How to personalise',
    '- Keep this focused and compact.',
  ];

  const filler = Array.from(
    { length: Math.max(0, lineCount - prefix.length) },
    (_, index) => `Preference line ${index + 1}`
  );

  return [...prefix, ...filler].join('\n');
};

describe('computeSkillQualityScore', () => {
  it('scores a minimal skill as low quality', () => {
    const result = computeSkillQualityScore({
      name: 'Meeting Prep',
      relativePath: 'meeting-prep.md',
      hasFrontmatter: false,
      examples: [],
      bodyText: '',
    });

    expect(result.total).toBeLessThanOrEqual(22);
    expect(result.band).toBe('seedling');
  });

  it('scores a fully documented and well-used skill very highly', () => {
    const result = computeSkillQualityScore(createFullSkillInput());

    expect(result.total).toBe(100);
    expect(result.band).toBe('exemplary');

    const allDimensions: DimensionName[] = [
      'structure',
      'clarity',
      'context',
      'adoption',
      'extensionHealth',
    ];

    for (const dimension of allDimensions) {
      expect(result.breakdown[dimension]).toEqual({ score: 15, max: 15 });
    }

    expect(result.breakdown.examples).toEqual({ score: 25, max: 25 });
  });

  it('gracefully degrades examples scoring when metadata is absent', () => {
    const result = computeSkillQualityScore({
      ...createFullSkillInput(),
      exampleMetas: undefined,
    });

    expect(result.breakdown.examples).toEqual({ score: 15, max: 25 });
    expect(result.topImprovement).toBeDefined();
    expect(result.topImprovement!.dimension).toBe('examples');
    expect(result.topImprovement!.suggestion).toBe(
      'Your examples are there -- adding a short description to each would help Rebel understand what they demonstrate.'
    );
  });

  it('suggests adding an example when none exist', () => {
    const result = computeSkillQualityScore({
      ...createFullSkillInput(),
      examples: [],
      exampleMetas: undefined,
    });

    expect(result.breakdown.examples).toEqual({ score: 0, max: 25 });
    expect(result.topImprovement).toBeDefined();
    expect(result.topImprovement!.dimension).toBe('examples');
    expect(result.topImprovement!.suggestion).toBe(
      'Show Rebel what good output looks like. One real example is worth a thousand words of instruction.'
    );
  });

  it('suggests counter-examples for solid or exemplary skills that lack one', () => {
    const result = computeSkillQualityScore({
      ...createFullSkillInput(),
      exampleMetas: createExampleMetas(false),
    });

    expect(result.band).toBe('exemplary');
    expect(result.breakdown.examples).toEqual({ score: 22, max: 25 });
    expect(result.topImprovement).toBeDefined();
    expect(result.topImprovement!.dimension).toBe('examples');
    expect(result.topImprovement!.suggestion).toBe(
      'Show what "not quite right" looks like too. Counter-examples sharpen the output dramatically.'
    );
  });

  it('awards structure points for action-oriented descriptions', () => {
    const input = createFullSkillInput();

    const actionDescriptionResult = computeSkillQualityScore({
      ...input,
      name: 'Meeting Prep',
      relativePath: 'meeting-prep.md',
      frontmatter: {
        ...input.frontmatter,
        description:
          'Prepare concise meeting briefs with objectives, risks, and next actions for stakeholders.',
        use_cases: undefined,
      },
    });

    const nonActionDescriptionResult = computeSkillQualityScore({
      ...input,
      name: 'Meeting Prep',
      relativePath: 'meeting-prep.md',
      frontmatter: {
        ...input.frontmatter,
        description:
          'Comprehensive meeting briefs with objectives, risks, and key decisions for stakeholders.',
        use_cases: undefined,
      },
    });

    expect(actionDescriptionResult.breakdown.structure.score).toBe(10);
    expect(nonActionDescriptionResult.breakdown.structure.score).toBe(8);
  });

  it('uses a structure-specific suggestion when description lacks action verbs', () => {
    const input = createFullSkillInput();

    const result = computeSkillQualityScore({
      ...input,
      name: 'Meeting Prep',
      relativePath: 'meeting-prep.md',
      frontmatter: {
        ...input.frontmatter,
        description:
          'Comprehensive meeting briefs with objectives, risks, and key decisions for stakeholders.',
        use_cases: ['Prepare for weekly planning calls'],
      },
    });

    expect(result.topImprovement).toBeDefined();
    expect(result.topImprovement!.dimension).toBe('structure');
    expect(result.topImprovement!.suggestion).toBe(
      'The description could be sharper -- mention what this skill creates or produces'
    );
  });

  it('scores extension skills differently when lean versus bloated', () => {
    const full = createFullSkillInput();
    const extensionInput: SkillQualityInput = {
      ...full,
      frontmatter: {
        ...full.frontmatter,
        extends: 'rebel-system/skills/meetings/meeting-prep/SKILL.md',
        extension_type: 'overlay',
      },
      isExtended: false,
      hasExtensibilityNote: false,
    };

    const leanResult = computeSkillQualityScore({
      ...extensionInput,
      bodyText: buildBodyWithLines(80),
    });

    const bloatedResult = computeSkillQualityScore({
      ...extensionInput,
      bodyText: buildBodyWithLines(220),
    });

    expect(leanResult.breakdown.extensionHealth.score).toBe(15);
    expect(bloatedResult.breakdown.extensionHealth.score).toBe(10);
    expect(leanResult.total).toBeGreaterThan(bloatedResult.total);
  });

  it('scores base skills higher when they are extended and extensible', () => {
    const full = createFullSkillInput();
    const baseFrontmatter = {
      ...full.frontmatter,
      extends: undefined,
      extension_type: undefined,
    };

    const withExtensions = computeSkillQualityScore({
      ...full,
      frontmatter: baseFrontmatter,
      isExtended: true,
      hasOrphanedExtensions: false,
      hasExtensibilityNote: true,
    });

    const withoutExtensions = computeSkillQualityScore({
      ...full,
      frontmatter: baseFrontmatter,
      isExtended: false,
      hasOrphanedExtensions: false,
      hasExtensibilityNote: false,
    });

    expect(withExtensions.breakdown.extensionHealth.score).toBe(15);
    expect(withoutExtensions.breakdown.extensionHealth.score).toBe(5);
  });

  it('handles edge cases: no frontmatter, zero usage, and empty body', () => {
    const full = createFullSkillInput();

    const noFrontmatter = computeSkillQualityScore({
      ...full,
      name: 'Meeting Prep',
      relativePath: 'meeting-prep.md',
      hasFrontmatter: false,
      frontmatter: undefined,
    });

    const zeroUsage = computeSkillQualityScore({
      ...full,
      usageCount: 0,
      sessionCount: 0,
      lastUsedAt: null,
    });

    const emptyBody = computeSkillQualityScore({
      ...full,
      bodyText: '',
    });

    expect(noFrontmatter.breakdown.structure.score).toBe(0);
    expect(zeroUsage.breakdown.adoption.score).toBe(0);
    expect(emptyBody.breakdown.clarity.score).toBe(0);
  });

  it('returns topImprovement for the weakest dimension with a suggestion', () => {
    const result = computeSkillQualityScore({
      ...createFullSkillInput(),
      usageCount: 0,
      sessionCount: 0,
      lastUsedAt: null,
    });

    expect(result.topImprovement).toBeDefined();
    expect(result.topImprovement!.dimension).toBe('adoption');
    expect(result.topImprovement!.suggestion).toBe(
      'Take this skill for a spin in a real conversation. Practice makes permanent.'
    );
    expect(result.topImprovement!.suggestion.length).toBeGreaterThan(0);
  });

  it('uses the extension-specific topImprovement suggestion for weak extension health', () => {
    const full = createFullSkillInput();
    const result = computeSkillQualityScore({
      ...full,
      frontmatter: {
        ...full.frontmatter,
        extends: 'rebel-system/skills/meetings/meeting-prep/SKILL.md',
        extension_type: undefined,
      },
      bodyText: buildBodyWithLines(220),
      usageCount: 15,
      sessionCount: 5,
      lastUsedAt: daysAgoIso(1),
    });

    expect(result.topImprovement).toBeDefined();
    expect(result.topImprovement!.dimension).toBe('extensionHealth');
    expect(result.topImprovement!.suggestion).toBe(
      'Keep your personal additions focused -- a few clear preferences beat a wall of text'
    );
  });

  it('returns undefined topImprovement when all dimensions are maxed', () => {
    const result = computeSkillQualityScore(createFullSkillInput());

    expect(result.total).toBe(100);
    expect(result.topImprovement).toBeUndefined();
  });
});

describe('context freshness: last_updated fallback', () => {
  it('awards freshness points when only last_updated is present', () => {
    const input = createFullSkillInput();
    input.frontmatter = {
      ...input.frontmatter,
      last_modified_at: undefined,
      last_updated: daysAgoIso(10),
    };
    const result = computeSkillQualityScore(input);
    expect(result.breakdown.context.score).toBeGreaterThanOrEqual(4);
  });

  it('prefers last_modified_at over last_updated', () => {
    const input = createFullSkillInput();
    input.frontmatter = {
      ...input.frontmatter,
      last_modified_at: daysAgoIso(10),
      last_updated: daysAgoIso(200),
    };
    const resultWithRecent = computeSkillQualityScore(input);

    const inputStale = createFullSkillInput();
    inputStale.frontmatter = {
      ...inputStale.frontmatter,
      last_modified_at: daysAgoIso(200),
      last_updated: daysAgoIso(10),
    };
    const resultWithStale = computeSkillQualityScore(inputStale);

    // last_modified_at takes precedence, so recent last_modified_at should score better
    expect(resultWithRecent.breakdown.context.score).toBeGreaterThan(
      resultWithStale.breakdown.context.score
    );
  });
});

describe('extension health with real values', () => {
  it('awards points when skill is extended by another', () => {
    const input = createFullSkillInput();
    input.isExtended = true;
    input.hasOrphanedExtensions = false;
    input.hasExtensibilityNote = true;
    const result = computeSkillQualityScore(input);
    expect(result.breakdown.extensionHealth.score).toBe(15);
  });

  it('scores extension skills based on their own extends field, not orphan flag', () => {
    const input: SkillQualityInput = {
      name: 'my-meeting-prep',
      relativePath: 'Chief-of-Staff/skills/meetings/meeting-prep/SKILL.md',
      hasFrontmatter: true,
      frontmatter: {
        description: 'Personal meeting prep extension',
        extends: 'rebel-system/skills/meetings/meeting-prep/SKILL.md',
        extension_type: 'overlay',
      },
      examples: [],
      bodyText: '# My preferences\n\nI like bullet points.',
      hasOrphanedExtensions: true,
    };
    const result = computeSkillQualityScore(input);
    // Extension skills are scored by their own properties (leanness, extension_type)
    // The orphan flag affects base skill scoring, not extension scoring
    expect(result.breakdown.extensionHealth.score).toBeGreaterThanOrEqual(5);
  });

  it('does not award isExtended bonus when base skill has no extensions', () => {
    const input = createFullSkillInput();
    input.isExtended = false;
    input.hasOrphanedExtensions = true;
    input.hasExtensibilityNote = true;
    const result = computeSkillQualityScore(input);
    // No isExtended bonus (+5), but !hasOrphanedExtensions is false so no +5 there either
    // Only extensibilityNote (+5) applies
    expect(result.breakdown.extensionHealth.score).toBe(5);
  });
});

describe('quality score helpers', () => {
  it('normalises the raw 0-100 score range to 0-100', () => {
    expect(normaliseSkillQualityTotal(0)).toBe(0);
    expect(normaliseSkillQualityTotal(50)).toBe(50);
    expect(normaliseSkillQualityTotal(100)).toBe(100);
  });

  it('maps quality bands at boundaries', () => {
    expect(getSkillQualityBand(0)).toBe('seedling');
    expect(getSkillQualityBand(22)).toBe('seedling');
    expect(getSkillQualityBand(23)).toBe('growing');
    expect(getSkillQualityBand(45)).toBe('growing');
    expect(getSkillQualityBand(46)).toBe('solid');
    expect(getSkillQualityBand(68)).toBe('solid');
    expect(getSkillQualityBand(69)).toBe('exemplary');
    expect(getSkillQualityBand(100)).toBe('exemplary');
  });
});
