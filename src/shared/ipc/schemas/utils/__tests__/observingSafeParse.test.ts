import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { observingSafeParse } from '../observingSafeParse';

const TestSchema = z.object({
  id: z.string(),
  count: z.number(),
  tag: z.string().optional(),
});

function createMockLogger() {
  return { warn: vi.fn() };
}

describe('observingSafeParse', () => {
  it('returns ok=true and parsed data when the payload matches the schema', () => {
    const log = createMockLogger();
    const result = observingSafeParse({
      schema: TestSchema,
      payload: { id: 'abc', count: 7, tag: 'x' },
      channel: 'test:channel',
      log,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ id: 'abc', count: 7, tag: 'x' });
      expect(result.mode).toBe('observe');
    }
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('returns ok=false and logs structured warning when the payload mismatches', () => {
    const log = createMockLogger();
    const result = observingSafeParse({
      schema: TestSchema,
      payload: { id: 42, count: 'not a number' },
      channel: 'test:channel',
      log,
    });
    expect(result.ok).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const call = log.warn.mock.calls[0];
    const logObject = call[0] as Record<string, unknown>;
    const logMessage = call[1] as string;
    expect(logObject.channel).toBe('test:channel');
    expect(logObject.mode).toBe('observe');
    expect(logObject.issueCount).toBeGreaterThan(0);
    expect(Array.isArray(logObject.issues)).toBe(true);
    expect(logMessage).toContain('observed');
  });

  it('respects mode=enforce in the log message and return value', () => {
    const log = createMockLogger();
    const result = observingSafeParse({
      schema: TestSchema,
      payload: { id: 1 },
      channel: 'test:channel',
      mode: 'enforce',
      log,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mode).toBe('enforce');
    }
    const logMessage = log.warn.mock.calls[0][1] as string;
    expect(logMessage).toContain('rejected');
  });

  it('truncates issues to MAX_ISSUES_LOGGED (5) for the log payload', () => {
    const log = createMockLogger();
    const ManyFieldsSchema = z.object({
      a: z.string(),
      b: z.string(),
      c: z.string(),
      d: z.string(),
      e: z.string(),
      f: z.string(),
      g: z.string(),
    });
    observingSafeParse({
      schema: ManyFieldsSchema,
      payload: {},
      channel: 'test:channel',
      log,
    });
    const logObject = log.warn.mock.calls[0][0] as Record<string, unknown>;
    expect(Array.isArray(logObject.issues)).toBe(true);
    expect((logObject.issues as unknown[]).length).toBeLessThanOrEqual(5);
    expect(logObject.issueCount).toBe(7);
  });

  it('formats issue paths as dotted strings with (root) fallback', () => {
    const log = createMockLogger();
    const NestedSchema = z.object({
      session: z.object({
        id: z.string(),
      }),
    });
    observingSafeParse({
      schema: NestedSchema,
      payload: { session: { id: 123 } },
      channel: 'test:channel',
      log,
    });
    const issues = (log.warn.mock.calls[0][0] as { issues: Array<{ path: string }> }).issues;
    expect(issues[0].path).toBe('session.id');
  });

  it('does NOT include the raw `received` value in the log (redaction)', () => {
    const log = createMockLogger();
    observingSafeParse({
      schema: TestSchema,
      payload: { id: 'leaked-pii-here', count: 'not a number' },
      channel: 'test:channel',
      log,
    });
    const logObject = log.warn.mock.calls[0][0] as Record<string, unknown>;
    const serialized = JSON.stringify(logObject);
    expect(serialized).not.toContain('leaked-pii-here');
  });

  it('does NOT include the raw `received` value via issue.message for enum mismatches (PII guard)', () => {
    const log = createMockLogger();
    const EnumSchema = z.object({
      role: z.enum(['user', 'assistant', 'system']),
    });
    observingSafeParse({
      schema: EnumSchema,
      payload: { role: 'leaked-pii-via-enum-message' },
      channel: 'test:channel',
      log,
    });
    const logObject = log.warn.mock.calls[0][0] as Record<string, unknown>;
    const serialized = JSON.stringify(logObject);
    expect(serialized).not.toContain('leaked-pii-via-enum-message');
    const issues = (logObject.issues as Array<{ message: string; code: string }>);
    expect(issues.length).toBeGreaterThan(0);
    expect(['invalid_value', 'invalid_enum_value']).toContain(issues[0].code);
    expect(issues[0].message).not.toContain('leaked-pii-via-enum-message');
  });

  it('does NOT include the unrecognized key name via issue.message (PII guard)', () => {
    const log = createMockLogger();
    const StrictSchema = z.object({ id: z.string() }).strict();
    observingSafeParse({
      schema: StrictSchema,
      payload: { id: 'ok', leaked_pii_field_name: 'x' },
      channel: 'test:channel',
      log,
    });
    const logObject = log.warn.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(logObject)).not.toContain('leaked_pii_field_name');
  });

  it('does NOT include the raw `received` value via issue.message for literal mismatches (PII guard)', () => {
    const log = createMockLogger();
    const LiteralSchema = z.object({
      kind: z.literal('expected-value'),
    });
    observingSafeParse({
      schema: LiteralSchema,
      payload: { kind: 'leaked-pii-via-literal-message' },
      channel: 'test:channel',
      log,
    });
    const logObject = log.warn.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(logObject)).not.toContain('leaked-pii-via-literal-message');
  });

  it('substitutes a generic message for known issue codes', () => {
    const log = createMockLogger();
    observingSafeParse({
      schema: TestSchema,
      payload: { id: 42, count: 'not a number' },
      channel: 'test:channel',
      log,
    });
    const issues = (log.warn.mock.calls[0][0] as { issues: Array<{ code: string; message: string }> }).issues;
    const invalidType = issues.find((i) => i.code === 'invalid_type');
    expect(invalidType).toBeDefined();
    expect(invalidType?.message).toBe('value has the wrong type');
  });

  it('redacts user-controlled record keys from issue.path (PII guard)', () => {
    const log = createMockLogger();
    const RecordSchema = z.object({
      attachmentTexts: z.record(z.string(), z.string()),
    });
    observingSafeParse({
      schema: RecordSchema,
      payload: {
        attachmentTexts: {
          'sensitive-document.pdf': 42,
        },
      },
      channel: 'test:channel',
      log,
    });
    const logObject = log.warn.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(logObject)).not.toContain('sensitive-document.pdf');
    const issues = (logObject.issues as Array<{ path: string }>);
    expect(issues[0].path).toBe('attachmentTexts.<redacted-key>');
  });

  it('preserves numeric indices and schema field names in issue.path', () => {
    const log = createMockLogger();
    const NestedListSchema = z.object({
      messages: z.array(z.object({ id: z.string() })),
    });
    observingSafeParse({
      schema: NestedListSchema,
      payload: { messages: [{ id: 'ok' }, { id: 7 }] },
      channel: 'test:channel',
      log,
    });
    const issues = (log.warn.mock.calls[0][0] as { issues: Array<{ path: string }> }).issues;
    expect(issues[0].path).toBe('messages.1.id');
  });

  it('handles deeply-nested paths by truncating at MAX_PATH_DEPTH (6)', () => {
    const log = createMockLogger();
    const DeepSchema = z.object({
      a: z.object({
        b: z.object({
          c: z.object({
            d: z.object({
              e: z.object({
                f: z.object({
                  g: z.object({
                    h: z.string(),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    });
    observingSafeParse({
      schema: DeepSchema,
      payload: { a: { b: { c: { d: { e: { f: { g: { h: 999 } } } } } } } },
      channel: 'test:channel',
      log,
    });
    const path = (log.warn.mock.calls[0][0] as { issues: Array<{ path: string }> }).issues[0].path;
    expect(path).toContain('…');
  });
});
