/**
 * Unit tests for the pure logic in scripts/mcp-release.ts:
 *
 *  - ledger id generation (the --reconcile hand-seeding trap: ids must
 *    always satisfy assertSafeLedgerId — PLAN.md 260611 Decision Log 13:15 (a))
 *  - Release-Gate trailer format/parse + Rebel-side audit assessment
 *    (Stage 5′ — Decision Log 13:20 (1))
 *  - §13 gate-block validation under the AI-only contract, including the
 *    legacy Human-Signoff alias (Decision Log 13:20 (2)); the committed
 *    legacy artifacts in docs-private must remain valid
 *  - --reconcile fail-loud preconditions (tip checkout + regen-clean —
 *    review round 2: reconcile only handles the clean tip case)
 *  - semver ordering used by --reconcile's ahead-of-pin check
 *  - isCommitAncestor (the relaxed dev-push guard — Decision Log 13:15 (b)),
 *    exercised against a real temp git repo
 */

import { execSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertBumpConnectorScript,
  assertReconcileRegenClean,
  assertReconcileTipCheckout,
  assertSafeLedgerId,
  assertSecurityReviewNotSkipped,
  assessReleaseGateAudit,
  compareSemver,
  detectSiblingCatalogueDrift,
  evaluatePushApproval,
  extractReviewGateFields,
  formatReleaseGateTrailer,
  generateLedgerId,
  isCommitAncestor,
  pushApprovalToken,
  modelFamily,
  parseReleaseGateTrailer,
  type Ledger,
  validateSecurityReviewGateFields,
} from '../mcp-release';
import {
  CONNECTOR_RELEASE_MAPPINGS,
  listConnectorNames,
} from '../mcp-release-catalog-mapping';
import { checkMappedConnectorSecurityReviewPolicy } from '../validate-mcp-release-security-policy';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Ledger id generation
// ---------------------------------------------------------------------------

describe('generateLedgerId', () => {
  it('produces ids that satisfy assertSafeLedgerId (the --reconcile seeding contract)', () => {
    const id = generateLedgerId('retell-ai');
    expect(() => assertSafeLedgerId(id)).not.toThrow();
    expect(id.startsWith('retell-ai-')).toBe(true);
  });

  it('produces distinct ids across calls (random suffix)', () => {
    expect(generateLedgerId('slack')).not.toEqual(generateLedgerId('slack'));
  });
});

// ---------------------------------------------------------------------------
// Release-Gate trailer (Stage 5′)
// ---------------------------------------------------------------------------

const SHA256_A = 'a'.repeat(64);
const SHA256_B = 'b'.repeat(64);
const REVIEW_PATH = 'docs-private/reports/security-reviews/260611_retell-ai_0.2.3.md';

describe('Release-Gate trailer', () => {
  it('format/parse round-trips through a full commit message', () => {
    const trailer = formatReleaseGateTrailer(REVIEW_PATH, SHA256_A);
    const message = `chore(release): retell-ai@0.2.3\n\n${trailer}\n`;
    expect(parseReleaseGateTrailer(message)).toEqual({
      kind: 'present',
      path: REVIEW_PATH,
      sha256: SHA256_A,
    });
  });

  it('reports absent when no trailer line exists', () => {
    expect(parseReleaseGateTrailer('chore(release): slack@0.1.4\n')).toEqual({ kind: 'absent' });
  });

  it.each([
    ['short hash', `Release-Gate: ${REVIEW_PATH}#abc123`],
    ['missing #sha', `Release-Gate: ${REVIEW_PATH}`],
    ['uppercase hash', `Release-Gate: ${REVIEW_PATH}#${'A'.repeat(64)}`],
    ['traversal segment', `Release-Gate: docs-private/../../../etc/passwd.md#${'a'.repeat(64)}`],
    ['empty segment', `Release-Gate: docs-private//reviews/x.md#${'a'.repeat(64)}`],
    ['path outside the review dir', `Release-Gate: docs/reviews/x.md#${'a'.repeat(64)}`],
    ['non-.md suffix', `Release-Gate: ${REVIEW_PATH.replace(/\.md$/, '.txt')}#${'a'.repeat(64)}`],
    ['double space after colon', `Release-Gate:  ${REVIEW_PATH}#${'a'.repeat(64)}`],
    ['no space after colon', `Release-Gate:${REVIEW_PATH}#${'a'.repeat(64)}`],
    ['leading whitespace', `  Release-Gate: ${REVIEW_PATH}#${'a'.repeat(64)}`],
    ['trailing whitespace', `Release-Gate: ${REVIEW_PATH}#${'a'.repeat(64)} `],
  ])('reports malformed for %s', (_label, line) => {
    const result = parseReleaseGateTrailer(`subject\n\n${line}\n`);
    expect(result.kind).toBe('malformed');
  });
});

describe('formatReleaseGateTrailer — never stamp what the public gate refuses', () => {
  it('throws on a review path with characters outside the public grammar', () => {
    expect(() =>
      formatReleaseGateTrailer(
        'docs-private/reports/security-reviews/260611_retell+ai_0.2.3.md',
        SHA256_A,
      ),
    ).toThrow(/public mcp-servers release gate would reject/);
  });

  it('throws on a review path outside docs-private/reports/security-reviews/', () => {
    expect(() => formatReleaseGateTrailer('docs/reviews/260611_x_0.1.0.md', SHA256_A)).toThrow(
      /public mcp-servers release gate would reject/,
    );
  });

  it('throws on a non-lowercase-hex sha256', () => {
    expect(() => formatReleaseGateTrailer(REVIEW_PATH, 'A'.repeat(64))).toThrow(
      /public mcp-servers release gate would reject/,
    );
  });
});

// ---------------------------------------------------------------------------
// Release-Gate grammar parity with the public workflow gate (review round 2,
// F3): extract TRAILER_RE from mcp-servers/.github/workflows/release.yml at
// test time and assert parseReleaseGateTrailer reaches the SAME accept/reject
// verdict on every fixture. Grammar drift between the Rebel-side stamper and
// the public gate then fails tests here instead of blocking a release
// post-push.
// ---------------------------------------------------------------------------

