/**
 * TipTap Markdown Editor - Spike Tests
 *
 * Tests Markdown round-trip fidelity to validate TipTap for our use case.
 * This is part of Stage 0 spike evaluation.
 *
 * These tests use TipTap's headless editor (no DOM required) to validate
 * Markdown parsing and serialization.
 */

import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table';
import Link from '@tiptap/extension-link';
import { TipTapImageExtension } from '../extensions/tiptapImageExtension';
import {
  getImageFilesFromFileList,
  hasFilesInFileList,
  hasNonWhitespacePlainText,
  loadMarkdownContentSafely,
  stripPastedImageTags,
} from './TipTapMarkdownEditor';
import { decodeHtmlEntitiesInMarkdown } from '@renderer/utils/documentUtils';

/**
 * Helper to create a TipTap editor for testing
 */
function createTestEditor(content: string): Editor {
  return new Editor({
    extensions: [
      StarterKit,
      Markdown.configure({ markedOptions: { gfm: true } }),
      TableKit,
      // Note: Only add Link if not already included by Markdown extension
      // The duplicate warning is harmless but we could configure StarterKit to exclude link
      Link.extend({ name: 'customLink' }).configure({ openOnClick: false }),
      TipTapImageExtension,
    ],
    content,
    contentType: 'markdown',
  });
}

