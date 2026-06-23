/**
 * Tests for the R2 AgentEvent construction ESLint guard (chunk S2-B2).
 *
 * The rule is implemented with ESLint's built-in no-restricted-syntax, so this
 * test drives the real flat config through ESLint's public API instead of a
 * custom RuleTester harness.
 *
 * @see ../../eslint.config.mjs
 * @see docs/plans/260427_refactor_contract_manifest.md
 */

import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintSyntheticFixture } from '../../test-utils/lint-synthetic-fixture';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const agentEventRuleMessage = 'R2 AgentEvent construction guard:';

async function lintFixture(relativePath: string, source: string) {
  const result = await lintSyntheticFixture({
    filePath: join(repoRoot, relativePath),
    source,
  });
  return result.messages.filter(
    (message) =>
      message.ruleId === 'no-restricted-syntax' &&
      message.message.includes(agentEventRuleMessage),
  );
}

const agentEventImport = "import type { AgentEvent } from '@shared/types';\n";
const unknownValue = 'declare const value: unknown;\n';

describe('R2 AgentEvent no-restricted-syntax guard', () => {
  it('flags direct casts to AgentEvent in production code', async () => {
    const messages = await lintFixture(
      'src/main/services/agentEventCastFixture.ts',
      `${agentEventImport}${unknownValue}const event = value as AgentEvent;\n`,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain('use `buildAgentEvent.<type>`');
  });

  it('flags double casts through unknown to AgentEvent in production code', async () => {
    const messages = await lintFixture(
      'src/main/services/agentEventUnknownCastFixture.ts',
      `${agentEventImport}${unknownValue}const event = value as unknown as AgentEvent;\n`,
    );

    expect(messages).toHaveLength(1);
  });

  it('flags array casts to AgentEvent[] in production code', async () => {
    const messages = await lintFixture(
      'cloud-client/src/agentEventArrayCastFixture.ts',
      `${agentEventImport}${unknownValue}const events = value as AgentEvent[];\n`,
    );

    expect(messages).toHaveLength(1);
  });

  it('flags AgentEvent variant shape-coerce casts in production code', async () => {
    const messages = await lintFixture(
      'cloud-service/src/agentEventShapeCastFixture.ts',
      `${unknownValue}const event = value as { type: 'tool'; timestamp: number };\n`,
    );

    expect(messages).toHaveLength(1);
  });

  it('allows AgentEvent fixture casts in test files', async () => {
    const messages = await lintFixture(
      'src/main/services/__tests__/agentEventFixture.test.ts',
      [
        agentEventImport,
        unknownValue,
        'const event = value as AgentEvent;',
        "const shaped = value as { type: 'tool'; timestamp: number };",
      ].join('\n'),
    );

    expect(messages).toHaveLength(0);
  });

  it('allows AgentEvent construction inside src/shared/contracts', async () => {
    const messages = await lintFixture(
      'src/shared/contracts/agentEventManifest.ts',
      [
        agentEventImport,
        unknownValue,
        'const event = value as AgentEvent;',
        "const shaped = value as { type: 'tool'; timestamp: number };",
      ].join('\n'),
    );

    expect(messages).toHaveLength(0);
  });

  it('allows non-AgentEvent type-literal casts with unrelated type strings', async () => {
    const messages = await lintFixture(
      'src/main/services/nonAgentEventShapeFixture.ts',
      `${unknownValue}const event = value as { type: 'text'; text: string };\n`,
    );

    expect(messages).toHaveLength(0);
  });
});