describe('Release-Gate grammar parity (script vs public workflow regex)', () => {
  const workflowPath = path.join(REPO_ROOT, 'mcp-servers', '.github', 'workflows', 'release.yml');

  it.skipIf(!fs.existsSync(workflowPath))(
    'parseReleaseGateTrailer and release.yml TRAILER_RE agree on every fixture',
    () => {
      const yml = fs.readFileSync(workflowPath, 'utf8');
      const reMatch = yml.match(/^\s*TRAILER_RE='([^']+)'\s*$/m);
      expect(reMatch, 'TRAILER_RE definition in release.yml').not.toBeNull();
      // The workflow regex is POSIX ERE applied per-line by `grep -E`; its
      // constructs (anchors, classes, bounded repeats) are JS-compatible.
      const workflowRe = new RegExp(reMatch![1]);

      const HASH = 'f'.repeat(64);
      const fixtures: Array<[label: string, line: string]> = [
        ['default review path', `Release-Gate: ${REVIEW_PATH}#${HASH}`],
        [
          'nested subdirectory',
          `Release-Gate: docs-private/reports/security-reviews/2026/06/x_0.1.0.md#${HASH}`,
        ],
        [
          'dots inside a segment',
          `Release-Gate: docs-private/reports/security-reviews/260611_retell-ai_0.2.3.md#${HASH}`,
        ],
        [
          'traversal segment',
          `Release-Gate: docs-private/reports/security-reviews/../../secrets.md#${HASH}`,
        ],
        ['empty segment', `Release-Gate: docs-private/reports/security-reviews//x.md#${HASH}`],
        ['wrong root', `Release-Gate: docs-private/reports/security-reviews/x.md#${HASH}`],
        [
          'odd-but-fs-valid char (+)',
          `Release-Gate: docs-private/reports/security-reviews/x+v2.md#${HASH}`,
        ],
        [
          'odd-but-fs-valid chars (parens)',
          `Release-Gate: docs-private/reports/security-reviews/x(2).md#${HASH}`,
        ],
        [
          'dot-leading segment',
          `Release-Gate: docs-private/reports/security-reviews/.hidden.md#${HASH}`,
        ],
        ['non-.md suffix', `Release-Gate: docs-private/reports/security-reviews/x.txt#${HASH}`],
        ['uppercase hash', `Release-Gate: ${REVIEW_PATH}#${'F'.repeat(64)}`],
        ['short hash', `Release-Gate: ${REVIEW_PATH}#${'f'.repeat(63)}`],
        ['long hash', `Release-Gate: ${REVIEW_PATH}#${'f'.repeat(65)}`],
        ['missing #sha', `Release-Gate: ${REVIEW_PATH}`],
        ['double space after colon', `Release-Gate:  ${REVIEW_PATH}#${HASH}`],
        ['no space after colon', `Release-Gate:${REVIEW_PATH}#${HASH}`],
        ['leading whitespace', `  Release-Gate: ${REVIEW_PATH}#${HASH}`],
        ['trailing whitespace', `Release-Gate: ${REVIEW_PATH}#${HASH} `],
      ];

      // Sanity: the fixture list must exercise both verdicts.
      expect(fixtures.some(([, line]) => workflowRe.test(line))).toBe(true);
      expect(fixtures.some(([, line]) => !workflowRe.test(line))).toBe(true);

      for (const [label, line] of fixtures) {
        const workflowAccepts = workflowRe.test(line);
        const parsed = parseReleaseGateTrailer(`subject\n\n${line}\n`);
        const scriptAccepts = parsed.kind === 'present';
        expect(
          scriptAccepts,
          `${label}: script=${parsed.kind}, workflow=${workflowAccepts ? 'accept' : 'reject'}`,
        ).toBe(workflowAccepts);
      }
    },
  );
});

describe('assessReleaseGateAudit', () => {
  const present = { kind: 'present' as const, path: REVIEW_PATH, sha256: SHA256_A };

  it('warns (not fails) on absent trailer — pre-stamping commits cannot be retro-stamped', () => {
    const result = assessReleaseGateAudit({
      trailer: { kind: 'absent' },
      ledgerReviewPath: REVIEW_PATH,
      recomputedSha256: SHA256_A,
    });
    expect(result.status).toBe('warn-absent');
    if (result.status === 'warn-absent') {
      expect(result.note).toMatch(/cannot\s+retro-stamp/i);
    }
  });

  it('fails on malformed trailer', () => {
    const result = assessReleaseGateAudit({
      trailer: { kind: 'malformed', raw: 'Release-Gate: junk' },
      ledgerReviewPath: REVIEW_PATH,
      recomputedSha256: SHA256_A,
    });
    expect(result.status).toBe('fail');
  });

  it('fails when the trailer points at a different artifact than the ledger', () => {
    const result = assessReleaseGateAudit({
      trailer: present,
      ledgerReviewPath: 'docs-private/reports/security-reviews/260610_slack_0.1.4.md',
      recomputedSha256: SHA256_A,
    });
    expect(result.status).toBe('fail');
  });

  it('fails loud on hash MISMATCH (trailer present, hash differs)', () => {
    const result = assessReleaseGateAudit({
      trailer: present,
      ledgerReviewPath: REVIEW_PATH,
      recomputedSha256: SHA256_B,
    });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') {
      expect(result.reason).toMatch(/MISMATCH/);
    }
  });

  it('fails when the artifact is missing locally (cannot recompute)', () => {
    const result = assessReleaseGateAudit({
      trailer: present,
      ledgerReviewPath: REVIEW_PATH,
      recomputedSha256: undefined,
    });
    expect(result.status).toBe('fail');
  });

  it('passes when path and hash both match', () => {
    const result = assessReleaseGateAudit({
      trailer: present,
      ledgerReviewPath: REVIEW_PATH,
      recomputedSha256: SHA256_A,
    });
    expect(result).toEqual({ status: 'ok' });
  });
});

