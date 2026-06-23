#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const CHILD_PATH = path.join(__dirname, 'child.cjs');
const REPORT_DIR = path.join(
  REPO_ROOT,
  'docs/plans/260621_provider-transport-resolver/subagent_reports',
);

const POOL_SIZES = [4, 8, 16, 24, 32, 48, 64, 96];
const LOOKUPS = Number.parseInt(process.env.DNS_POOL_LOOKUPS ?? '400', 10);
const CHILD_TIMEOUT_MS = Number.parseInt(process.env.DNS_POOL_CHILD_TIMEOUT_MS ?? '60000', 10);
const DNS_NAME = process.env.DNS_POOL_NAME || 'localhost';
const STEADY_CONCURRENCY = Number.parseInt(
  process.env.DNS_POOL_CONCURRENCY ?? String(LOOKUPS),
  10,
);

function scenariosForPool(poolSize) {
  return [
    {
      id: 'fixed-9',
      label: 'fixed 9',
      blockers: 9,
      mode: 'steady',
      notes: 'field-ish parked-work count',
    },
    {
      id: 'pool',
      label: 'pool',
      blockers: poolSize,
      mode: 'steady',
      notes: 'one blocker per worker',
    },
    {
      id: '2x-pool',
      label: '2x pool',
      blockers: poolSize * 2,
      mode: 'steady',
      notes: 'adversarial oversubscription',
    },
    {
      id: 'fixed-9-burst',
      label: 'fixed 9 burst',
      blockers: 9,
      mode: 'burst',
      notes: 'all lookups submitted at once',
    },
  ];
}

function sanitizedEnv(poolSize, blockers, mode) {
  return {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
    PATH: process.env.PATH ?? '',
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    UV_THREADPOOL_SIZE: String(poolSize),
    POOL_SIZE: String(poolSize),
    BLOCKERS: String(blockers),
    LOOKUPS: String(LOOKUPS),
    DNS_CONCURRENCY: String(STEADY_CONCURRENCY),
    CHILD_TIMEOUT_MS: String(CHILD_TIMEOUT_MS),
    DNS_NAME,
    MODE: mode,
  };
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) {
    return Number.NaN;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sortedValues.length) - 1),
  );
  return sortedValues[index];
}

function summarizeLatencies(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length > 0 ? sorted[sorted.length - 1] : Number.NaN,
  };
}

function formatMs(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  if (value >= 1000) {
    return value.toFixed(0);
  }
  if (value >= 10) {
    return value.toFixed(1);
  }
  return value.toFixed(2);
}

function formatPass(value) {
  return value ? 'yes' : 'no';
}

