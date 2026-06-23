#!/usr/bin/env tsx
/**
 * CI Validation: Cross-surface alias integrity.
 *
 * Stage 0 of `docs/plans/260416_centralize_approval_and_diff_viewing_ux.md`
 * introduces `@rebel/cloud-client` as a runtime dependency of the renderer,
 * tests, and mobile. To prevent subtle bundling drift (renderer compiles fine
 * but tests or mobile break because an alias was forgotten in one of six
 * configs), this script enforces that the canonical path-aliases point to
 * the canonical locations in every build config that consumes them.
 *
 * What we check (Stage 0 scope — Round-2 finding F29):
 *   - `@rebel/shared`        → `packages/shared/src`
 *   - `@rebel/cloud-client`  → `cloud-client/src`
 *   - `@shared`              → `src/shared`
 *   - `@core`                → `src/core`
 *
 * Where we check:
 *   - `electron.vite.config.ts`          (renderer/main/preload Vite aliases)
 *   - `tsconfig.renderer.json`           (desktop renderer tsconfig)
 *   - `tsconfig.node.json`               (desktop main/preload tsconfig)
 *   - `vitest.config.ts`                 (root vitest aliases)
 *   - `cloud-service/tsconfig.json`      (cloud-service tsconfig)
 *   - `cloud-service/tsconfig.test.json` (cloud-service test tsconfig)
 *   - `cloud-client/tsconfig.test.json`  (cloud-client test tsconfig)
 *   - `web-companion/tsconfig.test.json` (web-companion test tsconfig)
 *   - `packages/shared/tsconfig.json`    (shared package tsconfig)
 *   - `packages/browser-extension/tsconfig.json` (browser extension tsconfig)
 *   - `mobile/tsconfig.json`             (mobile tsconfig)
 *   - `mobile/jest.config.js`            (mobile jest moduleNameMapper)
 *   - `mobile/metro.config.js`           (mobile Metro extraNodeModules / watchFolders)
 *
 * Exit code:
 *   0 — all aliases referenced in any config point to the canonical location
 *   1 — at least one config references an alias with the wrong path, or a
 *        required-by-Stage-0 alias is missing from the renderer/vitest config
 *
 * We do NOT require every alias to exist in every config, but configs that
 * MUST have the Stage-0 alias do have it. If an alias IS referenced, it must
 * point to the right place.
 *
 * Wired into: `npm run validate:fast` via the `validate:alias-integrity`
 * script defined in package.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Canonical layout (from repo root)
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..');

type AliasKey = '@rebel/shared' | '@rebel/cloud-client' | '@shared' | '@core' | '@main';

/** Canonical target relative to repo root. Normalised to forward-slashes. */
const CANONICAL: Record<AliasKey, string> = {
  '@rebel/shared': 'packages/shared/src',
  '@rebel/cloud-client': 'cloud-client/src',
  '@shared': 'src/shared',
  '@core': 'src/core',
  // @main is checked where present (main bundlers, worker esbuild) but never
  // *required* outside configs that list it — renderer/cloud configs simply
  // don't map it. Every @main mapping in the repo already points at src/main,
  // so adding it to CANONICAL only enables drift-detection; it forces nothing.
  '@main': 'src/main',
};

// ---------------------------------------------------------------------------
// Exported helpers (unit-testable)
// ---------------------------------------------------------------------------

export interface AliasViolation {
  file: string;
  alias: AliasKey;
  expected: string;
  found: string;
  message: string;
}

export interface MissingAlias {
  file: string;
  alias: AliasKey;
  reason: string;
}

interface ParsedTsconfig {
  extends?: string;
  compilerOptions?: { paths?: Record<string, string[]> };
}

interface TsconfigAliasMapping {
  target: string;
  configFile: string;
}

/**
 * Normalise a platform-specific absolute path into a repo-relative
 * forward-slash path we can compare against CANONICAL.
 */
export function normaliseRelative(repoRoot: string, absolutePath: string): string {
  const rel = path.relative(repoRoot, absolutePath);
  return rel.split(path.sep).join('/');
}

/**
 * Normalise a raw target string into a repo-root-relative forward-slash path.
 *
 * The raw target can be written in any of several idioms:
 *   - TS `paths` entry: `./packages/shared/src`          (config-dir-relative)
 *   - TS `paths` nested: `../packages/shared/src`         (config-dir-relative)
 *   - Jest module-name-mapper: `<rootDir>/../packages/...` (`<rootDir>` = config dir)
 *   - Vite/Metro `path.resolve(monorepoRoot, 'packages/...')` (repo-root-relative)
 *   - Vite `resolve(__dirname, 'packages/...')` at repo root (config-dir-relative)
 *
 * Since our regex parser captures only the quoted target string, we can't
 * reliably tell which of the last two was intended. We therefore produce a
 * set of candidate normalisations and return the BEST one (shortest absolute
 * path that still resolves within the repo root). Callers compare against
 * the canonical path, so if any candidate matches we count it as correct.
 */
export function normaliseTarget(
  repoRoot: string,
  configFile: string,
  rawTarget: string,
): string {
  return candidateNormalisations(repoRoot, configFile, rawTarget)[0]!;
}

/**
 * All reasonable ways a captured target string might resolve, in preference
 * order. The FIRST candidate is what `normaliseTarget` reports, but callers
 * that want "does any candidate match the canonical?" semantics should use
 * `normaliseTargetMatchesAny`.
 */
export function candidateNormalisations(
  repoRoot: string,
  configFile: string,
  rawTarget: string,
): string[] {
  const configDir = path.dirname(configFile);
  const candidates: string[] = [];

  // Candidate A: substitute `<rootDir>` (jest) with the config directory.
  if (rawTarget.includes('<rootDir>')) {
    const substituted = rawTarget.replace(/<rootDir>/g, configDir);
    const abs = path.isAbsolute(substituted)
      ? substituted
      : path.resolve(configDir, substituted);
    candidates.push(normaliseRelative(repoRoot, abs));
  }

  // Candidate B: config-dir-relative (TS paths, vite at repo root).
  if (!rawTarget.includes('<rootDir>')) {
    const abs = path.isAbsolute(rawTarget)
      ? rawTarget
      : path.resolve(configDir, rawTarget);
    candidates.push(normaliseRelative(repoRoot, abs));
  }

  // Candidate C: repo-root-relative (metro's `path.resolve(monorepoRoot, '...')`).
  if (
    !path.isAbsolute(rawTarget) &&
    !rawTarget.startsWith('./') &&
    !rawTarget.startsWith('../') &&
    !rawTarget.includes('<rootDir>')
  ) {
    const abs = path.resolve(repoRoot, rawTarget);
    candidates.push(normaliseRelative(repoRoot, abs));
  }

  // Deduplicate, preserving order.
  return Array.from(new Set(candidates));
}

