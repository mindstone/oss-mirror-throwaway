#!/usr/bin/env tsx
/**
 * Doc-reachability auditor (Stage 1: deterministic backbone).
 *
 * Answers: starting from root AGENTS.md, can an agent navigate to a given
 * orientation unit (code directory / entry-point file) within a handful of
 * sensible documentation hops? Builds a markdown -> {doc, code} link graph,
 * BFS-es hop distance from root AGENTS.md, then reports the gaps —
 * weighted by risk tier so auth/safety/IPC code is held to a higher bar
 * than leaf UI helpers.
 *
 * This is a *coverage / reachability* auditor, NOT a link-integrity checker
 * (lychee already does that — see .lychee.toml) and NOT a CI gate (it emits a
 * periodic report; see the plan). The actionable remedy for most gaps is
 * "add a small narrow signpost doc" or "add a link from the nearest hub".
 *
 * @see docs/plans/260614_doc_reachability_audit/PLAN.md — design + decisions
 * @see docs/project/DEV_DOCUMENTATION.md — the policy this measures
 * @see scripts/generate-impact-map.ts — fan-in (reverseDeps) source reused for risk tiers
 *
 * Usage:
 *   npx tsx scripts/audit-doc-reachability.ts                 # report to tmp/doc-reachability/
 *   npx tsx scripts/audit-doc-reachability.ts --out <dir>     # custom output dir
 *   npx tsx scripts/audit-doc-reachability.ts --max-hops 4    # "handful of hops" threshold (default 4)
 *   npx tsx scripts/audit-doc-reachability.ts --json-only     # skip the markdown report
 */
import * as fs from 'fs';
import * as path from 'path';

export const ROOT = path.resolve(__dirname, '..');

// Code extensions that count as "code" link targets / orientation-unit contents.
const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
]);
// Extensions a backticked path may carry that we still treat as a code-ish target.
const PATHISH_EXTS = new Set([
  ...CODE_EXTS, '.json', '.sh', '.css', '.md', '.py', '.yml', '.yaml',
]);

// Top-level dirs that hold code we care about reaching.
const CODE_ROOTS = ['src', 'cloud-service', 'cloud-client', 'packages', 'mobile', 'evals', 'scripts'];

// Path segments that mark build output / generated code — never a stale *source* signpost.
const GENERATED_SEGMENTS = new Set(['dist', 'out', 'build', 'release', 'generated']);

/**
 * A missing code-ref we should NOT report as stale:
 * - build/generated artifacts (`cloud-service/dist/...`, `src/preload/generated/`, `*.built.mjs`)
 * - top-level `src/<file>.<ext>` — this repo nests under src/{main,core,renderer,…}; a bare
 *   top-level src file is almost always a *package-relative* path in a doc describing a
 *   submodule connector (e.g. an MCP server's own `src/index.ts`), not this repo's tree.
 */
/**
 * Docs explicitly marked deprecated/historical/obsolete (frontmatter `status:`) legitimately
 * name removed code as historical reference — they should not be nagged for stale refs.
 */
