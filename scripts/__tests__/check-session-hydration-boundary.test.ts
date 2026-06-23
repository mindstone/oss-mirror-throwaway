import { describe, it, expect } from 'vitest';
import { scanContent } from '../check-session-hydration-boundary';

describe('check-session-hydration-boundary scanContent', () => {
  it('FLAGS an unannotated raw `JSON.parse(...) as AgentSession` (the bug class)', () => {
    const src = [
      'const content = fs.readFileSync(p, "utf8");',
      'const session = JSON.parse(content) as AgentSession;',
      'return session.messages.filter(Boolean);',
    ].join('\n');
    const { sanctioned, violations } = scanContent(src);
    expect(sanctioned).toBe(0);
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(2);
  });

  it('ALLOWS a raw parse with a `hydration-exempt:` annotation on the line above', () => {
    const src = [
      '// hydration-exempt: id check must precede normalize side-effects',
      'const rawSession = JSON.parse(content) as AgentSession;',
    ].join('\n');
    const { sanctioned, violations } = scanContent(src);
    expect(violations).toHaveLength(0);
    expect(sanctioned).toBe(1);
  });

  it('ALLOWS an annotation within the lookback window (not only the immediate line)', () => {
    const src = [
      '// hydration-exempt: tombstone check first',
      'log.info("about to parse");',
      'someOtherCall();',
      'const rawSession = JSON.parse(content) as AgentSession;',
    ].join('\n');
    const { violations } = scanContent(src);
    expect(violations).toHaveLength(0);
  });

  it('FLAGS the angle-bracket cast form `<AgentSession>JSON.parse(...)`', () => {
    const src = 'const s = <AgentSession>JSON.parse(content);';
    const { violations } = scanContent(src);
    expect(violations).toHaveLength(1);
  });

  it('does NOT flag a narrowed cast (Pick) — that is not a session-load', () => {
    const src = 'const meta = JSON.parse(c) as Pick<AgentSession, "updatedAt">;';
    const { sanctioned, violations } = scanContent(src);
    expect(sanctioned).toBe(0);
    expect(violations).toHaveLength(0);
  });

  it('does NOT flag a doc-comment that merely mentions the phrase', () => {
    const src = ' * `JSON.parse(content) as AgentSession` trusts the persisted shape';
    const { sanctioned, violations } = scanContent(src);
    expect(sanctioned).toBe(0);
    expect(violations).toHaveLength(0);
  });

  it('does NOT flag the hydrate helpers (annotated boundary)', () => {
    const src = [
      'function hydrateSession(content: string): AgentSession {',
      '  // hydration-exempt: THE full-hydration boundary.',
      '  return normalizeSessionTurnState(JSON.parse(content) as AgentSession);',
      '}',
    ].join('\n');
    const { violations } = scanContent(src);
    expect(violations).toHaveLength(0);
  });
});