describe('TipTap Markdown Round-Trip', () => {
  describe('Image paste/drop file extraction', () => {
    it('keeps image files and ignores non-image files', () => {
      const png = new File(['png'], 'photo.png', { type: 'image/png' });
      const text = new File(['text'], 'notes.txt', { type: 'text/plain' });
      const fileList = [png, text] as unknown as FileList;

      expect(getImageFilesFromFileList(fileList)).toEqual([png]);
    });

    it('detects file-only drops even when no image files are supported', () => {
      const text = new File(['text'], 'notes.txt', { type: 'text/plain' });
      const fileList = [text] as unknown as FileList;

      expect(getImageFilesFromFileList(fileList)).toEqual([]);
      expect(hasFilesInFileList(fileList)).toBe(true);
    });

    it('lets normal text paste win over mixed image clipboard content', () => {
      const clipboardData = {
        getData: (type: string) => type === 'text/plain' ? 'hello world' : '',
      } as DataTransfer;

      expect(hasNonWhitespacePlainText(clipboardData)).toBe(true);
    });

    it('strips pasted HTML image tags before TipTap parses them', () => {
      const html = '<p>Before</p><img src="https://example.com/track.png"><p>After</p><img src="data:image/png;base64,abc">';

      expect(stripPastedImageTags(html)).toBe('<p>Before</p><p>After</p>');
    });
  });

  describe('Basic formatting', () => {
    it('preserves headings', () => {
      const input = '# Heading 1\n\n## Heading 2\n\n### Heading 3';
      const editor = createTestEditor(input);

      const output = editor.getMarkdown();

      // Should preserve heading structure
      expect(output).toContain('# Heading 1');
      expect(output).toContain('## Heading 2');
      expect(output).toContain('### Heading 3');

      editor.destroy();
    });

    it('preserves bold and italic', () => {
      const input = 'This is **bold** and *italic* text.';
      const editor = createTestEditor(input);

      const output = editor.getMarkdown();

      // Should preserve inline formatting
      expect(output).toContain(`**bold**`);
      // TipTap may normalize to underscore or asterisk
      expect(output).toMatch(/\*italic\*|_italic_/);

      editor.destroy();
    });

    it('preserves links', () => {
      const input = 'Check out [this link](https://example.com).';
      const editor = createTestEditor(input);

      const output = editor.getMarkdown();

      expect(output).toContain('[this link](https://example.com)');

      editor.destroy();
    });

    it('preserves unordered lists', () => {
      const input = '- Item 1\n- Item 2\n- Item 3';
      const editor = createTestEditor(input);

      const output = editor.getMarkdown();

      // TipTap may use different bullet styles, but structure should be preserved
      expect(output).toContain('Item 1');
      expect(output).toContain('Item 2');
      expect(output).toContain('Item 3');
      // Should have 3 list items
      expect(output.match(/^[-*]\s/gm)?.length).toBe(3);

      editor.destroy();
    });

    it('preserves ordered lists', () => {
      const input = '1. First\n2. Second\n3. Third';
      const editor = createTestEditor(input);

      const output = editor.getMarkdown();

      expect(output).toContain('First');
      expect(output).toContain('Second');
      expect(output).toContain('Third');
      expect(output.match(/^\d+\.\s/gm)?.length).toBe(3);

      editor.destroy();
    });

    it('preserves blockquotes', () => {
      const input = '> This is a quote\n> that spans multiple lines.';
      const editor = createTestEditor(input);

      const output = editor.getMarkdown();

      expect(output).toContain('>');
      expect(output).toContain('This is a quote');

      editor.destroy();
    });

    it('preserves inline code', () => {
      const input = 'Use `console.log()` for debugging.';
      const editor = createTestEditor(input);

      const output = editor.getMarkdown();

      expect(output).toContain('`console.log()`');

      editor.destroy();
    });

    it('preserves code blocks', () => {
      const input = '```javascript\nconst x = 1;\n```';
      const editor = createTestEditor(input);

      const output = editor.getMarkdown();

      expect(output).toContain('```');
      expect(output).toContain('const x = 1;');

      editor.destroy();
    });

    it('preserves horizontal rules', () => {
      const input = 'Above\n\n---\n\nBelow';
      const editor = createTestEditor(input);

      const output = editor.getMarkdown();

      expect(output).toContain('Above');
      expect(output).toContain('Below');
      // TipTap may use different hr syntax
      expect(output).toMatch(/---|\*\*\*|___/);

      editor.destroy();
    });
  });

  describe('Tables (GFM)', () => {
    it('preserves markdown tables', () => {
      const input = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |';
      const editor = createTestEditor(input);

      const output = editor.getMarkdown();

      expect(output).toContain('Name');
      expect(output).toContain('Age');
      expect(output).toContain('Alice');
      expect(output).toContain('30');
      expect(output).toContain('Bob');
      expect(output).toContain('25');
      // Should contain pipe-delimited table syntax
      expect(output).toContain('|');

      editor.destroy();
    });

    it('preserves table with multiple columns', () => {
      const input = '| Feature | Status | Owner |\n| --- | --- | --- |\n| Auth | Done | Alice |\n| Search | WIP | Bob |';
      const editor = createTestEditor(input);

      const output = editor.getMarkdown();

      expect(output).toContain('Feature');
      expect(output).toContain('Status');
      expect(output).toContain('Owner');
      expect(output).toContain('Auth');
      expect(output).toContain('Search');

      editor.destroy();
    });
  });

  describe('Complex documents', () => {
    it('preserves mixed content document', () => {
      const input = `# Meeting Notes

## Attendees

- Alice
- Bob
- Charlie

## Discussion

We discussed **important topics** including:

1. First item with \`code\`
2. Second item with [link](https://example.com)
3. Third item

> Key takeaway: This is a critical insight.

---

### Action Items

\`\`\`typescript
function example() {
  return true;
}
\`\`\`
`;
      const editor = createTestEditor(input);

      const output = editor.getMarkdown();

      // Key structural elements should be preserved
      expect(output).toContain('# Meeting Notes');
      expect(output).toContain('## Attendees');
      expect(output).toContain('Alice');
      expect(output).toContain(`**important topics**`);
      expect(output).toContain('[link](https://example.com)');
      expect(output).toContain('`code`');
      expect(output).toContain('>');
      expect(output).toContain('```');
      expect(output).toContain('function example()');

      editor.destroy();
    });
  });

  describe('Rebel-specific concerns', () => {
    it('preserves library:// protocol links', () => {
      const input = 'See [related doc](library://documents/notes.md).';
      const editor = createTestEditor(input);

      const output = editor.getMarkdown();

      expect(output).toContain('library://documents/notes.md');

      editor.destroy();
    });

    it('preserves workspace:// protocol links', () => {
      const input = 'See [file](workspace://path/to/file.txt).';
      const editor = createTestEditor(input);

      const output = editor.getMarkdown();

      expect(output).toContain('workspace://path/to/file.txt');

      editor.destroy();
    });

    it('handles frontmatter-like content gracefully', () => {
      // Note: TipTap doesn't have native frontmatter support
      // We check if document content is preserved (frontmatter may be rendered as text or hr)
      const input = `---
title: Test Document
date: 2026-02-05
---

# Document Content

Regular paragraph.`;
      const editor = createTestEditor(input);

      const output = editor.getMarkdown();

      // The document content should be preserved even if frontmatter handling varies
      expect(output).toContain('# Document Content');
      expect(output).toContain('Regular paragraph');

      editor.destroy();
    });

    it('preserves wikilinks text even without native support', () => {
      // Wikilinks may not be natively supported, but text shouldn't be corrupted
      const input = 'Check out [[Related Note]] for more info.';
      const editor = createTestEditor(input);

      const output = editor.getMarkdown();

      // At minimum, the text should be preserved (brackets may be escaped)
      expect(output).toContain('Related Note');

      editor.destroy();
    });
  });
});

