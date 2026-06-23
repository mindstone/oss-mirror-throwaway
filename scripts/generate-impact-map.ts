#!/usr/bin/env tsx
/**
 * Generates a static analysis impact map for use by review lenses and the
 * Static Analysis specialist.
 *
 * --- v1 fields (CHIEF_ENGINEER review lenses) ---
 * Stable output sections — existing consumers depend on these shapes:
 *   - reverseDeps:           module -> [modules that import it]
 *   - surfaceClassification: module -> core | main | renderer | cloud | mobile | shared | scripts
 *   - mockTargets:           mocked-module -> [test files that mock it]
 *   - switchDispatchSites:   files with switch on .type/.kind/.action/.status/.event
 *   - ipcRegistrations:      IPC handler registrations (registerHandler / ipcMain.handle / ...)
 *
 * --- v2 additions (CHIEF_ENGINEER2 Static Analysis specialist) ---
 * Strictly additive. See:
 *   coding-agent-instructions/workflows/CHIEF_ENGINEER2/specialists/static_analysis.md
 *
 *   - schemaVersion:                "2"
 *   - boundaries.ipc.channels[]:    handlers + invokes paired by channel name; orphans flagged
 *   - boundaries.discriminants[]:   case-label sites (where each "case 'foo':" appears)
 *
 * The boundary-checklist generator (scripts/generate-boundary-checklist.ts) reads
 * `boundaries` + a diff to produce a per-task BOUNDARY_CHECKLIST.md.
 *
 * Usage:
 *   npx tsx scripts/generate-impact-map.ts                  # default: writes .impact-map.json (v1 path)
 *   npx tsx scripts/generate-impact-map.ts --output <path>  # writes to <path> (e.g. generated/boundary-map.json)
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

interface SwitchSite {
  file: string;
  line: number;
  discriminant: string;
}

interface IpcRegistration {
  channel: string;
  handler: string;
  handlerLine: number;
}

// === V2 additions (CHIEF_ENGINEER2) — see header doc ===

interface IpcInvoke {
  channel: string;
  file: string;
  line: number;
}

interface IpcChannel {
  channel: string;
  handlers: Array<{ file: string; line: number }>;
  invokes: Array<{ file: string; line: number }>;
  orphan: 'no_handler' | 'no_invoke' | null;
}

interface DiscriminantLabelSite {
  label: string;
  file: string;
  line: number;
}

interface Boundaries {
  ipc: { channels: IpcChannel[] };
  discriminantLabels: DiscriminantLabelSite[];
}

// === End v2 additions ===

interface ImpactMap {
  _warnings: string[];
  schemaVersion: '2';
  generated: string;
  reverseDeps: Record<string, string[]>;
  surfaceClassification: Record<string, string>;
  mockTargets: Record<string, string[]>;
  switchDispatchSites: SwitchSite[];
  ipcRegistrations: IpcRegistration[];
  boundaries: Boundaries;
}

export function classifySurface(filePath: string): string {
  if (filePath.startsWith('src/core/')) return 'core';
  if (filePath.startsWith('src/main/')) return 'main';
  if (filePath.startsWith('src/renderer/')) return 'renderer';
  if (filePath.startsWith('src/shared/')) return 'shared';
  if (filePath.startsWith('src/preload/')) return 'preload';
  if (filePath.startsWith('cloud-service/')) return 'cloud';
  if (filePath.startsWith('cloud-client/')) return 'cloud-client';
  if (filePath.startsWith('mobile/')) return 'mobile';
  if (filePath.startsWith('scripts/')) return 'scripts';
  if (filePath.startsWith('evals/')) return 'evals';
  if (filePath.startsWith('packages/')) return 'packages';
  return 'other';
}

/**
 * Re-anchor a madge path to repo-relative.
 *
 * madge emits keys/deps RELATIVE TO the scanned `srcDir`, not the repo root:
 *   - intra-root deps are bare (`App.tsx` from `src/renderer`)
 *   - cross-root deps are `../`-prefixed (`../../cloud-client/x.ts` from `src/main`,
 *     `../cloud-client/x.ts` from `scripts`)
 * `normalize(join(srcDir, raw))` re-anchors intra-root paths AND collapses the
 * `../` on cross-root deps so both forms resolve to the same repo-relative key
 * (e.g. both → `cloud-client/x.ts`). A blind `srcDir`-prepend would be WRONG —
 * it would yield `src/main/../../cloud-client/x.ts`. Uses `path.posix` so output
 * is stable cross-platform and the `startsWith('src/...')` classifier matches on
 * Windows too. See docs/plans/260613_impact-map-completeness/PLAN.md (Stage 1 / DI-2).
 */
