import { describe, it, expect } from 'vitest';
import {
  redactAndTruncateRawError,
  RAW_ERROR_TRUNCATE_BYTES,
  RAW_ERROR_REDACTION_PATTERNS,
} from '../redactRawError';

/**
 * Tests for the redactor that strips secrets and truncates raw upstream error
 * bodies before they land on `AgentEvent.error.rawError`. Added in S2 of
 * docs/plans/260429_eval_reliability_judge_panel.md.
 */

describe('redactAndTruncateRawError', () => {
  it('returns undefined for empty input', () => {
    expect(redactAndTruncateRawError(undefined)).toBeUndefined();
    expect(redactAndTruncateRawError('')).toBeUndefined();
  });

  it('redacts Authorization header values', () => {
    const out = redactAndTruncateRawError('Authorization: sk-secret-token-1234567890\n400 bad request');
    expect(out).toContain('Authorization: ***REDACTED***');
    expect(out).not.toContain('sk-secret-token-1234567890');
  });

  it('redacts bare Bearer tokens', () => {
    const out = redactAndTruncateRawError('Failed: Bearer abc.def-123_xyz');
    expect(out).toContain('Bearer ***REDACTED***');
    expect(out).not.toContain('abc.def-123_xyz');
  });

  it('redacts Google API keys (AIzaSy...)', () => {
    const realLookalike = 'AIzaSyDH9ABCD12345EFGHIJ67890KLMNOPQRSTUVWX'; // 39+ chars
    const body = `Request to https://generativelanguage.googleapis.com/v1beta/openai/chat/completions failed with key=${realLookalike}`;
    const out = redactAndTruncateRawError(body);
    expect(out).toContain('AIza***REDACTED***');
    expect(out).not.toContain(realLookalike);
  });

  it('redacts JWT-shaped tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = redactAndTruncateRawError(`Authorization rejected: ${jwt}`);
    expect(out).toContain('eyJ***REDACTED***');
    expect(out).not.toContain(jwt);
  });

  it('redacts api_key= bare form', () => {
    const out = redactAndTruncateRawError('config error: api_key=somethingsecret123');
    expect(out).toContain('api_key=***REDACTED***');
    expect(out).not.toContain('somethingsecret123');
  });

  it('layers shared redactSensitiveData (sk- tokens, etc)', () => {
    const out = redactAndTruncateRawError('OpenAI key sk-1234567890abcdef1234567890abcdef rejected');
    expect(out).not.toContain('sk-1234567890abcdef1234567890abcdef');
  });

  it('passes through non-sensitive text untouched', () => {
    const body = 'Cohere returned: messages.0: content cannot be empty';
    expect(redactAndTruncateRawError(body)).toBe(body);
  });

  it('truncates oversized bodies with the marker', () => {
    const body = 'A'.repeat(RAW_ERROR_TRUNCATE_BYTES + 500);
    const out = redactAndTruncateRawError(body);
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThan(body.length);
    expect(out).toContain('[truncated; original length=');
    expect(out!.startsWith('A'.repeat(100))).toBe(true);
  });

  it('does not truncate bodies under the limit', () => {
    const body = 'small body';
    expect(redactAndTruncateRawError(body)).toBe(body);
  });

  it('Authorization pattern wins over bare-Bearer (more specific first)', () => {
    const out = redactAndTruncateRawError('Authorization: Bearer abc123');
    // The Authorization pattern matches "Authorization: Bearer abc123" entirely;
    // the redacted output should not still contain "Bearer abc123" as plaintext.
    expect(out).toContain('Authorization: ***REDACTED***');
    expect(out).not.toContain('Bearer abc123');
  });

  it('exposes the patterns array for callers that want to inspect them', () => {
    expect(RAW_ERROR_REDACTION_PATTERNS.length).toBeGreaterThan(0);
    for (const { pattern, replacement } of RAW_ERROR_REDACTION_PATTERNS) {
      expect(pattern).toBeInstanceOf(RegExp);
      expect(typeof replacement).toBe('string');
      expect(replacement).toContain('***REDACTED***');
    }
  });
});
