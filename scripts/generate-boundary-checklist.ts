#!/usr/bin/env tsx
/**
 * Generates BOUNDARY_CHECKLIST.md for a Chief Engineer v2 planning folder.
 *
 * Consumes the v2 `boundaries` section of `generated/boundary-map.json` (produced
 * by `scripts/generate-impact-map.ts --output ...`) and the current diff, then
 * emits a per-task checklist of boundary items touched by the change.
 *
 * Companion: coding-agent-instructions/workflows/CHIEF_ENGINEER2/specialists/static_analysis.md
 * Schema:    coding-agent-instructions/workflows/CHIEF_ENGINEER2/schemas/boundary-checklist.ts
 *
 * Re-runnable: existing non-pending annotations (`addressed`, `out-of-scope`,
 * `uncertain`) are preserved on items still present in the new generation; new
 * items appear as `pending`.
 *
 * Usage:
 *   npx tsx scripts/generate-boundary-checklist.ts <planning-folder>
 *   npx tsx scripts/generate-boundary-checklist.ts <planning-folder> --diff <range>
 *   npx tsx scripts/generate-boundary-checklist.ts <planning-folder> --map <path>
 *
 * Defaults:
 *   --diff   compares HEAD..(working-tree + untracked)
 *   --map    <planning-folder>/generated/boundary-map.json
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_GIT_MAXBUFFER } from './lib/git-exec.js';

const ROOT = path.resolve(__dirname, '..');

interface IpcChannelEntry {
  channel: string;
  handlers: Array<{ file: string; line: number }>;
  invokes: Array<{ file: string; line: number }>;
  orphan: 'no_handler' | 'no_invoke' | null;
}

interface DiscriminantLabelEntry {
  label: string;
  file: string;
  line: number;
}

interface BoundaryMap {
  schemaVersion?: string;
  boundaries?: {
    ipc?: { channels: IpcChannelEntry[] };
    discriminantLabels?: DiscriminantLabelEntry[];
  };
  /** module (repo-relative) -> [modules that statically import it]. See generate-impact-map.ts. */
  reverseDeps?: Record<string, string[]>;
  /** module (repo-relative) -> broad surface (core/main/renderer/shared/scripts/...). */
  surfaceClassification?: Record<string, string>;
}

type ItemState = 'pending' | 'addressed' | 'out-of-scope' | 'uncertain';

interface ChecklistItem {
  id: string;
  category: 'ipc' | 'case-label' | 'reverse-dep';
  label: string;
  details: string[];
  state: ItemState;
  rationale?: string;
}

/**
 * Threshold above which a changed file's importer list is COLLAPSED to a
 * count + per-surface summary instead of listed in full. Chosen at 20 (Decision
 * Log 2026-06-13 12:25): fully covers the 2–20-importer "shared-helper sweet
 * spot" where the cross-consumer regression class lives, while collapsing only
 * the ~5% of modules (barrels / loggers / `types.ts`) whose hundreds of
 * importers would otherwise train reviewers to ignore the section.
 */
const REVERSE_DEP_LIST_CAP = 20;

/**
 * Build the "Direct static importers" checklist items from the reverse-dep map.
 *
 * Pure function (no git / madge / filesystem) so it is unit-testable against a
 * synthetic map + changed-file set. See
 * `scripts/__tests__/boundary-checklist-reverse-deps.test.ts`.
 *
 * Design (LOCKED — see docs/plans/260613_impact-map-completeness/PLAN.md
 * Decision Log 2026-06-13 12:25):
 *  - **Completeness = 1-hop static importers.** We list every importer madge
 *    found in `reverseDeps[changedFile]`. This does NOT cover transitive,
 *    dynamic-import, `require()`, string-registry, or exported-symbol-semantic
 *    consumers — matching the NOT-COVERED note the impact map emits. Documented
 *    here and in the rendered advisory header so reviewers don't over-trust it.
 *  - **Threshold:** fan-in ≤ REVERSE_DEP_LIST_CAP → list ALL importers (each
 *    with its surface); fan-in > cap → COLLAPSE to count + per-surface
 *    breakdown + a pointer to `reverseDeps[...]` in the map (no full dump), so
 *    barrels/loggers stay quiet.
 *  - **Cross-boundary = PRIORITY signal, NOT an inclusion filter (GPT-F1).** The
 *    regression class can cross a boundary while staying in the same broad
 *    surface (the motivating case was `scripts/check-eslint-new-warnings.ts` →
 *    `scripts/lib/knip-diff-guard.ts`, both `scripts`). So we list ALL
 *    low-fan-in importers regardless of surface, and only mark an item
 *    HIGH-PRIORITY when fan-in ≤ cap AND ≥1 importer sits in a different
 *    surface. Same-surface importers are never dropped.
 *  - **Co-changed importers** (themselves in the changed set) are annotated
 *    "already in diff" and don't drive priority — they're under review already.
 *  - **0 importers → no item** (the ~47%-of-files quiet-by-design case).
 *  - Advisory: emitted as normal pending checklist items the reviewer
 *    dispositions; NOT a CI-blocking gate.
 */
