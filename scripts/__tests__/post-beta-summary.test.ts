import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BANNED_BULLET_PATTERNS,
  buildLlmSystemPrompt,
  buildRawFallbackBuckets,
  commitAndPushSummary,
  expandMarkerRangeUntilVisible,
  filterVisibleCommits,
  findLastAnnouncedReleaseShaPrefix,
  generateBucketsWithLlm,
  parseLlmResponse,
  parseLlmResponseDetailed,
  renderMarkdown,
  renderSlackPayload,
} from '../post-beta-summary';
import type {
  ArchiveCommitOutcome,
  CommitArchiveDeps,
  CommitInput,
  CommitRange,
  ExpandMarkerRangeDeps,
  RawCommit,
  SummaryMetadata,
} from '../post-beta-summary';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

describe('post-beta-summary', () => {
  it('re-indexes visible commits after internal commits are filtered out', () => {
    const commits = filterVisibleCommits([
      {
        hash: '1111111111111111111111111111111111111111',
        subject: 'test(ci): Guard an internal smoke test',
        body: '',
      },
      {
        hash: '2222222222222222222222222222222222222222',
        subject: 'feat(homepage): Add a calmer Today card',
        body: 'Makes the home screen easier to scan.',
      },
    ]);

    expect(commits).toHaveLength(1);
    expect(commits[0]?.index).toBe(0);
    expect(commits[0]?.subject).toBe('Add a calmer Today card');

    expect(() => parseLlmResponse(
      JSON.stringify({
        what_youll_see: [{ bullet: 'The Today card is easier to scan.', source_indices: [0] }],
        what_we_fixed: [],
        worth_a_look: [],
      }),
      commits.length,
      0,
    )).not.toThrow();
  });

  it('keeps technical-only fallback posts out of raw commit-list territory', () => {
    const commits = filterVisibleCommits([
      {
        hash: '3333333333333333333333333333333333333333',
        subject: 'fix(test): Guard against empty UNCONFIGURED_TEST_MCPS in mcp-smoke',
        body: 'Vitest rejects empty describe blocks.',
      },
      {
        hash: '4444444444444444444444444444444444444444',
        subject: 'fix(ci): Grant contents read on beta deploy trigger workflow',
        body: 'Allows actions/checkout to fetch the private repo.',
      },
    ]);

    expect(commits).toEqual([]);
    expect(buildRawFallbackBuckets(commits)).toEqual({
      whatYoullSee: [],
      whatWeFixed: ['Behind-the-scenes reliability work for the beta channel. Nothing obvious to demo this time.'],
      worthALook: [],
    });
  });

  it('keeps fallback bullets user-facing when the LLM is unavailable', () => {
    const fixture = JSON.parse(fs.readFileSync(
      path.join(REPO_ROOT, 'scripts/__fixtures__/post-beta-summary/commits-technical-fallback.json'),
      'utf8',
    )) as { commits: Array<{ hash: string; subject: string; body: string }> };
    const commits = filterVisibleCommits(fixture.commits);

    expect(buildRawFallbackBuckets(commits)).toEqual({
      whatYoullSee: ['Adds clearer connection warnings: helps users understand why a connector needs attention.'],
      whatWeFixed: ['Clarifies post-enable setup instructions: office desktop users were looking in the wrong ribbon area.'],
      worthALook: [],
    });
  });

  it('frames internal beta posts as UI/UX awareness briefings for customer-facing teammates', () => {
    const prompt = buildLlmSystemPrompt();

    expect(prompt).toContain('Primary reader need: customer-facing teammates');
    expect(prompt).toContain('"What you\'ll see"');
    expect(prompt).toContain('"What we fixed"');
    expect(prompt).toContain('This is an awareness briefing, not a review rota.');

    const metadata = {
      releaseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      releaseShaShort: 'aaaaaaaa',
      betaVersion: '0.4.36.12345678',
      workflowRunUrl: 'https://example.com/workflow',
      runId: '123',
      runAttempt: '1',
      isBackfill: false,
      fallbackDays: 30,
      generationMode: 'summary' as const,
      generatedAtIso: '2026-05-05T10:00:00.000Z',
      idempotencyKey: 'aaaaaaaa-123-1',
      consolidatedMarkerCount: 0,
    };
    const buckets = {
      whatYoullSee: ['Onboarding now explains tool connection recovery more clearly.'],
      whatWeFixed: ['If someone says setup looks different, expect clearer guidance rather than a dead end.'],
      worthALook: ['File watching should feel steadier during longer sessions.'],
    };

    const markdown = renderMarkdown(metadata, buckets, null);
    expect(markdown).toContain("### What you'll see");
    expect(markdown).toContain('### What we fixed');
    expect(markdown).toContain('### Worth a look');
    expect(markdown).not.toContain('### UI/UX changes to know');
    expect(markdown).not.toContain('### What this means in demos and support');

    const slackPayload = renderSlackPayload(metadata, buckets, null);
    const slackText = JSON.stringify(slackPayload);
    expect(slackText).toContain("*What you'll see*");
    expect(slackText).toContain('*What we fixed*');
    expect(slackText).toContain('*Worth a look*');
    expect(slackPayload.text).toContain("What you'll see:");
    expect(slackPayload.text).not.toContain('UI/UX changes to know:');
  });

  it('does not classify [deploy-beta]-tagged commits as internal via the literal token', () => {
    const taggedCommit: RawCommit = {
      hash: 'a'.repeat(40),
      subject: 'fix(safety): Bump USER_MESSAGE_MAX_CHARS to avoid truncating multi-step requests [deploy-beta]',
      body: '',
    };

    const visible = filterVisibleCommits([taggedCommit]);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.scope).toBe('safety');
    expect(visible[0]?.subject).toContain('Bump USER_MESSAGE_MAX_CHARS');

    const untagged: RawCommit = {
      ...taggedCommit,
      subject: 'fix(safety): Bump USER_MESSAGE_MAX_CHARS to avoid truncating multi-step requests',
    };
    expect(filterVisibleCommits([untagged])).toHaveLength(1);

    // CI-scoped commits stay internal even with the token stripped — scope wins.
    const ciTaggedCommit: RawCommit = {
      hash: 'b'.repeat(40),
      subject: 'fix(ci): Unblock dev release pipeline [deploy-beta]',
      body: '',
    };
    expect(filterVisibleCommits([ciTaggedCommit])).toEqual([]);
  });

  it('preserves the Quiet beta message for genuinely-quiet fixture commits', () => {
    const fixture = JSON.parse(fs.readFileSync(
      path.join(REPO_ROOT, 'scripts/__fixtures__/post-beta-summary/commits-silent-beta.json'),
      'utf8',
    )) as { commits: Array<{ hash: string; subject: string; body: string }> };

    const visible = filterVisibleCommits(fixture.commits);
    expect(visible).toEqual([]);

    const metadata: SummaryMetadata = {
      releaseSha: 'c'.repeat(40),
      releaseShaShort: 'ccccccc',
      betaVersion: '0.4.4113068',
      workflowRunUrl: 'https://example.com/workflow',
      runId: '999',
      runAttempt: '1',
      isBackfill: false,
      fallbackDays: 30,
      generationMode: 'quiet',
      generatedAtIso: '2026-05-21T10:56:00.000Z',
      idempotencyKey: 'ccccccc-999-1',
      consolidatedMarkerCount: 0,
    };

    const quietMessage = 'Quiet beta — internal plumbing only. Nothing user-visible this round.';
    const markdown = renderMarkdown(metadata, { whatYoullSee: [], whatWeFixed: [], worthALook: [] }, quietMessage);
    expect(markdown).toContain('_Quiet beta — internal plumbing only.');
    expect(markdown).not.toContain('Catches up');

    const slack = renderSlackPayload(metadata, { whatYoullSee: [], whatWeFixed: [], worthALook: [] }, quietMessage);
    expect(JSON.stringify(slack)).toContain('Quiet beta — internal plumbing only.');
    expect(JSON.stringify(slack)).not.toContain('Catches up');
  });

  describe('findLastAnnouncedReleaseShaPrefix', () => {
    it('returns null for empty content', () => {
      expect(findLastAnnouncedReleaseShaPrefix('')).toBeNull();
      expect(findLastAnnouncedReleaseShaPrefix('   \n\n  ')).toBeNull();
    });

    it('returns null for a Latest-only changelog (no announced sections yet)', () => {
      const content = '# Internal Beta Changelog\n\nSome preamble.\n\n## Latest\n';
      expect(findLastAnnouncedReleaseShaPrefix(content)).toBeNull();
    });

    it('returns null when every section is Quiet-only', () => {
      const content = [
        '# Internal Beta Changelog',
        '',
        '## Latest',
        '',
        '## 2026-05-21 — beta v0.4.4113068 ([c094cc4](https://example.com))',
        '<!-- beta-summary-key: c094cc4-1-1 -->',
        '',
        '_Quiet beta — internal plumbing only. Nothing user-visible this round._',
        '',
        '## 2026-05-20 — beta v0.4.4112000 ([afde400](https://example.com))',
        '<!-- beta-summary-key: afde400-1-1 -->',
        '',
        '_Quiet beta — internal plumbing only. Nothing user-visible this round._',
        '',
      ].join('\n');
      expect(findLastAnnouncedReleaseShaPrefix(content)).toBeNull();
    });

    it('returns the most recent section prefix when a restored-label non-Quiet section exists', () => {
      const content = [
        '# Internal Beta Changelog',
        '',
        '## Latest',
        '',
        '## 2026-05-21 — beta v0.4.4113068 ([c094cc4](https://example.com))',
        '<!-- beta-summary-key: c094cc4-1-1 -->',
        '',
        "### What you'll see",
        '- Onboarding has clearer copy.',
        '',
        '## 2026-05-20 — beta v0.4.4112000 ([afde400](https://example.com))',
        '',
        '### What we fixed',
        '- Settings now look different.',
        '',
      ].join('\n');
      expect(findLastAnnouncedReleaseShaPrefix(content)).toBe('c094cc4');
    });

    it('still recognises the recent awareness headings as already-announced sections', () => {
      const content = [
        '# Internal Beta Changelog',
        '',
        '## Latest',
        '',
        '## 2026-05-21 — beta v0.4.4113068 ([c094cc4](https://example.com))',
        '<!-- beta-summary-key: c094cc4-1-1 -->',
        '',
        '### UI/UX changes to know',
        '- Onboarding has clearer copy.',
        '',
        '## 2026-05-20 — beta v0.4.4112000 ([afde400](https://example.com))',
        '',
        '### What this means in demos and support',
        '- Settings now look different.',
        '',
      ].join('\n');
      expect(findLastAnnouncedReleaseShaPrefix(content)).toBe('c094cc4');
    });

    it('skips Quiet sections and returns the next non-Quiet one underneath', () => {
      const content = [
        '# Internal Beta Changelog',
        '',
        '## Latest',
        '',
        '## 2026-05-21 — beta v… ([ccccccc](https://example.com))',
        '',
        '_Quiet beta — internal plumbing only. Nothing user-visible this round._',
        '',
        '## 2026-05-20 — beta v… ([abcdef0](https://example.com))',
        '',
        '### Other fixes worth knowing',
        '- Reliability tweak.',
        '',
        '## 2026-05-19 — beta v… ([0123456](https://example.com))',
        '',
        '### UI/UX changes to know',
        '- Older real announcement.',
        '',
      ].join('\n');
      expect(findLastAnnouncedReleaseShaPrefix(content)).toBe('abcdef0');
    });
  });

  describe('expandMarkerRangeUntilVisible', () => {
    const makeRange = (startRef: string): CommitRange => ({
      kind: 'marker',
      releaseSha: 'release-sha',
      startRef,
      isBackfill: false,
      fallbackDays: 30,
    });

    const visibleCommit: RawCommit = {
      hash: 'visible-commit',
      subject: 'feat(homepage): Add a calmer Today summary card',
      body: 'Surfaces upcoming meetings and action items in one glance.',
    };
    const ciFixCommit: RawCommit = {
      hash: 'ci-fix-commit',
      subject: 'fix(ci): Unblock dev release pipeline',
      body: '',
    };

    it('walks back through CI-retry markers to recover user-visible work', async () => {
      const markerChain: Record<string, string | null> = {
        'marker-A': 'marker-B',
        'marker-B': 'marker-C',
        'marker-C': null,
      };
      const commitsByStart: Record<string, RawCommit[]> = {
        'marker-A': [ciFixCommit],
        'marker-B': [ciFixCommit, ciFixCommit],
        'marker-C': [visibleCommit, ciFixCommit, ciFixCommit],
      };
      let timestampCalls = 0;
      let loadCalls = 0;
      const deps: ExpandMarkerRangeDeps = {
        getLatestMarker: async (ref) => markerChain[ref.replace(/\^$/, '')] ?? null,
        loadCommits: async (range) => {
          loadCalls += 1;
          return commitsByStart[range.startRef ?? ''] ?? [];
        },
        filterVisible: filterVisibleCommits,
        getCommitTimestamp: async () => {
          timestampCalls += 1;
          return new Date();
        },
      };

      const initialRange = makeRange('marker-A');
      const result = await expandMarkerRangeUntilVisible(
        initialRange,
        commitsByStart['marker-A']!,
        [],
        30,
        deps,
      );

      expect(result.hopsWalked).toBe(2);
      expect(result.range.startRef).toBe('marker-C');
      expect(result.visibleCommits).toHaveLength(1);
      expect(result.visibleCommits[0]?.subject).toBe('Add a calmer Today summary card');
      expect(loadCalls).toBe(2);
      expect(timestampCalls).toBe(2);
    });

    it('returns the input unchanged when initial range already has visible commits', async () => {
      const initialVisible: CommitInput[] = [
        {
          index: 0,
          hash: 'visible',
          type: 'feat',
          scope: 'homepage',
          subject: 'Already user-visible',
          bodyFirstLine: '',
        },
      ];
      let invoked = 0;
      const deps: ExpandMarkerRangeDeps = {
        getLatestMarker: async () => {
          invoked += 1;
          return 'should-not-be-called';
        },
        loadCommits: async () => [],
        filterVisible: filterVisibleCommits,
        getCommitTimestamp: async () => new Date(),
      };
      const result = await expandMarkerRangeUntilVisible(
        makeRange('marker-A'),
        [visibleCommit],
        initialVisible,
        30,
        deps,
      );
      expect(result.hopsWalked).toBe(0);
      expect(result.range.startRef).toBe('marker-A');
      expect(invoked).toBe(0);
    });

    it('stops walking when getLatestMarker returns null (end of chain)', async () => {
      const markerChain: Record<string, string | null> = {
        'marker-A': 'marker-B',
        'marker-B': null,
      };
      const deps: ExpandMarkerRangeDeps = {
        getLatestMarker: async (ref) => markerChain[ref.replace(/\^$/, '')] ?? null,
        loadCommits: async () => [ciFixCommit],
        filterVisible: filterVisibleCommits,
        getCommitTimestamp: async () => new Date(),
      };
      const result = await expandMarkerRangeUntilVisible(
        makeRange('marker-A'),
        [ciFixCommit],
        [],
        30,
        deps,
      );
      expect(result.hopsWalked).toBe(1);
      expect(result.range.startRef).toBe('marker-B');
      expect(result.visibleCommits).toEqual([]);
    });

    it('stops walking at the fallback-days cap', async () => {
      const ancientTimestamp = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      const deps: ExpandMarkerRangeDeps = {
        getLatestMarker: async () => 'marker-ancient',
        loadCommits: async () => [ciFixCommit],
        filterVisible: filterVisibleCommits,
        getCommitTimestamp: async () => ancientTimestamp,
      };
      const result = await expandMarkerRangeUntilVisible(
        makeRange('marker-A'),
        [ciFixCommit],
        [],
        30,
        deps,
      );
      expect(result.hopsWalked).toBe(0);
      expect(result.range.startRef).toBe('marker-A');
    });

    it('stops walking at the hop ceiling (MAX_MARKER_WALK_HOPS = 20)', async () => {
      let counter = 0;
      const deps: ExpandMarkerRangeDeps = {
        getLatestMarker: async () => {
          counter += 1;
          return `marker-${counter.toString().padStart(3, '0')}`;
        },
        loadCommits: async () => [ciFixCommit],
        filterVisible: filterVisibleCommits,
        getCommitTimestamp: async () => new Date(),
      };
      const result = await expandMarkerRangeUntilVisible(
        makeRange('marker-A'),
        [ciFixCommit],
        [],
        30,
        deps,
      );
      expect(result.hopsWalked).toBe(20);
      expect(result.range.startRef).toBe('marker-020');
    });

    it('stops walking when a previously-seen marker is encountered (cycle guard)', async () => {
      const chain = ['marker-B', 'marker-A'];
      let idx = 0;
      const deps: ExpandMarkerRangeDeps = {
        getLatestMarker: async () => {
          const next = chain[idx];
          idx += 1;
          return next ?? null;
        },
        loadCommits: async () => [ciFixCommit],
        filterVisible: filterVisibleCommits,
        getCommitTimestamp: async () => new Date(),
      };
      const result = await expandMarkerRangeUntilVisible(
        makeRange('marker-A'),
        [ciFixCommit],
        [],
        30,
        deps,
      );
      expect(result.hopsWalked).toBe(1);
      expect(result.range.startRef).toBe('marker-B');
    });

    it('stops at lastAnnouncedShaPrefix before crossing an already-announced beta', async () => {
      // Chain: origin → walk1 → announced-blocker → too-far.
      // Prefix 'announced' matches only the second hop's marker.
      const markerChain: Record<string, string | null> = {
        origin: 'walk1',
        walk1: 'announced-blocker',
        'announced-blocker': 'too-far',
      };
      const reached: string[] = [];
      const deps: ExpandMarkerRangeDeps = {
        getLatestMarker: async (ref) => markerChain[ref.replace(/\^$/, '')] ?? null,
        loadCommits: async (range) => {
          reached.push(range.startRef ?? '');
          return [ciFixCommit];
        },
        filterVisible: filterVisibleCommits,
        getCommitTimestamp: async () => new Date(),
        lastAnnouncedShaPrefix: 'announced',
      };

      const result = await expandMarkerRangeUntilVisible(
        makeRange('origin'),
        [ciFixCommit],
        [],
        30,
        deps,
      );
      expect(result.hopsWalked).toBe(1);
      expect(result.range.startRef).toBe('walk1');
      expect(reached).toEqual(['walk1']);
      expect(reached).not.toContain('announced-blocker');
      expect(reached).not.toContain('too-far');
    });

    it('does not walk at all when initialRange.startRef is already the last announced beta', async () => {
      // Regression: round-2 GPT review caught that the announced-prefix guard
      // only fires when newStartRef matches the prefix during the walk; if
      // initialRange.startRef itself is the most recent announced beta, the
      // very first hop would widen past it and re-include announced work.
      // Verify the early-return fires BEFORE any git access happens.
      let getLatestCalled = 0;
      let loadCommitsCalled = 0;
      let getTimestampCalled = 0;
      const deps: ExpandMarkerRangeDeps = {
        getLatestMarker: async () => {
          getLatestCalled += 1;
          return 'should-not-be-reached';
        },
        loadCommits: async () => {
          loadCommitsCalled += 1;
          return [ciFixCommit];
        },
        filterVisible: filterVisibleCommits,
        getCommitTimestamp: async () => {
          getTimestampCalled += 1;
          return new Date();
        },
        lastAnnouncedShaPrefix: 'announced',
      };

      const result = await expandMarkerRangeUntilVisible(
        makeRange('announced-full-sha-here'),
        [ciFixCommit],
        [],
        30,
        deps,
      );

      expect(result.hopsWalked).toBe(0);
      expect(result.range.startRef).toBe('announced-full-sha-here');
      expect(getLatestCalled).toBe(0);
      expect(loadCommitsCalled).toBe(0);
      expect(getTimestampCalled).toBe(0);
    });
  });

  it('renders the catch-up disclosure in markdown and Slack when consolidatedMarkerCount > 0', () => {
    const metadataBase: SummaryMetadata = {
      releaseSha: 'd'.repeat(40),
      releaseShaShort: 'ddddddd',
      betaVersion: '0.4.4113068',
      workflowRunUrl: 'https://example.com/workflow',
      runId: '321',
      runAttempt: '1',
      isBackfill: false,
      fallbackDays: 30,
      generationMode: 'summary',
      generatedAtIso: '2026-05-21T10:56:00.000Z',
      idempotencyKey: 'ddddddd-321-1',
      consolidatedMarkerCount: 0,
    };
    const buckets = {
      whatYoullSee: ['Homepage now shows a calmer Today summary.'],
      whatWeFixed: [],
      worthALook: [],
    };

    const single = renderMarkdown({ ...metadataBase, consolidatedMarkerCount: 1 }, buckets, null);
    expect(single).toContain("_Catches up on 1 earlier beta release whose summary didn't make it out._");
    expect(single).not.toContain('Quiet beta');

    const plural = renderMarkdown({ ...metadataBase, consolidatedMarkerCount: 3 }, buckets, null);
    expect(plural).toContain("_Catches up on 3 earlier beta releases whose summaries didn't make it out._");

    const slack = renderSlackPayload({ ...metadataBase, consolidatedMarkerCount: 2 }, buckets, null);
    const slackJson = JSON.stringify(slack);
    expect(slackJson).toContain("Catches up on 2 earlier beta releases whose summaries didn't make it out.");

    // Old phrasing must not appear anywhere.
    expect(single).not.toContain('rolls up');
    expect(plural).not.toContain('rolls up');
    expect(slackJson).not.toContain('rolls up');

    const zero = renderMarkdown({ ...metadataBase, consolidatedMarkerCount: 0 }, buckets, null);
    expect(zero).not.toContain('Catches up');

    // F2: when consolidatedMarkerCount is 0 alongside a quietMessage, the
    // catch-up line MUST NOT render — exhausted walk-back leaves a clean Quiet.
    const zeroQuiet = renderMarkdown(
      { ...metadataBase, consolidatedMarkerCount: 0, generationMode: 'quiet' },
      { whatYoullSee: [], whatWeFixed: [], worthALook: [] },
      'Quiet beta — internal plumbing only. Nothing user-visible this round.',
    );
    expect(zeroQuiet).toContain('_Quiet beta — internal plumbing only.');
    expect(zeroQuiet).not.toContain('Catches up');
    const zeroQuietSlack = renderSlackPayload(
      { ...metadataBase, consolidatedMarkerCount: 0, generationMode: 'quiet' },
      { whatYoullSee: [], whatWeFixed: [], worthALook: [] },
      'Quiet beta — internal plumbing only. Nothing user-visible this round.',
    );
    expect(JSON.stringify(zeroQuietSlack)).not.toContain('Catches up');

    const backfill = renderMarkdown(
      { ...metadataBase, consolidatedMarkerCount: 2, isBackfill: true },
      buckets,
      null,
    );
    expect(backfill).toContain('First generated beta summary');
    expect(backfill).not.toContain('Catches up');
  });
});

