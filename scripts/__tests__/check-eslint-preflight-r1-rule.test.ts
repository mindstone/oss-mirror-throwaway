/**
 * Tests for the R1 phase-to-phase ESLint rule preflight (chunk S2-B1).
 *
 * Coverage strategy:
 *   - Pure detector tests (`evaluatePreflight`) — text in / missing-anchors out.
 *   - I/O wrapper tests (`runPreflight`) — both legitimate config paths
 *     and not-found paths.
 *   - Remediation message snapshot — the failure text must be stable so
 *     CI logs are readable.
 *   - Real-config integration — the actual `eslint.config.mjs` in the
 *     repo must currently pass; this is the canary that the rule is in
 *     place at HEAD.
 *
 * @see ../check-eslint-preflight-r1-rule.ts
 */

import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  REQUIRED_R1_ANCHORS,
  evaluatePreflight,
  resolveDefaultConfigPath,
  renderFailureMessage,
  runPreflight,
} from '../check-eslint-preflight-r1-rule';

// ============================================================================
//   evaluatePreflight (pure)
// ============================================================================

describe('evaluatePreflight (pure detector)', () => {
  it('returns empty array when both anchors are present', () => {
    const text = `
      message: 'R1 phase-to-phase import forbidden: phase modules ...'
      message: 'R1 cycle-prevention: queryOptionsBuilder ...'
    `;
    expect(evaluatePreflight(text)).toEqual([]);
  });

  it('reports the phase-to-phase anchor missing', () => {
    const text = `
      message: 'R1 cycle-prevention: queryOptionsBuilder ...'
    `;
    expect(evaluatePreflight(text)).toEqual([
      'R1 phase-to-phase import forbidden:',
    ]);
  });

  it('reports the cycle-prevention anchor missing', () => {
    const text = `
      message: 'R1 phase-to-phase import forbidden: phase modules ...'
    `;
    expect(evaluatePreflight(text)).toEqual(['R1 cycle-prevention:']);
  });

  it('reports both anchors missing on an unrelated config', () => {
    const text = "export default [{ rules: { 'no-unused-vars': 'error' } }]";
    expect(evaluatePreflight(text)).toEqual([
      'R1 phase-to-phase import forbidden:',
      'R1 cycle-prevention:',
    ]);
  });

  it('reports anchor missing if it has been rewrapped across a newline', () => {
    // Documenting a known limitation: the detector is plain substring
    // search, so an anchor that has been line-wrapped across a newline
    // would not be found. If R1 ever reformats the message strings
    // across multiple lines, this preflight needs an update to do
    // multi-line normalization. For now, the regression test pins the
    // behaviour explicitly.
    const text = "message: 'R1 phase-to-phase import\nforbidden: ...'";
    expect(evaluatePreflight(text)).toContain(
      'R1 phase-to-phase import forbidden:',
    );
  });
});

// ============================================================================
//   runPreflight (I/O wrapper)
// ============================================================================

describe('runPreflight (I/O wrapper)', () => {
  it('returns ok=true when a temp config has both anchors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'preflight-r1-'));
    const path = join(dir, 'eslint.config.mjs');
    writeFileSync(
      path,
      `
        // synthesized fixture
        export default [{
          rules: {
            '@typescript-eslint/no-restricted-imports': ['error', {
              patterns: [{
                group: ['./turnPipeline/*'],
                message: 'R1 phase-to-phase import forbidden: phase modules ...'
              }]
            }]
          }
        }, {
          rules: {
            '@typescript-eslint/no-restricted-imports': ['error', {
              patterns: [{
                group: ['./turnPipeline'],
                message: 'R1 cycle-prevention: queryOptionsBuilder ...'
              }]
            }]
          }
        }]
      `,
      'utf8',
    );
    try {
      const result = runPreflight(path);
      expect(result.ok).toBe(true);
      expect(result.missingAnchors).toEqual([]);
      expect(result.readError).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns ok=false when an anchor is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'preflight-r1-'));
    const path = join(dir, 'eslint.config.mjs');
    writeFileSync(
      path,
      "message: 'R1 phase-to-phase import forbidden: ...'",
      'utf8',
    );
    try {
      const result = runPreflight(path);
      expect(result.ok).toBe(false);
      expect(result.missingAnchors).toEqual(['R1 cycle-prevention:']);
      expect(result.readError).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the file does not exist', () => {
    const result = runPreflight('/tmp/this-file-definitely-does-not-exist-xyz123.mjs');
    expect(result.ok).toBe(false);
    expect(result.readError).toMatch(/not found/i);
    expect(result.missingAnchors).toEqual(REQUIRED_R1_ANCHORS);
  });
});

// ============================================================================
//   renderFailureMessage
// ============================================================================

describe('renderFailureMessage', () => {
  it('includes each missing anchor in the output', () => {
    const text = renderFailureMessage({
      ok: false,
      configPath: '/some/path',
      missingAnchors: ['R1 phase-to-phase import forbidden:'],
      readError: null,
    });
    expect(text).toContain('R1 phase-to-phase import forbidden:');
    expect(text).toContain('FAILED');
    expect(text).toContain('Remediation:');
  });

  it('includes the read error when present', () => {
    const text = renderFailureMessage({
      ok: false,
      configPath: '/some/path',
      missingAnchors: REQUIRED_R1_ANCHORS,
      readError: 'eslint.config.mjs not found at /some/path',
    });
    expect(text).toContain('not found');
  });
});

// ============================================================================
//   Real-config canary
// ============================================================================

describe('real eslint.config.mjs at HEAD', () => {
  it('contains both R1 anchors (canary against accidental removal)', () => {
    const result = runPreflight(resolveDefaultConfigPath());
    if (!result.ok) {
      // Surface the failure message inline to make CI log diagnosis easy.
      throw new Error(renderFailureMessage(result));
    }
    expect(result.ok).toBe(true);
  });
});
