import {
  convertHtmlDetailsToCollapse,
  encodeSpacesInMarkdownLinks,
  extractYamlFrontmatterFields,
  isCollapseLanguage,
  parseCollapseBlock,
  stripYamlFrontmatter,
} from '../markdownPreprocessors';

describe('parseCollapseBlock', () => {
  it('extracts summary and body from collapse blocks', () => {
    expect(parseCollapseBlock('Summary\nBody line 1\nBody line 2')).toEqual({
      summary: 'Summary',
      body: 'Body line 1\nBody line 2',
    });
  });

  it('falls back to Details for empty content', () => {
    expect(parseCollapseBlock('   \n  ')).toEqual({
      summary: 'Details',
      body: '',
    });
  });
});

describe('isCollapseLanguage', () => {
  it('matches exact collapse language tokens only', () => {
    expect(isCollapseLanguage('language-collapse')).toEqual({
      isCollapse: true,
      defaultOpen: false,
    });
    expect(isCollapseLanguage('language-collapse-open')).toEqual({
      isCollapse: true,
      defaultOpen: true,
    });
    expect(isCollapseLanguage('language-collapsible')).toEqual({
      isCollapse: false,
      defaultOpen: false,
    });
    expect(isCollapseLanguage('language-collapse-custom')).toEqual({
      isCollapse: false,
      defaultOpen: false,
    });
  });
});

describe('convertHtmlDetailsToCollapse', () => {
  it('converts details blocks to collapse fences', () => {
    const input = '<details>\n<summary>Click to expand</summary>\n\nSome body content.\n</details>';
    expect(convertHtmlDetailsToCollapse(input)).toBe(
      '```collapse\nClick to expand\nSome body content.\n```',
    );
  });

  it('preserves code fences without converting embedded details tags', () => {
    const input = '```html\n<details>\n<summary>Example</summary>\nBody\n</details>\n```';
    expect(convertHtmlDetailsToCollapse(input)).toBe(input);
  });

  it('handles details blocks with attributes and empty summaries', () => {
    expect(
      convertHtmlDetailsToCollapse(
        '<details class="info" open>\n<summary></summary>\nBody\n</details>',
      ),
    ).toBe('```collapse-open\nDetails\nBody\n```');
  });
});

describe('encodeSpacesInMarkdownLinks', () => {
  it('encodes spaces in markdown link destinations', () => {
    expect(encodeSpacesInMarkdownLinks('[Doc](My Folder/file.md)')).toBe(
      '[Doc](My%20Folder/file.md)',
    );
    expect(encodeSpacesInMarkdownLinks('![Image](My Folder/file name.png)')).toBe(
      '![Image](My%20Folder/file%20name.png)',
    );
  });

  it('preserves markdown link titles while encoding URL spaces', () => {
    expect(encodeSpacesInMarkdownLinks('[Doc](My Folder/file.md "My Title")')).toBe(
      '[Doc](My%20Folder/file.md "My Title")',
    );
  });

  it('leaves protocol URLs, inline code, and fenced code untouched', () => {
    expect(encodeSpacesInMarkdownLinks('[Link](https://example.com/path with spaces)')).toBe(
      '[Link](https://example.com/path with spaces)',
    );
    expect(encodeSpacesInMarkdownLinks('`[Doc](My Folder/file.md)`')).toBe(
      '`[Doc](My Folder/file.md)`',
    );
    expect(encodeSpacesInMarkdownLinks('```\n[Doc](My Folder/file.md)\n```')).toBe(
      '```\n[Doc](My Folder/file.md)\n```',
    );
  });
});

describe('stripYamlFrontmatter', () => {
  it('strips valid YAML frontmatter', () => {
    expect(stripYamlFrontmatter('---\ntitle: Test\nauthor: Bot\n---\nContent here')).toBe(
      'Content here',
    );
  });

  it('returns the input unchanged without frontmatter', () => {
    expect(stripYamlFrontmatter('Hello world')).toBe('Hello world');
    expect(stripYamlFrontmatter('---not frontmatter')).toBe('---not frontmatter');
  });

  it('handles missing closing delimiters with the existing fallback logic', () => {
    expect(stripYamlFrontmatter('---\ntitle: Test\nauthor: Bot\nContent here')).toBe(
      '---\ntitle: Test\nauthor: Bot\nContent here',
    );
  });
});

describe('extractYamlFrontmatterFields', () => {
  it('extracts scalar, boolean, number, inline list, and list values', () => {
    expect(
      extractYamlFrontmatterFields(
        [
          '---',
          'title: "Test"',
          'published: true',
          'priority: 3',
          'tags: [alpha, beta]',
          'owners:',
          '  - "Ava"',
          '  - Ben',
          '---',
          '# Body',
        ].join('\n'),
      ),
    ).toEqual({
      title: 'Test',
      published: true,
      priority: 3,
      tags: ['alpha', 'beta'],
      owners: ['Ava', 'Ben'],
    });
  });

  it('returns null when there is no frontmatter or no parsed fields', () => {
    expect(extractYamlFrontmatterFields('No frontmatter')).toBeNull();
    expect(extractYamlFrontmatterFields('---\n---\nBody')).toBeNull();
  });
});
