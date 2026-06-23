#!/usr/bin/env npx tsx
/**
 * CI Validation: Markdown URL guard structural tripwires
 *
 * After R1 Stage 2b (2026-04-27), the structural prevention of the markdown
 * XSS class is the closed-API contract on `SafeMarkdown` / `SafeWebMarkdown`
 * plus the existing `no-restricted-imports` ESLint rule on `react-markdown`.
 * This script owns the markdown-surface ledger and two residual floors:
 *
 * 1. It prevents the "pre-built guarded value consumed cross-file" bypass
 * class — a helper
 * file like `src/utils/myGuardedTransform.ts` doing
 * `export { createGuardedUrlTransform } from '@rebel/shared'` and being
 * imported elsewhere to build a bespoke pipeline outside the wrappers.
 * 2. It verifies the eslint-allowed `react-markdown` wrappers route anchor
 * and image scheme-safety through the shared policy and do not reintroduce a
 * local dangerous-scheme predicate.
 *
 * Re-export allowed location: `packages/shared/**` (where the symbol
 * legitimately lives). Anywhere else is a violation.
 *
 * These gates compose with ESLint rather than replacing it: ESLint keeps new
 * `react-markdown` imports out of non-wrapper files; this script checks the
 * wrappers that are allowed to import it and keeps the cross-file re-export
 * bypass closed.
 *
 * Acknowledged limitation on the re-export gate: it catches *symbol
 * re-exports* only. Derived values like
 * `export const guarded = createGuardedUrlTransform(...)` are NOT caught here.
 * They are mitigated by:
 *   (a) the existing `react-markdown` ESLint allow-list — `ReactMarkdown`
 *       cannot be imported outside the four wrapper files, so a derived
 *       `guarded` value has nowhere safe to be plumbed.
 *   (b) the closed wrapper API — passing a custom `urlTransform` or
 *       `components.a` / `components.img` is type-rejected.
 *
 * Run: npx tsx scripts/check-no-cross-file-guarded-transform-reexports.ts
 * Wired into: npm run validate:fast
 *
 * The standing rules this gate enforces (twin-guard, new-surface/parity) are
 * documented in docs/project/MARKDOWN_URL_GUARD.md — read that before adding a
 * new markdown surface or a deliberate cross-sibling divergence.
 *
 * @see docs/project/MARKDOWN_URL_GUARD.md
 * @see docs/plans/260427_r1_stage2b_factory_refactor.md
 * @see docs-private/postmortems/260423_r1_xss_desktop_exploit_postmortem.md
 * @see docs/plans/260607_markdown-url-guard-unification/PLAN.md
 * @see docs/plans/260613_recs-markdown-url-guard/PLAN.md
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Markdown renderer ledger
// ---------------------------------------------------------------------------
//
// The covered wrapper set mirrors the authoritative eslint allow-list for
// direct `react-markdown` imports. Keep this co-located with the residual
// out-of-scope ledger so future agents update one place when a markdown
// surface lands.
//
// The desktop eslint allow-list also contains `exportUtils.ts` (remark-gfm
// export, not React rendering) and `useGlobalHotkey.ts` (hotkeys guard, not
// markdown). This registry intentionally contains only files that import and
// render `react-markdown`.
// ---------------------------------------------------------------------------

export interface MarkdownWrapperPolicyEntry {
  /** Path relative to repo root. */
  readonly path: string;
  /** Shared-policy symbols expected in this wrapper's scheme-safety path. */
  readonly requiredPolicySymbols: readonly string[];
  /** Extra source-level invariants for this wrapper. */
  readonly requiredSnippets: readonly string[];
}