/**
 * Return true if any candidate normalisation of `rawTarget` equals `expected`.
 * Used by `runAliasCheck` so we don't flag false positives when the same
 * alias target is written in multiple valid idioms across configs.
 */
export function normaliseTargetMatchesAny(
  repoRoot: string,
  configFile: string,
  rawTarget: string,
  expected: string,
): boolean {
  return candidateNormalisations(repoRoot, configFile, rawTarget).includes(expected);
}

/**
 * Strip a trailing `/*` or a `*` wildcard segment used in TS `paths` entries.
 */
function stripWildcard(value: string): string {
  return value.replace(/\/\*$/, '').replace(/\*$/, '');
}

/**
 * Extract alias→target mappings from a tsconfig-style JSON file.
 *
 * Accepts both `"@alias": ["./path"]` and `"@alias/*": ["./path/*"]`.
 * Returns ONLY the aliases in CANONICAL we care about.
 */
export function extractTsconfigAliases(
  jsonText: string,
): Partial<Record<AliasKey, string>> {
  // tsconfig files may contain line comments; strip them so JSON.parse works.
  const parsed = parseTsconfig(jsonText);
  const paths = parsed.compilerOptions?.paths ?? {};
  const out: Partial<Record<AliasKey, string>> = {};
  for (const [rawKey, values] of Object.entries(paths)) {
    if (!Array.isArray(values) || values.length === 0) continue;
    const key = stripWildcard(rawKey) as AliasKey;
    if (!(key in CANONICAL)) continue;
    if (out[key] !== undefined) continue; // first-wins, matching TS resolver
    out[key] = stripWildcard(values[0]!);
  }
  return out;
}

function parseTsconfig(jsonText: string): ParsedTsconfig {
  const stripped = jsonText.replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(stripped) as ParsedTsconfig;
}

function resolveTsconfigExtendsPath(configFile: string, rawExtends: string): string | null {
  if (!path.isAbsolute(rawExtends) && !rawExtends.startsWith('.')) {
    return null;
  }

  const resolved = path.resolve(path.dirname(configFile), rawExtends);
  return path.extname(resolved) ? resolved : `${resolved}.json`;
}

function extractTsconfigAliasMappings(
  configFile: string,
  readFile: (p: string) => string,
  seen: Set<string> = new Set(),
): Partial<Record<AliasKey, TsconfigAliasMapping>> {
  if (seen.has(configFile)) {
    throw new Error(`Circular tsconfig extends chain involving ${configFile}`);
  }
  seen.add(configFile);

  const text = readFile(configFile);
  const parsed = parseTsconfig(text);
  const inherited = parsed.extends
    ? (() => {
        const parentFile = resolveTsconfigExtendsPath(configFile, parsed.extends!);
        return parentFile
          ? extractTsconfigAliasMappings(parentFile, readFile, seen)
          : {};
      })()
    : {};

  const localAliases = extractTsconfigAliases(text);
  const localMappings: Partial<Record<AliasKey, TsconfigAliasMapping>> = {};
  for (const [aliasRaw, target] of Object.entries(localAliases)) {
    if (target === undefined) continue;
    localMappings[aliasRaw as AliasKey] = { target, configFile };
  }

  seen.delete(configFile);
  return { ...inherited, ...localMappings };
}

/**
 * Extract alias→target mappings from a JS/TS config file by regex.
 *
 * This is deliberately simple: it matches lines like
 *   '@rebel/shared': resolve(__dirname, 'packages/shared/src')
 *   '@rebel/shared': path.resolve(__dirname, './packages/shared/src')
 *   '@rebel/shared': '<rootDir>/../packages/shared/src'
 *   '@rebel/shared': path.resolve(monorepoRoot, 'packages/shared/src')
 *
 * and pulls the quoted string argument out. Lines that don't match are
 * ignored (they may be unrelated helper code). We do NOT attempt to evaluate
 * arbitrary JS; this is an integrity check, not a full resolver.
 */
/**
 * Extract alias→target mappings from a JS/TS config file by regex.
 *
 * Returns only the first occurrence per alias (matches bundler resolution).
 * Use `extractAllRegexAliases` when you need per-section drift detection.
 *
 * LIMITATION (literal string keys only): Spread operators (`...aliasCommon`)
 * and computed keys (`[aliasKey]: value`) are not parsed. If a future refactor
 * introduces either pattern in a vite config, `sectionedRequirements` checks
 * may false-negative (report "missing" when the alias IS present via spread).
 * The current codebase uses literal keys everywhere; this note is here so a
 * future agent adjusts this parser before adding spread/computed keys to
 * build-config alias maps.
 */
export function extractRegexAliases(
  text: string,
): Partial<Record<AliasKey, string>> {
  const all = extractAllRegexAliases(text);
  const out: Partial<Record<AliasKey, string>> = {};
  for (const [alias, targets] of Object.entries(all)) {
    if (targets.length > 0) {
      out[alias as AliasKey] = targets[0]!;
    }
  }
  return out;
}

/**
 * Extract ALL occurrences of each alias from a JS/TS config file (F-R2-3).
 *
 * In `electron.vite.config.ts`, the main/preload/renderer sections each
 * define aliases — this function collects every occurrence so we can detect
 * per-section drift (e.g., renderer says `packages/shared/src` but preload
 * says `packages/shared/WRONG`).
 */
export function extractAllRegexAliases(
  text: string,
): Partial<Record<AliasKey, string[]>> {
  const out: Partial<Record<AliasKey, string[]>> = {};
  const aliases: AliasKey[] = Object.keys(CANONICAL) as AliasKey[];
  for (const alias of aliases) {
    const escaped = alias.replace(/[/]/g, '\\/');
    const re = new RegExp(
      `['\"]\\^?${escaped}[$/*().]*['\"]\\s*:\\s*[^'\"\\n]*?['\"]([^'\"]+)['\"]`,
      'g',
    );
    const targets: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      targets.push(stripJestCaptureGroup(stripWildcard(m[1]!)));
    }
    if (targets.length > 0) {
      out[alias] = targets;
    }
  }
  return out;
}

/**
 * Strip trailing jest capture-group references (`/$1`) and explicit
 * `/index.ts|.js|.tsx|.mts|.mjs` file suffixes so the normalised target is
 * always the directory the alias resolves into. Bundlers index jest aliases
 * to a specific entry file; we treat those as equivalent to the directory.
 */
function stripJestCaptureGroup(value: string): string {
  return value
    .replace(/\/\$\d+$/, '')
    .replace(/\/index\.(?:ts|tsx|js|jsx|mts|mjs|cts|cjs)$/, '');
}

