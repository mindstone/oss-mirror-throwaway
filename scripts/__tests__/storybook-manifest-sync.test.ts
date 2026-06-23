/**
 * Stage 0 anti-drift guard for the Storybook source-of-truth layer
 * (FOX-3131). This test is a non-mutating parity and contract check:
 *
 *   - It reads the curated `storybookManifest.ts` and the committed
 *     generated artifact at
 *     `src/renderer/components/ui/manifests/storybook_component_manifest.json`
 *     and asserts they agree, ignoring only `generatedAt`.
 *   - It runs the same validator wired into the manifest export
 *     script so CI catches manifest/story drift whether or not the
 *     user remembered to re-run `npm run report:storybook-manifest`.
 *   - It exercises the validator directly on synthetic fixtures to
 *     lock in the recursive discovery surface and the uniqueness
 *     rules (duplicate manifest ids, duplicate manifest storyTitles,
 *     duplicate story meta.titles), which are easy to regress.
 *
 * The committed JSON is never rewritten by this test; failures point
 * developers at the manifest export script as the single source of
 * truth.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storybookManifest } from '../../src/renderer/components/ui/storybookManifest';
import {
  ALLOWED_MANIFEST_STORY_TITLES_WITHOUT_STORY,
  ALLOWED_NON_MANIFEST_STORY_TITLES,
  CONFIGURED_STORY_EXTENSIONS,
  PROJECT_ROOT,
  STORY_DIR,
  STORY_ROOT_RELATIVE,
  buildStorybookStoriesGlob,
  collectStoryTitles,
  discoverStoryFiles,
  extractMetaTitle,
  formatIssues,
  validateManifestContract,
} from '../storybookManifestContract';

const COMMITTED_JSON_PATH = path.join(
  PROJECT_ROOT,
  'src',
  'renderer',
  'components',
  'ui',
  'manifests',
  'storybook_component_manifest.json',
);

describe('storybook manifest ↔ story title contract (FOX-3131 Stage 0)', () => {
  const stories = collectStoryTitles(STORY_DIR);

  it('has no contract violations', () => {
    const issues = validateManifestContract({
      manifest: storybookManifest,
      stories,
      projectRoot: PROJECT_ROOT,
    });
    // Surface individual issues in the Vitest output for fast triage
    // without forcing the whole array into an assertion diff.
    if (issues.length > 0) {
      // eslint-disable-next-line no-console
      console.error('\nStorybook contract guard found issues:\n' + formatIssues(issues));
    }
    expect(issues).toEqual([]);
  });

  it('every manifest storyTitle resolves to an actual meta.title (or is an allowlisted missing story)', () => {
    const storyTitleSet = new Set(stories.map((s) => s.title));
    const allowlist = new Set(ALLOWED_MANIFEST_STORY_TITLES_WITHOUT_STORY);
    const unresolved = storybookManifest
      .filter(
        (family) => !storyTitleSet.has(family.storyTitle) && !allowlist.has(family.storyTitle),
      )
      .map((family) => `${family.id} -> ${family.storyTitle}`);
    expect(unresolved).toEqual([]);
  });

  it('every Storybook story is manifest-backed or explicitly allowlisted', () => {
    const manifestTitleSet = new Set(storybookManifest.map((m) => m.storyTitle));
    const allowlist = new Set(ALLOWED_NON_MANIFEST_STORY_TITLES);
    const orphans = stories
      .filter((s) => !manifestTitleSet.has(s.title) && !allowlist.has(s.title))
      .map((s) => `${s.title} (${path.relative(PROJECT_ROOT, s.file)})`);
    expect(orphans).toEqual([]);
  });

  it('committed storybook_component_manifest.json matches in-repo manifest (ignoring generatedAt)', () => {
    const raw = fs.readFileSync(COMMITTED_JSON_PATH, 'utf8');
    const parsed = JSON.parse(raw) as { generatedAt?: string; families?: unknown };
    expect(parsed.families).toEqual(storybookManifest);
  });

  it('allowlists stay small so retirement TODOs remain visible', () => {
    // Guardrail: the allowlists are stage-0 bootstrap tolerances plus
    // the single intentional landing-page exception. Flag if they grow
    // silently beyond that so reviewers notice.
    expect(ALLOWED_NON_MANIFEST_STORY_TITLES.length).toBeLessThanOrEqual(3);
    expect(ALLOWED_MANIFEST_STORY_TITLES_WITHOUT_STORY.length).toBeLessThanOrEqual(2);
  });
});

/**
 * Fixture-backed tests. These write minimal story files into a
 * temporary directory and run the helper against it so we can lock
 * in discovery and uniqueness behaviour without coupling to the
 * real `src/renderer/components/ui` tree.
 */
