#!/usr/bin/env tsx
/**
 * Doc-reachability auditor — Stage 2: the thin LLM-traversal judge.
 *
 * Stage 1 (audit-doc-reachability.ts) checks whether a doc *mentions the path* to a code dir.
 * It cannot tell whether the doc is actually *useful*. Stage 2 closes that gap: an LLM
 * (Cursor Composer-2) traverses from root AGENTS.md following only real doc links, grades whether
 * the docs orient an agent to the target (PASS_EXACT / PASS_AREA / WEAK / FAIL), and validates each
 * doc's descriptor against the code. A deterministic post-check then verifies every path/route the
 * judge cited actually exists — so a hallucinated route can't pass.
 *
 * Design (see docs/plans/260614_doc_reachability_audit/PLAN.md § Stage 2):
 *   - sampler:  pick a risk-stratified set of units from the Stage-1 coverage (pure)
 *   - prompt:   the judge writes machine-parseable JSON to a file (stdout capture truncates — spike lesson)
 *   - verify:   deterministic existence check on every cited path/route doc (anti-hallucination)
 *
 * Modes:
 *   --prepare           write the sample + judge prompt to <out> (then dispatch Composer-2 at it)
 *   --verify <json>     post-check a judge-output JSON and write the graded report
 *   --run               prepare → dispatch Composer-2 (via dispatch-cursor-subagent.ts) → verify
 *   --limit <n>         sample size (default 12)
 *   --out <dir>         output dir (default tmp/doc-reachability/stage2)
 *
 * @see docs/project/DOC_REACHABILITY.md — the principle this enforces
 * @see scripts/audit-doc-reachability.ts — Stage 1 (deterministic backbone) this builds on
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { runAudit, type UnitCoverage } from './audit-doc-reachability';

const ROOT = path.resolve(__dirname, '..');
const GRADES = ['PASS_EXACT', 'PASS_AREA', 'WEAK', 'FAIL'] as const;
export type JudgeGrade = (typeof GRADES)[number];

// ---------------------------------------------------------------------------
// Sampler — risk-stratified pick (pure)
// ---------------------------------------------------------------------------

/**
 * Pick units worth judging: mostly REACHABLE high-risk units (to catch "linked but unhelpful"
 * docs — Stage 2's core value), plus some UNREACHABLE high-risk units (to catch Stage-1
 * false-negatives, like the fenced-code mis-pairing bug the spike found). Deterministic:
 * sorted by fan-in, tie-broken by name.
 */
export function selectJudgeSample(coverage: UnitCoverage[], limit = 12): UnitCoverage[] {
  const byFanIn = (a: UnitCoverage, b: UnitCoverage) => b.fanIn - a.fanIn || a.unit.localeCompare(b.unit);
  const highRisk = coverage.filter((c) => c.tier === 'high');
  // Reachable units worth judging are the ones whose orientation depends on a *signpost elsewhere*
  // (hops >= 2, no own AGENTS.md) — i.e. the one-liner hub entries whose quality is uncertain.
  // Top-level anchors (hop 1, their own AGENTS.md) are trivially well-documented and uninformative.
  const reachable = highRisk
    .filter((c) => c.hops !== null && c.hops >= 2 && !c.hasOwnDoc)
    .sort(byFanIn);
  const unreachable = highRisk.filter((c) => c.hops === null).sort(byFanIn);
  const nReachable = Math.ceil(limit * 0.6);
  const nUnreachable = limit - nReachable;
  const picked = [...reachable.slice(0, nReachable), ...unreachable.slice(0, nUnreachable)];
  // top up from whichever pool has more, if one was short
  if (picked.length < limit) {
    const extra = [...reachable.slice(nReachable), ...unreachable.slice(nUnreachable)].sort(byFanIn);
    picked.push(...extra.slice(0, limit - picked.length));
  }
  return picked.sort(byFanIn);
}