/**
 * Slice a `defineConfig({ main: {...}, preload: {...}, renderer: {...} })`
 * config text into the string slice for one named top-level section so its
 * alias map can be validated in isolation.
 *
 * Strategy: strip comments/strings so stray `main:`/`renderer:` tokens in
 * those contexts cannot match, then locate `<section>:\s*{` and walk the
 * brace tree (honouring quoted strings + template literals) until the match
 * of the opening brace. Returns null when the section is missing entirely.
 *
 * Used by `runAliasCheck`'s `sectionedRequirements` branch (D20 Stage 5).
 */
export function extractViteSection(text: string, section: ViteConfigSection): string | null {
  const sanitized = stripComments(text);
  // Anchor the section header so a nested `main: true` / `renderer: 'foo'` inside an
  // inner object can't be mistaken for the top-level section. Require the keyword to
  // follow a newline, opening brace, or comma (optionally preceded by whitespace).
  // Comment-stripping already handles // and /* */; strings are preserved but the
  // anchor requirement makes accidental matches inside `'main: {'` string literals
  // dramatically less likely (would need to start at line start or after `{`/`,`).
  const headerRegex = new RegExp(`(?:^|[\\n,{])\\s*${section}\\s*:\\s*\\{`, 'm');
  const headerMatch = headerRegex.exec(sanitized);
  if (headerMatch === null) {
    return null;
  }
  const openBraceIdx = headerMatch.index + headerMatch[0].length - 1;
  let depth = 0;
  let i = openBraceIdx;
  const n = sanitized.length;
  while (i < n) {
    const c = sanitized[i];
    if (c === '{') {
      depth++;
      i++;
      continue;
    }
    if (c === '}') {
      depth--;
      if (depth === 0) {
        return sanitized.slice(openBraceIdx, i + 1);
      }
      i++;
      continue;
    }
    // Skip over quoted strings (they can't contain unquoted braces we care about).
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        const ch = sanitized[i];
        if (ch === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        i++;
        if (ch === quote) break;
      }
      continue;
    }
    i++;
  }
  return null;
}

/**
 * Named top-level sections in `electron.vite.config.ts` (and any similarly
 * structured electron-vite config). Each has its own `resolve.alias` map —
 * drift between them causes silent build failures (e.g. renderer imports
 * `@core/navigation` but renderer-section alias is missing).
 */
export type ViteConfigSection = 'main' | 'preload' | 'renderer';

export interface ConfigCheck {
  /** Absolute path to the config file. */
  file: string;
  /** Format hint — determines which parser we use. */
  kind: 'tsconfig' | 'regex';
  /** Aliases that MUST be present in this config (subset of CANONICAL keys). */
  required?: AliasKey[];
  /**
   * Per-section required aliases (regex configs only). When set, the check
   * slices the file into its named top-level sections (main/preload/renderer)
   * and validates that each section's alias map contains every listed key.
   * Closes the "alias defined in one section, missing from another" gap that
   * the flat `required` list cannot detect (because `firstParsed` finds the
   * alias in ANY section and satisfies the check). See D20 Stage 5 and the
   * §9 Stage 5 / §5 Stage 5 blocks of docs/plans/260425_d20_super_mcp_ci_wiring.md.
   */
  sectionedRequirements?: Partial<Record<ViteConfigSection, AliasKey[]>>;
}

export interface CheckResult {
  violations: AliasViolation[];
  missing: MissingAlias[];
}

/**
 * Run the alias-integrity check across a list of configs. Pure function —
 * testable with in-memory inputs via the `readFile` injection.
 */
export function runAliasCheck(
  repoRoot: string,
  configs: ConfigCheck[],
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): CheckResult {
  const violations: AliasViolation[] = [];
  const missing: MissingAlias[] = [];

  for (const cfg of configs) {
    let text: string;
    try {
      text = readFile(cfg.file);
    } catch (err) {
      violations.push({
        file: cfg.file,
        alias: '@rebel/shared', // placeholder — we can't know the alias, just report the file
        expected: '(file readable)',
        found: `(error reading: ${(err as Error).message})`,
        message: `Failed to read ${cfg.file}`,
      });
      continue;
    }

    if (cfg.kind === 'tsconfig') {
      const parsed = extractTsconfigAliasMappings(cfg.file, readFile);

      for (const [aliasRaw, mapping] of Object.entries(parsed)) {
        if (mapping === undefined) continue;
        const alias = aliasRaw as AliasKey;
        const expected = CANONICAL[alias];
        if (!normaliseTargetMatchesAny(repoRoot, mapping.configFile, mapping.target, expected)) {
          const candidates = candidateNormalisations(repoRoot, mapping.configFile, mapping.target);
          violations.push({
            file: mapping.configFile,
            alias,
            expected,
            found: candidates[0] ?? mapping.target,
            message:
              `Alias ${alias} in ${path.relative(repoRoot, mapping.configFile)} points to ` +
              `${candidates.join(' or ')} but should point to ${expected}.`,
          });
        }
      }

      for (const alias of cfg.required ?? []) {
        if (parsed[alias] === undefined) {
          const reason =
            `Required alias ${alias} is missing from ` +
            `${path.relative(repoRoot, cfg.file)} and its tsconfig extends chain. ` +
            `Add it to keep cross-surface imports resolvable (Stage 0 / F29).`;
          missing.push({ file: cfg.file, alias, reason });
        }
      }
    } else {
      // ---------------------------------------------------------------
      // F-R2-3: Regex configs — check ALL occurrences for per-section
      // drift (e.g., electron.vite.config.ts main vs renderer sections).
      // ---------------------------------------------------------------
      const allParsed = extractAllRegexAliases(text);
      const firstParsed = extractRegexAliases(text);

      // Validate first occurrence (same as before).
      for (const [aliasRaw, rawTarget] of Object.entries(firstParsed)) {
        if (rawTarget === undefined) continue;
        const alias = aliasRaw as AliasKey;
        const expected = CANONICAL[alias];
        if (!normaliseTargetMatchesAny(repoRoot, cfg.file, rawTarget, expected)) {
          const candidates = candidateNormalisations(repoRoot, cfg.file, rawTarget);
          violations.push({
            file: cfg.file,
            alias,
            expected,
            found: candidates[0] ?? rawTarget,
            message:
              `Alias ${alias} in ${path.relative(repoRoot, cfg.file)} points to ` +
              `${candidates.join(' or ')} but should point to ${expected}.`,
          });
        }
      }

      // Per-section drift: if an alias appears >1 time, ALL occurrences
      // must match the canonical target.
      for (const [aliasRaw, targets] of Object.entries(allParsed)) {
        if (!targets || targets.length <= 1) continue;
        const alias = aliasRaw as AliasKey;
        const expected = CANONICAL[alias];
        for (let i = 1; i < targets.length; i++) {
          const rawTarget = targets[i]!;
          if (!normaliseTargetMatchesAny(repoRoot, cfg.file, rawTarget, expected)) {
            const candidates = candidateNormalisations(repoRoot, cfg.file, rawTarget);
            violations.push({
              file: cfg.file,
              alias,
              expected,
              found: candidates[0] ?? rawTarget,
              message:
                `Alias ${alias} occurrence #${i + 1} in ${path.relative(repoRoot, cfg.file)} ` +
                `points to ${candidates.join(' or ')} but should point to ${expected} ` +
                `(per-section drift detected, F-R2-3).`,
            });
          }
        }
      }

      for (const alias of cfg.required ?? []) {
        if (firstParsed[alias] === undefined) {
          missing.push({
            file: cfg.file,
            alias,
            reason:
              `Required alias ${alias} is missing from ` +
              `${path.relative(repoRoot, cfg.file)}. Add it to keep cross-surface ` +
              `imports resolvable (Stage 0 / F29).`,
          });
        }
      }

      // ---------------------------------------------------------------
      // D20 Stage 5: Section-aware required-alias check.
      // Catches the case where an alias is defined in ONE electron-vite
      // section (main) but missing from another (renderer) — a gap the
      // flat `required` list above cannot detect because `firstParsed`
      // finds the alias in ANY section and marks it satisfied.
      // ---------------------------------------------------------------
      const sectioned = cfg.sectionedRequirements;
      if (sectioned) {
        for (const section of Object.keys(sectioned) as ViteConfigSection[]) {
          const requiredInSection = sectioned[section] ?? [];
          if (requiredInSection.length === 0) continue;
          const sectionText = extractViteSection(text, section);
          if (sectionText === null) {
            missing.push({
              file: cfg.file,
              alias: requiredInSection[0]!,
              reason:
                `Section "${section}" is missing from ` +
                `${path.relative(repoRoot, cfg.file)} — cannot verify per-section aliases. ` +
                `Expected a top-level \`${section}: { ... }\` block.`,
            });
            continue;
          }
          const sectionParsed = extractRegexAliases(sectionText);
          for (const alias of requiredInSection) {
            if (sectionParsed[alias] === undefined) {
              missing.push({
                file: cfg.file,
                alias,
                reason:
                  `Required alias ${alias} is missing from the "${section}" section of ` +
                  `${path.relative(repoRoot, cfg.file)}. Each electron-vite section has its own ` +
                  `resolve.alias map — add ${alias} here so ` +
                  `\`npm run build:legacy\` / \`verify:agent:full\` can resolve renderer imports ` +
                  `(D20 Stage 5, F-R2-5).`,
              });
            }
          }
        }
      }
    }
  }

  return { violations, missing };
}

