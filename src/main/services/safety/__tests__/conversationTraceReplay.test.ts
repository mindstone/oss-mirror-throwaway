/**
 * Conversation Trace Replay — bda78829 (AI Academy Curriculum)
 *
 * Replays the events of a real conversation against the safety pipeline and
 * asserts end-state metrics. This is the integration-level proof that the
 * approval-overasking fixes actually solve the experienced symptom.
 *
 * Stage 1 (this commit):
 *   - Loads the sanitised fixture and asserts internal consistency
 *     (the baseline metrics computed from safety-decisions.json match
 *     expected-baseline.json).
 *   - Uses the production `shouldAllow` to confirm that a "naive
 *     medium-confidence" decision oracle would have allowed many of the
 *     observed blocks if the high-confidence floor were relaxed for
 *     non-credential side-effect writes — the headline lever-B claim.
 *   - Records the *goal* assertions as `it.skip` blocks so they show in
 *     test output as TODO until the levers land.
 *
 * Later stages will:
 *   - Wire up the real evaluateSafetyPrompt + applySelectedPrinciple +
 *     consolidateSafetyPrompt cycle with mocked LLM responses (driven from
 *     the safety-prompt-versions.json timeline) and assert the rule churn
 *     (RC-4) reproduces.
 *   - Add lever-specific replays that prove each lever's claimed metric
 *     improvements.
 *
 * See: docs/plans/260525_approval_overasking_diagnostic.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { shouldAllow } from '@core/safetyPromptLogic';
import type { SafetyEvalResult } from '@core/safetyPromptTypes';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture loading
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../../..',
  'evals/fixtures/conversation-trace-replay/bda78829',
);

interface Decision {
  ts: number;
  toolDisplayName: string;
  toolId: string;
  actionSummary: string;
  decision: 'allowed' | 'blocked';
  reason: string;
  sessionType: string;
}

interface Baseline {
  conversationId: string;
  title: string;
  totalEvaluations: number;
  totalAllowed: number;
  totalBlocked: number;
  uniqueBlockedTargets: number;
  maxRepeatBlock: number;
  maxRepeatBlockTarget: string | null;
  safetyPromptVersionDelta: number;
  blockedActionSummary: Array<{ target: string; count: number }>;
}

function loadFixture(): { decisions: Decision[]; baseline: Baseline } {
  const decisions = JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, 'safety-decisions.json'), 'utf8'),
  ) as Decision[];
  const baseline = JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, 'expected-baseline.json'), 'utf8'),
  ) as Baseline;
  return { decisions, baseline };
}

function targetOf(d: Decision): string {
  return d.toolDisplayName || d.toolId || '?';
}

// ─────────────────────────────────────────────────────────────────────────────
// Baseline self-consistency
// ─────────────────────────────────────────────────────────────────────────────

describe('bda78829 fixture — self-consistency', () => {
  const { decisions, baseline } = loadFixture();

  it('matches the recorded conversation id', () => {
    expect(baseline.conversationId).toBe('bda78829-fa75-43c0-84f2-e1647cc342f1');
    expect(baseline.title).toBe('AI Academy Curriculum');
  });

  it('decision counts match the baseline summary', () => {
    expect(decisions).toHaveLength(baseline.totalEvaluations);
    const allowed = decisions.filter((d) => d.decision === 'allowed').length;
    const blocked = decisions.filter((d) => d.decision === 'blocked').length;
    expect(allowed).toBe(baseline.totalAllowed);
    expect(blocked).toBe(baseline.totalBlocked);
  });

  it('reproduces the per-target block distribution', () => {
    const blocked = decisions.filter((d) => d.decision === 'blocked');
    const counts = new Map<string, number>();
    for (const b of blocked) {
      const t = targetOf(b);
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const sortedActual = [...counts.entries()]
      .map(([target, count]) => ({ target, count }))
      .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target));
    const sortedExpected = [...baseline.blockedActionSummary].sort(
      (a, b) => b.count - a.count || a.target.localeCompare(b.target),
    );
    expect(sortedActual).toEqual(sortedExpected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostic — what would lever B (relaxed medium confidence) reduce?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Counts how many of the blocked memory writes would auto-allow if the LLM
 * evaluator had returned `{ decision: 'allow', confidence: 'medium' }` AND
 * `shouldAllow` accepted medium for side-effect tools (lever B).
 *
 * Today, `shouldAllow` rejects medium for side-effect tools — see
 * src/core/safetyPromptLogic.ts shouldAllow(). So this test demonstrates the
 * size of the "lever B" reduction in approval-prompt count.
 */
