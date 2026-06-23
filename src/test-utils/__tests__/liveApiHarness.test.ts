import { describe, expect, it } from 'vitest';
import {
  CHEAP_LIVE_MODELS,
  getLiveApiPrereq,
  liveApiMatrix,
  liveApiSkipLogLine,
  type LiveApiCell,
  type LiveApiEnv,
} from '../liveApiHarness';

// Neutral fake secret — deliberately NOT a provider-key-shaped literal, so the
// test-token drift check stays green; the redaction assertions work regardless
// of the value's shape.
const SECRET_VALUE = 'fake-live-key-DO-NOT-LOG-7f3a2b';

function makeCell(overrides: Partial<LiveApiCell> = {}): LiveApiCell {
  return {
    provider: 'anthropic',
    label: 'Anthropic direct live cell',
    envVar: 'TEST_ANTHROPIC_API_KEY',
    model: CHEAP_LIVE_MODELS.anthropic,
    ...overrides,
  };
}

function makeEnv(overrides: LiveApiEnv = {}): LiveApiEnv {
  return {
    RUN_LIVE_API_TESTS: '1',
    ...overrides,
  };
}

describe('liveApiHarness', () => {
  it('skips with a named env-var reason when the key is absent', () => {
    const result = getLiveApiPrereq(makeCell(), makeEnv());

    expect(result).toEqual({
      canRun: false,
      skipReason: 'TEST_ANTHROPIC_API_KEY (or legacy alias TEST_CLAUDE_API_KEY) is not set.',
    });
  });

  it('treats whitespace key env values as absent', () => {
    const result = getLiveApiPrereq(
      makeCell({ provider: 'openrouter', envVar: 'TEST_OPENROUTER_API_KEY', model: CHEAP_LIVE_MODELS.openrouter }),
      makeEnv({ TEST_OPENROUTER_API_KEY: '   \n\t   ' }),
    );

    expect(result).toEqual({
      canRun: false,
      skipReason: 'TEST_OPENROUTER_API_KEY is not set.',
    });
  });

  it('trims key env values before passing the opaque key through', () => {
    const result = getLiveApiPrereq(
      makeCell({ provider: 'openai', envVar: 'TEST_OPENAI_API_KEY', model: CHEAP_LIVE_MODELS.openai }),
      makeEnv({ TEST_OPENAI_API_KEY: `  ${SECRET_VALUE}  ` }),
    );

    expect(result).toEqual({ canRun: true, key: SECRET_VALUE });
  });

  it('accepts TEST_CLAUDE_API_KEY as the Anthropic legacy alias', () => {
    const result = getLiveApiPrereq(makeCell(), makeEnv({ TEST_CLAUDE_API_KEY: SECRET_VALUE }));

    expect(result).toEqual({ canRun: true, key: SECRET_VALUE });
  });

  it('skips when RUN_LIVE_API_TESTS is unset even if a key exists', () => {
    const result = getLiveApiPrereq(makeCell(), { TEST_ANTHROPIC_API_KEY: SECRET_VALUE });

    expect(result).toEqual({
      canRun: false,
      skipReason: 'RUN_LIVE_API_TESTS is not set (live-API tier is opt-in).',
    });
  });

  it('does not include key material in skip reasons or requirement diagnostics', () => {
    const result = getLiveApiPrereq(
      makeCell({
        requires: [
          {
            name: 'provider-shape',
            ok: false,
            diagnostic: `provider rejected key ${SECRET_VALUE}`,
          },
        ],
      }),
      makeEnv({ TEST_ANTHROPIC_API_KEY: SECRET_VALUE }),
    );

    expect(result.canRun).toBe(false);
    if (!result.canRun) {
      expect(result.skipReason).toContain('provider-shape');
      expect(result.skipReason).not.toContain(SECRET_VALUE);
      expect(result.skipReason).toContain('[REDACTED]');
    }
  });

  it('treats a whitespace-only RUN_LIVE_API_TESTS as unset (opt-in gate)', () => {
    const result = getLiveApiPrereq(makeCell(), makeEnv({ RUN_LIVE_API_TESTS: '   ' }));

    expect(result.canRun).toBe(false);
    if (!result.canRun) {
      expect(result.skipReason).toContain('RUN_LIVE_API_TESTS');
    }
  });

  it('reports a satisfied requirement as runnable and returns the opaque key', () => {
    const result = getLiveApiPrereq(
      makeCell({ requires: [{ name: 'catalog', ok: true, diagnostic: 'present' }] }),
      makeEnv({ TEST_ANTHROPIC_API_KEY: SECRET_VALUE }),
    );

    expect(result).toEqual({ canRun: true, key: SECRET_VALUE });
  });

  it('passes matrix cells through unchanged', () => {
    const cells = [
      makeCell(),
      makeCell({ provider: 'openai', envVar: 'TEST_OPENAI_API_KEY', model: CHEAP_LIVE_MODELS.openai }),
    ] as const;

    expect(liveApiMatrix(cells)).toBe(cells);
  });

  it('exports cheap default live models for each supported provider', () => {
    expect(CHEAP_LIVE_MODELS).toEqual({
      anthropic: 'claude-haiku-4-5',
      openrouter: 'deepseek/deepseek-v4-flash',
      openai: 'gpt-5-nano',
      codex: 'gpt-5.4',
    });
  });
});

