import { describe, expect, it } from 'vitest';
import {
  DRIVE_AWARE_SYNC_HELP_URL,
  DRIVE_AWARE_SYNC_TOAST_BODY,
  DRIVE_AWARE_SYNC_TOAST_TITLE,
  useDriveAwareSyncToast,
} from '../useDriveAwareSyncToast';

describe('useDriveAwareSyncToast', () => {
  it('exports a hook function', () => {
    expect(typeof useDriveAwareSyncToast).toBe('function');
  });

  it('uses the approved title copy', () => {
    expect(DRIVE_AWARE_SYNC_TOAST_TITLE).toBe('Drive is handling this workspace');
  });

  it('uses the approved body copy', () => {
    expect(DRIVE_AWARE_SYNC_TOAST_BODY).toBe(
      'This workspace is in Google Drive and Rebel is open on more than one computer. Rebel will let Drive deliver new workspace folders so it doesn\'t create duplicate "(1)" copies. Cloud continuity stays on for phone and browser. Less folder archaeology.',
    );
  });

  it('links Learn more to the Drive help article', () => {
    expect(DRIVE_AWARE_SYNC_HELP_URL).toBe(
      'rebel://library/rebel-system%2Fhelp-for-humans%2Fgoogle-drive-desktop-local-sync.md',
    );
  });
});