describe('post-beta-summary resilience (avoid needless fallback)', () => {
  const metadata: SummaryMetadata = {
    releaseSha: 'e'.repeat(40),
    releaseShaShort: 'eeeeeee',
    betaVersion: '0.4.5000000',
    workflowRunUrl: 'https://example.com/workflow',
    runId: '999',
    runAttempt: '1',
    isBackfill: false,
    fallbackDays: 30,
    generationMode: 'summary',
    generatedAtIso: '2026-06-03T08:00:00.000Z',
    idempotencyKey: 'eeeeeee-999-1',
    consolidatedMarkerCount: 0,
  };

  const commits: CommitInput[] = [
    { index: 0, hash: 'a'.repeat(40), type: 'feat', scope: 'homepage', subject: 'Add calmer Today card', bodyFirstLine: '' },
    { index: 1, hash: 'b'.repeat(40), type: 'fix', scope: 'voice', subject: 'Fix voice cutting out', bodyFirstLine: '' },
  ];

  it('drops a single malformed bullet but keeps the rest of the summary', () => {
    const result = parseLlmResponseDetailed(
      JSON.stringify({
        what_youll_see: [
          { bullet: 'The Today card is calmer.', source_indices: [0] },
          { bullet: 'References a commit that does not exist.', source_indices: [99] },
        ],
        what_we_fixed: [{ bullet: 'Voice no longer cuts out.', source_indices: [1] }],
        worth_a_look: [],
      }),
      commits.length,
      0,
    );

    expect(result.buckets.whatYoullSee).toEqual(['The Today card is calmer.']);
    expect(result.buckets.whatWeFixed).toEqual(['Voice no longer cuts out.']);
    expect(result.keptCount).toBe(2);
    expect(result.droppedReasons).toHaveLength(1);
    expect(result.droppedReasons[0]).toContain('out-of-range');
  });

  // End-to-end hostile-payload render smoke (Stage 3, rec 0b4878d6 /
  // 260607_make_beta_summaries_reliable_and_human). The existing banned-content
  // tests assert at the PARSE boundary; this drives a hostile model payload all
  // the way through parse -> renderMarkdown / renderSlackPayload and asserts no
  // banned token survives into the RENDERED Slack/markdown output. It guards the
  // whole parse+render composition, so a future render path that reintroduced
  // unfiltered text would fail here even if the parse filter still ran.
  it('hostile payload: no banned token survives into rendered Slack/markdown output', () => {
    const fixturePath = path.join(REPO_ROOT, 'scripts/__fixtures__/post-beta-summary/llm-response-hostile.json');
    const rawFixture = fs.readFileSync(fixturePath, 'utf8');
    const fixture = JSON.parse(rawFixture) as Record<string, unknown>;
    // Strip the human-readable _comment so only the LLM-response shape is parsed.
    const { _comment: _ignored, ...llmResponse } = fixture;

    // Non-vacuous guard #1: the fixture must actually contain banned content,
    // otherwise a clean rendered output would prove nothing.
    const hostileBulletText = JSON.stringify(llmResponse);
    const matchedInFixture = BANNED_BULLET_PATTERNS.filter(({ pattern }) => pattern.test(hostileBulletText));
    expect(matchedInFixture.length).toBeGreaterThan(0);

    const result = parseLlmResponseDetailed(JSON.stringify(llmResponse), commits.length, 0);

    // Non-vacuous guard #2: hostile bullets were actually dropped by the filter.
    expect(result.droppedReasons.join(' ')).toContain('banned content');
    // The clean, user-facing bullets still made it through (the filter is narrow).
    const survivors = [
      ...result.buckets.whatYoullSee,
      ...result.buckets.whatWeFixed,
      ...result.buckets.worthALook,
    ].join(' ');
    expect(survivors).toContain('Setup now explains itself');
    expect(survivors).toContain('retry quietly in the background');
    expect(survivors).toContain('snappier during longer sessions');

    // The actual smoke: render the full output and assert NO banned pattern leaks.
    const rendered = [
      renderMarkdown(metadata, result.buckets, null),
      JSON.stringify(renderSlackPayload(metadata, result.buckets, null)),
    ].join('\n');

    for (const { label, pattern } of BANNED_BULLET_PATTERNS) {
      expect(
        pattern.test(rendered),
        `Rendered beta-summary output leaked banned content (${label}); pattern ${pattern}`,
      ).toBe(false);
    }
  });

  it('treats a missing bucket key as empty rather than throwing', () => {
    expect(() => parseLlmResponseDetailed(
      JSON.stringify({ what_youll_see: [{ bullet: 'Valid.', source_indices: [0] }] }),
      commits.length,
      0,
    )).not.toThrow();
  });

  it('retries with the validation error and recovers without falling back', async () => {
    const attempts: string[] = [];
    const requester = async (userContent: string, attempt: number): Promise<string> => {
      attempts.push(userContent);
      if (attempt === 1) {
        return JSON.stringify({
          what_youll_see: [{ bullet: 'Bad bullet.', source_indices: [99] }],
          what_we_fixed: [],
          worth_a_look: [],
        });
      }
      return JSON.stringify({
        what_youll_see: [{ bullet: 'The Today card is calmer.', source_indices: [0] }],
        what_we_fixed: [],
        worth_a_look: [],
      });
    };

    const buckets = await generateBucketsWithLlm(commits, [], metadata, undefined, requester);
    expect(buckets.whatYoullSee).toEqual(['The Today card is calmer.']);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toContain('a previous attempt was rejected');
  });

  it('falls back only after exhausting all retries', async () => {
    let calls = 0;
    const requester = async (): Promise<string> => {
      calls += 1;
      return JSON.stringify({
        what_youll_see: [{ bullet: 'Still bad.', source_indices: [99] }],
        what_we_fixed: [],
        worth_a_look: [],
      });
    };

    await expect(
      generateBucketsWithLlm(commits, [], metadata, undefined, requester),
    ).rejects.toThrow(/No usable bullets/);
    expect(calls).toBe(3);
  });

  it('retries then fails when the model returns no bullets despite visible commits', async () => {
    let calls = 0;
    const requester = async (): Promise<string> => {
      calls += 1;
      return JSON.stringify({ what_youll_see: [], what_we_fixed: [], worth_a_look: [] });
    };

    await expect(
      generateBucketsWithLlm(commits, [], metadata, undefined, requester),
    ).rejects.toThrow(/No usable bullets/);
    expect(calls).toBe(3);
  });

  it('accepts an empty response only when there is nothing to summarise', async () => {
    let calls = 0;
    const requester = async (): Promise<string> => {
      calls += 1;
      return JSON.stringify({ what_youll_see: [], what_we_fixed: [], worth_a_look: [] });
    };

    const buckets = await generateBucketsWithLlm([], [], metadata, undefined, requester);
    expect(buckets).toEqual({ whatYoullSee: [], whatWeFixed: [], worthALook: [] });
    expect(calls).toBe(1);
  });

  it('salvages a full JSON object even when the model ignores the assistant prefill', async () => {
    const requester = async (): Promise<string> =>
      'Sure, here is the summary:\n{"what_youll_see":[{"bullet":"The Today card is calmer.","source_indices":[0]}],"what_we_fixed":[],"worth_a_look":[]}';

    const buckets = await generateBucketsWithLlm(commits, [], metadata, undefined, requester);
    expect(buckets.whatYoullSee).toEqual(['The Today card is calmer.']);
  });

  it('composes "Area — change" from the structured schema (where + what)', () => {
    const result = parseLlmResponseDetailed(
      JSON.stringify({
        what_youll_see: [{ area: 'Connectors', change: 'setup explains itself when it needs attention.', source_indices: [0] }],
        what_we_fixed: [{ area: 'Voice', change: 'no longer cuts out mid-sentence.', source_indices: [1] }],
        worth_a_look: [],
      }),
      commits.length,
      0,
    );

    expect(result.buckets.whatYoullSee).toEqual(['Connectors — setup explains itself when it needs attention.']);
    expect(result.buckets.whatWeFixed).toEqual(['Voice — no longer cuts out mid-sentence.']);
  });

  it('still accepts a legacy single-bullet entry for backward compatibility', () => {
    const result = parseLlmResponseDetailed(
      JSON.stringify({
        what_youll_see: [{ bullet: 'The Today card is calmer.', source_indices: [0] }],
        what_we_fixed: [],
        worth_a_look: [],
      }),
      commits.length,
      0,
    );

    expect(result.buckets.whatYoullSee).toEqual(['The Today card is calmer.']);
    expect(result.droppedReasons).toEqual([]);
  });

  it('drops an entry that has neither area+change nor a legacy bullet', () => {
    const result = parseLlmResponseDetailed(
      JSON.stringify({
        what_youll_see: [
          { area: 'Connectors', change: 'clearer setup.', source_indices: [0] },
          { area: 'Files', source_indices: [1] },
        ],
        what_we_fixed: [],
        worth_a_look: [],
      }),
      commits.length,
      0,
    );

    expect(result.buckets.whatYoullSee).toEqual(['Connectors — clearer setup.']);
    expect(result.droppedReasons).toHaveLength(1);
    expect(result.droppedReasons[0]).toContain('missing area+change');
  });

  it('instructs the writer to give an app area and forbids engineering jargon', () => {
    const prompt = buildLlmSystemPrompt();
    expect(prompt).toContain('"area"');
    expect(prompt).toContain('"change"');
    expect(prompt).toContain('No issue or ticket IDs');
    expect(prompt).toContain('No "Stage N"');
    expect(prompt).toContain('No commit-style prefixes');
  });

  it('drops bullets that leak ticket IDs, stage refs, or code constants even if the model ignores the prompt', () => {
    const result = parseLlmResponseDetailed(
      JSON.stringify({
        what_youll_see: [
          { area: 'Conflict-copy cleanup engine (REBEL-62A)', change: 'Stage 2 refinement preserves the sub-agent overlay.', source_indices: [0] },
          { area: 'Settings', change: 'USER_MESSAGE_MAX_CHARS was raised so long requests are not truncated.', source_indices: [1] },
          { area: 'Connectors', change: 'setup now explains itself when it needs attention.', source_indices: [0] },
        ],
        what_we_fixed: [],
        worth_a_look: [],
      }),
      commits.length,
      0,
    );

    // Only the clean, user-facing bullet survives.
    expect(result.buckets.whatYoullSee).toEqual(['Connectors — setup now explains itself when it needs attention.']);
    expect(result.droppedReasons).toHaveLength(2);
    expect(result.droppedReasons.join(' ')).toContain('banned content');
  });

  it('does not drop legitimate user-facing copy that mentions model names', () => {
    const result = parseLlmResponseDetailed(
      JSON.stringify({
        what_youll_see: [
          { area: 'Model picker', change: 'GPT-5 now shows estimated cost per model before you switch.', source_indices: [0] },
        ],
        what_we_fixed: [],
        worth_a_look: [],
      }),
      commits.length,
      0,
    );

    expect(result.buckets.whatYoullSee).toEqual(['Model picker — GPT-5 now shows estimated cost per model before you switch.']);
    expect(result.droppedReasons).toEqual([]);
  });
});

