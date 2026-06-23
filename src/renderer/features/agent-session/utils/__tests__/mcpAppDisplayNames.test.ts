import { describe, expect, it } from 'vitest';
import { resolveSourceDisplayName } from '../mcpAppDisplayNames';

describe('resolveSourceDisplayName', () => {
  it.each([
    ['GoogleWorkspace-jane-example-com'],
    ['google-workspace-jane-example-com'],
    ['GoogleWorkspace'],
  ])('resolves known Google Workspace catalog id %s', (packageId) => {
    expect(resolveSourceDisplayName(packageId)).toEqual({
      displayName: 'Google Workspace',
      sourceKind: 'known-external',
      isFallback: false,
    });
  });

  it.each([undefined, null, '', '   '])('resolves empty source %s to connected tool', (packageId) => {
    expect(resolveSourceDisplayName(packageId)).toEqual({
      displayName: 'connected tool',
      sourceKind: 'fallback',
      isFallback: true,
    });
  });

  it.each([
    ['rebel', 'Rebel'],
    ['rebel-canvas', 'Rebel Canvas'],
    ['rebel-shady', 'Rebel Shady'],
  ])('does not grant internal Rebel trust by prefix for %s', (packageId, expectedDisplayName) => {
    const resolved = resolveSourceDisplayName(packageId);
    expect(resolved).toEqual({
      displayName: expectedDisplayName,
      sourceKind: 'fallback',
      isFallback: true,
    });
    expect(resolved.displayName).not.toBe('Built into Rebel');
  });

  it('falls back to a short title-cased package family for unknown packages', () => {
    expect(resolveSourceDisplayName('unknown-foo-bar')).toEqual({
      displayName: 'Unknown Foo',
      sourceKind: 'fallback',
      isFallback: true,
    });
  });

  it.each([
    ['unknown-foo-bar-jane-example-com', 'Unknown Foo Bar', ['jane', 'example', 'com']],
    ['unknown-foo-bar-greg-example-co-uk', 'Unknown Foo Bar', ['greg', 'example', 'co', 'uk']],
    ['unknown-foo-bar-userid-2024', 'Unknown Foo Bar', ['userid', '2024']],
    ['unknown-foo-bar-uid-12345', 'Unknown Foo Bar', ['uid', '12345']],
    ['unknown-foo-bar-123-456', 'Unknown Foo Bar', ['123', '456']],
    ['unknown-foo-bar-2024', 'Unknown Foo Bar', ['2024']],
    ['acme-tool-550e8400-e29b-41d4-a716-446655440000', 'Acme Tool', ['550e8400', '446655440000']],
    ['acme-tool-user-c8f37e2c9aa0', 'Acme Tool', ['c8f37e2c9aa0']],
  ])('never renders full instance id for %s', (packageId, expected, disallowedFragments) => {
    const resolved = resolveSourceDisplayName(packageId);
    expect(resolved.displayName).toBe(expected);
    expect(resolved.sourceKind).toBe('fallback');
    for (const fragment of disallowedFragments) {
      expect(resolved.displayName.toLowerCase()).not.toContain(fragment.toLowerCase());
    }
  });

  it('under-discloses unknown long package ids when no suffix is recognized', () => {
    const resolved = resolveSourceDisplayName('unknown-foo-bar-private-installation-name');

    expect(resolved).toEqual({
      displayName: 'Unknown Foo',
      sourceKind: 'fallback',
      isFallback: true,
    });
    expect(resolved.displayName).not.toContain('Private');
    expect(resolved.displayName).not.toContain('Installation');
  });

  it.each([
    ['@google/workspace', 'Workspace'],
    ['@some-org/some-package-with-suffix', 'Some Package'],
  ])('strips npm scope from scoped package id %s', (packageId, expectedDisplayName) => {
    expect(resolveSourceDisplayName(packageId)).toEqual({
      displayName: expectedDisplayName,
      sourceKind: 'fallback',
      isFallback: true,
    });
  });
});
