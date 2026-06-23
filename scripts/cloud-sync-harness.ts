#!/usr/bin/env -S node --import tsx
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { CloudManifest, PushResult } from '@main/services/cloud/cloudWorkspaceSync';
import { bootstrapDesktopPlatform } from '../src/test-utils/cloudHarness/bootstrapDesktopPlatform';
import { DriveSim, type DriveMount } from '../src/test-utils/cloudHarness/driveSim';
import {
  startLocalCloudService,
  type LocalCloudService,
} from '../src/test-utils/cloudHarness/localCloudServiceFixture';
import { createSyncMachine, type SyncMachine } from '../src/test-utils/cloudHarness/syncMachine';
import {
  DRIVE_SETTLE_FORCE_CYCLES,
  MANIFEST_REL_PATH,
  fetchCloudManifest,
  readTextIfExists,
} from '../src/test-utils/cloudHarness/harnessHelpers';

type ScenarioName = 'file-conflict' | 'folder-conflict' | 'concurrent-edit';
type PrintMode = 'tree' | 'cloud-manifest' | 'machine-state' | 'all';

interface CliOptions {
  scenario: ScenarioName;
  printMode: PrintMode;
  step: boolean;
  keep: boolean;
  port?: number;
}

interface HarnessContext {
  opts: CliOptions;
  cloud: LocalCloudService;
  driveRoot: string;
  drive: DriveSim;
  mountA: DriveMount;
  mountB: DriveMount;
  a: SyncMachine;
  b: SyncMachine;
}

interface ScenarioReport {
  title: string;
  summaryLines: string[];
}

bootstrapDesktopPlatform();

function parseCliOptions(): CliOptions {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string', default: 'file-conflict' },
      print: { type: 'string', default: 'all' },
      step: { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      port: { type: 'string' },
    },
    allowPositionals: false,
  });

  const scenario = values.scenario;
  if (!isScenarioName(scenario)) {
    throw new Error(`Invalid --scenario "${String(scenario)}"; expected file-conflict, folder-conflict, or concurrent-edit`);
  }

  const printMode = values.print;
  if (!isPrintMode(printMode)) {
    throw new Error(`Invalid --print "${String(printMode)}"; expected tree, cloud-manifest, machine-state, or all`);
  }

  const port = parsePort(values.port);

  return {
    scenario,
    printMode,
    step: Boolean(values.step),
    keep: Boolean(values.keep),
    ...(port === undefined ? {} : { port }),
  };
}

function isScenarioName(value: unknown): value is ScenarioName {
  return value === 'file-conflict' || value === 'folder-conflict' || value === 'concurrent-edit';
}

function isPrintMode(value: unknown): value is PrintMode {
  return value === 'tree' || value === 'cloud-manifest' || value === 'machine-state' || value === 'all';
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid --port "${value}"; expected an integer from 1 to 65535`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid --port "${value}"; expected an integer from 1 to 65535`);
  }
  return port;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return false;
    throw err;
  }
}

function isErrno(err: unknown, code: string): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === code);
}

function sortedManifestEntries(manifest: CloudManifest): Record<string, { hash: string; size: number }> {
  return Object.fromEntries(
    Object.entries(manifest.entries).sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function createHarness(opts: CliOptions): Promise<HarnessContext> {
  let cloud: LocalCloudService | null = null;
  let driveRoot: string | null = null;
  let a: SyncMachine | null = null;
  let b: SyncMachine | null = null;

  try {
    cloud = await startLocalCloudService({
      keepData: opts.keep,
      ...(opts.port === undefined ? {} : { port: opts.port }),
    });
    driveRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'rebel-cloud-sync-drive-'));
    const drive = await DriveSim.create({ rootDir: driveRoot });
    const mountA = await drive.mount('A');
    const mountB = await drive.mount('B');
    a = await createSyncMachine({ name: 'A', cloud, workspaceDir: mountA.dir });
    b = await createSyncMachine({ name: 'B', cloud, workspaceDir: mountB.dir });

    return { opts, cloud, driveRoot, drive, mountA, mountB, a, b };
  } catch (err) {
    a?.sync._resetForTesting();
    b?.sync._resetForTesting();
    await cloud?.cleanup();

    if (!opts.keep) {
      await Promise.all([
        a ? fsp.rm(a.dataDir, { recursive: true, force: true }) : Promise.resolve(),
        b ? fsp.rm(b.dataDir, { recursive: true, force: true }) : Promise.resolve(),
        driveRoot ? fsp.rm(driveRoot, { recursive: true, force: true }) : Promise.resolve(),
      ]);
    }

    throw err;
  }
}