export const MARKDOWN_WRAPPER_POLICY_FILES: readonly MarkdownWrapperPolicyEntry[] = [
  {
    path: 'src/renderer/components/SafeMarkdown.tsx',
    requiredPolicySymbols: ['createGuardedUrlTransform', 'findBlockedUrlScheme'],
    requiredSnippets: [
      'urlTransform={guardedUrlTransform}',
      'findBlockedUrlScheme(href)',
      'findBlockedUrlScheme(src)',
    ],
  },
  {
    path: 'src/renderer/components/MessageMarkdown.tsx',
    requiredPolicySymbols: ['classifyMarkdownUrl', 'findBlockedUrlScheme'],
    requiredSnippets: [
      'const collapsibleUrlTransform =',
      'const getCollapsedAnchorHref =',
      'const messageMainUrlTransform =',
      'urlTransform={collapsibleUrlTransform}',
      'urlTransform={messageMainUrlTransform}',
      'classifyMarkdownUrl(href',
      'findBlockedUrlScheme(src)',
      '<span style={{ color:',
    ],
  },
  {
    path: 'src/renderer/components/WhatsNewDialog.tsx',
    requiredPolicySymbols: ['createGuardedUrlTransform', 'findBlockedUrlScheme'],
    requiredSnippets: [
      'urlTransform={guardedUrlTransform}',
      'findBlockedUrlScheme(href)',
      'findBlockedUrlScheme(src)',
    ],
  },
  {
    path: 'web-companion/src/components/SafeWebMarkdown.tsx',
    requiredPolicySymbols: ['createGuardedUrlTransform', 'findBlockedUrlScheme'],
    requiredSnippets: [
      'urlTransform={urlTransform}',
      'createGuardedUrlTransform(defaultUrlTransform',
      'findBlockedUrlScheme(href)',
      'findBlockedUrlScheme(src)',
    ],
  },
];

export interface OutOfScopeRendererEntry {
  /** Path relative to repo root. */
  readonly path: string;
  /** One-line description of the markdown rendering pattern. */
  readonly pattern: string;
  /** One-line justification for being out of scope. */
  readonly why_out_of_scope: string;
  /** Specific trigger condition that should re-evaluate coverage. */
  readonly revisit_if: string;
}

export const OUT_OF_SCOPE_MARKDOWN_RENDERERS: readonly OutOfScopeRendererEntry[] = [
  {
    path: 'mobile/app/conversation/[id].tsx',
    pattern: 'react-native-markdown-display',
    why_out_of_scope:
      'Different library entirely — cross-library parity is a separate effort.',
    revisit_if:
      'A cross-platform markdown abstraction is introduced, OR react-native-markdown-display is replaced.',
  },
  {
    path: 'mobile/src/components/FileViewerModal.tsx',
    pattern: 'react-native-markdown-display',
    why_out_of_scope: 'Same as mobile/app/conversation/[id].tsx.',
    revisit_if: 'Same as mobile/app/conversation/[id].tsx.',
  },
  {
    path: 'mobile/src/components/InboxItemDetailModal.tsx',
    pattern: 'react-native-markdown-display',
    why_out_of_scope: 'Same as mobile/app/conversation/[id].tsx.',
    revisit_if: 'Same as mobile/app/conversation/[id].tsx.',
  },
  {
    path: 'src/renderer/components/MediaEmbed.tsx',
    pattern: 'http(s)-only URL renderer (not a markdown component)',
    why_out_of_scope:
      'Separate trust boundary — http(s) URLs only; no markdown URL execution path.',
    revisit_if:
      'MediaEmbed is broadened to handle non-http(s) schemes.',
  },
];

// ---------------------------------------------------------------------------
// Exported helpers (unit-testable)
// ---------------------------------------------------------------------------

export interface Violation {
  file: string;
  line: number;
  text: string;
  rule: string;
}

const SYMBOL = 'createGuardedUrlTransform';

const LOCAL_SCHEME_PREDICATE_NAMES = [
  'isBlockedSchemeLink',
  'isDangerousScheme',
  'hasDangerousScheme',
  'isUnsafeScheme',
  'hasUnsafeScheme',
] as const;

function lineForIndex(source: string, index: number): number {
  return source.slice(0, Math.max(0, index)).split('\n').length;
}

function lineTextForIndex(source: string, index: number): string {
  const lineStart = source.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const lineEnd = source.indexOf('\n', index);
  return source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).trim();
}

function stripCommentsPreserveLines(source: string): string {
  let result = '';
  let i = 0;
  let inBlockComment = false;
  let inLineComment = false;
  let inString: '"' | "'" | '`' | null = null;
  let escaped = false;

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        result += '\n';
      } else {
        result += ' ';
      }
      i += 1;
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        result += '  ';
        inBlockComment = false;
        i += 2;
        continue;
      }
      result += char === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === inString) {
        inString = null;
      }
      i += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      result += '  ';
      inLineComment = true;
      i += 2;
      continue;
    }

    if (char === '/' && next === '*') {
      result += '  ';
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      inString = char;
    }

    result += char;
    i += 1;
  }

  return result;
}

