import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MAX_COMPACTION_DEPTH,
  MAX_COMPACTION_ATTEMPTS,
} from '@core/utils/compactionUtils';

/**
 * Stage 2 structural fence — counter-axes consolidation.
 *
 * Parent plan: docs/plans/260503_unified_recovery_pipeline.md (§6 Stage 2, §1 success criterion 1)
 *
 * The unified recovery pipeline preserves TWO orthogonal counter axes:
 *   - MAX_COMPACTION_ATTEMPTS = 3 (within-API-loop retries; Anthropic SDK inner loop)
 *   - MAX_COMPACTION_DEPTH    = 3 (cross-resetConversation retries; pipeline outer loop)
 *
 * Both must be canonically declared in src/core/utils/compactionUtils.ts and
 * import-traced from there in every consumer. Future agents collapsing the two
 * axes (or shadowing them with divergent local values, as the renderer's
 * useAgentSessionEngine.ts:428 currently does with MAX_COMPACTION_DEPTH = 2)
 * would silently re-introduce the cross-layer drift bug that motivated this
 * rebuild. This test fails loudly when that happens.
 *
 * Out-of-scope exemption: the renderer recovery loop in
 * useAgentSessionEngine.ts:422-835 still has a divergent local
 * `const MAX_COMPACTION_DEPTH = 2`. Stage 4 cuts over the renderer loop and
 * removes that file's recovery code wholesale — at which point the exemption
 * below disappears. Until then, the test allowlists exactly that file.
 */

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

const RECOVERY_PIPELINE_FILES = [
  'src/core/services/recovery/recoveryStateMachine.ts',
  'src/core/services/recovery/recoveryPipeline.ts',
  'src/core/services/recovery/recoveryEvents.ts',
  'src/core/services/recovery/recoveryAdapter.ts',
];

const CANONICAL_DECLARATION_SITE = 'src/core/utils/compactionUtils.ts';

const RENDERER_SHADOW_TO_REMOVE_IN_STAGE_4 =
  'src/renderer/features/agent-session/hooks/useAgentSessionEngine.ts';

describe('Stage 2 — counter axes structural fence', () => {
  it('I1: MAX_COMPACTION_DEPTH is an integer ≤ 5', () => {
    expect(Number.isInteger(MAX_COMPACTION_DEPTH)).toBe(true);
    expect(MAX_COMPACTION_DEPTH).toBeGreaterThan(0);
    expect(MAX_COMPACTION_DEPTH).toBeLessThanOrEqual(5);
    expect(MAX_COMPACTION_DEPTH).toBe(3);
  });

  it('MAX_COMPACTION_ATTEMPTS is an integer ≤ 5', () => {
    expect(Number.isInteger(MAX_COMPACTION_ATTEMPTS)).toBe(true);
    expect(MAX_COMPACTION_ATTEMPTS).toBeGreaterThan(0);
    expect(MAX_COMPACTION_ATTEMPTS).toBeLessThanOrEqual(5);
    expect(MAX_COMPACTION_ATTEMPTS).toBe(3);
  });

  it('the two axes are orthogonal (declared as distinct integer constants, not aliased)', () => {
    expect(MAX_COMPACTION_ATTEMPTS).not.toBe(undefined);
    expect(MAX_COMPACTION_DEPTH).not.toBe(undefined);
    const canonicalSource = readFileSync(resolve(REPO_ROOT, CANONICAL_DECLARATION_SITE), 'utf-8');
    expect(canonicalSource).toMatch(/export const MAX_COMPACTION_DEPTH\s*=\s*\d+/);
    expect(canonicalSource).toMatch(/export const MAX_COMPACTION_ATTEMPTS\s*=\s*\d+/);
  });

  it('both constants are declared exactly once (canonical site only)', () => {
    const canonicalDeclRegex = /export\s+const\s+MAX_COMPACTION_(DEPTH|ATTEMPTS)\s*=\s*\d+/g;
    const localDeclRegex = /(?:^|\s)const\s+MAX_COMPACTION_(?:DEPTH|ATTEMPTS|RECOVERY_[A-Z_]+)\s*=/gm;

    const canonicalSource = readFileSync(resolve(REPO_ROOT, CANONICAL_DECLARATION_SITE), 'utf-8');
    const canonicalMatches = canonicalSource.match(canonicalDeclRegex) ?? [];
    expect(canonicalMatches.length).toBe(2);

    for (const file of RECOVERY_PIPELINE_FILES) {
      const source = readFileSync(resolve(REPO_ROOT, file), 'utf-8');
      const localMatches = source.match(localDeclRegex) ?? [];
      expect(localMatches, `${file} must not redeclare MAX_COMPACTION_* constants locally`).toEqual([]);
    }
  });

  it('every recovery pipeline file that uses MAX_COMPACTION_* import-traces from compactionUtils', () => {
    for (const file of RECOVERY_PIPELINE_FILES) {
      const source = readFileSync(resolve(REPO_ROOT, file), 'utf-8');
      const usesDepth = /MAX_COMPACTION_DEPTH/.test(source);
      const usesAttempts = /MAX_COMPACTION_ATTEMPTS/.test(source);

      if (!usesDepth && !usesAttempts) continue;

      const importsFromCanonical =
        /import\s+\{[^}]*MAX_COMPACTION_(?:DEPTH|ATTEMPTS)[^}]*\}\s+from\s+['"]@core\/utils\/compactionUtils['"]/.test(source) ||
        /from\s+['"]@core\/services\/recovery\/recoveryStateMachine['"]/.test(source);

      expect(
        importsFromCanonical,
        `${file} uses MAX_COMPACTION_* but does not import-trace from compactionUtils.ts (canonical site) or recoveryStateMachine.ts (re-export)`
      ).toBe(true);
    }
  });

  it('agentLoop.ts imports MAX_COMPACTION_ATTEMPTS from compactionUtils (no private redeclaration)', () => {
    const agentLoopPath = resolve(REPO_ROOT, 'src/core/rebelCore/agentLoop.ts');
    const source = readFileSync(agentLoopPath, 'utf-8');

    expect(source).toMatch(
      /import\s+\{[^}]*MAX_COMPACTION_ATTEMPTS[^}]*\}\s+from\s+['"]@core\/utils\/compactionUtils['"]/
    );
    expect(source, 'agentLoop.ts must not declare MAX_COMPACTION_ATTEMPTS locally').not.toMatch(
      /^(?!.*export).*const\s+MAX_COMPACTION_ATTEMPTS\s*=/m
    );
  });

  // Renderer shadow was removed in Stage 4 — exemption deleted per test instructions.
});
