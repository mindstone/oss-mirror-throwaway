/**
 * Given the result of publishing all staged files, returns the toast
 * params to show — or `null` when no toast is needed (all succeeded).
 */
export interface PublishAllResult {
  published: number;
  conflicts: number;
  errors: number;
}

export interface PublishAllToast {
  title: string;
  description: string;
  variant: 'warning' | 'error';
}

export function buildPublishAllToast(result: PublishAllResult): PublishAllToast | null {
  // All succeeded — no toast needed
  if (result.conflicts === 0 && result.errors === 0) return null;

  // Build description parts
  const descParts: string[] = [];
  if (result.conflicts > 0) {
    descParts.push(
      result.published > 0
        ? `${result.conflicts} had conflicts — review them individually`
        : 'Review them individually to resolve'
    );
  }
  if (result.errors > 0) {
    descParts.push(`${result.errors} failed to save`);
  }

  const title = result.published > 0
    ? `Saved ${result.published} file${result.published !== 1 ? 's' : ''}`
    : result.conflicts > 0
      ? 'All files had conflicts'
      : 'Failed to save files';

  return {
    title,
    description: descParts.join('. '),
    variant: result.errors > 0 ? 'error' : 'warning',
  };
}