// ---------------------------------------------------------------------------
// Renderer singleton dedupe integrity
// ---------------------------------------------------------------------------

type RendererConfigScope = 'global' | 'renderer';

/**
 * A renderer dedupe target record.
 *
 * - `scope`: which slice of the (comment-stripped) file to search for a
 *   `dedupe: [...]` array.
 * - `anchor` (optional): when the dedupe array is nested inside a callback
 *   (storybook's `viteFinal(...)`) or a project sub-entry (vitest's
 *   `name: 'desktop'`), provide a distinctive token as a string or regex.
 *   The extractor will slice the comment-stripped source from the first
 *   anchor match before applying `scope`. If `anchor` is provided but
 *   cannot be found, the check fails loudly with a file-context error
 *   (prevents silent mis-slicing when an anchor token is later renamed).
 * - `endAnchor` (optional): when sibling sections live AFTER the anchor
 *   (e.g. vitest's `projects: [{ name: 'desktop', ... }, { name: 'mcp',
 *   ... }]`), provide a pattern that marks the start of the next sibling.
 *   The extractor bounds the search region to `[anchor, endAnchor)`, so
 *   a future desktop-project edit that drops `dedupe` cannot silently
 *   false-pass by reading a sibling project's dedupe. The endAnchor is
 *   searched strictly AFTER the anchor's match end. If no endAnchor
 *   match is found, the slice runs to EOF (safe when the anchored block
 *   is the last sibling).
 */
type RendererDedupeTarget = Readonly<{
  file: string;
  scope: RendererConfigScope;
  anchor?: string | RegExp;
  endAnchor?: string | RegExp;
}>;