export function normalizeMadgeKey(rawPath: string, srcDir: string): string {
  const normalized = path.posix.normalize(path.posix.join(srcDir, rawPath));
  // Fail LOUD on a key that escapes the repo root (enough `../` segments to walk
  // above srcDir's parent). This should never happen for in-repo madge output;
  // if it does, a silently-wrong key would corrupt reverseDeps lookups. Warn
  // (non-fatal — this is a dev-tool generator) so the anomaly is visible rather
  // than producing a `../`-prefixed key nothing will ever match. (review GPT-final-F2)
  if (normalized.startsWith('../')) {
    console.warn(
      `[impact-map] WARNING: madge key escaped repo root — srcDir="${srcDir}" rawPath="${rawPath}" → "${normalized}". ` +
        `This key will not match repo-relative lookups; investigate the madge output for this root.`,
    );
  }
  return normalized;
}

export function parseMadgeToReverse(jsonStr: string, srcDir: string): Record<string, string[]> {
  const forwardDeps: Record<string, string[]> = JSON.parse(jsonStr);
  const reverse: Record<string, string[]> = {};
  for (const [rawMod, deps] of Object.entries(forwardDeps)) {
    const mod = normalizeMadgeKey(rawMod, srcDir);
    if (!reverse[mod]) reverse[mod] = [];
    for (const rawDep of deps) {
      const dep = normalizeMadgeKey(rawDep, srcDir);
      if (!reverse[dep]) reverse[dep] = [];
      if (!reverse[dep].includes(mod)) reverse[dep].push(mod);
    }
  }
  return reverse;
}

/**
 * Merge per-root reverse-dep maps by UNIONing importer arrays per key.
 *
 * Replaces the old flat object-spread merge (`{ ...mainReverse, ...coreReverse }`),
 * which was last-writer-wins: a module imported from multiple roots (e.g. a shared
 * dep with the same repo-relative key produced by two scans) had its importer list
 * CLOBBERED by the later spread, silently dropping edges (measured: 23% of edges).
 * This concatenates + dedupes instead, building fresh arrays (never mutating inputs).
 * See docs/plans/260613_impact-map-completeness/PLAN.md (Stage 1 / DI-2).
 */
export function mergeReverseDeps(...maps: Array<Record<string, string[]>>): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const map of maps) {
    for (const [key, importers] of Object.entries(map)) {
      if (!merged[key]) merged[key] = [];
      for (const importer of importers) {
        if (!merged[key].includes(importer)) merged[key].push(importer);
      }
    }
  }
  return merged;
}

function buildReverseDeps(tsconfig: string, srcDir: string): Record<string, string[]> {
  const tmpFile = path.join(ROOT, `.madge-tmp-${srcDir.replace(/\//g, '-')}.json`);
  const cmd = `npx madge --ts-config ${tsconfig} --extensions ts,tsx ${srcDir} --json --no-spinner > "${tmpFile}"`;
  try {
    execSync(cmd, {
      encoding: 'utf-8',
      maxBuffer: 200 * 1024 * 1024,
      cwd: ROOT,
      shell: '/bin/sh',
    });
    const output = fs.readFileSync(tmpFile, 'utf-8');
    fs.unlinkSync(tmpFile);
    return parseMadgeToReverse(output, srcDir);
  } catch (err: unknown) {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    if (fs.existsSync(tmpFile)) {
      try {
        const output = fs.readFileSync(tmpFile, 'utf-8');
        fs.unlinkSync(tmpFile);
        return parseMadgeToReverse(output, srcDir);
      } catch { /* ignore */ }
    }
    const execErr = err as { stderr?: string };
    console.warn(`Warning: madge failed for ${srcDir}, skipping: ${execErr.stderr || ''}`);
    return {};
  }
}