describe('TipTap Editor API', () => {
  it('provides getMarkdown method', () => {
    const editor = createTestEditor('# Test');

    expect(editor.getMarkdown).toBeDefined();
    expect(typeof editor.getMarkdown()).toBe('string');

    editor.destroy();
  });

  it('supports setContent with markdown contentType', () => {
    const editor = createTestEditor('# Initial');

    editor.commands.setContent('# Updated', { contentType: 'markdown' });

    const output = editor.getMarkdown();
    expect(output).toContain('# Updated');

    editor.destroy();
  });

  it('supports text selection', () => {
    const editor = createTestEditor('Hello World');

    // Set cursor position
    editor.commands.setTextSelection({ from: 1, to: 5 });

    const { from, to } = editor.state.selection;
    expect(from).toBeDefined();
    expect(to).toBeDefined();

    editor.destroy();
  });

  it('supports focus command', () => {
    const editor = createTestEditor('Test content');

    // Focus command should exist and be callable
    expect(editor.commands.focus).toBeDefined();

    editor.destroy();
  });
});

describe('Bundle size estimation', () => {
  it('imports expected TipTap modules', async () => {
    // This test documents what we're importing
    // Bundle impact can be measured with npm run build + bundle analyzer
    const tiptapCore = await import('@tiptap/core');
    const tiptapReact = await import('@tiptap/react');
    const starterKit = await import('@tiptap/starter-kit');
    const markdown = await import('@tiptap/markdown');
    const table = await import('@tiptap/extension-table');
    const link = await import('@tiptap/extension-link');
    const placeholder = await import('@tiptap/extension-placeholder');

    expect(tiptapCore).toBeDefined();
    expect(tiptapReact).toBeDefined();
    expect(starterKit).toBeDefined();
    expect(markdown).toBeDefined();
    expect(table).toBeDefined();
    expect(link).toBeDefined();
    expect(placeholder).toBeDefined();
  });
});

describe('Image node parsing (FOX-2790)', () => {
  it('parses markdown image into an image node (not dropped)', () => {
    const input = '![screenshot](./images/screenshot.png)';
    const editor = createTestEditor(input);

    // The document should contain an image node
    let foundImage = false;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'image') {
        foundImage = true;
        expect(node.attrs.src).toBe('./images/screenshot.png');
        expect(node.attrs.alt).toBe('screenshot');
      }
    });
    expect(foundImage).toBe(true);

    editor.destroy();
  });

  it('preserves surrounding text with inline image', () => {
    const input = 'before ![img](path.png) after';
    const editor = createTestEditor(input);

    const textContent = editor.state.doc.textContent;
    expect(textContent).toContain('before');
    expect(textContent).toContain('after');

    // Image node should exist
    let imageCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'image') imageCount++;
    });
    expect(imageCount).toBe(1);

    editor.destroy();
  });

  it('handles image-only paragraph without corrupting document', () => {
    const input = '![alt](image.jpg)';
    const editor = createTestEditor(input);

    // Document should be valid (not empty or corrupted)
    expect(editor.state.doc.content.size).toBeGreaterThan(0);

    let foundImage = false;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'image') foundImage = true;
    });
    expect(foundImage).toBe(true);

    editor.destroy();
  });

  it('round-trips image markdown correctly', () => {
    const input = '![screenshot](./images/screenshot.png)';
    const editor = createTestEditor(input);

    const output = editor.getMarkdown();
    expect(output).toContain('![screenshot](./images/screenshot.png)');

    editor.destroy();
  });

  it('round-trips image with title', () => {
    const input = '![alt text](image.png "My Title")';
    const editor = createTestEditor(input);

    const output = editor.getMarkdown();
    expect(output).toContain('![alt text](image.png "My Title")');

    editor.destroy();
  });

  it('handles image with empty alt text', () => {
    const input = '![](path.png)';
    const editor = createTestEditor(input);

    let foundImage = false;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'image') {
        foundImage = true;
        expect(node.attrs.src).toBe('path.png');
        expect(node.attrs.alt).toBe('');
      }
    });
    expect(foundImage).toBe(true);

    const output = editor.getMarkdown();
    expect(output).toContain('![](path.png)');

    editor.destroy();
  });

  it('handles multiple images in the same paragraph', () => {
    const input = '![a](one.png) and ![b](two.png)';
    const editor = createTestEditor(input);

    let imageCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'image') imageCount++;
    });
    expect(imageCount).toBe(2);

    editor.destroy();
  });

  it('handles image with empty src', () => {
    const input = '![alt]()';
    const editor = createTestEditor(input);

    let foundImage = false;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'image') {
        foundImage = true;
        expect(node.attrs.alt).toBe('alt');
      }
    });
    expect(foundImage).toBe(true);

    editor.destroy();
  });

  it('preserves images in complex document with other elements', () => {
    const input = `# Document with Image

Here is some text with ![inline](img.png) image.

## Section 2

> A blockquote with text

- List item 1
- List item 2`;
    const editor = createTestEditor(input);

    // Image should be present
    let foundImage = false;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'image') foundImage = true;
    });
    expect(foundImage).toBe(true);

    // Other content should also be preserved
    const output = editor.getMarkdown();
    expect(output).toContain('# Document with Image');
    expect(output).toContain('![inline](img.png)');
    expect(output).toContain('Section 2');

    editor.destroy();
  });
});

