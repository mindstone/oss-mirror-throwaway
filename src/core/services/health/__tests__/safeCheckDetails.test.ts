import { describe, expect, it } from 'vitest';
import {
  API_COOLDOWN_SCOPES,
  defineSafeCheckDetails,
  extractMsvcRuntimeDetailsForSentry,
  safeClosedSet,
  safeKeyedCounts,
  scrubbedTelemetryText,
  type SafeTelemetryText,
} from '../safeCheckDetails';

describe('safe health-check detail constructors', () => {
  it('scrubs email, encoded email, connector slug, and user-home path shapes in text', () => {
    const safe = scrubbedTelemetryText(
      'failed for alice@example.com and bob%40example.com in C:\\Users\\Alice\\AppData\\Local\\Rebel GoogleWorkspace-alice-example-com',
    );

    expect(safe).not.toContain('alice@example.com');
    expect(safe).not.toContain('bob%40example.com');
    expect(safe).not.toContain('C:\\Users\\Alice');
    expect(safe).not.toContain('GoogleWorkspace-alice-example-com');
    expect(safe).toContain('[email]');
    expect(safe).toContain('GoogleWorkspace-[account]');
  });

  it('brands closed-set text and keyed counts without altering JSON-visible values', () => {
    const scope = safeClosedSet(API_COOLDOWN_SCOPES, 'api', 'api');
    const counts = safeKeyedCounts({ 'GoogleWorkspace-alice-example-com': 2 });

    expect(scope).toBe('api');
    expect(counts).toEqual({ 'GoogleWorkspace-alice-example-com': 2 });
  });

  it('scrubs MSVC runtime details before they are attached to Sentry extras', () => {
    const safe = extractMsvcRuntimeDetailsForSentry({
      exeDir: 'C:\\Users\\Alice\\AppData\\Local\\Programs\\Rebel',
      nodeBundleDir: '/Users/alice/Library/Application Support/Rebel/node-bundle',
      missingExe: ['vcruntime140.dll'],
      missingNodeBundle: ['api-ms-win-crt-runtime-l1-1-0.dll'],
      rawUnexpected: 'alice@example.com',
    });

    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain('Alice');
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('alice@example.com');
    expect(safe).toEqual({
      exeDir: '~\\AppData\\Local\\Programs\\Rebel',
      nodeBundleDir: '~/Library/Application Support/Rebel/node-bundle',
      missingExe: ['vcruntime140.dll'],
      missingNodeBundle: ['api-ms-win-crt-runtime-l1-1-0.dll'],
    });
  });

  it('keeps raw strings and raw keyed records out of typed producer details at compile time', () => {
    if (false) {
      defineSafeCheckDetails('apiCooldownHealth', {
        // @ts-expect-error raw strings must be classified before entering allowlisted detail fields
        scope: 'api',
        remainingMs: 1,
      });

      defineSafeCheckDetails('toolIndexHealth', {
        // @ts-expect-error raw keyed records must be classified before entering allowlisted detail fields
        byServer: { 'GoogleWorkspace-alice-example-com': 1 },
      });

      const raw: string = '2026-06-12T00:00:00.000Z';
      defineSafeCheckDetails('toolIndexHealth', {
        // @ts-expect-error timestamp strings must be scrubbed/classified first
        lastRefreshAt: raw,
      });

      const classified: SafeTelemetryText = scrubbedTelemetryText(raw);
      defineSafeCheckDetails('toolIndexHealth', {
        lastRefreshAt: classified,
      });
    }

    expect(true).toBe(true);
  });
});
