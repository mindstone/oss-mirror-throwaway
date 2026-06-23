import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyContributionPath } from '../contributionPathClassifier';

describe('classifyContributionPath', () => {
  beforeEach(() => {
    vi.stubEnv('HOME', '/Users/harry');
    vi.stubEnv('USERPROFILE', 'C:\\Users\\harry');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('classifies ~/mcp-servers/foo-mcp/ as canonical', () => {
    expect(classifyContributionPath('~/mcp-servers/foo-mcp/')).toBe('canonical');
  });

  it('classifies /Users/you/mcp-servers/foo-mcp/dist as canonical', () => {
    expect(classifyContributionPath('/Users/you/mcp-servers/foo-mcp/dist')).toBe('canonical');
  });

  it('classifies ~/mcp-servers/connectors/foo/ as connectors-repo (nested wins)', () => {
    expect(classifyContributionPath('~/mcp-servers/connectors/foo/')).toBe('connectors-repo');
  });

  it('classifies fork connectors path as connectors-repo', () => {
    expect(
      classifyContributionPath('/Users/you/development/mcp-servers-fork/connectors/humaans/'),
    ).toBe('connectors-repo');
  });

  it('classifies fibonacci path as non-canonical', () => {
    expect(
      classifyContributionPath('/Users/you/Documents/Rebel/Chief-of-Staff/scripts/fibonacci-mcp/'),
    ).toBe('non-canonical');
  });

  it('classifies /tmp/mcp-servers/foo as non-canonical', () => {
    expect(classifyContributionPath('/tmp/mcp-servers/foo')).toBe('non-canonical');
  });

  it('classifies /opt/mcp-servers/foo as non-canonical', () => {
    expect(classifyContributionPath('/opt/mcp-servers/foo')).toBe('non-canonical');
  });

  it('classifies ~/work/mcp-servers/foo as non-canonical', () => {
    expect(classifyContributionPath('~/work/mcp-servers/foo')).toBe('non-canonical');
  });

  it('classifies null/undefined/empty as unknown', () => {
    expect(classifyContributionPath(null)).toBe('unknown');
    expect(classifyContributionPath(undefined)).toBe('unknown');
    expect(classifyContributionPath('')).toBe('unknown');
  });

  it('classifies relative mcp-servers/foo path as unknown', () => {
    expect(classifyContributionPath('mcp-servers/foo')).toBe('unknown');
  });

  it('classifies relative ./foo/server.js path as unknown', () => {
    expect(classifyContributionPath('./foo/server.js')).toBe('unknown');
  });

  it('classifies windows C:\\Users\\harry\\mcp-servers\\foo as canonical when USERPROFILE is active', () => {
    vi.stubEnv('HOME', 'C:\\Users\\harry');
    vi.stubEnv('USERPROFILE', 'C:\\Users\\harry');
    expect(classifyContributionPath('C:\\Users\\harry\\mcp-servers\\foo')).toBe('canonical');
  });

  it('prefers false-negative when home is unavailable: absolute mcp-servers path is non-canonical', () => {
    vi.stubEnv('HOME', '');
    vi.stubEnv('USERPROFILE', '');
    expect(classifyContributionPath('/Users/you/mcp-servers/foo')).toBe('non-canonical');
  });
});
