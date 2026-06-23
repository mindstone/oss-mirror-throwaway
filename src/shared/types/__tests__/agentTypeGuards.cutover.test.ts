/**
 * R2 Stage 3a-AGT regression test (2026-05-01)
 *
 * Locks in the cutover that re-anchored `isToolEvent`, `isAssistantFamilyEvent`,
 * and the six narrowed-extract aliases (`ToolAgentEvent`, `ResultAgentEvent`,
 * `ErrorAgentEvent`, `AssistantAgentEvent`, `AssistantDeltaAgentEvent`,
 * `StatusAgentEvent`) on `AgentEventFromManifest` (manifest-derived) instead
 * of the hand-authored `AgentEvent` union.
 *
 * The cutover is type-trivial because TS-level identity
 * `AgentEvent === AgentEventFromManifest` is enforced by the Zod-side
 * `parity.schema.test.ts` `_ManifestParityCheck` sentinel + the 142-fixture
 * S2-D corpus. This file adds a complementary, independently-validatable gate
 * specifically for the type-guard surface in `shared/types/agent.ts` so a
 * future regression to that identity is caught here too. Closes 4 of the 7
 * `blocksStage3a` consumer-disposition entries (the `shared/types/agent.ts`
 * type-guard cluster).
 */
import { describe, expect, it } from 'vitest';

import {
  isAssistantFamilyEvent,
  isToolEvent,
  type AgentEvent,
  type AssistantAgentEvent,
  type AssistantDeltaAgentEvent,
  type ErrorAgentEvent,
  type ResultAgentEvent,
  type StatusAgentEvent,
  type ToolAgentEvent,
} from '@shared/types/agent';
import type { AgentEventFromManifest } from '@shared/contracts/agentEventManifest';
import type { AssertExact, IsExactStrict } from '@shared/types/typeAssertions';

// ---------------------------------------------------------------------------
// TS-level type parity: anchor invariant for the AGT cutover.
// If `AgentEvent` and `AgentEventFromManifest` ever diverge structurally,
// this assertion fails to compile, surfacing the regression at the same site
// the type-guards live (rather than only at the Zod-schema parity test).
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/naming-convention -- compile-time parity gate sentinel
type _AGTAnchorIdentity = AssertExact<IsExactStrict<AgentEvent, AgentEventFromManifest>>;
 
type _UseAGTAnchor = _AGTAnchorIdentity;

// ---------------------------------------------------------------------------
// Compile-time use-site checks: confirm the type-guards and narrowed aliases
// accept both `AgentEvent` and `AgentEventFromManifest` callers, and that
// narrowing flows through correctly. Wrapped in functions so vitest doesn't
// try to evaluate them at runtime — the type-checker still validates them.
// ---------------------------------------------------------------------------
function _compileTimeChecks(): void {
  const fromCanonical = null as unknown as AgentEvent;
  const fromManifest = null as unknown as AgentEventFromManifest;

  // Both callers reach the type-guards (signatures anchored on AgentEventFromManifest).
  const _canonicalIsTool: boolean = isToolEvent(fromCanonical);
  const _manifestIsTool: boolean = isToolEvent(fromManifest);
  const _canonicalIsAsstFamily: boolean = isAssistantFamilyEvent(fromCanonical);
  const _manifestIsAsstFamily: boolean = isAssistantFamilyEvent(fromManifest);

  // Narrowing chains: each narrowed-extract alias accepts a manifest-derived
  // AgentEventFromManifest and a hand-authored AgentEvent equivalently.
  if (isToolEvent(fromCanonical)) {
    const narrowed: ToolAgentEvent = fromCanonical;
    void narrowed;
  }
  if (isToolEvent(fromManifest)) {
    const narrowed: ToolAgentEvent = fromManifest;
    void narrowed;
  }
  if (isAssistantFamilyEvent(fromCanonical)) {
    const narrowed: AssistantAgentEvent | AssistantDeltaAgentEvent | ResultAgentEvent =
      fromCanonical;
    void narrowed;
  }

  // Reach every narrowed-extract alias to ensure none was missed during cutover.
  const _toolEv = null as unknown as ToolAgentEvent;
  const _resultEv = null as unknown as ResultAgentEvent;
  const _errorEv = null as unknown as ErrorAgentEvent;
  const _asstEv = null as unknown as AssistantAgentEvent;
  const _asstDeltaEv = null as unknown as AssistantDeltaAgentEvent;
  const _statusEv = null as unknown as StatusAgentEvent;

  void _canonicalIsTool;
  void _manifestIsTool;
  void _canonicalIsAsstFamily;
  void _manifestIsAsstFamily;
  void _toolEv;
  void _resultEv;
  void _errorEv;
  void _asstEv;
  void _asstDeltaEv;
  void _statusEv;
}
void _compileTimeChecks;

// ---------------------------------------------------------------------------
// Runtime gate: the type-guards must dispatch correctly on the manifest's
// canonical 19 event-type discriminants. We exercise representative discriminants
// (one per family) and assert the narrowing returns the expected boolean.
// ---------------------------------------------------------------------------
describe('R2 Stage 3a-AGT type-guard cutover', () => {
  it('isToolEvent narrows tool variants', () => {
    const ev: AgentEventFromManifest = {
      type: 'tool',
      toolName: 'Bash',
      detail: 'echo hi',
      stage: 'start',
      timestamp: 1,
    };
    expect(isToolEvent(ev)).toBe(true);
    expect(isAssistantFamilyEvent(ev)).toBe(false);
  });

  it('isAssistantFamilyEvent narrows assistant / assistant_delta / result variants', () => {
    const asst: AgentEventFromManifest = {
      type: 'assistant',
      text: 'hello',
      timestamp: 1,
    };
    const delta: AgentEventFromManifest = {
      type: 'assistant_delta',
      text: 'hi',
      timestamp: 1,
    };
    const result: AgentEventFromManifest = {
      type: 'result',
      text: 'final',
      timestamp: 1,
    };

    expect(isAssistantFamilyEvent(asst)).toBe(true);
    expect(isAssistantFamilyEvent(delta)).toBe(true);
    expect(isAssistantFamilyEvent(result)).toBe(true);
    expect(isToolEvent(asst)).toBe(false);
    expect(isToolEvent(delta)).toBe(false);
    expect(isToolEvent(result)).toBe(false);
  });

  it('rejects non-tool / non-assistant-family variants', () => {
    const status: AgentEventFromManifest = {
      type: 'status',
      message: 'hello',
      timestamp: 1,
    };
    expect(isToolEvent(status)).toBe(false);
    expect(isAssistantFamilyEvent(status)).toBe(false);
  });
});
