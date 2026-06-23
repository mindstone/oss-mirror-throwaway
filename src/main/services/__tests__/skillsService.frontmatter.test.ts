import { describe, expect, it } from 'vitest';
import { parseSkillFrontmatterFromContent } from '../skillsService';

describe('parseSkillFrontmatterFromContent', () => {
  it('parses model and effort fields', () => {
    const content = `---
description: Expert writing assistant
model: opus
effort: high
---
Use this for high-stakes writing work.`;

    const parsed = parseSkillFrontmatterFromContent(content);

    expect(parsed).toMatchObject({
      description: 'Expert writing assistant',
      model: 'opus',
      effort: 'high',
    });
  });

  it('tolerates unknown Anthropic-style fields', () => {
    const content = `---
description: Anthropic-compatible skill
model: sonnet
effort: medium
allowed-tools:
  - Read
  - Edit
context: workspace-write
hooks:
  pre_tool_use:
    - matcher: ".*"
paths:
  - "docs/**"
shell: bash
disable-model-invocation: true
agent: planner
---
Body`;

    const parsed = parseSkillFrontmatterFromContent(content);

    expect(parsed).not.toBeNull();
    expect(parsed?.description).toBe('Anthropic-compatible skill');
    expect(parsed?.model).toBe('sonnet');
    expect(parsed?.effort).toBe('medium');
  });

  it('keeps model and effort undefined when omitted', () => {
    const content = `---
description: Legacy skill with no model hints
---
Body`;

    const parsed = parseSkillFrontmatterFromContent(content);

    expect(parsed).not.toBeNull();
    expect(parsed?.description).toBe('Legacy skill with no model hints');
    expect(parsed?.model).toBeUndefined();
    expect(parsed?.effort).toBeUndefined();
  });

  it('parses optional output shape contracts', () => {
    const content = `---
description: Artifact-producing skill
output_shape:
  default_surface: file_artifact
  chat_contract: concise_summary
  artifact_expected: true
  max_chat_words: 180
  source_policy: artifact_sources
  extra_future_field: ignored
---
Body`;

    const parsed = parseSkillFrontmatterFromContent(content);

    expect(parsed?.output_shape).toEqual({
      default_surface: 'file_artifact',
      chat_contract: 'concise_summary',
      artifact_expected: true,
      max_chat_words: 180,
      source_policy: 'artifact_sources',
    });
  });

  it('ignores invalid output shape fields without dropping valid frontmatter', () => {
    const content = `---
description: Partially invalid output shape
output_shape:
  default_surface: print_it_on_a_tshirt
  chat_contract: concise_summary
  max_chat_words: lots
---
Body`;

    const parsed = parseSkillFrontmatterFromContent(content);

    expect(parsed).not.toBeNull();
    expect(parsed?.description).toBe('Partially invalid output shape');
    expect(parsed?.output_shape).toEqual({
      chat_contract: 'concise_summary',
    });
  });

  it('returns partial data for invalid effort values in frontmatter fallback', () => {
    const content = `---
description: Partial skill
model: opus
effort: turbo
tools_required: Read
---
Body`;

    const parsed = parseSkillFrontmatterFromContent(content);

    expect(parsed).not.toBeNull();
    expect(parsed?.description).toBe('Partial skill');
    expect(parsed?.model).toBe('opus');
    expect(parsed?.effort).toBeUndefined();
  });

  it('returns null for malformed frontmatter', () => {
    const content = `---
description: Broken skill
model: [opus
---
Body`;

    expect(parseSkillFrontmatterFromContent(content)).toBeNull();
  });
});