function buildMockTargets(): Record<string, string[]> {
  const mockTargets: Record<string, string[]> = {};

  try {
    const mockTmpFile = path.join(ROOT, '.madge-tmp-mocks.txt');
    // Use grep -r as a reliable fallback; rg escaping is fragile in tsx context
    execSync(
      `grep -rn --include='*.ts' --include='*.tsx' -E '(vi|jest)\\.mock\\(' . > "${mockTmpFile}" 2>/dev/null || true`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, cwd: ROOT, shell: '/bin/sh' },
    );
    const output = fs.readFileSync(mockTmpFile, 'utf-8');
    fs.unlinkSync(mockTmpFile);

    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      const fileMatch = line.match(/^\.\/([^:]+):\d+:/);
      const mockMatch = line.match(/(?:vi|jest)\.mock\(['"]([^'"]+)['"]/);
      if (fileMatch && mockMatch) {
        const testFile = fileMatch[1];
        const mockedModule = mockMatch[1];
        if (!mockTargets[mockedModule]) mockTargets[mockedModule] = [];
        if (!mockTargets[mockedModule].includes(testFile)) {
          mockTargets[mockedModule].push(testFile);
        }
      }
    }
  } catch {
    const mockTmpFile = path.join(ROOT, '.madge-tmp-mocks.txt');
    try { fs.unlinkSync(mockTmpFile); } catch { /* ignore */ }
    console.warn('Warning: mock target scan failed or found no results');
  }

  return mockTargets;
}

function buildSwitchDispatchSites(): SwitchSite[] {
  const sites: SwitchSite[] = [];
  try {
    const tmpFile = path.join(ROOT, '.madge-tmp-switches.txt');
    // Match switch statements on discriminant properties (.type, .kind, .action, .status, .event)
    execSync(
      `grep -rn --include='*.ts' --include='*.tsx' -E 'switch\\s*\\(\\S+\\.(type|kind|action|status|event)\\)' src/ > "${tmpFile}" 2>/dev/null || true`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, cwd: ROOT, shell: '/bin/sh' },
    );
    const output = fs.readFileSync(tmpFile, 'utf-8');
    fs.unlinkSync(tmpFile);

    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      const match = line.match(/^([^:]+):(\d+):.*switch\s*\(\S+\.(type|kind|action|status|event)\)/);
      if (match) {
        sites.push({ file: match[1], line: parseInt(match[2], 10), discriminant: match[3] });
      }
    }
  } catch {
    console.warn('Warning: switch dispatch site scan failed');
  }
  return sites;
}

function buildIpcRegistrations(): IpcRegistration[] {
  const registrations: IpcRegistration[] = [];
  try {
    const tmpFile = path.join(ROOT, '.madge-tmp-ipc.txt');
    // Match handler registrations: registerHandler('channel-name', ...) and handlerRegistry.register('channel-name', ...)
    execSync(
      `grep -rn --include='*.ts' -E "(registerHandler|handlerRegistry\\.register|ipcMain\\.handle)\\s*\\(" src/main/ > "${tmpFile}" 2>/dev/null || true`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, cwd: ROOT, shell: '/bin/sh' },
    );
    const output = fs.readFileSync(tmpFile, 'utf-8');
    fs.unlinkSync(tmpFile);

    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      const fileMatch = line.match(/^([^:]+):(\d+):/);
      const channelMatch = line.match(/(?:registerHandler|register|handle)\s*\(\s*['"]([^'"]+)['"]/);
      if (fileMatch && channelMatch) {
        registrations.push({
          channel: channelMatch[1],
          handler: fileMatch[1],
          handlerLine: parseInt(fileMatch[2], 10),
        });
      }
    }
  } catch {
    console.warn('Warning: IPC registration scan failed');
  }
  return registrations;
}

// === V2 additions (CHIEF_ENGINEER2) — see header doc ===