function printHeader(ctx: HarnessContext): void {
  console.log('[cloud-sync-harness] local cloud-sync harness');
  console.log(`[cloud-sync-harness] scenario=${ctx.opts.scenario}`);
  console.log(`[cloud-sync-harness] cloud baseUrl=${ctx.cloud.baseUrl}`);
  console.log(`[cloud-sync-harness] cloud dataDir=${ctx.cloud.dataDir}`);
  console.log(`[cloud-sync-harness] cloud workspaceDir=${ctx.cloud.workspaceDir}`);
  console.log(`[cloud-sync-harness] A workspace=${ctx.a.workspaceDir}`);
  console.log(`[cloud-sync-harness] A dataDir=${ctx.a.dataDir}`);
  console.log(`[cloud-sync-harness] B workspace=${ctx.b.workspaceDir}`);
  console.log(`[cloud-sync-harness] B dataDir=${ctx.b.dataDir}`);
}

async function establishBaseline(ctx: HarnessContext, rel: string, content: string): Promise<void> {
  await ctx.drive.seedFile(rel, content);
  await stepSnapshot(ctx, `seed ${rel}`);

  await ctx.drive.settle({ to: ['A', 'B'] });
  await stepSnapshot(ctx, 'settle baseline to A/B');

  await forceSync(ctx, ctx.a, 'A baseline push');

  await forceSyncCycles(ctx, ctx.b, 'B baseline pull', async () => {
    const contentOnB = await readTextIfExists(path.join(ctx.b.workspaceDir, rel));
    return contentOnB === content;
  });
}

async function forceSync(ctx: HarnessContext, machine: SyncMachine, label: string): Promise<PushResult> {
  const result = await machine.sync.forceSync(machine.client, machine.workspaceDir);
  console.log(`[cloud-sync-harness] ${label}: ${formatPushResult(result)}`);
  await stepSnapshot(ctx, label);
  return result;
}

async function forceSyncCycles(
  ctx: HarnessContext,
  machine: SyncMachine,
  label: string,
  predicate?: () => Promise<boolean>,
): Promise<boolean> {
  let matched = false;
  for (let cycle = 1; cycle <= DRIVE_SETTLE_FORCE_CYCLES; cycle += 1) {
    const result = await machine.sync.forceSync(machine.client, machine.workspaceDir);
    matched = predicate ? await predicate() : false;
    console.log(
      `[cloud-sync-harness] ${label} cycle ${cycle}/${DRIVE_SETTLE_FORCE_CYCLES}: ${formatPushResult(result)}${predicate ? `; ${matched ? 'landed' : 'pending'}` : ''}`,
    );
    await stepSnapshot(ctx, `${label} cycle ${cycle}`);
    if (matched) break;
  }
  return matched;
}

function formatPushResult(result: PushResult): string {
  const aborted = result.aborted === undefined ? '' : ` aborted=${result.aborted}`;
  return `pushed=${result.pushed} skipped=${result.skipped} failed=${result.failed}${aborted}`;
}

async function runFileConflict(ctx: HarnessContext): Promise<ScenarioReport> {
  const originalRel = 'memory/topics/foo.md';
  const conflictRel = 'memory/topics/foo (1).md';

  console.log('[cloud-sync-harness] REBEL-62A negative control: generated file conflict copies should stay local');
  await establishBaseline(ctx, originalRel, 'baseline');

  ctx.drive.concurrent([
    { mount: 'A', rel: originalRel, content: 'from A' },
    { mount: 'B', rel: originalRel, content: 'from B' },
  ]);
  await stepSnapshot(ctx, 'concurrent divergent file writes');

  await ctx.drive.settle({ to: ['A'] });
  await stepSnapshot(ctx, 'settle divergent file window to A');

  await forceSync(ctx, ctx.a, 'A push after file conflict');
  await forceSyncCycles(ctx, ctx.b, 'B pull after file conflict');

  const cloudManifest = await fetchCloudManifest(ctx.a);
  const cloudHasConflict = Object.hasOwn(cloudManifest.entries, conflictRel);
  const bHasConflict = await pathExists(path.join(ctx.b.workspaceDir, conflictRel));

  return {
    title: 'REBEL-62A negative control',
    summaryLines: [
      `${conflictRel} reached cloud: ${yesNo(cloudHasConflict)} (expected: NO, suppressed)`,
      `${conflictRel} reached B: ${yesNo(bHasConflict)} (expected: NO, suppressed)`,
      `${originalRel} cloud hash present: ${yesNo(Object.hasOwn(cloudManifest.entries, originalRel))}`,
    ],
  };
}