// ---------------------------------------------------------------------------
// Push approval and release-security fail-closed policy
// ---------------------------------------------------------------------------

const RELEASE_SHA = '1'.repeat(40);
const CATALOG_SHA = '2'.repeat(40);

function testLedger(overrides: Partial<Ledger> = {}): Ledger {
  return {
    id: 'slack-2026-06-12T10-00-00-000Z-abcd',
    connectorName: 'slack',
    startedAt: '2026-06-12T10:00:00.000Z',
    updatedAt: '2026-06-12T10:00:00.000Z',
    stage: 'version-bumped',
    fromVersion: '0.1.0',
    toVersion: '0.1.1',
    releaseCommitSha: RELEASE_SHA,
    catalogCommitSha: CATALOG_SHA,
    errors: [],
    ...overrides,
  };
}

describe('pushApprovalToken', () => {
  it('formats exact tokens for both push stages', () => {
    const ledger = testLedger();
    expect(pushApprovalToken('submodule-pushed', ledger)).toBe(
      `${ledger.id}:submodule-pushed:${RELEASE_SHA}`,
    );
    expect(pushApprovalToken('dev-pushed', ledger)).toBe(`${ledger.id}:dev-pushed:${CATALOG_SHA}`);
  });

  it('throws when the required stage SHA is missing', () => {
    const missingReleaseSha = testLedger();
    delete missingReleaseSha.releaseCommitSha;
    const missingCatalogSha = testLedger();
    delete missingCatalogSha.catalogCommitSha;

    expect(() => pushApprovalToken('submodule-pushed', missingReleaseSha)).toThrow(/missing commit SHA/);
    expect(() => pushApprovalToken('dev-pushed', missingCatalogSha)).toThrow(/missing commit SHA/);
  });
});

describe('evaluatePushApproval', () => {
  const ledger = testLedger();
  const expectedToken = pushApprovalToken('submodule-pushed', ledger);

  it('approves only a matching env token', () => {
    expect(
      evaluatePushApproval({
        stage: 'submodule-pushed',
        ledger,
        pushApprovalEnv: expectedToken,
        isTTY: false,
      }),
    ).toEqual({ kind: 'approved' });
  });

  it('rejects a mismatched token in non-TTY mode with the expected token', () => {
    expect(
      evaluatePushApproval({
        stage: 'submodule-pushed',
        ledger,
        pushApprovalEnv: 'wrong-token',
        isTTY: false,
      }),
    ).toEqual({ kind: 'rejected-non-tty', expectedToken });
  });

  it('rejects a missing token in non-TTY mode', () => {
    expect(
      evaluatePushApproval({
        stage: 'submodule-pushed',
        ledger,
        pushApprovalEnv: undefined,
        isTTY: false,
      }),
    ).toEqual({ kind: 'rejected-non-tty', expectedToken });
  });

  it('prompts when no token is present in TTY mode', () => {
    expect(
      evaluatePushApproval({
        stage: 'submodule-pushed',
        ledger,
        pushApprovalEnv: undefined,
        isTTY: true,
      }),
    ).toEqual({ kind: 'needs-prompt' });
  });

  it('does not let MCP_RELEASE_AUTO_APPROVE approve push stages', () => {
    const previous = process.env.MCP_RELEASE_AUTO_APPROVE;
    try {
      process.env.MCP_RELEASE_AUTO_APPROVE = '1';
      expect(
        evaluatePushApproval({
          stage: 'submodule-pushed',
          ledger,
          pushApprovalEnv: undefined,
          isTTY: true,
        }),
      ).toEqual({ kind: 'needs-prompt' });
    } finally {
      if (previous === undefined) delete process.env.MCP_RELEASE_AUTO_APPROVE;
      else process.env.MCP_RELEASE_AUTO_APPROVE = previous;
    }
  });
});

describe('assertSecurityReviewNotSkipped', () => {
  it('throws when MCP_RELEASE_SKIP_SECURITY_REVIEW=1', () => {
    expect(() =>
      assertSecurityReviewNotSkipped({
        ...process.env,
        MCP_RELEASE_SKIP_SECURITY_REVIEW: '1',
      }),
    ).toThrow(/no longer supported[\s\S]*requires a security review artifact/);
  });

  it('does not throw otherwise', () => {
    expect(() => assertSecurityReviewNotSkipped({})).not.toThrow();
    expect(() =>
      assertSecurityReviewNotSkipped({
        ...process.env,
        MCP_RELEASE_SKIP_SECURITY_REVIEW: '0',
      }),
    ).not.toThrow();
  });
});

