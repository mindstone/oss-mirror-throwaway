/**
 * Unit tests for the R2 S2-CG manifest-guard walker.
 *
 * Tests `checkSourceText()` against the three rules:
 *
 *   (a) `no-defineAgentEvent-outside-manifest`
 *   (b) `no-shadow-derived-export`
 *   (c) `no-spread-in-defineAgentEvent` (Phase-6 spread-aware)
 *
 * @see scripts/check-agent-event-manifest.ts
 * @see docs/plans/260427_refactor_contract_manifest.md
 * @see docs/plans/260429_r2_stage2_chunked_implementation_plan.md
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  checkSourceText,
  type ManifestGuardRule,
  type Violation,
} from '../check-agent-event-manifest';

const ROOT = '/repo';
const MANIFEST = path.join(
  ROOT,
  'src',
  'shared',
  'contracts',
  'agentEventManifest.ts',
);
const POLICY_MANIFEST = path.join(
  ROOT,
  'src',
  'shared',
  'contracts',
  'agentEventPolicyManifest.ts',
);
const CONSUMER = path.join(ROOT, 'src', 'main', 'services', 'consumer.ts');
const TEST_FILE = path.join(
  ROOT,
  'src',
  'shared',
  'contracts',
  '__tests__',
  'agentEventManifest.test.ts',
);
const ALLOWED_SHADOW_AGENT = path.join(
  ROOT,
  'src',
  'shared',
  'ipc',
  'schemas',
  'agent.ts',
);
const ALLOWED_SHADOW_COMPACTION = path.join(
  ROOT,
  'src',
  'shared',
  'utils',
  'eventCompaction.ts',
);

function rules(violations: Violation[]): ManifestGuardRule[] {
  return violations.map((v) => v.rule);
}

describe('S2-CG: rule (a) — defineAgentEvent outside the manifest module', () => {
  it('detects defineAgentEvent() called in production code outside the manifest', () => {
    const source = `
      import { defineAgentEvent } from '@shared/contracts/agentEventManifest';
      export const rogue = defineAgentEvent({
        type: 'rogue',
        payloadSchema: someSchema,
      });
    `;
    const v = checkSourceText(source, CONSUMER, ROOT);
    expect(rules(v)).toContain('no-defineAgentEvent-outside-manifest');
  });

  it('does NOT flag defineAgentEvent inside the manifest module itself', () => {
    const source = `
      const m = {
        status: defineAgentEvent({ type: 'status', payloadSchema: s }),
      };
    `;
    const v = checkSourceText(source, MANIFEST, ROOT);
    expect(rules(v)).not.toContain('no-defineAgentEvent-outside-manifest');
  });

  it('does NOT flag defineAgentEvent inside test files (legitimate fixture construction)', () => {
    const source = `
      const fixture = defineAgentEvent({
        type: 'fixture',
        payloadSchema: s,
        ...somePolicy,
      });
    `;
    const v = checkSourceText(source, TEST_FILE, ROOT);
    expect(rules(v)).not.toContain('no-defineAgentEvent-outside-manifest');
  });

  it('does NOT flag a method named defineAgentEvent on an object (different identifier path)', () => {
    const source = `
      myUtils.defineAgentEvent({ type: 'x' });
    `;
    const v = checkSourceText(source, CONSUMER, ROOT);
    expect(rules(v)).not.toContain('no-defineAgentEvent-outside-manifest');
  });
});

describe('S2-CG: rule (b) — hand-edits to derived export names', () => {
  it('detects export const AgentEventSchema outside the allowlist', () => {
    const source = `export const AgentEventSchema = z.discriminatedUnion('type', []);`;
    const v = checkSourceText(source, CONSUMER, ROOT);
    expect(rules(v)).toContain('no-shadow-derived-export');
  });

  it('detects export const COMPACTION_POLICY outside the allowlist', () => {
    const source = `export const COMPACTION_POLICY = { tool: 'compact' } as const;`;
    const v = checkSourceText(source, CONSUMER, ROOT);
    expect(rules(v)).toContain('no-shadow-derived-export');
  });

  it('detects export const SANITIZATION_POLICY anywhere outside the manifest modules', () => {
    const source = `export const SANITIZATION_POLICY = { tool: 'pass-through' };`;
    const v1 = checkSourceText(source, CONSUMER, ROOT);
    expect(rules(v1)).toContain('no-shadow-derived-export');
    const v2 = checkSourceText(source, ALLOWED_SHADOW_AGENT, ROOT);
    expect(rules(v2)).toContain('no-shadow-derived-export');
  });

  it('detects export const buildAgentEvent anywhere outside the manifest modules', () => {
    const source = `export const buildAgentEvent = {} as Record<string, unknown>;`;
    const v = checkSourceText(source, CONSUMER, ROOT);
    expect(rules(v)).toContain('no-shadow-derived-export');
  });

  it('does NOT flag export const AgentEventSchema in the allowlisted shadow-derive site (src/shared/ipc/schemas/agent.ts)', () => {
    const source = `export const AgentEventSchema = z.discriminatedUnion('type', []);`;
    const v = checkSourceText(source, ALLOWED_SHADOW_AGENT, ROOT);
    expect(rules(v)).not.toContain('no-shadow-derived-export');
  });

  it('flags export const COMPACTION_POLICY at src/shared/utils/eventCompaction.ts post-Stage-3a-L1 cutover (allowlist entry removed)', () => {
    // R2 Stage 3a-L1 (2026-05-01): eventCompaction.ts now consumes
    // COMPACTION_POLICY_FROM_MANIFEST directly, so the shadow-derive allowlist
    // entry for that file was removed. A future re-introduction of an
    // `export const COMPACTION_POLICY` at that site must FAIL the guard so it
    // can't silently regress the cutover.
    const source = `export const COMPACTION_POLICY = {} as const;`;
    const v = checkSourceText(source, ALLOWED_SHADOW_COMPACTION, ROOT);
    expect(rules(v)).toContain('no-shadow-derived-export');
  });

  it('does NOT flag any guarded name when declared in the manifest module itself', () => {
    const source = `
      export const AgentEventSchema = m.discriminatedUnion();
      export const COMPACTION_POLICY = m.compactionPolicy();
      export const SANITIZATION_POLICY = m.sanitizationPolicy();
      export const buildAgentEvent = m.builder();
    `;
    const v = checkSourceText(source, MANIFEST, ROOT);
    expect(rules(v)).not.toContain('no-shadow-derived-export');
  });

  it('does NOT flag a non-guarded name', () => {
    const source = `export const someOtherPolicy = {};`;
    const v = checkSourceText(source, CONSUMER, ROOT);
    expect(rules(v)).not.toContain('no-shadow-derived-export');
  });

  it('does NOT flag legitimate consumer reads (imports, references) of guarded names', () => {
    const source = `
      import { AgentEventSchema, COMPACTION_POLICY } from '@shared/contracts/agentEventManifest';
      const x = AgentEventSchema;
      function f() { return COMPACTION_POLICY; }
    `;
    const v = checkSourceText(source, CONSUMER, ROOT);
    expect(rules(v)).not.toContain('no-shadow-derived-export');
  });

  it('flags an un-allowlisted COMPACTION_POLICY even at a shadow-derive site for a DIFFERENT name', () => {
    // Ensures the allowlist is per-name, not per-file.
    const source = `export const COMPACTION_POLICY = {};`;
    const v = checkSourceText(source, ALLOWED_SHADOW_AGENT, ROOT);
    expect(rules(v)).toContain('no-shadow-derived-export');
  });
});

describe('S2-CG: rule (c) — spread expressions inside defineAgentEvent nested-axis positions (Phase-6 spread-aware)', () => {
  it('flags spread inside `envelope: { ... }` of a defineAgentEvent argument', () => {
    const source = `
      const m = {
        tool: defineAgentEvent({
          type: 'tool',
          envelope: { ...baseEnv, requiredForNewEvents: ['turnId'] },
        }),
      };
    `;
    const v = checkSourceText(source, MANIFEST, ROOT);
    expect(rules(v)).toContain('no-spread-in-defineAgentEvent');
  });

  it('flags spread inside `envelope: { persistence: { ... } }` (DEEP-nested — gemini P0 #1 recursion fix)', () => {
    // The real schema has `envelope.persistence: PersistenceFlags`,
    // NOT `persistence:` at the defineAgentEvent top level.
    // Recursive walker required to catch this real-shape bypass.
    const source = `
      const m = {
        tool: defineAgentEvent({
          type: 'tool',
          envelope: {
            requiredForNewEvents: ['turnId'],
            persistence: { ...defaults, mainAccumulator: true },
          },
        }),
      };
    `;
    const v = checkSourceText(source, MANIFEST, ROOT);
    expect(rules(v)).toContain('no-spread-in-defineAgentEvent');
  });

  it('flags spread inside any nested object literal at any depth (recursive walker)', () => {
    const source = `
      const m = {
        tool: defineAgentEvent({
          type: 'tool',
          envelope: {
            persistence: {
              meta: {
                deeplyNested: { ...maliciousVar },
              },
            },
          },
        }),
      };
    `;
    const v = checkSourceText(source, MANIFEST, ROOT);
    expect(rules(v)).toContain('no-spread-in-defineAgentEvent');
  });

  it('does NOT flag top-level spread INTO defineAgentEvent (legitimate composition pattern)', () => {
    const source = `
      const m = {
        tool: defineAgentEvent({
          ...agentEventPolicyManifest.tool,
          type: 'tool',
          payloadSchema: someSchema,
        }),
      };
    `;
    const v = checkSourceText(source, MANIFEST, ROOT);
    expect(rules(v)).not.toContain('no-spread-in-defineAgentEvent');
  });

  it('does NOT flag spread inside `payloadSchema: z.object({ ... })` (Zod, not nested-axis)', () => {
    const source = `
      const m = {
        tool: defineAgentEvent({
          type: 'tool',
          payloadSchema: z.object({
            field: z.string(),
            ...seqPayloadShape,
          }),
        }),
      };
    `;
    const v = checkSourceText(source, MANIFEST, ROOT);
    expect(rules(v)).not.toContain('no-spread-in-defineAgentEvent');
  });

  it('does NOT flag any spread when defineAgentEvent is called outside the manifest module (rule (a) handles that case independently)', () => {
    const source = `
      defineAgentEvent({
        type: 'rogue',
        envelope: { ...maliciousVar },
      });
    `;
    const v = checkSourceText(source, CONSUMER, ROOT);
    expect(rules(v)).not.toContain('no-spread-in-defineAgentEvent');
    // But (a) still fires:
    expect(rules(v)).toContain('no-defineAgentEvent-outside-manifest');
  });

  it('reports each nested-axis spread separately (multiple positions in same call)', () => {
    const source = `
      const m = {
        tool: defineAgentEvent({
          type: 'tool',
          envelope: {
            requiredForNewEvents: [],
            persistence: { ...a, mainAccumulator: true },
          },
          payloadShim: { ...b },
        }),
      };
    `;
    const v = checkSourceText(source, MANIFEST, ROOT);
    const spreadViolations = v.filter(
      (x) => x.rule === 'no-spread-in-defineAgentEvent',
    );
    expect(spreadViolations).toHaveLength(2);
  });

  it('does NOT flag spread inside an arrayed object inside z.object — Zod nested usage is allowed', () => {
    const source = `
      const m = {
        tool: defineAgentEvent({
          type: 'tool',
          payloadSchema: z.object({
            wrapper: z.object({
              ...sharedZodShape,
            }),
          }),
        }),
      };
    `;
    const v = checkSourceText(source, MANIFEST, ROOT);
    expect(rules(v)).not.toContain('no-spread-in-defineAgentEvent');
  });
});

describe('S2-CG: rule (a) — alias-bypass coverage (gemini3.1-pro P1)', () => {
  it('detects defineAgentEvent invoked under an import alias (`as foo`)', () => {
    const source = `
      import { defineAgentEvent as foo } from '@shared/contracts/agentEventManifest';
      foo({ type: 'rogue', payloadSchema: s });
    `;
    const v = checkSourceText(source, CONSUMER, ROOT);
    expect(rules(v)).toContain('no-defineAgentEvent-outside-manifest');
    // Message should disclose the aliased name to help debugging.
    const violation = v.find(
      (x) => x.rule === 'no-defineAgentEvent-outside-manifest',
    );
    expect(violation?.message).toContain("'foo'");
  });

  it('detects defineAgentEvent invoked via local const-alias', () => {
    const source = `
      import { defineAgentEvent } from '@shared/contracts/agentEventManifest';
      const fn = defineAgentEvent;
      fn({ type: 'rogue' });
    `;
    const v = checkSourceText(source, CONSUMER, ROOT);
    expect(rules(v)).toContain('no-defineAgentEvent-outside-manifest');
  });

  it('detects defineAgentEvent invoked via two-hop local const-alias chain', () => {
    const source = `
      import { defineAgentEvent } from '@shared/contracts/agentEventManifest';
      const fn1 = defineAgentEvent;
      const fn2 = fn1;
      fn2({ type: 'rogue' });
    `;
    const v = checkSourceText(source, CONSUMER, ROOT);
    expect(rules(v)).toContain('no-defineAgentEvent-outside-manifest');
  });
});

describe('S2-CG: smoke — manifest module itself is clean under the actual codebase', () => {
  it('the policy-manifest module is allowed to declare any names (it IS a manifest module)', () => {
    const source = `
      export const SANITIZATION_POLICY = derive();
      export const COMPACTION_POLICY = derive();
    `;
    const v = checkSourceText(source, POLICY_MANIFEST, ROOT);
    expect(rules(v)).not.toContain('no-shadow-derived-export');
  });
});
