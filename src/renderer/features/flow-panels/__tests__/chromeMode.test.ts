import { describe, expect, it } from 'vitest';
import {
  acquireChromeModeOwner,
  hasChromeModeOwner,
  releaseChromeModeOwner,
  resolveChromeMode,
  toggleChromeModeOwner,
} from '../chromeMode';

describe('chromeMode owner token model', () => {
  it('stays reduced while any owner token remains', () => {
    const none = new Set<string>();
    const withLibrary = acquireChromeModeOwner(none, 'library');
    const withLibraryAndKiosk = acquireChromeModeOwner(withLibrary, 'kiosk');

    expect(resolveChromeMode(withLibraryAndKiosk)).toBe('reduced');
    expect(hasChromeModeOwner(withLibraryAndKiosk, 'library')).toBe(true);
    expect(hasChromeModeOwner(withLibraryAndKiosk, 'kiosk')).toBe(true);

    const afterKioskRelease = releaseChromeModeOwner(withLibraryAndKiosk, 'kiosk');
    expect(resolveChromeMode(afterKioskRelease)).toBe('reduced');
    expect(hasChromeModeOwner(afterKioskRelease, 'library')).toBe(true);
    expect(hasChromeModeOwner(afterKioskRelease, 'kiosk')).toBe(false);

    const afterLibraryRelease = releaseChromeModeOwner(afterKioskRelease, 'library');
    expect(resolveChromeMode(afterLibraryRelease)).toBe('normal');
  });

  it('toggles the requested owner token on and off', () => {
    const none = new Set<string>();
    const reduced = toggleChromeModeOwner(none, 'kiosk');
    expect(resolveChromeMode(reduced)).toBe('reduced');
    expect(hasChromeModeOwner(reduced, 'kiosk')).toBe(true);

    const restored = toggleChromeModeOwner(reduced, 'kiosk');
    expect(resolveChromeMode(restored)).toBe('normal');
    expect(hasChromeModeOwner(restored, 'kiosk')).toBe(false);
  });
});
