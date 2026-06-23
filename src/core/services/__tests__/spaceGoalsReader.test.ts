import { describe, it, expect, vi } from 'vitest';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  }),
}));

import {
  extractGoalsFromAllSpaces,
  type SpaceReadmeInput,
  type SpaceGoalsParseResult,
} from '../spaceGoalsReader';

// ─── Helpers ───────────────────────────────────────────────────────────

function makeReadme(frontmatter: string, body = ''): string {
  return `---\n${frontmatter}\n---\n${body}`;
}

function makeInput(overrides: Partial<SpaceReadmeInput> & { readmeContent: string }): SpaceReadmeInput {
  return {
    spaceName: overrides.spaceName ?? 'Test Space',
    spacePath: overrides.spacePath ?? 'test-space',
    spaceType: overrides.spaceType ?? 'other',
    readmeContent: overrides.readmeContent,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('extractGoalsFromAllSpaces', () => {
  // ── Happy paths ────────────────────────────────────────────────────

  it('extracts personal_goals.this_quarter from Chief-of-Staff README', () => {
    const input = makeInput({
      spaceName: 'Chief-of-Staff',
      spacePath: 'Chief-of-Staff',
      spaceType: 'chief-of-staff',
      readmeContent: makeReadme(`
personal_goals_last_reviewed: "2026-04-07"
personal_goals:
  vision: "Build something great"
  this_quarter:
    - goal: "Ship the feature"
      why: "Users need it"
    - goal: "Improve test coverage"
      why: "Quality matters"
`),
    });

    const results = extractGoalsFromAllSpaces([input]);
    expect(results).toHaveLength(1);

    const result = results[0];
    expect(result.status).toBe('ok');
    expect(result.goals).not.toBeNull();
    expect(result.goals!.isPersonal).toBe(true);
    expect(result.goals!.spaceName).toBe('Chief-of-Staff');
    expect(result.goals!.goals).toEqual([
      { goal: 'Ship the feature', why: 'Users need it' },
      { goal: 'Improve test coverage', why: 'Quality matters' },
    ]);
    expect(result.goals!.lastReviewed).toBe('2026-04-07');
  });

  it('extracts company_goals.this_quarter from a company space', () => {
    const input = makeInput({
      spaceName: 'Acme Corp',
      spacePath: 'work/acme-corp',
      spaceType: 'company',
      readmeContent: makeReadme(`
company_values_last_reviewed: "2026-03-15"
company_goals:
  this_quarter:
    - goal: "Increase revenue by 20%"
      why: "Growth target"
    - goal: "Hire 5 engineers"
`),
    });

    const results = extractGoalsFromAllSpaces([input]);
    expect(results).toHaveLength(1);

    const result = results[0];
    expect(result.status).toBe('ok');
    expect(result.goals!.isPersonal).toBe(false);
    expect(result.goals!.spaceType).toBe('company');
    expect(result.goals!.goals).toEqual([
      { goal: 'Increase revenue by 20%', why: 'Growth target' },
      { goal: 'Hire 5 engineers' },
    ]);
    expect(result.goals!.lastReviewed).toBe('2026-03-15');
  });

  it('extracts team_goals.this_quarter from a team space', () => {
    const input = makeInput({
      spaceName: 'Engineering',
      spacePath: 'work/engineering',
      spaceType: 'team',
      readmeContent: makeReadme(`
team_goals:
  this_quarter:
    - goal: "Reduce tech debt by 30%"
      why: "Maintainability"
`),
    });

    const results = extractGoalsFromAllSpaces([input]);
    expect(results).toHaveLength(1);

    const result = results[0];
    expect(result.status).toBe('ok');
    expect(result.goals!.isPersonal).toBe(false);
    expect(result.goals!.goals).toEqual([
      { goal: 'Reduce tech debt by 30%', why: 'Maintainability' },
    ]);
    expect(result.goals!.lastReviewed).toBeNull();
  });

  // ── No goals ───────────────────────────────────────────────────────

  it('returns no_goals for a space without any goal fields', () => {
    const input = makeInput({
      spaceName: 'Notes',
      spacePath: 'notes',
      spaceType: 'personal',
      readmeContent: makeReadme(`
rebel_space_description: "Just notes"
space_type: "personal"
`),
    });

    const results = extractGoalsFromAllSpaces([input]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('no_goals');
    expect(results[0].goals).toBeNull();
  });

  it('returns no_goals when personal_goals exists but has no this_quarter', () => {
    const input = makeInput({
      spaceName: 'Chief-of-Staff',
      spacePath: 'Chief-of-Staff',
      spaceType: 'chief-of-staff',
      readmeContent: makeReadme(`
personal_goals:
  vision: "Be great"
`),
    });

    const results = extractGoalsFromAllSpaces([input]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('no_goals');
    expect(results[0].goals).toBeNull();
  });

  it('returns no_goals when this_quarter is an empty array', () => {
    const input = makeInput({
      spaceName: 'Chief-of-Staff',
      spacePath: 'Chief-of-Staff',
      spaceType: 'chief-of-staff',
      readmeContent: makeReadme(`
personal_goals:
  this_quarter: []
`),
    });

    const results = extractGoalsFromAllSpaces([input]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('no_goals');
    expect(results[0].goals).toBeNull();
  });

  // ── Parse errors ───────────────────────────────────────────────────

  it('returns parse_error for malformed YAML', () => {
    const input = makeInput({
      spaceName: 'Broken',
      spacePath: 'broken-space',
      spaceType: 'other',
      readmeContent: '---\n  bad:\nyaml: [\n---\nBody text',
    });

    const results = extractGoalsFromAllSpaces([input]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('parse_error');
    expect(results[0].error).toBeDefined();
    expect(results[0].goals).toBeNull();
  });

  // ── Malformed goal entries ─────────────────────────────────────────

  it('filters out null entries in the goals array', () => {
    const input = makeInput({
      spaceName: 'Chief-of-Staff',
      spacePath: 'Chief-of-Staff',
      spaceType: 'chief-of-staff',
      readmeContent: makeReadme(`
personal_goals:
  this_quarter:
    - goal: "Valid goal"
    - null
    - goal: "Another valid goal"
      why: "Because"
`),
    });

    const results = extractGoalsFromAllSpaces([input]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('ok');
    expect(results[0].goals!.goals).toEqual([
      { goal: 'Valid goal' },
      { goal: 'Another valid goal', why: 'Because' },
    ]);
  });

  it('filters out entries missing the goal field', () => {
    const input = makeInput({
      spaceName: 'Chief-of-Staff',
      spacePath: 'Chief-of-Staff',
      spaceType: 'chief-of-staff',
      readmeContent: makeReadme(`
personal_goals:
  this_quarter:
    - why: "Missing the goal field"
    - goal: "This one is fine"
    - goal: ""
`),
    });

    const results = extractGoalsFromAllSpaces([input]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('ok');
    expect(results[0].goals!.goals).toEqual([
      { goal: 'This one is fine' },
    ]);
  });

  it('returns no_goals when all entries are malformed', () => {
    const input = makeInput({
      spaceName: 'Chief-of-Staff',
      spacePath: 'Chief-of-Staff',
      spaceType: 'chief-of-staff',
      readmeContent: makeReadme(`
personal_goals:
  this_quarter:
    - why: "No goal field"
    - null
    - 42
`),
    });

    const results = extractGoalsFromAllSpaces([input]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('no_goals');
    expect(results[0].goals).toBeNull();
  });

  // ── Sorting ────────────────────────────────────────────────────────

  it('sorts personal goals first, then alphabetical by space name', () => {
    const inputs: SpaceReadmeInput[] = [
      makeInput({
        spaceName: 'Zebra Team',
        spacePath: 'work/zebra',
        spaceType: 'team',
        readmeContent: makeReadme(`
team_goals:
  this_quarter:
    - goal: "Zebra goal"
`),
      }),
      makeInput({
        spaceName: 'Acme Corp',
        spacePath: 'work/acme',
        spaceType: 'company',
        readmeContent: makeReadme(`
company_goals:
  this_quarter:
    - goal: "Acme goal"
`),
      }),
      makeInput({
        spaceName: 'Chief-of-Staff',
        spacePath: 'Chief-of-Staff',
        spaceType: 'chief-of-staff',
        readmeContent: makeReadme(`
personal_goals:
  this_quarter:
    - goal: "Personal goal"
`),
      }),
    ];

    const results = extractGoalsFromAllSpaces(inputs);
    expect(results).toHaveLength(3);

    // Personal first
    expect(results[0].spaceName).toBe('Chief-of-Staff');
    expect(results[0].goals!.isPersonal).toBe(true);

    // Then alphabetical
    expect(results[1].spaceName).toBe('Acme Corp');
    expect(results[2].spaceName).toBe('Zebra Team');
  });

  it('sorts no_goals and parse_error spaces alphabetically too', () => {
    const inputs: SpaceReadmeInput[] = [
      makeInput({
        spaceName: 'Zebra',
        spacePath: 'zebra',
        spaceType: 'other',
        readmeContent: makeReadme('rebel_space_description: "empty"'),
      }),
      makeInput({
        spaceName: 'Alpha',
        spacePath: 'alpha',
        spaceType: 'other',
        readmeContent: makeReadme('rebel_space_description: "also empty"'),
      }),
    ];

    const results = extractGoalsFromAllSpaces(inputs);
    expect(results[0].spaceName).toBe('Alpha');
    expect(results[1].spaceName).toBe('Zebra');
  });

  // ── lastReviewed extraction ────────────────────────────────────────

  it('extracts personal_goals_last_reviewed as lastReviewed', () => {
    const input = makeInput({
      spaceName: 'Chief-of-Staff',
      spacePath: 'Chief-of-Staff',
      spaceType: 'chief-of-staff',
      readmeContent: makeReadme(`
personal_goals_last_reviewed: "2026-04-01"
personal_goals:
  this_quarter:
    - goal: "Test goal"
`),
    });

    const results = extractGoalsFromAllSpaces([input]);
    expect(results[0].goals!.lastReviewed).toBe('2026-04-01');
  });

  it('extracts company_values_last_reviewed as lastReviewed', () => {
    const input = makeInput({
      spaceName: 'Acme Corp',
      spacePath: 'work/acme',
      spaceType: 'company',
      readmeContent: makeReadme(`
company_values_last_reviewed: "2026-03-20"
company_goals:
  this_quarter:
    - goal: "Revenue goal"
`),
    });

    const results = extractGoalsFromAllSpaces([input]);
    expect(results[0].goals!.lastReviewed).toBe('2026-03-20');
  });

  it('returns null lastReviewed when neither reviewed field is present', () => {
    const input = makeInput({
      spaceName: 'Engineering',
      spacePath: 'work/eng',
      spaceType: 'team',
      readmeContent: makeReadme(`
team_goals:
  this_quarter:
    - goal: "Ship v2"
`),
    });

    const results = extractGoalsFromAllSpaces([input]);
    expect(results[0].goals!.lastReviewed).toBeNull();
  });

  it('prefers personal_goals_last_reviewed over company_values_last_reviewed', () => {
    const input = makeInput({
      spaceName: 'Chief-of-Staff',
      spacePath: 'Chief-of-Staff',
      spaceType: 'chief-of-staff',
      readmeContent: makeReadme(`
personal_goals_last_reviewed: "2026-04-05"
company_values_last_reviewed: "2026-03-01"
personal_goals:
  this_quarter:
    - goal: "Test"
`),
    });

    const results = extractGoalsFromAllSpaces([input]);
    expect(results[0].goals!.lastReviewed).toBe('2026-04-05');
  });

  // ── Per-space isolation ────────────────────────────────────────────

  it('does not let one broken space affect other spaces', () => {
    const inputs: SpaceReadmeInput[] = [
      makeInput({
        spaceName: 'Good Space',
        spacePath: 'good',
        spaceType: 'company',
        readmeContent: makeReadme(`
company_goals:
  this_quarter:
    - goal: "Good goal"
`),
      }),
      makeInput({
        spaceName: 'Bad Space',
        spacePath: 'bad',
        spaceType: 'other',
        readmeContent: '---\n  bad:\nyaml: [\n---\n',
      }),
    ];

    const results = extractGoalsFromAllSpaces(inputs);
    expect(results).toHaveLength(2);

    const good = results.find(r => r.spaceName === 'Good Space')!;
    const bad = results.find(r => r.spaceName === 'Bad Space')!;

    expect(good.status).toBe('ok');
    expect(good.goals!.goals).toEqual([{ goal: 'Good goal' }]);

    expect(bad.status).toBe('parse_error');
    expect(bad.goals).toBeNull();
  });

  // ── Empty input ────────────────────────────────────────────────────

  it('returns empty array for empty input', () => {
    const results = extractGoalsFromAllSpaces([]);
    expect(results).toEqual([]);
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  it('handles README with no frontmatter (just body text)', () => {
    const input = makeInput({
      spaceName: 'Plain',
      spacePath: 'plain',
      spaceType: 'other',
      readmeContent: '# Just a markdown file\n\nNo frontmatter here.',
    });

    const results = extractGoalsFromAllSpaces([input]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('no_goals');
  });

  it('trims whitespace from goal and why fields', () => {
    const input = makeInput({
      spaceName: 'Chief-of-Staff',
      spacePath: 'Chief-of-Staff',
      spaceType: 'chief-of-staff',
      readmeContent: makeReadme(`
personal_goals:
  this_quarter:
    - goal: "  Ship the feature  "
      why: "  Users need it  "
`),
    });

    const results = extractGoalsFromAllSpaces([input]);
    expect(results[0].goals!.goals).toEqual([
      { goal: 'Ship the feature', why: 'Users need it' },
    ]);
  });

  it('omits why field when it is an empty string', () => {
    const input = makeInput({
      spaceName: 'Chief-of-Staff',
      spacePath: 'Chief-of-Staff',
      spaceType: 'chief-of-staff',
      readmeContent: makeReadme(`
personal_goals:
  this_quarter:
    - goal: "Test goal"
      why: ""
`),
    });

    const results = extractGoalsFromAllSpaces([input]);
    expect(results[0].goals!.goals).toEqual([
      { goal: 'Test goal' },
    ]);
  });

  it('does not match unrecognized *_goals fields (e.g. project_goals)', () => {
    const input = makeInput({
      spaceName: 'Project X',
      spacePath: 'project-x',
      spaceType: 'project',
      readmeContent: makeReadme(`
project_goals:
  this_quarter:
    - goal: "Should not be matched"
`),
    });

    const results = extractGoalsFromAllSpaces([input]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('no_goals');
  });

  it('uses first matching allowlisted field when multiple are present', () => {
    const input = makeInput({
      spaceName: 'Chief-of-Staff',
      spacePath: 'Chief-of-Staff',
      spaceType: 'chief-of-staff',
      readmeContent: makeReadme(`
personal_goals:
  this_quarter:
    - goal: "Personal goal"
company_goals:
  this_quarter:
    - goal: "Company goal"
`),
    });

    const results = extractGoalsFromAllSpaces([input]);
    expect(results[0].goals!.goals).toEqual([
      { goal: 'Personal goal' },
    ]);
  });
});
