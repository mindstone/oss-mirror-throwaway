#!/usr/bin/env npx tsx
/**
 * Boundary Hints — emit reviewer hints when a planned change touches a
 * registered boundary-contract surface.
 *
 * Consumed by CHIEF_ENGINEER2/CHIEF_ENGINEER2.md § 6.4 BOUNDARY_CHECKLIST.md. Fires mandatory
 * Spec Reader review steps when a hint matches. Fails closed on any
 * registry / invocation error so reviewers cannot mistake failure for
 * "no hints to address". See docs/project/BOUNDARY_REGISTRY.md.
 *
 * Usage:
 *   npx tsx scripts/boundary-hints.ts --planning-doc <path>
 *   npx tsx scripts/boundary-hints.ts --files <comma-separated>
 *   npx tsx scripts/boundary-hints.ts --diff [ref]   # default HEAD
 *
 * Exit codes:
 *   0  — success; stdout contains a Boundary Hints block (possibly empty).
 *   2  — registry/schema/regex/usage error; stderr has the cause.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fg from 'fast-glob';
import { parse as parseYaml } from 'yaml';
import { gitCapture } from './lib/git-exec.js';

// Thin async-iterable wrapper over fast-glob so we can use `for await` loops.
// node:fs/promises.glob would be cleaner but requires Node 22+; CI runs on Node 20.
async function* glob(pattern: string, opts: { cwd: string }): AsyncIterable<string> {
  const matches = await fg(pattern, { cwd: opts.cwd });
  for (const m of matches) yield m;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REGISTRY_PATH = join(repoRoot, 'docs/project/boundary-registry.yaml');

export type Entry = {
  id: string;
  category: string;
  description: string;
  spec_doc: string;
  owned_by?: string;
  match: {
    paths: string[];
    identifiers: string[];
    /**
     * Per-file filter. Files matching any exclude_paths glob are removed
     * from the candidate set BEFORE path matching. A file matching both
     * `paths` and `exclude_paths` is filtered out for that file only —
     * other path matches still contribute to firing the entry.
     * Defaults to `[]` when absent. See BOUNDARY_REGISTRY.md schema prose.
     */
    exclude_paths?: string[];
  };
  forbidden_terms?: string[];
  allowed_terms?: string[];
  rationale: string;
  postmortems: string[];
};
export type CompiledEntry = Entry & {
  identifierRegexes: RegExp[];
  forbiddenRegexes: RegExp[];
};
type Hint = {
  id: string;
  category: string;
  matched_via: string[];
  spec_doc: string;
  forbidden_terms_present: boolean;
  forbidden_locations: string[];
  rationale: string;
  postmortems: string[];
};

export class BoundaryHintsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoundaryHintsError';
  }
}

function die(msg: string): never {
  process.stderr.write(`[boundary-hints] ERROR: ${msg}\n`);
  process.exit(2);
}

/**
 * Throw on invalid entries so Vitest can assert error messages. The CLI
 * `main()` converts thrown errors to `process.exit(2)`.
 */
