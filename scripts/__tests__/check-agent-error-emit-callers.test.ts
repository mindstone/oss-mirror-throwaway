/**
 * Self-test for the agent error-event literal-construction guard
 * (260529 error-emit-funnel, Stage 3).
 *
 * Drives the AST scanner directly over synthetic sources so both directions are
 * pinned: AgentEvent-typed `{type:'error'}` literals are flagged; non-AgentEvent
 * `{type:'error'}` shapes (WS frames, other schemas, untyped) are NOT.
 *
 * @see ../check-agent-error-emit-callers.ts
 * @see docs/plans/260529_error-emit-funnel/PLAN.md Stage 3
 */
import { describe, expect, it } from 'vitest';
import { scanSource, findViolations } from '../check-agent-error-emit-callers';

interface V {
  relativePath: string;
  line: number;
  text: string;
}

function scan(source: string, relativePath = 'src/main/services/probe.ts'): V[] {
  const violations: V[] = [];
  scanSource(relativePath, source, violations);
  return violations;
}

describe('check-agent-error-emit-callers — flagged (AgentEvent error literals)', () => {
  it('flags a `const x: AgentEvent = { type: \'error\' }` annotation', () => {
    const v = scan(
      `const e: AgentEvent = { type: 'error', error: 'boom', errorSource: 'main', timestamp: 0 };`,
    );
    expect(v).toHaveLength(1);
  });

  it('flags a `{ type: \'error\' } as AgentEvent` assertion', () => {
    const v = scan(`const e = { type: 'error', error: 'boom' } as AgentEvent;`);
    expect(v).toHaveLength(1);
  });

  it('flags a `<AgentEvent>{ type: \'error\' }` prefix assertion', () => {
    // .ts (not .tsx) so the angle-bracket assertion parses.
    const v = scan(`const e = <AgentEvent>{ type: 'error', error: 'boom' };`);
    expect(v).toHaveLength(1);
  });

  it('flags a `{ type: \'error\' } satisfies AgentEvent`', () => {
    const v = scan(`const e = { type: 'error', error: 'boom' } satisfies AgentEvent;`);
    expect(v).toHaveLength(1);
  });

  it('flags `({ type: \'error\' as const, … }) as AgentEvent` through the `as const` wrapper', () => {
    const v = scan(`const e = ({ type: 'error' as const, error: 'boom' }) as AgentEvent;`);
    expect(v).toHaveLength(1);
  });

  it('flags a class property typed `: AgentEvent`', () => {
    const v = scan(
      `class C { readonly e: AgentEvent = { type: 'error', error: 'boom', errorSource: 'main', timestamp: 0 }; }`,
    );
    expect(v).toHaveLength(1);
  });
});

describe('check-agent-error-emit-callers — NOT flagged (non-AgentEvent error shapes)', () => {
  it('does not flag an untyped WS-control-frame literal', () => {
    const v = scan(`ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));`);
    expect(v).toHaveLength(0);
  });

  it('does not flag a literal typed as a different schema', () => {
    const v = scan(
      `interface MemErr { type: 'error'; error: string } const m: MemErr = { type: 'error', error: 'x' };`,
    );
    expect(v).toHaveLength(0);
  });

  it('does not flag a literal asserted to a different type', () => {
    const v = scan(`const m = { type: 'error', error: 'x' } as MemoryUpdateTerminalEvent;`);
    expect(v).toHaveLength(0);
  });

  it('does not flag a literal asserted only `as const`', () => {
    const v = scan(`const m = { type: 'error' as const, error: 'x' };`);
    expect(v).toHaveLength(0);
  });

  it('does not flag a non-error AgentEvent literal', () => {
    const v = scan(`const e: AgentEvent = { type: 'result', text: 'ok', timestamp: 0 };`);
    expect(v).toHaveLength(0);
  });

  it('does not flag a literal passed as an untyped function argument (automationScheduler shape)', () => {
    const v = scan(
      `broadcastTerminalEvent({ type: 'error', error: 'x', errorSource: 'main', timestamp: 0 });`,
    );
    expect(v).toHaveLength(0);
  });
});

describe('check-agent-error-emit-callers — repository invariant', () => {
  it('passes clean on the current tree (the funnel + tests are allowlisted)', () => {
    expect(findViolations()).toEqual([]);
  });
});
