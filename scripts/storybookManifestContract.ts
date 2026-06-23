/**
 * Mechanical anti-drift guard for the Storybook source-of-truth layer.
 *
 * This helper is shared between `scripts/export-storybook-manifest.ts`
 * (so `prestorybook` / `prebuild-storybook` fail fast on drift) and the
 * Vitest parity test in `scripts/__tests__/storybook-manifest-sync.test.ts`.
 *
 * Contract enforced here (Stage 0 of FOX-3131):
 *   1. Every curated `storybookManifest.storyTitle` must resolve to an
 *      actual `meta.title` in a story file under
 *      `src/renderer/components/ui/**`, unless the family is in the
 *      temporary `ALLOWED_MANIFEST_STORY_TITLES_WITHOUT_STORY` allowlist.
 *   2. Every story `meta.title` under that directory tree must have a
 *      matching manifest entry, unless it is in the
 *      `ALLOWED_NON_MANIFEST_STORY_TITLES` allowlist.
 *   3. Every `sourceFiles` and `appUsageFiles` path in the manifest
 *      must exist on disk.
 *   4. Manifest `id`s are unique, manifest `storyTitle`s are unique,
 *      and story `meta.title` values are unique across the discovered
 *      story surface. Duplicates surface as contract issues rather
 *      than being silently deduplicated.
 *
 * Discovery mirrors the Storybook config in `.storybook/main.ts`,
 * which recursively globs
 * `../src/renderer/components/ui/** /*.stories.@(ts|tsx|mdx)`.
 * The walker descends into subdirectories and recognizes `.stories.ts`
 * and `.stories.tsx`. It deliberately refuses `.stories.mdx`: the
 * regex-based `meta.title` extraction here only understands the
 * `const meta = { ... }` shape used by TS/TSX stories, so an MDX
 * story would be a silent false-negative. Adding MDX support is a
 * Stage 1+ concern; until then we fail loudly with a pointer to this
 * file.
 *
 * The guard deliberately uses a cheap regex extraction rather than
 * Storybook runtime introspection or full TypeScript AST parsing,
 * matching the Stage 0 constraint: stay small and local.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { StorybookFamilyEntry } from '../src/renderer/components/ui/storybookManifest';

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const STORY_ROOT_RELATIVE = 'src/renderer/components/ui';
export const STORY_DIR = path.join(PROJECT_ROOT, STORY_ROOT_RELATIVE);

/**
 * Story file extensions the contract helper can reason about today.
 *
 * Kept intentionally narrow: these are the extensions whose
 * `meta.title` can be extracted by the scoped regex below. If
 * `.storybook/main.ts` ever broadens to a shape this helper cannot
 * introspect (for example `.mdx`), discovery will throw rather than
 * silently skip the file. See {@link CONFIGURED_STORY_EXTENSIONS}
 * for the full configured surface.
 */
export const REGEX_READABLE_STORY_EXTENSIONS: readonly string[] = [
  '.stories.ts',
  '.stories.tsx',
];

/**
 * The full set of story extensions `.storybook/main.ts` globs today.
 *
 * This constant is the single source of truth for the Storybook
 * discovery surface. `.storybook/main.ts` derives its `stories` glob
 * from this list via {@link buildStorybookStoriesGlob}, and the
 * contract guard discovery walker uses the same list. That removes
 * the previous silent-drift seam where the two could disagree about
 * which extensions count as stories.
 *
 * Used by the loud-failure path so the error message is specific
 * about what the helper saw vs what it can extract from.
 */
export const CONFIGURED_STORY_EXTENSIONS: readonly string[] = [
  '.stories.ts',
  '.stories.tsx',
  '.stories.mdx',
];

/**
 * Build the Storybook `stories` glob pattern relative to an arbitrary
 * directory (for example, `.storybook/` when called from
 * `.storybook/main.ts`). The returned pattern is the single
 * representation of the Storybook discovery surface and is derived
 * from {@link STORY_ROOT_RELATIVE} and
 * {@link CONFIGURED_STORY_EXTENSIONS}.
 *
 * Keeping this derivation here means the contract guard's discovery
 * (see {@link discoverStoryFiles}) and the Storybook config share one
 * set of knobs instead of two independent copies that drift.
 */
