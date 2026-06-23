import { describe, expect, it } from 'vitest';
import { canShowSkillHistory, parseSkillContent } from './SkillCard';

describe('parseSkillContent', () => {
  it('treats sparse but parseable skill files as renderable', () => {
    const parsed = parseSkillContent(`---
tools_required:
  - slack
---
`);

    expect(parsed.isValid).toBe(true);
    expect(parsed.frontmatter.tools_required).toEqual(['slack']);
  });

  it('treats body-only skill instructions as renderable', () => {
    const parsed = parseSkillContent('Follow these instructions carefully.');

    expect(parsed.isValid).toBe(true);
    expect(parsed.body).toBe('Follow these instructions carefully.');
  });

  it('keeps empty skill content invalid', () => {
    const parsed = parseSkillContent('');

    expect(parsed.isValid).toBe(false);
  });

  it('normalizes scalar tools_required to array (Fixes REBEL-17D)', () => {
    const parsed = parseSkillContent(`---
tools_required: Read
---
Body`);

    expect(parsed.isValid).toBe(true);
    expect(parsed.frontmatter.tools_required).toEqual(['Read']);
  });

  it('normalizes scalar use_cases to array', () => {
    const parsed = parseSkillContent(`---
use_cases: Draft emails
---
Body`);

    expect(parsed.isValid).toBe(true);
    expect(parsed.frontmatter.use_cases).toEqual(['Draft emails']);
  });

  it('normalizes scalar dependencies to array', () => {
    const parsed = parseSkillContent(`---
dependencies: some-skill.md
---
Body`);

    expect(parsed.isValid).toBe(true);
    expect(parsed.frontmatter.dependencies).toEqual(['some-skill.md']);
  });

  it('preserves array fields that are already arrays', () => {
    const parsed = parseSkillContent(`---
tools_required:
  - Slack
  - Gmail
use_cases:
  - Email triage
---
Body`);

    expect(parsed.frontmatter.tools_required).toEqual(['Slack', 'Gmail']);
    expect(parsed.frontmatter.use_cases).toEqual(['Email triage']);
  });

  it('leaves array fields undefined when not present', () => {
    const parsed = parseSkillContent(`---
description: A skill
---
Body`);

    expect(parsed.frontmatter.tools_required).toBeUndefined();
    expect(parsed.frontmatter.use_cases).toBeUndefined();
    expect(parsed.frontmatter.dependencies).toBeUndefined();
  });

  it('drops non-string/non-array values (null, number, boolean) for array fields', () => {
    const parsed = parseSkillContent(`---
tools_required: 42
use_cases: true
dependencies: null
---
Body`);

    expect(parsed.frontmatter.tools_required).toBeUndefined();
    expect(parsed.frontmatter.use_cases).toBeUndefined();
    expect(parsed.frontmatter.dependencies).toBeUndefined();
  });

  it('filters non-string elements from mixed arrays', () => {
    const parsed = parseSkillContent(`---
tools_required:
  - Slack
  - 42
  - true
  - Gmail
---
Body`);

    expect(parsed.frontmatter.tools_required).toEqual(['Slack', 'Gmail']);
  });

  it('normalizes scalar contributors to array', () => {
    const parsed = parseSkillContent(`---
contributors: user-123
---
Body`);

    expect(parsed.frontmatter.contributors).toEqual(['user-123']);
  });
});

describe('canShowSkillHistory', () => {
  const user = { id: 'user-123', name: 'Owner', email: 'owner@example.com', image: null } as const;

  it('requires google_drive storage for eligible contributors', () => {
    const frontmatter = { author_id: 'user-123' };
    expect(canShowSkillHistory(frontmatter, 'restricted', user, 'google_drive')).toBe(true);
    expect(canShowSkillHistory(frontmatter, 'restricted', user, 'dropbox')).toBe(false);
    expect(canShowSkillHistory(frontmatter, 'restricted', user, undefined)).toBe(false);
  });

  it('keeps existing contributor rules before storage check', () => {
    const frontmatter = { contributors: ['user-123'] };
    expect(canShowSkillHistory(frontmatter, 'restricted', user, 'google_drive')).toBe(true);
    expect(canShowSkillHistory(frontmatter, 'private', user, 'google_drive')).toBe(false);
    expect(
      canShowSkillHistory(
        frontmatter,
        'restricted',
        { id: 'someone-else', name: 'Else', email: '[external-email]', image: null },
        'google_drive',
      ),
    ).toBe(false);
  });
});
