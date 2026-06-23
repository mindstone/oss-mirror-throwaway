import { describe, it, expect, vi } from 'vitest';
import {
  runSourceCapturePrefilter,
  compoundKey,
  normalizeTitle,
  findNearDuplicate,
  renderManifestForPrompt,
} from '../sourceCapturePrefilter';
import type {
  CandidateSource,
  CapturedSourceRecord,
  EnumerationSpec,
  PrefilterMcpCall,
  SourceCapturePrefilterDeps,
} from '../types';

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

function makeDeps(overrides: Partial<SourceCapturePrefilterDeps> = {}): SourceCapturePrefilterDeps {
  return {
    mcpCall: async () => ({ ok: true, result: { meetings: [] } }),
    scanCapturedFrontmatter: async () => [],
    clock: { now: () => 1_700_000_000_000 },
    logger: makeLogger(),
    ...overrides,
  };
}

/** A spec whose extractor returns the supplied candidates verbatim. */
function specReturning(specId: string, candidates: CandidateSource[]): EnumerationSpec {
  return {
    specId,
    source_system: candidates[0]?.source_system ?? 'fireflies',
    source_account: candidates[0]?.source_account ?? '[external-email]',
    package_id: 'pkg',
    tool_id: 'list',
    args: {},
    extract: () => candidates,
  };
}

const meetingA: CandidateSource = {
  id: 'ff-1',
  source_system: 'fireflies',
  source_account: '[external-email]',
  source_uid: 'ff-1',
  title: 'Weekly Sync',
  date: '2026-02-10',
  participants: ['Greg', 'Jane'],
};
const meetingB: CandidateSource = {
  id: 'ff-2',
  source_system: 'fireflies',
  source_account: '[external-email]',
  source_uid: 'ff-2',
  title: 'Pricing Review',
  date: '2026-02-19',
  participants: ['Greg', 'Tom'],
};

describe('compoundKey', () => {
  it('joins system:account:uid', () => {
    expect(compoundKey('fireflies', '[external-email]', 'ff-1')).toBe(
      'fireflies:[external-email]:ff-1',
    );
  });
});

describe('normalizeTitle', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeTitle('  Weekly  Sync!! (Q1) ')).toBe('weekly sync q1');
  });
});

describe('runSourceCapturePrefilter — enumerate', () => {
  it('passes all candidates through when nothing is already captured', async () => {
    const deps = makeDeps();
    const result = await runSourceCapturePrefilter(
      { specs: [specReturning('s1', [meetingA, meetingB])] },
      deps,
    );
    expect(result.observability.enumerated).toBe(2);
    expect(result.observability.passed).toBe(2);
    expect(result.observability.excludedExactDupe).toBe(0);
    expect(result.manifest.map((m) => m.id)).toEqual(['ff-1', 'ff-2']);
    expect(result.manifest.every((m) => m.disposition === 'passed')).toBe(true);
    // One scripted call per spec.
    expect(result.observability.scriptedToolCallCount).toBe(1);
  });

  it('aggregates candidates across multiple specs and counts each call', async () => {
    const deps = makeDeps();
    const result = await runSourceCapturePrefilter(
      {
        specs: [
          specReturning('s1', [meetingA]),
          specReturning('s2', [meetingB]),
        ],
      },
      deps,
    );
    expect(result.observability.enumerated).toBe(2);
    expect(result.observability.scriptedToolCallCount).toBe(2);
  });
});

describe('runSourceCapturePrefilter — activity window', () => {
  it('excludes candidates dated before windowStartMs but keeps undated ones', async () => {
    const undated: CandidateSource = {
      id: 'no-date',
      source_system: 'gmail',
      source_account: '[external-email]',
      source_uid: 'no-date',
      title: 'Undated thread',
      participants: [],
    };
    const deps = makeDeps();
    // Window starts 2026-02-15: meetingA (02-10) is out, meetingB (02-19) is in,
    // undated is kept (recall-preserving).
    const windowStartMs = Date.parse('2026-02-15T00:00:00Z');
    const result = await runSourceCapturePrefilter(
      { specs: [specReturning('s1', [meetingA, meetingB, undated])], windowStartMs },
      deps,
    );
    expect(result.observability.outOfWindow).toBe(1);
    expect(result.observability.passed).toBe(2);
    expect(result.manifest.map((m) => m.id).sort()).toEqual(['ff-2', 'no-date']);
    const oow = result.observability.items.find((i) => i.disposition === 'out_of_window');
    expect(oow?.id).toBe('ff-1');
  });

  it('enumerates everything when windowStartMs is omitted', async () => {
    const deps = makeDeps();
    const result = await runSourceCapturePrefilter(
      { specs: [specReturning('s1', [meetingA, meetingB])] },
      deps,
    );
    expect(result.observability.outOfWindow).toBe(0);
    expect(result.observability.passed).toBe(2);
  });
});