export function compileEntry(raw: unknown, index: number): CompiledEntry {
  const loc = `entries[${index}]`;
  if (!raw || typeof raw !== 'object') throw new BoundaryHintsError(`${loc}: not an object`);
  const e = raw as Record<string, unknown>;
  for (const field of ['id', 'category', 'description', 'spec_doc', 'rationale']) {
    if (typeof e[field] !== 'string' || !(e[field] as string).trim()) {
      throw new BoundaryHintsError(`${loc}: missing/empty string field '${field}'`);
    }
  }
  const match = e.match as Record<string, unknown> | undefined;
  if (!match || !Array.isArray(match.paths) || !Array.isArray(match.identifiers)) {
    throw new BoundaryHintsError(`${loc} (${e.id}): match.paths and match.identifiers must be arrays`);
  }
  if ((match.paths as unknown[]).length === 0) {
    throw new BoundaryHintsError(`${loc} (${e.id}): match.paths must have at least one entry`);
  }
  if (!Array.isArray(e.postmortems) || (e.postmortems as unknown[]).length === 0) {
    throw new BoundaryHintsError(`${loc} (${e.id}): postmortems must be a non-empty array`);
  }
  const excludePathsRaw = match.exclude_paths;
  if (excludePathsRaw !== undefined && !Array.isArray(excludePathsRaw)) {
    throw new BoundaryHintsError(`${loc} (${e.id}): match.exclude_paths must be an array when present`);
  }
  const excludePaths: string[] = (excludePathsRaw as unknown[] | undefined)?.map((p, i) => {
    if (typeof p !== 'string' || !p.trim()) {
      throw new BoundaryHintsError(`${loc} (${e.id}): match.exclude_paths[${i}] must be non-empty string`);
    }
    return p;
  }) ?? [];
  const id = e.id as string;
  const compileRegex = (patterns: unknown[], field: string): RegExp[] =>
    patterns.map((p, i) => {
      if (typeof p !== 'string') throw new BoundaryHintsError(`${loc} (${id}): ${field}[${i}] must be string`);
      try {
        return new RegExp(p, 'g');
      } catch (err) {
        throw new BoundaryHintsError(`${loc} (${id}): invalid regex in ${field}[${i}] (${p}): ${(err as Error).message}`);
      }
    });
  return {
    id,
    category: e.category as string,
    description: e.description as string,
    spec_doc: e.spec_doc as string,
    owned_by: typeof e.owned_by === 'string' ? e.owned_by : undefined,
    match: {
      paths: match.paths as string[],
      identifiers: match.identifiers as string[],
      exclude_paths: excludePaths,
    },
    forbidden_terms: Array.isArray(e.forbidden_terms) ? (e.forbidden_terms as string[]) : [],
    allowed_terms: Array.isArray(e.allowed_terms) ? (e.allowed_terms as string[]) : [],
    rationale: e.rationale as string,
    postmortems: e.postmortems as string[],
    identifierRegexes: compileRegex(match.identifiers as unknown[], 'identifiers'),
    forbiddenRegexes: compileRegex(
      (e.forbidden_terms as unknown[] | undefined) ?? [],
      'forbidden_terms'
    ),
  };
}

export async function loadRegistry(
  registryPath: string,
  cwdOverride?: string
): Promise<{ entries: CompiledEntry[]; warnings: string[] }> {
  if (!existsSync(registryPath)) throw new BoundaryHintsError(`registry not found at ${registryPath}`);
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(registryPath, 'utf8'));
  } catch (err) {
    throw new BoundaryHintsError(`YAML parse failed: ${(err as Error).message}`);
  }
  const root = doc as Record<string, unknown> | null;
  if (!root || root.version !== 1) throw new BoundaryHintsError(`registry missing 'version: 1'`);
  if (!Array.isArray(root.boundaries)) throw new BoundaryHintsError(`registry missing 'boundaries' array`);
  const entries = (root.boundaries as unknown[]).map((raw, i) => compileEntry(raw, i));
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.id)) throw new BoundaryHintsError(`duplicate id '${e.id}'`);
    seen.add(e.id);
  }
  const warnings: string[] = [];
  const cwd = cwdOverride ?? repoRoot;
  for (const e of entries) {
    const specPath = join(cwd, e.spec_doc.split('#')[0]);
    if (!existsSync(specPath)) warnings.push(`${e.id}: spec_doc missing at ${e.spec_doc}`);
    // Path-glob drift: each path pattern must resolve to ≥1 real repo path.
    // Silent false-negatives here are the exact failure mode the tool is meant
    // to prevent (renamed file → hint stops firing, nobody notices).
    for (const pattern of e.match.paths) {
      let found = false;
      for await (const _m of glob(pattern, { cwd })) { found = true; break; }
      if (!found) warnings.push(`${e.id}: path glob '${pattern}' matches no repo files`);
    }
  }
  return { entries, warnings };
}

