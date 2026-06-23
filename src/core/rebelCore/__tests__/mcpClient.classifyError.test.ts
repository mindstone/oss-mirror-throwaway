import { describe, it, expect } from 'vitest';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { classifyMcpErrorKind } from '../mcpClient';

describe('classifyMcpErrorKind', () => {
  it('classifies bare Error("Not connected") as transport_not_connected', () => {
    expect(classifyMcpErrorKind(new Error('Not connected'))).toBe('transport_not_connected');
  });

  it('is case-insensitive on the not-connected message', () => {
    expect(classifyMcpErrorKind(new Error('not connected'))).toBe('transport_not_connected');
    expect(classifyMcpErrorKind(new Error('NOT CONNECTED'))).toBe('transport_not_connected');
  });

  it('only matches the exact SDK message, not arbitrary substrings', () => {
    // A different "not connected" wording must NOT be classified as transport-loss
    expect(classifyMcpErrorKind(new Error('the server is not connected to oauth'))).toBe('unknown');
    expect(classifyMcpErrorKind(new Error('Auth failed: not connected to upstream'))).toBe('unknown');
  });

  it('classifies "Connection closed" as transport_connection_closed', () => {
    expect(classifyMcpErrorKind(new Error('Connection closed'))).toBe('transport_connection_closed');
    expect(classifyMcpErrorKind(new Error('MCP error -32000: Connection closed'))).toBe('transport_connection_closed');
  });

  it('matches "Connection closed" with suffix context', () => {
    expect(classifyMcpErrorKind(new Error('Connection closed: server-initiated'))).toBe('transport_connection_closed');
  });

  // Stage 3 / B3 — a structured `-33007` (super-mcp DOWNSTREAM_ERROR) is a
  // DOWNSTREAM connector child-death, not severance of our own link to
  // super-mcp. It must be classified as `downstream_transport_closed` BEFORE
  // the "Connection closed" substring check (its message usually contains that
  // very phrase). This is a one-time Sentry-grouping discontinuity for existing
  // -33007 events (fingerprint discriminator `kind:` changes value).
  it('classifies a structured -33007 (DOWNSTREAM_ERROR) as downstream_transport_closed', () => {
    const downstream = {
      code: -33007,
      message: "Tool execution failed in package 'Brave Search'. MCP error -32000: Connection closed. try restart_package(...)",
    };
    expect(classifyMcpErrorKind(downstream)).toBe('downstream_transport_closed');
  });

  it('a -33007 with a bare "Connection closed" message is downstream, NOT transport_connection_closed', () => {
    expect(classifyMcpErrorKind({ code: -33007, message: 'Connection closed' })).toBe('downstream_transport_closed');
  });

  it('control: a bare Error("Connection closed") with NO code stays transport_connection_closed (our link)', () => {
    expect(classifyMcpErrorKind(new Error('Connection closed'))).toBe('transport_connection_closed');
    // A different code that happens to say "connection closed" is still our-link severance.
    expect(classifyMcpErrorKind({ code: -32000, message: 'Connection closed' })).toBe('transport_connection_closed');
  });

  it('classifies a wrapped "Not connected" structured McpError as mcp_error', () => {
    // Real-world SDK wrapping pattern: `McpError(-32603, 'Internal error: Not connected')`.
    // The `^not connected$` regex must NOT match because the message has a prefix —
    // this falls through to the McpError/structured check.
    const structured = { code: -32603, message: 'Internal error: Not connected' };
    expect(classifyMcpErrorKind(structured)).toBe('mcp_error');
  });

  it('classifies "session not found" messages as session_not_found', () => {
    expect(classifyMcpErrorKind(new Error('Session not found'))).toBe('session_not_found');
    expect(classifyMcpErrorKind(new Error('MCP error -32000: session not found'))).toBe('session_not_found');
  });

  it('classifies real McpError instances as mcp_error when message does not match transport patterns', () => {
    const err = new McpError(ErrorCode.InternalError, 'something went wrong');
    expect(classifyMcpErrorKind(err)).toBe('mcp_error');
  });

  it('prefers transport classification over mcp_error when message matches both patterns', () => {
    // A future structured error with message: 'Not connected' must NOT be demoted
    // to the generic mcp_error bucket — the classifier runs regex checks first.
    const structured = { code: -32000, message: 'Not connected' };
    expect(classifyMcpErrorKind(structured)).toBe('transport_not_connected');
  });

  it('classifies unknown non-Error values as unknown', () => {
    expect(classifyMcpErrorKind('some string')).toBe('unknown');
    expect(classifyMcpErrorKind(null)).toBe('unknown');
    expect(classifyMcpErrorKind(undefined)).toBe('unknown');
    expect(classifyMcpErrorKind({})).toBe('unknown');
  });
});
