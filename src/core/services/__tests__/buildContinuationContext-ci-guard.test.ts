/**
 * CI guard for Stage 2 of `docs/plans/260525_cross_turn_awareness_layer1_layer2.md`.
 *
 * Both proactive injection sites in the agent turn pipeline must route
 * through `buildContinuationContext` so the resulting prefix has at most
 * ONE `<prior_turns>` block AND at most ONE `<conversation_history>`
 * block. New production callers that bypass the wrapper would silently
 * re-introduce the double-injection class of bugs.
 *
 * Scope: production source under `src/` (excluding `__tests__` and the
 * canonical wrapper / recovery fallback site). Tests are free to mock
 * `loadConversationHistory` directly.
 */
import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const ALLOWLIST = new Set<string>([
  'src/core/services/buildContinuationContext.ts',
  'src/core/services/conversationHistoryService.ts',
  'src/main/services/conversationHistoryService.ts',
  'src/main/services/turnErrorRecovery.ts',
]);

describe('buildContinuationContext CI guard', () => {
  it('blocks new direct loadConversationHistory imports outside the canonical wrapper', () => {
    const stdout = execSync(
      'rg --files-with-matches "loadConversationHistory" src --glob "*.ts" --glob "*.tsx" --glob "!**/__tests__/**" --glob "!**/*.test.ts" --glob "!**/*.test.tsx" || true',
      { cwd: REPO_ROOT, encoding: 'utf-8' },
    );
    const offenders = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((relPath) => !ALLOWLIST.has(relPath));

    expect(offenders, `Unauthorized direct loadConversationHistory references: ${offenders.join(', ')}`).toEqual([]);
  });
});