// NOTE: `packages/browser-extension/vite.config.ts` is intentionally
// excluded — it has no `@rebel/cloud-client` alias and no transitive
// cloud-client imports, so it cannot surface the duplicate-React failure
// class this check guards against. Verified 2026-04-22. If the browser
// extension ever adds such an import, add it here.
const RENDERER_DEDUPE_TARGETS: ReadonlyArray<RendererDedupeTarget> = [
  {
    file: path.join(REPO_ROOT, 'vite.renderer.config.mjs'),
    scope: 'global',
  },
  {
    file: path.join(REPO_ROOT, 'electron.vite.config.ts'),
    scope: 'renderer',
  },
  {
    file: path.join(REPO_ROOT, '.storybook/main.ts'),
    scope: 'global',
    anchor: /viteFinal\s*\(/,
  },
  {
    file: path.join(REPO_ROOT, 'web-companion/vite.config.ts'),
    scope: 'global',
  },
  {
    file: path.join(REPO_ROOT, 'vitest.config.ts'),
    scope: 'global',
    anchor: /name:\s*['"]desktop['"]/,
    // Bound the slice to the desktop project block so a future edit that
    // drops `dedupe:` from the desktop project cannot silently false-pass by
    // inheriting a sibling project's dedupe.
    endAnchor: /name:\s*['"][^'"]+['"]/,
  },
];

export async function loadRendererSingletonDeps(): Promise<readonly string[]> {
  const modulePath = path.join(REPO_ROOT, 'scripts/renderer-singleton-deps.mjs');
  const moduleUrl = pathToFileURL(modulePath).href;
  const moduleValue = (await import(moduleUrl)) as {
    RENDERER_SINGLETON_DEPS?: unknown;
  };
  const deps = moduleValue.RENDERER_SINGLETON_DEPS;
  if (!Array.isArray(deps) || deps.some((dep) => typeof dep !== 'string')) {
    throw new Error(
      `renderer-singleton-deps.mjs must export RENDERER_SINGLETON_DEPS as a string array.`,
    );
  }
  return deps;
}

function stripComments(text: string): string {
  // String-aware comment stripper. The old regex-based version corrupted
  // files containing glob patterns like `'**/*.{test,spec}'` because the
  // `/*` inside a string literal was treated as a block-comment opener.
  // This state-machine skips over single/double/template string literals
  // (with backslash escape awareness) and only strips real // line and
  // /* block */ comments. Newlines inside block comments are preserved to
  // keep line-number approximations reasonable for error messages.
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : '';

    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        const ch = text[i];
        if (ch === '\\' && i + 1 < n) {
          out += ch + text[i + 1];
          i += 2;
          continue;
        }
        out += ch;
        i++;
        if (ch === quote) break;
      }
      continue;
    }

    if (c === '/' && c2 === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) {
        break;
      }
      for (let j = i; j < end; j++) if (text[j] === '\n') out += '\n';
      i = end + 2;
      continue;
    }

    if (c === '/' && c2 === '/') {
      const end = text.indexOf('\n', i + 2);
      if (end === -1) break;
      i = end;
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

class AnchorNotFoundError extends Error {
  constructor(anchor: string | RegExp) {
    super(
      `renderer dedupe anchor ${anchor instanceof RegExp ? anchor.toString() : JSON.stringify(anchor)} not found`,
    );
    this.name = 'AnchorNotFoundError';
  }
}

function findAnchorMatch(
  sanitized: string,
  anchor: string | RegExp,
): { index: number; length: number } | null {
  if (typeof anchor === 'string') {
    const idx = sanitized.indexOf(anchor);
    return idx === -1 ? null : { index: idx, length: anchor.length };
  }
  // Use a local non-global copy so we always match from position 0 and the
  // regex's internal lastIndex can't leak across calls.
  const nonGlobal = new RegExp(anchor.source, anchor.flags.replace('g', ''));
  const match = nonGlobal.exec(sanitized);
  return match ? { index: match.index, length: match[0].length } : null;
}

function extractRendererDedupeArray(
  text: string,
  scope: RendererConfigScope,
  anchor?: string | RegExp,
  endAnchor?: string | RegExp,
): string | null {
  // Strip comments so that commented-out `dedupe:` arrays or stray
  // `renderer:` tokens inside comments cannot produce false-PASS matches.
  const sanitized = stripComments(text);
  let scopedText = sanitized;
  if (anchor !== undefined) {
    const anchorMatch = findAnchorMatch(sanitized, anchor);
    if (anchorMatch === null) {
      throw new AnchorNotFoundError(anchor);
    }
    let endIndex = sanitized.length;
    if (endAnchor !== undefined) {
      // Search strictly AFTER the anchor's match end so endAnchor regexes
      // that are generalisations of the anchor (e.g. anchor =
      // /name:\s*['"]desktop['"]/ with endAnchor = /name:\s*['"][^'"]+['"]/)
      // don't match the anchor itself.
      const afterAnchor = sanitized.slice(anchorMatch.index + anchorMatch.length);
      const endMatch = findAnchorMatch(afterAnchor, endAnchor);
      if (endMatch !== null) {
        endIndex = anchorMatch.index + anchorMatch.length + endMatch.index;
      }
    }
    scopedText = sanitized.slice(anchorMatch.index, endIndex);
  }
  if (scope === 'renderer') {
    const rendererIndex = scopedText.indexOf('renderer:');
    if (rendererIndex === -1) {
      return null;
    }
    scopedText = scopedText.slice(rendererIndex);
  }
  const dedupeMatch = scopedText.match(/dedupe\s*:\s*\[([\s\S]*?)\]/);
  return dedupeMatch?.[1] ?? null;
}

function parseDedupeEntries(
  dedupeArraySource: string,
  singletonDeps: readonly string[],
): string[] {
  const entries = new Set<string>();
  const literalRegex = /['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = literalRegex.exec(dedupeArraySource)) !== null) {
    entries.add(match[1]!);
  }
  if (/\.\.\.\s*RENDERER_SINGLETON_DEPS\b/.test(dedupeArraySource)) {
    for (const dep of singletonDeps) {
      entries.add(dep);
    }
  }
  return [...entries];
}

export function checkRendererSingletonDedupe(
  repoRoot: string,
  singletonDeps: readonly string[],
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): string[] {
  const errors: string[] = [];

  for (const target of RENDERER_DEDUPE_TARGETS) {
    let text: string;
    try {
      text = readFile(target.file);
    } catch (err) {
      errors.push(
        `Failed to read ${path.relative(repoRoot, target.file)} while checking renderer dedupe: ${(err as Error).message}`,
      );
      continue;
    }

    let dedupeArraySource: string | null;
    try {
      dedupeArraySource = extractRendererDedupeArray(
        text,
        target.scope,
        target.anchor,
        target.endAnchor,
      );
    } catch (err) {
      if (err instanceof AnchorNotFoundError) {
        errors.push(
          `${path.relative(repoRoot, target.file)} renderer dedupe anchor not found: ${err.message}. ` +
            `The anchor token may have been renamed — update RENDERER_DEDUPE_TARGETS in scripts/check-alias-integrity.ts.`,
        );
        continue;
      }
      throw err;
    }
    if (!dedupeArraySource) {
      errors.push(
        `${path.relative(repoRoot, target.file)} is missing renderer resolve.dedupe: [...].`,
      );
      continue;
    }

    const dedupeEntries = parseDedupeEntries(dedupeArraySource, singletonDeps);
    const missing = singletonDeps.filter((dep) => !dedupeEntries.includes(dep));
    if (missing.length > 0) {
      errors.push(
        `${path.relative(repoRoot, target.file)} renderer resolve.dedupe is missing required singleton deps: ${missing.join(', ')}`,
      );
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Worker-build plugin-attachment guard (prevention rec C31, second half)
// ---------------------------------------------------------------------------

interface BuildCall {
  /** outfile basename when parseable, else positional `#n` — for error messages. */
  label: string;
  /** the `build({ ... })` object-literal text. */
  body: string;
}

/**
 * Extract every `build({ ... })` call's object literal from an esbuild script
 * via brace matching. Conservative: build-worker.mjs's call objects contain no
 * `{`/`}` inside string values, so naive depth counting is safe here. The
 * regex requires `build(` immediately followed by `{`, so it does NOT match
 * `setup(build) {` or `build.onResolve({...})` inside the alias plugin itself.
 */
export function extractBuildCalls(text: string): BuildCall[] {
  const calls: BuildCall[] = [];
  const re = /\bbuild\s*\(\s*\{/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text)) !== null) {
    const braceStart = m.index + m[0].length - 1; // index of the opening `{`
    let depth = 0;
    let i = braceStart;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    const body = text.slice(braceStart, i);
    n += 1;
    const outfile = body.match(/outfile:\s*resolve\([^,]+,\s*['"]([^'"]+)['"]/);
    calls.push({ label: outfile ? outfile[1]! : `#${n}`, body });
  }
  return calls;
}

/**
 * Fail-closed check that a build-call object literal attaches `aliasPlugin` via
 * its `plugins: [ ... ]` array — NOT merely mentions the token anywhere (a
 * `// TODO aliasPlugin` comment or a string must not satisfy it). Returns false
 * if there is no `plugins` array at all.
 */
export function pluginsArrayHasAliasPlugin(buildBody: string): boolean {
  const cleaned = stripComments(buildBody);
  // Match `plugins:` then a bracket-balanced [ ... ] array.
  const start = cleaned.search(/\bplugins\s*:\s*\[/);
  if (start === -1) return false;
  const open = cleaned.indexOf('[', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return false;
  const arrayText = cleaned.slice(open + 1, end);
  return /\baliasPlugin\b/.test(arrayText);
}

/**
 * Assert every esbuild `build({...})` target in scripts/build-worker.mjs
 * attaches `aliasPlugin`. The original bug (260529_build_worker_core_alias_missing)
 * had two facets: the @core alias was missing from the map AND the alias plugin
 * was attached only to the GPU worker builds, so the Node worker builds silently
 * resolved nothing once a new @core import appeared. The alias-path check covers
 * the map; this covers the plugin. A future worker target that forgets the plugin
 * fails the gate before the Forge build path runs (kill-by-construction).
 */
export function checkWorkerBuildPluginAttachment(
  repoRoot: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): string[] {
  const file = path.join(repoRoot, 'scripts/build-worker.mjs');
  let text: string;
  try {
    text = readFile(file);
  } catch {
    return ['scripts/build-worker.mjs not found — worker-build aliasPlugin guard could not run.'];
  }
  const calls = extractBuildCalls(text);
  if (calls.length === 0) {
    return [
      'scripts/build-worker.mjs: no build({ ... }) calls found — aliasPlugin guard expected at least one (parser drift? update extractBuildCalls).',
    ];
  }
  const errors: string[] = [];
  for (const call of calls) {
    if (!pluginsArrayHasAliasPlugin(call.body)) {
      errors.push(
        `scripts/build-worker.mjs: build() target ${call.label} does not attach aliasPlugin in its plugins array — its @core/@main/@shared imports will not resolve. Add aliasPlugin to that target's plugins array.`,
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Private Mindstone alias parity
// ---------------------------------------------------------------------------

const PRIVATE_MINDSTONE_ALIAS = '@private/mindstone';
const PRIVATE_MINDSTONE_TS_ALIAS = `${PRIVATE_MINDSTONE_ALIAS}/*`;
const PRIVATE_MINDSTONE_PRIVATE_PATH = './private/mindstone/src/*';
const PRIVATE_MINDSTONE_STUB_PATH = './src/main/oss/private-mindstone-stub/*';

function readJsonFile<T>(file: string, readFile: (p: string) => string): T {
  return JSON.parse(readFile(file)) as T;
}

interface PrivateMindstoneTsconfigShape {
  compilerOptions?: {
    paths?: Record<string, string[]>;
  };
}

function checkPrivateMindstoneViteConfig(
  repoRoot: string,
  relativeFile: string,
  readFile: (p: string) => string,
): string[] {
  const file = path.join(repoRoot, relativeFile);
  const text = readFile(file);
  const strippedText = stripComments(text);
  const errors: string[] = [];
  const requiredSnippets = [
    {
      pattern: /existsSync\(\s*privateMindstoneBootstrapPath\s*\)/,
      message: 'does not guard alias selection with existsSync(privateMindstoneBootstrapPath)',
    },
    {
      pattern: /private\/mindstone\/src\/bootstrap\.ts/,
      message: 'does not check the canonical private/mindstone/src/bootstrap.ts file',
    },
    {
      pattern: /private\/mindstone\/src/,
      message: 'does not include the real private/mindstone/src alias target',
    },
    {
      pattern: /src\/main\/oss\/private-mindstone-stub/,
      message: 'does not include the OSS stub alias target',
    },
    {
      pattern: /['"]@private\/mindstone['"]\s*:\s*privateMindstoneAliasTarget/,
      message: 'does not expose @private/mindstone through privateMindstoneAliasTarget',
    },
  ];

  for (const { pattern, message } of requiredSnippets) {
    if (!pattern.test(text)) {
      errors.push(`${relativeFile}: ${message}.`);
    }
  }

  const ternaryMatch = strippedText.match(
    /const\s+privateMindstoneAliasTarget\s*=\s*existsSync\(\s*privateMindstoneBootstrapPath\s*\)\s*\?\s*(?<truthy>[^:;]+?)\s*:\s*(?<falsy>[^;]+?);/s,
  );
  if (!ternaryMatch?.groups) {
    errors.push(
      `${relativeFile}: privateMindstoneAliasTarget must be assigned with existsSync(privateMindstoneBootstrapPath) ? private target : OSS stub target.`,
    );
  } else {
    const truthyBranch = ternaryMatch.groups.truthy.trim();
    const falsyBranch = ternaryMatch.groups.falsy.trim();
    const truthyIsPrivate = /private\/mindstone\/src/.test(truthyBranch);
    const falsyIsStub = /src\/main\/oss\/private-mindstone-stub/.test(falsyBranch);
    if (!truthyIsPrivate || !falsyIsStub) {
      errors.push(
        `${relativeFile}: privateMindstoneAliasTarget fall-through order is wrong; existsSync(privateMindstoneBootstrapPath) must resolve private/mindstone/src when true and src/main/oss/private-mindstone-stub when false (found truthy branch ${JSON.stringify(truthyBranch)}, falsy branch ${JSON.stringify(falsyBranch)}).`,
      );
    }
  }

  return errors;
}

/**
 * Renderer `__REBEL_IS_OSS__` build-define parity (Stage 1 cross-surface seam,
 * 260607_oss-b6-launch-polish). The renderer learns the OSS build signal from a
 * compile-time `define` — there is no PlatformConfig in the renderer and the
 * argv leg was deliberately dropped — so the only drift guard is a config-parity
 * assertion that BOTH active renderer configs define `__REBEL_IS_OSS__` from the
 * SAME existsSync(privateMindstoneBootstrapPath) check:
 *   - vite.renderer.config.mjs        (forge / packaged production renderer)
 *   - electron.vite.config.ts         (legacy electron-vite dev renderer)
 * A literal can't be unit-tested across bundlers, so this is the keystone for
 * the renderer leg (see arbitrator report 260607_231045, decision A).
 */
function checkRendererIsOssDefine(
  repoRoot: string,
  relativeFile: string,
  readFile: (p: string) => string,
): string[] {
  const file = path.join(repoRoot, relativeFile);
  const text = readFile(file);
  const errors: string[] = [];
  const definePattern = /__REBEL_IS_OSS__\s*:\s*JSON\.stringify\(\s*isOssBuild\s*\)/;
  const requiredSnippets = [
    {
      pattern: /private\/mindstone\/src\/bootstrap\.ts/,
      message: 'does not derive the OSS signal from the canonical private/mindstone/src/bootstrap.ts existsSync check',
    },
    {
      pattern: /const\s+isOssBuild\s*=\s*!existsSync\(\s*privateMindstoneBootstrapPath\s*\)/,
      message: 'does not compute `const isOssBuild = !existsSync(privateMindstoneBootstrapPath)`',
    },
  ];
  for (const { pattern, message } of requiredSnippets) {
    if (!pattern.test(text)) {
      errors.push(`${relativeFile}: ${message}.`);
    }
  }

  const defineSearchText = relativeFile === 'electron.vite.config.ts'
    ? extractViteSection(text, 'renderer')
    : text;
  if (defineSearchText === null) {
    errors.push(
      `${relativeFile}: renderer section is missing; cannot verify \`__REBEL_IS_OSS__\` is defined for the renderer.`,
    );
  } else if (!definePattern.test(defineSearchText)) {
    const location = relativeFile === 'electron.vite.config.ts'
      ? ' inside the renderer config block'
      : '';
    errors.push(
      `${relativeFile}: does not expose \`__REBEL_IS_OSS__: JSON.stringify(isOssBuild)\`${location} in a renderer \`define\`.`,
    );
  }
  return errors;
}

/**
 * OSS-conditional `@rudderstack/analytics-js` alias parity (F8 —
 * 260618_oss-rudderstack-strip). The Elastic-2.0 RudderStack browser SDK is
 * dependency-stripped from the public mirror, so the OSS renderer build must
 * alias the specifier to a local no-op stub or Rollup fails to resolve the
 * guarded dynamic import against the physically-absent package. The alias MUST
 * be present, OSS-conditional (absent in commercial), and IDENTICAL in BOTH
 * active renderer configs:
 *   - vite.renderer.config.mjs   (forge / packaged production renderer)
 *   - electron.vite.config.ts    (legacy electron-vite renderer section)
 * This kills the config-drift class by construction (the highest-blast-radius
 * silent-failure mode this change introduces — alias in one config only → one
 * build path silently no-ops analytics, or commercial loses analytics). The
 * alias-integrity gate would otherwise NOT catch it (rudderstack is not in the
 * canonical map). Mirrors checkRendererIsOssDefine's two-config parity shape.
 */
const RUDDERSTACK_OSS_STUB_PATH = 'src/renderer/src/oss/rudderstack-analytics-stub.ts';
const RUDDERSTACK_OSS_PACKAGE = '@rudderstack/analytics-js';

function escapeRudderstackRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function checkRudderstackOssAliasConfig(
  repoRoot: string,
  relativeFile: string,
  readFile: (p: string) => string,
): string[] {
  const file = path.join(repoRoot, relativeFile);
  const text = readFile(file);
  const errors: string[] = [];

  // 1. The OSS-conditional alias target must be defined via the same
  //    existsSync(privateMindstoneBootstrapPath) → isOssBuild signal, resolving
  //    to the stub when OSS and being absent ({}) when commercial.
  const ternaryPattern = new RegExp(
    // Tolerate an optional TS type annotation (electron.vite.config.ts is .ts and
    // annotates `: Record<string, string>`; vite.renderer.config.mjs has none).
    `const\\s+rudderstackOssAlias\\s*(?::[^=]+)?=\\s*isOssBuild\\s*\\?\\s*\\{[^}]*['"]${escapeRudderstackRegExp(RUDDERSTACK_OSS_PACKAGE)}['"]\\s*:\\s*resolve\\([^)]*${escapeRudderstackRegExp(RUDDERSTACK_OSS_STUB_PATH)}[^)]*\\)[^}]*\\}\\s*:\\s*\\{\\s*\\}`,
    's',
  );
  if (!ternaryPattern.test(text)) {
    errors.push(
      `${relativeFile}: missing or malformed OSS-conditional rudderstack alias — expected \`const rudderstackOssAlias = isOssBuild ? { '${RUDDERSTACK_OSS_PACKAGE}': resolve(..., '${RUDDERSTACK_OSS_STUB_PATH}') } : {}\` (alias must be ABSENT in commercial so the real package resolves).`,
    );
  }

  // 2. The renderer resolve.alias map must spread that conditional alias in.
  //    For electron.vite.config.ts the spread must be inside the renderer section.
  const aliasSearchText = relativeFile === 'electron.vite.config.ts'
    ? extractViteSection(text, 'renderer')
    : stripComments(text);
  if (aliasSearchText === null) {
    errors.push(
      `${relativeFile}: renderer section is missing; cannot verify the rudderstack OSS alias is applied.`,
    );
  } else if (!/\.\.\.rudderstackOssAlias\b/.test(aliasSearchText)) {
    const location = relativeFile === 'electron.vite.config.ts'
      ? ' inside the renderer config block'
      : '';
    errors.push(
      `${relativeFile}: renderer \`resolve.alias\` does not spread \`...rudderstackOssAlias\`${location}.`,
    );
  }

  return errors;
}

export function checkRudderstackOssAliasParity(
  repoRoot: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): string[] {
  return [
    ...checkRudderstackOssAliasConfig(repoRoot, 'vite.renderer.config.mjs', readFile),
    ...checkRudderstackOssAliasConfig(repoRoot, 'electron.vite.config.ts', readFile),
  ];
}

export function checkPrivateMindstoneAliasParity(
  repoRoot: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): string[] {
  const errors: string[] = [
    ...checkPrivateMindstoneViteConfig(repoRoot, 'vite.main.config.mjs', readFile),
    ...checkPrivateMindstoneViteConfig(repoRoot, 'electron.vite.config.ts', readFile),
    ...checkPrivateMindstoneViteConfig(repoRoot, 'vitest.config.ts', readFile),
    ...checkRendererIsOssDefine(repoRoot, 'vite.renderer.config.mjs', readFile),
    ...checkRendererIsOssDefine(repoRoot, 'electron.vite.config.ts', readFile),
  ];

  const expectedPaths = [PRIVATE_MINDSTONE_PRIVATE_PATH, PRIVATE_MINDSTONE_STUB_PATH];
  for (const relativeFile of ['tsconfig.json', 'tsconfig.node.json']) {
    const file = path.join(repoRoot, relativeFile);
    const parsed = readJsonFile<PrivateMindstoneTsconfigShape>(file, readFile);
    const actual = parsed.compilerOptions?.paths?.[PRIVATE_MINDSTONE_TS_ALIAS];
    if (JSON.stringify(actual) !== JSON.stringify(expectedPaths)) {
      errors.push(
        `${relativeFile}: ${PRIVATE_MINDSTONE_TS_ALIAS} must be ${JSON.stringify(expectedPaths)}; found ${JSON.stringify(actual)}.`,
      );
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const configs: ConfigCheck[] = [
    {
      file: path.join(REPO_ROOT, 'electron.vite.config.ts'),
      kind: 'regex',
      // Renderer must resolve @rebel/cloud-client at bundle time.
      required: ['@rebel/shared', '@rebel/cloud-client', '@shared', '@core'],
      // Per-section required aliases — prevents the "@core defined in main but
      // not in renderer" silent-failure mode that broke `build:legacy` before
      // D20 Stage 5. Each electron-vite section owns its own resolve.alias map.
      sectionedRequirements: {
        main: ['@core', '@shared', '@rebel/shared'],
        preload: ['@shared', '@rebel/shared'],
        renderer: ['@core', '@shared', '@rebel/shared', '@rebel/cloud-client'],
      },
    },
    {
      file: path.join(REPO_ROOT, 'tsconfig.renderer.json'),
      kind: 'tsconfig',
      required: ['@rebel/shared', '@rebel/cloud-client', '@shared'],
    },
    {
      file: path.join(REPO_ROOT, 'tsconfig.node.json'),
      kind: 'tsconfig',
      // Main/preload do NOT depend on @rebel/cloud-client (banned by ESLint boundary).
      required: ['@rebel/shared', '@shared', '@core'],
    },
    {
      file: path.join(REPO_ROOT, 'vitest.config.ts'),
      kind: 'regex',
      required: ['@rebel/shared', '@rebel/cloud-client', '@shared', '@core'],
    },
    {
      file: path.join(REPO_ROOT, 'cloud-service/tsconfig.json'),
      kind: 'tsconfig',
      // cloud-service now imports from '@rebel/cloud-client' at runtime
      // (see cloud-service/src/bootstrap.ts — setLogErrorReporter bridge).
      required: ['@rebel/shared', '@rebel/cloud-client', '@shared', '@core'],
    },
    {
      file: path.join(REPO_ROOT, 'cloud-service/tsconfig.test.json'),
      kind: 'tsconfig',
      required: ['@rebel/shared', '@rebel/cloud-client', '@shared', '@core'],
    },
    {
      file: path.join(REPO_ROOT, 'cloud-client/tsconfig.test.json'),
      kind: 'tsconfig',
      required: ['@rebel/shared', '@shared'],
    },
    {
      file: path.join(REPO_ROOT, 'web-companion/tsconfig.test.json'),
      kind: 'tsconfig',
      required: ['@rebel/shared', '@rebel/cloud-client', '@shared', '@core'],
    },
    {
      file: path.join(REPO_ROOT, 'packages/shared/tsconfig.json'),
      kind: 'tsconfig',
      required: ['@rebel/shared', '@rebel/cloud-client', '@core'],
    },
    {
      file: path.join(REPO_ROOT, 'packages/browser-extension/tsconfig.json'),
      kind: 'tsconfig',
      required: ['@rebel/shared', '@rebel/cloud-client', '@core'],
    },
    {
      file: path.join(REPO_ROOT, 'mobile/tsconfig.json'),
      kind: 'tsconfig',
      // Mobile code DOES import @rebel/cloud-client today (PairScreen etc.)
      // so the IDE needs the path even though Metro/Jest resolve separately.
      required: ['@rebel/shared', '@rebel/cloud-client', '@shared', '@core'],
    },
    {
      file: path.join(REPO_ROOT, 'mobile/jest.config.js'),
      kind: 'regex',
      required: ['@rebel/shared', '@rebel/cloud-client', '@shared', '@core'],
    },
    {
      file: path.join(REPO_ROOT, 'mobile/metro.config.js'),
      kind: 'regex',
      // Metro doesn't map @shared or @core as raw aliases (imports use paths),
      // but @rebel/shared and @rebel/cloud-client must be in extraNodeModules.
      required: ['@rebel/shared', '@rebel/cloud-client'],
    },
    {
      // Cloud esbuild bundler — aliases here must match canonical paths so
      // runtime resolution matches tsconfig/lint-time resolution.
      file: path.join(REPO_ROOT, 'cloud-service/build.mjs'),
      kind: 'regex',
      required: ['@rebel/shared', '@rebel/cloud-client', '@shared', '@core'],
    },
    {
      // Embedding-worker esbuild bundler (scripts/build-worker.mjs). Its
      // `pathAliases` map must match tsconfig.node.json (@core/@main/@shared) or
      // a worker fails to resolve those imports at build time — the exact class
      // of 260529_build_worker_core_alias_missing (prevention rec C31). @core was
      // the alias the original bug lost.
      // See docs-private/postmortems/260529_build_worker_core_alias_missing_postmortem.md
      file: path.join(REPO_ROOT, 'scripts/build-worker.mjs'),
      kind: 'regex',
      required: ['@core', '@main', '@shared'],
    },
  ];

  const { violations, missing } = runAliasCheck(REPO_ROOT, configs);
  const singletonDeps = await loadRendererSingletonDeps();
  const rendererDedupeErrors = checkRendererSingletonDedupe(REPO_ROOT, singletonDeps);
  const workerPluginErrors = checkWorkerBuildPluginAttachment(REPO_ROOT);
  const privateMindstoneAliasErrors = checkPrivateMindstoneAliasParity(REPO_ROOT);
  const rudderstackOssAliasErrors = checkRudderstackOssAliasParity(REPO_ROOT);

  if (
    violations.length === 0 &&
    missing.length === 0 &&
    rendererDedupeErrors.length === 0 &&
    workerPluginErrors.length === 0 &&
    privateMindstoneAliasErrors.length === 0 &&
    rudderstackOssAliasErrors.length === 0
  ) {
    console.log(
      '\u2714 Alias integrity: all configs point @rebel/*, @shared, @core to the canonical paths, private Mindstone alias parity is intact, the OSS rudderstack alias is mirrored across both renderer configs, renderer singleton dedupe is intact, and every build-worker target attaches aliasPlugin.',
    );
    return;
  }

  for (const v of violations) {
    console.error(`\u2718 ${v.message}`);
  }
  for (const m of missing) {
    console.error(`\u2718 ${m.reason}`);
  }
  for (const dedupeError of rendererDedupeErrors) {
    console.error(`\u2718 ${dedupeError}`);
  }
  for (const workerPluginError of workerPluginErrors) {
    console.error(`\u2718 ${workerPluginError}`);
  }
  for (const privateMindstoneAliasError of privateMindstoneAliasErrors) {
    console.error(`\u2718 ${privateMindstoneAliasError}`);
  }
  for (const rudderstackOssAliasError of rudderstackOssAliasErrors) {
    console.error(`\u2718 ${rudderstackOssAliasError}`);
  }
  console.error(
    `\nAlias integrity failed: ${violations.length} path mismatches, ${missing.length} missing required aliases, ${rendererDedupeErrors.length} renderer dedupe issues, ${workerPluginErrors.length} worker-build plugin gaps, ${privateMindstoneAliasErrors.length} private Mindstone alias issues, ${rudderstackOssAliasErrors.length} rudderstack OSS alias issues.`,
  );
  process.exit(1);
}

// Only run when invoked directly (not when imported by tests).
// When executed via `tsx scripts/check-alias-integrity.ts`, Node sets
// `require.main === module` exactly as it does for CJS.
if (require.main === module) {
  main().catch((err) => {
    console.error(`\u2718 Alias integrity check crashed: ${(err as Error).message}`);
    process.exit(1);
  });
}