describe('bda78829 fixture — lever B sizing', () => {
  const { decisions } = loadFixture();

  // Heuristic: blocks where the production reason indicates "shared write
  // not explicitly permitted / requires approval / needs rule" — i.e., not
  // structural credential rejections — are exactly the population that lever
  // B targets. Credential / secret patterns stay blocked.
  const isSharedWriteBlock = (d: Decision): boolean =>
    d.decision === 'blocked' &&
    /shared.*(write|save|update|space)|company-wide|General space/i.test(
      d.reason,
    ) &&
    !/credential|secret|api[ -]key|password|token/i.test(d.reason);

  it('classifies the blocked writes correctly', () => {
    const blocks = decisions.filter((d) => d.decision === 'blocked');
    const sharedWriteBlocks = blocks.filter(isSharedWriteBlock);
    // We expect substantially all blocks to be shared-write writes —
    // there's only one Bash block + one untargeted Edit block in baseline.
    expect(sharedWriteBlocks.length).toBeGreaterThanOrEqual(blocks.length - 4);
  });

  it('shouldAllow accepts medium-confidence allow for Write/memory_write (not in SIDE_EFFECT_VERBS)', () => {
    // Memory writes (`memory_write`) and the built-in `Write` tool are not
    // in SIDE_EFFECT_VERBS, so the high-confidence floor that gates
    // send/post/create/edit/etc. does NOT apply to them. Once the upstream
    // LLM-eval branch is reached (via explicit `permissive` on a non-private
    // space), a routine "looks fine + medium" verdict auto-allows without
    // surfacing an approval card.
    const result: SafetyEvalResult = {
      decision: 'allow',
      confidence: 'medium',
      reason: 'shared write looks fine',
    };
    expect(shouldAllow(result, 'Write')).toBe(true);
    expect(shouldAllow(result, 'memory_write')).toBe(true);
    expect(shouldAllow(result, 'Read')).toBe(true);
    // Edit (and other side-effect verbs) still need high confidence.
    expect(shouldAllow(result, 'Edit')).toBe(false);
  });

  it('shouldAllow still gates low-confidence allow and block decisions', () => {
    const lowResult: SafetyEvalResult = {
      decision: 'allow',
      confidence: 'low',
      reason: 'unclear',
    };
    expect(shouldAllow(lowResult, 'Edit')).toBe(false);
    const blocked: SafetyEvalResult = {
      decision: 'block',
      confidence: 'high',
      reason: 'policy violation',
    };
    expect(shouldAllow(blocked, 'Edit')).toBe(false);
  });

  it('measures the headline reduction lever B targets', () => {
    const blocks = decisions.filter((d) => d.decision === 'blocked');
    const sharedWriteBlocks = blocks.filter(isSharedWriteBlock);
    // ~28 of 29 blocks are shared-write blocks. Lever B (honour explicit
    // `permissive` on the destination space) targets exactly this population.
    const reductionTarget = sharedWriteBlocks.length;
    expect(reductionTarget).toBeGreaterThan(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Goal assertions — STAGE 5+ (failing today, should pass after fixes)
// ─────────────────────────────────────────────────────────────────────────────

describe('bda78829 — goal assertions (now exercised by the simulator)', () => {
  const { baseline } = loadFixture();

  // These three assertions reproduce the *baseline* metrics. They confirm the
  // fixture still represents the bad-path observation. The post-fix metrics
  // are asserted by `conversationTraceReplay.simulator.test.ts`, which models
  // the actual code-path changes for Levers A and B.
  it('baseline still has 11 version bumps (the bad path)', () => {
    expect(baseline.safetyPromptVersionDelta).toBe(11);
  });

  it('baseline still has 14× max repeat block (the bad path)', () => {
    expect(baseline.maxRepeatBlock).toBe(14);
  });

  it('baseline still has 29 total approval prompts (the bad path)', () => {
    expect(baseline.totalBlocked).toBe(29);
  });
});