export function buildStorybookStoriesGlob(fromDir: string): string {
  const storyPrefix = '.stories.';
  const extGroup = CONFIGURED_STORY_EXTENSIONS.map((ext) => {
    if (!ext.startsWith(storyPrefix)) {
      throw new Error(
        `CONFIGURED_STORY_EXTENSIONS entry '${ext}' does not start with ` +
          `'${storyPrefix}'; buildStorybookStoriesGlob assumes the ` +
          '.stories.<ext> shape.',
      );
    }
    return ext.slice(storyPrefix.length);
  }).join('|');

  const absStoryDir = path.join(PROJECT_ROOT, STORY_ROOT_RELATIVE);
  const rel = path.relative(fromDir, absStoryDir).split(path.sep).join('/');
  return `${rel}/**/*.stories.@(${extGroup})`;
}

/**
 * Storybook story `meta.title` values that may exist without a
 * corresponding curated manifest entry.
 *
 * The intended steady-state contract is a single exception: the
 * design-system landing surface. Each additional entry below is a
 * pragmatic Stage-0 bootstrap exception with a clear retirement stage.
 */
export const ALLOWED_NON_MANIFEST_STORY_TITLES: readonly string[] = [
  // Intentional design-system landing page. This is the single
  // long-lived non-manifest exception by design. FOX-3131 Stage 1
  // retitled the former 'Rebel UI/Overview' to 'Design System/Start
  // Here' in-place; the allowlist shape is unchanged.
  'Design System/Start Here',
  // Internal feature-level preview for the extracted inbox workflow
  // card frame. This is intentionally not part of the design-system
  // registry: it previews a reusable inbox pattern, not a shared UI
  // primitive or manifest-backed design-system family.
  'Inbox/Inbox Card Frame',
  // Transcript-local MessageMarkdown image-error preview. It is
  // co-located under components/ui only because the Storybook discovery
  // glob is centralized there; retire this exception when feature-local
  // story discovery is supported.
  'Components/MessageMarkdown/ImageError',
];

/**
 * Manifest `storyTitle` values whose backing story file has not been
 * created yet. Keep this list tight; every entry is future work.
 *
 * FOX-3131 Stage 3 landed `Toggles.stories.tsx` at
 * `meta.title = 'Design System/Missing/Toggles'`, so the `toggles`
 * family is now manifest-backed end-to-end and this list is empty by
 * design. New entries should be rare and must name the stage that will
 * retire them.
 */
export const ALLOWED_MANIFEST_STORY_TITLES_WITHOUT_STORY: readonly string[] = [];

export interface StoryTitleRecord {
  /** Absolute path to the story file. */
  file: string;
  /** The `meta.title` string declared in that file. */
  title: string;
}

export type ContractIssueKind =
  | 'missing-story'
  | 'orphan-story'
  | 'missing-source-file'
  | 'missing-app-usage-file'
  | 'duplicate-manifest-id'
  | 'duplicate-manifest-story-title'
  | 'duplicate-story-title';

export interface ContractIssue {
  kind: ContractIssueKind;
  message: string;
}

/**
 * Extract the `title` string literal declared at the top level of the
 * `const meta = { ... }` object in a story source file. Returns `null`
 * when no such declaration exists.
 *
 * Why a scoped brace-depth scanner rather than a flat regex: a flat
 * regex that matches the first `title:` after `const meta` will
 * false-match on unrelated `title:` fields elsewhere in the file
 * (for example, a `type Args = { title: string }` declaration or a
 * nested `args: { title: '...' }` block) whenever the meta object
 * does not itself declare `title`. The previous implementation had
 * this false-positive; this version walks only the meta object's
 * body and only matches `title:` at its top level.
 *
 * Still intentionally not an AST parse: the guard only needs to find
 * one string literal at one specific location in files written to a
 * tight local convention.
 */
