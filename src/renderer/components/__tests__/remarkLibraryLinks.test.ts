import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import * as coreNavigation from '@core/navigation';
import { encodeSpacesInMarkdownLinks } from '@rebel/shared';
import type { SpaceInfo, SpaceType } from '@shared/ipc/schemas/library';
import { remarkLibraryLinks, type RemarkLibraryLinksOptions } from '../remarkLibraryLinks';

/**
 * Tests for the remarkLibraryLinks plugin
 *
 * This plugin transforms relative and absolute file paths in Markdown links
 * to the canonical `rebel://library/` protocol URL at the AST level.
 *
 * Stage H of docs/plans/260416_centralize_cross_surface_links.md migrated the
 * emitter from `library://` to `rebel://library/` so all surfaces share one
 * URL scheme. Legacy `library://` and `workspace://` URLs remain readable
 * indefinitely via `getLibraryProtocol` / `extractLibraryPath`.
 */

async function transformMarkdown(markdown: string, options?: RemarkLibraryLinksOptions): Promise<string> {
  const result = await unified()
    .use(remarkParse)
    .use(remarkLibraryLinks, options)
    .use(remarkStringify)
    .process(markdown);
  return String(result);
}

async function transformMessageMarkdownInput(
  markdown: string,
  options?: RemarkLibraryLinksOptions,
): Promise<string> {
  return transformMarkdown(encodeSpacesInMarkdownLinks(markdown), options);
}

/**
 * Parse + run the plugin and return the resulting mdast tree. Useful for
 * asserting on node *types* (e.g. `imageReference` vs `image`) rather than
 * stringified output, since `remark-stringify` can collapse some node
 * distinctions.
 */
async function transformToTree(
  markdown: string,
  options?: RemarkLibraryLinksOptions,
): Promise<import('mdast').Root> {
  const processor = unified().use(remarkParse).use(remarkLibraryLinks, options);
  const tree = processor.parse(markdown) as import('mdast').Root;
  await processor.run(tree);
  return tree;
}

function makeSpace(overrides: Partial<SpaceInfo> & { name: string; absolutePath: string; type: SpaceType }): SpaceInfo {
  return {
    name: overrides.name,
    path: overrides.path ?? overrides.name,
    absolutePath: overrides.absolutePath,
    type: overrides.type,
    isSymlink: overrides.isSymlink ?? false,
    hasReadme: overrides.hasReadme ?? true,
    sourcePath: overrides.sourcePath,
    sharing: overrides.sharing,
    status: overrides.status ?? 'ok',
  } as SpaceInfo;
}

