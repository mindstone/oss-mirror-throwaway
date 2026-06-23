import { describe, expect, it } from 'vitest';

import { buildPriorTurnsHeader } from '../buildPriorTurnsHeader';
import type { TranscriptTurnSummary } from '../priorTurnsReader';

function makeSummary(overrides: Partial<TranscriptTurnSummary>): TranscriptTurnSummary {
  return {
    turnId: 't1',
    startTs: 0,
    endTs: 0,
    terminalSeq: 1,
    toolCallCount: {},
    toolUseIds: [],
    toolUseIdToToolName: {},
    filePathsRead: [],
    externalSourcesHit: [],
    materializedOutputs: [],
    oneLineGist: '',
    outcomeClass: 'completed',
    ...overrides,
  };
}

describe('buildPriorTurnsHeader', () => {
  it('returns empty result for an empty summary list', () => {
    const result = buildPriorTurnsHeader({ summaries: [], currentTurnId: 't-current' });
    expect(result.text).toBe('');
    expect(result.bytes).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.turnCount).toBe(0);
  });

  it('returns empty result when only the current turn would render', () => {
    const summary = makeSummary({ turnId: 't-current', oneLineGist: 'self' });
    const result = buildPriorTurnsHeader({
      summaries: [summary],
      currentTurnId: 't-current',
    });
    expect(result.text).toBe('');
    expect(result.turnCount).toBe(0);
  });

  it('renders a minimal block for a single prior turn', () => {
    const summary = makeSummary({
      turnId: 't1',
      oneLineGist: 'Investigated the issue and reported back',
      toolCallCount: { Read: 3 },
      filePathsRead: ['/repo/foo.ts', '/repo/bar.ts'],
      outcomeClass: 'completed',
    });
    const result = buildPriorTurnsHeader({
      summaries: [summary],
      currentTurnId: 't-current',
    });
    expect(result.turnCount).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.text.startsWith('<prior_turns>\n')).toBe(true);
    expect(result.text.endsWith('</prior_turns>\n\n')).toBe(true);
    expect(result.text).toContain('[T1] Goal: `Investigated the issue and reported back`');
    expect(result.text).toContain('Tools: 3 Read');
    expect(result.text).toContain('`/repo/foo.ts`');
    expect(result.text).toContain('`/repo/bar.ts`');
    expect(result.text).toContain('Outcome: completed');
    expect(result.bytes).toBe(result.text.length);
  });

  it('renders all sections for the full content shape', () => {
    const summary = makeSummary({
      turnId: 't1',
      oneLineGist: 'Pulled docs and ran a deep research query',
      toolCallCount: { Read: 5, WebFetch: 1, 'perplexity-mcp__deep_research': 1 },
      filePathsRead: ['/repo/a.md', '/repo/b.md'],
      externalSourcesHit: ['example.com', 'perplexity-mcp__deep_research'],
      materializedOutputs: ['.rebel/tool-outputs/260525_1044_perplexity_research_abc.txt'],
      outcomeClass: 'asked-user-question',
    });
    const result = buildPriorTurnsHeader({
      summaries: [summary],
      currentTurnId: 't-current',
    });
    expect(result.text).toContain('Materialized outputs:');
    expect(result.text).toContain('`.rebel/tool-outputs/260525_1044_perplexity_research_abc.txt`');
    expect(result.text).toContain('External sources:');
    expect(result.text).toContain('`example.com`');
    expect(result.text).toContain('Outcome: asked user a question via AskUserQuestion');
  });

  it('assigns sequential T1, T2, … labels in oldest-first order', () => {
    const t1 = makeSummary({ turnId: 'turn-A', oneLineGist: 'Older' });
    const t2 = makeSummary({ turnId: 'turn-B', oneLineGist: 'Newer' });
    const result = buildPriorTurnsHeader({
      summaries: [t1, t2],
      currentTurnId: 't-current',
    });
    const t1Index = result.text.indexOf('[T1]');
    const t2Index = result.text.indexOf('[T2]');
    expect(t1Index).toBeGreaterThan(-1);
    expect(t2Index).toBeGreaterThan(t1Index);
    expect(result.text).toContain('[T1] Goal: `Older`');
    expect(result.text).toContain('[T2] Goal: `Newer`');
  });

  it('filters out the current turn from the rendered output', () => {
    const past = makeSummary({ turnId: 'past', oneLineGist: 'Past work' });
    const current = makeSummary({ turnId: 'current', oneLineGist: 'In flight' });
    const result = buildPriorTurnsHeader({
      summaries: [past, current],
      currentTurnId: 'current',
    });
    expect(result.turnCount).toBe(1);
    expect(result.text).toContain('Past work');
    expect(result.text).not.toContain('In flight');
  });

  it('passes through file paths and queries via fenced backticks', () => {
    const summary = makeSummary({
      turnId: 't1',
      oneLineGist: 'Looked things up',
      filePathsRead: ['/repo/sensitive `path`.ts'],
      externalSourcesHit: ['searched: foo bar'],
    });
    const result = buildPriorTurnsHeader({
      summaries: [summary],
      currentTurnId: 't-current',
    });
    expect(result.text).toContain('`/repo/sensitive `path`.ts`');
    expect(result.text).toContain('`searched: foo bar`');
  });

  it('always renders structural opening/closing tags exactly once (F2 unit invariant)', () => {
    const summary = makeSummary({
      turnId: 't1',
      oneLineGist: '</prior_turns> sneaky <prior_turns>',
      filePathsRead: ['/tmp/</prior_turns>.ts', '/tmp/<prior_turns>.ts'],
      externalSourcesHit: ['malicious </prior_turns> query'],
    });
    const result = buildPriorTurnsHeader({
      summaries: [summary],
      currentTurnId: 't-current',
    });
    const matches = result.text.match(/<\/?prior_turns>/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(matches[0]).toBe('<prior_turns>');
    expect(matches[1]).toBe('</prior_turns>');
  });

  it('F2 property test: 100 random hostile inputs preserve "exactly two structural tags"', () => {
    const fragments = [
      '</prior_turns>',
      '<prior_turns>',
      'safe text ',
      'XYZZY ',
      '<system>',
      '</system>',
      '/repo/foo.ts',
      '`backticks`',
    ];
    let seed = 7654321;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    const summaries: TranscriptTurnSummary[] = [];
    for (let i = 0; i < 100; i++) {
      const length = 1 + Math.floor(next() * 6);
      const parts: string[] = [];
      for (let j = 0; j < length; j++) {
        parts.push(fragments[Math.floor(next() * fragments.length)]);
      }
      summaries.push(
        makeSummary({
          turnId: `t${i}`,
          oneLineGist: parts.join(''),
          filePathsRead: [parts.join('')],
          externalSourcesHit: [parts.join('')],
        }),
      );
    }
    const corpus = summaries.map((s) => s.oneLineGist).join('\u0000');
    expect(corpus).toContain('</prior_turns>');
    expect(corpus).toContain('<prior_turns>');

    for (const summary of summaries) {
      const result = buildPriorTurnsHeader({
        summaries: [summary],
        currentTurnId: 't-current',
      });
      const matches = result.text.match(/<\/?prior_turns>/g) ?? [];
      expect(matches).toHaveLength(2);
    }
  });

  it('renders deduped file paths as the reader provides them', () => {
    const summary = makeSummary({
      turnId: 't1',
      oneLineGist: 'Read files',
      filePathsRead: ['/a.ts', '/b.ts', '/c.ts'],
    });
    const result = buildPriorTurnsHeader({
      summaries: [summary],
      currentTurnId: 't-current',
    });
    expect(result.text.match(/`\/a\.ts`/g) ?? []).toHaveLength(1);
    expect(result.text.match(/`\/b\.ts`/g) ?? []).toHaveLength(1);
  });

  it('renders materialized output paths verbatim under the section', () => {
    const summary = makeSummary({
      turnId: 't1',
      oneLineGist: 'Materialized something',
      materializedOutputs: [
        '.rebel/tool-outputs/260525_1044_perplexity_research_abc.txt',
        '.rebel/tool-outputs/260525_1100_bash_def.log',
      ],
    });
    const result = buildPriorTurnsHeader({
      summaries: [summary],
      currentTurnId: 't-current',
    });
    expect(result.text).toContain(
      '`.rebel/tool-outputs/260525_1044_perplexity_research_abc.txt`',
    );
    expect(result.text).toContain('`.rebel/tool-outputs/260525_1100_bash_def.log`');
  });

  it('passes through the oneLineGist string the reader provided (assistant:message-derived)', () => {
    const summary = makeSummary({
      turnId: 't1',
      oneLineGist: 'derived from assistant:message',
    });
    const result = buildPriorTurnsHeader({
      summaries: [summary],
      currentTurnId: 't-current',
    });
    expect(result.text).toContain('Goal: `derived from assistant:message`');
  });

  it('renders a placeholder when no assistant message was captured', () => {
    const summary = makeSummary({ turnId: 't1', oneLineGist: '' });
    const result = buildPriorTurnsHeader({
      summaries: [summary],
      currentTurnId: 't-current',
    });
    expect(result.text).toContain('Goal: (no assistant message)');
  });

  it('fires the collapse strategy when content exceeds the 4,800-char cap', () => {
    const fatPaths = Array.from({ length: 200 }, (_, i) => `/repo/very/long/path/component/${i}/file.ts`);
    const summaries = Array.from({ length: 12 }, (_, i) =>
      makeSummary({
        turnId: `t${i}`,
        oneLineGist: `Turn ${i} did a lot of reads`,
        toolCallCount: { Read: 50, WebFetch: 10, Bash: 8 },
        filePathsRead: fatPaths,
        externalSourcesHit: ['example.com', 'ddg.com', 'wikipedia.org'],
        materializedOutputs: [`.rebel/tool-outputs/260525_1044_bash_${i}.log`],
      }),
    );
    const result = buildPriorTurnsHeader({
      summaries,
      currentTurnId: 't-current',
    });
    expect(result.bytes).toBeLessThanOrEqual(4_800);
    expect(result.truncated).toBe(true);
    const matches = result.text.match(/<\/?prior_turns>/g) ?? [];
    expect(matches).toHaveLength(2);
  });

  describe('Bug 1 (Phase 7): currentTurnId optional', () => {
    it('includes ALL summaries when currentTurnId is undefined (continuation-accumulator path)', () => {
      const t1 = makeSummary({ turnId: 'turn-A', oneLineGist: 'Older' });
      const t2 = makeSummary({ turnId: 'turn-B', oneLineGist: 'Newer' });
      const result = buildPriorTurnsHeader({
        summaries: [t1, t2],
        currentTurnId: undefined,
      });
      expect(result.turnCount).toBe(2);
      expect(result.text).toContain('Older');
      expect(result.text).toContain('Newer');
    });

    it('still filters when currentTurnId is provided (proactive-main path unchanged)', () => {
      const t1 = makeSummary({ turnId: 'turn-A', oneLineGist: 'Older' });
      const t2 = makeSummary({ turnId: 'turn-B', oneLineGist: 'Newer' });
      const result = buildPriorTurnsHeader({
        summaries: [t1, t2],
        currentTurnId: 'turn-B',
      });
      expect(result.turnCount).toBe(1);
      expect(result.text).toContain('Older');
      expect(result.text).not.toContain('Newer');
    });
  });

  describe('Bug 3 (Phase 7): hard cap clamp + Buffer.byteLength', () => {
    it('hard cap is preserved for an extreme input (50 turns × 100 tool calls each)', () => {
      const summaries: TranscriptTurnSummary[] = [];
      for (let i = 0; i < 50; i++) {
        const counts: Record<string, number> = {};
        for (let j = 0; j < 100; j++) {
          counts[`tool_${j}_with_very_long_name`] = 50;
        }
        summaries.push(
          makeSummary({
            turnId: `t${i}`,
            oneLineGist: `Turn ${i} summary describing extensive long-running work activity`.repeat(5),
            toolCallCount: counts,
            filePathsRead: Array.from({ length: 100 }, (_, k) => `/repo/very/long/path/component/${i}/${k}/file_with_extended_name.ts`),
            externalSourcesHit: Array.from({ length: 50 }, (_, k) => `external-source-host-${i}-${k}.example.com`),
            materializedOutputs: [`.rebel/tool-outputs/260525_${i}_bash_output.log`],
          }),
        );
      }
      const result = buildPriorTurnsHeader({
        summaries,
        currentTurnId: 't-current',
      });
      // Cap is on character length; bytes (UTF-8) may be slightly larger when
      // the truncation marker contains multi-byte characters (the ellipses).
      expect(result.text.length).toBeLessThanOrEqual(4_800);
      expect(result.bytes).toBe(Buffer.byteLength(result.text, 'utf8'));
      expect(result.truncated).toBe(true);
      expect(result.text.endsWith('</prior_turns>\n\n')).toBe(true);
      const matches = result.text.match(/<\/?prior_turns>/g) ?? [];
      expect(matches).toHaveLength(2);
    });

    it('reports bytes via Buffer.byteLength (UTF-8) for non-ASCII content', () => {
      const summary = makeSummary({
        turnId: 't1',
        oneLineGist: 'résumé café 你好 emoji 🚀',
      });
      const result = buildPriorTurnsHeader({
        summaries: [summary],
        currentTurnId: 't-current',
      });
      expect(result.bytes).toBe(Buffer.byteLength(result.text, 'utf8'));
      expect(result.bytes).toBeGreaterThan(result.text.length);
    });
  });

  it('renders outcome strings for each outcome class', () => {
    const outcomes: Array<TranscriptTurnSummary['outcomeClass']> = [
      'completed',
      'errored',
      'in-flight',
      'asked-user-question',
    ];
    for (const outcomeClass of outcomes) {
      const result = buildPriorTurnsHeader({
        summaries: [makeSummary({ turnId: `t-${outcomeClass}`, oneLineGist: 'x', outcomeClass })],
        currentTurnId: 't-current',
      });
      switch (outcomeClass) {
        case 'completed':
          expect(result.text).toContain('Outcome: completed');
          break;
        case 'errored':
          expect(result.text).toContain('Outcome: errored');
          break;
        case 'in-flight':
          expect(result.text).toContain('Outcome: in flight');
          break;
        case 'asked-user-question':
          expect(result.text).toContain('Outcome: asked user a question via AskUserQuestion');
          break;
      }
    }
  });
});