async function runFolderConflict(ctx: HarnessContext): Promise<ScenarioReport> {
  const originalRel = 'Projects/Client/notes.md';
  const conflictRel = 'Projects/Client (1)/notes.md';
  const bFolderContent = 'folder conflict content from B';

  console.log('[cloud-sync-harness] REBEL-5QS regression guard: generated folder conflict copies are suppressed');
  await establishBaseline(ctx, originalRel, 'baseline');

  await ctx.mountB.writeFile(originalRel, bFolderContent);
  await stepSnapshot(ctx, 'seed B folder edit');

  await ctx.drive.mintFolderConflict('Projects/Client', 'B');
  await stepSnapshot(ctx, 'mint folder conflict from B');

  await ctx.drive.settle({ to: ['A'] });
  await stepSnapshot(ctx, 'settle folder conflict to A');

  await forceSync(ctx, ctx.a, 'A push after folder conflict');
  const bPulledConflict = await forceSyncCycles(ctx, ctx.b, 'B pull after folder conflict', async () => {
    const contentOnB = await readTextIfExists(path.join(ctx.b.workspaceDir, conflictRel));
    return contentOnB === bFolderContent;
  });

  const cloudManifest = await fetchCloudManifest(ctx.a);
  const cloudHasConflict = Object.hasOwn(cloudManifest.entries, conflictRel);
  const bHasConflict = await pathExists(path.join(ctx.b.workspaceDir, conflictRel));

  return {
    title: 'REBEL-5QS folder conflict suppression',
    summaryLines: [
      `${conflictRel} reached cloud: ${yesNo(cloudHasConflict)} (expected: NO, suppressed)`,
      `${conflictRel} reached B: ${yesNo(bHasConflict && bPulledConflict)} (expected: NO, suppressed)`,
      `${originalRel} remains in cloud: ${yesNo(Object.hasOwn(cloudManifest.entries, originalRel))}`,
    ],
  };
}

async function runConcurrentEdit(ctx: HarnessContext): Promise<ScenarioReport> {
  const originalRel = 'memory/topics/concurrent.md';

  console.log('[cloud-sync-harness] concurrent-edit: raw Drive divergence after same-path edits');
  await establishBaseline(ctx, originalRel, 'baseline');

  ctx.drive.concurrent([
    { mount: 'A', rel: originalRel, content: 'concurrent edit from A' },
    { mount: 'B', rel: originalRel, content: 'concurrent edit from B' },
  ]);
  await stepSnapshot(ctx, 'concurrent same-path edits');

  await ctx.drive.settle({ to: ['A', 'B'] });
  await stepSnapshot(ctx, 'settle concurrent edits to both');

  await forceSync(ctx, ctx.a, 'A sync after concurrent edit');
  await forceSyncCycles(ctx, ctx.b, 'B sync after concurrent edit');

  const cloudManifest = await fetchCloudManifest(ctx.a);
  const tree = await ctx.drive.tree();
  const aConflicts = conflictCopies(tree.A ?? []);
  const bConflicts = conflictCopies(tree.B ?? []);
  const cloudConflicts = conflictCopies(Object.keys(cloudManifest.entries));

  return {
    title: 'concurrent-edit divergence',
    summaryLines: [
      `A conflict copies: ${formatPathList(aConflicts)}`,
      `B conflict copies: ${formatPathList(bConflicts)}`,
      `Cloud conflict copies: ${formatPathList(cloudConflicts)}`,
      `${originalRel} cloud hash present: ${yesNo(Object.hasOwn(cloudManifest.entries, originalRel))}`,
    ],
  };
}

function conflictCopies(files: string[]): string[] {
  return files.filter((file) => / \([0-9]+\)(?:\.[^/]+)?$/.test(path.posix.basename(file))).sort((a, b) => a.localeCompare(b));
}

function yesNo(value: boolean): 'YES' | 'NO' {
  return value ? 'YES' : 'NO';
}

function formatPathList(paths: string[]): string {
  return paths.length === 0 ? '<none>' : paths.join(', ');
}

async function stepSnapshot(ctx: HarnessContext, label: string): Promise<void> {
  if (!ctx.opts.step) return;
  console.log(`\n[cloud-sync-harness] STEP SNAPSHOT: ${label}`);
  await dumpState(ctx, 'all');
}