type Args = { files?: string[]; diffRef?: string; planningDoc?: string; registry: string };
function parseArgs(argv: string[]): Args {
  const out: Args = { registry: DEFAULT_REGISTRY_PATH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--files') out.files = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--diff') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out.diffRef = next; i++; } else { out.diffRef = 'HEAD'; }
    } else if (a === '--planning-doc') out.planningDoc = argv[++i];
    else if (a === '--registry') out.registry = resolve(argv[++i] ?? '');
    else if (a === '--help' || a === '-h') {
      process.stdout.write(`Usage: boundary-hints.ts [--planning-doc <path>] [--files a,b,c] [--diff [ref]] [--registry <path>]\n`);
      process.exit(0);
    } else die(`unknown argument: ${a}`);
  }
  if (!out.files && !out.diffRef && !out.planningDoc) {
    die(`provide at least one of --files, --diff, --planning-doc`);
  }
  return out;
}

function gatherPaths(opts: Args): Set<string> {
  const paths = new Set<string>();
  for (const f of opts.files ?? []) paths.add(normalize(f));
  if (opts.diffRef) {
    try {
      const out = gitCapture(['diff', '--name-only', opts.diffRef], { cwd: repoRoot });
      out.split('\n').filter(Boolean).forEach(p => paths.add(normalize(p)));
    } catch (err) {
      die(`git diff failed: ${(err as Error).message}`);
    }
  }
  if (opts.planningDoc) {
    const docPath = resolve(opts.planningDoc);
    if (!existsSync(docPath)) die(`planning doc not found: ${opts.planningDoc}`);
    const text = readFileSync(docPath, 'utf8');
    for (const m of text.matchAll(/`([^`\n]+\.[a-zA-Z0-9]+)`/g)) paths.add(normalize(m[1]));
  }
  return paths;
}

export function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function gatherText(opts: Args): string {
  // Text comes ONLY from the planning doc. Scanning --files / --diff file contents
  // would self-match the registry and the script itself, which own the identifier
  // strings by definition. Planning-doc prose is the right signal at plan-review time.
  if (!opts.planningDoc) return '';
  return readFileSync(resolve(opts.planningDoc), 'utf8');
}

/**
 * Match include globs against a candidate file set, honoring exclude_paths
 * as a PER-FILE filter (exclude wins for that file only). A file matching
 * both include and exclude globs is removed from the candidate set; other
 * files matching the include globs still contribute to firing.
 *
 * Returns true when any non-excluded changed file is also covered by an
 * include glob.
 */
export async function matchPaths(
  includeGlobs: string[],
  excludeGlobs: string[],
  files: Set<string>,
  cwdOverride?: string
): Promise<boolean> {
  if (files.size === 0) return false;
  const cwd = cwdOverride ?? repoRoot;
  // Build the set of excluded changed files.
  const excluded = new Set<string>();
  if (excludeGlobs.length > 0) {
    for (const pattern of excludeGlobs) {
      for await (const match of glob(pattern, { cwd })) {
        const normalized = normalize(match as string);
        if (files.has(normalized)) excluded.add(normalized);
      }
    }
  }
  // Now check include globs against files NOT in the excluded set.
  for (const pattern of includeGlobs) {
    for await (const match of glob(pattern, { cwd })) {
      const normalized = normalize(match as string);
      if (files.has(normalized) && !excluded.has(normalized)) return true;
    }
  }
  return false;
}

export function matchRegexes(regexes: RegExp[], text: string): boolean {
  if (!text) return false;
  return regexes.some(r => { r.lastIndex = 0; return r.test(text); });
}

export function findForbidden(regexes: RegExp[], text: string): string[] {
  if (!text || regexes.length === 0) return [];
  const hits: string[] = [];
  for (const r of regexes) {
    r.lastIndex = 0;
    for (const m of text.matchAll(new RegExp(r.source, 'g'))) {
      const start = Math.max(0, (m.index ?? 0) - 30);
      const end = Math.min(text.length, (m.index ?? 0) + m[0].length + 30);
      hits.push(`...${text.slice(start, end).replace(/\s+/g, ' ')}...`);
    }
  }
  return hits.slice(0, 5);
}

function emitYaml(hints: Hint[], warnings: string[]): void {
  const ts = new Date().toISOString();
  const lines: string[] = [`# Boundary Hints (generated by scripts/boundary-hints.ts at ${ts})`];
  if (hints.length === 0) {
    lines.push('Boundary Hints: []  # no registered boundaries match this change');
  } else {
    lines.push('Boundary Hints:');
    for (const h of hints) {
      lines.push(`  - id: ${h.id}`);
      lines.push(`    category: ${h.category}`);
      lines.push(`    matched_via: [${h.matched_via.join(', ')}]`);
      lines.push(`    spec_doc: ${h.spec_doc}`);
      lines.push(`    forbidden_terms_present: ${h.forbidden_terms_present}`);
      if (h.forbidden_terms_present) {
        lines.push(`    forbidden_locations:`);
        for (const loc of h.forbidden_locations) lines.push(`      - ${JSON.stringify(loc)}`);
      }
      lines.push(`    rationale: ${JSON.stringify(h.rationale.trim().replace(/\s+/g, ' '))}`);
      lines.push(`    postmortems: [${h.postmortems.map(p => JSON.stringify(p)).join(', ')}]`);
      lines.push(`    required_reviewer_action: |`);
      lines.push(`      1. Open ${h.spec_doc} and grep for invariants relevant to this boundary.`);
      lines.push(`      2. In your review response, write a "Spec Reader - ${h.id}" block with 3-5 verbatim invariant quotes.`);
      lines.push(`      3. For each invariant, state "verified" or "deviates - rationale: ...".`);
      lines.push(`      4. Do NOT approve without this block. Missing block = INCOMPLETE review.`);
    }
  }
  lines.push(`Registry Warnings: ${warnings.length === 0 ? '[]' : ''}`);
  for (const w of warnings) lines.push(`  - ${JSON.stringify(w)}`);
  process.stdout.write(lines.join('\n') + '\n');
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  let loaded: { entries: CompiledEntry[]; warnings: string[] };
  try {
    loaded = await loadRegistry(opts.registry);
  } catch (err) {
    if (err instanceof BoundaryHintsError) die(err.message);
    throw err;
  }
  const { entries, warnings } = loaded;
  const paths = gatherPaths(opts);
  const text = gatherText(opts);
  const hints: Hint[] = [];
  for (const e of entries) {
    const via: string[] = [];
    if (await matchPaths(e.match.paths, e.match.exclude_paths ?? [], paths)) via.push('path_glob');
    if (matchRegexes(e.identifierRegexes, text)) via.push('identifier');
    if (via.length === 0) continue;
    const forbiddenLocs = findForbidden(e.forbiddenRegexes, text);
    hints.push({
      id: e.id,
      category: e.category,
      matched_via: via,
      spec_doc: e.spec_doc,
      forbidden_terms_present: forbiddenLocs.length > 0,
      forbidden_locations: forbiddenLocs,
      rationale: e.rationale,
      postmortems: e.postmortems,
    });
  }
  emitYaml(hints, warnings);
}

// Direct-execution gate: only run the CLI when this file is invoked directly
// (e.g. `npx tsx scripts/boundary-hints.ts`). When imported from tests via
// Vitest, the exports are available but `main()` does not run.
const invokedAsScript = (() => {
  if (!process.argv[1]) return false;
  try {
    // fileURLToPath of import.meta.url vs resolved argv[1]
    const entry = resolve(process.argv[1]);
    const thisFile = fileURLToPath(import.meta.url);
    return entry === thisFile;
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main().catch(err => die(`unexpected: ${(err as Error).stack ?? err}`));
}