describe('runSourceCapturePrefilter — exclude exact dupes', () => {
  it('excludes a candidate whose compound key exactly matches a captured source', async () => {
    const captured: CapturedSourceRecord[] = [
      { compoundKey: 'fireflies:[external-email]:ff-1', source_system: 'fireflies', source_uid: 'ff-1' },
    ];
    const deps = makeDeps({ scanCapturedFrontmatter: async () => captured });
    const result = await runSourceCapturePrefilter(
      { specs: [specReturning('s1', [meetingA, meetingB])] },
      deps,
    );
    expect(result.observability.excludedExactDupe).toBe(1);
    expect(result.observability.passed).toBe(1);
    expect(result.manifest.map((m) => m.id)).toEqual(['ff-2']);
    // Excluded item still appears in observability (no silent drop).
    const excludedRow = result.observability.items.find((i) => i.id === 'ff-1');
    expect(excludedRow?.disposition).toBe('excluded_exact_dupe');
    expect(excludedRow?.matchedKey).toBe('fireflies:[external-email]:ff-1');
  });
});

describe('runSourceCapturePrefilter — flag (not drop) near-dupes', () => {
  it('flags a same-day, title-overlapping, participant-overlapping candidate but keeps it in the manifest', async () => {
    // Captured has a DIFFERENT uid (so not an exact dupe) but same day/title/people.
    const captured: CapturedSourceRecord[] = [
      {
        compoundKey: 'fireflies:[external-email]:other-uid',
        source_system: 'fireflies',
        source_uid: 'other-uid',
        title: 'Weekly Sync',
        date: '2026-02-10',
        participants: ['Greg', 'Jane'],
      },
    ];
    const deps = makeDeps({ scanCapturedFrontmatter: async () => captured });
    const result = await runSourceCapturePrefilter(
      { specs: [specReturning('s1', [meetingA])] },
      deps,
    );
    expect(result.observability.flaggedNearDupe).toBe(1);
    expect(result.observability.excludedExactDupe).toBe(0);
    expect(result.manifest).toHaveLength(1);
    expect(result.manifest[0]?.disposition).toBe('flagged_near_dupe');
    expect(result.manifest[0]?.flaggedDuplicateOf).toBe('fireflies:[external-email]:other-uid');
  });

  it('does NOT flag when participants do not overlap (avoids generic-title false positives)', async () => {
    const captured: CapturedSourceRecord[] = [
      {
        compoundKey: 'fireflies:[external-email]:other-uid',
        source_system: 'fireflies',
        source_uid: 'other-uid',
        title: 'Weekly Sync',
        date: '2026-02-10',
        participants: ['Alice', 'Bob'],
      },
    ];
    const deps = makeDeps({ scanCapturedFrontmatter: async () => captured });
    const result = await runSourceCapturePrefilter(
      { specs: [specReturning('s1', [meetingA])] },
      deps,
    );
    expect(result.observability.flaggedNearDupe).toBe(0);
    expect(result.observability.passed).toBe(1);
    expect(result.manifest[0]?.disposition).toBe('passed');
  });

  it('does NOT flag when on a different day', async () => {
    const captured: CapturedSourceRecord[] = [
      {
        compoundKey: 'fireflies:[external-email]:other-uid',
        source_system: 'fireflies',
        source_uid: 'other-uid',
        title: 'Weekly Sync',
        date: '2026-02-11',
        participants: ['Greg', 'Jane'],
      },
    ];
    const deps = makeDeps({ scanCapturedFrontmatter: async () => captured });
    const result = await runSourceCapturePrefilter(
      { specs: [specReturning('s1', [meetingA])] },
      deps,
    );
    expect(result.observability.flaggedNearDupe).toBe(0);
    expect(result.manifest[0]?.disposition).toBe('passed');
  });
});

