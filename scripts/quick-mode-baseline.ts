/**
 * Quick-Mode Baseline Analyzer
 *
 * Reads existing per-turn session pino logs from
 * `~/Library/Application Support/mindstone-rebel/logs/sessions/*.log`
 * (and optionally the main pino logs for stderr-forwarded pre-turn-worker
 * data) and emits one row per turn with the timing signals needed to
 * design the Quick Mode toggle.
 *
 * Usage:
 *   npx tsx scripts/quick-mode-baseline.ts                         # JSONL to stdout
 *   npx tsx scripts/quick-mode-baseline.ts --csv                   # CSV to stdout
 *   npx tsx scripts/quick-mode-baseline.ts --summary               # stats only
 *   npx tsx scripts/quick-mode-baseline.ts --since 2026-04-01
 *   npx tsx scripts/quick-mode-baseline.ts --sessions-dir <path>
 *   npx tsx scripts/quick-mode-baseline.ts --main-dir <path>
 *
 * No app-code dependency. Pure read-only analysis tool. Safe to ship in scripts/.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';

interface Args {
  sessionsDir: string;
  mainDir: string;
  outputFormat: 'jsonl' | 'csv' | 'summary';
  sinceIso: string | null;
}

interface TurnRow {
  turnId: string;
  startedAtIso: string;
  endedAtIso: string | null;
  durationSec: number | null;
  timeToFirstToolMs: number | null;
  preTurnResolveMs: number | null;
  systemPromptMs: number | null;
  mcpResolveMs: number | null;
  preTurnSearchMs: number | null;
  preTurnEmbeddingFileMs: number | null;
  preTurnEmbeddingToolMs: number | null;
  preTurnEmbeddingSkillMs: number | null;
  preTurnEmbeddingConversationMs: number | null;
  toolCallCount: number | null;
  totalCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  totalPromptTokens: number | null;
  model: string | null;
  hadCouncil: boolean;
  hadAdHoc: boolean;
  hadSubAgent: boolean;
  hadPlanner: boolean;
  hadThinking: boolean;
  hadRateLimit: boolean;
  hadError: boolean;
  endReason: string;
  toolSafetyEvalCount: number;
  watchdogStallCount: number;
  watchdogMaxLevel: number;
  rendererSessionId: string | null;
  isMemoryUpdate: boolean;
}

function detectDefaultPaths(): { sessionsDir: string; mainDir: string } | null {
  const home = homedir();
  switch (platform()) {
    case 'darwin': {
      const base = path.join(home, 'Library', 'Application Support', 'mindstone-rebel', 'logs');
      return { sessionsDir: path.join(base, 'sessions'), mainDir: base };
    }
    case 'linux': {
      const base = path.join(home, '.config', 'mindstone-rebel', 'logs');
      return { sessionsDir: path.join(base, 'sessions'), mainDir: base };
    }
    case 'win32': {
      const appData = process.env.APPDATA;
      if (!appData) return null;
      const base = path.join(appData, 'mindstone-rebel', 'logs');
      return { sessionsDir: path.join(base, 'sessions'), mainDir: base };
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
  const has = (flag: string): boolean => argv.includes(flag);

  const defaults = detectDefaultPaths();
  const sessionsDir = get('--sessions-dir') ?? defaults?.sessionsDir;
  const mainDir = get('--main-dir') ?? defaults?.mainDir;
  if (!sessionsDir || !mainDir) {
    console.error('Could not detect log directories. Pass --sessions-dir and --main-dir.');
    process.exit(2);
  }

  let outputFormat: Args['outputFormat'] = 'jsonl';
  if (has('--csv')) outputFormat = 'csv';
  if (has('--summary')) outputFormat = 'summary';

  const sinceRaw = get('--since');
  const sinceIso = sinceRaw ? new Date(sinceRaw).toISOString() : null;
  if (sinceRaw && Number.isNaN(Date.parse(sinceRaw))) {
    console.error(`Invalid --since value (expected YYYY-MM-DD or ISO timestamp): ${sinceRaw}`);
    process.exit(2);
  }

  return { sessionsDir, mainDir, outputFormat, sinceIso };
}

interface SessionLogLine {
  level?: number;
  time?: string;
  msg?: string;
  turnId?: string;
  rendererSessionId?: string;
  preTurnResolveMs?: number;
  systemPromptMs?: number;
  mcpResolveMs?: number;
  durationMs?: number;
  searchDurationMs?: number;
  model?: string;
  totalCostUsd?: number;
  totalToolCalls?: number;
  totalPromptTokens?: number;
  phaseName?: string;
  phase?: string;
  status?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  errorMessage?: string;
  agentErrorKind?: string;
}

function parseLine(raw: string): SessionLogLine | null {
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as SessionLogLine;
  } catch {
    return null;
  }
}

const COUNCIL_INDICATORS = ['dispatch_council', 'Council fan-out', 'council_member', 'councilMembers', 'CouncilDispatch'];
const ADHOC_INDICATORS = ['dispatch_adhoc_agent', 'ad-hoc agent dispatched', 'adhocAgent', 'AdHocAgent'];
const SUBAGENT_INDICATORS = ['SUBAGENT: Sub-agent tool invoked', 'dispatched sub-agent', 'subagent_dispatch', 'dispatch_sub_agent'];
const PLANNER_INDICATORS = ['Planning model decision', 'planMode', 'plan_mode', 'CODEX-DIAG] Planning'];
const THINKING_INDICATORS = ['thinking_block', 'thinkingBudgetTokens', 'extended_thinking', 'thinkingBudget'];

function indicatorPresent(haystack: string, needles: string[]): boolean {
  for (const n of needles) {
    if (haystack.includes(n)) return true;
  }
  return false;
}

function extractTurnIdFromFilename(name: string): string | null {
  const m = name.match(/turn-([0-9a-f-]+)-renderer/);
  return m ? m[1] : null;
}

function analyzeSessionLog(filePath: string): TurnRow | null {
  const fileName = path.basename(filePath);
  const turnIdFromName = extractTurnIdFromFilename(fileName);
  if (!turnIdFromName) return null;

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split('\n');
  let startedAtIso: string | null = null;
  let endedAtIso: string | null = null;
  let preTurnResolveMs: number | null = null;
  let systemPromptMs: number | null = null;
  let mcpResolveMs: number | null = null;
  let model: string | null = null;
  let totalCostUsd: number | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let totalPromptTokens: number | null = null;
  let toolCallCount: number | null = null;
  let hadCouncil = false;
  let hadAdHoc = false;
  let hadSubAgent = false;
  let hadPlanner = false;
  let hadThinking = false;
  let hadRateLimit = false;
  let hadError = false;
  let endReason = 'unknown';
  let rendererSessionId: string | null = null;
  let toolSafetyEvalCount = 0;
  let watchdogStallCount = 0;
  let watchdogMaxLevel = 0;
  let firstToolStartMs: number | null = null;
  const isMemoryUpdate = fileName.includes('memory-update');

  for (const raw of lines) {
    const line = parseLine(raw);
    if (!line) continue;
    const msg = line.msg ?? '';

    if (line.time && !startedAtIso) startedAtIso = line.time;
    if (line.time) endedAtIso = line.time;
    if (line.rendererSessionId && !rendererSessionId) rendererSessionId = line.rendererSessionId;

    if (msg === 'Pre-turn resolution timing (systemPrompt + MCP)') {
      preTurnResolveMs = line.preTurnResolveMs ?? null;
      systemPromptMs = line.systemPromptMs ?? null;
      mcpResolveMs = line.mcpResolveMs ?? null;
    }

    if (msg === 'Agent turn produced result') {
      model = line.model ?? model;
      totalCostUsd = line.totalCostUsd ?? totalCostUsd;
      totalPromptTokens = line.totalPromptTokens ?? totalPromptTokens;
      toolCallCount = line.totalToolCalls ?? toolCallCount;
      const u = line.usage;
      if (u) {
        inputTokens = u.input_tokens ?? inputTokens;
        outputTokens = u.output_tokens ?? outputTokens;
        cacheReadTokens = u.cache_read_input_tokens ?? cacheReadTokens;
      }
      if (endReason === 'unknown') endReason = 'completed';
    }

    if (msg.includes('Rate limit')) {
      hadRateLimit = true;
      hadError = true;
      endReason = 'rate_limited';
    }
    if (line.level !== undefined && line.level >= 50) {
      hadError = true;
      if (endReason === 'unknown') endReason = 'error';
    }
    if (line.agentErrorKind) {
      hadError = true;
      if (endReason === 'unknown') endReason = line.agentErrorKind;
    }

    if (msg === 'Evaluating interactive tool safety via Safety Prompt') {
      toolSafetyEvalCount += 1;
    }
    if (
      firstToolStartMs === null &&
      msg === 'Tool event dispatched to renderer' &&
      (line as unknown as { stage?: string }).stage === 'start' &&
      line.time
    ) {
      firstToolStartMs = Date.parse(line.time);
    }
    if (msg.startsWith('Agent turn watchdog')) {
      watchdogStallCount += 1;
      const watchdogLevel = (line as unknown as { level?: number; watchdogLevel?: number }).watchdogLevel;
      if (typeof watchdogLevel === 'number' && watchdogLevel > watchdogMaxLevel) {
        watchdogMaxLevel = watchdogLevel;
      }
    }

    if (indicatorPresent(raw, COUNCIL_INDICATORS)) hadCouncil = true;
    if (indicatorPresent(raw, ADHOC_INDICATORS)) hadAdHoc = true;
    if (indicatorPresent(raw, SUBAGENT_INDICATORS)) hadSubAgent = true;
    if (indicatorPresent(raw, PLANNER_INDICATORS)) hadPlanner = true;
    if (indicatorPresent(raw, THINKING_INDICATORS)) hadThinking = true;
  }

  if (!startedAtIso) return null;

  const startedMs = Date.parse(startedAtIso);
  const endedMs = endedAtIso ? Date.parse(endedAtIso) : null;
  const durationSec = endedMs !== null ? (endedMs - startedMs) / 1000 : null;
  const timeToFirstToolMs = firstToolStartMs !== null ? firstToolStartMs - startedMs : null;

  return {
    turnId: turnIdFromName,
    startedAtIso,
    endedAtIso,
    durationSec,
    timeToFirstToolMs,
    preTurnResolveMs,
    systemPromptMs,
    mcpResolveMs,
    preTurnSearchMs: null,
    preTurnEmbeddingFileMs: null,
    preTurnEmbeddingToolMs: null,
    preTurnEmbeddingSkillMs: null,
    preTurnEmbeddingConversationMs: null,
    toolCallCount,
    totalCostUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalPromptTokens,
    model,
    hadCouncil,
    hadAdHoc,
    hadSubAgent,
    hadPlanner,
    hadThinking,
    hadRateLimit,
    hadError,
    endReason,
    toolSafetyEvalCount,
    watchdogStallCount,
    watchdogMaxLevel,
    rendererSessionId,
    isMemoryUpdate,
  };
}

interface MainLogPreTurn {
  searchDurationMs: number | null;
  embeddings: Record<'file' | 'tool' | 'skill' | 'conversation', number | null>;
}

function buildMainLogPreTurnIndex(mainDir: string, turnsByStart: TurnRow[]): Map<string, MainLogPreTurn> {
  const index = new Map<string, MainLogPreTurn>();
  if (turnsByStart.length === 0) return index;

  const minStart = Date.parse(turnsByStart[0].startedAtIso);
  const lastTurn = turnsByStart[turnsByStart.length - 1];
  const maxEnd = Date.parse(lastTurn.endedAtIso ?? lastTurn.startedAtIso) + 60_000;

  let candidates: string[];
  try {
    candidates = readdirSync(mainDir).filter((f) => /^mindstone-rebel\.\d+\.log$/.test(f));
  } catch {
    return index;
  }

  type PendingEmbedding = { phase: 'file' | 'tool' | 'skill' | 'conversation'; startMs: number };
  const pendingByPid = new Map<number, PendingEmbedding | null>();

  // Walk each main log and bucket interesting events by timestamp window
  type Event =
    | { kind: 'searchResult'; ms: number; searchDurationMs: number }
    | { kind: 'embeddingDone'; ms: number; phase: 'file' | 'tool' | 'skill' | 'conversation'; elapsedMs: number };

  const events: Event[] = [];

  for (const f of candidates) {
    const full = path.join(mainDir, f);
    let content: string;
    try {
      content = readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    const fileLines = content.split('\n');
    for (const raw of fileLines) {
      if (!raw.includes('pre-turn-diag') && !raw.includes('Pre-turn worker search results')) continue;
      const line = parseLine(raw);
      if (!line || !line.time) continue;
      const ms = Date.parse(line.time);
      if (ms < minStart - 60_000 || ms > maxEnd) continue;

      const pid = (line as unknown as { pid?: number }).pid ?? 0;
      const phase = (line as unknown as { phase?: string }).phase;

      if (phase && phase.startsWith('embedding-') && phase.endsWith('-start')) {
        const sectionRaw = phase.replace('embedding-', '').replace('-start', '');
        if (sectionRaw === 'file' || sectionRaw === 'tool' || sectionRaw === 'skill' || sectionRaw === 'conversation') {
          pendingByPid.set(pid, { phase: sectionRaw, startMs: ms });
        }
        continue;
      }
      if (phase && phase.startsWith('embedding-') && phase.endsWith('-done')) {
        const sectionRaw = phase.replace('embedding-', '').replace('-done', '');
        const pending = pendingByPid.get(pid) ?? null;
        if (
          pending &&
          pending.phase === sectionRaw &&
          (sectionRaw === 'file' || sectionRaw === 'tool' || sectionRaw === 'skill' || sectionRaw === 'conversation')
        ) {
          events.push({ kind: 'embeddingDone', ms, phase: sectionRaw, elapsedMs: ms - pending.startMs });
          pendingByPid.set(pid, null);
        }
        continue;
      }

      // The pre-turn worker search results line is forwarded via stderr in main log,
      // wrapped inside { "error": "<stringified-json>", "source": "pre-turn-worker-stderr" }
      const errorField = (line as unknown as { error?: string }).error;
      if (errorField && errorField.includes('Pre-turn worker search results')) {
        try {
          const inner = JSON.parse(errorField) as { searchDurationMs?: number };
          if (typeof inner.searchDurationMs === 'number') {
            events.push({ kind: 'searchResult', ms, searchDurationMs: inner.searchDurationMs });
          }
        } catch {
          // ignore
        }
      } else if (typeof (line as unknown as { searchDurationMs?: unknown }).searchDurationMs === 'number') {
        events.push({
          kind: 'searchResult',
          ms,
          searchDurationMs: (line as unknown as { searchDurationMs: number }).searchDurationMs,
        });
      }
    }
  }

  // Sort turns by start time for window matching
  const sortedTurns = [...turnsByStart].sort((a, b) => Date.parse(a.startedAtIso) - Date.parse(b.startedAtIso));
  // For each turn, accept events that fall within [start, end+5s]
  for (const turn of sortedTurns) {
    const tStart = Date.parse(turn.startedAtIso);
    const tEnd = turn.endedAtIso ? Date.parse(turn.endedAtIso) : tStart + 600_000;
    const slack = 5_000;
    const bucket: MainLogPreTurn = {
      searchDurationMs: null,
      embeddings: { file: null, tool: null, skill: null, conversation: null },
    };
    for (const e of events) {
      if (e.ms < tStart - slack || e.ms > tEnd + slack) continue;
      if (e.kind === 'searchResult') {
        if (bucket.searchDurationMs === null || e.searchDurationMs > bucket.searchDurationMs) {
          bucket.searchDurationMs = e.searchDurationMs;
        }
      } else if (e.kind === 'embeddingDone') {
        if (bucket.embeddings[e.phase] === null || e.elapsedMs > (bucket.embeddings[e.phase] ?? 0)) {
          bucket.embeddings[e.phase] = e.elapsedMs;
        }
      }
    }
    index.set(turn.turnId, bucket);
  }

  return index;
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

function formatNum(v: number | null, digits = 1): string {
  if (v === null || !Number.isFinite(v)) return '–';
  return v.toFixed(digits);
}

function summarize(rows: TurnRow[]): void {
  const numericFields: Array<keyof TurnRow> = [
    'durationSec',
    'timeToFirstToolMs',
    'preTurnResolveMs',
    'systemPromptMs',
    'mcpResolveMs',
    'preTurnSearchMs',
    'preTurnEmbeddingFileMs',
    'preTurnEmbeddingToolMs',
    'preTurnEmbeddingSkillMs',
    'preTurnEmbeddingConversationMs',
    'toolCallCount',
    'totalCostUsd',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'totalPromptTokens',
    'toolSafetyEvalCount',
    'watchdogStallCount',
    'watchdogMaxLevel',
  ];
  console.log(`\n=== Quick-Mode Baseline Summary ===`);
  console.log(`Total turns analyzed: ${rows.length}`);
  const userTurns = rows.filter((r) => !r.isMemoryUpdate);
  console.log(`User-prompt turns (excludes memory-update bg turns): ${userTurns.length}`);
  console.log(`Memory-update background turns: ${rows.length - userTurns.length}`);
  console.log('');

  console.log('Per-turn feature presence (user turns only):');
  const total = userTurns.length || 1;
  const counts = {
    council: userTurns.filter((r) => r.hadCouncil).length,
    adhoc: userTurns.filter((r) => r.hadAdHoc).length,
    subAgent: userTurns.filter((r) => r.hadSubAgent).length,
    planner: userTurns.filter((r) => r.hadPlanner).length,
    thinking: userTurns.filter((r) => r.hadThinking).length,
    rateLimit: userTurns.filter((r) => r.hadRateLimit).length,
    error: userTurns.filter((r) => r.hadError).length,
  };
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(12)} ${String(v).padStart(4)} / ${total}  (${((100 * v) / total).toFixed(1)}%)`);
  }
  console.log('');

  console.log('End-reason distribution (user turns):');
  const reasonCounts = new Map<string, number>();
  for (const r of userTurns) {
    reasonCounts.set(r.endReason, (reasonCounts.get(r.endReason) ?? 0) + 1);
  }
  const sortedReasons = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sortedReasons) {
    console.log(`  ${reason.padEnd(24)} ${String(count).padStart(4)} (${((100 * count) / total).toFixed(1)}%)`);
  }
  console.log('');

  console.log('Numeric field stats (user turns only):');
  const header = `${'field'.padEnd(34)} ${'count'.padStart(5)}  ${'min'.padStart(8)}  ${'p50'.padStart(8)}  ${'p90'.padStart(8)}  ${'p99'.padStart(8)}  ${'max'.padStart(8)}`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const field of numericFields) {
    const values = userTurns
      .map((r) => r[field])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (values.length === 0) {
      console.log(`${String(field).padEnd(34)} ${'0'.padStart(5)}  ${'–'.padStart(8)}  ${'–'.padStart(8)}  ${'–'.padStart(8)}  ${'–'.padStart(8)}  ${'–'.padStart(8)}`);
      continue;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const digits = field === 'totalCostUsd' ? 4 : field === 'durationSec' ? 2 : 0;
    console.log(
      `${String(field).padEnd(34)} ${String(values.length).padStart(5)}  ${formatNum(sorted[0], digits).padStart(8)}  ${formatNum(percentile(sorted, 50), digits).padStart(8)}  ${formatNum(percentile(sorted, 90), digits).padStart(8)}  ${formatNum(percentile(sorted, 99), digits).padStart(8)}  ${formatNum(sorted[sorted.length - 1], digits).padStart(8)}`,
    );
  }
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function emitCsv(rows: TurnRow[]): void {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]) as Array<keyof TurnRow>;
  console.log(columns.join(','));
  for (const r of rows) {
    console.log(columns.map((c) => csvEscape(r[c])).join(','));
  }
}

function emitJsonl(rows: TurnRow[]): void {
  for (const r of rows) {
    console.log(JSON.stringify(r));
  }
}

function main(): void {
  const args = parseArgs();

  if (!existsSync(args.sessionsDir)) {
    console.error(`Sessions directory not found: ${args.sessionsDir}`);
    process.exit(2);
  }

  let sessionFiles: string[];
  try {
    sessionFiles = readdirSync(args.sessionsDir).filter((f) => f.endsWith('.log'));
  } catch (err) {
    console.error(`Could not read sessions directory: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const rows: TurnRow[] = [];
  for (const f of sessionFiles) {
    const row = analyzeSessionLog(path.join(args.sessionsDir, f));
    if (!row) continue;
    if (args.sinceIso && row.startedAtIso < args.sinceIso) continue;
    rows.push(row);
  }
  rows.sort((a, b) => a.startedAtIso.localeCompare(b.startedAtIso));

  // Enrich with main-log signals (pre-turn worker search, embedding phase durations)
  if (existsSync(args.mainDir)) {
    const preTurnIndex = buildMainLogPreTurnIndex(args.mainDir, rows);
    for (const row of rows) {
      const enrichment = preTurnIndex.get(row.turnId);
      if (!enrichment) continue;
      row.preTurnSearchMs = enrichment.searchDurationMs;
      row.preTurnEmbeddingFileMs = enrichment.embeddings.file;
      row.preTurnEmbeddingToolMs = enrichment.embeddings.tool;
      row.preTurnEmbeddingSkillMs = enrichment.embeddings.skill;
      row.preTurnEmbeddingConversationMs = enrichment.embeddings.conversation;
    }
  }

  switch (args.outputFormat) {
    case 'csv':
      emitCsv(rows);
      break;
    case 'summary':
      summarize(rows);
      break;
    case 'jsonl':
    default:
      emitJsonl(rows);
      break;
  }
}

main();