describe('storybookManifestContract discovery + uniqueness (FOX-3131 Stage 0)', () => {
  let tmpDir: string;

  const writeStory = (relativePath: string, title: string): string => {
    const abs = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      [
        `import type { Meta } from '@storybook/react';`,
        ``,
        `const meta = {`,
        `  title: '${title}',`,
        `} satisfies Meta;`,
        ``,
        `export default meta;`,
        ``,
      ].join('\n'),
      'utf8',
    );
    return abs;
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storybook-contract-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('recursively discovers nested .stories.ts and .stories.tsx files', () => {
    const top = writeStory('Top.stories.tsx', 'Design System/Top');
    const nested = writeStory(
      path.join('nested', 'deep', 'Nested.stories.tsx'),
      'Design System/Nested',
    );
    const tsOnly = writeStory(path.join('nested', 'Bare.stories.ts'), 'Design System/Bare');

    const files = discoverStoryFiles(tmpDir);
    expect(new Set(files)).toEqual(new Set([top, nested, tsOnly]));

    const records = collectStoryTitles(tmpDir);
    const titles = records.map((r) => r.title).sort();
    expect(titles).toEqual(['Design System/Bare', 'Design System/Nested', 'Design System/Top']);
  });

  it('fails loudly when an .mdx story is discovered', () => {
    writeStory('Top.stories.tsx', 'Design System/Top');
    const mdxPath = path.join(tmpDir, 'nested', 'Broken.stories.mdx');
    fs.mkdirSync(path.dirname(mdxPath), { recursive: true });
    fs.writeFileSync(mdxPath, '<Meta title="Design System/Broken" />\n', 'utf8');

    expect(() => discoverStoryFiles(tmpDir)).toThrowError(/\.mdx/i);
    expect(() => discoverStoryFiles(tmpDir)).toThrowError(/nested\/Broken\.stories\.mdx/);
  });

  it('flags duplicate manifest ids as a contract issue', () => {
    writeStory('A.stories.tsx', 'Design System/A');
    const stories = collectStoryTitles(tmpDir);

    const issues = validateManifestContract({
      manifest: [
        {
          id: 'dup',
          title: 'A',
          storyTitle: 'Design System/A',
          status: 'shared',
          summary: '',
          sourceFiles: [],
          appUsageFiles: [],
        },
        {
          id: 'dup',
          title: 'A again',
          storyTitle: 'Design System/A-again',
          status: 'shared',
          summary: '',
          sourceFiles: [],
          appUsageFiles: [],
        },
      ],
      stories,
      projectRoot: tmpDir,
      missingStoryAllowlist: ['Design System/A-again'],
    });

    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain('duplicate-manifest-id');
    expect(
      issues.find((i) => i.kind === 'duplicate-manifest-id')?.message,
    ).toMatch(/'dup'/);
  });

  it('flags duplicate manifest storyTitles as a contract issue', () => {
    writeStory('A.stories.tsx', 'Design System/Shared');
    const stories = collectStoryTitles(tmpDir);

    const issues = validateManifestContract({
      manifest: [
        {
          id: 'one',
          title: 'One',
          storyTitle: 'Design System/Shared',
          status: 'shared',
          summary: '',
          sourceFiles: [],
          appUsageFiles: [],
        },
        {
          id: 'two',
          title: 'Two',
          storyTitle: 'Design System/Shared',
          status: 'shared',
          summary: '',
          sourceFiles: [],
          appUsageFiles: [],
        },
      ],
      stories,
      projectRoot: tmpDir,
    });

    const duplicates = issues.filter((i) => i.kind === 'duplicate-manifest-story-title');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].message).toMatch(/Design System\/Shared/);
  });

  it('flags duplicate story meta.title values (cross-file) as a contract issue', () => {
    writeStory('A.stories.tsx', 'Design System/Dup');
    writeStory(path.join('nested', 'B.stories.tsx'), 'Design System/Dup');
    const stories = collectStoryTitles(tmpDir);

    const issues = validateManifestContract({
      manifest: [
        {
          id: 'dup',
          title: 'Dup',
          storyTitle: 'Design System/Dup',
          status: 'shared',
          summary: '',
          sourceFiles: [],
          appUsageFiles: [],
        },
      ],
      stories,
      projectRoot: tmpDir,
    });

    const dupIssues = issues.filter((i) => i.kind === 'duplicate-story-title');
    expect(dupIssues).toHaveLength(1);
    expect(dupIssues[0].message).toMatch(/Design System\/Dup/);
    expect(dupIssues[0].message).toMatch(/A\.stories\.tsx/);
    expect(dupIssues[0].message).toMatch(/nested\/B\.stories\.tsx/);
  });

  it('passes clean fixtures with unique ids, storyTitles, and meta.titles', () => {
    writeStory('A.stories.tsx', 'Design System/A');
    writeStory(path.join('nested', 'B.stories.tsx'), 'Design System/B');
    const stories = collectStoryTitles(tmpDir);

    const issues = validateManifestContract({
      manifest: [
        {
          id: 'a',
          title: 'A',
          storyTitle: 'Design System/A',
          status: 'shared',
          summary: '',
          sourceFiles: [],
          appUsageFiles: [],
        },
        {
          id: 'b',
          title: 'B',
          storyTitle: 'Design System/B',
          status: 'shared',
          summary: '',
          sourceFiles: [],
          appUsageFiles: [],
        },
      ],
      stories,
      projectRoot: tmpDir,
    });

    expect(issues).toEqual([]);
  });

  it('flags missing-source-file when a manifest sourceFiles path does not exist', () => {
    writeStory('A.stories.tsx', 'Design System/A');
    fs.writeFileSync(path.join(tmpDir, 'real-source.tsx'), '// real\n', 'utf8');
    const stories = collectStoryTitles(tmpDir);

    const issues = validateManifestContract({
      manifest: [
        {
          id: 'a',
          title: 'A',
          storyTitle: 'Design System/A',
          status: 'shared',
          summary: '',
          sourceFiles: ['real-source.tsx', 'does-not-exist.tsx'],
          appUsageFiles: [],
        },
      ],
      stories,
      projectRoot: tmpDir,
    });

    const missing = issues.filter((i) => i.kind === 'missing-source-file');
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toMatch(/does-not-exist\.tsx/);
    expect(missing[0].message).toMatch(/'a'/);
    expect(issues.find((i) => i.kind === 'missing-source-file' && /real-source\.tsx/.test(i.message))).toBeUndefined();
  });

  it('flags missing-app-usage-file when a manifest appUsageFiles path does not exist', () => {
    writeStory('A.stories.tsx', 'Design System/A');
    fs.writeFileSync(path.join(tmpDir, 'real-usage.tsx'), '// real\n', 'utf8');
    const stories = collectStoryTitles(tmpDir);

    const issues = validateManifestContract({
      manifest: [
        {
          id: 'a',
          title: 'A',
          storyTitle: 'Design System/A',
          status: 'shared',
          summary: '',
          sourceFiles: [],
          appUsageFiles: ['real-usage.tsx', 'stale-usage.tsx'],
        },
      ],
      stories,
      projectRoot: tmpDir,
    });

    const missing = issues.filter((i) => i.kind === 'missing-app-usage-file');
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toMatch(/stale-usage\.tsx/);
    expect(missing[0].message).toMatch(/'a'/);
    expect(issues.find((i) => i.kind === 'missing-app-usage-file' && /real-usage\.tsx/.test(i.message))).toBeUndefined();
  });
});