function hasReactMarkdownRender(sourceWithoutComments: string): boolean {
  return (
    /\bfrom\s+['"]react-markdown['"]/.test(sourceWithoutComments) &&
    /<ReactMarkdown\b/.test(sourceWithoutComments)
  );
}

function collectRegexViolations(
  source: string,
  filePath: string,
  regex: RegExp,
  rule: string,
): Violation[] {
  const violations: Violation[] = [];
  for (const match of source.matchAll(regex)) {
    const index = match.index ?? 0;
    violations.push({
      file: filePath,
      line: lineForIndex(source, index),
      text: lineTextForIndex(source, index),
      rule,
    });
  }
  return violations;
}

/**
 * Pure detection function: scans TypeScript source for re-exports of
 * `createGuardedUrlTransform`. Strips comments first (mirrors
 * `check-core-imports.ts` precedent) so commented-out re-exports are not
 * flagged.
 *
 * Patterns caught (Prettier defaults to `semi: true`, so trailing semicolons
 * are common — both forms supported):
 *
 *   1. Re-export from another module (with or without `;`):
 *        export { createGuardedUrlTransform } from '@rebel/shared';
 *        export { createGuardedUrlTransform as guard } from '@rebel/shared';
 *
 *   2. Re-export from local scope (with or without `;`):
 *        export { createGuardedUrlTransform };
 *        export { localGuard as createGuardedUrlTransform };
 *
 * Word-boundary anchors (`\b...\b`) handle alias forms regardless of
 * position inside the braces.
 */
export function findGuardedTransformReexports(
  source: string,
  filePath: string,
): Violation[] {
  const violations: Violation[] = [];
  const lines = source.split('\n');
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const originalLine = lines[i];
    let line = originalLine;
    const lineNum = i + 1;

    // ---- Strip comments so we don't flag commented-out code ----

    if (inBlockComment) {
      const endIdx = line.indexOf('*/');
      if (endIdx !== -1) {
        inBlockComment = false;
        line = line.slice(endIdx + 2);
      } else {
        continue;
      }
    }

    while (line.includes('/*')) {
      const startIdx = line.indexOf('/*');
      const endIdx = line.indexOf('*/', startIdx + 2);
      if (endIdx !== -1) {
        line = line.slice(0, startIdx) + line.slice(endIdx + 2);
      } else {
        line = line.slice(0, startIdx);
        inBlockComment = true;
        break;
      }
    }

    const commentIdx = line.indexOf('//');
    if (commentIdx !== -1) {
      line = line.slice(0, commentIdx);
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    // ---- Patterns ----
    // Use a single regex covering both "from '...'" and local-scope forms,
    // with optional trailing semicolon. Word-boundaries handle alias forms.

    // Re-export from another module: export { ... } from '...';
    const reexportFromRegex = new RegExp(
      `export\\s*\\{[^}]*\\b${SYMBOL}\\b[^}]*\\}\\s*from\\s*['"][^'"]*['"]\\s*;?\\s*$`,
    );

    // Re-export from local scope: export { ... };
    const reexportLocalRegex = new RegExp(
      `export\\s*\\{[^}]*\\b${SYMBOL}\\b[^}]*\\}\\s*;?\\s*$`,
    );

    if (reexportFromRegex.test(trimmed)) {
      violations.push({
        file: filePath,
        line: lineNum,
        text: originalLine.trim(),
        rule: 'no-cross-file-guarded-transform-reexport',
      });
      continue;
    }

    if (reexportLocalRegex.test(trimmed)) {
      violations.push({
        file: filePath,
        line: lineNum,
        text: originalLine.trim(),
        rule: 'no-cross-file-guarded-transform-reexport',
      });
    }
  }

  return violations;
}

export interface MarkdownWrapperSource {
  readonly path: string;
  readonly source: string;
}

export interface MarkdownWrapperPolicyOptions {
  readonly requireCompleteWrapperSet?: boolean;
}

export function findLocalMarkdownSchemePredicates(
  source: string,
  filePath: string,
): Violation[] {
  const withoutComments = stripCommentsPreserveLines(source);
  const violations: Violation[] = [];

  for (const name of LOCAL_SCHEME_PREDICATE_NAMES) {
    const nameRegex = new RegExp(
      `\\b(?:function\\s+${name}|(?:const|let|var)\\s+${name}\\b|${name}\\s*=)`,
      'g',
    );
    violations.push(
      ...collectRegexViolations(
        withoutComments,
        filePath,
        nameRegex,
        'no-local-markdown-scheme-predicate',
      ),
    );
  }

  // Catch hand-rolled dangerous-scheme predicates without flagging comments or
  // ordinary routing checks like `href.startsWith('rebel://space/')`.
  const dangerousSchemePredicateRegex =
    /(?:javascript|blob|file)\s*:\\?[^;\n]*(?:\.test\s*\(|\.match\s*\(|\.startsWith\s*\(|\.includes\s*\(|\.search\s*\()/gi;
  violations.push(
    ...collectRegexViolations(
      withoutComments,
      filePath,
      dangerousSchemePredicateRegex,
      'no-local-markdown-scheme-predicate',
    ),
  );

  const predicateBeforeDangerousSchemeRegex =
    /(?:\.test\s*\(|\.match\s*\(|\.startsWith\s*\(|\.includes\s*\(|\.search\s*\()[^;\n]*(?:javascript|blob|file)\s*:/gi;
  violations.push(
    ...collectRegexViolations(
      withoutComments,
      filePath,
      predicateBeforeDangerousSchemeRegex,
      'no-local-markdown-scheme-predicate',
    ),
  );

  return violations;
}

function findMissingSharedPolicyImportViolation(
  sourceWithoutComments: string,
  filePath: string,
  entry: MarkdownWrapperPolicyEntry,
): Violation | null {
  const missing = entry.requiredPolicySymbols.filter(
    (symbol) => !new RegExp(`\\b${symbol}\\b`).test(sourceWithoutComments),
  );
  if (missing.length === 0) return null;

  return {
    file: filePath,
    line: 1,
    text: `Missing shared markdown URL policy symbol(s): ${missing.join(', ')}`,
    rule: 'markdown-wrapper-must-use-shared-url-policy',
  };
}

function findMissingRequiredSnippetViolations(
  sourceWithoutComments: string,
  filePath: string,
  entry: MarkdownWrapperPolicyEntry,
): Violation[] {
  return entry.requiredSnippets
    .filter((snippet) => !sourceWithoutComments.includes(snippet))
    .map((snippet) => ({
      file: filePath,
      line: 1,
      text: `Missing required markdown wrapper guard shape: ${snippet}`,
      rule: 'markdown-wrapper-must-use-shared-url-policy',
    }));
}

/**
 * Marker that sanctions a deliberate cross-sibling guard divergence: a
 * `<ReactMarkdown>` block in a wrapper that does NOT install a `urlTransform`
 * and is NOT inherently inert (children-only anchor) must carry this comment
 * on one of the comment lines immediately preceding the block, or it fails the
 * gate.
 *
 * This is the explicit escape hatch the markdown-url-rendering-guard-parity
 * recommendation (260422 P-high ci_check) asked for: divergences from sibling
 * renderers in the same module are allowed only when documented inline, so a
 * silent drop of the scheme guard can't slip through review.
 *
 * @see docs/project/MARKDOWN_URL_GUARD.md
 */
// Anchored at line start (after indentation) so it only matches a real `//`
// line comment, never the substring inside a string/template literal.
const PARITY_EXEMPT_LINE_REGEX = /^\s*\/\/\s*PARITY-EXEMPT:\s*\S/;

/** True iff a block is inherently inert — children-only anchor, no href, no img. */
function isInherentlyInertReactMarkdownBlock(block: string): boolean {
  return (
    /a:\s*\(\{\s*children\s*\}\)\s*=>\s*\(\s*<span\b/.test(block) &&
    !/\bhref=/.test(block) &&
    !/\bimg\s*:/.test(block)
  );
}

/**
 * Detects whether a `// PARITY-EXEMPT: <reason>` line-comment sits directly
 * above the block. We walk UPWARD from the block's line over the contiguous run
 * of blank-or-comment lines only: a comment marker counts, a blank line is
 * skipped, and any line of actual code (including another `<ReactMarkdown`)
 * stops the walk. This scopes one marker to exactly the block it precedes —
 * a marker above an earlier sibling cannot leak to a later unguarded block —
 * and, by matching only line-leading `//`, never trips on the literal string
 * inside a template/string.
 *
 * The block index is computed against the comment-stripped source, but
 * `stripCommentsPreserveLines` preserves byte offsets and newlines, so the
 * line number maps 1:1 into the original (comment-bearing) source lines.
 */
function hasPrecedingParityExempt(originalSource: string, blockIndex: number): boolean {
  const lines = originalSource.split('\n');
  const blockLineNum = lineForIndex(originalSource, blockIndex); // 1-based
  // Start one line above the block's opening line and walk up.
  for (let i = blockLineNum - 2; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) break;
    const trimmed = line.trim();
    if (trimmed === '') continue; // blank line — keep looking
    if (PARITY_EXEMPT_LINE_REGEX.test(line)) return true;
    if (trimmed.startsWith('//')) continue; // other comment line — keep looking
    // Any non-comment, non-blank line (real code, or another tag) ends the run.
    break;
  }
  return false;
}

function findMissingPolicyOnReactMarkdownBlocks(
  sourceWithoutComments: string,
  filePath: string,
  originalSource: string,
): Violation[] {
  const violations: Violation[] = [];
  const blockRegex = /<ReactMarkdown\b[\s\S]*?<\/ReactMarkdown>/g;

  for (const match of sourceWithoutComments.matchAll(blockRegex)) {
    const block = match[0];
    const index = match.index ?? 0;
    const hasUrlTransform = /\burlTransform=/.test(block);
    const hasInertAnchor = isInherentlyInertReactMarkdownBlock(block);

    if (hasUrlTransform || hasInertAnchor) {
      continue;
    }

    // Not guarded and not inherently inert. This is a cross-sibling divergence
    // from the guarded blocks in the same module — allowed only when sanctioned
    // by an explicit inline `// PARITY-EXEMPT:` comment so the divergence is
    // documented and reviewable rather than a silent scheme-guard drop.
    if (hasPrecedingParityExempt(originalSource, index)) {
      continue;
    }

    violations.push({
      file: filePath,
      line: lineForIndex(sourceWithoutComments, index),
      text: lineTextForIndex(sourceWithoutComments, index),
      rule: 'markdown-wrapper-react-markdown-must-be-guarded-or-inert',
    });
  }

  return violations;
}

export function findMarkdownWrapperPolicyViolations(
  source: string,
  filePath: string,
): Violation[] {
  const entry = MARKDOWN_WRAPPER_POLICY_FILES.find((candidate) => candidate.path === filePath);
  const withoutComments = stripCommentsPreserveLines(source);
  const violations = findLocalMarkdownSchemePredicates(source, filePath);

  if (!entry) {
    return violations;
  }

  if (!hasReactMarkdownRender(withoutComments)) {
    violations.push({
      file: filePath,
      line: 1,
      text: 'Expected eslint-allowed markdown wrapper to import and render ReactMarkdown',
      rule: 'markdown-wrapper-must-render-react-markdown',
    });
    return violations;
  }

  const missingImportViolation = findMissingSharedPolicyImportViolation(
    withoutComments,
    filePath,
    entry,
  );
  if (missingImportViolation) {
    violations.push(missingImportViolation);
  }

  violations.push(
    ...findMissingRequiredSnippetViolations(withoutComments, filePath, entry),
    ...findMissingPolicyOnReactMarkdownBlocks(withoutComments, filePath, source),
  );

  return violations;
}

export function checkMarkdownWrapperPolicyInSources(
  sources: readonly MarkdownWrapperSource[],
  options: MarkdownWrapperPolicyOptions = {},
): Violation[] {
  const requireCompleteWrapperSet = options.requireCompleteWrapperSet ?? true;
  const byPath = new Map(sources.map((source) => [source.path, source.source]));
  const violations: Violation[] = [];

  if (requireCompleteWrapperSet) {
    for (const entry of MARKDOWN_WRAPPER_POLICY_FILES) {
      if (!byPath.has(entry.path)) {
        violations.push({
          file: entry.path,
          line: 1,
          text: 'Expected eslint-allowed markdown wrapper source to be present in the policy check',
          rule: 'markdown-wrapper-ledger-missing-source',
        });
      }
    }
  }

  for (const source of sources) {
    violations.push(...findMarkdownWrapperPolicyViolations(source.source, source.path));
  }

  return violations.flat();
}

export function collectMarkdownWrapperSources(repoRoot: string): MarkdownWrapperSource[] {
  return MARKDOWN_WRAPPER_POLICY_FILES.map((entry) => {
    const absPath = path.join(repoRoot, entry.path);
    return {
      path: entry.path,
      source: fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '',
    };
  });
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

/**
 * Roots to scan for re-exports. Excludes `packages/shared/**` (the only
 * legitimate location for re-exporting `createGuardedUrlTransform`).
 */
const SCAN_ROOTS: readonly string[] = [
  'src',
  'web-companion/src',
  'cloud-client/src',
  'cloud-service/src',
  'mobile',
];

/**
 * Excluded path fragments (relative to repo root). Tests, build outputs, and
 * node_modules are excluded.
 */
const EXCLUDE_FRAGMENTS: readonly string[] = [
  '/node_modules/',
  '/__tests__/',
  '/dist/',
  '/build/',
  '/out/',
  '/.electron-vite/',
];

function shouldExclude(absPath: string): boolean {
  // Normalise to forward slashes for cross-platform fragment matching.
  const norm = absPath.replace(/\\/g, '/');
  for (const frag of EXCLUDE_FRAGMENTS) {
    if (norm.includes(frag)) return true;
  }
  // Skip test files.
  if (/\.(test|spec)\.[tj]sx?$/.test(norm)) return true;
  return false;
}

function collectScanFiles(repoRoot: string): string[] {
  const results: string[] = [];

  function walk(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return; // path may not exist for all surfaces (mobile is gitignored on some clones)
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (shouldExclude(fullPath)) continue;
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (
        entry.name.endsWith('.ts') ||
        entry.name.endsWith('.tsx') ||
        entry.name.endsWith('.js') ||
        entry.name.endsWith('.jsx')
      ) {
        results.push(fullPath);
      }
    }
  }

  for (const root of SCAN_ROOTS) {
    walk(path.join(repoRoot, root));
  }

  return results;
}

// ---------------------------------------------------------------------------
// CLI runner — skipped when imported for testing (Vitest sets VITEST env var)
// ---------------------------------------------------------------------------

if (!process.env.VITEST) {
  const REPO_ROOT = path.resolve(__dirname, '..');

  console.log(
    `Checking markdown URL guard tripwires and \`${SYMBOL}\` re-exports...\n`,
  );
  console.log(`Scan roots: ${SCAN_ROOTS.join(', ')}\n`);

  const files = collectScanFiles(REPO_ROOT);
  const allViolations: Violation[] = [];

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const relativePath = path.relative(REPO_ROOT, file);
    const violations = findGuardedTransformReexports(source, relativePath);
    allViolations.push(...violations);
  }

  allViolations.push(
    ...checkMarkdownWrapperPolicyInSources(collectMarkdownWrapperSources(REPO_ROOT)),
  );

  if (allViolations.length > 0) {
    console.error(`✗ Found ${allViolations.length} markdown URL guard violation(s):\n`);
    for (const v of allViolations) {
      console.error(`  ${v.file}:${v.line} [${v.rule}]`);
      console.error(`    ${v.text}\n`);
    }
    console.error(
      `\`${SYMBOL}\` may only be re-exported from \`packages/shared/**\`, and eslint-allowed\n` +
        '`react-markdown` wrappers must route scheme-safety through the shared markdown URL\n' +
        'policy (`classifyMarkdownUrl` / `findBlockedUrlScheme` / `createGuardedUrlTransform`).\n' +
        'Do not reintroduce local `javascript:` / `blob:` / `file:` scheme predicates in wrappers.\n' +
        'Every `<ReactMarkdown>` block must be guarded (urlTransform) or inherently inert; a\n' +
        'deliberate divergence from sibling renderers needs an inline `// PARITY-EXEMPT: <reason>` comment.\n\n' +
        'See: docs/project/MARKDOWN_URL_GUARD.md',
    );
    process.exit(1);
  } else {
    console.log(
      `✓ ${files.length} files scanned — no \`${SYMBOL}\` re-exports outside packages/shared/`,
    );
    console.log(
      `✓ ${MARKDOWN_WRAPPER_POLICY_FILES.length} react-markdown wrappers route scheme-safety through the shared policy`,
    );
  }
}
