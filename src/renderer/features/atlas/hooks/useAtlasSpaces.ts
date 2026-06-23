/**
 * useAtlasSpaces
 * 
 * Hook to fetch spaces and build a color map for Atlas visualization.
 * Maps file paths to space colors using hash-based HSL generation.
 */

import { useMemo } from 'react';
import { useSpacesData } from '@renderer/hooks/useSpacesData';
import { getSpaceColor, buildSpaceColorMap, type SpaceColorInfo } from '../utils/atlasConfig';

export interface SpaceLegendItem {
  name: string;
  color: string;
  /** If true, this is a system/unspaced category (hidden by default) */
  isSystem?: boolean;
}

/** Color for files not in any configured space */
const SYSTEM_COLOR = 'hsl(220, 10%, 45%)'; // Muted gray-blue
const SYSTEM_LABEL = 'System';

interface UseAtlasSpacesResult {
  /** Map of file path -> space color */
  spaceColorMap: Map<string, string>;
  /** Map of file path -> space name (for tooltips) */
  spaceNameMap: Map<string, string>;
  /** Legend items for display */
  legend: SpaceLegendItem[];
  /** Set of file paths that are "system" (not in any space) */
  systemPaths: Set<string>;
  /** Whether spaces are loading */
  isLoading: boolean;
}

export function useAtlasSpaces(
  filePaths: string[],
  coreDirectory: string | null | undefined,
): UseAtlasSpacesResult {
  const { spaces: spacesData, loading: isLoading } = useSpacesData(coreDirectory);

  const spaces = useMemo<SpaceColorInfo[]>(() => spacesData.map(space => ({
    name: space.displayName || space.name,
    // For symlinked spaces, use sourcePath (resolved target) for matching,
    // since indexed files have resolved paths, not symlink paths.
    path: space.sourcePath || space.absolutePath,
    color: getSpaceColor(space.path, space.name), // Use relative path for hierarchy.
  })), [spacesData]);
  
  // Build color map when spaces or file paths change
  // Also track which files are "system" (not in any space)
  const { spaceColorMap, systemPaths } = useMemo(() => {
    if (filePaths.length === 0) {
      return { spaceColorMap: new Map<string, string>(), systemPaths: new Set<string>() };
    }
    
    const colorMap = spaces.length > 0 
      ? buildSpaceColorMap(filePaths, spaces)
      : new Map<string, string>();
    
    // Find files not in any space
    const system = new Set<string>();
    for (const filePath of filePaths) {
      if (!colorMap.has(filePath)) {
        system.add(filePath);
        colorMap.set(filePath, SYSTEM_COLOR);
      }
    }
    
    return { spaceColorMap: colorMap, systemPaths: system };
  }, [filePaths, spaces]);
  
  // Build name map for tooltips (same matching logic as color map)
  // Case-insensitive on macOS/Windows to match filesystem behavior
  const spaceNameMap = useMemo(() => {
    const nameMap = new Map<string, string>();
    if (spaces.length === 0 || filePaths.length === 0) {
      return nameMap;
    }
    
    // Check if filesystem is case-insensitive (macOS, Windows)
    const platform = typeof navigator !== 'undefined' ? navigator.platform.toLowerCase() : '';
    const caseInsensitive = platform.includes('mac') || platform.includes('win');
    
    // Sort spaces by path length (longest first) for most specific match
    const sortedSpaces = [...spaces].sort((a, b) => b.path.length - a.path.length);
    
    // Pre-normalize space paths
    const normalizedSpaces = sortedSpaces.map(space => ({
      ...space,
      normalizedPath: caseInsensitive
        ? space.path.replace(/\\/g, '/').toLowerCase()
        : space.path.replace(/\\/g, '/'),
    }));
    
    for (const filePath of filePaths) {
      const normalizedPath = caseInsensitive
        ? filePath.replace(/\\/g, '/').toLowerCase()
        : filePath.replace(/\\/g, '/');
      
      for (const space of normalizedSpaces) {
        if (normalizedPath.startsWith(space.normalizedPath + '/') || 
            normalizedPath === space.normalizedPath) {
          nameMap.set(filePath, space.name);
          break;
        }
      }
    }
    
    return nameMap;
  }, [filePaths, spaces]);
  
  // Build legend items (unique spaces that have files)
  const legend = useMemo(() => {
    const usedSpaces = new Set<string>();
    
    // Find which spaces have files in the visualization
    for (const [, color] of spaceColorMap) {
      usedSpaces.add(color);
    }
    
    // Build legend from spaces that have files
    const items: SpaceLegendItem[] = spaces
      .filter(space => usedSpaces.has(space.color))
      .map(space => ({
        name: space.name,
        color: space.color,
      }));
    
    // Add "System" entry if there are unspaced files
    if (systemPaths.size > 0) {
      items.push({
        name: SYSTEM_LABEL,
        color: SYSTEM_COLOR,
        isSystem: true,
      });
    }
    
    return items;
  }, [spaceColorMap, spaces, systemPaths]);
  
  return {
    spaceColorMap,
    spaceNameMap,
    legend,
    systemPaths,
    isLoading,
  };
}
