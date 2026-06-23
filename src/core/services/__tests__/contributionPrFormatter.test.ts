/**
 * Tests for `src/core/services/contributionPrFormatter.ts` (Stage 1).
 *
 * Covers the full Stage 5 formatter test list from
 * `docs/plans/260424_contribution_pr_template_revamp.md`.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appendBuildContextAppendix,
  BODY_MAX,
  classifyBuildPlanShape,
  computePayloadFingerprintExcludingAppendix,
  ContributionPrFormatterValidationError,
  formatBuildContextAppendix,
  MAX_APPENDIX_LEN,
  TITLE_MAX,
  buildValidationEvidence,
  composePrMetadata,
  formatContributionPrBody,
  formatContributionPrTitle,
  hasUserPrFormContent,
  inferConfigSummaryFromDisk,
  inferSummaryFromDisk,
  sanitizeForGitHub,
  type BuildContext,
  type ComposePrMetadataInput,
  type ConfigInferenceResult,
} from '../contributionPrFormatter';

// ─── Helpers ────────────────────────────────────────────────────────

const baseInput = (
  overrides: Partial<ComposePrMetadataInput> = {},
): ComposePrMetadataInput => ({
  connectorName: 'humaans',
  attributionMode: 'rebel-name',
  attributionName: 'Alice',
  includeSubmitterInTitle: true,
  submissionPath: 'Rebel relay',
  summary: 'Adds the Humaans connector.',
  motivation: 'Needed by HR teams.',
  reviewerNotes: undefined,
  configResult: { outcome: 'missing' },
  validationEvidence: buildValidationEvidence(),
  ...overrides,
});

const baseBuildContext = (
  overrides: Partial<BuildContext> = {},
): BuildContext => ({
  model: 'claude-opus-4-7',
  appVersion: '0.13.4',
  sessionId: 'session-123',
  appWorkflow: 'software-engineer',
  taskSubagentTypes: ['planner', 'implementer', 'reviewer'],
  buildPlanShape: 'se-working-doc',
  ...overrides,
});

// ─── formatContributionPrTitle ──────────────────────────────────────

describe('formatContributionPrTitle', () => {
  it('returns bare title for anonymous mode (suffix omitted)', () => {
    const title = formatContributionPrTitle({
      connectorName: 'humaans',
      attributionName: undefined,
      attributionMode: 'anonymous',
      includeSubmitterInTitle: true,
    });
    expect(title).toBe('feat(connector): add humaans');
  });

  it('returns bare title when includeSubmitterInTitle is false (own-fork case)', () => {
    const title = formatContributionPrTitle({
      connectorName: 'humaans',
      attributionName: 'octocat',
      attributionMode: 'github',
      includeSubmitterInTitle: false,
    });
    expect(title).toBe('feat(connector): add humaans');
  });

  it('appends submitter suffix for rebel-name mode', () => {
    const title = formatContributionPrTitle({
      connectorName: 'humaans',
      attributionName: 'Alice',
      attributionMode: 'rebel-name',
      includeSubmitterInTitle: true,
    });
    expect(title).toBe('feat(connector): add humaans — submitted by Alice');
  });

  it('appends submitter suffix for github mode when includeSubmitterInTitle is true', () => {
    const title = formatContributionPrTitle({
      connectorName: 'humaans',
      attributionName: 'octocat',
      attributionMode: 'github',
      includeSubmitterInTitle: true,
    });
    expect(title).toBe('feat(connector): add humaans — submitted by octocat');
  });

  it('drops suffix when appending would push past TITLE_MAX', () => {
    // "feat(connector): add " = 21 chars. connectorName padded so the
    // bare title ≤ 120 but bare+suffix > 120.
    const longConnector = 'a'.repeat(80);
    const longName = 'Alice-'.repeat(20);
    const title = formatContributionPrTitle({
      connectorName: longConnector,
      attributionName: longName,
      attributionMode: 'rebel-name',
      includeSubmitterInTitle: true,
    });
    expect(title).toBe(`feat(connector): add ${longConnector}`);
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
  });

  it('keeps suffix when the combined title is exactly TITLE_MAX', () => {
    // Total length with suffix must be exactly 120.
    // Layout: "feat(connector): add " (21) + connector + " — submitted by " (16) + name = 120
    // (the em-dash `—` counts as 1 code unit in JS). So connector + name = 83.
    const connectorName = 'c'.repeat(42);
    const attributionName = 'n'.repeat(41);
    const title = formatContributionPrTitle({
      connectorName,
      attributionName,
      attributionMode: 'rebel-name',
      includeSubmitterInTitle: true,
    });
    expect(title.length).toBe(TITLE_MAX);
    expect(title).toContain(`— submitted by ${attributionName}`);
  });

  it('throws when includeSubmitterInTitle=true + rebel-name + attributionName missing', () => {
    expect(() =>
      formatContributionPrTitle({
        connectorName: 'humaans',
        attributionName: undefined,
        attributionMode: 'rebel-name',
        includeSubmitterInTitle: true,
      }),
    ).toThrow(ContributionPrFormatterValidationError);
  });

  it('throws when includeSubmitterInTitle=true + github + attributionName empty', () => {
    expect(() =>
      formatContributionPrTitle({
        connectorName: 'humaans',
        attributionName: '',
        attributionMode: 'github',
        includeSubmitterInTitle: true,
      }),
    ).toThrow(ContributionPrFormatterValidationError);
  });

  it('throws when includeSubmitterInTitle=true + rebel-name + whitespace-only attributionName', () => {
    expect(() =>
      formatContributionPrTitle({
        connectorName: 'humaans',
        attributionName: '   \t  ',
        attributionMode: 'rebel-name',
        includeSubmitterInTitle: true,
      }),
    ).toThrow(ContributionPrFormatterValidationError);
  });

  it('does NOT throw when includeSubmitterInTitle=false + missing name (own-fork w/ anon submitter)', () => {
    expect(() =>
      formatContributionPrTitle({
        connectorName: 'humaans',
        attributionName: undefined,
        attributionMode: 'github',
        includeSubmitterInTitle: false,
      }),
    ).not.toThrow();
  });
});

// ─── formatContributionPrBody ───────────────────────────────────────

describe('formatContributionPrBody', () => {
  it('emits Submitter for rebel-name; skips when anonymous', () => {
    const nonAnonBody = formatContributionPrBody(baseInput({ attributionMode: 'rebel-name', attributionName: 'Alice' }));
    expect(nonAnonBody).toContain('## Submitter\nAlice');

    const anonBody = formatContributionPrBody(baseInput({ attributionMode: 'anonymous', attributionName: undefined }));
    expect(anonBody).not.toContain('## Submitter');
  });

  it('throws fail-closed when non-anonymous mode has missing attributionName', () => {
    expect(() =>
      formatContributionPrBody(baseInput({ attributionMode: 'rebel-name', attributionName: undefined })),
    ).toThrow(ContributionPrFormatterValidationError);

    expect(() =>
      formatContributionPrBody(baseInput({ attributionMode: 'github', attributionName: '' })),
    ).toThrow(ContributionPrFormatterValidationError);
  });

  it('omits Summary and Why sections when empty after trim and no inferred fallback', () => {
    const body = formatContributionPrBody(
      baseInput({ summary: '   ', motivation: '', inferredSummary: undefined }),
    );
    expect(body).not.toContain('## Summary');
    expect(body).not.toContain('## Why this connector is useful');
  });

  it('falls back to inferredSummary when user summary is empty', () => {
    const body = formatContributionPrBody(
      baseInput({ summary: '', inferredSummary: 'A tiny MCP server returning random shapes.' }),
    );
    expect(body).toContain('## Summary\nA tiny MCP server returning random shapes.');
  });

  it('falls back to inferredSummary when user summary is whitespace-only', () => {
    const body = formatContributionPrBody(
      baseInput({ summary: '   \n  ', inferredSummary: 'Inferred from package.json.' }),
    );
    expect(body).toContain('## Summary\nInferred from package.json.');
  });

  it('user summary wins over inferredSummary when both are non-empty', () => {
    const body = formatContributionPrBody(
      baseInput({ summary: 'User wrote this.', inferredSummary: 'Auto-generated description.' }),
    );
    expect(body).toContain('## Summary\nUser wrote this.');
    expect(body).not.toContain('Auto-generated description.');
  });

  it('omits Summary section when both user summary and inferredSummary are empty/whitespace', () => {
    const body = formatContributionPrBody(
      baseInput({ summary: '   ', inferredSummary: '   ' }),
    );
    expect(body).not.toContain('## Summary');
  });

  it('emits Breaking changes / reviewer notes only when non-empty', () => {
    const withNotes = formatContributionPrBody(baseInput({ reviewerNotes: 'Requires Node 20+.' }));
    expect(withNotes).toContain('## Breaking changes / reviewer notes\nRequires Node 20+.');

    const withoutNotes = formatContributionPrBody(baseInput({ reviewerNotes: undefined }));
    expect(withoutNotes).not.toContain('## Breaking changes / reviewer notes');

    const whitespaceNotes = formatContributionPrBody(baseInput({ reviewerNotes: '  \n  ' }));
    expect(whitespaceNotes).not.toContain('## Breaking changes / reviewer notes');
  });

  it('always emits Validation section', () => {
    const body = formatContributionPrBody(baseInput());
    expect(body).toContain('## Validation');
    expect(body).toContain('Pre-submit checks passed in Rebel');
  });

  it('narrows on configResult.outcome: parsed emits summary', () => {
    const body = formatContributionPrBody(
      baseInput({ configResult: { outcome: 'parsed', summary: 'API_KEY, API_URL' } }),
    );
    expect(body).toContain('## Configuration / docs\nAPI_KEY, API_URL');
  });

  it('narrows on configResult.outcome: none emits "None"', () => {
    const body = formatContributionPrBody(baseInput({ configResult: { outcome: 'none' } }));
    expect(body).toContain('## Configuration / docs\nNone');
  });

  it('narrows on configResult.outcome: missing omits the section', () => {
    const body = formatContributionPrBody(baseInput({ configResult: { outcome: 'missing' } }));
    expect(body).not.toContain('## Configuration / docs');
  });

  it('narrows on configResult.outcome: read_error omits the section', () => {
    const body = formatContributionPrBody(
      baseInput({ configResult: { outcome: 'read_error', errorCode: 'EACCES' } }),
    );
    expect(body).not.toContain('## Configuration / docs');
  });
});

// ─── sanitizeForGitHub ─────────────────────────────────────────────

describe('sanitizeForGitHub', () => {
  it('strips <script, <iframe, <object, <embed (case-insensitive)', () => {
    // Mirrors backend: removes the matched tag opener entirely (empty replacement).
    // See rebel-platform/server/schemas/contribution-relay-v1.ts:172-174.
    expect(sanitizeForGitHub('hello <script>alert(1)</script>')).toBe('hello >alert(1)</script>');
    expect(sanitizeForGitHub('<Script >')).toBe(' >');
    expect(sanitizeForGitHub('<IFRAME src=x>')).toBe(' src=x>');
    expect(sanitizeForGitHub('<OBJECT data=x>')).toBe(' data=x>');
    expect(sanitizeForGitHub('<embed src=x>')).toBe(' src=x>');
  });

  it('does NOT strip partial matches without word boundary', () => {
    // <scripting> — "scripting" is different token, \b fails after "script"
    expect(sanitizeForGitHub('<scripting>')).toBe('<scripting>');
    expect(sanitizeForGitHub('<scriptfoo')).toBe('<scriptfoo');
    expect(sanitizeForGitHub('<iframes>')).toBe('<iframes>');
  });

  it('leaves unrelated content untouched', () => {
    expect(sanitizeForGitHub('no tags here')).toBe('no tags here');
    expect(sanitizeForGitHub('<div>ok</div>')).toBe('<div>ok</div>');
  });

  it('strips multiple occurrences', () => {
    const input = '<script>one</script> and <IFRAME>two</IFRAME>';
    expect(sanitizeForGitHub(input)).toBe('>one</script> and >two</IFRAME>');
  });

  it('byte-equal to a local copy of the backend regex transform', () => {
    // Pin a literal copy of the backend's sanitizePrBody. If this test fails
    // after a backend change, update the regex here AND file an issue to
    // extract this to a shared schemas package (plan's deferred item I4).
    // Backend source: rebel-platform/server/schemas/contribution-relay-v1.ts:97,172-174
    const backendRegex = /<(script|iframe|object|embed)\b/gi;
    const backendSanitize = (raw: string): string => raw.replace(backendRegex, '');

    const adversarialFixtures = [
      '<script>alert(1)</script>',
      '<SCRIPT>x</SCRIPT>',
      'leading <iframe src="x"></iframe> trailing',
      'mixed <div><object data="x"></object></div>',
      '<embed\nsrc="x">',
      '<scripting>kept</scripting>',
      '<scriptfoo',
      '<iframes>word boundary keeps me</iframes>',
      'plain text with no tags',
      '',
      '<<<script>>>',
      'nested <iframe><script>both</script></iframe>',
      '<script/>self-closing',
    ];

    for (const input of adversarialFixtures) {
      expect(sanitizeForGitHub(input)).toBe(backendSanitize(input));
    }
  });
});

// ─── inferConfigSummaryFromDisk ─────────────────────────────────────

describe('inferConfigSummaryFromDisk', () => {
  let rootTmp: string;

  beforeAll(async () => {
    rootTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-pr-formatter-'));
  });

  afterAll(async () => {
    await fs.rm(rootTmp, { recursive: true, force: true }).catch(() => undefined);
  });

  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(rootTmp, 'case-'));
  });

  it('returns missing when .env.example is absent', async () => {
    const result = await inferConfigSummaryFromDisk(dir);
    expect(result).toEqual<ConfigInferenceResult>({ outcome: 'missing' });
  });

  it('returns none for empty file', async () => {
    await fs.writeFile(path.join(dir, '.env.example'), '', 'utf8');
    const result = await inferConfigSummaryFromDisk(dir);
    expect(result).toEqual<ConfigInferenceResult>({ outcome: 'none' });
  });

  it('returns none for comment-and-blank-only file', async () => {
    await fs.writeFile(
      path.join(dir, '.env.example'),
      '# header comment\n\n# another comment\n   \n',
      'utf8',
    );
    const result = await inferConfigSummaryFromDisk(dir);
    expect(result).toEqual<ConfigInferenceResult>({ outcome: 'none' });
  });

  it('returns parsed for mixed valid/malformed lines — keeps valid keys', async () => {
    await fs.writeFile(
      path.join(dir, '.env.example'),
      '# comment\nAPI_KEY=x\nnot a real line\nANOTHER_VAR=y\n# more\n',
      'utf8',
    );
    const result = await inferConfigSummaryFromDisk(dir);
    expect(result).toEqual<ConfigInferenceResult>({
      outcome: 'parsed',
      summary: 'API_KEY, ANOTHER_VAR',
    });
  });

  it('returns none when all lines are malformed (no valid key matches)', async () => {
    await fs.writeFile(
      path.join(dir, '.env.example'),
      'lowercase_key=1\n9STARTS_WITH_DIGIT=2\nJUST_TEXT\n',
      'utf8',
    );
    const result = await inferConfigSummaryFromDisk(dir);
    expect(result).toEqual<ConfigInferenceResult>({ outcome: 'none' });
  });

  it('recognises "export KEY=value" form', async () => {
    await fs.writeFile(path.join(dir, '.env.example'), 'export API_KEY=xyz\n', 'utf8');
    const result = await inferConfigSummaryFromDisk(dir);
    expect(result).toEqual<ConfigInferenceResult>({ outcome: 'parsed', summary: 'API_KEY' });
  });

  it('truncates at 10 keys with "...and N more" suffix', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `KEY_${i}=v`).join('\n');
    await fs.writeFile(path.join(dir, '.env.example'), lines, 'utf8');
    const result = await inferConfigSummaryFromDisk(dir);
    expect(result.outcome).toBe('parsed');
    if (result.outcome !== 'parsed') throw new Error('unreachable');
    // First 10 keys present, trailing suffix "...and 40 more".
    expect(result.summary).toContain('KEY_0');
    expect(result.summary).toContain('KEY_9');
    expect(result.summary).not.toContain('KEY_10');
    expect(result.summary).toContain('...and 40 more');
  });

  it('extracts the key only for a very long value', async () => {
    const longVal = 'v'.repeat(5000);
    await fs.writeFile(path.join(dir, '.env.example'), `ABC_DEF=${longVal}\n`, 'utf8');
    const result = await inferConfigSummaryFromDisk(dir);
    expect(result).toEqual<ConfigInferenceResult>({ outcome: 'parsed', summary: 'ABC_DEF' });
  });

  it('returns missing for a non-existent localServerPath', async () => {
    const bogus = path.join(rootTmp, 'definitely-does-not-exist', 'nested');
    const result = await inferConfigSummaryFromDisk(bogus);
    expect(result).toEqual<ConfigInferenceResult>({ outcome: 'missing' });
  });

  it('returns missing for empty-string localServerPath', async () => {
    const result = await inferConfigSummaryFromDisk('');
    expect(result).toEqual<ConfigInferenceResult>({ outcome: 'missing' });
  });

  it('returns missing for undefined localServerPath', async () => {
    const result = await inferConfigSummaryFromDisk(undefined);
    expect(result).toEqual<ConfigInferenceResult>({ outcome: 'missing' });
  });

  it('returns read_error for non-ENOENT fs failures (EISDIR via directory-named .env.example)', async () => {
    // Creating `.env.example` as a directory triggers EISDIR on readFile.
    await fs.mkdir(path.join(dir, '.env.example'));
    const result = await inferConfigSummaryFromDisk(dir);
    expect(result.outcome).toBe('read_error');
    if (result.outcome !== 'read_error') throw new Error('unreachable');
    expect(result.errorCode).toBe('EISDIR');
  });
});

// ─── inferSummaryFromDisk ───────────────────────────────────────────

describe('inferSummaryFromDisk', () => {
  let rootTmp: string;

  beforeAll(async () => {
    rootTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-pr-summary-'));
  });

  afterAll(async () => {
    await fs.rm(rootTmp, { recursive: true, force: true }).catch(() => undefined);
  });

  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(rootTmp, 'case-'));
  });

  it('returns the description when package.json has a non-empty description', async () => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'foo-mcp',
        description: 'A tiny MCP server that returns random shapes.',
      }),
      'utf8',
    );
    const result = await inferSummaryFromDisk(dir);
    expect(result).toBe('A tiny MCP server that returns random shapes.');
  });

  it('trims whitespace from the description', async () => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ description: '  Padded description.  \n' }),
      'utf8',
    );
    const result = await inferSummaryFromDisk(dir);
    expect(result).toBe('Padded description.');
  });

  it('returns undefined when package.json is absent (ENOENT)', async () => {
    const result = await inferSummaryFromDisk(dir);
    expect(result).toBeUndefined();
  });

  it('returns undefined when description field is missing', async () => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'foo-mcp' }),
      'utf8',
    );
    const result = await inferSummaryFromDisk(dir);
    expect(result).toBeUndefined();
  });

  it('returns undefined when description is an empty string', async () => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ description: '' }),
      'utf8',
    );
    const result = await inferSummaryFromDisk(dir);
    expect(result).toBeUndefined();
  });

  it('returns undefined when description is whitespace-only', async () => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ description: '   \n\t  ' }),
      'utf8',
    );
    const result = await inferSummaryFromDisk(dir);
    expect(result).toBeUndefined();
  });

  it('returns undefined when description is not a string', async () => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ description: 123 }),
      'utf8',
    );
    const result = await inferSummaryFromDisk(dir);
    expect(result).toBeUndefined();
  });

  it('returns undefined for malformed JSON', async () => {
    await fs.writeFile(path.join(dir, 'package.json'), '{ not valid json', 'utf8');
    const result = await inferSummaryFromDisk(dir);
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty-string localServerPath', async () => {
    const result = await inferSummaryFromDisk('');
    expect(result).toBeUndefined();
  });

  it('returns undefined for undefined localServerPath', async () => {
    const result = await inferSummaryFromDisk(undefined);
    expect(result).toBeUndefined();
  });

  it('returns undefined for non-existent directory', async () => {
    const bogus = path.join(rootTmp, 'definitely-does-not-exist', 'nested');
    const result = await inferSummaryFromDisk(bogus);
    expect(result).toBeUndefined();
  });

  it('returns undefined on non-ENOENT fs error (EISDIR via directory-named package.json)', async () => {
    await fs.mkdir(path.join(dir, 'package.json'));
    const result = await inferSummaryFromDisk(dir);
    expect(result).toBeUndefined();
  });
});

// ─── hasUserPrFormContent ───────────────────────────────────────────

describe('hasUserPrFormContent', () => {
  it('returns false when no fields present', () => {
    expect(hasUserPrFormContent({})).toBe(false);
    expect(
      hasUserPrFormContent({ summary: undefined, motivation: undefined, reviewerNotes: undefined }),
    ).toBe(false);
  });

  it('returns true for summary-only', () => {
    expect(hasUserPrFormContent({ summary: 'hi' })).toBe(true);
  });

  it('returns true for motivation-only', () => {
    expect(hasUserPrFormContent({ motivation: 'x' })).toBe(true);
  });

  it('returns true for reviewerNotes-only', () => {
    expect(hasUserPrFormContent({ reviewerNotes: 'x' })).toBe(true);
  });

  it('returns true when multiple fields are non-empty', () => {
    expect(hasUserPrFormContent({ summary: 'a', motivation: 'b' })).toBe(true);
    expect(hasUserPrFormContent({ summary: 'a', motivation: 'b', reviewerNotes: 'c' })).toBe(true);
  });

  it('returns false for whitespace-only fields', () => {
    expect(hasUserPrFormContent({ summary: '  ', motivation: '\n', reviewerNotes: '\t' })).toBe(false);
    // Whitespace-only in any single field (others undefined) is still "not engaged".
    expect(hasUserPrFormContent({ summary: '  \n' })).toBe(false);
  });

  it('returns false for empty strings', () => {
    expect(hasUserPrFormContent({ summary: '', motivation: '', reviewerNotes: '' })).toBe(false);
  });
});

// ─── composePrMetadata ──────────────────────────────────────────────

describe('composePrMetadata', () => {
  it('relay non-anonymous: title has suffix, body has Submitter, sanitization applied', () => {
    const result = composePrMetadata(baseInput({
      attributionMode: 'rebel-name',
      attributionName: 'Alice',
      includeSubmitterInTitle: true,
      submissionPath: 'Rebel relay',
      summary: 'Hello <script>alert(1)</script>',
    }));
    expect(result.title).toContain('— submitted by Alice');
    expect(result.body).toContain('## Submitter\nAlice');
    // Sanitization applied to final body — backend-identical strip.
    expect(result.body).not.toMatch(/<script\b/i);
    expect(result.body).toContain('Hello >alert(1)</script>');
    expect(result.submissionPath).toBe('Rebel relay');
  });

  it('own-fork (github): bare title, body Submitter still present', () => {
    const result = composePrMetadata(baseInput({
      attributionMode: 'github',
      attributionName: 'octocat',
      includeSubmitterInTitle: false,
      submissionPath: 'GitHub fork',
    }));
    expect(result.title).toBe('feat(connector): add humaans');
    expect(result.body).toContain('## Submitter\noctocat');
    expect(result.submissionPath).toBe('GitHub fork');
  });

  it('surfaces the fail-closed throw from formatContributionPrTitle', () => {
    expect(() =>
      composePrMetadata(baseInput({
        attributionMode: 'rebel-name',
        attributionName: undefined,
        includeSubmitterInTitle: true,
      })),
    ).toThrow(ContributionPrFormatterValidationError);
  });

  it('surfaces the fail-closed throw from formatContributionPrBody', () => {
    // includeSubmitterInTitle=false suppresses the title-level throw, but
    // the body still requires a non-empty attributionName for non-anon modes.
    expect(() =>
      composePrMetadata(baseInput({
        attributionMode: 'github',
        attributionName: '',
        includeSubmitterInTitle: false,
      })),
    ).toThrow(ContributionPrFormatterValidationError);
  });

  it('golden: full body contract with every section populated (relay non-anon)', () => {
    // Exact-equality snapshot of the final PR body with all user-form fields
    // + parsed config present. Locks section ORDER, HEADER NAMING, and
    // BLANK-LINE handling — guards against silent formatting drift.
    const result = composePrMetadata(baseInput({
      connectorName: 'random-number',
      attributionMode: 'rebel-name',
      attributionName: 'Alice',
      includeSubmitterInTitle: true,
      submissionPath: 'Rebel relay',
      summary: 'A connector that returns random numbers.',
      motivation: 'Useful for testing and demos.',
      reviewerNotes: 'No breaking changes.',
      configResult: { outcome: 'parsed', summary: 'RANDOM_SEED, MAX_VALUE' },
    }));
    expect(result.title).toBe('feat(connector): add random-number — submitted by Alice');
    expect(result.body).toBe(
      '## Summary\nA connector that returns random numbers.\n\n' +
        '## Submitter\nAlice\n\n' +
        '## Why this connector is useful\nUseful for testing and demos.\n\n' +
        '## Validation\n- Pre-submit checks passed in Rebel (readiness signal confirmed).\n- See commit history in the PR for test evidence.\n\n' +
        '## Configuration / docs\nRANDOM_SEED, MAX_VALUE\n\n' +
        '## Breaking changes / reviewer notes\nNo breaking changes.',
    );
    expect(result.submissionPath).toBe('Rebel relay');
  });

  it('old-record (no summary/motivation/reviewerNotes): minimal sections, no empty headers', () => {
    const result = composePrMetadata(baseInput({
      summary: undefined,
      motivation: undefined,
      reviewerNotes: undefined,
      configResult: { outcome: 'missing' },
    }));
    expect(result.body).not.toContain('## Summary');
    expect(result.body).not.toContain('## Why this connector is useful');
    expect(result.body).not.toContain('## Breaking changes / reviewer notes');
    expect(result.body).not.toContain('## Configuration / docs');
    expect(result.body).toContain('## Submitter');
    expect(result.body).toContain('## Validation');
  });

  it('anonymous regression matrix: anonymous mode → no Submitter, no title suffix', () => {
    const result = composePrMetadata(baseInput({
      attributionMode: 'anonymous',
      attributionName: undefined,
      includeSubmitterInTitle: true, // mode wins over this flag
    }));
    expect(result.title).toBe('feat(connector): add humaans');
    expect(result.body).not.toContain('## Submitter');
  });

  it('title overflow: body Submitter preserved even when title suffix dropped', () => {
    const longName = 'Alice-'.repeat(25);
    const longConnector = 'a'.repeat(80);
    const result = composePrMetadata(baseInput({
      connectorName: longConnector,
      attributionMode: 'rebel-name',
      attributionName: longName,
      includeSubmitterInTitle: true,
    }));
    expect(result.title).toBe(`feat(connector): add ${longConnector}`);
    expect(result.body).toContain(`## Submitter\n${longName}`);
  });

  it('sanitization: adversarial <script> in user-visible fields is stripped', () => {
    const result = composePrMetadata(baseInput({
      summary: 'Uses <script>evil()</script>',
      motivation: '<iframe src=x></iframe>',
      reviewerNotes: '<OBJECT data=bad>',
    }));
    expect(result.body).not.toMatch(/<script\b/i);
    expect(result.body).not.toMatch(/<iframe\b/i);
    expect(result.body).not.toMatch(/<object\b/i);
    expect(result.body).toContain('Uses >evil()</script>');
    expect(result.body).toContain(' src=x></iframe>');
    expect(result.body).toContain(' data=bad>');
  });

  it('inferredSummary: end-to-end fallback produces ## Summary section in formatter_default scenario', () => {
    // Mirrors the real formatter_default code path: user form fields all
    // empty (postmortem 260424 removed the form), package.json description
    // present on disk so dispatcher passes inferredSummary.
    const result = composePrMetadata(baseInput({
      summary: undefined,
      motivation: undefined,
      reviewerNotes: undefined,
      inferredSummary: 'A tiny MCP server returning random shapes.',
    }));
    expect(result.body).toContain('## Summary\nA tiny MCP server returning random shapes.');
    expect(result.body).toContain('## Submitter');
    expect(result.body).toContain('## Validation');
  });

  it('inferredSummary: sanitization applies to the inferred fallback like any other body content', () => {
    const result = composePrMetadata(baseInput({
      summary: undefined,
      inferredSummary: 'Adds <script>evil()</script> connector.',
    }));
    expect(result.body).not.toMatch(/<script\b/i);
    expect(result.body).toContain('## Summary\nAdds >evil()</script> connector.');
  });

  it('inferredSummary: not emitted when undefined and user summary is also empty', () => {
    const result = composePrMetadata(baseInput({
      summary: undefined,
      inferredSummary: undefined,
    }));
    expect(result.body).not.toContain('## Summary');
  });

  it('byte parity: same input across transports produces identical body; title differs only by suffix', () => {
    const shared = baseInput({
      connectorName: 'widgets',
      summary: 'Adds widgets.',
      motivation: 'Users love widgets.',
      reviewerNotes: 'No breaking changes.',
      configResult: { outcome: 'parsed', summary: 'WIDGET_API_KEY' },
    });
    const relay = composePrMetadata({
      ...shared,
      attributionMode: 'rebel-name',
      attributionName: 'octocat',
      includeSubmitterInTitle: true,
      submissionPath: 'Rebel relay',
    });
    const ownFork = composePrMetadata({
      ...shared,
      attributionMode: 'github',
      attributionName: 'octocat',
      includeSubmitterInTitle: false,
      submissionPath: 'GitHub fork',
    });
    // Bodies are byte-identical for the same Submitter name.
    expect(ownFork.body).toBe(relay.body);
    // Titles differ only by the relay's "— submitted by" suffix.
    expect(relay.title).toBe(`${ownFork.title} — submitted by octocat`);
  });
});

// ─── Build Context appendix helpers (SE-evidence Stage 1) ───────────

describe('Build Context appendix helpers', () => {
  it('parity: relay and own-fork transports produce byte-identical appendix-bearing bodies', () => {
    const relay = composePrMetadata(baseInput({
      attributionMode: 'rebel-name',
      attributionName: 'octocat',
      includeSubmitterInTitle: true,
      submissionPath: 'Rebel relay',
      summary: 'Adds widgets.',
      motivation: 'Users love widgets.',
    }));
    const ownFork = composePrMetadata(baseInput({
      attributionMode: 'github',
      attributionName: 'octocat',
      includeSubmitterInTitle: false,
      submissionPath: 'GitHub fork',
      summary: 'Adds widgets.',
      motivation: 'Users love widgets.',
    }));

    const relayWithAppendix = appendBuildContextAppendix(
      relay.body,
      baseBuildContext(),
      { bodyMax: BODY_MAX, maxAppendixLen: MAX_APPENDIX_LEN },
    );
    const ownForkWithAppendix = appendBuildContextAppendix(
      ownFork.body,
      baseBuildContext(),
      { bodyMax: BODY_MAX, maxAppendixLen: MAX_APPENDIX_LEN },
    );

    expect(relayWithAppendix.body).toBe(ownForkWithAppendix.body);
  });

  it('BODY_MAX budget: truncates body first and still appends Build Context', () => {
    const oversizedBody = 'x'.repeat(BODY_MAX);
    const result = appendBuildContextAppendix(
      oversizedBody,
      baseBuildContext(),
      { bodyMax: BODY_MAX, maxAppendixLen: MAX_APPENDIX_LEN },
    );

    expect(result.body.length).toBeLessThanOrEqual(BODY_MAX);
    expect(result.body).toContain('**Build Context** (auto-generated provenance)');
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'body_truncated' }),
      ]),
    );
  });

  it('agent_override branch attachment shape: appendix is appended after agent-provided body', () => {
    const agentBody = 'Agent-authored PR body section';
    const result = appendBuildContextAppendix(
      agentBody,
      baseBuildContext(),
      { bodyMax: BODY_MAX, maxAppendixLen: MAX_APPENDIX_LEN },
    );

    expect(result.body.startsWith(`${agentBody}\n\n---`)).toBe(true);
    expect(result.body).toContain('**Build Context** (auto-generated provenance)');
  });

  it('idempotency fingerprint ignores mutating Build Context appendix', () => {
    const payloadBase = {
      clientContributionId: 'contrib-123',
      connectorName: 'my-connector',
      attributionMode: 'anonymous',
      prTitle: 'feat(connector): add my-connector',
      files: [{ path: 'connectors/my-connector/src/index.ts', content: 'export const x = 1;' }],
    };
    const userBody = '## Summary\nStable user content';
    const prBodyA = appendBuildContextAppendix(
      userBody,
      baseBuildContext({ appVersion: '0.13.4' }),
      { bodyMax: BODY_MAX, maxAppendixLen: MAX_APPENDIX_LEN },
    ).body;
    const prBodyB = appendBuildContextAppendix(
      userBody,
      baseBuildContext({ appVersion: '0.13.5' }),
      { bodyMax: BODY_MAX, maxAppendixLen: MAX_APPENDIX_LEN },
    ).body;

    expect(prBodyA).not.toBe(prBodyB);
    expect(
      computePayloadFingerprintExcludingAppendix({ ...payloadBase, prBody: prBodyA }),
    ).toBe(
      computePayloadFingerprintExcludingAppendix({ ...payloadBase, prBody: prBodyB }),
    );
  });

  it('emits appendix_field_truncated warning when taskSubagentTypes overflows appendix budget', () => {
    const manySubagents = Array.from({ length: 120 }, (_, i) => `subagent-${i}`);
    const result = appendBuildContextAppendix(
      'Body',
      baseBuildContext({ taskSubagentTypes: manySubagents }),
      { bodyMax: BODY_MAX, maxAppendixLen: MAX_APPENDIX_LEN },
    );

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'appendix_field_truncated',
          field: 'taskSubagentTypes',
          originalCount: 120,
        }),
      ]),
    );
  });

  it('emits appendix_omitted: appendix_alone_exceeds_bodymax when appendix cannot fit by itself', () => {
    const result = appendBuildContextAppendix(
      'short-body',
      baseBuildContext(),
      { bodyMax: 30, maxAppendixLen: MAX_APPENDIX_LEN },
    );

    expect(result.body).not.toContain('**Build Context** (auto-generated provenance)');
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'appendix_omitted',
          reason: 'appendix_alone_exceeds_bodymax',
        }),
      ]),
    );
  });

  it('emits appendix_omitted: budget_exhausted_after_truncation when reserved budget is exceeded', () => {
    const longContext = baseBuildContext({
      model: 'm'.repeat(70),
      appVersion: 'v'.repeat(60),
      sessionId: 's'.repeat(60),
      taskSubagentTypes: [],
    });
    const result = appendBuildContextAppendix(
      'x'.repeat(410),
      longContext,
      { bodyMax: 420, maxAppendixLen: 20 },
    );

    expect(result.body).not.toContain('**Build Context** (auto-generated provenance)');
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'appendix_omitted',
          reason: 'budget_exhausted_after_truncation',
        }),
      ]),
    );
  });

  it('defaults unknown for empty model/appVersion/sessionId/taskSubagentTypes fields', () => {
    const appendix = formatBuildContextAppendix(baseBuildContext({
      model: '',
      appVersion: '   ',
      sessionId: '',
      taskSubagentTypes: [],
    }));

    expect(appendix).toContain('- App-Version: unknown');
    expect(appendix).toContain('- Model: unknown');
    expect(appendix).toContain('- Session-ID: unknown');
    expect(appendix).toContain('- Task-Subagents: unknown');
  });

  it('classifies build-plan shape from frontmatter + required sections', () => {
    const workingDoc = [
      '---',
      'workflow: software-engineer',
      'models:',
      '  orchestrator: x',
      '  planner: x',
      '  implementer: x',
      '  reviewer: x',
      '---',
      '',
      '## Review History',
    ].join('\n');
    expect(classifyBuildPlanShape(workingDoc)).toBe('se-working-doc');
    expect(classifyBuildPlanShape('## just a stub')).toBe('stub');
    expect(classifyBuildPlanShape('   ')).toBe('missing');
  });
});

// ─── Length boundaries ──────────────────────────────────────────────

describe('length boundaries', () => {
  it('accepts a title at exactly TITLE_MAX', () => {
    // connector + name must make "feat(connector): add <c> — submitted by <n>" = 120 chars.
    // prefix "feat(connector): add " (21) + c + " — submitted by " (16) + n = 120
    // (em-dash = 1 JS code unit). c + n = 83 → 42 + 41.
    const connectorName = 'c'.repeat(42);
    const attributionName = 'n'.repeat(41);
    expect(() =>
      composePrMetadata(baseInput({ connectorName, attributionName })),
    ).not.toThrow();
  });

  it('throws for a formatter-generated title over TITLE_MAX when no suffix to drop', () => {
    // bare title "feat(connector): add X" where X is 100 chars → 121 total.
    const connectorName = 'x'.repeat(100);
    expect(() =>
      composePrMetadata(baseInput({
        connectorName,
        attributionMode: 'anonymous',
        attributionName: undefined,
        includeSubmitterInTitle: false,
      })),
    ).toThrow(ContributionPrFormatterValidationError);
  });

  it('accepts a body at exactly BODY_MAX', () => {
    // Build a skeleton, then pad summary with plain text (no sanitizable
    // tags) so final length = 4096.
    const skeleton = composePrMetadata(baseInput({
      attributionMode: 'anonymous',
      attributionName: undefined,
      includeSubmitterInTitle: false,
      summary: '',
      motivation: undefined,
      reviewerNotes: undefined,
      configResult: { outcome: 'missing' },
    }));
    // Skeleton body = Validation only. Adding "## Summary\n" + text = 11 extra chars before text.
    const padLen = BODY_MAX - skeleton.body.length - '## Summary\n'.length - '\n\n'.length;
    const padded = 'a'.repeat(padLen);
    const result = composePrMetadata(baseInput({
      attributionMode: 'anonymous',
      attributionName: undefined,
      includeSubmitterInTitle: false,
      summary: padded,
      motivation: undefined,
      reviewerNotes: undefined,
      configResult: { outcome: 'missing' },
    }));
    expect(result.body.length).toBe(BODY_MAX);
  });

  it('throws for a body over BODY_MAX', () => {
    const huge = 'a'.repeat(BODY_MAX + 100);
    expect(() =>
      composePrMetadata(baseInput({
        attributionMode: 'anonymous',
        attributionName: undefined,
        includeSubmitterInTitle: false,
        summary: huge,
      })),
    ).toThrow(ContributionPrFormatterValidationError);
  });
});

// ─── buildValidationEvidence ────────────────────────────────────────

describe('buildValidationEvidence', () => {
  it('returns the accurate V1 copy', () => {
    const evidence = buildValidationEvidence();
    expect(evidence).toContain('Pre-submit checks passed in Rebel (readiness signal confirmed).');
    expect(evidence).toContain('See commit history in the PR for test evidence.');
    // Do NOT overclaim with build/lint/tests lines — regression guard.
    expect(evidence).not.toContain('Build:');
    expect(evidence).not.toContain('Lint:');
    expect(evidence).not.toContain('Tests:');
  });
});
