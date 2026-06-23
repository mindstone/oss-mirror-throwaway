import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateExampleContent, generateExampleFilename } from '../exampleTemplates';

describe('exampleTemplates', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('generateExampleContent', () => {
    it('builds a positive example template with required frontmatter and placeholder copy', () => {
      const content = generateExampleContent({
        skillName: 'meeting-prep',
        skillRelativePath: 'skills/meetings/meeting-prep/SKILL.md',
        type: 'positive',
      });

      expect(content).toContain('description: ""');
      expect(content).toContain('type: positive');
      expect(content).toContain('generated_by: skills/meetings/meeting-prep/SKILL.md');
      expect(content).toContain('last_updated: "2026-03-10"');
      expect(content).toContain('# Example: Meeting Prep');
      expect(content).toContain('Replace this with a real example of what this skill produces at its best.');
    });

    it('builds a counter-example template with required section guidance', () => {
      const content = generateExampleContent({
        skillName: 'meeting-prep',
        skillRelativePath: 'skills/meetings/meeting-prep/SKILL.md',
        type: 'counter-example',
      });

      expect(content).toContain('description: ""');
      expect(content).toContain('type: counter-example');
      expect(content).toContain('generated_by: skills/meetings/meeting-prep/SKILL.md');
      expect(content).toContain('last_updated: "2026-03-10"');
      expect(content).toContain('# Counter-Example: Meeting Prep');
      expect(content).toContain('Replace this with an example of output that misses the mark.');
      expect(content).toContain('## Why this falls short');
      expect(content).toContain('Without this section, counter-examples teach very little.');
    });
  });

  describe('generateExampleFilename', () => {
    it('generates the first positive filename in kebab-case', () => {
      const fileName = generateExampleFilename('Meeting Prep ++', 'positive', []);

      expect(fileName).toBe('meeting-prep-example-1.md');
    });

    it('increments positive filenames to avoid collisions', () => {
      const fileName = generateExampleFilename('meeting-prep', 'positive', [
        'skills/meetings/meeting-prep/examples/meeting-prep-example-1.md',
        'skills\\meetings\\meeting-prep\\examples\\meeting-prep-example-2.md',
      ]);

      expect(fileName).toBe('meeting-prep-example-3.md');
    });

    it('uses the counter prefix and increments only against counter filenames', () => {
      const fileName = generateExampleFilename('meeting-prep', 'counter-example', [
        'skills/meetings/meeting-prep/examples/meeting-prep-example-1.md',
        'skills/meetings/meeting-prep/examples/meeting-prep-counter-1.md',
      ]);

      expect(fileName).toBe('meeting-prep-counter-2.md');
    });
  });
});