export function isHistoricalDoc(content: string): boolean {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  return !!fm && /\bstatus:\s*["']?(deprecated|historical|obsolete)["']?/i.test(fm[1]);
}

export function isExcludedStaleRef(rel: string): boolean {
  const segments = rel.split('/');
  if (segments.some((s) => GENERATED_SEGMENTS.has(s))) return true;
  if (/\.(built|min)\./.test(path.basename(rel))) return true;
  if (/^src\/[^/]+\.[A-Za-z0-9]+$/.test(rel)) return true;
  // eval output dirs (gitignored, generated) referenced by eval docs/READMEs — not source
  if (/(^|\/)evals\/(results|analysis)(\/|$)/.test(rel) || rel.includes('evals/gui/docs/')) return true;
  return false;
}

// Directories never enumerated as orientation units (or scanned for docs).
const EXCLUDED_DIR_NAMES = new Set([
  'node_modules', 'dist', 'out', 'build', '.git', 'coverage', '__snapshots__',
  'generated', '.turbo', '.vite', 'release', 'vendor', '.factory',
]);

// ---------------------------------------------------------------------------
// Alias resolution (parsed from tsconfig.json compilerOptions.paths)
// ---------------------------------------------------------------------------

export function loadAliasMap(repoRoot: string): Record<string, string> {
  const map: Record<string, string> = {};
  const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return map;
  try {
    // tsconfig allows comments/trailing commas; strip the common cases.
    const raw = fs.readFileSync(tsconfigPath, 'utf-8')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const json = JSON.parse(raw);
    const paths: Record<string, string[]> = json?.compilerOptions?.paths ?? {};
    for (const [alias, targets] of Object.entries(paths)) {
      if (!Array.isArray(targets) || targets.length === 0) continue;
      // "@core/*" -> "@core/", target "./src/core/*" -> "src/core/"
      const aliasPrefix = alias.replace(/\*$/, '');
      const targetPrefix = targets[0].replace(/^\.\//, '').replace(/\*$/, '');
      map[aliasPrefix] = targetPrefix;
    }
  } catch {
    // Best-effort: alias resolution degrades to "unresolved", which is observable
    // in the report (code refs that don't resolve are dropped, not silently passed).
  }
  return map;
}

// ---------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------

export interface ExtractedLink {
  /** Raw target text as written in the doc (pre-resolution). */
  raw: string;
  /** How it was written: a markdown [..](..) link, or an inline `backtick` path. */
  source: 'markdown' | 'backtick';
}

const MD_LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const BACKTICK_RE = /`([^`]+)`/g;

/** Known tsconfig aliases we resolve (kept narrow so npm scopes like `@rebel/…` aren't mistaken for paths). */
const KNOWN_ALIAS_RE = /^@(core|main|renderer|shared|preload)\//;

/** Globs / placeholders that are never concrete repo paths (incl. `...` path elisions in prose). */
export function isGlobOrPlaceholder(s: string): boolean {
  return /[*<>]/.test(s) || /\.\.\./.test(s);
}

/** True if a backticked string looks like a repo path worth resolving. */
export function looksLikePath(s: string): boolean {
  const cleaned = stripTargetSuffix(s.trim());
  if (!cleaned || cleaned.includes(' ')) return false;
  if (/^https?:\/\//.test(cleaned)) return false;
  if (isGlobOrPlaceholder(cleaned)) return false;
  // known tsconfig alias (@core/..., @renderer/...) — not arbitrary npm scopes
  if (KNOWN_ALIAS_RE.test(cleaned)) return true;
  // rooted in a known code/doc top dir
  if (CODE_ROOTS.some((r) => cleaned === r || cleaned.startsWith(`${r}/`))) return true;
  if (cleaned.startsWith('docs/')) return true;
  // has a separator AND a known extension
  const ext = path.extname(cleaned);
  if (cleaned.includes('/') && PATHISH_EXTS.has(ext)) return true;
  return false;
}

/** Strip `#anchor`, `:line`, `:symbol()`, and trailing `()` from a target. */
export function stripTargetSuffix(target: string): string {
  let t = target.trim();
  t = t.replace(/^<|>$/g, '');
  const hash = t.indexOf('#');
  if (hash >= 0) t = t.slice(0, hash);
  // `:lineNo` or `:symbolName` or `:symbol()` — only strip a single trailing :segment
  t = t.replace(/:[A-Za-z0-9_$]+(\(\))?$/, '');
  t = t.replace(/\(\)$/, '');
  return t.trim();
}