describe('liveApiHarness — non-env credential probe (codex)', () => {
  const codexCell = (probeResult: { available: boolean; diagnostic: string }, requires?: LiveApiCell['requires']): LiveApiCell => ({
    provider: 'codex',
    label: 'ChatGPT Pro live cell',
    credentialProbe: () => probeResult,
    model: CHEAP_LIVE_MODELS.codex,
    requires,
  });

  it('runs (no secret through the harness) when the probe reports available', () => {
    const result = getLiveApiPrereq(codexCell({ available: true, diagnostic: 'present' }), makeEnv());
    // Probe-gated cells carry NO secret: key is the empty sentinel.
    expect(result).toEqual({ canRun: true, key: '' });
  });

  it('skips with the probe diagnostic (verbatim) when unavailable', () => {
    const result = getLiveApiPrereq(
      codexCell({ available: false, diagnostic: 'no Codex token file — sign in with ChatGPT Pro.' }),
      makeEnv(),
    );
    expect(result).toEqual({
      canRun: false,
      skipReason: 'no Codex token file — sign in with ChatGPT Pro.',
    });
  });

  it('respects the opt-in gate even when the probe is available', () => {
    const result = getLiveApiPrereq(codexCell({ available: true, diagnostic: 'present' }), {});
    expect(result).toEqual({
      canRun: false,
      skipReason: 'RUN_LIVE_API_TESTS is not set (live-API tier is opt-in).',
    });
  });

  it('still honors a failing requires[] prerequisite for probe-gated cells', () => {
    const result = getLiveApiPrereq(
      codexCell({ available: true, diagnostic: 'present' }, [{ name: 'catalog', ok: false, diagnostic: 'missing' }]),
      makeEnv(),
    );
    expect(result.canRun).toBe(false);
    if (!result.canRun) {
      expect(result.skipReason).toContain("prerequisite 'catalog' not met");
      expect(result.skipReason).toContain('missing');
    }
  });

  it('skips (never throws) a cell that declares neither envVar nor credentialProbe', () => {
    const malformed = { provider: 'codex', label: 'broken cell', model: CHEAP_LIVE_MODELS.codex } as LiveApiCell;
    const result = getLiveApiPrereq(malformed, makeEnv());
    expect(result.canRun).toBe(false);
    if (!result.canRun) {
      expect(result.skipReason).toContain('neither envVar nor credentialProbe');
    }
  });

  it('skips (never throws) a cell that declares BOTH envVar and credentialProbe (mutual exclusivity enforced)', () => {
    const both = {
      provider: 'codex',
      label: 'both-sources cell',
      envVar: 'TEST_OPENAI_API_KEY',
      credentialProbe: () => ({ available: true, diagnostic: 'present' }),
      model: CHEAP_LIVE_MODELS.codex,
    } as LiveApiCell;
    // Even with the env key present, declaring both is a test-author error → skip,
    // not a silent preference for envVar.
    const result = getLiveApiPrereq(both, makeEnv({ TEST_OPENAI_API_KEY: SECRET_VALUE }));
    expect(result.canRun).toBe(false);
    if (!result.canRun) {
      expect(result.skipReason).toContain('declares BOTH envVar and credentialProbe');
      expect(result.skipReason).not.toContain(SECRET_VALUE);
    }
  });
});

describe('liveApiHarness — liveApiSkipLogLine (invariants 2 + 3)', () => {
  it('names the cell and the reason in a single diagnostic line', () => {
    // The skipReason that getLiveApiPrereq would produce for a missing key.
    const reason = 'TEST_ANTHROPIC_API_KEY (or legacy alias TEST_CLAUDE_API_KEY) is not set.';
    const line = liveApiSkipLogLine(makeCell(), reason);

    expect(line).toContain('Skipping live-API integration test');
    expect(line).toContain('Anthropic direct live cell');
    expect(line).toContain(reason);
  });

  it('end-to-end: a key-present-but-opt-in-off cell yields a key-free skip line', () => {
    // Reproduce the real flow without driving a vitest suite from inside a test:
    // compute the prereq (opt-in gate off, key present), then format its line.
    const prereq = getLiveApiPrereq(makeCell(), { TEST_ANTHROPIC_API_KEY: SECRET_VALUE });
    expect(prereq.canRun).toBe(false);
    if (!prereq.canRun) {
      const line = liveApiSkipLogLine(makeCell(), prereq.skipReason);
      // Invariant 3: even with a key present in env, it never reaches the log line.
      expect(line).not.toContain(SECRET_VALUE);
      expect(line).toContain('RUN_LIVE_API_TESTS');
    }
  });
});