export function buildReverseDepItems(
  changedFiles: Set<string>,
  reverseDeps: Record<string, string[]>,
  surfaceClassification: Record<string, string>,
): ChecklistItem[] {
  const surfaceOf = (file: string): string => surfaceClassification[file] ?? 'other';
  const result: ChecklistItem[] = [];

  // Deterministic order: iterate changed files sorted, so output is stable.
  for (const changedFile of [...changedFiles].sort()) {
    const importers = reverseDeps[changedFile];
    if (!importers || importers.length === 0) continue; // quiet-by-design

    const changedSurface = surfaceOf(changedFile);
    // Stable importer order for reproducible checklists.
    const sortedImporters = [...importers].sort();
    const fanIn = sortedImporters.length;

    if (fanIn > REVERSE_DEP_LIST_CAP) {
      // COLLAPSE: count + per-surface breakdown + pointer. No full dump.
      const perSurface = new Map<string, number>();
      for (const imp of sortedImporters) {
        const s = surfaceOf(imp);
        perSurface.set(s, (perSurface.get(s) ?? 0) + 1);
      }
      const breakdown = [...perSurface.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([s, n]) => `${s} ${n}`)
        .join(', ');
      result.push({
        id: `revdep:${changedFile}`,
        category: 'reverse-dep',
        label: `\`${changedFile}\` — ${fanIn} direct static importers (high fan-in, collapsed)`,
        details: [
          `Surface: ${changedSurface}`,
          `Importer surfaces: ${breakdown}`,
          `Full list: see boundary-map.json reverseDeps["${changedFile}"]`,
          'Priority: info (high fan-in — collapsed so barrels/loggers stay quiet).',
        ],
        state: 'pending',
      });
      continue;
    }

    // LIST ALL: low fan-in. Mark each importer's surface; note co-changed ones.
    let hasCrossBoundary = false;
    const importerLines = sortedImporters.map((imp) => {
      const impSurface = surfaceOf(imp);
      if (impSurface !== changedSurface) hasCrossBoundary = true;
      const coChanged = changedFiles.has(imp) ? ' — already in diff' : '';
      return `${imp} (${impSurface})${coChanged}`;
    });
    const priorityNote = hasCrossBoundary
      ? 'Priority: high — low fan-in with ≥1 cross-boundary importer.'
      : 'Priority: medium — low fan-in, same surface only.';
    result.push({
      id: `revdep:${changedFile}`,
      category: 'reverse-dep',
      label: `\`${changedFile}\` — ${fanIn} direct static importer${fanIn === 1 ? '' : 's'}${hasCrossBoundary ? ' (cross-boundary)' : ''}`,
      details: [
        `Surface: ${changedSurface}`,
        priorityNote,
        `Importers: ${importerLines.join('; ')}`,
      ],
      state: 'pending',
    });
  }

  return result;
}

// ---- CLI ----
// Wrapped in main()/require.main so importing this module for unit tests (which
// only need the pure `buildReverseDepItems` above) does NOT execute the CLI
// side-effects (argv parsing, process.exit, git/madge shell-outs, file writes).
// Mirrors the idiom Stage 1 added in generate-impact-map.ts.
function main(): void {
const args = process.argv.slice(2);
function getOpt(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}

const folder = args.find((a) => !a.startsWith('--'));
if (!folder) {
  console.error('Usage: generate-boundary-checklist.ts <planning-folder> [--diff <range>] [--map <path>]');
  process.exit(2);
}
if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
  console.error(`Not a directory: ${folder}`);
  process.exit(2);
}