describe('detectSiblingCatalogueDrift', () => {
  it('returns [] when the working tree is clean', () => {
    expect(detectSiblingCatalogueDrift('', 'slack')).toEqual([]);
  });

  it('ignores the released connector own page and docs/index.md', () => {
    const status = ['M  docs/catalogue/slack.md', 'M  docs/index.md'].join('\n');
    expect(detectSiblingCatalogueDrift(status, 'slack')).toEqual([]);
  });

  it('flags a stale sibling catalogue page left unstaged by the regen', () => {
    const status = [
      'M  docs/catalogue/slack.md', // released, staged — excluded
      'M  docs/index.md', // always staged — excluded (not a catalogue page)
      ' M docs/catalogue/hubspot.md', // sibling drift — flagged
    ].join('\n');
    expect(detectSiblingCatalogueDrift(status, 'slack')).toEqual(['docs/catalogue/hubspot.md']);
  });

  it('flags multiple siblings, sorted and de-duplicated, ignoring unrelated paths', () => {
    const status = [
      ' M docs/catalogue/zendesk.md',
      ' M docs/catalogue/airtable.md',
      ' M connectors/slack/package.json', // unrelated — not a catalogue page
      '?? scratch.log',
    ].join('\n');
    expect(detectSiblingCatalogueDrift(status, 'slack')).toEqual([
      'docs/catalogue/airtable.md',
      'docs/catalogue/zendesk.md',
    ]);
  });

  it('does not match nested paths under catalogue/ (only top-level <name>.md pages)', () => {
    const status = ' M docs/catalogue/sub/dir/notapage.md';
    expect(detectSiblingCatalogueDrift(status, 'slack')).toEqual([]);
  });

  it('handles git-quoted paths (special chars) by stripping the wrapper quotes', () => {
    // NB: real catalogue pages are lowercase ASCII slugs (bump-connector enforces
    // it), so this exercises the quote-wrapper strip, not full C-style decoding.
    const status = ' M "docs/catalogue/söme-connector.md"';
    expect(detectSiblingCatalogueDrift(status, 'slack')).toEqual(['docs/catalogue/söme-connector.md']);
  });

  it('flags staged-and-modified (MM) and untracked (??) sibling pages', () => {
    const status = [
      'MM docs/catalogue/hubspot.md', // staged + further modified
      '?? docs/catalogue/brand-new.md', // a freshly generated, untracked sibling page
    ].join('\n');
    expect(detectSiblingCatalogueDrift(status, 'slack')).toEqual([
      'docs/catalogue/brand-new.md',
      'docs/catalogue/hubspot.md',
    ]);
  });

  it('does not flag a rename record (the generator edits in place, never renames pages)', () => {
    // `R  old -> new` -> slice(3) yields "docs/catalogue/old.md -> docs/catalogue/new.md",
    // which the anchored regex rejects (the " -> " breaks the single-path match). This
    // locks in that rename records are intentionally not treated as drift.
    const status = 'R  docs/catalogue/old.md -> docs/catalogue/new.md';
    expect(detectSiblingCatalogueDrift(status, 'slack')).toEqual([]);
  });
});

describe('mapped connector release-security invariant', () => {
  const REVIEW_ARTIFACT_VERSION = '1.2.3';
  const REVIEW_ARTIFACT_DATE = '260612';
  const REVIEW_ARTIFACT_DIR = 'docs-private/reports/security-reviews';
  const CONNECTOR_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

  it('all listed connector names are present in the mapping record', () => {
    expect([...listConnectorNames()].sort()).toEqual(Object.keys(CONNECTOR_RELEASE_MAPPINGS).sort());
  });

  it('every mapped connector has the fields needed to resolve and validate a review artifact', () => {
    expect(checkMappedConnectorSecurityReviewPolicy(CONNECTOR_RELEASE_MAPPINGS)).toEqual([]);

    for (const [connectorName, mapping] of Object.entries(CONNECTOR_RELEASE_MAPPINGS)) {
      expect(mapping.name, connectorName).toBe(connectorName);
      expect(mapping.name, connectorName).toMatch(CONNECTOR_NAME_RE);
      expect(mapping.npmPackage, connectorName).toBe(`@mindstone/mcp-server-${mapping.name}`);

      const expectedSuffix = `_${mapping.name}_${REVIEW_ARTIFACT_VERSION}.md`;
      const defaultReviewPath = path.posix.join(
        REVIEW_ARTIFACT_DIR,
        `${REVIEW_ARTIFACT_DATE}${expectedSuffix}`,
      );
      expect(defaultReviewPath, connectorName).toBe(
        `docs-private/reports/security-reviews/260612_${mapping.name}_${REVIEW_ARTIFACT_VERSION}.md`,
      );
      expect(defaultReviewPath, connectorName).toMatch(
        /^docs-private\/reports\/security-reviews\/\d{6}_[a-z0-9][a-z0-9-]*_1\.2\.3\.md$/,
      );
      expect(defaultReviewPath.endsWith(expectedSuffix), connectorName).toBe(true);
    }
  });

  it('MCP_RELEASE_SKIP_SECURITY_REVIEW=1 is refused for every mapped connector', () => {
    for (const connectorName of listConnectorNames()) {
      expect(
        () =>
          assertSecurityReviewNotSkipped({
            ...process.env,
            MCP_RELEASE_SKIP_SECURITY_REVIEW: '1',
          }),
        connectorName,
      ).toThrow(/Every agent-driven connector release requires a security review artifact/);
    }
  });
});

// ---------------------------------------------------------------------------
// §13 gate-block validation (AI-only contract + legacy alias)
// ---------------------------------------------------------------------------

const EXPECTED = {
  connector: 'retell-ai',
  npmPackage: '@mindstone/mcp-server-retell-ai',
  version: '0.2.3',
};

function gateBlock(lines: Record<string, string>): Map<string, string> {
  const text = Object.entries(lines)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return extractReviewGateFields(text);
}

const BASE_FIELDS = {
  'Security-Review-Gate': 'Approved',
  Connector: 'retell-ai',
  Package: '@mindstone/mcp-server-retell-ai',
  Version: '0.2.3',
  'Critical-Findings-Open': '0',
  'High-Findings-Open': '0',
};

