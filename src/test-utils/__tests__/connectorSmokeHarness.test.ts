import { describe, expect, it } from 'vitest';
import {
  assertConnectorSmokeJsonExpectations,
  isAuthRequired,
  isRemoteAuthError,
  resolveOpsFromAllowlist,
  remoteAuthSkipDegradedLine,
  remoteAuthSkipReason,
} from '../connectorSmokeHarness';
import { CONNECTOR_SMOKE_CELLS, replitCell, slackCell } from '../../../tests/connector-smoke/connectorSmokeCells';
import { allowlistEntryFor } from '../../../tests/connector-smoke/connectorSmokeAllowlist';

describe('isAuthRequired', () => {
  it('matches the canonical auth_required envelope (slack/google/microsoft auth path)', () => {
    expect(isAuthRequired(JSON.stringify({ status: 'auth_required' }))).toBe(true);
    expect(
      isAuthRequired(JSON.stringify({ user_action: { id: 'microsoft.connect_account' } })),
    ).toBe(true);
    expect(isAuthRequired(JSON.stringify({ setupToolName: 'authenticate_workspace_account' }))).toBe(
      true,
    );
  });

  it('matches the Microsoft no-account error envelope (the live-run hard-fail shape)', () => {
    expect(
      isAuthRequired(
        JSON.stringify({
          ok: false,
          error: 'No Microsoft account found. Connect your Microsoft 365 account to continue.',
          next_step: 'authenticate_microsoft_account',
        }),
      ),
    ).toBe(true);
  });

  it('matches an error whose next_step is to authenticate, even without an explicit error string', () => {
    expect(isAuthRequired(JSON.stringify({ ok: false, next_step: 'authenticate_microsoft_account' }))).toBe(
      true,
    );
  });

  it('matches a "connect your account" / "account not connected" error message', () => {
    expect(isAuthRequired(JSON.stringify({ ok: false, error: 'Please connect your Slack account.' }))).toBe(
      true,
    );
    expect(isAuthRequired(JSON.stringify({ ok: false, error: 'Account is not connected.' }))).toBe(true);
  });

  it('does NOT match a generic non-auth error — a real failure must still fail', () => {
    expect(isAuthRequired(JSON.stringify({ ok: false, error: 'rate limited' }))).toBe(false);
    expect(isAuthRequired(JSON.stringify({ ok: false, error: 'Internal server error' }))).toBe(false);
    expect(isAuthRequired(JSON.stringify({ ok: false, error: 'Invalid argument: limit must be a number' }))).toBe(
      false,
    );
    // A successful read with content must never be treated as auth-required.
    expect(isAuthRequired(JSON.stringify({ ok: true, channels: [{ id: 'C1' }] }))).toBe(false);
  });

  it('handles non-JSON text via the textual fallback, and empty/undefined as false', () => {
    expect(isAuthRequired('error: auth_required for this workspace')).toBe(true);
    expect(isAuthRequired('connect_account to proceed')).toBe(true);
    expect(isAuthRequired('some unrelated plain-text error')).toBe(false);
    expect(isAuthRequired('')).toBe(false);
    expect(isAuthRequired(undefined)).toBe(false);
  });
});

describe('isRemoteAuthError', () => {
  it('matches a 401 on .status or .code (StreamableHTTPError carries HTTP status on .code)', () => {
    expect(isRemoteAuthError({ status: 401 })).toBe(true);
    expect(isRemoteAuthError({ code: 401 })).toBe(true);
    const e401 = Object.assign(new Error('Error POSTing to endpoint (HTTP 401): Unauthorized'), {
      code: 401,
    });
    expect(isRemoteAuthError(e401)).toBe(true);
  });

  it('matches explicit auth signals in the message even without a numeric status/code', () => {
    expect(isRemoteAuthError(new Error('401 Unauthorized'))).toBe(true);
    expect(isRemoteAuthError(new Error('invalid_token'))).toBe(true);
    expect(isRemoteAuthError(new Error('the access token has expired'))).toBe(true);
    expect(isRemoteAuthError(new Error('invalid_grant'))).toBe(true);
  });

  it('treats a BARE 403/forbidden as a FAILURE (scope/policy regression), not an auth-skip', () => {
    // Suggestion 5: a bare 403 must NOT be hidden as "reconnect" — it may be a removed scope or a
    // real authorization regression. Only a 403 WITH explicit token language is an auth-skip.
    expect(isRemoteAuthError({ status: 403 })).toBe(false);
    expect(isRemoteAuthError({ code: 403 })).toBe(false);
    expect(isRemoteAuthError(new Error('403 Forbidden: insufficient scope'))).toBe(false);
    expect(isRemoteAuthError(new Error('request forbidden'))).toBe(false);
    // ...but a 403 accompanied by token/expiry language IS an auth-skip.
    expect(isRemoteAuthError(Object.assign(new Error('403: token expired'), { code: 403 }))).toBe(true);
    expect(isRemoteAuthError(new Error('403 Forbidden: invalid_token'))).toBe(true);
  });

  it('does NOT match a generic / server error — must still FAIL the cell', () => {
    expect(isRemoteAuthError(Object.assign(new Error('Internal Server Error'), { code: 500 }))).toBe(false);
    expect(isRemoteAuthError({ status: 500 })).toBe(false);
    expect(isRemoteAuthError({ code: 503 })).toBe(false);
    expect(isRemoteAuthError(new Error('ECONNRESET'))).toBe(false);
    expect(isRemoteAuthError(new Error('socket hang up'))).toBe(false);
    expect(isRemoteAuthError(undefined)).toBe(false);
  });
});