export function extractMetaTitle(source: string): string | null {
  const meta = findMetaObjectBounds(source);
  if (!meta) return null;

  const { openBrace, closeBrace } = meta;
  const end = closeBrace;
  let i = openBrace + 1;
  let depth = 0;

  while (i < end) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i + 2);
      i = nl === -1 ? end : Math.min(nl + 1, end);
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? end : Math.min(close + 2, end);
      continue;
    }
    if (ch === '/' && isRegexStartContext(source, i)) {
      // A regex literal can contain `title:`, `]`, `{`, and other
      // characters this scanner would otherwise treat as meaningful.
      // Skip the whole literal so we do not false-match a `title:`
      // inside a regex body and do not corrupt bracket-depth tracking
      // with regex metacharacters. See the accompanying tests in
      // `scripts/__tests__/storybook-manifest-sync.test.ts` for the
      // exact false-positive and false-negative classes this closes.
      i = Math.min(skipRegexLiteral(source, i), end);
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i = Math.min(skipStringLiteral(source, i), end);
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      i++;
      continue;
    }

    if (depth === 0 && source.startsWith('title', i)) {
      const beforeCh = i === 0 ? '' : source[i - 1];
      const afterCh = source[i + 5] ?? '';
      const isStandaloneKey =
        !/[A-Za-z0-9_$]/.test(beforeCh) && !/[A-Za-z0-9_$]/.test(afterCh);
      if (isStandaloneKey) {
        let j = i + 5;
        while (j < end && /\s/.test(source[j] ?? '')) j++;
        if (source[j] === ':') {
          j++;
          while (j < end && /\s/.test(source[j] ?? '')) j++;
          const quote = source[j];
          if (quote === "'" || quote === '"') {
            return readStringLiteralBody(source, j, quote, end);
          }
          // Non-string title (template literal with interpolation, an
          // identifier, a function call, …). We cannot resolve it
          // statically; surface as "no title" rather than guessing.
          return null;
        }
      }
    }

    i++;
  }

  return null;
}

interface MetaObjectBounds {
  /** Index of the opening `{` of the meta object. */
  openBrace: number;
  /** Index of the matching closing `}`. */
  closeBrace: number;
}

/**
 * Locate the `const meta = { ... }` declaration's outer braces.
 *
 * The regex intentionally matches at start-of-line so that prose like
 * `// const meta = { ... }` inside a JSDoc cannot masquerade as the
 * real declaration.
 */
function findMetaObjectBounds(source: string): MetaObjectBounds | null {
  const decl = /^[\t ]*(?:export\s+)?const\s+meta\b[^=]*?=\s*\{/m.exec(source);
  if (!decl) return null;
  const openBrace = decl.index + decl[0].length - 1;
  const len = source.length;
  let i = openBrace + 1;
  let depth = 1;
  while (i < len && depth > 0) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i + 2);
      i = nl === -1 ? len : nl + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? len : close + 2;
      continue;
    }
    if (ch === '/' && isRegexStartContext(source, i)) {
      // Same reasoning as the main extractor loop: a regex literal can
      // contain `]`, `{`, `(`, and similar characters that would
      // corrupt the brace-depth tracking used to find the meta
      // object's closing brace. Skipping the whole literal keeps the
      // scanner honest regardless of regex body contents.
      i = skipRegexLiteral(source, i);
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipStringLiteral(source, i);
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
    } else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0) return { openBrace, closeBrace: i };
    }
    i++;
  }
  return null;
}

/**
 * Decide whether the `/` at `slashIndex` plausibly starts a regex
 * literal (as opposed to a division operator). We do not have a full
 * JS parser here, so the check looks back past whitespace/comments to
 * the previous significant character. If that character is something
 * that can end an expression/value (an identifier char, digit, `)`,
 * or `]`), we treat `/` as division. Otherwise we treat it as the
 * start of a regex. This matches the heuristic used by most small
 * JS tokenizers and is safe for the tightly-scoped story-file shapes
 * the contract guard is meant to introspect (property values, array
 * elements, function arguments).
 */
function isRegexStartContext(source: string, slashIndex: number): boolean {
  let k = slashIndex - 1;
  while (k >= 0) {
    const ch = source[k];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      k--;
      continue;
    }
    if (ch === '/' && k >= 1 && source[k - 1] === '*') {
      const open = source.lastIndexOf('/*', k - 2);
      if (open === -1) break;
      k = open - 1;
      continue;
    }
    break;
  }
  if (k < 0) return true;
  const prev = source[k];
  if (/[A-Za-z0-9_$)\]]/.test(prev)) return false;
  return true;
}

/**
 * Advance past a regex literal starting at `start` (where
 * `source[start] === '/'`). Handles `\`-escapes and `[...]` character
 * classes (which can themselves contain an unescaped `/`). Returns
 * the index just past the closing `/` and any trailing flags.
 *
 * If the regex is unterminated on its line (a stray division after
 * all, despite the heuristic), we fall back to advancing by one so
 * the caller keeps making progress rather than looping forever.
 */
