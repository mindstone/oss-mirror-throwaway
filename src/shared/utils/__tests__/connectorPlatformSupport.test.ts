import { describe, it, expect } from 'vitest';
import {
  isConnectorSupportedOnPlatform,
  platformSupportLabel,
} from '../connectorPlatformSupport';

describe('isConnectorSupportedOnPlatform', () => {
  it('treats undefined platforms as cross-platform', () => {
    expect(isConnectorSupportedOnPlatform(undefined, 'darwin')).toBe(true);
    expect(isConnectorSupportedOnPlatform(undefined, 'win32')).toBe(true);
    expect(isConnectorSupportedOnPlatform(undefined, 'linux')).toBe(true);
  });

  it('treats empty platforms as cross-platform', () => {
    expect(isConnectorSupportedOnPlatform([], 'darwin')).toBe(true);
  });

  it('returns true when current platform is in the list', () => {
    expect(isConnectorSupportedOnPlatform(['darwin'], 'darwin')).toBe(true);
    expect(isConnectorSupportedOnPlatform(['darwin', 'linux'], 'linux')).toBe(true);
  });

  it('returns false when current platform is not in the list', () => {
    expect(isConnectorSupportedOnPlatform(['darwin'], 'win32')).toBe(false);
    expect(isConnectorSupportedOnPlatform(['linux'], 'darwin')).toBe(false);
  });

  it('is permissive when current platform is unknown', () => {
    // We never hide connectors because of a missing signal — fail open.
    expect(isConnectorSupportedOnPlatform(['darwin'], null)).toBe(true);
    expect(isConnectorSupportedOnPlatform(['darwin'], undefined)).toBe(true);
  });
});

describe('platformSupportLabel', () => {
  it('returns null for cross-platform connectors', () => {
    expect(platformSupportLabel(undefined)).toBeNull();
    expect(platformSupportLabel([])).toBeNull();
  });

  it('returns a single-platform label when only one is supported', () => {
    expect(platformSupportLabel(['darwin'])).toBe('macOS only');
    expect(platformSupportLabel(['win32'])).toBe('Windows only');
    expect(platformSupportLabel(['linux'])).toBe('Linux only');
  });

  it('returns a multi-platform label for partial support', () => {
    expect(platformSupportLabel(['darwin', 'linux'])).toBe('macOS + Linux only');
    expect(platformSupportLabel(['win32', 'linux'])).toBe('Windows + Linux only');
  });
});
