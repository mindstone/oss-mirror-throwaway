/**
 * Stage 0 Phase G — Fresh baseline extraction harness for 260508 active-work
 * CPU/GPU architectural rebuild plan.
 *
 * Reads `mindstone-rebel.log` after a Phase-G capture run, extracts the
 * relevant Memory diagnostic samples + active-turn-window metrics, and
 * writes a JSON snapshot to `tests/perf-baselines/260508/baseline-<ts>.json`.
 *
 * Usage:
 *   npx tsx scripts/baseline-260508-extract.ts                # auto-detect log
 *   npx tsx scripts/baseline-260508-extract.ts --since-min 5  # last 5 minutes only
 *   npx tsx scripts/baseline-260508-extract.ts --label first-turn
 *
 * Prints a console summary and saves the JSON. Human-readable.
 */
import { createReadStream, existsSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir, platform } from 'node:os';
import path from 'node:path';

interface Args {
  logPath: string;
  sinceMinutes: number;
  label: string;
  outDir: string;
}

interface RawLogLine {
  msg?: string;
  time?: string | number;
  level?: number;
  blurState?: unknown;
  rssMB?: number;
  totalCpuPercent?: number;
  processes?: Array<{
    type?: string;
    label?: string;
    name?: string;
    cpuPercent?: number;
    workingSetMB?: number;
    rssMB?: number;
    pid?: number;
  }>;
  eventLoopDelay?: {
    p50?: number;
    p95?: number;
    p99?: number;
    max?: number;
    mean?: number;
    windowDurationMs?: number;
  } | { status?: string };
  gpuLifecycle?: {
    crashes?: number;
    restarts?: number;
  };
  // Active-turn signals we care about for 260508
  turnId?: string;
  sessionId?: string;
  eventType?: string;
}

interface BaselineSnapshot {
  capturedAt: string;
  label: string;
  logPath: string;
  windowMinutes: number;
  scenario: {
    notes: string;
  };
  processCpu: {
    samples: number;
    mainAvg: number | null;
    mainMax: number | null;
    rendererAvg: number | null;
    rendererMax: number | null;
    gpuAvg: number | null;
    gpuMax: number | null;
    superMcpAvg: number | null;
    superMcpMax: number | null;
  };
  processRss: {
    mainMaxMB: number | null;
    rendererMaxMB: number | null;
    gpuMaxMB: number | null;
  };
  eventLoop: {
    samplesAvailable: number;
    p50Avg: number | null;
    p95Avg: number | null;
    p99Avg: number | null;
    maxOverall: number | null;
  };
  gpu: {
    crashes: number;
    restarts: number;
  };
  rawSampleCount: number;
}

function detectDefaultLogPath(): string | null {
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'mindstone-rebel', 'logs', 'mindstone-rebel.log');
    case 'linux':
      return path.join(home, '.config', 'mindstone-rebel', 'logs', 'mindstone-rebel.log');
    case 'win32': {
      const appData = process.env.APPDATA;
      return appData ? path.join(appData, 'mindstone-rebel', 'logs', 'mindstone-rebel.log') : null;
    }
    default:
      return null;
  }
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, fallback?: string): string | undefined => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return fallback;
    return argv[idx + 1];
  };

  const detected = detectDefaultLogPath();
  const logPath = get('--log') ?? detected;
  if (!logPath) {
    console.error('Could not auto-detect log path. Pass --log <path>.');
    process.exit(2);
  }

  const sinceArg = get('--since-min', '15');
  const sinceMinutes = Number.parseFloat(sinceArg ?? '15');
  if (!Number.isFinite(sinceMinutes) || sinceMinutes <= 0) {
    console.error(`--since-min must be a positive number. got: ${sinceArg}`);
    process.exit(2);
  }

  const label = get('--label', 'baseline') ?? 'baseline';
  const outDir = get('--out-dir', path.join(process.cwd(), 'tests', 'perf-baselines', '260508'))
    ?? path.join(process.cwd(), 'tests', 'perf-baselines', '260508');

  return { logPath, sinceMinutes, label, outDir };
}