describe('remote auth-skip telemetry never leaks the token (item 3)', () => {
  it('the DEGRADED line + skip reason are built from connector + phase ONLY — never the error', () => {
    // By construction the auth-skip path logs ONLY these two builders (no error.message), and the
    // builders take no error argument — so a bearer token embedded in a thrown SDK/server error
    // cannot reach the telemetry. Even feeding a token-like string as the phase is fine: callers
    // pass only fixed phases ('connect' / `call <op>`), never error text.
    const fakeToken = 'xoxb-SUPER-SECRET-BEARER-0123456789';
    const degraded = remoteAuthSkipDegradedLine('notion', 'connect');
    const reason = remoteAuthSkipReason('notion', 'call notion-get-users');
    expect(degraded).not.toContain(fakeToken);
    expect(reason).not.toContain(fakeToken);
    expect(degraded).toContain('DEGRADED notion');
    expect(reason).toContain('token expired/needs reconnect');
  });
});

describe('ops are resolved from the SSOT, not a mutable cell field (item 2)', () => {
  it('every cell maps to a non-empty SSOT allowlist entry and exposes NO own readOnlyOps field', () => {
    for (const cell of CONNECTOR_SMOKE_CELLS) {
      // The cell must NOT carry its own op list (the runner resolves from the SSOT by connector id).
      expect(
        (cell as unknown as Record<string, unknown>).readOnlyOps,
        `${cell.connector} must not declare its own readOnlyOps (resolve from SSOT)`,
      ).toBeUndefined();
      // The SSOT must have a non-empty op set for the connector (red-team F5: no zero-coverage).
      const entry = allowlistEntryFor(cell.connector);
      expect(entry.readOnlyOps.length, `${cell.connector}: SSOT has 0 ops`).toBeGreaterThan(0);
    }
  });

  it('replit argsFor overrides ONLY an allowlisted op name (cannot introduce a new op)', () => {
    const host = 'h-uuid.riker.replit.dev';
    const user = 'u-uuid';
    const saved = { h: process.env.REPLIT_SMOKE_HOST, u: process.env.REPLIT_SMOKE_USER };
    process.env.REPLIT_SMOKE_HOST = host;
    process.env.REPLIT_SMOKE_USER = user;
    try {
      // The allowlisted op gets host/user; any other name resolves to undefined (no injection).
      expect(replitCell.argsFor?.('replit_check_connection')).toEqual({ host, user });
      expect(replitCell.argsFor?.('replit_write_file')).toBeUndefined();
    } finally {
      if (saved.h === undefined) delete process.env.REPLIT_SMOKE_HOST;
      else process.env.REPLIT_SMOKE_HOST = saved.h;
      if (saved.u === undefined) delete process.env.REPLIT_SMOKE_USER;
      else process.env.REPLIT_SMOKE_USER = saved.u;
    }
  });

  it('skips only the env-gated Slack permalink op when SLACK_SMOKE_PERMALINK is unset', () => {
    const resolved = resolveOpsFromAllowlist(slackCell, { RUN_CONNECTOR_SMOKE_TESTS: '1' });

    expect(resolved.runnableOps.map((op) => op.name)).toEqual([
      'list_slack_workspaces',
      'list_slack_channels',
    ]);
    expect(resolved.skippedOps).toEqual([
      {
        name: 'get_slack_message_by_link',
        skipReason:
          "slack.get_slack_message_by_link: SLACK_SMOKE_PERMALINK is not set (required for argument 'url').",
      },
    ]);
  });

  it('maps SLACK_SMOKE_PERMALINK into the Slack message-by-link url argument when set', () => {
    const permalink = 'https://workspace.slack.com/archives/C123/p1710000000000000';
    const resolved = resolveOpsFromAllowlist(slackCell, {
      RUN_CONNECTOR_SMOKE_TESTS: '1',
      SLACK_SMOKE_PERMALINK: ` ${permalink} `,
    });
    const op = resolved.runnableOps.find((candidate) => candidate.name === 'get_slack_message_by_link');

    expect(resolved.skippedOps).toEqual([]);
    expect(op?.arguments).toEqual({ include_thread: false, url: permalink });
  });
});

describe('declarative connector-smoke JSON expectations', () => {
  const slackMessageByLinkOp = allowlistEntryFor('slack').readOnlyOps.find(
    (op) => op.name === 'get_slack_message_by_link',
  );
  function requireSlackMessageByLinkOp() {
    if (!slackMessageByLinkOp) {
      throw new Error('Slack get_slack_message_by_link smoke op is missing from the allowlist');
    }
    return slackMessageByLinkOp;
  }

  it('accepts the Slack attachment metadata response shape', () => {
    assertConnectorSmokeJsonExpectations(
      slackCell,
      requireSlackMessageByLinkOp(),
      JSON.stringify({
        ok: true,
        message: {
          files: [
            {
              id: 'F123',
              mimetype: 'application/pdf',
              size: 12345,
            },
          ],
        },
      }),
    );
  });

  it('rejects a Slack message-by-link response without file metadata', () => {
    expect(() =>
      assertConnectorSmokeJsonExpectations(
        slackCell,
        requireSlackMessageByLinkOp(),
        JSON.stringify({ ok: true, message: { files: [] } }),
      ),
    ).toThrow(/message\.files/);
  });
});
