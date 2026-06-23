/**
 * Noise pattern detection tests — mirrors the categories enumerated in
 * docs/project/SENTRY_TRIAGE.md § Project-Specific Noise Categories. When
 * SENTRY_TRIAGE.md grows new noise categories, add the corresponding entry
 * here so the production trigger list stays anchored to the doc.
 */

import { describe, expect, it } from 'vitest';

import { matchesNoiseTitle } from '../noisePatterns.ts';

describe('matchesNoiseTitle', () => {
  it('matches Chromium native crashes', () => {
    expect(matchesNoiseTitle('partition_alloc::internal::OnNoMemoryInternal()')).toEqual({
      match: true,
      category: 'chromium_native',
    });
    expect(matchesNoiseTitle('SIGABRT in __pthread_kill')).toEqual({
      match: true,
      category: 'chromium_native',
    });
    expect(matchesNoiseTitle('logging::LogMessage::HandleFatal at line 123')).toEqual({
      match: true,
      category: 'chromium_native',
    });
  });

  it('matches macOS system crashes', () => {
    expect(matchesNoiseTitle('-[NSApplication _crashOnException:] uncaught')).toEqual({
      match: true,
      category: 'macos_system',
    });
    expect(matchesNoiseTitle('-[AVCaptureDALDevice initWithDeviceUID:]')).toEqual({
      match: true,
      category: 'macos_system',
    });
  });

  it('matches user environment errors', () => {
    expect(matchesNoiseTitle('Error: ENOSPC: no space left on device')).toEqual({
      match: true,
      category: 'user_environment',
    });
    expect(matchesNoiseTitle('Permission denied (EACCES) when writing settings')).toEqual({
      match: true,
      category: 'user_environment',
    });
  });

  it('matches network failure errno strings', () => {
    expect(matchesNoiseTitle('getaddrinfo ENOTFOUND api.example.com')).toEqual({
      match: true,
      category: 'network_failure',
    });
    expect(matchesNoiseTitle('connect ENETUNREACH 10.0.0.5:443')).toEqual({
      match: true,
      category: 'network_failure',
    });
    expect(matchesNoiseTitle('Request ETIMEDOUT after 30s')).toEqual({
      match: true,
      category: 'network_failure',
    });
  });

  it('matches Squirrel updater quirks', () => {
    expect(matchesNoiseTitle('Squirrel: Command failed: 4294967295')).toEqual({
      match: true,
      category: 'squirrel_updater',
    });
  });

  it('returns no match for ordinary error titles', () => {
    expect(matchesNoiseTitle('TypeError: cannot read property of undefined')).toEqual({
      match: false,
    });
    expect(matchesNoiseTitle('AgentSessionError: invalid_request_error: prompt too long')).toEqual({
      match: false,
    });
    expect(matchesNoiseTitle('')).toEqual({ match: false });
  });

  it('is case-sensitive for symbol names', () => {
    // Sentry preserves casing for native symbols — lowercased input shouldn't
    // match. Keeps ordinary string literals from being miscategorised when
    // they happen to share a noisy-looking lowercase prefix.
    expect(matchesNoiseTitle('partition_alloc::internal::onnomemoryinternal()')).toEqual({
      match: false,
    });
  });
});
