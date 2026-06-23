import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';

/**
 * Tests for the OAuth timeout fix (FOX-2553).
 * 
 * Tests the auth-in-flight guard and timeout error message detection.
 * callSuperMcpAuthenticate is private, so we test the exported surface
 * (isOAuthAuthInFlight) and the timeout regex logic directly.
 */

// The timeout error regex used in callSuperMcpAuthenticate
const TIMEOUT_REGEX = /timed?\s*out|timeout/i;

describe('OAuth timeout error detection', () => {
  it('detects "Request timed out" from MCP SDK', () => {
    expect(TIMEOUT_REGEX.test('Request timed out')).toBe(true);
  });

  it('detects "timeout" standalone', () => {
    expect(TIMEOUT_REGEX.test('timeout')).toBe(true);
  });

  it('detects "timed out" with space', () => {
    expect(TIMEOUT_REGEX.test('Operation timed out after 330000ms')).toBe(true);
  });

  it('detects "Timeout" case-insensitive', () => {
    expect(TIMEOUT_REGEX.test('Connection Timeout')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(TIMEOUT_REGEX.test('Authentication failed')).toBe(false);
    expect(TIMEOUT_REGEX.test('Super-MCP is not running')).toBe(false);
    expect(TIMEOUT_REGEX.test('No response from authenticate')).toBe(false);
    expect(TIMEOUT_REGEX.test('OAuth error: access_denied')).toBe(false);
  });
});

describe('isOAuthAuthInFlight', () => {
  // We need to test the actual module export since the Set is module-scoped.
  // Use dynamic import to get the real function.
  let isOAuthAuthInFlight: () => boolean;

  beforeEach(async () => {
    // Reset modules to get fresh state
    vi.resetModules();

    // Re-initialize @core singletons cleared by vi.resetModules()
    await initTestPlatformConfig();

    // Mock all heavy dependencies that mcpService imports
    vi.doMock('@core/services/settingsStore', () => ({
      setSettingsStoreAdapter: vi.fn(),
      getSettings: vi.fn(() => ({ mcpConfigFile: null })),
      settingsStore: { store: {} },
    }));
    vi.doMock('../superMcpHttpManager', () => ({
      superMcpHttpManager: {
        getState: vi.fn(() => ({ isRunning: false, url: null, port: null })),
        isConfigured: vi.fn(() => false),
      },
      findAvailablePort: vi.fn(),
    }));
    vi.doMock('@core/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      createScopedLogger: vi.fn(() => ({
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      })),
    }));

    const mod = await import('../mcpService');
    isOAuthAuthInFlight = mod.isOAuthAuthInFlight;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false when no auth is in progress', () => {
    expect(isOAuthAuthInFlight()).toBe(false);
  });

  // The Set is only mutated by callSuperMcpAuthenticate (private),
  // so we verify the initial state is clean. The in-flight tracking
  // is exercised via integration testing (see local testing instructions below).
});
