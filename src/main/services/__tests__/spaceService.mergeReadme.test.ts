import { describe, it, expect } from 'vitest';
import type { SpaceFrontmatter } from '../promptTemplateService';

// Dynamic import to use mocked electron-store from vitest.setup.ts
const spaceService = await import('../spaceService');

describe('spaceService.mergeReadmeWithFrontmatter', () => {
  const baseFrontmatter: SpaceFrontmatter = {
    rebel_space_description: 'A test space for testing',
    space_type: 'project',
    sharing: 'private',
  };

  describe('null content (new README)', () => {
    it('creates fresh README with frontmatter block only', () => {
      const result = spaceService.mergeReadmeWithFrontmatter(null, baseFrontmatter);

      // Should have frontmatter block
      expect(result).toMatch(/^---\n/);
      expect(result).toMatch(/\n---\n$/);

      // Should contain our fields
      expect(result).toContain('rebel_space_description: A test space for testing');
      expect(result).toContain('space_type: project');
      expect(result).toContain('sharing: private');
    });

    it('handles array fields correctly', () => {
      const frontmatter: SpaceFrontmatter = {
        ...baseFrontmatter,
        related_spaces: ['space1', 'space2'],
      };

      const result = spaceService.mergeReadmeWithFrontmatter(null, frontmatter);

      expect(result).toContain('related_spaces:');
      expect(result).toContain('  - space1');
      expect(result).toContain('  - space2');
    });
  });

  describe('content without frontmatter', () => {
    it('prepends frontmatter block and preserves entire content', () => {
      const existingContent = '# My Project\n\nThis is an existing README with no frontmatter.\n\n## Features\n\n- Feature 1\n- Feature 2\n';

      const result = spaceService.mergeReadmeWithFrontmatter(existingContent, baseFrontmatter);

      // Should start with frontmatter block
      expect(result).toMatch(/^---\n/);

      // Should have our fields
      expect(result).toContain('rebel_space_description: A test space for testing');

      // Should preserve existing content after frontmatter
      expect(result).toContain('# My Project');
      expect(result).toContain('This is an existing README with no frontmatter.');
      expect(result).toContain('## Features');
      expect(result).toContain('- Feature 1');
      expect(result).toContain('- Feature 2');
    });

    it('handles empty content as no frontmatter', () => {
      const existingContent = '';

      const result = spaceService.mergeReadmeWithFrontmatter(existingContent, baseFrontmatter);

      // Should have frontmatter block
      expect(result).toMatch(/^---\n/);
      expect(result).toContain('rebel_space_description: A test space for testing');
    });
  });

  describe('content with existing frontmatter', () => {
    it('merges space fields while preserving body', () => {
      const existingContent = `---
rebel_space_description: Old description
space_type: team
---

# Project README

This is the body content.
`;

      const newFrontmatter: SpaceFrontmatter = {
        rebel_space_description: 'New updated description',
        space_type: 'project',
        sharing: 'team',
      };

      const result = spaceService.mergeReadmeWithFrontmatter(existingContent, newFrontmatter);

      // Space fields should be updated
      expect(result).toContain('rebel_space_description: New updated description');
      expect(result).toContain('space_type: project');
      expect(result).toContain('sharing: team');

      // Body should be preserved
      expect(result).toContain('# Project README');
      expect(result).toContain('This is the body content.');
    });

    it('preserves user custom fields not in space frontmatter', () => {
      const existingContent = `---
rebel_space_description: Old description
custom_field: user data
another_custom: 42
---

# Body
`;

      const result = spaceService.mergeReadmeWithFrontmatter(existingContent, baseFrontmatter);

      // Our fields should take precedence
      expect(result).toContain('rebel_space_description: A test space for testing');

      // User custom fields should be preserved
      expect(result).toContain('custom_field: user data');
      expect(result).toContain('another_custom: 42');
    });

    it('our space fields take precedence over existing values', () => {
      const existingContent = `---
rebel_space_description: User wrote this
space_type: other
sharing: public
---

# Content
`;

      const newFrontmatter: SpaceFrontmatter = {
        rebel_space_description: 'System updated description',
        space_type: 'project',
        sharing: 'private',
      };

      const result = spaceService.mergeReadmeWithFrontmatter(existingContent, newFrontmatter);

      // Our values should override
      expect(result).toContain('rebel_space_description: System updated description');
      expect(result).toContain('space_type: project');
      expect(result).toContain('sharing: private');

      // Body preserved
      expect(result).toContain('# Content');
    });
  });

  describe('malformed YAML handling', () => {
    it('falls back to prepending when frontmatter YAML is invalid', () => {
      // Malformed YAML - indentation issues would cause parse error
      const existingContent = `---
  badly: indented
    nested: wrong
---

# Content
`;

      const result = spaceService.mergeReadmeWithFrontmatter(existingContent, baseFrontmatter);

      // Should still have our frontmatter
      expect(result).toContain('rebel_space_description: A test space for testing');

      // Should preserve original content (including malformed frontmatter)
      expect(result).toContain('# Content');
    });

    it('handles incomplete frontmatter delimiters by prepending', () => {
      // Missing closing ---
      const existingContent = `---
some_field: value

# This should be treated as body
`;
      // Note: front-matter library may parse this, but with empty body
      // The key is we don't lose any content

      const result = spaceService.mergeReadmeWithFrontmatter(existingContent, baseFrontmatter);

      // Should have our fields
      expect(result).toContain('rebel_space_description: A test space for testing');
    });
  });

  describe('edge cases', () => {
    it('handles frontmatter with special characters in values', () => {
      const frontmatter: SpaceFrontmatter = {
        rebel_space_description: 'Project for Acme Corp: "The Best" initiative',
        space_type: 'project',
        sharing: 'private',
      };

      const result = spaceService.mergeReadmeWithFrontmatter(null, frontmatter);

      // The description with quotes and colon should be properly escaped
      expect(result).toContain('rebel_space_description:');
      // Verify the value is quoted to handle the special characters
      expect(result).toMatch(/rebel_space_description: ".*Acme Corp.*Best.*initiative"/);
    });

    it('produces valid YAML that can be re-parsed (round-trip)', async () => {
      // Dynamic import front-matter for verification
      const fm = (await import('front-matter')).default;
      
      const frontmatter: SpaceFrontmatter = {
        rebel_space_description: 'Has: colons and "quotes" in it',
        space_type: 'project',
        sharing: 'team',
      };

      const result = spaceService.mergeReadmeWithFrontmatter(null, frontmatter);
      
      // Re-parse the generated YAML and verify values round-trip correctly
      const reparsed = fm<Record<string, unknown>>(result);
      expect(reparsed.attributes.rebel_space_description).toBe('Has: colons and "quotes" in it');
      expect(reparsed.attributes.space_type).toBe('project');
      expect(reparsed.attributes.sharing).toBe('team');
    });

    it('handles empty frontmatter delimiters', () => {
      // Edge case: existing file has empty frontmatter block
      const existingContent = `---
---

# Content after empty frontmatter
`;

      const result = spaceService.mergeReadmeWithFrontmatter(existingContent, baseFrontmatter);

      // Should have our fields (either merged or prepended)
      expect(result).toContain('rebel_space_description: A test space for testing');
      // Body should be preserved
      expect(result).toContain('# Content after empty frontmatter');
    });

    it('preserves exact body whitespace', () => {
      const existingContent = `---
old_field: value
---

# Title

First paragraph.

Second paragraph with
multiple lines.
`;

      const result = spaceService.mergeReadmeWithFrontmatter(existingContent, baseFrontmatter);

      // Body structure should be preserved
      expect(result).toContain('\n# Title\n\nFirst paragraph.\n\nSecond paragraph with\nmultiple lines.\n');
    });

    it('handles undefined optional fields by excluding them', () => {
      const frontmatter: SpaceFrontmatter = {
        rebel_space_description: 'Test',
        // space_type, sharing, memoryTrust etc. are undefined
      };

      const result = spaceService.mergeReadmeWithFrontmatter(null, frontmatter);

      // Only defined fields should appear
      expect(result).toContain('rebel_space_description: Test');
      expect(result).not.toContain('space_type');
      expect(result).not.toContain('sharing');
      expect(result).not.toContain('memoryTrust');
    });
  });
});