/**
 * Depth-aware extractor regression coverage. Locks in the fix for
 * the reviewer-flagged false positive: the extractor must not return
 * an unrelated `title:` found elsewhere in the file when the meta
 * object itself does not declare a top-level `title`.
 */
describe('extractMetaTitle (FOX-3131 Stage 0 refinement)', () => {
  it('returns the top-level meta.title even when later objects also have a title field', () => {
    const source = [
      `import type { Meta, StoryObj } from '@storybook/react';`,
      ``,
      `const meta = {`,
      `  title: 'Design System/TopLevel',`,
      `  component: Thing,`,
      `  args: { title: 'this is a prop, not meta.title' },`,
      `} satisfies Meta<typeof Thing>;`,
      ``,
      `export default meta;`,
      ``,
      `type Args = { title: string };`,
      ``,
      `export const Primary: StoryObj = {`,
      `  args: { title: 'primary arg' },`,
      `};`,
    ].join('\n');

    expect(extractMetaTitle(source)).toBe('Design System/TopLevel');
  });

  it('returns null when meta.title is missing even if later unrelated title: fields exist', () => {
    const source = [
      `import type { Meta, StoryObj } from '@storybook/react';`,
      ``,
      `const meta = {`,
      `  component: Thing,`,
      `  args: { title: 'nested, at depth > 0' },`,
      `  parameters: { docs: { description: { component: 'no title here' } } },`,
      `} satisfies Meta<typeof Thing>;`,
      ``,
      `export default meta;`,
      ``,
      `type Args = { title: string };`,
      ``,
      `export const Primary: StoryObj = {`,
      `  args: { title: 'this must not be picked up by the extractor' },`,
      `};`,
      ``,
      `const fallback = {`,
      `  title: 'neither should this',`,
      `};`,
    ].join('\n');

    expect(extractMetaTitle(source)).toBeNull();
  });

  it('ignores `title:` commented out above the meta declaration', () => {
    const source = [
      `// Historical note: title: 'Old/Name' was removed intentionally.`,
      `/*`,
      ` * title: 'Even older name'`,
      ` */`,
      `const meta = {`,
      `  title: 'Design System/Current',`,
      `  component: Thing,`,
      `} satisfies Meta<typeof Thing>;`,
    ].join('\n');

    expect(extractMetaTitle(source)).toBe('Design System/Current');
  });

  it('supports typed meta declarations (const meta: Meta<typeof X> = { ... })', () => {
    const source = [
      `const meta: Meta<typeof Thing> = {`,
      `  title: 'Design System/Typed',`,
      `  component: Thing,`,
      `};`,
      `export default meta;`,
    ].join('\n');

    expect(extractMetaTitle(source)).toBe('Design System/Typed');
  });

  it('does not false-match `title:` inside a regex literal when meta has no real title', () => {
    // The regex body contains the literal text `title:` at depth 0 of
    // the meta object. A scanner that does not recognize regex
    // literals would pick this up and invent a phantom meta title.
    const source = [
      `const meta = {`,
      `  component: Thing,`,
      `  pattern: /title: 'phantom'/,`,
      `} satisfies Meta<typeof Thing>;`,
      `export default meta;`,
    ].join('\n');

    expect(extractMetaTitle(source)).toBeNull();
  });

  it('still extracts the real title when a regex literal appears before it at depth 0', () => {
    // Regex bodies can contain `]`, `{`, and `(`, any of which would
    // corrupt bracket-depth tracking and could cause the scanner to
    // give up before reaching the real `title:` further down. Locks
    // in the false-negative fix.
    const source = [
      `const meta = {`,
      `  component: Thing,`,
      `  pattern: /[\\]{}()]+/g,`,
      `  title: 'Design System/RegexAware',`,
      `} satisfies Meta<typeof Thing>;`,
      `export default meta;`,
    ].join('\n');

    expect(extractMetaTitle(source)).toBe('Design System/RegexAware');
  });

  it('still extracts the real title when a nested object contains a regex with `title:` in its body', () => {
    const source = [
      `const meta = {`,
      `  title: 'Design System/Nested',`,
      `  argTypes: {`,
      `    label: { validate: /title: .*/ },`,
      `  },`,
      `} satisfies Meta<typeof Thing>;`,
      `export default meta;`,
    ].join('\n');

    expect(extractMetaTitle(source)).toBe('Design System/Nested');
  });
});

