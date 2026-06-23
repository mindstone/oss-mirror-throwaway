import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { runTruffleHogPublicAllowlistCheck } from '../check-trufflehog-public-allowlist';

function createTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

function writeFile(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
}

function yamlForEntries(entries: readonly Record<string, unknown>[]): string {
  const renderedEntries = entries.flatMap((entry) => [
    `  - ${Object.entries(entry).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n    ')}`,
  ]);
  return ['version: 1', 'allowlist:', ...renderedEntries, ''].join('\n');
}

function runEntries(entries: readonly Record<string, unknown>[]) {
  const root = createTempRoot('trufflehog-public-allowlist-');
  try {
    const allowlistPath = path.join(root, '.trufflehog-public-allowlist.yaml');
    writeFile(root, '.trufflehog-public-allowlist.yaml', yamlForEntries(entries));
    return runTruffleHogPublicAllowlistCheck({ repoRoot: root, allowlistPath });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Build forbidden-shaped fixtures at runtime so public-mirror scanners never see
// those literals in shipped test source.
const fakeStripeTestKey = ['sk', 'test', '51HxYzABCdef0123456789realish'].join('_');
const fakeStripeLiveKey = ['sk', 'live', '12345678901234567890'].join('_');
const fakeSlackPermalink = ['https://', 'mindstone', '.slack.com', '/archives/C123/p456'].join('');
const fakeLinearUrl = ['https://', 'linear.app/', 'mindstone', '/issue/FOX-123/leak'].join('');
const fakeSlackToken = ['xoxb', '123456789012', 'abcdefghijklmnop'].join('-');
const fakeAwsKey = 'AKIA' + '1234567890123456';

describe('check-trufflehog-public-allowlist', () => {
  test('passes role inbox, Stripe test key, and example.com public fixture entries', () => {
    const result = runEntries([
      { kind: 'corporate-inbox', pattern: 'security@mindstone.com', reason: 'Public security inbox.' },
      { kind: 'public-test-key', pattern: 'pk_test_', reason: 'Stripe test key prefix.' },
      { kind: 'public-fixture', pattern: 'alice@example.com', reason: 'RFC example address.' },
    ]);

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  test('fails a public-test-key entry that is a full key rather than the exact prefix', () => {
    const result = runEntries([
      { kind: 'public-test-key', pattern: fakeStripeTestKey, reason: 'Full (real-ish) test secret.' },
    ]);

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'public-test-key' }));
  });

  test('fails when a corporate-inbox entry uses an employee local-part', () => {
    const result = runEntries([
      { kind: 'corporate-inbox', pattern: '[Mindstone-email]', reason: 'Employee address.' },
    ]);

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'corporate-inbox' }));
    expect(result.findings[0]?.detail).toContain('not a recognised public role inbox');
  });

  test('fails when a corporate-inbox entry uses a non-corporate domain', () => {
    const result = runEntries([
      { kind: 'corporate-inbox', pattern: '[external-email]', reason: 'External address.' },
    ]);

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'corporate-inbox' }));
    expect(result.findings[0]?.detail).toContain('not in CORP_DOMAINS');
  });

  test('fails on unknown kind', () => {
    const result = runEntries([
      { kind: 'internal-url', pattern: 'security@mindstone.com', reason: 'Unknown kind.' },
    ]);

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'unknown-kind' }));
  });

  test('fails on missing kind', () => {
    const result = runEntries([
      { pattern: 'security@mindstone.com', reason: 'Missing kind.' },
    ]);

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'missing-kind' }));
  });

  test('fails on production token patterns even under a known kind', () => {
    const result = runEntries([
      { kind: 'public-test-key', pattern: fakeStripeLiveKey, reason: 'Production token.' },
    ]);

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'unsafe-pattern' }));
  });

  test('fails on internal Slack URLs', () => {
    const result = runEntries([
      { kind: 'public-fixture', pattern: fakeSlackPermalink, reason: 'Internal URL.' },
    ]);

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'unsafe-pattern' }));
  });

  test('fails on internal Linear URLs', () => {
    const result = runEntries([
      { kind: 'public-fixture', pattern: fakeLinearUrl, reason: 'Internal URL.' },
    ]);

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'unsafe-pattern' }));
  });

  test('fails on unsafe metadata strings, not only unsafe pattern strings', () => {
    const result = runEntries([
      { kind: 'public-fixture', pattern: 'example.com', reason: `See ${fakeLinearUrl}` },
    ]);

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'unsafe-pattern' }));
    expect(result.findings[0]?.detail).toContain('reason');
  });

  test('fails on Slack-shaped token patterns', () => {
    const result = runEntries([
      { kind: 'public-fixture', pattern: fakeSlackToken, reason: 'Slack-shaped token.' },
    ]);

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'unsafe-pattern' }));
  });

  test('fails on unrecognised public-test-key prefixes', () => {
    const result = runEntries([
      { kind: 'public-test-key', pattern: fakeAwsKey, reason: 'AWS-looking key.' },
    ]);

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'public-test-key' }));
  });

  test('fails on unrecognised public fixtures', () => {
    const result = runEntries([
      { kind: 'public-fixture', pattern: '[external-email]', reason: 'Not an approved fixture.' },
    ]);

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'public-fixture' }));
  });
});
