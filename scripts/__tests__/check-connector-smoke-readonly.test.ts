import { describe, expect, it } from 'vitest';
import { checkOpReadOnly, checkRemoteOpReadOnly } from '../check-connector-smoke-readonly';
import {
  CONNECTOR_SMOKE_ALLOWLIST,
  REMOTE_READONLY_OPS,
} from '../../tests/connector-smoke/connectorSmokeAllowlist';

const SLACK_SRC = 'mcp-servers/connectors/slack/src';

describe('check-connector-smoke-readonly guard', () => {
  it('passes every op the smoke allowlist actually declares (local AST + remote curated)', () => {
    for (const entry of CONNECTOR_SMOKE_ALLOWLIST) {
      for (const op of entry.readOnlyOps) {
        if (entry.remote) {
          const result = checkRemoteOpReadOnly(entry.connector, op.name);
          expect(result.ok, `${entry.connector}.${op.name}: ${result.reason ?? ''}`).toBe(true);
        } else {
          const sourceDir = `mcp-servers/connectors/${entry.toolSourceConnectorDir}/src`;
          const result = checkOpReadOnly(entry.connector, op.name, sourceDir);
          expect(result.ok, `${entry.connector}.${op.name}: ${result.reason ?? ''}`).toBe(true);
          expect(result.annotations?.readOnlyHint).toBe(true);
          expect(result.annotations?.destructiveHint).not.toBe(true);
        }
      }
    }
  });

  it('FAILS on a real write/destructive op (slack post_slack_message)', () => {
    // The synthetic "what if someone allowlisted a write op" case. post_slack_message is a
    // real Slack tool annotated destructiveHint:true — the guard must reject it.
    const result = checkOpReadOnly('slack', 'post_slack_message', SLACK_SRC);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/destructiveHint:true|not annotated readOnlyHint:true/);
  });

  it('passes the Slack attachment metadata smoke op', () => {
    const result = checkOpReadOnly('slack', 'get_slack_message_by_link', SLACK_SRC);
    expect(result.ok, result.reason ?? '').toBe(true);
    expect(result.annotations?.readOnlyHint).toBe(true);
    expect(result.annotations?.destructiveHint).not.toBe(true);
  });

  it('FAILS when an allowlisted op cannot be found in the connector source', () => {
    const result = checkOpReadOnly('slack', 'this_tool_does_not_exist', SLACK_SRC);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not find/);
  });

  it('FAILS when the tool source dir does not exist', () => {
    const result = checkOpReadOnly('bogus', 'whatever', 'mcp-servers/connectors/does-not-exist/src');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/source dir not found/);
  });

  // --- remote (http) connector guarding ---

  it('passes a curated remote op (notion-get-users is in REMOTE_READONLY_OPS)', () => {
    expect(REMOTE_READONLY_OPS).toContain('notion-get-users');
    const result = checkRemoteOpReadOnly('notion', 'notion-get-users');
    expect(result.ok).toBe(true);
  });

  it('FAILS a non-curated / write remote op — must NOT be silently skipped', () => {
    // A remote write op someone tries to slip onto a remote allowlist. It is not in the curated
    // REMOTE_READONLY_OPS set, so the guard rejects it.
    const result = checkRemoteOpReadOnly('notion', 'notion-create-pages');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/curated REMOTE_READONLY_OPS/);
  });
});
