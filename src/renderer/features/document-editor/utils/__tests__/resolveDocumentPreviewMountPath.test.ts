import { describe, expect, it } from 'vitest';

import { resolveDocumentPreviewMountPath } from '../resolveDocumentPreviewMountPath';

describe('resolveDocumentPreviewMountPath', () => {
  it('prefers a pending path parked before the editor mounted', () => {
    expect(resolveDocumentPreviewMountPath({
      pendingPath: 'pending.md',
      committedPath: 'committed.md',
      previewOpen: true,
      openTabCount: 0,
    })).toBe('pending.md');
  });

  it('opens the committed preview path when the editor mounts after the commit effect window', () => {
    expect(resolveDocumentPreviewMountPath({
      pendingPath: null,
      committedPath: 'committed.md',
      previewOpen: true,
      openTabCount: 0,
    })).toBe('committed.md');
  });

  it('does not reopen committed paths when the editor already has tabs', () => {
    expect(resolveDocumentPreviewMountPath({
      pendingPath: null,
      committedPath: 'committed.md',
      previewOpen: true,
      openTabCount: 1,
    })).toBeNull();
  });

  it('does nothing when the preview is closed', () => {
    expect(resolveDocumentPreviewMountPath({
      pendingPath: null,
      committedPath: 'committed.md',
      previewOpen: false,
      openTabCount: 0,
    })).toBeNull();
  });

  it('does not flush a pending path while the preview is closed', () => {
    expect(resolveDocumentPreviewMountPath({
      pendingPath: 'pending.md',
      committedPath: null,
      previewOpen: false,
      openTabCount: 0,
    })).toBeNull();
  });
});
