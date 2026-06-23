import { describe, it, expect } from 'vitest';
import { redactSensitiveData } from '../redaction';

describe('diagnostics redaction wrapper', () => {
  it('redacts API keys with the canonical single-pass redactor', () => {
    expect(redactSensitiveData(`token sk-ant-${'a'.repeat(40)}`)).toContain('REDACTED');
  });
  it('redacts bearer tokens', () => {
    expect(redactSensitiveData(`Bearer ${'a'.repeat(40)}`)).toContain('Bearer ***REDACTED***');
  });
  it('normalizes user home paths', () => {
    expect(redactSensitiveData('/Users/alice/project')).toContain('~');
  });
});