/**
 * Config-contract alignment. Before this refinement, the story
 * discovery surface and the Storybook `stories` glob were two
 * independent copies that could silently drift. `.storybook/main.ts`
 * now derives its glob from {@link buildStorybookStoriesGlob}, so
 * these tests assert that wiring stays in place and that the derived
 * glob actually covers the configured extensions and story root.
 */
describe('storybook config ↔ contract helper alignment (FOX-3131 Stage 0 refinement)', () => {
  const STORYBOOK_DIR = path.join(PROJECT_ROOT, '.storybook');

  it('buildStorybookStoriesGlob points at the configured story root', () => {
    const glob = buildStorybookStoriesGlob(STORYBOOK_DIR);
    expect(glob.endsWith('/**/*.stories.@(' + CONFIGURED_STORY_EXTENSIONS
      .map((e) => e.replace('.stories.', ''))
      .join('|') + ')')).toBe(true);

    const storyRootPortion = glob.replace(/\/\*\*\/.+$/, '');
    const resolvedRoot = path.resolve(STORYBOOK_DIR, storyRootPortion);
    expect(resolvedRoot).toBe(path.join(PROJECT_ROOT, STORY_ROOT_RELATIVE));
  });

  it('buildStorybookStoriesGlob covers every configured story extension', () => {
    const glob = buildStorybookStoriesGlob(STORYBOOK_DIR);
    for (const ext of CONFIGURED_STORY_EXTENSIONS) {
      const bare = ext.replace('.stories.', '');
      expect(glob).toContain(bare);
    }
  });

  it('.storybook/main.ts sources its stories glob from the shared contract helper', () => {
    const mainTs = fs.readFileSync(path.join(STORYBOOK_DIR, 'main.ts'), 'utf8');
    // Mechanical assertion that the drift-seam remains closed. If a
    // future edit ever hard-codes the glob again, this test fires.
    expect(mainTs).toMatch(
      /from\s+['"]\.\.\/scripts\/storybookManifestContract['"]/,
    );
    expect(mainTs).toMatch(/buildStorybookStoriesGlob/);
    expect(mainTs).toMatch(/stories:\s*\[\s*buildStorybookStoriesGlob\(__dirname\)\s*\]/);
  });
});