/** Fisher-Yates shuffle (pure; rng injectable for deterministic tests). */
export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Broad RANDOM spot-check across the whole codebase (the original "random sampling" idea):
 * sample units uniformly at random across ALL tiers, but guarantee at least a quarter are
 * high-risk and some are unreachable, so a big random round still stress-tests the risky surface
 * and re-checks Stage-1 false-negatives rather than drowning in trivial leaf dirs.
 */
export function selectRandomSample(coverage: UnitCoverage[], limit = 20, rng: () => number = Math.random): UnitCoverage[] {
  const minHigh = Math.ceil(limit * 0.25);
  const highRisk = shuffle(coverage.filter((c) => c.tier === 'high'), rng);
  const unreachable = shuffle(coverage.filter((c) => c.hops === null), rng);
  const picked = new Map<string, UnitCoverage>();
  const add = (c?: UnitCoverage) => { if (c && picked.size < limit) picked.set(c.unit, c); };
  // guarantee some high-risk + some unreachable representation
  highRisk.slice(0, minHigh).forEach(add);
  unreachable.slice(0, Math.ceil(limit * 0.2)).forEach(add);
  // fill the rest uniformly at random across everything
  for (const c of shuffle(coverage, rng)) { if (picked.size >= limit) break; add(c); }
  return [...picked.values()];
}

// ---------------------------------------------------------------------------
// Prompt builder (pure)
// ---------------------------------------------------------------------------

export function buildJudgePrompt(sample: UnitCoverage[], judgeOutputPath: string): string {
  const targets = sample
    .map((c, i) => `${i + 1}. \`${c.unit}/\`  (stage-1: ${c.hops === null ? 'UNREACHABLE' : `reachable in ${c.hops} hops via ${c.viaDoc}`})`)
    .join('\n');
  return `# Task: documentation-reachability judge (Stage 2)

For each TARGET below, judge whether this repo's **documentation** would let an AI coding agent
navigate from the root \`AGENTS.md\` to that code, and whether the docs along the way actually
**orient** the agent (say what the code is + name key files). This is a quality judgment.

## Rules

- **Start at \`AGENTS.md\`** (repo root). Follow only links that genuinely exist in the docs you open
  (root \`AGENTS.md\` → hub/overview → narrower doc → target). You MAY open \`docs/project/*.md\` and
  nested \`AGENTS.md\`. Do NOT use repo-wide code search to "find" the target — navigate via docs only.
- The stage-1 hint (reachable/unreachable) may be WRONG — verify it yourself by traversing. If you
  find a real doc route stage-1 missed, grade on what you find.
- Open the target dir's index/main file ONCE to check the final doc's description matches the code.
- A short, accurate one-line signpost counts as a PASS — brevity is never penalised.

## Grades

- \`PASS_EXACT\` — docs led you to the exact dir/file AND a doc on the route accurately describes it.
- \`PASS_AREA\` — docs led you to the owning area with a clear, correct sense of its responsibility.
- \`WEAK\` — you reached something related but the docs are too vague/misleading to act on.
- \`FAIL\` — no documentation route reaches it within 5 hops.

## TARGETS

${targets}

## OUTPUT — write JSON to \`${judgeOutputPath}\` (this is your deliverable; create only this file)

\`\`\`json
{
  "results": [
    {
      "unit": "<the target path, no trailing slash>",
      "grade": "PASS_EXACT | PASS_AREA | WEAK | FAIL",
      "route": ["AGENTS.md", "docs/project/SOME_HUB.md", "..."],
      "citedPaths": ["<every repo file/dir path you cite as evidence, e.g. the doc line's link target and the code file you opened>"],
      "descriptionAccurate": true,
      "justification": "<one sentence>"
    }
  ]
}
\`\`\`

\`route\` = the .md docs you opened in order (repo-relative). \`citedPaths\` = every concrete repo path
you reference as evidence (route docs may repeat here; include the target code files you opened).
Be a strict, honest judge: if no route exists, \`FAIL\` — do not invent a path.`;
}

// ---------------------------------------------------------------------------
// Verifier — deterministic post-check (anti-hallucination)
// ---------------------------------------------------------------------------