const diffRange = getOpt('--diff');
const mapPath = getOpt('--map') ?? path.join(folder, 'generated', 'boundary-map.json');

// ---- Load boundary map ----
if (!fs.existsSync(mapPath)) {
  console.error(`Boundary map not found: ${mapPath}`);
  console.error(`Hint: generate one with`);
  console.error(`  npx tsx scripts/generate-impact-map.ts --output "${mapPath}"`);
  process.exit(1);
}
const map: BoundaryMap = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
if (map.schemaVersion !== '2' || !map.boundaries) {
  console.error(`Map at ${mapPath} is missing v2 boundaries (schemaVersion=${map.schemaVersion ?? '<none>'}).`);
  console.error('Regenerate with the current scripts/generate-impact-map.ts.');
  process.exit(1);
}

// ---- Determine changed files ----
function getChangedFiles(): Set<string> {
  let cmd: string;
  if (diffRange) {
    cmd = `git diff --name-only ${diffRange}`;
  } else {
    // HEAD vs working tree + untracked non-ignored files.
    cmd = "git diff --name-only HEAD; git ls-files --others --exclude-standard";
  }
  // `cmd` is an assembled compound shell command (it may contain `git ls-files`
  // / `git diff`, both repo-size-unbounded), so the guard can't see it — bound
  // it here with the shared maxBuffer policy.
  // git-exec-allow: assembled compound git command bounded by DEFAULT_GIT_MAXBUFFER
  const out = execSync(cmd, {
    encoding: 'utf-8',
    cwd: ROOT,
    shell: '/bin/sh',
    maxBuffer: DEFAULT_GIT_MAXBUFFER,
  });
  return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
}
const changed = getChangedFiles();

// ---- Build items ----
const items: ChecklistItem[] = [];

for (const ch of map.boundaries.ipc?.channels ?? []) {
  const touches =
    ch.handlers.some((h) => changed.has(h.file)) || ch.invokes.some((i) => changed.has(i.file));
  if (!touches) continue;
  const details: string[] = [
    ch.handlers.length
      ? `Handlers: ${ch.handlers.map((h) => `${h.file}:${h.line}`).join(', ')}`
      : 'Handlers: (none)',
    ch.invokes.length
      ? `Invokes: ${ch.invokes.map((i) => `${i.file}:${i.line}`).join(', ')}`
      : 'Invokes: (none)',
  ];
  if (ch.orphan) details.push(`Orphan: ${ch.orphan} (grep-based — typed proxies are not scanned)`);
  items.push({
    id: `ipc:${ch.channel}`,
    category: 'ipc',
    label: `IPC channel \`${ch.channel}\``,
    details,
    state: 'pending',
  });
}

// Group case-label sites by label, then keep labels with at least one site in a changed file.
const labelSites = new Map<string, Array<{ file: string; line: number }>>();
for (const site of map.boundaries.discriminantLabels ?? []) {
  if (!labelSites.has(site.label)) labelSites.set(site.label, []);
  labelSites.get(site.label)!.push({ file: site.file, line: site.line });
}
for (const [label, sites] of labelSites) {
  if (!sites.some((s) => changed.has(s.file))) continue;
  items.push({
    id: `case:${label}`,
    category: 'case-label',
    label: `Discriminant case \`${label}\``,
    details: [`Sites: ${sites.map((s) => `${s.file}:${s.line}`).join(', ')}`],
    state: 'pending',
  });
}

// Direct static importers (reverse-dep) — advisory; see buildReverseDepItems().
const revdepItems = buildReverseDepItems(
  changed,
  map.reverseDeps ?? {},
  map.surfaceClassification ?? {},
);
items.push(...revdepItems);

items.sort((a, b) => a.id.localeCompare(b.id));