function buildIpcInvokes(): IpcInvoke[] {
  const invokes: IpcInvoke[] = [];
  try {
    const tmpFile = path.join(ROOT, '.madge-tmp-ipc-invokes.txt');
    // Capture `.invoke('channel', ...)` and `.invoke("channel", ...)` patterns —
    // generously covers ipcRenderer.invoke / bridge.invoke / ipc.invoke / etc.
    // Scans renderer + cloud-client + mobile + shared (where invokes typically live);
    // skipping src/main/ keeps us from collecting same-process method calls.
    execSync(
      `grep -rn --include='*.ts' --include='*.tsx' -E "\\.invoke\\s*\\(\\s*['\\\"][^'\\\"]+['\\\"]" src/renderer/ src/shared/ src/preload/ cloud-client/ mobile/ > "${tmpFile}" 2>/dev/null || true`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, cwd: ROOT, shell: '/bin/sh' },
    );
    const output = fs.readFileSync(tmpFile, 'utf-8');
    fs.unlinkSync(tmpFile);

    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      const fileMatch = line.match(/^([^:]+):(\d+):/);
      const channelMatch = line.match(/\.invoke\s*\(\s*['"]([^'"]+)['"]/);
      if (fileMatch && channelMatch) {
        invokes.push({
          channel: channelMatch[1],
          file: fileMatch[1],
          line: parseInt(fileMatch[2], 10),
        });
      }
    }
  } catch {
    console.warn('Warning: IPC invoke scan failed');
  }
  return invokes;
}

function reconcileIpcChannels(
  registrations: IpcRegistration[],
  invokes: IpcInvoke[],
): IpcChannel[] {
  const map = new Map<string, IpcChannel>();
  const ensure = (channel: string): IpcChannel => {
    let entry = map.get(channel);
    if (!entry) {
      entry = { channel, handlers: [], invokes: [], orphan: null };
      map.set(channel, entry);
    }
    return entry;
  };
  for (const r of registrations) {
    ensure(r.channel).handlers.push({ file: r.handler, line: r.handlerLine });
  }
  for (const i of invokes) {
    ensure(i.channel).invokes.push({ file: i.file, line: i.line });
  }
  for (const entry of map.values()) {
    if (entry.handlers.length === 0) entry.orphan = 'no_handler';
    else if (entry.invokes.length === 0) entry.orphan = 'no_invoke';
  }
  return Array.from(map.values()).sort((a, b) => a.channel.localeCompare(b.channel));
}

