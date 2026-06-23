/**
 * Stage 1.B — MCP wrapper `renderContributionToolResult` unit tests.
 *
 * Asserts that the pure renderer exported from
 * `resources/mcp/rebel-mcp-connectors/server.cjs` translates each
 * Decision.kind into the deterministic text + isError shape per Decision 3
 * of `docs/plans/260426_foolproof_contribution_flow_stage1.md`.
 *
 * No `child_process.spawn`, no real bridge HTTP — synthetic bridge bodies
 * drive a 5-kind matrix plus legacy / fallback / unknown-kind edge cases.
 *
 * Loading `server.cjs` is gated by the `require.main === module ||
 * MCP_RUN_SERVER === '1'` check at the top of that file, so this require()
 * is safe and does NOT trigger the MCP server lifecycle.
 */

import path from 'node:path';

// Use a relative path that escapes `src/main/services/__tests__/` to the repo
// root. `import.meta.url` would be cleaner but Vitest in CommonJS-resolution
// mode handles `require()` for `.cjs` more robustly via createRequire.
import { createRequire } from 'node:module';
const requireServer = createRequire(import.meta.url);
const serverModule = requireServer(
  path.resolve(__dirname, '../../../../resources/mcp/rebel-mcp-connectors/server.cjs'),
);
const { renderContributionToolResult } = serverModule as {
  renderContributionToolResult: (body: unknown) => {
    content: Array<{ type: string; text: string }>;
    isError: boolean;
  };
};

// ── Synthetic bridge body builders ──────────────────────────────────────

function makeBuild(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'contrib-mock-1',
    sessionId: 'session-mock-1',
    connectorName: 'mock-connector',
    status: 'draft',
    attributionMode: 'anonymous',
    acknowledgedEvents: [],
    createdAt: '2026-04-26T12:00:00.000Z',
    updatedAt: '2026-04-26T12:00:00.000Z',
    ...overrides,
  };
}

function bodyForCreated(): Record<string, unknown> {
  const build = makeBuild({ status: 'draft' });
  return {
    success: true,
    contributionId: build.id,
    status: build.status,
    created: true,
    decision: { kind: 'created', build },
  };
}

function bodyForUpdated(): Record<string, unknown> {
  const build = makeBuild({ status: 'ready_to_submit' });
  return {
    success: true,
    contributionId: build.id,
    status: build.status,
    created: false,
    decision: { kind: 'updated', build },
    promotionDecision: 'promoted',
    promotionReason: 'evidence+intent',
  };
}

function bodyForNoop(): Record<string, unknown> {
  const build = makeBuild({ status: 'draft' });
  return {
    success: true,
    contributionId: build.id,
    status: build.status,
    created: false,
    decision: { kind: 'noop', build },
  };
}

function bodyForDeferredMissingEvidence(): Record<string, unknown> {
  const build = makeBuild({ status: 'testing' });
  return {
    success: true,
    contributionId: build.id,
    status: build.status,
    created: true,
    decision: {
      kind: 'deferred',
      build,
      reason: 'missing_evidence',
      nextAction: 'run_tests',
      guidance:
        'Run tests (Bash) or register the server via rebel_mcp_add_server before reporting ready_to_submit. The next evidence signal will promote this contribution automatically.',
    },
    promotionDecision: 'deferred',
    promotionReason: 'evidence-insufficient',
    missingSignals: ['test-pass', 'add-server-observer'],
    guidance:
      'Run tests (Bash) or register the server via rebel_mcp_add_server before reporting ready_to_submit. The next evidence signal will promote this contribution automatically.',
  };
}

function bodyForDeferredNonCanonical(): Record<string, unknown> {
  const build = makeBuild({ status: 'testing' });
  return {
    success: true,
    contributionId: build.id,
    status: build.status,
    created: true,
    decision: {
      kind: 'deferred',
      build,
      reason: 'non_canonical_path',
      nextAction: 'move_to_canonical_path',
      guidance:
        'Move the connector into ~/mcp-servers/<api-name>-mcp/, re-register it with rebel_mcp_add_server, then report ready_to_submit again.',
    },
  };
}

function bodyForRejectedInvalidTransition(): Record<string, unknown> {
  const build = makeBuild({ status: 'submitted' });
  return {
    success: false,
    contributionId: build.id,
    status: build.status,
    created: false,
    decision: {
      kind: 'rejected',
      build,
      reason: 'invalid_transition',
      nextAction: 'wait_for_review',
      guidance:
        "Cannot transition from 'submitted' to 'testing'. Valid next states from 'submitted' are: ci_pass, ci_fail, approved, changes_requested, rejected, published.",
    },
    error: "Cannot transition from 'submitted' to 'testing'.",
    currentStatus: 'submitted',
    attemptedStatus: 'testing',
  };
}

