import { describe, expect, it } from 'vitest';
import { isStructuredOutputSchemaRejection } from '../structuredOutputErrorClassification';

const makeRoutedError = (overrides: Record<string, unknown> = {}): Error => {
  const err = new Error(typeof overrides.message === 'string' ? (overrides.message as string) : 'boom') as Error & Record<string, unknown>;
  err.__agentErrorKind = 'invalid_request';
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'message') continue;
    err[key] = value;
  }
  return err;
};

describe('isStructuredOutputSchemaRejection', () => {
  describe('positive matches', () => {
    it('matches OpenAI strict response_format rejection', () => {
      const err = makeRoutedError({
        status: 400,
        __rawMessage:
          "Invalid schema for response_format 'rebel_plan': In context=(), 'oneOf' is not permitted.",
      });
      expect(isStructuredOutputSchemaRejection(err)).toBe(true);
    });

    it('matches Anthropic output_config.format rejection', () => {
      const err = makeRoutedError({
        status: 400,
        __rawMessage:
          'output_config.format.schema: Enum value "low" does not match declared type \'["string", "null"]\'',
      });
      expect(isStructuredOutputSchemaRejection(err)).toBe(true);
    });

    it('matches output_format keyword variants', () => {
      const err = makeRoutedError({
        status: 400,
        __rawMessage: 'output_format json_schema validation failed',
      });
      expect(isStructuredOutputSchemaRejection(err)).toBe(true);
    });

    it('accepts duck-typed errors without an instanceof relationship', () => {
      const ductTyped = {
        __agentErrorKind: 'invalid_request',
        __rawMessage: "response_format json_schema invalid",
        status: 400,
      };
      expect(isStructuredOutputSchemaRejection(ductTyped)).toBe(true);
    });

    it('passes when status is omitted (message-only fallback)', () => {
      const err = makeRoutedError({
        __rawMessage: "response_format schema rejected",
      });
      expect(isStructuredOutputSchemaRejection(err)).toBe(true);
    });

    it('falls back to .message when __rawMessage absent', () => {
      const err = makeRoutedError({
        status: 400,
        message:
          'API_ERROR_INTERCEPT: 400 Invalid schema for response_format',
      });
      // legacy sentinel still routes to invalid_request via getErrorKind
      expect(isStructuredOutputSchemaRejection(err)).toBe(true);
    });

    it('matches Anthropic constrained-decoding union-cap overflow (verbatim wording)', () => {
      const err = makeRoutedError({
        status: 400,
        __rawMessage:
          'Schemas contains too many parameters with union types (17 parameters with type arrays or anyOf). This causes exponential compilation cost. Reduce the number of nullable or union-typed parameters (limit: 16 parameters with unions).',
      });
      expect(isStructuredOutputSchemaRejection(err)).toBe(true);
    });

    it('matches the alternative "parameters with unions" phrasing (limit clause)', () => {
      const err = makeRoutedError({
        status: 400,
        __rawMessage:
          'Schema rejected: limit: 16 parameters with unions exceeded.',
      });
      expect(isStructuredOutputSchemaRejection(err)).toBe(true);
    });
  });

  describe('negative matches', () => {
    it('does not match MCP tool input_schema 400s (covered by isSchemaValidationError)', () => {
      const err = makeRoutedError({
        status: 400,
        __rawMessage: 'invalid_request_error: tools.0.input_schema: JSON schema is invalid',
      });
      expect(isStructuredOutputSchemaRejection(err)).toBe(false);
    });

    it('does not match unrelated invalid_request 400s', () => {
      const err = makeRoutedError({
        status: 400,
        __rawMessage: 'some other invalid_request error unrelated to schemas',
      });
      expect(isStructuredOutputSchemaRejection(err)).toBe(false);
    });

    it('does not match non-400 statuses', () => {
      const err = makeRoutedError({
        status: 500,
        __rawMessage: 'response_format json_schema parse error',
      });
      expect(isStructuredOutputSchemaRejection(err)).toBe(false);
    });

    it('does not match other error kinds (rate_limit)', () => {
      const err = new Error('429 rate limit') as Error & Record<string, unknown>;
      err.__agentErrorKind = 'rate_limit';
      err.status = 400;
      err.__rawMessage = 'response_format schema body too long';
      expect(isStructuredOutputSchemaRejection(err)).toBe(false);
    });

    it('does not match unknown errors with empty message', () => {
      const err = makeRoutedError({
        status: 400,
        __rawMessage: '',
      });
      expect(isStructuredOutputSchemaRejection(err)).toBe(false);
    });

    it('does not match surface keyword without schema marker', () => {
      const err = makeRoutedError({
        status: 400,
        __rawMessage: 'response_format value rejected by quota policy',
      });
      // 'response_format' present but no 'schema' / 'json_schema' marker
      expect(isStructuredOutputSchemaRejection(err)).toBe(false);
    });

    it('does not match schema marker without surface keyword', () => {
      const err = makeRoutedError({
        status: 400,
        __rawMessage: 'json_schema validation failed for tools.0.input_schema',
      });
      // input_schema is not in the surface set; matches MCP path instead
      expect(isStructuredOutputSchemaRejection(err)).toBe(false);
    });

    it('does not match "parameters with union" without a schema marker (paranoia probe)', () => {
      const err = makeRoutedError({
        status: 400,
        __rawMessage: 'parameters with union semantics rejected by quota policy',
      });
      // Has the new surface keyword but no schema/json_schema marker — must still fail #4.
      expect(isStructuredOutputSchemaRejection(err)).toBe(false);
    });

    it('returns false for non-error inputs', () => {
      expect(isStructuredOutputSchemaRejection(undefined)).toBe(false);
      expect(isStructuredOutputSchemaRejection(null)).toBe(false);
      expect(isStructuredOutputSchemaRejection('boom')).toBe(false);
      expect(isStructuredOutputSchemaRejection(42)).toBe(false);
    });
  });
});