async function runCell(poolSize, scenario) {
  const child = spawn(process.execPath, [CHILD_PATH], {
    env: sanitizedEnv(poolSize, scenario.blockers, scenario.mode),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parentKillTimer = setTimeout(() => {
    child.kill('SIGKILL');
  }, CHILD_TIMEOUT_MS + 5_000);

  const events = [];
  const latencies = [];
  let stdoutBuffer = '';
  let stderr = '';
  let startEvent = null;

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        const event = JSON.parse(line);
        events.push(event);
        if (event.ev === 'start') {
          startEvent = event;
        }
        if (event.ev === 'lookup') {
          latencies.push(event.latencyMs);
        }
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  clearTimeout(parentKillTimer);

  if (stdoutBuffer.trim().length > 0) {
    const event = JSON.parse(stdoutBuffer.trim());
    events.push(event);
    if (event.ev === 'lookup') {
      latencies.push(event.latencyMs);
    }
  }

  if (stderr.trim().length > 0) {
    throw new Error(
      `Child emitted stderr for pool=${poolSize} scenario=${scenario.id}: ${stderr.trim()}`,
    );
  }
  if (exitCode !== 0) {
    throw new Error(
      `Child exited ${exitCode} for pool=${poolSize} scenario=${scenario.id}: ${JSON.stringify(
        events.slice(-5),
      )}`,
    );
  }
  if (latencies.length !== LOOKUPS) {
    throw new Error(
      `Expected ${LOOKUPS} lookup samples for pool=${poolSize} scenario=${scenario.id}, got ${latencies.length}`,
    );
  }
  if (events.some((event) => event.ev === 'timeout')) {
    throw new Error(`Child timeout for pool=${poolSize} scenario=${scenario.id}`);
  }

  const stats = summarizeLatencies(latencies);
  return {
    poolSize,
    scenarioId: scenario.id,
    scenarioLabel: scenario.label,
    blockers: scenario.blockers,
    mode: scenario.mode,
    notes: scenario.notes,
    startEvent,
    ...stats,
  };
}

function tableRows(results) {
  return results.map((result) => ({
    pool: result.poolSize,
    scenario: result.scenarioLabel,
    blockers: result.blockers,
    mode: result.mode,
    fs: result.startEvent?.fsBlockers ?? 'n/a',
    cpu: result.startEvent?.cpuBlockers ?? 'n/a',
    cpuTargetMs: result.startEvent?.cpuTargetMs ?? 'n/a',
    n: result.count,
    p50: formatMs(result.p50),
    p95: formatMs(result.p95),
    p99: formatMs(result.p99),
    max: formatMs(result.max),
  }));
}

function renderMarkdownTable(rows) {
  const headers = [
    'pool',
    'scenario',
    'blockers',
    'mode',
    'fs',
    'cpu',
    'cpu target ms',
    'n',
    'p50 ms',
    'p95 ms',
    'p99 ms',
    'max ms',
  ];
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.pool} | ${row.scenario} | ${row.blockers} | ${row.mode} | ${row.fs} | ${row.cpu} | ${row.cpuTargetMs} | ${row.n} | ${row.p50} | ${row.p95} | ${row.p99} | ${row.max} |`,
    );
  }
  return lines.join('\n');
}

function findResult(results, poolSize, scenarioId) {
  return results.find((result) => result.poolSize === poolSize && result.scenarioId === scenarioId);
}

function analyze(results) {
  const negativeRows = [4, 8].map((poolSize) => findResult(results, poolSize, '2x-pool'));
  const negativeControlPassed = negativeRows.every((row) => row && row.p99 > 10_000);

  const candidatePools = POOL_SIZES.filter((poolSize) => poolSize >= 16);
  const sub100Pools = candidatePools.filter((poolSize) => {
    const steady = findResult(results, poolSize, 'fixed-9');
    const burst = findResult(results, poolSize, 'fixed-9-burst');
    return steady && burst && steady.p99 < 100 && burst.p99 < 100;
  });
  const under10sPools = candidatePools.filter((poolSize) => {
    const steady = findResult(results, poolSize, 'fixed-9');
    const burst = findResult(results, poolSize, 'fixed-9-burst');
    return steady && burst && steady.p99 < 10_000 && burst.p99 < 10_000;
  });

  const recommendedPool = sub100Pools[0] ?? under10sPools[0] ?? null;
  const recommendedBasis =
    sub100Pools.length > 0
      ? 'fixed-9 steady+burst p99 < 100ms'
      : under10sPools.length > 0
        ? 'fixed-9 steady+burst p99 < 10s'
        : 'no fixed-9 pool cleared 10s';

  const prefilterGo = negativeControlPassed && recommendedPool !== null;

  return {
    negativeControlPassed,
    negativeRows,
    sub100Pools,
    under10sPools,
    recommendedPool,
    recommendedBasis,
    prefilterGo,
  };
}

function timestampForFilename(date = new Date()) {
  const yy = String(date.getUTCFullYear()).slice(-2);
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${yy}${mm}${dd}_${hh}${min}${ss}`;
}

function renderReport(results, analysis) {
  const table = renderMarkdownTable(tableRows(results));
  const negativeSummary = analysis.negativeRows
    .map((row) => `pool ${row.poolSize} 2x-pool p99=${formatMs(row.p99)}ms max=${formatMs(row.max)}ms`)
    .join('; ');

  return `# Stage 2 DNS pool latency spike results

Generated: ${new Date().toISOString()}

## Verdict

Pre-filter: **${analysis.prefilterGo ? 'GO for continued investigation' : 'NO-GO'}**.

Recommended pool size from this macOS run: **${
    analysis.recommendedPool === null ? 'none' : analysis.recommendedPool
  }** (${analysis.recommendedBasis}).

This is not a license to delete the c-ares decouple. A green result here only means the OS-resolver path is not disqualified for the field-ish fixed-9 load shape on this machine.

## What This Measured

- Real \`dns.lookup('${DNS_NAME}')\`, which uses the OS resolver and the libuv threadpool.
- A stable local name, so the timings isolate pool-queue wait. Real external hosts add network RTT independently of the pool queue.
- ${LOOKUPS} lookup samples per cell, reporting p50 / p95 / p99 / max and gating on p99.
- Fresh child process per cell with sanitized env and \`UV_THREADPOOL_SIZE\` set before the first async pool op.
- Mixed blockers: FIFO-backed \`fs.open\` calls persistently park worker threads in blocking syscalls, while \`crypto.pbkdf2\` blockers provide CPU work queued ahead of the DNS sample.

## Headline

- Negative control: **${formatPass(analysis.negativeControlPassed)}** (${negativeSummary}). This shows the harness can make \`dns.lookup\` starve past undici's 10s connect ceiling when the pool is too small/oversubscribed.
- Field-ish fixed-9 load: pools clearing fixed-9 steady+burst at p99 <100ms: ${
    analysis.sub100Pools.length > 0 ? analysis.sub100Pools.join(', ') : 'none'
  }.
- Field-ish fixed-9 load: pools clearing fixed-9 steady+burst at p99 <10s: ${
    analysis.under10sPools.length > 0 ? analysis.under10sPools.join(', ') : 'none'
  }.
- Adversarial saturation remains a hard limit: rows with blockers equal to or above the pool measure the queueing cost of exhausting a finite libuv pool, not a property any pool size can make disappear.

## Results

${table}

## Caveats

- macOS only. Windows and glibc-Linux are unproven.
- The cloud target is \`node:22-slim\` with no nscd/systemd-resolved OS DNS cache, which is the must-test-before-removal worst case for dropping \`cacheable-lookup\`. This macOS run does not cover it.
- VPN scoped-DNS correctness is a field/manual axiom: this spike does not prove that \`getaddrinfo\` returns the routable split-DNS address where c-ares did not.
- A green here means "not disqualified", not "safe to delete c-ares". Deletion still needs the later gates: field telemetry, producer bounding, and target-platform proof.
`;
}

async function main() {
  console.log(
    `Running DNS pool latency spike: ${POOL_SIZES.length} pool sizes, ${LOOKUPS} lookups/cell, name=${DNS_NAME}`,
  );

  const results = [];
  for (const poolSize of POOL_SIZES) {
    for (const scenario of scenariosForPool(poolSize)) {
      process.stdout.write(
        `pool=${poolSize} scenario=${scenario.id} blockers=${scenario.blockers} mode=${scenario.mode} ... `,
      );
      const result = await runCell(poolSize, scenario);
      results.push(result);
      console.log(
        `p99=${formatMs(result.p99)}ms max=${formatMs(result.max)}ms fs=${result.startEvent?.fsBlockers} cpu=${result.startEvent?.cpuBlockers}`,
      );
    }
  }

  const analysis = analyze(results);
  const table = renderMarkdownTable(tableRows(results));
  console.log('\n' + table);
  console.log(
    `\nPre-filter: ${analysis.prefilterGo ? 'GO for continued investigation' : 'NO-GO'}; recommended pool: ${
      analysis.recommendedPool ?? 'none'
    } (${analysis.recommendedBasis})`,
  );

  await fs.mkdir(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `${timestampForFilename()}_stage2-spike-results.md`);
  await fs.writeFile(reportPath, renderReport(results, analysis), 'utf8');
  console.log(`Report written: ${path.relative(REPO_ROOT, reportPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
