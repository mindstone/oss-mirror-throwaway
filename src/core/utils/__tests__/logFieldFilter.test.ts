/**
 * Unit tests for logFieldFilter — privacy-safe log field allowlisting.
 *
 * Verifies that:
 * - Allowlisted fields pass through unchanged
 * - Blocked fields (user content, paths, MCP args) are stripped
 * - sanitizeLogMessage() removes dangerous embedded content
 * - filterLogEntries() handles multi-line NDJSON correctly
 * - extractAnonymizedSessionMeta() returns safe stats, never titles/messages
 */

import { describe, it, expect, vi } from 'vitest';

// Mock @core/utils/logRedaction before importing the module under test
vi.mock('@core/utils/logRedaction', () => ({
  redactSensitiveData: (content: string) => {
    // Simplified: normalize home directory paths and redact emails
    return content
      .replace(/\/Users\/[^/\s"]+/g, '~')
      .replace(/\/home\/[^/\s"]+/g, '~')
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '***@***.***');
  },
}));

import {
  SAFE_LOG_FIELDS,
  SANITIZED_LOG_FIELDS,
  sanitizeLogMessage,
  filterLogEntry,
  filterLogEntries,
  redactLogBreadcrumbData,
  extractAnonymizedSessionMeta,
} from '@core/utils/logFieldFilter';
import { collectSerdeStrictnessIssues } from '@shared/utils/sentrySerdeStrictness';

// =============================================================================
// SAFE_LOG_FIELDS — allowlist correctness
// =============================================================================

describe('SAFE_LOG_FIELDS', () => {
  it('includes all expected structural fields', () => {
    const expected = [
      'level', 'time', 'ts', 'pid', 'hostname', 'v',
      'service', 'component', 'source', 'name', 'tag', 'ipc', 'channel', 'handler',
      'status', 'statusCode', 'code',
      'toolName', 'isError', 'toolArgKeys', 'toolEmptyArgKeys',
      'duration', 'durationMs', 'count', 'size', 'sizeBytes', 'lineCount',
      'turnId', 'sessionId', 'requestId', 'traceId',
    ];
    for (const field of expected) {
      expect(SAFE_LOG_FIELDS.has(field), `Expected '${field}' in SAFE_LOG_FIELDS`).toBe(true);
    }
  });

  it('does NOT include dangerous content fields', () => {
    const dangerous = [
      'preview', 'structuredOutput', 'args', 'stderr', 'meetingTitle',
      'content', 'text', 'description', 'title', 'query', 'prompt',
      'result', 'response', 'output', 'data', 'body', 'payload',
      'filePath', 'path', 'configPath', 'automationFilePath',
      'workspacePath', 'relativePath', 'breadcrumbs',
    ];
    const newToolDiagnosticsFields = ['toolName', 'isError', 'toolArgKeys', 'toolEmptyArgKeys'];

    for (const field of newToolDiagnosticsFields) {
      expect(dangerous).not.toContain(field);
    }

    for (const field of dangerous) {
      expect(SAFE_LOG_FIELDS.has(field), `'${field}' should NOT be in SAFE_LOG_FIELDS`).toBe(false);
    }
  });

  it('does NOT allowlist PII-bearing tool/package identifier shapes', () => {
    // Package IDs in this repo encode PII-derived account slugs (e.g.
    // 'GoogleWorkspace-teammember-mindstone-com'); the compound `${packageId}__${toolName}`
    // form (e.g. 'GoogleWorkspace-liam-com__send_workspace_email') inherits that PII.
    // Neither `packageId` nor any compound-identifier field belongs in this allowlist.
    const piiBearingFields = ['packageId', 'effectiveToolId', 'tool_id', 'serverInstanceId', 'sourcePackageId'];
    for (const field of piiBearingFields) {
      expect(SAFE_LOG_FIELDS.has(field), `'${field}' must NOT be in SAFE_LOG_FIELDS (carries PII-derived slugs)`).toBe(false);
    }
  });
});

describe('SANITIZED_LOG_FIELDS', () => {
  it('includes msg and error-related fields', () => {
    expect(SANITIZED_LOG_FIELDS.has('msg')).toBe(true);
    expect(SANITIZED_LOG_FIELDS.has('err')).toBe(true);
    expect(SANITIZED_LOG_FIELDS.has('errMsg')).toBe(true);
    expect(SANITIZED_LOG_FIELDS.has('errCode')).toBe(true);
    expect(SANITIZED_LOG_FIELDS.has('errStack')).toBe(true);
  });
});

describe('MCP tool execution outcomes', () => {
  it('passes through each new tool diagnostics field unchanged', () => {
    const fieldCases: Array<[string, unknown]> = [
      ['toolName', 'compose_workspace_email'],
      ['isError', true],
      ['toolArgKeys', ['to', 'subject', 'body']],
      ['toolEmptyArgKeys', ['body']],
    ];

    for (const [field, value] of fieldCases) {
      const result = filterLogEntry({ level: 30, [field]: value });
      expect(result[field]).toEqual(value);
    }
  });

  it('passes through toolArgKeys/toolEmptyArgKeys string[] values unchanged', () => {
    const entry = {
      toolArgKeys: ['to', 'subject', 'body'],
      toolEmptyArgKeys: ['body'],
    };

    const result = filterLogEntry(entry);
    expect(result.toolArgKeys).toEqual(['to', 'subject', 'body']);
    expect(result.toolEmptyArgKeys).toEqual(['body']);
  });

  it('passes through isError=false and isError=true', () => {
    for (const isError of [false, true]) {
      const result = filterLogEntry({ isError });
      expect(result.isError).toBe(isError);
    }
  });

  it('keeps toolName while stripping dangerous fields and unknown packageId', () => {
    const entry = {
      level: 30,
      toolName: 'compose_workspace_email',
      // packageId is intentionally NOT allowlisted — must be stripped even when present.
      packageId: 'GoogleWorkspace-teammember-mindstone-com',
      args: { to: 'user@example.com', subject: 'Hi', body: 'Secret body' },
      preview: 'Draft body preview',
    };

    const result = filterLogEntry(entry);
    expect(result.level).toBe(30);
    expect(result.toolName).toBe('compose_workspace_email');
    expect(result).not.toHaveProperty('packageId');
    expect(result).not.toHaveProperty('args');
    expect(result).not.toHaveProperty('preview');
  });
});

// =============================================================================
// sanitizeLogMessage
// =============================================================================

describe('sanitizeLogMessage', () => {
  it('preserves short operational messages unchanged (modulo redactSensitiveData pass)', () => {
    expect(sanitizeLogMessage('Starting agent turn')).toBe('Starting agent turn');
    expect(sanitizeLogMessage('Health check passed')).toBe('Health check passed');
    expect(sanitizeLogMessage('IPC call completed')).toBe('IPC call completed');
  });

  it('strips double-quoted strings longer than 10 chars', () => {
    const input = 'Auto-title failed for "My Secret Project Meeting Notes"';
    const result = sanitizeLogMessage(input);
    expect(result).toContain('[content-redacted]');
    expect(result).not.toContain('Secret Project');
  });

  it('strips single-quoted strings longer than 10 chars', () => {
    const input = "Failed to read 'really-long-filename-here.docx'";
    const result = sanitizeLogMessage(input);
    expect(result).toContain('[content-redacted]');
    expect(result).not.toContain('really-long-filename');
  });

  it('preserves short quoted strings (10 chars or fewer)', () => {
    const input = 'Status: "ok"';
    const result = sanitizeLogMessage(input);
    expect(result).toContain('"ok"');
  });

  it('strips file paths after ~/', () => {
    const input = 'Reading file ~/Documents/secret-project/notes.md';
    const result = sanitizeLogMessage(input);
    expect(result).toContain('~/[path-redacted]');
    expect(result).not.toContain('Documents');
    expect(result).not.toContain('secret-project');
  });

  it('strips content after title: keyword', () => {
    const input = 'Meeting prep saved for title: Q4 Strategy Review with Board Members';
    const result = sanitizeLogMessage(input);
    expect(result).toContain('title: [content-redacted]');
    expect(result).not.toContain('Q4 Strategy');
  });

  it('strips content after description: keyword', () => {
    const input = 'Processing description: This is my confidential project description here';
    const result = sanitizeLogMessage(input);
    expect(result).toContain('description: [content-redacted]');
    expect(result).not.toContain('confidential');
  });

  it('applies redactSensitiveData as final pass (emails)', () => {
    const input = 'User: alice@example.com reported error';
    const result = sanitizeLogMessage(input);
    expect(result).toContain('***@***.***');
    expect(result).not.toContain('alice@example.com');
  });

  it('applies redactSensitiveData as final pass (home dir paths)', () => {
    const input = 'Config at /Users/alice/Library/Preferences/config.json';
    const result = sanitizeLogMessage(input);
    expect(result).toContain('~');
    expect(result).not.toContain('/Users/alice');
  });

  it('handles combined dangerous content', () => {
    const input = 'Failed to process "My Important Document.docx" at ~/Projects/secret/file.txt for title: Board Meeting 2026';
    const result = sanitizeLogMessage(input);
    expect(result).not.toContain('Important Document');
    expect(result).not.toContain('Projects/secret');
    expect(result).not.toContain('Board Meeting');
  });
});

// =============================================================================
// filterLogEntry
// =============================================================================

describe('filterLogEntry', () => {
  it('passes through safe fields unchanged', () => {
    const entry = {
      level: 30,
      time: '2026-03-24T10:00:00.000Z',
      pid: 12345,
      service: 'mcpService',
      component: 'ipc',
      status: 'ok',
      durationMs: 150,
      turnId: 'abc-123',
      sessionId: 'def-456',
    };
    const result = filterLogEntry(entry);
    expect(result).toEqual(entry);
  });

  it('strips blocked fields entirely', () => {
    const entry = {
      level: 50,
      time: '2026-03-24T10:00:00.000Z',
      msg: 'Error occurred',
      preview: 'User document content here',
      structuredOutput: { title: 'Secret' },
      args: { filePath: '/Users/bob/secret.doc' },
      stderr: 'Error: confidential output',
      meetingTitle: 'Board Strategy Session',
      content: 'Full message content',
      filePath: '/Users/bob/docs/important.pdf',
      breadcrumbs: ['user action 1', 'user action 2'],
    };
    const result = filterLogEntry(entry);

    // Safe fields present
    expect(result.level).toBe(50);
    expect(result.time).toBe('2026-03-24T10:00:00.000Z');

    // Sanitized field present (msg)
    expect(result.msg).toBeDefined();

    // Blocked fields absent
    expect(result).not.toHaveProperty('preview');
    expect(result).not.toHaveProperty('structuredOutput');
    expect(result).not.toHaveProperty('args');
    expect(result).not.toHaveProperty('stderr');
    expect(result).not.toHaveProperty('meetingTitle');
    expect(result).not.toHaveProperty('content');
    expect(result).not.toHaveProperty('filePath');
    expect(result).not.toHaveProperty('breadcrumbs');
  });

  it('sanitizes msg field through sanitizeLogMessage', () => {
    const entry = {
      level: 40,
      msg: 'Failed for "My Really Secret Document Title Here"',
    };
    const result = filterLogEntry(entry);
    expect(result.msg).toContain('[content-redacted]');
    expect(result.msg).not.toContain('Secret Document');
  });

  it('sanitizes err field through sanitizeLogMessage', () => {
    const entry = {
      level: 50,
      err: 'Error reading ~/Projects/secret-client/data.json: ENOENT',
    };
    const result = filterLogEntry(entry);
    expect(String(result.err)).toContain('~/[path-redacted]');
    expect(String(result.err)).not.toContain('secret-client');
  });

  // REGRESSION GUARD (REBEL bug-report data-quality): pino writes `err` as a
  // nested OBJECT by default ({type,message,stack,code,...}). The old filter
  // collapsed any non-string sanitized value with String(value), turning every
  // real error into the literal "[object Object]" in Sentry — discarding
  // message/code/stack for ~all error logging. This was never tested because the
  // only prior `err` case passed a string. See
  // docs/plans/260606_bug-report-data-quality/subagent_reports/260606_researcher-object-object-rootcause.md
  it('preserves the structure of an object err (pino default shape), not "[object Object]"', () => {
    const entry = {
      level: 50,
      msg: 'Codex passthrough failed',
      err: {
        type: 'Error',
        message: 'ECONNREFUSED localhost:1455',
        code: 'ECONNREFUSED',
        stack: 'Error: ECONNREFUSED\n    at file:///Users/realuser/dev/app/proxy.ts:12:7',
      },
    };
    const result = filterLogEntry(entry);

    // Must NOT be the stringified-object placeholder.
    expect(result.err).not.toBe('[object Object]');
    expect(JSON.stringify(result)).not.toContain('[object Object]');

    // Structure + diagnostic signal preserved.
    expect(result.err).toMatchObject({
      type: 'Error',
      message: 'ECONNREFUSED localhost:1455',
      code: 'ECONNREFUSED',
    });

    // Stack home-dir path is scrubbed (privacy): no raw /Users/<name> survives.
    const err = result.err as Record<string, unknown>;
    expect(String(err.stack)).not.toContain('/Users/realuser');
    expect(String(err.stack)).not.toContain('realuser');
    expect(JSON.stringify(result)).not.toMatch(/\/Users\/[^/\s"]+/);
  });

  // PRIVACY GUARD (Reviewer F1): a custom Error subclass can carry arbitrary
  // user data as enumerable properties. Only canonical Error keys may survive;
  // everything else must be dropped (the old String(value) collapse leaked none
  // of this, so a naive recursion would be a regression).
  it('drops content-bearing custom properties from an object err, keeps canonical keys', () => {
    const entry = {
      level: 50,
      err: {
        message: 'request failed',
        code: 'E_CUSTOM',
        status: 502,
        // Content-bearing custom props that MUST be dropped:
        projectName: 'Confidential Target Corp',
        customerId: 123456789,
        path: '/private/var/folders/x/secret-merger.ts',
        payload: { type: 'Buffer', data: [115, 107, 45, 97, 110, 116] },
      },
    };
    const result = filterLogEntry(entry);
    const err = result.err as Record<string, unknown>;

    // Canonical operational keys preserved.
    expect(err.message).toBe('request failed');
    expect(err.code).toBe('E_CUSTOM');
    expect(err.status).toBe(502);

    // Custom / content-bearing keys dropped entirely.
    expect(err).not.toHaveProperty('projectName');
    expect(err).not.toHaveProperty('customerId');
    expect(err).not.toHaveProperty('path');
    expect(err).not.toHaveProperty('payload');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Confidential Target Corp');
    expect(serialized).not.toContain('123456789');
    expect(serialized).not.toContain('secret-merger');
  });

  it('recurses a cause chain and an errors[] array with the same key allowlist', () => {
    const entry = {
      level: 50,
      err: {
        message: 'outer',
        secretOuter: 'Confidential Target Corp',
        cause: { message: 'inner', code: 'EINNER', secretInner: '[external-email]' },
        errors: [{ message: 'agg one', leak: 'Confidential Target Corp' }],
      },
    };
    const result = filterLogEntry(entry);
    const serialized = JSON.stringify(result);
    const err = result.err as Record<string, unknown>;
    expect((err.cause as Record<string, unknown>).message).toBe('inner');
    expect((err.cause as Record<string, unknown>).code).toBe('EINNER');
    expect(serialized).not.toContain('Confidential Target Corp');
    expect(serialized).not.toContain('[external-email]');
    expect(err).not.toHaveProperty('secretOuter');
  });

  // PRIVACY GUARD (Reviewer F5): `Error.cause` / `AggregateError.errors` are
  // typed `unknown` — a bare primitive there must NOT survive (it would reopen the
  // F1 leak class through a canonical key). cause/errors carry only Error objects.
  it('drops primitive cause / errors values, keeps Error-shaped ones', () => {
    const entry = {
      level: 50,
      err: {
        message: 'outer',
        cause: 'Confidential Target Corp', // bare string cause → must be dropped
        errors: [123456789, 'Confidential Target Corp', { message: 'agg ok', code: 'EAGG' }],
      },
    };
    const result = filterLogEntry(entry);
    const err = result.err as Record<string, unknown>;
    const serialized = JSON.stringify(result);

    expect(err.message).toBe('outer');
    expect(err).not.toHaveProperty('cause'); // primitive cause dropped entirely
    // errors keeps only the Error-shaped element.
    expect(Array.isArray(err.errors)).toBe(true);
    expect(err.errors).toHaveLength(1);
    expect((err.errors as Array<Record<string, unknown>>)[0]).toMatchObject({ message: 'agg ok', code: 'EAGG' });

    expect(serialized).not.toContain('Confidential Target Corp');
    expect(serialized).not.toContain('123456789');
  });

  it('caps recursion depth on a hostile deeply-nested err', () => {
    // Build a chain deeper than MAX_NESTED_DEPTH via the canonical `cause` key.
    let deep: Record<string, unknown> = { message: 'leaf', secret: 'Confidential Target Corp' };
    for (let i = 0; i < 12; i++) deep = { message: `level-${i}`, cause: deep };
    const result = filterLogEntry({ level: 50, err: deep });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('[redacted-depth]');
    expect(serialized).not.toContain('Confidential Target Corp');
  });

  it('does not split surrogate pairs when truncating nested string fields', () => {
    const boundary = 'a'.repeat(8191);
    const entry = {
      level: 50,
      err: {
        message: `${boundary}😀tail`,
      },
    };

    const result = filterLogEntry(entry);
    const err = result.err as Record<string, unknown>;
    const message = String(err.message);
    const issues = collectSerdeStrictnessIssues(JSON.stringify(result));

    expect(issues.loneSurrogateEscapes).toHaveLength(0);
    expect(issues.rawLoneSurrogates).toHaveLength(0);
    expect(message).not.toContain('\uFFFD');
    expect(message.length).toBe(8191);
  });

  it('drops upstreamStatus when it is not a number (SAFE field guard)', () => {
    expect(filterLogEntry({ level: 50, upstreamStatus: 503 })).toMatchObject({ upstreamStatus: 503 });
    const bad = filterLogEntry({ level: 50, upstreamStatus: 'secret-string-value' });
    expect(bad).not.toHaveProperty('upstreamStatus');
    const badObj = filterLogEntry({ level: 50, upstreamStatus: { leak: 'Confidential Target Corp' } });
    expect(badObj).not.toHaveProperty('upstreamStatus');
  });

  it('round-trips an object-err NDJSON line without leaking content', () => {
    const ndjson = JSON.stringify({
      level: 50,
      time: '2026-05-21T14:25:25.824Z',
      pid: 1009,
      component: 'main',
      msg: '[CODEX-DIAG] Codex passthrough failed',
      err: {
        type: 'Error',
        message: 'upstream 401',
        code: 'AUTH',
        stack: 'Error\n    at /Users/realuser/secret-project/file.ts:1:1',
      },
    });
    const out = filterLogEntries(ndjson);
    expect(out).not.toContain('[object Object]');
    expect(out).not.toContain('secret-project');
    expect(out).not.toContain('realuser');
    const parsed = JSON.parse(out);
    expect((parsed.err as Record<string, unknown>).message).toBe('upstream 401');
    expect((parsed.err as Record<string, unknown>).code).toBe('AUTH');
  });

  it('sanitizes the hand-extracted errorMessage / errorStack siblings', () => {
    const entry = {
      level: 50,
      errorMessage: 'failed opening ~/Documents/private-merger-notes.txt',
      errorStack: 'Error\n    at /Users/realuser/app/x.ts:2:2',
    };
    const result = filterLogEntry(entry);
    expect(result).toHaveProperty('errorMessage');
    expect(result).toHaveProperty('errorStack');
    expect(String(result.errorMessage)).toContain('[path-redacted]');
    expect(String(result.errorMessage)).not.toContain('private-merger-notes');
    expect(String(result.errorStack)).not.toContain('realuser');
  });

  it('handles entries with no matching fields', () => {
    const entry = {
      unknownField1: 'secret data',
      unknownField2: 'more secrets',
    };
    const result = filterLogEntry(entry);
    expect(Object.keys(result)).toHaveLength(0);
  });
});

// =============================================================================
// filterLogEntries (NDJSON)
// =============================================================================

describe('filterLogEntries', () => {
  it('processes multi-line NDJSON correctly', () => {
    const ndjson = [
      JSON.stringify({ level: 30, time: '2026-03-24T10:00:00Z', msg: 'ok', service: 'test', filePath: '/secret' }),
      JSON.stringify({ level: 50, time: '2026-03-24T10:01:00Z', msg: 'error', preview: 'user content' }),
      '', // empty line
      JSON.stringify({ level: 30, time: '2026-03-24T10:02:00Z', msg: 'done', args: { secret: true } }),
    ].join('\n');

    const result = filterLogEntries(ndjson);
    const lines = result.split('\n');

    expect(lines).toHaveLength(3);

    const parsed0 = JSON.parse(lines[0]);
    expect(parsed0.service).toBe('test');
    expect(parsed0).not.toHaveProperty('filePath');

    const parsed1 = JSON.parse(lines[1]);
    expect(parsed1).not.toHaveProperty('preview');

    const parsed2 = JSON.parse(lines[2]);
    expect(parsed2).not.toHaveProperty('args');
  });

  it('skips non-JSON lines gracefully', () => {
    const ndjson = [
      'This is not JSON',
      JSON.stringify({ level: 30, time: 'now', msg: 'ok' }),
      '--- separator ---',
    ].join('\n');

    const result = filterLogEntries(ndjson);
    const lines = result.split('\n');
    expect(lines).toHaveLength(1);
  });

  it('handles empty input', () => {
    expect(filterLogEntries('')).toBe('');
    expect(filterLogEntries('\n\n')).toBe('');
  });

  it('produces valid NDJSON output', () => {
    const ndjson = JSON.stringify({ level: 30, msg: 'test', service: 'svc' });
    const result = filterLogEntries(ndjson);
    // Should be parseable
    expect(() => JSON.parse(result)).not.toThrow();
  });
});

// =============================================================================
// extractAnonymizedSessionMeta
// =============================================================================

describe('extractAnonymizedSessionMeta', () => {
  const baseSession = {
    id: 'session-uuid-123',
    createdAt: 1711200000000,
    updatedAt: 1711286400000,
    messages: [
      { id: 'm1', role: 'user', text: 'Secret question' },
      { id: 'm2', role: 'assistant', text: 'Secret answer' },
      { id: 'm3', role: 'user', text: 'Follow up' },
    ],
    eventsByTurn: {
      'turn-1': [
        { type: 'usage', costUsd: 0.005 },
        { type: 'tool_result', error: undefined },
      ],
      'turn-2': [
        { type: 'error' },
        { type: 'tool_error' },
        { type: 'usage', costUsd: 0.003 },
      ],
    },
    origin: 'manual' as const,
  };

  it('returns correct aggregate stats', () => {
    const meta = extractAnonymizedSessionMeta(baseSession);
    expect(meta.id).toBe('session-uuid-123');
    expect(meta.turnCount).toBe(2);
    expect(meta.totalMessageCount).toBe(3);
    expect(meta.errorEventCount).toBe(1);
    expect(meta.toolFailureCount).toBe(1);
    expect(meta.costUsd).toBeCloseTo(0.008);
    expect(meta.createdAt).toBe(1711200000000);
    expect(meta.updatedAt).toBe(1711286400000);
    expect(meta.origin).toBe('manual');
  });

  it('NEVER includes title in the output', () => {
    const sessionWithTitle = {
      ...baseSession,
      title: 'My Secret Strategy Meeting Notes',
    };
    const meta = extractAnonymizedSessionMeta(sessionWithTitle);
    const jsonStr = JSON.stringify(meta);
    expect(jsonStr).not.toContain('Secret Strategy');
    expect(jsonStr).not.toContain('title');
  });

  it('NEVER includes message content', () => {
    const meta = extractAnonymizedSessionMeta(baseSession);
    const jsonStr = JSON.stringify(meta);
    expect(jsonStr).not.toContain('Secret question');
    expect(jsonStr).not.toContain('Secret answer');
    expect(jsonStr).not.toContain('Follow up');
  });

  it('handles sessions with no events', () => {
    const emptySession = {
      id: 'empty-session',
      createdAt: 1711200000000,
      updatedAt: 1711200000000,
      messages: [],
      eventsByTurn: {},
    };
    const meta = extractAnonymizedSessionMeta(emptySession);
    expect(meta.turnCount).toBe(0);
    expect(meta.totalMessageCount).toBe(0);
    expect(meta.errorEventCount).toBe(0);
    expect(meta.toolFailureCount).toBe(0);
    expect(meta.costUsd).toBeUndefined();
    expect(meta.origin).toBe('manual');
  });

  it('handles sessions with missing optional fields', () => {
    const minimalSession = {
      id: 'minimal-session',
      createdAt: 1711200000000,
      updatedAt: 1711200000000,
    };
    const meta = extractAnonymizedSessionMeta(minimalSession);
    expect(meta.turnCount).toBe(0);
    expect(meta.totalMessageCount).toBe(0);
    expect(meta.costUsd).toBeUndefined();
  });

  it('counts tool_result with error as a tool failure', () => {
    const session = {
      id: 'tool-err-session',
      createdAt: 1711200000000,
      updatedAt: 1711200000000,
      eventsByTurn: {
        'turn-1': [
          { type: 'tool_result', error: { message: 'some error' } },
          { type: 'tool_result', error: undefined },
          { type: 'tool_result' },
        ],
      },
    };
    const meta = extractAnonymizedSessionMeta(session);
    // Only the first tool_result has a truthy error
    expect(meta.toolFailureCount).toBe(1);
  });

  it('returns costUsd as undefined when total is zero', () => {
    const session = {
      id: 'no-cost-session',
      createdAt: 1711200000000,
      updatedAt: 1711200000000,
      eventsByTurn: {
        'turn-1': [{ type: 'text' }],
      },
    };
    const meta = extractAnonymizedSessionMeta(session);
    expect(meta.costUsd).toBeUndefined();
  });

  it('includes real-world-like dangerous content in session and confirms it does not leak', () => {
    const dangerousSession = {
      id: 'dangerous-session',
      title: 'Quarterly Board Meeting Prep - Confidential',
      createdAt: 1711200000000,
      updatedAt: 1711200000000,
      messages: [
        { id: 'm1', role: 'user', text: 'Summarize the Q4 financial report at ~/Documents/Finance/Q4-2026.xlsx' },
        { id: 'm2', role: 'assistant', text: 'The Q4 report shows revenue of $12.5M with 15% growth...' },
      ],
      eventsByTurn: {
        'turn-1': [
          { type: 'usage', costUsd: 0.01 },
        ],
      },
      origin: 'automation' as const,
    };
    const meta = extractAnonymizedSessionMeta(dangerousSession);
    const jsonStr = JSON.stringify(meta);

    // Should contain safe fields
    expect(meta.id).toBe('dangerous-session');
    expect(meta.totalMessageCount).toBe(2);
    expect(meta.origin).toBe('automation');

    // Should NOT contain any content
    expect(jsonStr).not.toContain('Board Meeting');
    expect(jsonStr).not.toContain('Confidential');
    expect(jsonStr).not.toContain('financial report');
    expect(jsonStr).not.toContain('Q4-2026');
    expect(jsonStr).not.toContain('revenue');
    expect(jsonStr).not.toContain('Documents');
  });
});

// =============================================================================
// redactLogBreadcrumbData (MF-2) — log breadcrumbs use the deny-by-default allowlist
// =============================================================================

describe('redactLogBreadcrumbData', () => {
  it('keeps operational fields, drops content under benign keys', () => {
    const data = {
      service: 'agent',
      code: 'E_FOO',
      durationMs: 1234,
      // content-bearing keys that pattern redaction would have let through:
      title: 'Project Zephyr — Q3 acquisition memo',
      query: 'acquire TargetCo Industries',
      filename: 'merger-notes.txt',
      projectName: 'Confidential Target Corp',
    };
    const out = redactLogBreadcrumbData(data);
    expect(out).toMatchObject({ service: 'agent', code: 'E_FOO', durationMs: 1234 });
    expect(out).not.toHaveProperty('title');
    expect(out).not.toHaveProperty('query');
    expect(out).not.toHaveProperty('filename');
    expect(out).not.toHaveProperty('projectName');
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('Project Zephyr');
    expect(serialized).not.toContain('TargetCo Industries');
    expect(serialized).not.toContain('Confidential Target Corp');
    expect(serialized).not.toContain('merger-notes');
  });

  it('sanitizes the err object on a breadcrumb (no [object Object], path scrubbed)', () => {
    const out = redactLogBreadcrumbData({
      service: 'fs',
      err: { type: 'Error', message: 'ENOENT', code: 'ENOENT', stack: 'at /Users/ada/secret/x.ts:1:1' },
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('[object Object]');
    expect(serialized).not.toContain('/Users/ada');
    expect((out.err as Record<string, unknown>).code).toBe('ENOENT');
  });
});
