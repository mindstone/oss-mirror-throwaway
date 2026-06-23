import { describe, it, expect } from 'vitest';
import {
  useSharedDriveHealthToasts,
  buildAppNotRunningMessage,
  buildOnlineOnlyMessage,
  PROVIDER_DISPLAY_NAMES,
} from '../useSharedDriveHealthToasts';

describe('useSharedDriveHealthToasts', () => {
  // ---------------------------------------------------------------------------
  // Export verification
  // ---------------------------------------------------------------------------
  describe('exports', () => {
    it('exports useSharedDriveHealthToasts function', () => {
      expect(typeof useSharedDriveHealthToasts).toBe('function');
    });

    it('exports buildAppNotRunningMessage function', () => {
      expect(typeof buildAppNotRunningMessage).toBe('function');
    });

    it('exports buildOnlineOnlyMessage function', () => {
      expect(typeof buildOnlineOnlyMessage).toBe('function');
    });

    it('exports PROVIDER_DISPLAY_NAMES constant', () => {
      expect(typeof PROVIDER_DISPLAY_NAMES).toBe('object');
    });


  });

  // ---------------------------------------------------------------------------
  // Provider display names
  // ---------------------------------------------------------------------------
  describe('PROVIDER_DISPLAY_NAMES', () => {
    it('maps google_drive to Google Drive', () => {
      expect(PROVIDER_DISPLAY_NAMES.google_drive).toBe('Google Drive');
    });

    it('maps onedrive to OneDrive', () => {
      expect(PROVIDER_DISPLAY_NAMES.onedrive).toBe('OneDrive');
    });

    it('maps dropbox to Dropbox', () => {
      expect(PROVIDER_DISPLAY_NAMES.dropbox).toBe('Dropbox');
    });

    it('has entries for all three supported providers', () => {
      expect(Object.keys(PROVIDER_DISPLAY_NAMES)).toEqual(
        expect.arrayContaining(['google_drive', 'onedrive', 'dropbox']),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // buildAppNotRunningMessage
  // ---------------------------------------------------------------------------
  describe('buildAppNotRunningMessage', () => {
    it('includes display name for Google Drive', () => {
      expect(buildAppNotRunningMessage('google_drive')).toBe(
        'Google Drive needs to be running so your linked shared spaces stay in sync.',
      );
    });

    it('includes display name for OneDrive', () => {
      expect(buildAppNotRunningMessage('onedrive')).toBe(
        'OneDrive needs to be running so your linked shared spaces stay in sync.',
      );
    });

    it('includes display name for Dropbox', () => {
      expect(buildAppNotRunningMessage('dropbox')).toBe(
        'Dropbox needs to be running so your linked shared spaces stay in sync.',
      );
    });

    it('falls back to raw provider string for unknown providers', () => {
      expect(buildAppNotRunningMessage('box')).toBe(
        'box needs to be running so your linked shared spaces stay in sync.',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // buildOnlineOnlyMessage
  // ---------------------------------------------------------------------------
  describe('buildOnlineOnlyMessage', () => {
    it('returns concise message for known providers', () => {
      expect(buildOnlineOnlyMessage('onedrive')).toBe(
        "Shared space files aren't available offline.",
      );
    });

    it('returns same message for Dropbox', () => {
      expect(buildOnlineOnlyMessage('dropbox')).toBe(
        "Shared space files aren't available offline.",
      );
    });

    it('returns same message for Google Drive', () => {
      expect(buildOnlineOnlyMessage('google_drive')).toBe(
        "Shared space files aren't available offline.",
      );
    });

    it('returns same message for unknown providers', () => {
      expect(buildOnlineOnlyMessage('icloud')).toBe(
        "Shared space files aren't available offline.",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Deduplication / dismiss logic (structural)
  // ---------------------------------------------------------------------------
  describe('deduplication and dismiss behavior', () => {
    it('message builders produce non-empty strings', () => {
      for (const provider of Object.keys(PROVIDER_DISPLAY_NAMES)) {
        expect(buildAppNotRunningMessage(provider).length).toBeGreaterThan(0);
        expect(buildOnlineOnlyMessage(provider).length).toBeGreaterThan(0);
      }
    });

    it('app-not-running messages include the provider display name', () => {
      for (const [provider, displayName] of Object.entries(PROVIDER_DISPLAY_NAMES)) {
        expect(buildAppNotRunningMessage(provider)).toContain(displayName);
      }
    });
  });
});
