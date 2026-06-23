export type ExampleTemplateType = 'positive' | 'counter-example';

export interface GenerateExampleOptions {
  skillName: string;
  skillRelativePath: string;
  type: ExampleTemplateType;
}

const DEFAULT_SKILL_SLUG = 'skill';

const toKebabCase = (value: string): string => {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || DEFAULT_SKILL_SLUG;
};

const toTitleCase = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Untitled Skill';
  }

  return trimmed
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (char: string) => char.toUpperCase());
};

const getFileName = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  return segments[segments.length - 1] ?? '';
};

const todayIsoDate = (): string => new Date().toISOString().slice(0, 10);

export function generateExampleContent(options: GenerateExampleOptions): string {
  const { skillName, skillRelativePath, type } = options;
  const title = toTitleCase(skillName);
  const lastUpdated = todayIsoDate();

  if (type === 'counter-example') {
    return `---
description: ""
type: counter-example
generated_by: ${skillRelativePath}
last_updated: "${lastUpdated}"
---

# Counter-Example: ${title}

Replace this with an example of output that misses the mark.

## Why this falls short

Explain what makes this output less effective than a good example.
Without this section, counter-examples teach very little.
`;
  }

  return `---
description: ""
type: positive
generated_by: ${skillRelativePath}
last_updated: "${lastUpdated}"
---

# Example: ${title}

Replace this with a real example of what this skill produces at its best.
`;
}

export function generateExampleFilename(
  skillName: string,
  type: ExampleTemplateType,
  existingPaths: string[]
): string {
  const skillSlug = toKebabCase(skillName);
  const variant = type === 'counter-example' ? 'counter' : 'example';
  const existingFileNames = new Set(existingPaths.map(path => getFileName(path).toLowerCase()));

  let index = 1;
  let candidate = `${skillSlug}-${variant}-${index}.md`;

  while (existingFileNames.has(candidate.toLowerCase())) {
    index += 1;
    candidate = `${skillSlug}-${variant}-${index}.md`;
  }

  return candidate;
}
