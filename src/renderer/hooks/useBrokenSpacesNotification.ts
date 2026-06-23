import { useCallback, useMemo } from 'react';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import { useSpacesData } from '@renderer/hooks/useSpacesData';

export interface BrokenSpace {
  name: string;
  path: string;
  absolutePath: string;
  statusMessage?: string;
}

interface UseBrokenSpacesNotificationOptions {
  coreDirectory: string | null | undefined;
}

interface UseBrokenSpacesNotificationResult {
  brokenSpaces: BrokenSpace[];
  hasBrokenSpaces: boolean;
  checkForBrokenSpaces: () => Promise<void>;
}

/**
 * Hook to detect spaces with broken frontmatter.
 * Notification is now handled via the system health check infrastructure.
 */
export const useBrokenSpacesNotification = ({
  coreDirectory,
}: UseBrokenSpacesNotificationOptions): UseBrokenSpacesNotificationResult => {
  const { spaces, refresh } = useSpacesData(coreDirectory);

  const checkForBrokenSpaces = useCallback(async () => {
    await refresh();
  }, [refresh]);

  const brokenSpaces = useMemo(() => spaces
    .filter((space: SpaceInfo) => space.status === 'needs_attention')
    .map((space: SpaceInfo) => ({
      name: space.name,
      path: space.path,
      absolutePath: space.absolutePath,
      statusMessage: space.statusMessage,
    })), [spaces]);

  return {
    brokenSpaces,
    hasBrokenSpaces: brokenSpaces.length > 0,
    checkForBrokenSpaces,
  };
};
