export interface ResolveDocumentPreviewMountPathOptions {
  pendingPath: string | null;
  committedPath: string | null;
  previewOpen: boolean;
  openTabCount: number;
}

export function resolveDocumentPreviewMountPath({
  pendingPath,
  committedPath,
  previewOpen,
  openTabCount,
}: ResolveDocumentPreviewMountPathOptions): string | null {
  if (!previewOpen) {
    return null;
  }

  if (pendingPath) {
    return pendingPath;
  }

  if (!committedPath) {
    return null;
  }

  return openTabCount === 0 ? committedPath : null;
}