describe('extractReviewGateFields — gate-block scoping (s13 version-scan fix)', () => {
  it('ignores a prose "Version:" line AFTER the gate block (the retell-ai 0.2.4 clobber)', () => {
    const review = [
      '## Release Gate',
      '',
      'Security-Review-Gate: Approved',
      'Connector: retell-ai',
      'Version: 0.2.4',
      '',
      '## Notes',
      '',
      '- Version: 0.2.4 (security fix on top of 0.2.3)',
    ].join('\n');
    expect(extractReviewGateFields(review).get('version')).toBe('0.2.4');
  });

  it('first-wins inside the block: a later prose mention in the SAME section cannot clobber', () => {
    const review = [
      '## Release Gate',
      'Version: 0.2.4',
      'Adversarial-Verdict: UPHELD',
      '',
      '(Reports: foo. Version: 0.2.4 (note) — incorporated.)',
    ].join('\n');
    expect(extractReviewGateFields(review).get('version')).toBe('0.2.4');
  });

  it('falls back to whole-document parsing when there is no "## Release Gate" header (legacy artifacts)', () => {
    const review = ['Version: 0.1.0', 'Connector: slack'].join('\n');
    expect(extractReviewGateFields(review).get('version')).toBe('0.1.0');
    expect(extractReviewGateFields(review).get('connector')).toBe('slack');
  });

  it('near-miss header (not exact "## Release Gate") falls back to whole-doc LAST-wins, catching a later wrong value (F1 under-block guard)', () => {
    const review = [
      '## Release Gate (machine-readable)',  // near-miss header → NOT scoped
      '- Version: 0.2.4',                    // earlier prose (would-be first)
      '- Connector: retell-ai',
      '',
      'Version: 0.0.1',                      // later, genuinely-wrong gate value
      'Connector: wrong',
    ].join('\n');
    // whole-doc last-wins must surface the LATER (wrong) values so the gate fails closed
    expect(extractReviewGateFields(review).get('version')).toBe('0.0.1');
    expect(extractReviewGateFields(review).get('connector')).toBe('wrong');
  });

  it('handles CRLF line endings', () => {
    const review = '## Release Gate\r\nVersion: 0.2.4\r\n## Notes\r\n- Version: 0.2.4 (note)\r\n';
    expect(extractReviewGateFields(review).get('version')).toBe('0.2.4');
  });

  it('uses the FIRST "## Release Gate" block when more than one is present', () => {
    const review = [
      '## Release Gate',
      'Version: 0.2.4',
      '## Release Gate',
      'Version: 9.9.9',
    ].join('\n');
    expect(extractReviewGateFields(review).get('version')).toBe('0.2.4');
  });

  it('stops at the next "## " section so later-section fields do not leak in', () => {
    const review = [
      '## Release Gate',
      'Connector: retell-ai',
      '## AI Provenance',
      'Connector: SOMETHING-ELSE',
    ].join('\n');
    expect(extractReviewGateFields(review).get('connector')).toBe('retell-ai');
  });
});

describe('validateSecurityReviewGateFields — AI-only contract', () => {
  it('accepts a new-format artifact (cross-family models + UPHELD + Release-Authorized-By)', () => {
    const gate = gateBlock({
      ...BASE_FIELDS,
      'Author-Model': 'claude-fable-5',
      'Adversarial-Model': 'gpt-5.5',
      'Adversarial-Verdict': 'UPHELD',
      'Release-Authorized-By': 'standing-policy:§13-ai-only',
    });
    expect(() => validateSecurityReviewGateFields(gate, EXPECTED, 'review.md')).not.toThrow();
  });

  it('accepts UPHELD-WITH-ADDENDA and Approved-with-deferred-findings', () => {
    const gate = gateBlock({
      ...BASE_FIELDS,
      'Security-Review-Gate': 'Approved-with-deferred-findings',
      'Author-Model': 'gemini-2.5-pro',
      'Adversarial-Model': 'claude-opus-4.8',
      'Adversarial-Verdict': 'UPHELD-WITH-ADDENDA',
      'Release-Authorized-By': 'Team Member',
    });
    expect(() => validateSecurityReviewGateFields(gate, EXPECTED, 'review.md')).not.toThrow();
  });

  it('accepts a legacy artifact (Human-Signoff only, no model/verdict fields)', () => {
    const gate = gateBlock({ ...BASE_FIELDS, 'Human-Signoff': 'Team Member' });
    expect(() => validateSecurityReviewGateFields(gate, EXPECTED, 'review.md')).not.toThrow();
  });

  it('rejects same-family author + adversarial models', () => {
    const gate = gateBlock({
      ...BASE_FIELDS,
      'Author-Model': 'claude-fable-5',
      'Adversarial-Model': 'claude-opus-4.8',
      'Adversarial-Verdict': 'UPHELD',
      'Release-Authorized-By': 'Team Member',
    });
    expect(() => validateSecurityReviewGateFields(gate, EXPECTED, 'review.md')).toThrow(
      /DIFFERENT model family/,
    );
  });

  it('rejects a missing or non-upheld Adversarial-Verdict', () => {
    for (const verdict of [undefined, 'REJECTED', 'pending']) {
      const fields: Record<string, string> = {
        ...BASE_FIELDS,
        'Author-Model': 'claude-fable-5',
        'Adversarial-Model': 'gpt-5.5',
        'Release-Authorized-By': 'Team Member',
      };
      if (verdict !== undefined) fields['Adversarial-Verdict'] = verdict;
      expect(() => validateSecurityReviewGateFields(gateBlock(fields), EXPECTED, 'review.md')).toThrow(
        /Adversarial-Verdict/,
      );
    }
  });

  it('rejects Release-Authorized-By without the model fields (new artifacts get full validation)', () => {
    const gate = gateBlock({ ...BASE_FIELDS, 'Release-Authorized-By': 'Team Member' });
    expect(() => validateSecurityReviewGateFields(gate, EXPECTED, 'review.md')).toThrow(/Author-Model/);
  });

  it('rejects partial adoption (legacy signoff + Author-Model but no Adversarial-Model)', () => {
    const gate = gateBlock({
      ...BASE_FIELDS,
      'Human-Signoff': 'Team Member',
      'Author-Model': 'claude-fable-5',
    });
    expect(() => validateSecurityReviewGateFields(gate, EXPECTED, 'review.md')).toThrow(
      /Adversarial-Model/,
    );
  });

  it('rejects partial adoption (legacy signoff + Adversarial-Verdict but no model fields)', () => {
    // Any new-format field — including Adversarial-Verdict alone — must force
    // full new-format validation; it cannot ride the legacy alias through.
    const gate = gateBlock({
      ...BASE_FIELDS,
      'Human-Signoff': 'Team Member',
      'Adversarial-Verdict': 'UPHELD',
    });
    expect(() => validateSecurityReviewGateFields(gate, EXPECTED, 'review.md')).toThrow(
      /Author-Model/,
    );
  });

  it('rejects missing/placeholder authorization', () => {
    expect(() => validateSecurityReviewGateFields(gateBlock(BASE_FIELDS), EXPECTED, 'review.md')).toThrow(
      /Release-Authorized-By/,
    );
    const placeholder = gateBlock({ ...BASE_FIELDS, 'Human-Signoff': 'pending' });
    expect(() => validateSecurityReviewGateFields(placeholder, EXPECTED, 'review.md')).toThrow(
      /Release-Authorized-By/,
    );
  });

  it('still enforces the pre-existing identity fields', () => {
    const gate = gateBlock({
      ...BASE_FIELDS,
      Version: '0.2.2',
      'Human-Signoff': 'Team Member',
    });
    expect(() => validateSecurityReviewGateFields(gate, EXPECTED, 'review.md')).toThrow(/version/i);
  });
});