function bodyForRejectedReauth(): Record<string, unknown> {
  return {
    success: false,
    decision: {
      kind: 'rejected',
      reason: 'reauth_required',
      nextAction: 'reauth_github',
      guidance:
        'Your GitHub authorisation has expired. Reconnect GitHub in Settings → Connectors before retrying.',
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('renderContributionToolResult — Stage 1.B wrapper', () => {
  it('renders Created text for kind=created (isError=false)', () => {
    const out = renderContributionToolResult(bodyForCreated());
    expect(out.isError).toBe(false);
    expect(out.content[0].type).toBe('text');
    expect(out.content[0].text).toMatch(/^Created contribution contrib-mock-1 — status: draft$/);
  });

  it('renders Updated text for kind=updated (isError=false)', () => {
    const out = renderContributionToolResult(bodyForUpdated());
    expect(out.isError).toBe(false);
    expect(out.content[0].text).toMatch(/^Updated contribution contrib-mock-1 — status: ready_to_submit$/);
  });

  it('renders "No change to" text for kind=noop (isError=false)', () => {
    const out = renderContributionToolResult(bodyForNoop());
    expect(out.isError).toBe(false);
    expect(out.content[0].text).toMatch(/^No change to contribution contrib-mock-1 — status: draft$/);
  });

  it('returns isError=true for kind=deferred / reason=missing_evidence / nextAction=run_tests', () => {
    const out = renderContributionToolResult(bodyForDeferredMissingEvidence());
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('deferred');
    expect(out.content[0].text).toContain('missing_evidence');
    expect(out.content[0].text).toContain('run_tests');
    // Full guidance string preserved verbatim
    expect(out.content[0].text).toContain(
      'Run tests (Bash) or register the server via rebel_mcp_add_server',
    );
    // Footer parenthetical
    expect(out.content[0].text).toContain('contribution_id=contrib-mock-1');
    expect(out.content[0].text).toContain('current_status=testing');
  });

  it('returns isError=true for kind=deferred / reason=non_canonical_path / nextAction=move_to_canonical_path', () => {
    const out = renderContributionToolResult(bodyForDeferredNonCanonical());
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('deferred');
    expect(out.content[0].text).toContain('non_canonical_path');
    expect(out.content[0].text).toContain('move_to_canonical_path');
    expect(out.content[0].text).toContain('~/mcp-servers/<api-name>-mcp/');
  });

  it('returns isError=true for kind=rejected / reason=invalid_transition / nextAction=wait_for_review', () => {
    const out = renderContributionToolResult(bodyForRejectedInvalidTransition());
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('rejected');
    expect(out.content[0].text).toContain('invalid_transition');
    expect(out.content[0].text).toContain('wait_for_review');
    expect(out.content[0].text).toContain('current_status=submitted');
  });

  it('returns isError=true for kind=rejected / reason=reauth_required / nextAction=reauth_github', () => {
    const out = renderContributionToolResult(bodyForRejectedReauth());
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('reauth_required');
    expect(out.content[0].text).toContain('reauth_github');
    expect(out.content[0].text).toContain('Reconnect GitHub');
  });

  it('falls back to legacy success/error when bridge body lacks decision field (created)', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = renderContributionToolResult({
      success: true,
      contributionId: 'contrib-legacy-1',
      status: 'draft',
      created: true,
    });
    expect(out.isError).toBe(false);
    expect(out.content[0].text).toMatch(
      /^Created contribution contrib-legacy-1 — status: draft$/,
    );
    stderr.mockRestore();
  });

  it('falls back to legacy success path with Updated verb when created=false', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = renderContributionToolResult({
      success: true,
      contributionId: 'contrib-legacy-2',
      status: 'ready_to_submit',
      created: false,
    });
    expect(out.isError).toBe(false);
    expect(out.content[0].text).toMatch(
      /^Updated contribution contrib-legacy-2 — status: ready_to_submit$/,
    );
    stderr.mockRestore();
  });

  it('falls back to legacy error path when bridge body has success: false and no decision', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = renderContributionToolResult({ success: false, error: 'oops something exploded' });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('oops something exploded');
    stderr.mockRestore();
  });

  it('emits a structured diagnostic on stderr when a 2xx body lacks decision (success-without-decision path)', () => {
    // Stage 1 fix pass: the Stage 1.A bridge always attaches `decision` on
    // every non-malformed-input response. If the wrapper sees a `success:
    // true` body without `decision`, the bridge has regressed (failure
    // matrix #2 hidden-defer risk). The wrapper logs a structured JSON
    // diagnostic on stderr matching the existing unknown-kind pattern.
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderContributionToolResult({
      success: true,
      contributionId: 'contrib-diagnostic-1',
      status: 'ready_to_submit',
      created: false,
    });
    expect(stderr).toHaveBeenCalled();
    const calls = stderr.mock.calls.flat();
    const diagnosticCall = calls.find(
      (arg) => typeof arg === 'string' && arg.includes('contribution-state-decision-missing'),
    );
    expect(diagnosticCall).toBeDefined();
    // The diagnostic line is a single JSON string the operator can grep.
    expect(typeof diagnosticCall).toBe('string');
    const parsed = JSON.parse(diagnosticCall as string);
    expect(parsed.component).toBe('rebel-mcp-connectors');
    expect(parsed.event).toBe('contribution-state-decision-missing');
    expect(parsed.bodyHasSuccess).toBe(true);
    expect(parsed.bodyHasError).toBe(false);
    expect(parsed.contributionId).toBe('contrib-diagnostic-1');
    stderr.mockRestore();
  });

  it('emits the success-without-decision diagnostic on the error path too (defensive coverage)', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderContributionToolResult({ success: false, error: 'transport blew up' });
    const calls = stderr.mock.calls.flat();
    const diagnosticCall = calls.find(
      (arg) => typeof arg === 'string' && arg.includes('contribution-state-decision-missing'),
    );
    expect(diagnosticCall).toBeDefined();
    const parsed = JSON.parse(diagnosticCall as string);
    expect(parsed.bodyHasSuccess).toBe(false);
    expect(parsed.bodyHasError).toBe(true);
    expect(parsed.contributionId).toBeNull();
    stderr.mockRestore();
  });

  it('first-line text is regex-parseable: matches /Contribution state report (\\w+): (\\w+)\\./', () => {
    const cases = [
      bodyForDeferredMissingEvidence(),
      bodyForDeferredNonCanonical(),
      bodyForRejectedInvalidTransition(),
      bodyForRejectedReauth(),
    ];
    for (const c of cases) {
      const out = renderContributionToolResult(c);
      const firstLine = out.content[0].text.split('\n')[0];
      expect(firstLine).toMatch(/^Contribution state report (\w+): (\w+)\.$/);
    }
  });

  it('second-line text is regex-parseable: matches /Next action: \\w+\\./', () => {
    const cases = [
      bodyForDeferredMissingEvidence(),
      bodyForDeferredNonCanonical(),
      bodyForRejectedInvalidTransition(),
      bodyForRejectedReauth(),
    ];
    for (const c of cases) {
      const out = renderContributionToolResult(c);
      const lines = out.content[0].text.split('\n');
      expect(lines[1]).toMatch(/^Next action: \w+\.$/);
    }
  });

  it('success text format is backward-compat with pre-Stage-1 wrapper', () => {
    // Pre-Stage-1 produced exactly: `${verb} contribution ${id} — status: ${status}`.
    // The new wrapper must still produce this single-line format for kind ∈ {created, updated}.
    const created = renderContributionToolResult(bodyForCreated());
    expect(created.content[0].text).toMatch(/^(Created|Updated|No change to) contribution \S+ — status: \w+$/);

    const updated = renderContributionToolResult(bodyForUpdated());
    expect(updated.content[0].text).toMatch(/^(Created|Updated|No change to) contribution \S+ — status: \w+$/);
  });

  it('unknown decision.kind degrades to legacy success path with stderr warning', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = renderContributionToolResult({
      success: true,
      contributionId: 'contrib-unknown-kind',
      status: 'draft',
      created: true,
      decision: { kind: 'wibble' },
    });
    expect(out.isError).toBe(false);
    expect(out.content[0].text).toMatch(
      /^Created contribution contrib-unknown-kind — status: draft$/,
    );
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('Unknown decision.kind'),
      'wibble',
    );
    stderr.mockRestore();
  });

  it('decision.guidance is preserved verbatim including multi-line content', () => {
    const multiLineGuidance = 'Line one of guidance.\n  - bullet 1\n  - bullet 2\nLine four.';
    const out = renderContributionToolResult({
      success: true,
      decision: {
        kind: 'deferred',
        build: makeBuild({ status: 'testing' }),
        reason: 'missing_evidence',
        nextAction: 'run_tests',
        guidance: multiLineGuidance,
      },
    });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain(multiLineGuidance);
  });

  it('null/undefined bridge body degrades to legacy error path', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const outNull = renderContributionToolResult(null);
    expect(outNull.isError).toBe(true);
    expect(outNull.content[0].text).toContain('Failed to report contribution state');

    const outUndef = renderContributionToolResult(undefined);
    expect(outUndef.isError).toBe(true);
    stderr.mockRestore();
  });

  it('footer parenthetical falls back to body fields when decision.build is missing', () => {
    // Reauth-required deferred case where the bridge has not yet attached
    // a build (e.g. session+path with no contribution record). The renderer
    // should still produce a coherent footer using whatever body fields exist.
    const out = renderContributionToolResult({
      success: false,
      contributionId: 'fallback-id',
      status: 'fallback-status',
      decision: {
        kind: 'deferred',
        reason: 'missing_evidence',
        nextAction: 'run_tests',
        guidance: 'guidance text',
      },
    });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('contribution_id=fallback-id');
    expect(out.content[0].text).toContain('current_status=fallback-status');
  });
});