describe('remarkLibraryLinks plugin', () => {
  describe('basic transformations', () => {
    it('transforms simple relative paths', async () => {
      const input = '[Doc](docs/file.md)';
      const output = await transformMarkdown(input);
      expect(output).toContain('rebel://library/docs%2Ffile.md');
    });

    it('transforms paths with ./ prefix', async () => {
      const input = '[Doc](./docs/file.md)';
      const output = await transformMarkdown(input);
      expect(output).toContain('rebel://library/.%2Fdocs%2Ffile.md');
    });

    it('transforms paths with ../ prefix', async () => {
      const input = '[Doc](../docs/file.md)';
      const output = await transformMarkdown(input);
      expect(output).toContain('rebel://library/..%2Fdocs%2Ffile.md');
    });

    it('transforms root-level files like README.md', async () => {
      const input = '[Readme](README.md)';
      const output = await transformMarkdown(input);
      expect(output).toContain('rebel://library/README.md');
    });

    it('transforms folder links with trailing slash', async () => {
      const input = '[Docs](docs/)';
      const output = await transformMarkdown(input);
      expect(output).toContain('rebel://library/docs%2F');
    });

    it('transforms absolute Unix paths', async () => {
      const input = '[File](/Users/path/file.md)';
      const output = await transformMarkdown(input);
      expect(output).toContain('rebel://library/%2FUsers%2Fpath%2Ffile.md');
    });
  });

  describe('fragment handling', () => {
    it('preserves fragment (does not encode # as %23)', async () => {
      const input = '[Section](docs/file.md#heading)';
      const output = await transformMarkdown(input);
      expect(output).toContain('rebel://library/docs%2Ffile.md#heading');
      expect(output).not.toContain('%23');
    });

    it('preserves fragment with special characters', async () => {
      const input = '[Section](docs/file.md#some-heading-here)';
      const output = await transformMarkdown(input);
      expect(output).toContain('#some-heading-here');
    });
  });

  describe('query parameter handling', () => {
    it('preserves query parameters', async () => {
      const input = '[Doc](docs/file.md?raw=true)';
      const output = await transformMarkdown(input);
      expect(output).toContain('rebel://library/docs%2Ffile.md?raw=true');
    });

    it('preserves both query and fragment', async () => {
      const input = '[Doc](docs/file.md?raw=true#heading)';
      const output = await transformMarkdown(input);
      expect(output).toContain('rebel://library/docs%2Ffile.md?raw=true#heading');
    });
  });

  describe('Windows path handling', () => {
    it('transforms Windows absolute paths with backslash', async () => {
      const input = '[File](C:\\Users\\path\\file.md)';
      const output = await transformMarkdown(input);
      expect(output).toContain('rebel://library/');
      // Note: Markdown parser may have already handled the backslashes
    });

    it('transforms Windows absolute paths with forward slash', async () => {
      const input = '[File](C:/Users/path/file.md)';
      const output = await transformMarkdown(input);
      expect(output).toContain('rebel://library/');
    });

    it('does not treat Windows drive letter as protocol', async () => {
      const input = '[File](D:/Documents/file.md)';
      const output = await transformMarkdown(input);
      // Should be transformed, not skipped
      expect(output).toContain('rebel://library/');
    });
  });

  describe('protocol URLs (should not transform)', () => {
    it('does not transform http:// URLs', async () => {
      const input = '[Site](https://example.com)';
      const output = await transformMarkdown(input);
      expect(output).toContain('https://example.com');
      expect(output).not.toContain('rebel://library/');
    });

    it('does not transform mailto: URLs', async () => {
      const input = '[Email](mailto:test@example.com)';
      const output = await transformMarkdown(input);
      expect(output).toContain('mailto:test@example.com');
      expect(output).not.toContain('rebel://library/');
    });

    it('does not transform file:// URLs', async () => {
      const input = '[File](file:///path/to/file.md)';
      const output = await transformMarkdown(input);
      expect(output).toContain('file:///path/to/file.md');
      expect(output).not.toContain('rebel://library/file');
    });

    it('does not transform library:// URLs (legacy form — left untouched for backwards compat)', async () => {
      const input = '[File](library://docs/file.md)';
      const output = await transformMarkdown(input);
      // Legacy `library://` URLs are a protocol form — remark leaves them
      // alone. Readers (extractLibraryPath) still accept them.
      expect(output).toContain('library://docs/file.md');
      expect(output).not.toContain('rebel://library/');
    });

    it('does not transform workspace:// URLs (backwards compat)', async () => {
      const input = '[File](workspace://docs/file.md)';
      const output = await transformMarkdown(input);
      // Should not transform - it's already a protocol URL
      expect(output).toContain('workspace://docs/file.md');
      expect(output).not.toContain('rebel://library/workspace');
    });

    it('does not transform rebel:// URLs', async () => {
      const input = '[Conv](rebel://conversation/123)';
      const output = await transformMarkdown(input);
      expect(output).toContain('rebel://conversation/123');
      expect(output).not.toContain('rebel://library/');
    });

    it('does not transform data: URLs', async () => {
      const input = '[Data](data:text/plain;base64,SGVsbG8=)';
      const output = await transformMarkdown(input);
      expect(output).toContain('data:text/plain');
      expect(output).not.toContain('rebel://library/');
    });
  });

  describe('special cases', () => {
    it('does not transform anchor-only links', async () => {
      const input = '[Top](#top)';
      const output = await transformMarkdown(input);
      expect(output).toContain('#top');
      expect(output).not.toContain('rebel://library/');
    });

    it('does not transform protocol-relative URLs', async () => {
      const input = '[Site](//example.com/path)';
      const output = await transformMarkdown(input);
      expect(output).toContain('//example.com/path');
      expect(output).not.toContain('rebel://library/');
    });

    it('does not transform empty links', async () => {
      const input = '[Empty]()';
      const output = await transformMarkdown(input);
      expect(output).not.toContain('rebel://library/');
    });

    it('handles already-encoded URLs', async () => {
      const input = '[Doc](docs%2Ffile.md)';
      const output = await transformMarkdown(input);
      // Should decode first, then re-encode
      expect(output).toContain('rebel://library/');
    });
  });

  describe('edge cases from real-world usage', () => {
    it('handles paths with spaces (encoded)', async () => {
      const input = '[Doc](docs/my%20file.md)';
      const output = await transformMarkdown(input);
      expect(output).toContain('rebel://library/');
    });

    it('handles paths with special characters', async () => {
      const input = '[Doc](docs/file-name_v2.md)';
      const output = await transformMarkdown(input);
      expect(output).toContain('rebel://library/');
    });

    it('handles wikilink-style paths (from rebel-system)', async () => {
      // This tests paths that might have been converted from wikilinks
      const input = '[topics/my-topic](topics/my-topic.md)';
      const output = await transformMarkdown(input);
      expect(output).toContain('rebel://library/topics%2Fmy-topic.md');
    });

    it('handles skills paths', async () => {
      const input = '[Skill](skills/memory/memory-update/SKILL.md)';
      const output = await transformMarkdown(input);
      expect(output).toContain('rebel://library/skills%2Fmemory%2Fmemory-update%2FSKILL.md');
    });
  });

  // Stage 1 of docs/plans/260418_finish_cross_surface_links_closeout.md:
  // when `coreDirectory` + `spaces` are supplied, the plugin should route
  // through `toBestFileLink` and emit `rebel://space/` for shareable spaces
  // and `rebel://library/` (workspace-relative) for private/unmatched ones.
  describe('Stage 1 — space-URL emission when coreDirectory + spaces are supplied', () => {
    const CORE = '/Users/me/core';
    const shared: SpaceInfo = makeSpace({
      name: 'Shared',
      absolutePath: `${CORE}/Shared`,
      type: 'team',
    });
    const privateSpace: SpaceInfo = makeSpace({
      name: 'Personal',
      absolutePath: `${CORE}/Personal`,
      type: 'chief-of-staff',
    });

    it('emits rebel://space/ for a file inside a shareable space', async () => {
      const output = await transformMarkdown('[Q1](Shared/notes/Q1.md)', {
        coreDirectory: CORE,
        spaces: [shared],
        spacesReady: true,
      });
      expect(output).toContain('rebel://space/Shared/notes%2FQ1.md');
    });

    it('emits workspace-relative rebel://library/ for a file inside a private (chief-of-staff) space', async () => {
      const output = await transformMarkdown('[Doc](Personal/diary.md)', {
        coreDirectory: CORE,
        spaces: [privateSpace],
        spacesReady: true,
      });
      expect(output).toContain('rebel://library/Personal%2Fdiary.md');
      expect(output).not.toContain('rebel://space/');
    });

    it('falls back to library form when spacesReady=false', async () => {
      const output = await transformMarkdown('[Q1](Shared/notes/Q1.md)', {
        coreDirectory: CORE,
        spaces: [shared],
        spacesReady: false,
      });
      expect(output).toContain('rebel://library/Shared%2Fnotes%2FQ1.md');
      expect(output).not.toContain('rebel://space/');
    });

    it('preserves fragment on space URLs', async () => {
      const output = await transformMarkdown('[Sec](Shared/Q1.md#heading)', {
        coreDirectory: CORE,
        spaces: [shared],
        spacesReady: true,
      });
      expect(output).toContain('rebel://space/Shared/Q1.md#heading');
      expect(output).not.toContain('%23');
    });
  });

  /**
   * Stage I6 — explicit markdown image syntax (`![alt](path)`) now routes
   * through the plugin's `image` visitor in parity with the `link` visitor.
   * See docs/plans/260422_broken_image_followups_i6_i7.md Stage I6.
   */
  describe('Stage I6 — explicit markdown image syntax', () => {
    it('T6 transforms a basic image path', async () => {
      const output = await transformMarkdown('![alt](docs/file.png)');
      expect(output.trim()).toBe('![alt](rebel://library/docs%2Ffile.png)');
    });

    it('T7 transforms image paths with spaces (pipeline mirrors production preprocessor)', async () => {
      const output = await transformMessageMarkdownInput('![alt](my image.png)');
      expect(output.trim()).toBe('![alt](rebel://library/my%20image.png)');
    });

    it('T8 does not transform protocol image URLs', async () => {
      const output = await transformMarkdown('![alt](https://example.com/x.png)');
      expect(output.trim()).toBe('![alt](https://example.com/x.png)');
    });

    it('T9 preserves image titles', async () => {
      const output = await transformMarkdown('![alt](x.png "My Image")');
      expect(output.trim()).toBe('![alt](rebel://library/x.png "My Image")');
    });

    it('T10 encodes fragments inside the library URL (not as suffix)', async () => {
      const output = await transformMarkdown('![alt](x.png#anchor)');
      expect(output.trim()).toBe('![alt](rebel://library/x.png%23anchor)');
    });

    it('T11 encodes query strings inside the library URL (not as suffix)', async () => {
      const output = await transformMarkdown('![alt](x.png?v=2)');
      expect(output.trim()).toBe('![alt](rebel://library/x.png%3Fv%3D2)');
    });

    it('T12 always emits rebel://library/ for images in shareable spaces and skips toBestFileLink for the image path', async () => {
      const CORE = '/Users/me/core';
      const shared = makeSpace({
        name: 'Shared',
        absolutePath: `${CORE}/Shared`,
        type: 'team',
      });

      // Mixed link + image input proves the live-export spy is wired: the link
      // should call `toBestFileLink`, while the image must not add a second call.
      const toBestFileLinkSpy = vi.spyOn(coreNavigation, 'toBestFileLink');
      const output = await transformMarkdown('[Doc](Shared/doc.md)\n![alt](Shared/img.png)', {
        coreDirectory: CORE,
        spaces: [shared],
        spacesReady: true,
      });

      expect(output).toContain('[Doc](rebel://space/Shared/doc.md)');
      expect(output).toContain('![alt](rebel://library/Shared%2Fimg.png)');
      expect(output).not.toContain('![alt](rebel://space/');
      expect(toBestFileLinkSpy).toHaveBeenCalledTimes(1);

      toBestFileLinkSpy.mockRestore();
    });

    it('T13 does not transform anchor-only image URLs', async () => {
      const output = await transformMarkdown('![alt](#only)');
      expect(output.trim()).toBe('![alt](#only)');
    });

    it('T21 leaves reference-style images unchanged (regression guard for I11 deliberate non-coverage)', async () => {
      // Note: reference-style definition URLs with spaces do not round-trip
      // through `remark-parse` cleanly (spaces are not escaped → parser falls
      // back to plain text). Use a space-free path so the tree actually
      // contains `imageReference` + `definition` nodes.
      const tree = await transformToTree('![alt][ref]\n\n[ref]: image.png');

      // Walk the tree and collect node types so we can assert the
      // deliberate-non-coverage contract: the plugin MUST NOT rewrite
      // `imageReference` or `definition` nodes into inline `image` nodes.
      const nodeTypes: string[] = [];
      const visitTree = (node: { type: string; children?: Array<{ type: string; children?: unknown }> }): void => {
        nodeTypes.push(node.type);
        if (Array.isArray(node.children)) {
          for (const child of node.children) {
            visitTree(child as { type: string; children?: Array<{ type: string; children?: unknown }> });
          }
        }
      };
      visitTree(tree);

      expect(nodeTypes).toContain('imageReference');
      expect(nodeTypes).toContain('definition');
      expect(nodeTypes).not.toContain('image');

      // Assert the definition node's url field was NOT rewritten.
      const findNode = (
        root: import('mdast').Root,
        type: string,
      ): { url?: string } | null => {
        let found: { url?: string } | null = null;
        const walk = (node: { type: string; children?: unknown[]; url?: string }): void => {
          if (found) return;
          if (node.type === type) {
            found = node as { url?: string };
            return;
          }
          if (Array.isArray(node.children)) {
            for (const child of node.children) {
              walk(child as { type: string; children?: unknown[]; url?: string });
            }
          }
        };
        walk(root as unknown as { type: string; children?: unknown[]; url?: string });
        return found;
      };
      const definitionNode = findNode(tree, 'definition');
      expect(definitionNode?.url).toBe('image.png');
      expect(definitionNode?.url?.startsWith('rebel://')).toBe(false);

      // Belt-and-suspenders: the stringified output must still round-trip to
      // reference form and must not emit a library URL anywhere in the tree.
      const output = await transformMarkdown('![alt][ref]\n\n[ref]: image.png');
      expect(output).toContain('[ref]: image.png');
      expect(output).not.toContain('rebel://library/');
    });

    it('T22 round-trips already-encoded image URLs', async () => {
      const output = await transformMarkdown('![alt](my%20image.png)');
      expect(output.trim()).toBe('![alt](rebel://library/my%20image.png)');
    });

    it('T23 leaves empty image URLs unchanged', async () => {
      const output = await transformMarkdown('![alt]()');
      expect(output.trim()).toBe('![alt]()');
    });

    it('T24 leaves protocol-relative image URLs unchanged', async () => {
      const output = await transformMarkdown('![alt](//example.com/x.png)');
      expect(output.trim()).toBe('![alt](//example.com/x.png)');
    });

    it('T24b does not crash on malformed Unicode in image URLs and emits a fallback breadcrumb', async () => {
      // Lone surrogate — `encodeURIComponent` throws `URI malformed`. Plugin
      // must fall back rather than crashing the render AND emit a warning so
      // the silent-swallow is observable (AGENTS.md: "Silent failure is a bug").
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const loneSurrogate = 'foo\uD800bar.png';
        const tree = await transformToTree(`![alt](${loneSurrogate})`);
        // No throw ==> pass for crash-safety.
        expect(() => tree).not.toThrow();
        // Observability: the fallback path logged a warning with the original URL.
        const fallbackCalls = warnSpy.mock.calls.filter(
          (call) => call[0] === '[Renderer] remarkLibraryLinks image fallback',
        );
        expect(fallbackCalls).toHaveLength(1);
        const payload = fallbackCalls[0]?.[1] as { url?: string; error?: string } | undefined;
        expect(payload?.url).toBe(loneSurrogate);
        expect(typeof payload?.error).toBe('string');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('T24c transforms Windows drive-letter image paths', async () => {
      // Parity with the link-visitor Windows-path coverage: drive letters
      // (`C:` / `D:`) must be treated as paths, not protocol URLs.
      const winPath = await transformMarkdown('![diagram](C:/Users/me/diagram.png)');
      expect(winPath.trim()).toContain('rebel://library/');
      expect(winPath.trim()).not.toContain('![diagram](C:/');

      const otherDrive = await transformMarkdown('![report](D:/reports/q1.png)');
      expect(otherDrive.trim()).toContain('rebel://library/');
    });
  });
});