export interface JudgeResultRaw {
  unit: string;
  grade: string;
  route?: string[];
  citedPaths?: string[];
  descriptionAccurate?: boolean;
  justification?: string;
}

export interface VerifiedResult extends JudgeResultRaw {
  grade: JudgeGrade | 'INVALID';
  /** repo-relative paths the judge cited that do NOT exist on disk (hallucination signal) */
  missingCited: string[];
  /** true if the judgment is trustworthy: valid grade + all cited paths exist */
  trustworthy: boolean;
}

export function verifyJudgeOutput(raw: JudgeResultRaw[], repoRoot: string): VerifiedResult[] {
  return raw.map((r) => {
    const cited = [...(r.route ?? []), ...(r.citedPaths ?? [])];
    const missingCited = cited.filter((p) => {
      const clean = p.replace(/#.*$/, '').replace(/:[0-9]+$/, '').replace(/\/+$/, '');
      return clean.length > 0 && !fs.existsSync(path.join(repoRoot, clean));
    });
    const validGrade = (GRADES as readonly string[]).includes(r.grade);
    return {
      ...r,
      grade: validGrade ? (r.grade as JudgeGrade) : 'INVALID',
      missingCited,
      trustworthy: validGrade && missingCited.length === 0,
    };
  });
}

export function renderJudgeReport(verified: VerifiedResult[]): string {
  const counts: Record<string, number> = {};
  for (const v of verified) counts[v.grade] = (counts[v.grade] ?? 0) + 1;
  const untrusted = verified.filter((v) => !v.trustworthy);
  const lines: string[] = [];
  lines.push('# Doc-Reachability — Stage 2 (LLM-traversal judge) report');
  lines.push('');
  lines.push('> An LLM traversed the docs from `AGENTS.md` and graded whether they *orient* an agent');
  lines.push('> to each target. Every cited path was then verified to exist on disk; a judgment with a');
  lines.push('> missing cited path is flagged **untrustworthy** (possible hallucinated route).');
  lines.push('');
  lines.push(`**Grades:** ${GRADES.map((g) => `${g}=${counts[g] ?? 0}`).join(' · ')}` + (counts.INVALID ? ` · INVALID=${counts.INVALID}` : ''));
  lines.push(`**Untrustworthy (missing cited paths): ${untrusted.length}/${verified.length}**`);
  lines.push('');
  lines.push('| Unit | Grade | Desc OK? | Trustworthy | Justification |');
  lines.push('|------|-------|----------|-------------|---------------|');
  for (const v of verified) {
    lines.push(`| \`${v.unit}\` | ${v.grade} | ${v.descriptionAccurate ? 'yes' : 'no'} | ${v.trustworthy ? 'yes' : '⚠️ no'} | ${(v.justification ?? '').replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  if (untrusted.length > 0) {
    lines.push('## ⚠️ Untrustworthy judgments (verify manually)');
    for (const v of untrusted) {
      lines.push(`- \`${v.unit}\` (${v.grade}) — missing cited paths: ${v.missingCited.map((m) => `\`${m}\``).join(', ') || '(invalid grade)'}`);
    }
    lines.push('');
  }
  // Actionable: WEAK/FAIL on trustworthy judgments are the real doc-quality gaps.
  const actionable = verified.filter((v) => v.trustworthy && (v.grade === 'WEAK' || v.grade === 'FAIL'));
  if (actionable.length > 0) {
    lines.push('## Doc-quality gaps to fix (trustworthy WEAK/FAIL)');
    for (const v of actionable) lines.push(`- \`${v.unit}\` (${v.grade}) — ${v.justification ?? ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseJudgeJson(text: string): JudgeResultRaw[] {
  // tolerate a fenced ```json block or raw JSON
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const parsed = JSON.parse(body);
  const results = Array.isArray(parsed) ? parsed : parsed.results;
  if (!Array.isArray(results)) throw new Error('judge output has no `results` array');
  return results;
}

function main(): void {
  const argv = process.argv.slice(2);
  const mode = argv.find((a) => ['--prepare', '--verify', '--run'].includes(a)) ?? '--run';
  const limit = Number(argv[argv.indexOf('--limit') + 1]) || 12;
  const outDir = argv.includes('--out') ? path.resolve(argv[argv.indexOf('--out') + 1]) : path.join(ROOT, 'tmp', 'doc-reachability', 'stage2');
  const verifyArg = argv[argv.indexOf('--verify') + 1];
  fs.mkdirSync(outDir, { recursive: true });
  const judgeOutputPath = path.join(outDir, 'judge-output.json');
  const promptPath = path.join(outDir, 'judge-prompt.md');

  if (mode === '--verify') {
    const file = verifyArg && verifyArg !== '--verify' ? path.resolve(verifyArg) : judgeOutputPath;
    const verified = verifyJudgeOutput(parseJudgeJson(fs.readFileSync(file, 'utf-8')), ROOT);
    fs.writeFileSync(path.join(outDir, 'judge-report.md'), renderJudgeReport(verified));
    fs.writeFileSync(path.join(outDir, 'judge-verified.json'), JSON.stringify(verified, null, 2));
    const untrusted = verified.filter((v) => !v.trustworthy).length;
    console.log(`Stage 2 verify → ${outDir}/judge-report.md (${verified.length} judged, ${untrusted} untrustworthy)`);
    return;
  }

  // prepare (and run)
  const useRandom = argv.includes('--random');
  const { coverage } = runAudit(ROOT, 4);
  const sample = useRandom ? selectRandomSample(coverage, limit) : selectJudgeSample(coverage, limit);
  fs.writeFileSync(path.join(outDir, 'judge-sample.json'), JSON.stringify(sample, null, 2));
  fs.writeFileSync(promptPath, buildJudgePrompt(sample, path.relative(ROOT, judgeOutputPath)));
  console.log(`Stage 2 prepare → ${promptPath} (${sample.length} units sampled)`);

  if (mode === '--prepare') {
    console.log('Next: dispatch Composer-2 at the prompt (it writes judge-output.json), then re-run with --verify.');
    return;
  }

  // --run: dispatch Composer-2 end-to-end via the cursor subagent dispatcher
  const dispatcher = path.join(ROOT, 'coding-agent-instructions', 'scripts', 'dispatch-cursor-subagent.ts');
  if (!fs.existsSync(dispatcher)) {
    console.log(`Dispatcher not found (${dispatcher}); run --prepare then dispatch Composer-2 manually, then --verify.`);
    return;
  }
  try {
    execFileSync('npx', ['tsx', dispatcher,
      '--planning-folder', 'docs/plans/260614_doc_reachability_audit',
      '--activity', 'implementer', '--event', 'stage_implementation', '--phase', '4',
      // --model is required by the dispatcher (no default); this audit deliberately uses
      // the cheap Composer judge.
      '--model', 'composer-2.5',
      '--access', 'edits', '--workspace', ROOT, '--label', 'stage2-judge',
      '--timeout-minutes', '30', '--prompt-file', promptPath,
    ], { cwd: ROOT, stdio: 'inherit' });
  } catch {
    // The dispatcher can exit non-zero on *post-run* stamping (e.g. session_id / CE2_JUDGMENT block)
    // even when Composer-2 succeeded and wrote the output file. Don't discard a good run — fall
    // through and let the file-existence check below decide.
  }
  if (!fs.existsSync(judgeOutputPath)) {
    console.log(`Judge did not write ${judgeOutputPath}; the prompt is ready — dispatch Composer-2 manually, then re-run with --verify.`);
    return;
  }
  const verified = verifyJudgeOutput(parseJudgeJson(fs.readFileSync(judgeOutputPath, 'utf-8')), ROOT);
  fs.writeFileSync(path.join(outDir, 'judge-report.md'), renderJudgeReport(verified));
  fs.writeFileSync(path.join(outDir, 'judge-verified.json'), JSON.stringify(verified, null, 2));
  console.log(`Stage 2 run complete → ${outDir}/judge-report.md`);
}

if (require.main === module) main();
