import { describe, it, expect } from 'vitest';
import { shouldOfferRelocation, resolveMoveConflict } from '../appRelocationService';

const BASE = {
  platform: 'darwin' as NodeJS.Platform,
  isPackaged: true,
  isInApplicationsFolder: false,
  optedOut: false,
  isLocalForgeBuild: false,
};

describe('shouldOfferRelocation', () => {
  it('offers for the packaged macOS app outside /Applications and not opted out', () => {
    expect(shouldOfferRelocation(BASE)).toBe(true);
  });

  it('does not offer when already in /Applications', () => {
    expect(shouldOfferRelocation({ ...BASE, isInApplicationsFolder: true })).toBe(false);
  });

  it('does not offer once the user has opted out', () => {
    expect(shouldOfferRelocation({ ...BASE, optedOut: true })).toBe(false);
  });

  it('does not offer the unpackaged dev bundle', () => {
    expect(shouldOfferRelocation({ ...BASE, isPackaged: false })).toBe(false);
  });

  it('does not offer a local developer (package:run) build', () => {
    // The dev build is packaged + outside /Applications, so every other gate
    // passes — only isLocalForgeBuild suppresses the per-launch nag.
    expect(shouldOfferRelocation({ ...BASE, isLocalForgeBuild: true })).toBe(false);
  });

  it('does not offer on non-macOS platforms', () => {
    for (const platform of ['win32', 'linux'] as NodeJS.Platform[]) {
      expect(shouldOfferRelocation({ ...BASE, platform })).toBe(false);
    }
  });
});

describe('resolveMoveConflict', () => {
  it('overwrites a non-running existing copy (consolidate the duplicate)', () => {
    expect(resolveMoveConflict('exists')).toBe(true);
  });

  it('halts when the existing /Applications copy is running', () => {
    expect(resolveMoveConflict('existsAndRunning')).toBe(false);
  });
});
