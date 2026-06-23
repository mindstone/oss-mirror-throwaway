import { describe, it, expect } from 'vitest';
import {
  analyzePrivacyPromptSync,
  extractPrivacyBullet,
  normalizePrivacyBullet,
  REQUIRED_PRIVACY_CATEGORIES,
} from '../check-botqa-transcript-privacy-prompt-sync';

const BULLET =
  '- Privacy guard: if the question concerns salary, compensation, performance reviews, medical or health information, personal contact details, confidential deals, or termination/firing, ALWAYS redirect privately. Do NOT repeat the topic, summarize what was said, or hint at the reason — even if it is in the transcript. Reply with just: "I\'d rather share that privately — talk with ${ownerName} after the meeting."';

const prodSource = (bullet: string) => `const prompt = \`Instructions:\n- Answer based ONLY on transcript\n${bullet}\`;`;
const evalSource = (bullet: string) => `return \`Instructions:\n- Answer based ONLY on transcript\n${bullet}\`;`;

describe('extractPrivacyBullet', () => {
  it('extracts the bullet up to the closing backtick', () => {
    const extracted = extractPrivacyBullet(prodSource(BULLET));
    expect(extracted).toContain('- Privacy guard:');
    expect(extracted).toContain('termination/firing');
    expect(extracted).not.toContain('`');
  });
  it('returns null when the bullet is absent', () => {
    expect(extractPrivacyBullet('const x = `no privacy here`;')).toBeNull();
  });
});

describe('normalizePrivacyBullet', () => {
  it('collapses ${ownerName} and whitespace', () => {
    const a = normalizePrivacyBullet('talk with ${ownerName}  after\n the meeting');
    expect(a).toBe('talk with <OWNER> after the meeting');
  });
});

describe('analyzePrivacyPromptSync', () => {
  it('PASSES when both bullets are identical modulo interpolation', () => {
    const result = analyzePrivacyPromptSync({
      productionSource: prodSource(BULLET),
      evalSource: evalSource(BULLET),
    });
    expect(result.exitCode).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('FAILS when the eval bullet drifts from production', () => {
    const drifted = BULLET.replace('ALWAYS redirect privately', 'ALWAYS redirect');
    const result = analyzePrivacyPromptSync({
      productionSource: prodSource(BULLET),
      evalSource: evalSource(drifted),
    });
    expect(result.exitCode).toBe(1);
    expect(result.errors.join('\n')).toMatch(/drift/i);
  });

  it('FAILS when production drops a required category', () => {
    const stripped = BULLET.replace('medical or health information, ', '');
    const result = analyzePrivacyPromptSync({
      productionSource: prodSource(stripped),
      evalSource: evalSource(stripped),
    });
    expect(result.exitCode).toBe(1);
    expect(result.errors.join('\n')).toMatch(/missing required category "medical"/);
  });

  it('FAILS when production is missing the bullet entirely', () => {
    const result = analyzePrivacyPromptSync({
      productionSource: 'const prompt = `Instructions: just answer`;',
      evalSource: evalSource(BULLET),
    });
    expect(result.exitCode).toBe(1);
    expect(result.errors.join('\n')).toMatch(/Production prompt.*missing/i);
  });

  it('covers all 6 required categories in the canonical bullet', () => {
    const norm = normalizePrivacyBullet(BULLET).toLowerCase();
    for (const cat of REQUIRED_PRIVACY_CATEGORIES) {
      expect(norm).toContain(cat);
    }
  });
});