describe('HTML entity handling (FOX-2621)', () => {
  /**
   * These tests verify that decodeHtmlEntitiesInMarkdown + TipTap round-trip
   * produces correct results without literal &nbsp; in ProseMirror text nodes.
   * Tests apply decodeHtmlEntitiesInMarkdown before creating the editor,
   * matching the real component flow in TipTapMarkdownEditor.tsx.
   */

  it('decoded &nbsp; in paragraph does not appear as literal text in ProseMirror', () => {
    const decoded = decodeHtmlEntitiesInMarkdown('Hello&nbsp;World');
    const editor = createTestEditor(decoded);

    const textContent = editor.state.doc.textContent;
    expect(textContent).not.toContain('&nbsp;');
    expect(textContent).toContain('Hello');
    expect(textContent).toContain('World');

    editor.destroy();
  });

  it('decoded &nbsp; in table cell does not appear as literal text', () => {
    const input = '| Header |\n|--------|\n| &nbsp; |';
    const decoded = decodeHtmlEntitiesInMarkdown(input);
    const editor = createTestEditor(decoded);

    const textContent = editor.state.doc.textContent;
    expect(textContent).not.toContain('&nbsp;');

    editor.destroy();
  });

  it('decoded double-encoded &amp;nbsp; does not appear as literal text', () => {
    const input = 'Text with &amp;nbsp; entity';
    const decoded = decodeHtmlEntitiesInMarkdown(input);
    const editor = createTestEditor(decoded);

    const textContent = editor.state.doc.textContent;
    expect(textContent).not.toContain('&nbsp;');
    expect(textContent).not.toContain('&amp;');

    editor.destroy();
  });

  it('getMarkdown() round-trip does not re-introduce &nbsp;', () => {
    const input = 'Hello&nbsp;World';
    const decoded = decodeHtmlEntitiesInMarkdown(input);
    const editor = createTestEditor(decoded);

    const output = editor.getMarkdown();
    expect(output).not.toContain('&nbsp;');

    editor.destroy();
  });
});

describe('loadMarkdownContentSafely — crash guard (REBEL-64W/5KJ)', () => {
  it('loads valid markdown normally through the guard', () => {
    const editor = createTestEditor('seed');
    loadMarkdownContentSafely(editor, '# Hello\n\nWorld **bold**');
    const output = editor.getMarkdown();
    expect(output).toContain('# Hello');
    expect(output).toContain('**bold**');
    editor.destroy();
  });

  // When the markdown parse throws a schema violation (the REBEL-64W/5KJ
  // class), the guard must NOT rethrow (which would crash the renderer) and
  // must preserve non-empty content as a plaintext-paragraph fallback.
  it('recovers from a schema-invalid parse and preserves text as plaintext', () => {
    const calls: Array<{ content: unknown; opts?: { contentType?: string } }> = [];
    const fakeEditor = {
      commands: {
        setContent: (content: unknown, opts?: { contentType?: string }) => {
          calls.push({ content, opts });
          if (opts?.contentType === 'markdown') {
            throw new Error('Invalid content for node doc: <>');
          }
          return true;
        },
      },
    } as unknown as Parameters<typeof loadMarkdownContentSafely>[0];

    expect(() => loadMarkdownContentSafely(fakeEditor, 'some **markdown**')).not.toThrow();
    expect(calls).toHaveLength(2);
    expect(calls[0].opts?.contentType).toBe('markdown');
    expect(calls[1].content).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'some **markdown**' }] }],
    });
  });

  it('falls back to an empty paragraph for blank input when the parse throws', () => {
    const calls: unknown[] = [];
    const fakeEditor = {
      commands: {
        setContent: (content: unknown, opts?: { contentType?: string }) => {
          calls.push(content);
          if (opts?.contentType === 'markdown') throw new Error('Content hole not allowed in a leaf node spec');
          return true;
        },
      },
    } as unknown as Parameters<typeof loadMarkdownContentSafely>[0];

    expect(() => loadMarkdownContentSafely(fakeEditor, '   ')).not.toThrow();
    expect(calls[1]).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
  });
});
