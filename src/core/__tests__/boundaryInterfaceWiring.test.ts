/**
 * Boundary Interface Wiring Verification Tests
 *
 * Verifies that both production bootstraps (desktop Electron and cloud service)
 * call all required boundary interface setter functions. These are structural
 * tests that read the source files and check for the expected set*() calls.
 *
 * This catches integration_gap bugs where a new boundary interface is added
 * but one of the bootstraps forgets to initialize it.
 *
 * @see docs/plans/260406_test_suite_improvements.md (D.3)
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Required boundary interface setter calls that MUST appear in both bootstraps.
 * When adding a new boundary interface, add its setter here.
 */
const REQUIRED_BOUNDARY_SETTERS = [
  'setErrorReporter',
  'setStoreFactory',
  'setPushNotificationSinkFactory',
  'setTracker',
  'setBroadcastService',
  'setHandlerRegistry',
  'setSafetyEvaluationService',
  'setSettingsStoreAdapter',
] as const;

/**
 * setPlatformConfig is required but lives in different files per surface:
 * - Desktop: src/main/bootstrap.ts (runs before src/main/index.ts)
 * - Cloud: cloud-service/src/platformInit.ts (imported by server.ts before bootstrap)
 */
const PLATFORM_CONFIG_SETTER = 'setPlatformConfig';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '../../..');

function readSource(relativePath: string): string {
  const fullPath = path.join(ROOT, relativePath);
  return fs.readFileSync(fullPath, 'utf-8');
}

/** Check if a source file contains a function call (not just a comment or import). */
function containsSetterCall(source: string, setterName: string): boolean {
  // Match actual function calls: setterName( with optional whitespace
  // Exclude lines that are only imports or comments
  const lines = source.split('\n');
  return lines.some((line) => {
    const trimmed = line.trim();
    // Skip comments
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      return false;
    }
    // Skip import statements (they import the setter, but don't call it)
    if (trimmed.startsWith('import ')) {
      return false;
    }
    // Check for actual call: setterName(
    return new RegExp(`\\b${setterName}\\s*\\(`).test(trimmed);
  });
}

// ---------------------------------------------------------------------------
// Desktop bootstrap wiring (src/main/bootstrap.ts + src/main/index.ts)
// ---------------------------------------------------------------------------

describe('desktop bootstrap — boundary interface wiring', () => {
  // Desktop splits initialization across two files:
  // - bootstrap.ts: setPlatformConfig (must run first, before module evaluation)
  // - index.ts: all other boundary interface setters
  const bootstrapSource = readSource('src/main/bootstrap.ts');
  const indexSource = readSource('src/main/index.ts');
  const combinedDesktopSource = bootstrapSource + '\n' + indexSource;

  it('calls setPlatformConfig in bootstrap.ts', () => {
    expect(
      containsSetterCall(bootstrapSource, PLATFORM_CONFIG_SETTER),
      `Desktop bootstrap.ts does not call ${PLATFORM_CONFIG_SETTER}(). ` +
      `PlatformConfig must be initialized before any core module imports.`,
    ).toBe(true);
  });

  it.each(REQUIRED_BOUNDARY_SETTERS)(
    'calls %s in the desktop startup sequence',
    (setterName) => {
      expect(
        containsSetterCall(combinedDesktopSource, setterName),
        `Desktop startup (bootstrap.ts + index.ts) does not call ${setterName}(). ` +
        `Add it to src/main/index.ts to wire the boundary interface.`,
      ).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Cloud bootstrap wiring (cloud-service/src/platformInit.ts + cloud-service/src/bootstrap.ts)
// ---------------------------------------------------------------------------

describe('cloud bootstrap — boundary interface wiring', () => {
  // Cloud also splits initialization:
  // - platformInit.ts: setPlatformConfig (imported as side-effect by server.ts)
  // - bootstrap.ts: all other boundary interface setters
  const platformInitSource = readSource('cloud-service/src/platformInit.ts');
  const bootstrapSource = readSource('cloud-service/src/bootstrap.ts');
  const combinedCloudSource = platformInitSource + '\n' + bootstrapSource;

  it('calls setPlatformConfig in platformInit.ts', () => {
    expect(
      containsSetterCall(platformInitSource, PLATFORM_CONFIG_SETTER),
      `Cloud platformInit.ts does not call ${PLATFORM_CONFIG_SETTER}(). ` +
      `PlatformConfig must be initialized before any core module imports.`,
    ).toBe(true);
  });

  it.each(REQUIRED_BOUNDARY_SETTERS)(
    'calls %s in the cloud startup sequence',
    (setterName) => {
      expect(
        containsSetterCall(combinedCloudSource, setterName),
        `Cloud startup (platformInit.ts + bootstrap.ts) does not call ${setterName}(). ` +
        `Add it to cloud-service/src/bootstrap.ts to wire the boundary interface.`,
      ).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Cross-bootstrap consistency
// ---------------------------------------------------------------------------

describe('bootstrap consistency — both surfaces wire the same interfaces', () => {
  const desktopBootstrap = readSource('src/main/bootstrap.ts');
  const desktopIndex = readSource('src/main/index.ts');
  const cloudPlatformInit = readSource('cloud-service/src/platformInit.ts');
  const cloudBootstrap = readSource('cloud-service/src/bootstrap.ts');

  const desktopCombined = desktopBootstrap + '\n' + desktopIndex;
  const cloudCombined = cloudPlatformInit + '\n' + cloudBootstrap;

  const allSetters = [PLATFORM_CONFIG_SETTER, ...REQUIRED_BOUNDARY_SETTERS];

  it('both desktop and cloud call the same set of boundary interface setters', () => {
    const desktopSetters = allSetters.filter((s) => containsSetterCall(desktopCombined, s));
    const cloudSetters = allSetters.filter((s) => containsSetterCall(cloudCombined, s));

    const onlyDesktop = desktopSetters.filter((s) => !cloudSetters.includes(s));
    const onlyCloud = cloudSetters.filter((s) => !desktopSetters.includes(s));

    if (onlyDesktop.length > 0 || onlyCloud.length > 0) {
      const details: string[] = [];
      if (onlyDesktop.length > 0) details.push(`Desktop-only: ${onlyDesktop.join(', ')}`);
      if (onlyCloud.length > 0) details.push(`Cloud-only: ${onlyCloud.join(', ')}`);
      // This is a warning, not a hard failure — some interfaces may intentionally differ.
      // But it's worth flagging for investigation.
      expect.soft(
        onlyDesktop.length + onlyCloud.length,
        `Boundary interface wiring differs between surfaces: ${details.join('; ')}. ` +
        `This may be intentional, but verify both surfaces can function correctly.`,
      ).toBe(0);
    }
  });
});