function buildDiscriminantLabels(): DiscriminantLabelSite[] {
  const sites: DiscriminantLabelSite[] = [];
  try {
    const tmpFile = path.join(ROOT, '.madge-tmp-discriminant-labels.txt');
    // Matches `case 'foo':` and `case "foo":` (allowing word-chars, dots, dashes, underscores).
    execSync(
      `grep -rn --include='*.ts' --include='*.tsx' -E "case\\s+['\\\"][A-Za-z_][A-Za-z0-9_.-]*['\\\"]\\s*:" src/ cloud-service/ cloud-client/ mobile/ > "${tmpFile}" 2>/dev/null || true`,
      { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024, cwd: ROOT, shell: '/bin/sh' },
    );
    const output = fs.readFileSync(tmpFile, 'utf-8');
    fs.unlinkSync(tmpFile);

    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      const match = line.match(/^([^:]+):(\d+):.*case\s+['"]([A-Za-z_][A-Za-z0-9_.-]*)['"]/);
      if (match) {
        sites.push({ label: match[3], file: match[1], line: parseInt(match[2], 10) });
      }
    }
  } catch {
    console.warn('Warning: discriminant label scan failed');
  }
  return sites;
}

// === End v2 additions ===

function main(): void {
  console.log('Generating impact map...');

  console.log('  Building reverse dependencies (renderer)...');
  const rendererReverse = buildReverseDeps('tsconfig.renderer.json', 'src/renderer');

  console.log('  Building reverse dependencies (main)...');
  const mainReverse = buildReverseDeps('tsconfig.node.json', 'src/main');

  console.log('  Building reverse dependencies (core)...');
  const coreReverse = buildReverseDeps('tsconfig.node.json', 'src/core');

  console.log('  Building reverse dependencies (shared)...');
  const sharedReverse = buildReverseDeps('tsconfig.node.json', 'src/shared');

  console.log('  Building reverse dependencies (scripts)...');
  const scriptsReverse = buildReverseDeps('tsconfig.scripts.json', 'scripts');

  console.log('  Scanning mock targets...');
  const mockTargets = buildMockTargets();

  console.log('  Scanning switch/dispatch sites...');
  const switchDispatchSites = buildSwitchDispatchSites();

  console.log('  Scanning IPC registrations...');
  const ipcRegistrations = buildIpcRegistrations();

  // V2 scans (additive — CHIEF_ENGINEER2 Static Analysis specialist).
  console.log('  [v2] Scanning IPC invokes...');
  const ipcInvokes = buildIpcInvokes();

  console.log('  [v2] Scanning discriminant labels (case "foo")...');
  const discriminantLabels = buildDiscriminantLabels();

  const ipcChannels = reconcileIpcChannels(ipcRegistrations, ipcInvokes);

  const reverseDeps = mergeReverseDeps(mainReverse, coreReverse, sharedReverse, rendererReverse, scriptsReverse);

  const surfaceClassification: Record<string, string> = {};
  for (const mod of Object.keys(reverseDeps)) {
    surfaceClassification[mod] = classifySurface(mod);
  }

  const impactMap: ImpactMap = {
    _warnings: [
      'COVERAGE LIMITATIONS — This map is NOT exhaustive. Review lenses must supplement with manual investigation.',
      'COVERED: Static TypeScript imports (reverseDeps) across src/{renderer,main,core,shared} and scripts/, vi.mock/jest.mock sites (mockTargets), switch-on-discriminant sites (switchDispatchSites), IPC handler registrations (ipcRegistrations).',
      'NOT COVERED: Stringly-typed config/feature-flag lookups, runtime-only dependencies (dynamic import(), require()), event emitter channels (emit/on by string name), plugin registrations, cloud channel policy sync (see src/shared/cloudChannelPolicies.ts), switch statements on non-property discriminants (e.g. switch(action)), string-keyed registry maps.',
      'RULE OF THUMB: If the changed code defines a contract consumed by string matching (not by import), this map will miss those consumers. Grep manually.',
      'V2 (boundaries.*) ADDITIONAL CAVEATS: ipc.channels orphan flagging is grep-based — typed proxies (e.g. window.api.foo) are NOT scanned as invokes, so a channel with only typed-proxy callers will appear orphaned. discriminantLabels collects case labels textually; correlate to discriminant via switchDispatchSites manually.',
    ],
    schemaVersion: '2',
    generated: new Date().toISOString(),
    reverseDeps,
    surfaceClassification,
    mockTargets,
    switchDispatchSites,
    ipcRegistrations,
    boundaries: {
      ipc: { channels: ipcChannels },
      discriminantLabels,
    },
  };

  // CLI: --output <path> writes to a custom path (e.g. generated/boundary-map.json for CE2).
  // Default keeps v1 behaviour: write to .impact-map.json at repo root.
  const args = process.argv.slice(2);
  const outputIdx = args.indexOf('--output');
  const customOutput = outputIdx >= 0 && args[outputIdx + 1] ? args[outputIdx + 1] : null;
  const outputPath = customOutput ? path.resolve(ROOT, customOutput) : path.join(ROOT, '.impact-map.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(impactMap, null, 2));

  const modCount = Object.keys(reverseDeps).length;
  const mockCount = Object.keys(mockTargets).length;
  const switchCount = switchDispatchSites.length;
  const ipcCount = ipcRegistrations.length;
  const orphanHandlerCount = ipcChannels.filter((c) => c.orphan === 'no_invoke').length;
  const orphanInvokeCount = ipcChannels.filter((c) => c.orphan === 'no_handler').length;
  const labelUnique = new Set(discriminantLabels.map((d) => d.label)).size;
  console.log(`\nImpact map generated: ${outputPath}`);
  console.log(`  ${modCount} modules with reverse dependencies`);
  console.log(`  ${mockCount} mock targets tracked`);
  console.log(`  ${switchCount} switch/dispatch sites found`);
  console.log(`  ${ipcCount} IPC handler registrations found`);
  console.log(`  [v2] ${ipcChannels.length} IPC channels (${orphanHandlerCount} handler-without-invoke, ${orphanInvokeCount} invoke-without-handler)`);
  console.log(`  [v2] ${discriminantLabels.length} discriminant case-label sites (${labelUnique} unique labels)`);
}

// Only run the (madge-invoking) generation when executed as a CLI, not when the
// pure helpers above are imported by a unit test. `require.main === module` is the
// CJS idiom; this file already relies on CJS (`__dirname`, line 33) under tsx.
if (require.main === module) {
  main();
}