function skipRegexLiteral(source: string, start: number): number {
  const len = source.length;
  let i = start + 1;
  let inClass = false;
  while (i < len) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '\n') {
      return start + 1;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      i++;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      i++;
      continue;
    }
    if (ch === '/') {
      i++;
      while (i < len && /[A-Za-z]/.test(source[i] ?? '')) i++;
      return i;
    }
    i++;
  }
  return len;
}

/**
 * Advance past a string (including template) literal starting at
 * `start` and return the index just past the closing quote.
 */
function skipStringLiteral(source: string, start: number): number {
  const quote = source[start];
  const len = source.length;
  let i = start + 1;
  while (i < len) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        const c = source[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === "'" || c === '"' || c === '`') {
          i = skipStringLiteral(source, i);
          continue;
        }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return len;
}

/**
 * Read the body of a simple string literal starting at the opening
 * quote index `start`. Supports `'` and `"` only. Handles common
 * escape sequences defensively; returns `null` if the literal is not
 * terminated before `end`.
 */
function readStringLiteralBody(
  source: string,
  start: number,
  quote: "'" | '"',
  end: number,
): string | null {
  let i = start + 1;
  let value = '';
  while (i < end) {
    const ch = source[i];
    if (ch === '\\') {
      const next = source[i + 1] ?? '';
      if (next === 'n') value += '\n';
      else if (next === 't') value += '\t';
      else if (next === 'r') value += '\r';
      else value += next;
      i += 2;
      continue;
    }
    if (ch === quote) return value;
    value += ch;
    i++;
  }
  return null;
}

/**
 * Return true if `name` ends with any extension in `suffixes`.
 */
function endsWithAny(name: string, suffixes: readonly string[]): string | null {
  for (const suffix of suffixes) {
    if (name.endsWith(suffix)) return suffix;
  }
  return null;
}

/**
 * Recursively collect absolute paths for every story file under
 * `storyDir`. Mirrors the `.storybook/main.ts` glob surface.
 *
 * If a discovered file matches {@link CONFIGURED_STORY_EXTENSIONS} but
 * not {@link REGEX_READABLE_STORY_EXTENSIONS} (currently only
 * `.stories.mdx`), this function throws. That is the "fail loudly on
 * unsupported extensions" branch called out in the Stage 0 plan: we
 * would rather block than silently miss a story file.
 */
export function discoverStoryFiles(storyDir: string = STORY_DIR): string[] {
  const found: string[] = [];
  const unsupported: string[] = [];

  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (endsWithAny(entry.name, REGEX_READABLE_STORY_EXTENSIONS)) {
        found.push(abs);
        continue;
      }
      if (endsWithAny(entry.name, CONFIGURED_STORY_EXTENSIONS)) {
        unsupported.push(abs);
      }
    }
  };

  walk(storyDir);

  if (unsupported.length > 0) {
    const rendered = unsupported
      .map((file) => `  - ${path.relative(PROJECT_ROOT, file)}`)
      .join('\n');
    throw new Error(
      'Storybook contract guard found story files in an extension it cannot ' +
        'introspect yet:\n' +
        rendered +
        '\n\nThe regex-based `meta.title` extractor in ' +
        'scripts/storybookManifestContract.ts only supports ' +
        `${REGEX_READABLE_STORY_EXTENSIONS.join(', ')}. ` +
        'Either convert the file to a supported extension, or teach the helper ' +
        'about the new shape (and update REGEX_READABLE_STORY_EXTENSIONS).',
    );
  }

  return found.sort();
}

/**
 * Walk the curated story directory recursively and return every
 * `(file, title)` pair. Throws if any story file is missing a
 * resolvable `meta.title`, because that means the contract guard
 * cannot reason about it.
 */
export function collectStoryTitles(storyDir: string = STORY_DIR): StoryTitleRecord[] {
  const files = discoverStoryFiles(storyDir);
  const records: StoryTitleRecord[] = [];
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, 'utf8');
    const title = extractMetaTitle(source);
    if (!title) {
      throw new Error(
        `Storybook contract guard could not extract meta.title from ${path.relative(PROJECT_ROOT, filePath)}. ` +
          `Ensure the file declares \`const meta\` with a \`title: '...'\` field.`,
      );
    }
    records.push({ file: filePath, title });
  }
  return records;
}

