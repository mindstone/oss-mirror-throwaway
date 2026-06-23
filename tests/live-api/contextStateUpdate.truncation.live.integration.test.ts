/**
 * Red→green live repro for the context-state compaction truncation bug.
 *
 * Bug (confirmed against the local cost-ledger: 229/250 `compaction-bts` rows
 * failed, 241/250 with `outTok` pinned at exactly 2000): `updateContextStateViaLLM`
 * asks a model to emit the FULL JSON context-state but caps output at
 * `maxTokens: 2000`. When the faithful state exceeds 2000 output tokens the JSON
 * is truncated mid-structure, `JSON.parse` throws, the call returns `ok:false`,
 * the caller skips the prune, and the attempt is still billed.
 *
 * This file drives a REAL cheap model (DeepSeek V4 Flash and Haiku, both via
 * OpenRouter — gated on TEST_OPENROUTER_API_KEY) with a pruned payload large
 * enough that a faithful state exceeds the cap.
 *
 *  - `mechanism` it: proves the failure is *truncation* (`stopReason` ===
 *    length/max_tokens) and not a model-stupidity parse failure. Stable — it
 *    passes an explicit `maxTokens: 2000`, so it documents the mechanism forever.
 *  - `end-to-end` it: calls `updateContextStateViaLLM` with the production cap.
 *    Asserts `ok === true` + that a known injected fact survives (fidelity, not
 *    just parseability). This is RED on the unfixed code (cap 2000 → ok:false)
 *    and turns GREEN once the cap is raised / state is bounded.
 *
 * Gating: SOLELY on TEST_OPENROUTER_API_KEY (loaded from .env.test by
 * vitest.setup.ts). Absent key → describe SKIPS, never fails.
 */
import { expect, it } from 'vitest';
import { createClientForModel } from '@core/rebelCore/clientFactory';
import type { CreateParams } from '@core/rebelCore/modelClient';
import type { ChatMessage, TextBlock } from '@core/rebelCore/modelTypes';
import type { RebelCoreContextState } from '@core/rebelCore/taskState';
import { createEmptyContextState } from '@core/rebelCore/taskState';
import { updateContextStateViaLLM } from '@core/rebelCore/contextStateUpdate';
import { PRESERVATION_CATEGORIES } from '@core/rebelCore/contextPreservation';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import type { AppSettings } from '@shared/types';
import type { ModelProfile } from '@shared/types/settings';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { describeLiveApi } from '../../src/test-utils/liveApiHarness';

const LIVE_TIMEOUT_MS = 90_000;

/** A distinctive marker injected into the payload; must survive into the state (fidelity). */
const SENTINEL_PATH = 'src/zzz/SENTINEL_MARKER_42_keep_this.ts';
const SENTINEL_GOAL = 'SENTINEL-GOAL-9f3a: ship the quarterly board deck by Friday';

/** Reconstruct the exact system prompt updateContextStateViaLLM uses (local fn there). */
function buildUpdatePrompt(): string {
  const categoriesText = PRESERVATION_CATEGORIES.map(
    (cat, i) => `${i + 1}. ${cat.key}: ${cat.instruction}`,
  ).join('\n');
  return getPrompt(PROMPT_IDS.AGENT_CONTEXT_STATE_UPDATE, { categories: categoriesText });
}

/**
 * Build a pruned tool-interaction payload whose faithful summary lands between
 * the old cap (2000 — so the mechanism test truncates) and the new cap (8192 —
 * so the end-to-end test fits with margin). ~22 distinct decisions/artifacts,
 * each a meaty paragraph; the prompt instructs the model to preserve all of them.
 * (A real single prune is ~5 tool pairs plus the bounded prior state — far
 * smaller; this is a deliberately heavy but in-range batch.)
 */
function buildLargePrunedMessages(): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < 22; i++) {
    const id = `tool_${i}`;
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'investigate_module', input: { target: `module_${i}` } }],
    });
    const isSentinel = i === 17;
    const findingPath = isSentinel ? SENTINEL_PATH : `src/modules/module_${i}/handler_${i}.ts`;
    const decision = isSentinel
      ? `DECISION ${i}: adopt the deck-export pipeline so we can meet the goal "${SENTINEL_GOAL}". `
      : `DECISION ${i}: chose approach_${i} over alt_${i} because of latency constraint c_${i}. `;
    const result =
      `${decision}` +
      `We modified ${findingPath} to add capability cap_${i}. ` +
      `Constraint: the feature must stay under budget_${i}ms and never block the main thread. ` +
      `Rejected alternative alt_${i} (too much memory). Blocker b_${i}: waiting on review from team_${i}. ` +
      `Remaining work r_${i}: wire telemetry and add a regression test for edge_${i}. ` +
      `Artifact: ${findingPath} (identifier handler_${i}). Accomplished a_${i}: prototype verified locally.`;
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: result }],
    });
  }
  return messages;
}