// ---- Preserve states from existing checklist ----
const checklistPath = path.join(folder, 'BOUNDARY_CHECKLIST.md');
const preserved = new Map<string, { state: ItemState; rationale?: string }>();
const STATE_RE = /Status:\s+(pending|addressed|out-of-scope|uncertain)(?:\s*\(([^)]*)\))?/;
if (fs.existsSync(checklistPath)) {
  const existing = fs.readFileSync(checklistPath, 'utf-8');
  const lines = existing.split('\n');
  let currentId: string | null = null;
  for (const line of lines) {
    const idMatch = line.match(/^-\s+\[[ x]\]\s+`([^`]+)`/);
    if (idMatch) {
      currentId = idMatch[1];
      continue;
    }
    if (!currentId) continue;
    const stateMatch = line.match(STATE_RE);
    if (stateMatch) {
      const state = stateMatch[1] as ItemState;
      if (state !== 'pending') {
        preserved.set(currentId, { state, rationale: stateMatch[2] });
      }
      currentId = null;
    }
  }
}

let preservedApplied = 0;
for (const item of items) {
  const p = preserved.get(item.id);
  if (p) {
    item.state = p.state;
    item.rationale = p.rationale;
    preservedApplied++;
  }
}

// ---- Render markdown ----
function renderItem(item: ChecklistItem): string {
  const checkbox = item.state === 'pending' ? '[ ]' : '[x]';
  const status = item.rationale ? `${item.state} (${item.rationale})` : item.state;
  const detailLines = item.details.map((d) => `  - ${d}`).join('\n');
  return `- ${checkbox} \`${item.id}\` — ${item.label}\n${detailLines}\n  - Status: ${status}`;
}

const ipcItems = items.filter((i) => i.category === 'ipc');
const caseItems = items.filter((i) => i.category === 'case-label');
const revdepRendered = items.filter((i) => i.category === 'reverse-dep');

const sections: string[] = [];
sections.push(
  '## IPC channels\n\n' +
    (ipcItems.length === 0
      ? '_(none touched in this diff)_'
      : ipcItems.map(renderItem).join('\n')),
);
sections.push(
  '## Discriminant case labels\n\n' +
    (caseItems.length === 0
      ? '_(none touched in this diff)_'
      : caseItems.map(renderItem).join('\n')),
);
sections.push(
  '## Direct static importers\n\n' +
    '> For each changed file, its **1-hop static TypeScript importers** (from the impact map\'s `reverseDeps`). ' +
    'Changed a shared symbol → confirm each importer\'s contract still holds. ' +
    '`high` = low fan-in with a cross-boundary importer; `medium` = low fan-in, same surface; high-fan-in modules are collapsed to a count + pointer. ' +
    'NOT COVERED: transitive, dynamic-import, `require()`, string-registry, or exported-symbol-semantic consumers — treat as advisory, not exhaustive.\n\n' +
    (revdepRendered.length === 0
      ? '_(no changed file has static importers in the map)_'
      : revdepRendered.map(renderItem).join('\n')),
);

const relMap = path.relative(folder, mapPath);
const header = `# Boundary Checklist

> Auto-generated by \`scripts/generate-boundary-checklist.ts\`. See [\`coding-agent-instructions/workflows/CHIEF_ENGINEER2/specialists/static_analysis.md\`](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/specialists/static_analysis.md) for lifecycle and item states.
>
> Re-run preserves non-pending annotations on items still present; new items appear as \`pending\`.

\`\`\`
generated_at: ${new Date().toISOString()}
map:          ${relMap}
diff:         ${diffRange ?? 'HEAD..(working-tree + untracked)'}
items:        ${items.length}
generator:    scripts/generate-boundary-checklist.ts v1
\`\`\`

**States:** \`pending\` → \`addressed\` | \`out-of-scope (<reason>)\` | \`uncertain (<question>)\`. Update the \`Status:\` line on each item; tick the checkbox when non-pending.

`;

fs.writeFileSync(checklistPath, header + sections.join('\n\n') + '\n');

const pendingCount = items.filter((i) => i.state === 'pending').length;
console.log(`Wrote ${checklistPath}`);
console.log(
  `  ${items.length} items total (${ipcItems.length} ipc, ${caseItems.length} case-labels, ${revdepRendered.length} reverse-dep)`,
);
console.log(`  ${pendingCount} pending, ${preservedApplied} preserved from prior generation`);
console.log(`  ${changed.size} changed files in scope`);
}

if (require.main === module) {
  main();
}