// Regression coverage for the 260531 incident: the internal-changelog archive
// commit path must be observable and non-silent so the last-announced release
// state can be trusted. See
// docs-private/postmortems/260531_beta_slack_summary_walks_back_across_55d515e_p3_postmortem.md
// and docs/plans/260614_recs8-changelog-observability/.
describe('commitAndPushSummary — observable archive outcome', () => {
  type SummaryBundle = Parameters<typeof commitAndPushSummary>[0];

  function makePostedBundle(): SummaryBundle {
    const metadata = {
      releaseSha: 'abcdef1234567890abcdef1234567890abcdef12',
      releaseShaShort: 'abcdef1',
      betaVersion: '1.2.3',
      workflowRunUrl: 'https://example.test/run',
      runId: 'run-1',
      runAttempt: '1',
      isBackfill: false,
      fallbackDays: 14,
      generatedAtIso: '2026-06-14T00:00:00.000Z',
      idempotencyKey: 'abcdef1-run-1-1',
      consolidatedMarkerCount: 0,
      generationMode: 'summary',
    } as unknown as SummaryMetadata;
    return {
      kind: 'posted',
      metadata,
      markdown: '### Beta v1.2.3 (abcdef1)\n\n- Conversations — something changed.',
      slackPayload: { blocks: [] },
    } as unknown as SummaryBundle;
  }

  /**
   * Records emitted archive outcomes and EVERY git arg invoked. The optional
   * `runGit` behaviour is wrapped so `gitCalls` recording is preserved even when
   * a test customises the git responses (otherwise `gitCalls.some(...)` checks
   * would be vacuous).
   */
  function makeDeps(overrides: {
    runGit?: (args: string[]) => Promise<string>;
    tryGit?: CommitArchiveDeps['tryGit'];
  } = {}): {
    deps: CommitArchiveDeps;
    emitted: ArchiveCommitOutcome[];
    gitCalls: string[][];
  } {
    const emitted: ArchiveCommitOutcome[] = [];
    const gitCalls: string[][] = [];
    let changelog = '## Latest\n';
    const defaultRunGit = async (args: string[]): Promise<string> => {
      // Simulate `git diff --cached --name-only` returning the staged file by default.
      if (args[0] === 'diff' && args.includes('--cached')) {
        return 'INTERNAL_CHANGELOG.md';
      }
      return '';
    };
    const runGitBehaviour = overrides.runGit ?? defaultRunGit;
    const deps: CommitArchiveDeps = {
      runGit: async (args) => {
        gitCalls.push(args);
        return runGitBehaviour(args);
      },
      tryGit: overrides.tryGit ?? (async () => ({ ok: true, stdout: '' })),
      readChangelog: async () => changelog,
      writeChangelog: async (content) => {
        changelog = content;
      },
      emitOutcome: (outcome) => {
        emitted.push(outcome);
      },
    };
    return { deps, emitted, gitCalls };
  }

  it('reports a `committed` outcome and pushes on the success path', async () => {
    const { deps, emitted, gitCalls } = makeDeps();
    const outcome = await commitAndPushSummary(makePostedBundle(), { lenient: false }, deps);

    expect(outcome.kind).toBe('committed');
    expect(outcome.succeeded).toBe(true);
    expect(outcome.pushAttempts).toBe(1);
    expect(outcome.releaseShaShort).toBe('abcdef1');
    // The structured outcome is emitted exactly once for observability.
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual(outcome);
    // A real commit + push happened.
    expect(gitCalls.some((c) => c[0] === 'commit')).toBe(true);
    expect(gitCalls.some((c) => c[0] === 'push')).toBe(true);
  });

  it('surfaces a no-op (no staged change) as observable degraded state, not silent success', async () => {
    // `git diff --cached --name-only` returns nothing — the file write produced
    // no staged change, so the archive did NOT advance.
    const { deps, emitted, gitCalls } = makeDeps({
      runGit: async (args) => {
        if (args[0] === 'diff' && args.includes('--cached')) {
          return '';
        }
        return '';
      },
    });
    const outcome = await commitAndPushSummary(makePostedBundle(), { lenient: false }, deps);

    expect(outcome.kind).toBe('no-op');
    // Critically: a no-op is NOT reported as a clean success (was a silent `return true`).
    expect(outcome.succeeded).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe('no-op');
    // No commit/push was attempted on the no-op path.
    expect(gitCalls.some((c) => c[0] === 'commit')).toBe(false);
    expect(gitCalls.some((c) => c[0] === 'push')).toBe(false);
  });

  it('recovers via fetch+rebase and reports `committed` with the right attempt count', async () => {
    let pushCalls = 0;
    const { deps, emitted, gitCalls } = makeDeps({
      runGit: async (args) => {
        if (args[0] === 'diff' && args.includes('--cached')) {
          return 'INTERNAL_CHANGELOG.md';
        }
        if (args[0] === 'push') {
          pushCalls += 1;
          if (pushCalls === 1) {
            throw new Error('non-fast-forward');
          }
          return '';
        }
        return '';
      },
    });
    const outcome = await commitAndPushSummary(makePostedBundle(), { lenient: false }, deps);

    expect(outcome.kind).toBe('committed');
    expect(outcome.succeeded).toBe(true);
    expect(outcome.pushAttempts).toBe(2);
    // The first failure triggered a fetch + rebase before the second push.
    expect(gitCalls.some((c) => c[0] === 'fetch')).toBe(true);
    expect(gitCalls.some((c) => c[0] === 'rebase' && c[1] === 'origin/dev')).toBe(true);
    expect(emitted).toHaveLength(1);
  });

  it('reports a `wrote-no-commit` outcome when git is intentionally skipped (--no-commit)', async () => {
    const { deps, emitted, gitCalls } = makeDeps();
    const outcome = await commitAndPushSummary(
      makePostedBundle(),
      { lenient: false, skipGitCommit: true },
      deps,
    );

    expect(outcome.kind).toBe('wrote-no-commit');
    expect(outcome.succeeded).toBe(true);
    expect(gitCalls).toHaveLength(0);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe('wrote-no-commit');
  });

  it('reports a `push-failed` outcome in lenient mode without throwing', async () => {
    const { deps, emitted } = makeDeps({
      runGit: async (args) => {
        if (args[0] === 'diff' && args.includes('--cached')) {
          return 'INTERNAL_CHANGELOG.md';
        }
        if (args[0] === 'push') {
          throw new Error('remote rejected: protected branch');
        }
        return '';
      },
    });
    const outcome = await commitAndPushSummary(makePostedBundle(), { lenient: true }, deps);

    expect(outcome.kind).toBe('push-failed');
    expect(outcome.succeeded).toBe(false);
    expect(outcome.pushAttempts).toBe(3);
    expect(outcome.error).toContain('protected branch');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe('push-failed');
  });

  it('throws on push failure in strict (non-lenient) mode after emitting the outcome', async () => {
    const { deps, emitted } = makeDeps({
      runGit: async (args) => {
        if (args[0] === 'diff' && args.includes('--cached')) {
          return 'INTERNAL_CHANGELOG.md';
        }
        if (args[0] === 'push') {
          throw new Error('network unreachable');
        }
        return '';
      },
    });

    await expect(commitAndPushSummary(makePostedBundle(), { lenient: false }, deps)).rejects.toThrow(
      'network unreachable',
    );
    // The failure is still observable even though the caller gets a throw.
    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe('push-failed');
  });

  it('reports a `commit-failed` outcome when `git commit` itself fails (lenient)', async () => {
    const { deps, emitted, gitCalls } = makeDeps({
      runGit: async (args) => {
        if (args[0] === 'diff' && args.includes('--cached')) {
          return 'INTERNAL_CHANGELOG.md';
        }
        if (args[0] === 'commit') {
          throw new Error('pre-commit hook rejected');
        }
        return '';
      },
    });
    const outcome = await commitAndPushSummary(makePostedBundle(), { lenient: true }, deps);

    expect(outcome.kind).toBe('commit-failed');
    expect(outcome.succeeded).toBe(false);
    expect(outcome.error).toContain('pre-commit hook rejected');
    // The commit failed, so push must never be attempted.
    expect(gitCalls.some((c) => c[0] === 'push')).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe('commit-failed');
  });

  it('reports a `skipped-bundle` outcome and touches no git for a skipped summary', async () => {
    const { deps, emitted, gitCalls } = makeDeps();
    const skippedBundle = {
      kind: 'skipped',
      metadata: makePostedBundle().metadata,
      skipReason: 'already posted for release abcdef1',
    } as unknown as SummaryBundle;

    const outcome = await commitAndPushSummary(skippedBundle, { lenient: false }, deps);

    expect(outcome.kind).toBe('skipped-bundle');
    expect(outcome.succeeded).toBe(true);
    expect(gitCalls).toHaveLength(0);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe('skipped-bundle');
  });
});