/** Seed state carrying the sentinel goal, so we can also assert pre-existing facts are not lost. */
function buildSeedState(): RebelCoreContextState {
  return {
    ...createEmptyContextState(),
    taskContext: { goals: SENTINEL_GOAL, constraints: '', requirements: '' },
  };
}

function makeSettings(): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: { enabled: false },
    models: {
      apiKey: 'dummy-anthropic-key-not-used',
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-sonnet-4-20250514',
      permissionMode: 'plan',
      executablePath: null,
      planMode: true,
      extendedContext: false,
    },
    diagnostics: { enabled: false },
    localModel: { profiles: [], activeProfileId: null },
  } as unknown as AppSettings;
}

function textOf(content: ReadonlyArray<{ type: string }>): string {
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

const TRUNCATION_STOP_REASONS = new Set(['length', 'max_tokens']);

// Both models prove the truncation *mechanism*. Only the fast, non-reasoning
// model runs the end-to-end GREEN assertion: DeepSeek V4 Flash is a reasoning
// model that spends output tokens on a hidden trace, so emitting the full state
// at the raised cap exceeds the (deliberately bounded) compaction timeout — a
// model-suitability limit, not the compaction bug. Production routes compaction
// to a fast model (see Stage 4), which Haiku represents.
const MODELS: ReadonlyArray<{ id: string; endToEnd: boolean }> = [
  { id: 'deepseek/deepseek-v4-flash', endToEnd: false },
  { id: 'anthropic/claude-haiku-4-5', endToEnd: true },
];

for (const { id: modelId, endToEnd } of MODELS) {
  const MODEL = unsafeAssertRoutingModelId(modelId);

  describeLiveApi(
    {
      provider: 'openrouter',
      label: `Context-state compaction truncation — ${modelId} (live)`,
      envVar: 'TEST_OPENROUTER_API_KEY',
      model: MODEL,
    },
    ({ key }) => {
      const profile = {
        id: `openrouter-${modelId}-ctxstate-test`,
        name: `OpenRouter ${modelId} (ctx-state test)`,
        providerType: 'openrouter',
        serverUrl: 'https://openrouter.ai/api/v1',
        apiKey: key,
        model: MODEL,
        enabled: true,
      } as unknown as ModelProfile;

      it(
        'mechanism: full-state prompt at maxTokens:2000 truncates on a large payload (not a parse-stupidity failure)',
        async () => {
          const settings = makeSettings();
          const client = await createClientForModel({ model: MODEL, profile, settings });

          const prunedText = JSON.stringify(buildLargePrunedMessages(), null, 2);
          const userPrompt =
            `Current State:\n${JSON.stringify(buildSeedState(), null, 2)}\n\n` +
            `Pruned Interactions:\n${prunedText}\n\nReturn the updated JSON state.`;

          const params: CreateParams = {
            model: MODEL,
            systemPrompt: buildUpdatePrompt(),
            messages: [{ role: 'user', content: userPrompt }],
            maxTokens: 2000, // the buggy production cap, passed explicitly
          };

          const res = await client.create(params);

          // The output token count sits at (or essentially at) the 2000 cap …
          console.warn(
            `[live] ${modelId}: stopReason=${res.stopReason} outputTokens=${res.usage.outputTokens}`,
          );
          // … and the model wanted more — proving TRUNCATION, not malformed output.
          expect(TRUNCATION_STOP_REASONS.has(res.stopReason)).toBe(true);

          // The truncated text does not parse as the complete state JSON.
          const out = textOf(res.content);
          const match = out.match(/\{.*\}/s);
          let parsed = false;
          if (match) {
            try {
              JSON.parse(match[0]);
              parsed = true;
            } catch {
              parsed = false;
            }
          }
          expect(parsed).toBe(false);
        },
        LIVE_TIMEOUT_MS,
      );

      (endToEnd ? it : it.skip)(
        'updateContextStateViaLLM succeeds on a large pruned payload and preserves known facts (RED until cap raised / state bounded)',
        async () => {
          const settings = makeSettings();
          const client = await createClientForModel({ model: MODEL, profile, settings });

          const result = await updateContextStateViaLLM(
            client,
            MODEL,
            buildSeedState(),
            buildLargePrunedMessages(),
          );

          // RED on unfixed code: cap 2000 truncates → ok:false. GREEN after Stage 1/2.
          expect(
            result.ok,
            `failureReason=${result.failureReason} outputTokens=${result.usage?.outputTokens}`,
          ).toBe(true);

          // Fidelity (not just parseability): the seeded goal and the injected
          // sentinel artifact must survive into the merged state. The schema uses
          // .catch()/.partial(), so a parseable-but-empty state would pass ok:true
          // without these checks.
          const serialized = JSON.stringify(result.state);
          expect(serialized).toContain('SENTINEL-GOAL-9f3a');
          expect(serialized).toContain('SENTINEL_MARKER_42');
        },
        LIVE_TIMEOUT_MS,
      );
    },
  );
}