async function dumpState(ctx: HarnessContext, mode: PrintMode = ctx.opts.printMode): Promise<void> {
  if (mode === 'tree' || mode === 'all') {
    const tree = await ctx.drive.tree();
    console.log('[cloud-sync-harness] Drive tree');
    console.log(JSON.stringify(tree, null, 2));
  }

  if (mode === 'cloud-manifest' || mode === 'all') {
    const manifest = await fetchCloudManifest(ctx.a);
    console.log('[cloud-sync-harness] Cloud manifest');
    console.log(JSON.stringify({
      complete: manifest.complete,
      reasons: manifest.reasons,
      entries: sortedManifestEntries(manifest),
    }, null, 2));
  }

  if (mode === 'machine-state' || mode === 'all') {
    const machineState = await readMachineState(ctx);
    console.log('[cloud-sync-harness] Machine state');
    console.log(JSON.stringify(machineState, null, 2));
  }
}

async function readMachineState(ctx: HarnessContext): Promise<Record<string, unknown>> {
  ctx.a.sync.flush();
  ctx.b.sync.flush();

  const [tree, aManifest, bManifest] = await Promise.all([
    ctx.drive.tree(),
    readMachineManifest(ctx.a),
    readMachineManifest(ctx.b),
  ]);

  return {
    A: {
      workspaceDir: ctx.a.workspaceDir,
      dataDir: ctx.a.dataDir,
      workspaceFiles: tree.A ?? [],
      manifestPath: path.join(ctx.a.dataDir, MANIFEST_REL_PATH),
      manifestEntries: Object.keys(aManifest).sort((left, right) => left.localeCompare(right)),
    },
    B: {
      workspaceDir: ctx.b.workspaceDir,
      dataDir: ctx.b.dataDir,
      workspaceFiles: tree.B ?? [],
      manifestPath: path.join(ctx.b.dataDir, MANIFEST_REL_PATH),
      manifestEntries: Object.keys(bManifest).sort((left, right) => left.localeCompare(right)),
    },
  };
}

async function readMachineManifest(machine: SyncMachine): Promise<Record<string, unknown>> {
  const manifestPath = path.join(machine.dataDir, MANIFEST_REL_PATH);
  const raw = await readTextIfExists(manifestPath);
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

async function runScenario(ctx: HarnessContext): Promise<ScenarioReport> {
  switch (ctx.opts.scenario) {
    case 'file-conflict':
      return runFileConflict(ctx);
    case 'folder-conflict':
      return runFolderConflict(ctx);
    case 'concurrent-edit':
      return runConcurrentEdit(ctx);
  }
}

async function cleanupHarness(ctx: HarnessContext | null): Promise<void> {
  if (!ctx) return;

  ctx.a.sync.flush();
  ctx.b.sync.flush();
  ctx.a.sync._resetForTesting();
  ctx.b.sync._resetForTesting();

  await ctx.cloud.cleanup();

  if (!ctx.opts.keep) {
    await Promise.all([
      fsp.rm(ctx.a.dataDir, { recursive: true, force: true }),
      fsp.rm(ctx.b.dataDir, { recursive: true, force: true }),
      fsp.rm(ctx.driveRoot, { recursive: true, force: true }),
    ]);
  }
}

function printKeepHint(ctx: HarnessContext): void {
  console.log('[cloud-sync-harness] --keep preserved temp roots:');
  console.log(`  cloud dataDir: ${ctx.cloud.dataDir}`);
  console.log(`  cloud workspaceDir: ${ctx.cloud.workspaceDir}`);
  console.log(`  DriveSim root: ${ctx.driveRoot}`);
  console.log(`  A dataDir: ${ctx.a.dataDir}`);
  console.log(`  B dataDir: ${ctx.b.dataDir}`);
  const stepFlag = ctx.opts.step ? ' --step' : '';
  const portFlag = ctx.opts.port === undefined ? '' : ` --port ${ctx.opts.port}`;
  console.log(
    `[cloud-sync-harness] re-run hint: node --import tsx scripts/cloud-sync-harness.ts --scenario ${ctx.opts.scenario} --print ${ctx.opts.printMode}${stepFlag} --keep${portFlag}`,
  );
}

function printSummary(report: ScenarioReport): void {
  console.log(`\n[cloud-sync-harness] Summary: ${report.title}`);
  for (const line of report.summaryLines) {
    console.log(`[cloud-sync-harness] - ${line}`);
  }
}

async function main(): Promise<number> {
  let ctx: HarnessContext | null = null;

  try {
    const opts = parseCliOptions();
    ctx = await createHarness(opts);
    printHeader(ctx);

    const report = await runScenario(ctx);

    console.log('\n[cloud-sync-harness] Final requested dump');
    await dumpState(ctx);
    printSummary(report);

    if (ctx.opts.keep) {
      printKeepHint(ctx);
    }

    return 0;
  } catch (err) {
    console.error('[cloud-sync-harness] FAIL');
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    return 1;
  } finally {
    await cleanupHarness(ctx);
  }
}

void main().then((code) => process.exit(code));