async function readLogLinesAfter(logPath: string, cutoffMs: number): Promise<string[]> {
  if (!existsSync(logPath)) {
    console.error(`Log file not found: ${logPath}`);
    process.exit(2);
  }
  const dir = path.dirname(logPath);
  const baseName = path.basename(logPath);
  const stem = baseName.replace(/\.log$/, '');
  const matchPattern = (f: string): boolean => {
    if (f === baseName) return true;
    if (f.startsWith(`${baseName}.`)) return true;
    if (f.startsWith(`${stem}.`) && f.endsWith('.log')) return true;
    return false;
  };
  const candidates = readdirSync(dir)
    .filter(matchPattern)
    .map((f) => ({ p: path.join(dir, f), m: statSync(path.join(dir, f)).mtimeMs }))
    .filter((c) => c.m >= cutoffMs - 600_000)
    .sort((a, b) => a.m - b.m);

  const lines: string[] = [];
  for (const c of candidates) {
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(c.p, { encoding: 'utf-8' });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (line.length === 0) return;
        if (!line.includes('"Memory diagnostic"')) return;
        const tIdx = line.indexOf('"time":"');
        if (tIdx !== -1) {
          const tStart = tIdx + 8;
          const tEnd = line.indexOf('"', tStart);
          if (tEnd !== -1) {
            const ts = Date.parse(line.slice(tStart, tEnd));
            if (Number.isFinite(ts) && ts < cutoffMs) return;
          }
        }
        lines.push(line);
      });
      rl.on('close', () => resolve());
      rl.on('error', (err) => {
        console.warn(`Skipping unreadable log: ${c.p} (${(err as Error).message})`);
        resolve();
      });
      stream.on('error', (err) => {
        console.warn(`Stream error on: ${c.p} (${(err as Error).message})`);
        resolve();
      });
    });
  }
  return lines;
}

function safeParse(line: string): RawLogLine | null {
  try {
    return JSON.parse(line) as RawLogLine;
  } catch {
    return null;
  }
}

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function maxOrNull(nums: number[]): number | null {
  return nums.length === 0 ? null : Math.max(...nums);
}

function extract(lines: string[], windowMs: number, now: number): BaselineSnapshot {
  const cutoff = now - windowMs;
  const samples: RawLogLine[] = [];
  for (const raw of lines) {
    const parsed = safeParse(raw);
    if (!parsed) continue;
    if (parsed.msg !== 'Memory diagnostic') continue;
    if (parsed.time !== undefined) {
      const t = typeof parsed.time === 'number' ? parsed.time : Date.parse(String(parsed.time));
      if (Number.isFinite(t) && t < cutoff) continue;
    }
    samples.push(parsed);
  }

  const mainCpu: number[] = [];
  const rendererCpu: number[] = [];
  const gpuCpu: number[] = [];
  const superMcpCpu: number[] = [];
  const mainRss: number[] = [];
  const rendererRss: number[] = [];
  const gpuRss: number[] = [];
  const p50: number[] = [];
  const p95: number[] = [];
  const p99: number[] = [];
  const elMax: number[] = [];
  let elSamples = 0;
  let gpuCrashes = 0;
  let gpuRestarts = 0;

  for (const s of samples) {
    if (Array.isArray(s.processes)) {
      for (const p of s.processes) {
        const cpu = typeof p.cpuPercent === 'number' ? p.cpuPercent : null;
        const rss = typeof p.workingSetMB === 'number'
          ? p.workingSetMB
          : typeof p.rssMB === 'number' ? p.rssMB : null;
        const t = (p.type ?? '').toLowerCase();
        const lbl = (p.label ?? p.name ?? '').toLowerCase();
        if (t === 'browser' || lbl === 'main') {
          if (cpu !== null) mainCpu.push(cpu);
          if (rss !== null) mainRss.push(rss);
        } else if (t === 'tab' && (lbl === 'mainui' || lbl === 'renderer' || lbl.startsWith('main'))) {
          if (cpu !== null) rendererCpu.push(cpu);
          if (rss !== null) rendererRss.push(rss);
        } else if (t === 'gpu' || lbl === 'gpu') {
          if (cpu !== null) gpuCpu.push(cpu);
          if (rss !== null) gpuRss.push(rss);
        } else if (lbl.includes('super-mcp') || lbl.includes('supermcp') || t === 'subprocess') {
          if (cpu !== null) superMcpCpu.push(cpu);
        }
      }
    } else if (typeof s.rssMB === 'number') {
      mainRss.push(s.rssMB);
      if (typeof s.totalCpuPercent === 'number') mainCpu.push(s.totalCpuPercent);
    }
    const eld = s.eventLoopDelay as Record<string, number | string> | undefined;
    if (eld && typeof eld.p50 === 'number' && typeof eld.p95 === 'number' && typeof eld.p99 === 'number') {
      elSamples += 1;
      p50.push(eld.p50 as number);
      p95.push(eld.p95 as number);
      p99.push(eld.p99 as number);
      if (typeof eld.max === 'number') elMax.push(eld.max);
    }
    const gpu = s.gpuLifecycle;
    if (gpu) {
      if (typeof gpu.crashes === 'number') gpuCrashes = Math.max(gpuCrashes, gpu.crashes);
      if (typeof gpu.restarts === 'number') gpuRestarts = Math.max(gpuRestarts, gpu.restarts);
    }
  }

  const snap: BaselineSnapshot = {
    capturedAt: new Date(now).toISOString(),
    label: '',
    logPath: '',
    windowMinutes: windowMs / 60000,
    scenario: {
      notes: 'See tests/perf-baselines/260508/PROCEDURE.md for the locked scenario this baseline was captured against.',
    },
    processCpu: {
      samples: samples.length,
      mainAvg: avg(mainCpu),
      mainMax: maxOrNull(mainCpu),
      rendererAvg: avg(rendererCpu),
      rendererMax: maxOrNull(rendererCpu),
      gpuAvg: avg(gpuCpu),
      gpuMax: maxOrNull(gpuCpu),
      superMcpAvg: avg(superMcpCpu),
      superMcpMax: maxOrNull(superMcpCpu),
    },
    processRss: {
      mainMaxMB: maxOrNull(mainRss),
      rendererMaxMB: maxOrNull(rendererRss),
      gpuMaxMB: maxOrNull(gpuRss),
    },
    eventLoop: {
      samplesAvailable: elSamples,
      p50Avg: avg(p50),
      p95Avg: avg(p95),
      p99Avg: avg(p99),
      maxOverall: maxOrNull(elMax),
    },
    gpu: {
      crashes: gpuCrashes,
      restarts: gpuRestarts,
    },
    rawSampleCount: samples.length,
  };
  return snap;
}