describe('modelFamily', () => {
  it.each([
    ['claude-fable-5', 'claude'],
    ['`claude-opus-4.8`', 'claude'],
    ['gpt-5.5', 'gpt'],
    ['GPT-5.5-codex', 'gpt'],
    ['gemini-2.5-pro', 'gemini'],
  ])('%s -> %s', (id, family) => {
    expect(modelFamily(id)).toBe(family);
  });
});

// Regression pin: the committed legacy §13 artifacts (gate-block era,
// Human-Signoff only) must remain valid under the AI-only verifier.
describe('existing docs-private artifacts remain valid', () => {
  const reviewDir = path.join(REPO_ROOT, 'docs-private', 'reports', 'security-reviews');
  const legacyArtifacts = [
    '260529_hubspot_0.2.1.md',
    '260610_slack_0.1.4.md',
    '260611_retell-ai_0.2.3.md',
  ];

  it.skipIf(!fs.existsSync(reviewDir))('validates each gate-block-era artifact', () => {
    for (const file of legacyArtifacts) {
      const fullPath = path.join(reviewDir, file);
      if (!fs.existsSync(fullPath)) continue; // tolerate partial checkouts
      const match = file.match(/^\d{6}_(.+)_(\d+\.\d+\.\d+)\.md$/);
      expect(match, `filename convention for ${file}`).not.toBeNull();
      const [, connector, version] = match!;
      const gate = extractReviewGateFields(fs.readFileSync(fullPath, 'utf8'));
      expect(() =>
        validateSecurityReviewGateFields(
          gate,
          { connector, npmPackage: `@mindstone/mcp-server-${connector}`, version },
          file,
        ),
      ).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Stage 1 version-skew guard (Stage 7a, R2-F7): the bump implementation
// lives at the submodule pin; an older pin must fail loud with the exact
// "advance the submodule" fix, never fall back to an inline bump.
// ---------------------------------------------------------------------------

describe('assertBumpConnectorScript', () => {
  it('fails loud with the submodule-advance fix when the script is absent at the pin', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-release-skew-'));
    try {
      expect(() => assertBumpConnectorScript(dir)).toThrow(
        /update the mcp-servers submodule to a release-tooling commit \(>= 2026-06-11\) — see MCP_OSS_RELEASE_AGENT_DRIVEN\.md/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the script path when present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-release-skew-'));
    try {
      const scriptPath = path.join(dir, 'scripts', 'bump-connector.mjs');
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
      fs.writeFileSync(scriptPath, '// stub\n');
      expect(assertBumpConnectorScript(dir)).toBe(scriptPath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Ordering pin (R2-F7): once mcp-release.ts delegates to the submodule
  // script, a checkout whose pin predates it is broken-by-skew — this test
  // makes that loud in CI rather than at release time. Tolerates a
  // not-initialized submodule (partial checkouts), matching the docs-private
  // tolerance above.
  const submoduleDir = path.join(REPO_ROOT, 'mcp-servers');
  it.skipIf(!fs.existsSync(path.join(submoduleDir, 'connectors')))(
    'the current mcp-servers pin carries scripts/bump-connector.mjs',
    () => {
      expect(() => assertBumpConnectorScript(submoduleDir)).not.toThrow();
    },
  );
});

// ---------------------------------------------------------------------------
// --reconcile fail-loud preconditions (review round 2: reconcile only
// handles the clean tip case; everything else routes to the manual runbook)
// ---------------------------------------------------------------------------

describe('reconcile preconditions', () => {
  const TIP = 'a'.repeat(40);
  const OTHER = 'b'.repeat(40);

  it('accepts a submodule HEAD that IS the origin/main tip', () => {
    expect(() => assertReconcileTipCheckout(TIP, TIP)).not.toThrow();
  });

  it('rejects a non-tip checkout, routing to checkout origin/main + the manual runbook', () => {
    expect(() => assertReconcileTipCheckout(OTHER, TIP)).toThrow(
      /not the origin\/main tip[\s\S]*checkout origin\/main[\s\S]*MCP_OSS_PACKAGE_MANUAL_UPDATE/,
    );
  });

  it('accepts a clean working tree after the idempotent regen', () => {
    expect(() => assertReconcileRegenClean('', 'slack')).not.toThrow();
    expect(() => assertReconcileRegenClean('   \n', 'slack')).not.toThrow();
  });

  it('aborts on ANY regen drift (no drift-fix commit), routing to the manual runbook', () => {
    expect(() => assertReconcileRegenClean(' M docs/index.md\n', 'slack')).toThrow(
      /will NOT create a drift-fix commit[\s\S]*MCP_OSS_PACKAGE_MANUAL_UPDATE/,
    );
    expect(() => assertReconcileRegenClean('?? connectors/slack/STATUS.json\n', 'slack')).toThrow(
      /--reconcile aborted/,
    );
  });
});

// ---------------------------------------------------------------------------
// compareSemver (--reconcile ahead-of-pin ordering)
// ---------------------------------------------------------------------------

describe('compareSemver', () => {
  it('orders major/minor/patch numerically', () => {
    expect(compareSemver('0.2.3', '0.2.2')).toBeGreaterThan(0);
    expect(compareSemver('0.2.2', '0.2.3')).toBeLessThan(0);
    expect(compareSemver('0.2.3', '0.2.3')).toBe(0);
    expect(compareSemver('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0);
  });

  it('throws on non-semver input', () => {
    expect(() => compareSemver('not-a-version', '1.0.0')).toThrow(/non-semver/);
  });
});

// ---------------------------------------------------------------------------
// isCommitAncestor — real git fixture (hermetic: scrub GIT_* like
// release-to-production-guards.test.ts, since this can run inside the
// pre-push hook where git exports GIT_DIR etc.)
// ---------------------------------------------------------------------------

const SCRUBBED_GIT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
];

describe('isCommitAncestor', () => {
  const savedGitEnv: Record<string, string | undefined> = {};
  let repoDir: string;
  let first: string;
  let second: string;

  beforeAll(() => {
    for (const key of SCRUBBED_GIT_VARS) {
      savedGitEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';

    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-release-ancestor-'));
    const git = (cmd: string): string =>
      execSync(`git ${cmd}`, { cwd: repoDir, encoding: 'utf8' }).trim();
    git('init -q -b main');
    git('config user.email test@example.com');
    git('config user.name Test');
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'one\n');
    git('add a.txt');
    git('commit -q -m first');
    first = git('rev-parse HEAD');
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'two\n');
    git('add a.txt');
    git('commit -q -m second');
    second = git('rev-parse HEAD');
  });

  afterAll(() => {
    for (const key of SCRUBBED_GIT_VARS) {
      if (savedGitEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedGitEnv[key];
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('accepts a descendant HEAD (ancestor -> true)', () => {
    expect(isCommitAncestor(first, second, repoDir)).toBe(true);
  });

  it('treats a commit as its own ancestor (strict-equality case still passes)', () => {
    expect(isCommitAncestor(second, second, repoDir)).toBe(true);
  });

  it('refuses foreign state (descendant -> ancestor is false)', () => {
    expect(isCommitAncestor(second, first, repoDir)).toBe(false);
  });

  it('throws (not false) on an unknown SHA — fail loud, not fail open', () => {
    expect(() => isCommitAncestor('0'.repeat(40), second, repoDir)).toThrow(/merge-base/);
  });
});

// ---------------------------------------------------------------------------
// bump-connector.mjs sync mode (review round 2, F2): when package.json is
// already at --to, the script must VALIDATE every other lockstep version
// surface (package-lock.json top-level + packages[""], server.json top-level
// + packages[0], CHANGELOG `## [<to>]` block) instead of skipping them — a
// partial state is a desynced externally-landed bump that fails closed and
// routes to the manual runbook. Exercised against a temp-copy fixture repo
// (the script resolves connectors/ relative to its own location, so the
// fixture copies the script into a scratch repo root; the generator scripts
// are intentionally absent there, which the script tolerates by skipping).
// ---------------------------------------------------------------------------

const BUMP_SCRIPT_SRC = path.join(REPO_ROOT, 'mcp-servers', 'scripts', 'bump-connector.mjs');

describe.skipIf(!fs.existsSync(BUMP_SCRIPT_SRC))('bump-connector.mjs lockstep sync mode', () => {
  const VERSION = '0.2.3';
  const CONNECTOR = 'testconn';
  const fixtureDirs: string[] = [];

  afterAll(() => {
    for (const dir of fixtureDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  interface FixtureOverrides {
    lockVersion?: string;
    lockRootPkgVersion?: string;
    serverVersion?: string;
    serverPkgVersion?: string;
    changelog?: string | null; // null = no CHANGELOG.md at all
    omitLockfile?: boolean;
  }

  function makeFixture(overrides: FixtureOverrides = {}): {
    repoDir: string;
    connectorDir: string;
    run: (...args: string[]) => SpawnSyncReturns<string>;
  } {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bump-connector-fixture-'));
    fixtureDirs.push(repoDir);
    const scriptPath = path.join(repoDir, 'scripts', 'bump-connector.mjs');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.copyFileSync(BUMP_SCRIPT_SRC, scriptPath);

    const connectorDir = path.join(repoDir, 'connectors', CONNECTOR);
    fs.mkdirSync(connectorDir, { recursive: true });
    const writeJson = (name: string, value: unknown): void =>
      fs.writeFileSync(path.join(connectorDir, name), `${JSON.stringify(value, null, 2)}\n`);

    writeJson('package.json', { name: `@mindstone/mcp-server-${CONNECTOR}`, version: VERSION });
    if (!overrides.omitLockfile) {
      writeJson('package-lock.json', {
        name: `@mindstone/mcp-server-${CONNECTOR}`,
        version: overrides.lockVersion ?? VERSION,
        lockfileVersion: 3,
        packages: {
          '': {
            name: `@mindstone/mcp-server-${CONNECTOR}`,
            version: overrides.lockRootPkgVersion ?? VERSION,
          },
        },
      });
    }
    writeJson('server.json', {
      name: `io.github.mindstone-ai/${CONNECTOR}`,
      version: overrides.serverVersion ?? VERSION,
      packages: [{ identifier: `@mindstone/mcp-server-${CONNECTOR}`, version: overrides.serverPkgVersion ?? VERSION }],
    });
    // Schema v2: STATUS.json stores no version (check-status.mjs rejects a
    // present field). The bump script must never read or write this file.
    writeJson('STATUS.json', { schemaVersion: 2, name: CONNECTOR });
    if (overrides.changelog !== null) {
      fs.writeFileSync(
        path.join(connectorDir, 'CHANGELOG.md'),
        overrides.changelog ??
          `# Changelog\n\n## [Unreleased]\n\n## [${VERSION}] - 2026-06-11\n\n### Changed\n\n- prior release\n`,
      );
    }

    // Hermetic fixtures: skeleton repos have no scripts/check-server-json.mjs
    // and no registry access — skip the registry precondition (every real
    // invocation path runs it; the test below pins that the default is ON).
    const run = (...args: string[]): SpawnSyncReturns<string> =>
      spawnSync(process.execPath, [scriptPath, ...args, '--skip-server-json-check'], {
        encoding: 'utf8',
      });
    return { repoDir, connectorDir, run };
  }

  // STATUS.json schema v2 (drift-prevention Option-4-lite, Stage 7b): the
  // file stores no version, so the bump script's old STATUS-sync step is
  // gone. Sync mode must pass on a fully-landed bump and leave STATUS.json
  // byte-identical — reintroducing a version write here would recreate the
  // drift class check-status.mjs now rejects fail-closed.
  it('runs the server.json registry precondition by default (no skip flag => loud failure in a skeleton repo)', () => {
    const { repoDir, connectorDir } = makeFixture();
    const scriptPath = path.join(repoDir, 'scripts', 'bump-connector.mjs');
    const r = spawnSync(
      process.execPath,
      [scriptPath, CONNECTOR, '--to', VERSION, '--changelog-entry', 'noop'],
      { encoding: 'utf8' },
    );
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    void connectorDir;
  });

  it('passes a fully-landed bump (every lockstep surface at --to) and leaves STATUS.json untouched', () => {
    const { connectorDir, run } = makeFixture();
    const statusPath = path.join(connectorDir, 'STATUS.json');
    const statusBefore = fs.readFileSync(statusPath, 'utf8');
    const result = run(CONNECTOR, '--to', VERSION);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/idempotent sync only/);
    expect(fs.readFileSync(statusPath, 'utf8')).toBe(statusBefore);
  });

  it.each<[label: string, overrides: FixtureOverrides, staleSurfaceRe: RegExp]>([
    ['stale package-lock.json top-level version', { lockVersion: '0.2.2' }, /package-lock\.json version is "0\.2\.2"/],
    [
      'stale package-lock.json packages[""].version',
      { lockRootPkgVersion: '0.2.2' },
      /package-lock\.json packages\[""\]\.version is "0\.2\.2"/,
    ],
    ['stale server.json top-level version', { serverVersion: '0.2.2' }, /server\.json version is "0\.2\.2"/],
    [
      'stale server.json packages[0].version',
      { serverPkgVersion: '0.2.2' },
      /server\.json packages\[0\]\.version is "0\.2\.2"/,
    ],
    [
      'CHANGELOG missing the target block',
      { changelog: '# Changelog\n\n## [Unreleased]\n\n## [0.2.2] - 2026-06-01\n' },
      /CHANGELOG\.md has no "## \[0\.2\.3\]" block/,
    ],
    ['CHANGELOG.md absent entirely', { changelog: null }, /CHANGELOG\.md is missing/],
  ])('fails closed in sync mode on %s, routing to the manual runbook', (_label, overrides, staleSurfaceRe) => {
    const { run } = makeFixture(overrides);
    const result = run(CONNECTOR, '--to', VERSION);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(staleSurfaceRe);
    expect(result.stderr).toMatch(/desynced externally-landed bump/);
    expect(result.stderr).toMatch(/MCP_OSS_PACKAGE_MANUAL_UPDATE/);
  });

  it('reports EVERY stale surface in one failure and leaves the tree untouched', () => {
    const { connectorDir, run } = makeFixture({
      lockVersion: '0.2.2',
      serverPkgVersion: '0.2.1',
    });
    const statusPath = path.join(connectorDir, 'STATUS.json');
    const statusBefore = fs.readFileSync(statusPath, 'utf8');
    const result = run(CONNECTOR, '--to', VERSION);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/package-lock\.json version/);
    expect(result.stderr).toMatch(/server\.json packages\[0\]\.version/);
    // Fail closed BEFORE any write — and STATUS.json is never a write target
    // under schema v2 anyway.
    expect(fs.readFileSync(statusPath, 'utf8')).toBe(statusBefore);
  });

  it('still refuses a --to behind the current version (rollback is a git revert, not a re-bump)', () => {
    const { run } = makeFixture();
    const result = run(CONNECTOR, '--to', '0.2.2');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/BEHIND the current version/);
  });

  it('real bump then re-run: bump writes all surfaces, the re-run passes sync validation', () => {
    // omitLockfile: bump mode regenerates the lockfile via npm; keep the
    // fixture hermetic (no npm/network) by exercising the no-lockfile path.
    const { connectorDir, run } = makeFixture({ omitLockfile: true });
    const statusPath = path.join(connectorDir, 'STATUS.json');
    const statusBefore = fs.readFileSync(statusPath, 'utf8');
    const bump = run(CONNECTOR, '--to', '0.2.4', '--changelog-entry', 'test entry', '--date', '2026-06-11');
    expect(bump.status, bump.stderr).toBe(0);
    // Bump mode must not touch STATUS.json either (schema v2: no stored version).
    expect(fs.readFileSync(statusPath, 'utf8')).toBe(statusBefore);
    const pkg = JSON.parse(fs.readFileSync(path.join(connectorDir, 'package.json'), 'utf8'));
    expect(pkg.version).toBe('0.2.4');
    const server = JSON.parse(fs.readFileSync(path.join(connectorDir, 'server.json'), 'utf8'));
    expect(server.version).toBe('0.2.4');
    expect(server.packages[0].version).toBe('0.2.4');
    expect(fs.readFileSync(path.join(connectorDir, 'CHANGELOG.md'), 'utf8')).toContain(
      '## [0.2.4] - 2026-06-11',
    );

    const resync = run(CONNECTOR, '--to', '0.2.4');
    expect(resync.status, resync.stderr).toBe(0);
    expect(resync.stdout).toMatch(/idempotent sync only/);
  });
});
