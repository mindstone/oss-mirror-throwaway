import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RAW_TURN_DISPATCH_ALLOWLIST,
  countRawTurnDispatches,
  isCountedRendererFile,
  scanAgentTurnDispatchChokepoint,
} from '../check-agent-turn-dispatch-chokepoint';
import { STEPS } from '../run-validate-fast';
import { GUARD_NAMES as SOURCE_POLICY_GUARDS } from '../groups/source-policy-chokepoints';

describe('countRawTurnDispatches', () => {
  it('counts window.agentApi.turn( and bare agentApi.turn( call sites', () => {
    const source = `
      await window.agentApi.turn({ sessionId, prompt });
      const api = window.agentApi;
      await api.turn({ sessionId, prompt }); // NOT counted: receiver is not agentApi
      await agentApi.turn({ sessionId, prompt });
    `;
    const result = countRawTurnDispatches(source, 'src/renderer/foo.ts');
    expect(result.count).toBe(2);
    expect(result.locations).toEqual(['src/renderer/foo.ts:2', 'src/renderer/foo.ts:5']);
  });

  it('ignores mentions inside line and block comments', () => {
    const source = `
      // falls back to window.agentApi.turn({ isSystemContinuation: true })
      /**
       * instead of calling window.agentApi.turn() directly.
       */
      const x = 1;
    `;
    expect(countRawTurnDispatches(source, 'src/renderer/foo.ts').count).toBe(0);
  });

  it('does not count other agentApi members or other turn() receivers', () => {
    const source = `
      await window.agentApi.stopTurn({ turnId });
      await window.agentApi.toolSafetyResponse(payload);
      await otherApi.turn(request);
    `;
    expect(countRawTurnDispatches(source, 'src/renderer/foo.ts').count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // KNOWN LIMITATION (documented, Stage 3 review F3): the guard is lightweight
  // TEXTUAL enforcement, not AST dataflow analysis. Alias / destructuring
  // indirection is deliberately NOT caught — do not over-trust the guard
  // against an adversarial bypass; the type-level seam (dispatchAgentTurn's
  // required decision parameter) is the primary kill-by-construction layer.
  // If this test starts FAILING because the counter now catches these shapes,
  // celebrate, then update the guard's header comment to match.
  // -------------------------------------------------------------------------
  it('KNOWN LIMITATION: alias and destructuring indirection are NOT caught (expected misses)', () => {
    const aliased = `
      const api = window.agentApi;
      await api.turn({ sessionId, prompt });
    `;
    const destructured = `
      const { turn } = window.agentApi;
      await turn({ sessionId, prompt });
    `;
    expect(countRawTurnDispatches(aliased, 'src/renderer/aliased.ts').count).toBe(0);
    expect(countRawTurnDispatches(destructured, 'src/renderer/destructured.ts').count).toBe(0);
  });
});

describe('isCountedRendererFile', () => {
  it('counts renderer prod source and skips tests', () => {
    expect(isCountedRendererFile('src/renderer/utils/foo.ts')).toBe(true);
    expect(isCountedRendererFile('src/renderer/components/Foo.tsx')).toBe(true);
    expect(isCountedRendererFile('src/renderer/hooks/__tests__/foo.test.ts')).toBe(false);
    expect(isCountedRendererFile('src/renderer/hooks/foo.test.ts')).toBe(false);
    expect(isCountedRendererFile('src/renderer/styles/app.css')).toBe(false);
  });
});

describe('scanAgentTurnDispatchChokepoint (synthetic tree)', () => {
  let repoRoot: string;

  const writeFile = (relativePath: string, contents: string): void => {
    const fullPath = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, contents);
  };

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-chokepoint-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  const scan = (allowlist: ReadonlyArray<{ file: string; expectedCount: number; why: string }>) =>
    scanAgentTurnDispatchChokepoint({
      repoRoot,
      scanRoot: path.join(repoRoot, 'src', 'renderer'),
      allowlist,
    });

  it('passes when every raw site matches a count-pinned allowlist entry', () => {
    writeFile('src/renderer/chokepoint.ts', 'return window.agentApi.turn(request);\n');
    const result = scan([
      { file: 'src/renderer/chokepoint.ts', expectedCount: 1, why: 'the chokepoint' },
    ]);
    expect(result.violations).toEqual([]);
    expect(result.totalRawSites).toBe(1);
  });

  it('fails with new_bypass when a non-allowlisted file dispatches directly', () => {
    writeFile('src/renderer/chokepoint.ts', 'return window.agentApi.turn(request);\n');
    writeFile(
      'src/renderer/features/sneaky.ts',
      'await window.agentApi.turn({ sessionId, prompt });\n',
    );
    const result = scan([
      { file: 'src/renderer/chokepoint.ts', expectedCount: 1, why: 'the chokepoint' },
    ]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe('new_bypass');
    expect(result.violations[0]?.file).toBe('src/renderer/features/sneaky.ts');
    expect(result.violations[0]?.message).toContain('dispatchAgentTurn');
    expect(result.violations[0]?.message).toContain('src/renderer/features/sneaky.ts:1');
  });

  it('fails with new_bypass when an allowlisted file grows past its pin', () => {
    writeFile(
      'src/renderer/engine.ts',
      'await window.agentApi.turn(a);\nawait window.agentApi.turn(b);\n',
    );
    const result = scan([
      { file: 'src/renderer/engine.ts', expectedCount: 1, why: 'engine internals' },
    ]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe('new_bypass');
    expect(result.violations[0]?.message).toContain('exceed the allowlist pin');
  });

  it('fails with stale_allowlist when an allowlisted file drops below its pin (anti-rot)', () => {
    writeFile('src/renderer/engine.ts', 'await window.agentApi.turn(a);\n');
    const result = scan([
      { file: 'src/renderer/engine.ts', expectedCount: 3, why: 'engine internals' },
    ]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe('stale_allowlist');
    expect(result.violations[0]?.message).toContain('Lower expectedCount to 1');
  });

  it('fails with stale_allowlist when an allowlisted file has no raw sites or is gone (anti-rot)', () => {
    writeFile('src/renderer/clean.ts', 'export const noop = 1;\n');
    const result = scan([
      { file: 'src/renderer/clean.ts', expectedCount: 1, why: 'stale entry' },
      { file: 'src/renderer/missing.ts', expectedCount: 2, why: 'deleted file' },
    ]);
    expect(result.violations).toHaveLength(2);
    expect(result.violations.every((v) => v.kind === 'stale_allowlist')).toBe(true);
  });

  it('skips test files when counting', () => {
    writeFile(
      'src/renderer/hooks/__tests__/engine.test.ts',
      'turnMock = window.agentApi.turn(request);\n',
    );
    writeFile('src/renderer/hooks/engine.spec.ts', 'window.agentApi.turn(request);\n');
    const result = scan([]);
    expect(result.violations).toEqual([]);
    expect(result.totalRawSites).toBe(0);
  });
});

describe('repo + wiring', () => {
  it('passes on the real repo with the shipped allowlist', () => {
    const result = scanAgentTurnDispatchChokepoint();
    expect(result.violations).toEqual([]);
  });

  it('the shipped allowlist names the chokepoint module and engine internals only', () => {
    expect(RAW_TURN_DISPATCH_ALLOWLIST.map((entry) => entry.file)).toEqual([
      'src/renderer/features/agent-session/utils/dispatchAgentTurn.ts',
      'src/renderer/features/agent-session/hooks/useAgentSessionEngine.ts',
    ]);
  });

  it('is wired into validate:fast via the source-policy-chokepoints group', () => {
    expect(STEPS.map((s) => s.name)).toContain('validate:source-policy-chokepoints');
    expect(SOURCE_POLICY_GUARDS).toContain('check-agent-turn-dispatch-chokepoint');
  });
});