describe('runSourceCapturePrefilter — enumeration failure is observable, never silent', () => {
  it('records enumeration_failed when an mcpCall fails', async () => {
    const mcpCall: PrefilterMcpCall = async (spec) =>
      spec.specId === 'bad'
        ? { ok: false, error: 'connector timeout' }
        : { ok: true, result: { meetings: [] } };
    const goodSpec = specReturning('good', [meetingA]);
    const badSpec: EnumerationSpec = {
      specId: 'bad',
      source_system: 'slack',
      source_account: '[external-email]',
      package_id: 'Slack',
      tool_id: 'search',
      args: {},
      extract: () => [],
    };
    const deps = makeDeps({ mcpCall });
    const result = await runSourceCapturePrefilter({ specs: [goodSpec, badSpec] }, deps);
    expect(result.observability.enumerationFailed).toBe(1);
    expect(result.observability.passed).toBe(1);
    const failRow = result.observability.items.find((i) => i.disposition === 'enumeration_failed');
    expect(failRow?.id).toBe('bad');
    expect(failRow?.error).toBe('connector timeout');
    // The successful spec still produced its candidate.
    expect(result.manifest.map((m) => m.id)).toEqual(['ff-1']);
  });

  it('records enumeration_failed when the extractor throws', async () => {
    const throwingSpec: EnumerationSpec = {
      specId: 'throws',
      source_system: 'fireflies',
      source_account: '[external-email]',
      package_id: 'pkg',
      tool_id: 'list',
      args: {},
      extract: () => {
        throw new Error('bad shape');
      },
    };
    const deps = makeDeps();
    const result = await runSourceCapturePrefilter({ specs: [throwingSpec] }, deps);
    expect(result.observability.enumerationFailed).toBe(1);
    const row = result.observability.items.find((i) => i.disposition === 'enumeration_failed');
    expect(row?.error).toContain('extract failed');
  });
});

describe('findNearDuplicate', () => {
  it('matches on substring title containment', () => {
    const cand: CandidateSource = { ...meetingA, title: 'Weekly Sync — Product' };
    const captured: CapturedSourceRecord[] = [
      {
        compoundKey: 'k',
        source_system: 'fireflies',
        source_uid: 'x',
        title: 'Weekly Sync',
        date: '2026-02-10',
        participants: ['Jane'],
      },
    ];
    expect(findNearDuplicate(cand, captured)).toBe('k');
  });
});

describe('renderManifestForPrompt', () => {
  it('renders passed + flagged items and an empty-manifest note', async () => {
    const deps = makeDeps();
    const empty = await runSourceCapturePrefilter({ specs: [] }, deps);
    const emptyBlock = renderManifestForPrompt(empty);
    expect(emptyBlock).toContain('No new candidate sources');

    const result = await runSourceCapturePrefilter(
      { specs: [specReturning('s1', [meetingA, meetingB])] },
      deps,
    );
    const block = renderManifestForPrompt(result);
    expect(block).toContain('Curated candidate manifest');
    expect(block).toContain('Weekly Sync');
    expect(block).toContain('source_uid: ff-1');
    expect(block).toContain('do NOT need');
  });

  it('surfaces an enumeration-failure fallback note', async () => {
    const mcpCall: PrefilterMcpCall = async () => ({ ok: false, error: 'down' });
    const badSpec: EnumerationSpec = {
      specId: 'slack.search',
      source_system: 'slack',
      source_account: '[external-email]',
      package_id: 'Slack',
      tool_id: 'search',
      args: {},
      extract: () => [],
    };
    const deps = makeDeps({ mcpCall });
    const result = await runSourceCapturePrefilter({ specs: [badSpec] }, deps);
    const block = renderManifestForPrompt(result);
    expect(block).toContain('failed to enumerate');
    expect(block).toContain('slack.search');
  });
});