export interface ValidateOptions {
  manifest: StorybookFamilyEntry[];
  stories: StoryTitleRecord[];
  projectRoot?: string;
  nonManifestAllowlist?: readonly string[];
  missingStoryAllowlist?: readonly string[];
}

/**
 * Run the bidirectional contract check plus cheap path-existence and
 * uniqueness checks for manifest evidence. Returns a flat list of
 * issues; callers decide how to surface them.
 */
export function validateManifestContract(options: ValidateOptions): ContractIssue[] {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const nonManifestAllowlist = new Set(options.nonManifestAllowlist ?? ALLOWED_NON_MANIFEST_STORY_TITLES);
  const missingStoryAllowlist = new Set(options.missingStoryAllowlist ?? ALLOWED_MANIFEST_STORY_TITLES_WITHOUT_STORY);

  const storyTitleSet = new Set(options.stories.map((s) => s.title));
  const manifestTitleSet = new Set(options.manifest.map((m) => m.storyTitle));

  const issues: ContractIssue[] = [];

  const manifestIdCounts = new Map<string, number>();
  const manifestStoryTitleCounts = new Map<string, number>();
  for (const family of options.manifest) {
    manifestIdCounts.set(family.id, (manifestIdCounts.get(family.id) ?? 0) + 1);
    manifestStoryTitleCounts.set(
      family.storyTitle,
      (manifestStoryTitleCounts.get(family.storyTitle) ?? 0) + 1,
    );
  }
  for (const [id, count] of manifestIdCounts) {
    if (count > 1) {
      issues.push({
        kind: 'duplicate-manifest-id',
        message: `Manifest contains ${count} families with id '${id}'. Ids must be unique.`,
      });
    }
  }
  for (const [storyTitle, count] of manifestStoryTitleCounts) {
    if (count > 1) {
      issues.push({
        kind: 'duplicate-manifest-story-title',
        message:
          `Manifest contains ${count} families pointing at storyTitle ` +
          `'${storyTitle}'. storyTitle values must be unique.`,
      });
    }
  }

  const storyTitleFiles = new Map<string, string[]>();
  for (const story of options.stories) {
    const existing = storyTitleFiles.get(story.title);
    if (existing) {
      existing.push(story.file);
    } else {
      storyTitleFiles.set(story.title, [story.file]);
    }
  }
  for (const [title, files] of storyTitleFiles) {
    if (files.length > 1) {
      const rendered = files.map((f) => path.relative(projectRoot, f)).sort().join(', ');
      issues.push({
        kind: 'duplicate-story-title',
        message:
          `Story meta.title '${title}' is declared in multiple files (${rendered}). ` +
          `meta.title values must be unique across the Storybook tree.`,
      });
    }
  }

  for (const family of options.manifest) {
    if (!storyTitleSet.has(family.storyTitle) && !missingStoryAllowlist.has(family.storyTitle)) {
      issues.push({
        kind: 'missing-story',
        message:
          `Manifest family '${family.id}' declares storyTitle ` +
          `'${family.storyTitle}' but no story file exports that meta.title.`,
      });
    }

    for (const rel of family.sourceFiles) {
      const abs = path.join(projectRoot, rel);
      if (!fs.existsSync(abs)) {
        issues.push({
          kind: 'missing-source-file',
          message: `Manifest family '${family.id}' references non-existent sourceFiles entry '${rel}'.`,
        });
      }
    }

    for (const rel of family.appUsageFiles) {
      const abs = path.join(projectRoot, rel);
      if (!fs.existsSync(abs)) {
        issues.push({
          kind: 'missing-app-usage-file',
          message: `Manifest family '${family.id}' references non-existent appUsageFiles entry '${rel}'.`,
        });
      }
    }
  }

  for (const story of options.stories) {
    if (!manifestTitleSet.has(story.title) && !nonManifestAllowlist.has(story.title)) {
      issues.push({
        kind: 'orphan-story',
        message:
          `Story '${story.title}' (${path.relative(projectRoot, story.file)}) ` +
          `has no manifest entry and is not present in ALLOWED_NON_MANIFEST_STORY_TITLES.`,
      });
    }
  }

  return issues;
}

/**
 * Format a list of issues for human-readable CLI output.
 */
export function formatIssues(issues: ContractIssue[]): string {
  if (issues.length === 0) return '';
  const lines = issues.map((issue) => `  - [${issue.kind}] ${issue.message}`);
  return lines.join('\n');
}