export function extractLinks(markdown: string): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  // Strip fenced code blocks first: their backticks otherwise mis-pair the inline-code scan
  // for the rest of the doc (dropping real path mentions), and paths inside example code are
  // not signposts anyway.
  markdown = markdown.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');
  let m: RegExpExecArray | null;
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(markdown)) !== null) {
    // Code such as `arr[i](x)` or `makeApi[method](req)` parses as [text](target) but is not a
    // link: a bare-identifier target (no path separator, extension, or anchor) is never a real link.
    if (/^[A-Za-z_$][\w$]*$/.test(m[1].trim())) continue;
    out.push({ raw: m[1], source: 'markdown' });
  }
  BACKTICK_RE.lastIndex = 0;
  while ((m = BACKTICK_RE.exec(markdown)) !== null) {
    if (looksLikePath(m[1])) out.push({ raw: m[1], source: 'backtick' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

export interface ResolvedTarget {
  /** repo-relative POSIX path, or null if it doesn't resolve to an existing file/dir. */
  relPath: string | null;
  kind: 'doc' | 'code' | 'missing' | 'external';
  /** true if the resolved path exists on disk. */
  exists: boolean;
}

/**
 * Resolve a repo-relative path on disk, applying code-extension and /index
 * fallbacks (so `src/core/platform` matches `src/core/platform.ts`). Returns
 * the actual existing repo-relative path, or null.
 */
export function resolveOnDisk(repoRoot: string, rel: string): string | null {
  if (!rel) return null;
  rel = rel.replace(/\/+$/, ''); // canonicalise: dir links often carry a trailing slash (`src/foo/`)
  if (!rel) return null;
  const direct = path.join(repoRoot, rel);
  if (fs.existsSync(direct)) return rel;
  if (!path.extname(rel)) {
    for (const ext of CODE_EXTS) {
      if (fs.existsSync(path.join(repoRoot, rel + ext))) return rel + ext;
    }
    // a bare dir-like path that exists only via index.* — return the dir
    for (const ext of CODE_EXTS) {
      if (fs.existsSync(path.join(repoRoot, rel, `index${ext}`))) return rel;
    }
  }
  return null;
}

export function resolveTarget(
  rawTarget: string,
  fromDocRelDir: string,
  aliasMap: Record<string, string>,
  repoRoot: string,
): ResolvedTarget {
  const raw = rawTarget.trim();
  if (/^https?:\/\//.test(raw) || raw.startsWith('mailto:')) {
    return { relPath: null, kind: 'external', exists: false };
  }
  const cleaned = stripTargetSuffix(raw);
  if (!cleaned || isGlobOrPlaceholder(cleaned)) {
    return { relPath: null, kind: 'external', exists: false };
  }

  // Build candidate repo-relative paths, then pick the first that exists on disk.
  // `src/foo` inside a nested AGENTS.md can mean either the doc's own `src/foo`
  // or the repo-root `src/foo` (shared core) — so we try both and let the
  // filesystem disambiguate.
  const candidates: string[] = [];
  const aliasHit = Object.keys(aliasMap).find(
    (a) => cleaned === a.replace(/\/$/, '') || cleaned.startsWith(a),
  );
  if (aliasHit) {
    candidates.push(cleaned.replace(aliasHit, aliasMap[aliasHit]));
  } else if (cleaned.startsWith('/')) {
    candidates.push(cleaned.slice(1));
  } else {
    const docRel = path.posix.normalize(path.posix.join(fromDocRelDir, cleaned)).replace(/^\.\//, '');
    const rootRel = cleaned.replace(/^\.\//, '');
    candidates.push(docRel);
    if (rootRel !== docRel) candidates.push(rootRel);
  }

  for (const cand of candidates) {
    const resolved = resolveOnDisk(repoRoot, cand);
    if (resolved) {
      return { relPath: resolved, kind: resolved.endsWith('.md') ? 'doc' : 'code', exists: true };
    }
  }
  // Nothing existed. Prefer a code-root-rooted candidate so under-code-root stale detection
  // works even when the doc-relative candidate (e.g. `docs/project/src/...` from a backticked
  // `src/...` path in a docs/project file) would otherwise mask it.
  const codeRooted = candidates.find((c) => CODE_ROOTS.some((rt) => c === rt || c.startsWith(`${rt}/`)));
  return { relPath: codeRooted ?? candidates[0] ?? cleaned, kind: 'missing', exists: false };
}

// ---------------------------------------------------------------------------
// Doc discovery
// ---------------------------------------------------------------------------

/** Markdown docs that form the agent-navigation surface. */
export function discoverDocs(repoRoot: string): string[] {
  const docs = new Set<string>();
  const addIfExists = (rel: string) => {
    if (fs.existsSync(path.join(repoRoot, rel))) docs.add(rel);
  };
  addIfExists('AGENTS.md');
  addIfExists('CLAUDE.md');
  addIfExists('README.md');

  // All of docs/project (the evergreen surface).
  walkFiles(path.join(repoRoot, 'docs', 'project'), repoRoot, (rel) => {
    if (rel.endsWith('.md')) docs.add(rel);
  });

  // Nested AGENTS.md / CLAUDE.md / README.md across the code tree.
  for (const r of CODE_ROOTS) {
    walkFiles(path.join(repoRoot, r), repoRoot, (rel) => {
      const base = path.basename(rel);
      if (base === 'AGENTS.md' || base === 'CLAUDE.md' || base === 'README.md') docs.add(rel);
    });
  }
  return [...docs].sort();
}

function walkFiles(absDir: string, repoRoot: string, visit: (rel: string) => void): void {
  if (!fs.existsSync(absDir)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.factory') continue;
    if (EXCLUDED_DIR_NAMES.has(e.name)) continue;
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) {
      walkFiles(abs, repoRoot, visit);
    } else if (e.isFile()) {
      visit(path.relative(repoRoot, abs).split(path.sep).join('/'));
    }
  }
}

// ---------------------------------------------------------------------------
// Graph + BFS
// ---------------------------------------------------------------------------

export interface DocGraph {
  /** doc rel path -> set of doc rel paths it links to */
  docEdges: Map<string, Set<string>>;
  /** doc rel path -> set of code rel paths it references (file or dir) */
  codeRefs: Map<string, Set<string>>;
  /** doc rel path -> code refs that did not resolve (stale signpost) */
  staleRefs: Map<string, Set<string>>;
}

export function buildGraph(repoRoot: string, docs: string[], aliasMap: Record<string, string>): DocGraph {
  const docSet = new Set(docs);
  const docEdges = new Map<string, Set<string>>();
  const codeRefs = new Map<string, Set<string>>();
  const staleRefs = new Map<string, Set<string>>();

  for (const doc of docs) {
    docEdges.set(doc, new Set());
    codeRefs.set(doc, new Set());
    staleRefs.set(doc, new Set());
    const content = fs.readFileSync(path.join(repoRoot, doc), 'utf-8');
    const historical = isHistoricalDoc(content);
    const fromDir = path.posix.dirname(doc);
    for (const link of extractLinks(content)) {
      const r = resolveTarget(link.raw, fromDir, aliasMap, repoRoot);
      if (r.kind === 'doc' && r.relPath) {
        if (docSet.has(r.relPath)) docEdges.get(doc)!.add(r.relPath);
        // .md outside the discovered set (e.g. plans/) is intentionally not a hop node.
      } else if (r.kind === 'code' && r.relPath) {
        codeRefs.get(doc)!.add(r.relPath);
      } else if (r.kind === 'missing' && r.relPath) {
        // Only count dead refs that point *into a code root* (markdown stale links
        // are lychee's job; docs/ and gitignored dirs are out of scope).
        const ext = path.extname(r.relPath);
        const underCodeRoot = CODE_ROOTS.some((rt) => r.relPath!.startsWith(`${rt}/`));
        // docs/project/mcps/* describe submodule connector packages; their `src/...` refs are
        // package-relative (the connector's own tree), not this repo's — skip them.
        const describesSubmodulePackage = doc.startsWith('docs/project/mcps/');
        if (
          underCodeRoot && !r.relPath.endsWith('.md') && (CODE_EXTS.has(ext) || ext === '') &&
          !isExcludedStaleRef(r.relPath) && !describesSubmodulePackage && !historical
        ) {
          staleRefs.get(doc)!.add(r.relPath);
        }
      }
    }
  }
  return { docEdges, codeRefs, staleRefs };
}

/** BFS hop distance from a root doc over doc->doc edges. Root = 0. */
export function bfsHops(graph: DocGraph, rootDoc: string): Map<string, number> {
  const dist = new Map<string, number>();
  if (!graph.docEdges.has(rootDoc)) return dist;
  dist.set(rootDoc, 0);
  const queue: string[] = [rootDoc];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = dist.get(cur)!;
    for (const next of graph.docEdges.get(cur) ?? []) {
      if (!dist.has(next)) {
        dist.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  return dist;
}

// ---------------------------------------------------------------------------
// Orientation units + coverage
// ---------------------------------------------------------------------------

export type RiskTier = 'high' | 'medium' | 'low';

const HIGH_RISK_PATTERNS = [
  /\/(auth|oauth)(\/|$)/i, /codexAuth/i, /providerRout|providerEligibility/i,
  /\bsafety\b/i, /\bipc\b/i, /(^|\/)stores?(\/|$)/i, /(^|\/)services?(\/|$)/i,
  /modelRout|billing|\bpricing\b/i,
  /agentRuntime|agentTurn|agentMessage/i, /cloudChannelPolic|cloudSettingsPolic/i,
];
const LOW_RISK_PATTERNS = [
  /\/components\/ui(\/|$)/i, /\.stories\./i, /(^|\/)styles?(\/|$)/i,
  /(^|\/)icons?(\/|$)/i, /(^|\/)assets?(\/|$)/i,
];

/** Test / fixture / mock dirs are not orientation units an agent needs doc-routing to. */
export function isTestOrFixturePath(rel: string): boolean {
  return rel.split('/').some((seg) => seg.startsWith('__') || seg === 'fixtures' || seg === 'mocks');
}

/** Enumerate code directories that hold orientation-worthy code. */
export function enumerateUnits(repoRoot: string): string[] {
  const dirs = new Set<string>();
  for (const r of CODE_ROOTS) {
    walkFiles(path.join(repoRoot, r), repoRoot, (rel) => {
      if (CODE_EXTS.has(path.extname(rel))) {
        const dir = path.posix.dirname(rel);
        if (dir && dir !== '.' && !isTestOrFixturePath(dir)) dirs.add(dir);
      }
    });
  }
  return [...dirs].sort();
}

export function riskTier(unit: string, fanIn: number): RiskTier {
  if (HIGH_RISK_PATTERNS.some((re) => re.test(unit))) return 'high';
  if (LOW_RISK_PATTERNS.some((re) => re.test(unit))) return 'low';
  if (fanIn >= 15) return 'high';
  if (fanIn >= 4) return 'medium';
  return 'low';
}

export interface UnitCoverage {
  unit: string;
  tier: RiskTier;
  fanIn: number;
  /** min hops to reach this unit (a doc at hop k referencing it -> k+1), or null if unreachable. */
  hops: number | null;
  /** the doc that provides the shortest route, if any */
  viaDoc: string | null;
  /** true if the dir contains its own AGENTS.md or README.md (a local orientation anchor). */
  hasOwnDoc: boolean;
}

/** Load reverseDeps fan-in from an existing .impact-map.json, if present. */
export function loadFanIn(repoRoot: string): Map<string, number> {
  const fanIn = new Map<string, number>();
  const p = path.join(repoRoot, '.impact-map.json');
  if (!fs.existsSync(p)) return fanIn;
  try {
    const json = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const reverseDeps: Record<string, string[]> = json?.reverseDeps ?? {};
    for (const [mod, importers] of Object.entries(reverseDeps)) {
      const dir = path.posix.dirname(mod);
      fanIn.set(dir, (fanIn.get(dir) ?? 0) + (Array.isArray(importers) ? importers.length : 0));
    }
  } catch {
    /* best-effort */
  }
  return fanIn;
}

export function computeCoverage(
  repoRoot: string,
  units: string[],
  graph: DocGraph,
  hops: Map<string, number>,
  fanIn: Map<string, number>,
): UnitCoverage[] {
  // Build: code path -> best (hops, doc). A doc referencing dir D, or any file under D, covers D.
  const dirBest = new Map<string, { hops: number; viaDoc: string }>();
  const consider = (coveredDir: string, hop: number, doc: string) => {
    const cur = dirBest.get(coveredDir);
    if (!cur || hop < cur.hops) dirBest.set(coveredDir, { hops: hop, viaDoc: doc });
  };
  for (const [doc, refs] of graph.codeRefs) {
    const docHop = hops.get(doc);
    if (docHop === undefined) continue; // doc unreachable from root -> doesn't confer reachability
    const refHop = docHop + 1;
    for (const ref of refs) {
      const refDir = ref.includes('.') && CODE_EXTS.has(path.extname(ref)) ? path.posix.dirname(ref) : ref;
      // a reference confers coverage on the referenced dir and all its ancestors up to a code root
      let d: string = refDir;
      while (d && d !== '.' && !CODE_ROOTS.includes(d)) {
        consider(d, refHop, doc);
        d = path.posix.dirname(d);
      }
      if (CODE_ROOTS.includes(d)) consider(d, refHop, doc);
    }
  }

  return units.map((unit) => {
    const best = dirBest.get(unit);
    return {
      unit,
      tier: riskTier(unit, fanIn.get(unit) ?? 0),
      fanIn: fanIn.get(unit) ?? 0,
      hops: best ? best.hops : null,
      viaDoc: best ? best.viaDoc : null,
      hasOwnDoc: hasOwningDoc(repoRoot, unit),
    };
  });
}

function hasOwningDoc(repoRoot: string, unit: string): boolean {
  for (const name of ['AGENTS.md', 'README.md']) {
    if (fs.existsSync(path.join(repoRoot, unit, name))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface AuditResult {
  generatedFrom: string;
  maxHops: number;
  /** false when .impact-map.json is absent — risk tiers then come from path heuristics only. */
  fanInAvailable: boolean;
  totals: {
    units: number;
    reachable: number;
    unreachable: number;
    byTier: Record<RiskTier, { total: number; reachable: number; overHops: number }>;
  };
  unreachableHighRisk: UnitCoverage[];
  overHopsHighRisk: UnitCoverage[];
  dirsWithoutOwnDoc: string[];
  staleCodeRefs: Array<{ doc: string; ref: string }>;
  hopHistogram: Record<string, number>;
}

export function buildResult(
  coverage: UnitCoverage[],
  graph: DocGraph,
  maxHops: number,
  fanInAvailable: boolean,
): AuditResult {
  const byTier: Record<RiskTier, { total: number; reachable: number; overHops: number }> = {
    high: { total: 0, reachable: 0, overHops: 0 },
    medium: { total: 0, reachable: 0, overHops: 0 },
    low: { total: 0, reachable: 0, overHops: 0 },
  };
  const hopHistogram: Record<string, number> = {};
  let reachable = 0;
  for (const c of coverage) {
    byTier[c.tier].total += 1;
    if (c.hops !== null) {
      reachable += 1;
      byTier[c.tier].reachable += 1;
      if (c.hops > maxHops) byTier[c.tier].overHops += 1;
      const key = String(c.hops);
      hopHistogram[key] = (hopHistogram[key] ?? 0) + 1;
    } else {
      hopHistogram['unreachable'] = (hopHistogram['unreachable'] ?? 0) + 1;
    }
  }

  const staleCodeRefs: Array<{ doc: string; ref: string }> = [];
  for (const [doc, refs] of graph.staleRefs) {
    for (const ref of refs) staleCodeRefs.push({ doc, ref });
  }

  return {
    generatedFrom: 'AGENTS.md',
    maxHops,
    fanInAvailable,
    totals: {
      units: coverage.length,
      reachable,
      unreachable: coverage.length - reachable,
      byTier,
    },
    unreachableHighRisk: coverage
      .filter((c) => c.tier === 'high' && c.hops === null)
      .sort((a, b) => b.fanIn - a.fanIn),
    overHopsHighRisk: coverage
      .filter((c) => c.tier === 'high' && c.hops !== null && c.hops > maxHops)
      .sort((a, b) => (b.hops ?? 0) - (a.hops ?? 0)),
    dirsWithoutOwnDoc: coverage
      .filter((c) => c.tier === 'high' && !c.hasOwnDoc && c.hops === null)
      .map((c) => c.unit),
    staleCodeRefs: staleCodeRefs.sort((a, b) => a.doc.localeCompare(b.doc)),
    hopHistogram,
  };
}

export function renderMarkdown(result: AuditResult): string {
  const lines: string[] = [];
  lines.push('# Doc-Reachability Audit Report');
  lines.push('');
  lines.push(`Generated from \`${result.generatedFrom}\`; "handful of hops" threshold = ${result.maxHops}.`);
  lines.push('');
  lines.push('> Stage 1 (deterministic): measures **path-signpost reachability** — whether a doc');
  lines.push('> within the hop budget references each code directory by path, so an agent could');
  lines.push('> navigate from root `AGENTS.md` to it. (Whether that doc *actually orients* the agent');
  lines.push('> is the Stage 2 LLM-traversal job.) The usual remedy for a gap is a **small narrow');
  lines.push('> signpost doc** or a link from the nearest hub — not prose.');
  lines.push('');
  if (!result.fanInAvailable) {
    lines.push('> ⚠️ **Fan-in data absent** (`.impact-map.json` not found). Risk tiers are derived from');
    lines.push('> path heuristics only, so the "medium" tier is empty. Run `npx tsx scripts/generate-impact-map.ts`');
    lines.push('> first for tiers enriched by import fan-in.');
    lines.push('');
  }
  lines.push('## Coverage by risk tier');
  lines.push('');
  lines.push('| Tier | Units | Reachable | % | Over hop budget |');
  lines.push('|------|-------|-----------|---|-----------------|');
  for (const tier of ['high', 'medium', 'low'] as RiskTier[]) {
    const t = result.totals.byTier[tier];
    const pct = t.total ? `${Math.round((t.reachable / t.total) * 100)}%` : 'n/a';
    lines.push(`| ${tier} | ${t.total} | ${t.reachable} | ${pct} | ${t.overHops} |`);
  }
  lines.push('');
  lines.push(`**Overall:** ${result.totals.reachable}/${result.totals.units} units reachable.`);
  lines.push('');

  lines.push('## Unreachable high-risk units (act on these first)');
  lines.push('');
  if (result.unreachableHighRisk.length === 0) {
    lines.push('_None — every high-risk unit is reachable._');
  } else {
    lines.push('| Unit | Fan-in | Has own AGENTS/README? | Suggested remedy |');
    lines.push('|------|--------|------------------------|------------------|');
    for (const c of result.unreachableHighRisk) {
      const remedy = c.hasOwnDoc
        ? 'link its AGENTS.md from the nearest reachable hub'
        : 'add a narrow signpost doc / AGENTS.md and link it from the nearest hub';
      lines.push(`| \`${c.unit}\` | ${c.fanIn} | ${c.hasOwnDoc ? 'yes' : 'no'} | ${remedy} |`);
    }
  }
  lines.push('');

  lines.push('## High-risk units reachable but beyond the hop budget');
  lines.push('');
  if (result.overHopsHighRisk.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| Unit | Hops | Via doc |');
    lines.push('|------|------|---------|');
    for (const c of result.overHopsHighRisk) {
      lines.push(`| \`${c.unit}\` | ${c.hops} | \`${c.viaDoc}\` |`);
    }
  }
  lines.push('');

  lines.push('## Stale code references in docs (signposts pointing at missing paths)');
  lines.push('');
  if (result.staleCodeRefs.length === 0) {
    lines.push('_None._');
  } else {
    for (const s of result.staleCodeRefs.slice(0, 100)) {
      lines.push(`- \`${s.doc}\` → \`${s.ref}\` (missing)`);
    }
    if (result.staleCodeRefs.length > 100) {
      lines.push(`- … and ${result.staleCodeRefs.length - 100} more (see JSON).`);
    }
  }
  lines.push('');

  lines.push('## Hop-distance distribution (all tiers)');
  lines.push('');
  const keys = Object.keys(result.hopHistogram).sort((a, b) => {
    if (a === 'unreachable') return 1;
    if (b === 'unreachable') return -1;
    return Number(a) - Number(b);
  });
  for (const k of keys) {
    lines.push(`- ${k === 'unreachable' ? 'unreachable' : `${k} hop(s)`}: ${result.hopHistogram[k]}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function runAudit(repoRoot: string, maxHops: number): { result: AuditResult; graph: DocGraph; coverage: UnitCoverage[] } {
  const aliasMap = loadAliasMap(repoRoot);
  const docs = discoverDocs(repoRoot);
  const graph = buildGraph(repoRoot, docs, aliasMap);
  const hops = bfsHops(graph, 'AGENTS.md');
  const fanIn = loadFanIn(repoRoot);
  const units = enumerateUnits(repoRoot);
  const coverage = computeCoverage(repoRoot, units, graph, hops, fanIn);
  const result = buildResult(coverage, graph, maxHops, fanIn.size > 0);
  return { result, graph, coverage };
}

function parseArgs(argv: string[]): { out: string; maxHops: number; jsonOnly: boolean } {
  let out = path.join(ROOT, 'tmp', 'doc-reachability');
  let maxHops = 4;
  let jsonOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) { out = path.resolve(argv[++i]); }
    else if (argv[i] === '--max-hops' && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`--max-hops must be a positive integer (got "${argv[i]}")`);
      }
      maxHops = n;
    }
    else if (argv[i] === '--json-only') { jsonOnly = true; }
  }
  return { out, maxHops, jsonOnly };
}

function main(): void {
  const { out, maxHops, jsonOnly } = parseArgs(process.argv.slice(2));
  const { result } = runAudit(ROOT, maxHops);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(result, null, 2));
  if (!jsonOnly) {
    fs.writeFileSync(path.join(out, 'report.md'), renderMarkdown(result));
  }
  const { byTier } = result.totals;
  console.log(`Doc-reachability audit → ${out}`);
  console.log(
    `  high: ${byTier.high.reachable}/${byTier.high.total} reachable (${byTier.high.overHops} over ${maxHops} hops) · ` +
    `medium: ${byTier.medium.reachable}/${byTier.medium.total} · low: ${byTier.low.reachable}/${byTier.low.total}`,
  );
  console.log(`  unreachable high-risk units: ${result.unreachableHighRisk.length}; stale code refs: ${result.staleCodeRefs.length}`);
}

// Run only when invoked directly (not when imported by tests).
if (require.main === module) {
  main();
}
