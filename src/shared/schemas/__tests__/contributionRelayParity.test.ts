/**
 * Contribution Relay v1 — Parity Test
 *
 * Parses the shared contract fixture at
 * `docs/contracts/fixtures/contribution-relay-sample.json` through
 * `RelaySubmitRequestSchema.parse` so any drift against the backend copy
 * (`fixtures/contribution-relay-sample.json` in rebel-platform) fails this
 * test rather than leaking into a live smoke run.
 *
 * @see docs/plans/260423_contribution_relay_frontend_handoff.md §6 Task 7
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ATTRIBUTION_NAME_MAX,
  RelaySubmitRequestSchema,
  validateAttributionName,
} from '../contributionRelay';

describe('contribution-relay-sample.json parity', () => {
  it('matches RelaySubmitRequestSchema exactly', () => {
    const fixturePath = path.resolve(
      __dirname,
      '../../../../docs/contracts/fixtures/contribution-relay-sample.json',
    );
    const raw = readFileSync(fixturePath, 'utf-8');
    const parsed = JSON.parse(raw);

    const result = RelaySubmitRequestSchema.safeParse(parsed);

    if (!result.success) {
      // Emit the issues verbatim so a regression makes the mismatch obvious.
      console.error(
        'Fixture failed to parse against RelaySubmitRequestSchema:',
        result.error.issues,
      );
    }

    expect(result.success).toBe(true);
  });
});

// Stage 6.1 M2 / m7 (260420 OSS MCP backend relay): the attributionName regex
// was tightened to match the backend byte-for-byte. Previously the desktop
// accepted apostrophes, commas, and parens that the backend would reject at
// submit time, giving users a confusing 400 after hitting "Share". These
// tests guard against silent drift in either direction — every disallowed
// character the backend rejects must also be rejected here, and every
// allowed character must continue to pass.

describe('attributionName schema — Stage 6.1 M2 character rules', () => {
  function makeRequest(attributionName: string) {
    return {
      clientContributionId: 'contrib-abc',
      connectorName: 'my-connector',
      attributionMode: 'rebel-name' as const,
      attributionName,
      prTitle: 'feat(connector): add my-connector',
      prBody: 'Adds my-connector.',
      files: [
        {
          path: 'connectors/my-connector/package.json',
          content: '{"name":"my-connector"}',
        },
      ],
    };
  }

  it.each([
    ["O'Brien", 'apostrophe'],
    ['Smith, Jr.', 'comma'],
    ['Alex (dev)', 'parens'],
    ['Alex<tag>', 'angle brackets'],
    ['Alex@handle', 'at sign'],
    ['Alex/Bob', 'slash'],
    ['Alex\\Bob', 'backslash'],
    ['Alex"quote"', 'double quote'],
    ['Alex\nChen', 'newline'],
    ['Alex\u0000Chen', 'null byte'],
  ])('rejects %j (%s)', (name, _label) => {
    const result = RelaySubmitRequestSchema.safeParse(makeRequest(name));
    expect(result.success).toBe(false);
  });

  it.each([
    ['Alex Chen', 'space'],
    ['Alex.Chen', 'dot'],
    ['Alex_Chen', 'underscore'],
    ['Alex-Chen', 'hyphen'],
    ['Ada L. Chen', 'space + dot'],
    ['陈志强', 'CJK'],
    ['Zöe', 'latin diacritic'],
    ['Ιωάννα', 'greek'],
    ['user42', 'digits'],
  ])('accepts %j (%s)', (name, _label) => {
    const result = RelaySubmitRequestSchema.safeParse(makeRequest(name));
    expect(result.success).toBe(true);
  });

  it('rejects a name that is only punctuation/whitespace (no letter or digit)', () => {
    const result = RelaySubmitRequestSchema.safeParse(makeRequest(' . _ - '));
    expect(result.success).toBe(false);
  });

  it('rejects a name longer than the cap', () => {
    const tooLong = 'a'.repeat(ATTRIBUTION_NAME_MAX + 1);
    const result = RelaySubmitRequestSchema.safeParse(makeRequest(tooLong));
    expect(result.success).toBe(false);
  });
});

describe('validateAttributionName (shared UI helper)', () => {
  it('returns null for empty input (callers decide whether empty is required)', () => {
    expect(validateAttributionName('')).toBeNull();
    expect(validateAttributionName('   ')).toBeNull();
  });

  it('returns null for valid names', () => {
    expect(validateAttributionName('Alex Chen')).toBeNull();
    expect(validateAttributionName('  Alex Chen  ')).toBeNull();
    expect(validateAttributionName('陈志强')).toBeNull();
    expect(validateAttributionName('Ada L. Chen')).toBeNull();
  });

  it('returns a length error when the name exceeds the cap', () => {
    const tooLong = 'a'.repeat(ATTRIBUTION_NAME_MAX + 1);
    expect(validateAttributionName(tooLong)).toMatch(/80 characters/);
  });

  it('returns a character error for disallowed punctuation', () => {
    expect(validateAttributionName("O'Brien")).toMatch(/apostrophes/);
    expect(validateAttributionName('Smith, Jr.')).toMatch(/commas/);
    expect(validateAttributionName('Alex (dev)')).toMatch(/parentheses/);
  });

  it('returns a letter-or-digit error when only punctuation is present', () => {
    expect(validateAttributionName(' . _ - ')).toMatch(/letter or digit/);
  });
});

// 260423 contribution-relay 400 fix (see
// `docs-private/investigations/260423_contribution_relay_400_validation.md`): desktop
// must pre-reject denylisted file paths so the user sees an actionable error
// locally rather than a generic backend 400 after the POST.

describe('ContributionFileSchema.path — sensitive-file denylist', () => {
  // The path refine is private to the module; reach it through the top-level
  // RelaySubmitRequestSchema so we exercise the real submit path.
  function requestWithFilePath(filePath: string) {
    return {
      clientContributionId: 'contrib-abc',
      connectorName: 'my-connector',
      attributionMode: 'rebel-name' as const,
      attributionName: 'Alex Chen',
      prTitle: 'feat(connector): add my-connector',
      prBody: 'Adds my-connector.',
      files: [
        {
          path: filePath,
          content: 'secret=value',
        },
      ],
    };
  }

  it('rejects connectors/<x>/.env.example (the original 260423 repro case)', () => {
    const result = RelaySubmitRequestSchema.safeParse(
      requestWithFilePath('connectors/my-connector/.env.example'),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const pathIssue = result.error.issues.find((issue) =>
        issue.path.join('.').endsWith('path'),
      );
      expect(pathIssue?.message).toBe('file path targets a denylisted extension');
    }
  });

  it.each([
    'connectors/my-connector/.env',
    'connectors/my-connector/.env.local',
    'connectors/my-connector/prod.env',
    'connectors/my-connector/src/.env.production',
    'connectors/my-connector/keys/server.key',
    'connectors/my-connector/certs/private.pem',
  ])('rejects %s', (filePath) => {
    const result = RelaySubmitRequestSchema.safeParse(requestWithFilePath(filePath));
    expect(result.success).toBe(false);
  });

  it('accepts the same connector with only a non-denylisted file', () => {
    const result = RelaySubmitRequestSchema.safeParse(
      requestWithFilePath('connectors/my-connector/package.json'),
    );
    expect(result.success).toBe(true);
  });
});

describe('RelaySubmitRequestSchema — full-payload denylist enforcement', () => {
  it('rejects a payload whose files[] includes a .env.example alongside valid files', () => {
    const payload = {
      clientContributionId: 'contrib-abc',
      connectorName: 'my-connector',
      attributionMode: 'anonymous' as const,
      prTitle: 'feat(connector): add my-connector',
      prBody: 'Adds my-connector.',
      files: [
        {
          path: 'connectors/my-connector/package.json',
          content: '{"name":"my-connector"}',
        },
        {
          path: 'connectors/my-connector/src/index.ts',
          content: 'export const x = 1;',
        },
        {
          path: 'connectors/my-connector/.env.example',
          content: 'API_KEY=replace-me',
        },
      ],
    };

    const result = RelaySubmitRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      const denylistIssue = result.error.issues.find(
        (issue) => issue.message === 'file path targets a denylisted extension',
      );
      expect(denylistIssue).toBeDefined();
      expect(denylistIssue?.path.join('.')).toBe('files.2.path');
    }
  });
});