function fmt(n: number | null, suffix = ''): string {
  return n === null ? '—' : `${n.toFixed(1)}${suffix}`;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const now = Date.now();
  const windowMs = args.sinceMinutes * 60_000;
  const cutoff = now - windowMs;
  const lines = await readLogLinesAfter(args.logPath, cutoff);
  const snap = extract(lines, windowMs, now);
  snap.label = args.label;
  snap.logPath = args.logPath;

  if (!existsSync(args.outDir)) {
    mkdirSync(args.outDir, { recursive: true });
  }
  const ts = new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const outPath = path.join(args.outDir, `baseline-${args.label}-${ts}.json`);
  writeFileSync(outPath, JSON.stringify(snap, null, 2));

  console.log('');
  console.log('========================================');
  console.log(' Stage 0 Phase G — Baseline Extracted');
  console.log('========================================');
  console.log(`  Window:        last ${args.sinceMinutes} minutes`);
  console.log(`  Samples found: ${snap.rawSampleCount}`);
  console.log(`  Label:         ${args.label}`);
  console.log('');
  if (snap.rawSampleCount === 0) {
    console.log('  NO Memory diagnostic samples in window.');
    console.log('  - Was dev:perf running for at least 5 minutes?');
    console.log('  - Is the log path correct?');
    console.log(`  - Try: --since-min 60 to widen the window`);
    console.log('');
    process.exit(1);
  }
  console.log('  Process CPU (avg / max %)');
  console.log(`    main:      ${fmt(snap.processCpu.mainAvg)} / ${fmt(snap.processCpu.mainMax)}`);
  console.log(`    renderer:  ${fmt(snap.processCpu.rendererAvg)} / ${fmt(snap.processCpu.rendererMax)}`);
  console.log(`    gpu:       ${fmt(snap.processCpu.gpuAvg)} / ${fmt(snap.processCpu.gpuMax)}`);
  console.log(`    super-mcp: ${fmt(snap.processCpu.superMcpAvg)} / ${fmt(snap.processCpu.superMcpMax)}`);
  console.log('');
  console.log('  Process RSS (max MB)');
  console.log(`    main:      ${fmt(snap.processRss.mainMaxMB)}`);
  console.log(`    renderer:  ${fmt(snap.processRss.rendererMaxMB)}`);
  console.log(`    gpu:       ${fmt(snap.processRss.gpuMaxMB)}`);
  console.log('');
  console.log('  Event loop delay (avg ms / max ms)');
  console.log(`    p50:       ${fmt(snap.eventLoop.p50Avg)}`);
  console.log(`    p95:       ${fmt(snap.eventLoop.p95Avg)}`);
  console.log(`    p99:       ${fmt(snap.eventLoop.p99Avg)}`);
  console.log(`    max:       ${fmt(snap.eventLoop.maxOverall)}`);
  console.log('');
  console.log(`  GPU crashes/restarts: ${snap.gpu.crashes} / ${snap.gpu.restarts}`);
  console.log('');
  console.log(`  Saved: ${outPath}`);
  console.log('');
}

main().catch((err) => {
  console.error('Baseline extraction failed:', err);
  process.exit(1);
});
