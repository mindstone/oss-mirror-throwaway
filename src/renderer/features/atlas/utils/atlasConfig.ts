/**
 * Atlas Configuration
 * 
 * Visual settings and utility functions for the Atlas visualization.
 */

// Force-graph configuration
export const ATLAS_CONFIG = {
  // Completely disable physics - UMAP positions ARE the layout
  d3AlphaDecay: 1, // Immediate stop
  d3VelocityDecay: 1, // No momentum
  warmupTicks: 0, // Skip warmup
  cooldownTicks: 0, // Skip cooldown
  
  // Node appearance
  nodeRelSize: 4,
  nodeOpacity: 0.85,
  
  // Link appearance (for hover edges)
  linkOpacity: 0.95,
  linkWidth: 2,

  // UMAP configuration
  umap: {
    nNeighbors: 15,
    minDist: 0.2,
    nComponents: 3,
  },

  // d3-force tuning applied only when shouldRunForces is true (semantic edges
  // hydrated). Values match d3-force defaults so the simulation behaves the
  // same as if d3Force(...) had not been touched, while keeping the tuning
  // surface in one place. Adjust here if the force-directed layout needs
  // visual tweaking; see AtlasCanvas.tsx force-tuning useEffect (~L1252).
  forces: {
    linkDistance: 30,
    linkStrength: 0.3,
    chargeStrength: -30,
    chargeMaxDistance: 300,
    centerStrength: 0.1,
  },
};

// File extension to color mapping
const EXTENSION_COLORS: Record<string, string> = {
  // Documents
  md: '#4A9EFF',
  txt: '#6B7280',
  pdf: '#EF4444',
  doc: '#2563EB',
  docx: '#2563EB',
  
  // Code - JavaScript/TypeScript
  js: '#F7DF1E',
  jsx: '#61DAFB',
  ts: '#3178C6',
  tsx: '#3178C6',
  
  // Code - Python
  py: '#3572A5',
  ipynb: '#F37726',
  
  // Code - Other
  rs: '#DEA584',
  go: '#00ADD8',
  rb: '#CC342D',
  java: '#B07219',
  c: '#555555',
  cpp: '#F34B7D',
  h: '#555555',
  
  // Web
  html: '#E34F26',
  css: '#1572B6',
  scss: '#C6538C',
  json: '#292929',
  yaml: '#CB171E',
  yml: '#CB171E',
  xml: '#FF6600',
  
  // Config
  toml: '#9C4121',
  ini: '#6B7280',
  env: '#ECD53F',
  
  // Data
  csv: '#217346',
  sql: '#336791',
  
  // Images
  png: '#FF6B6B',
  jpg: '#FF6B6B',
  jpeg: '#FF6B6B',
  gif: '#FF6B6B',
  svg: '#FFB13B',
  
  // Other
  sh: '#89E051',
  bash: '#89E051',
  zsh: '#89E051',
};

const DEFAULT_COLOR = '#8B5CF6'; // Purple for unknown types

/**
 * Convert a color string to RGBA with specified alpha.
 * Handles hex colors (#RGB, #RRGGBB), rgb(), and hsl() formats.
 * 
 * Phase 7: Used for per-node opacity in semantic search
 * (nodeOpacity is global, but nodeColor with RGBA alpha channel works)
 */
export function colorToRgba(color: string, alpha: number): string {
  // Already rgba - just update alpha
  if (color.startsWith('rgba(')) {
    const match = color.match(/rgba\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*[\d.]+\s*\)/);
    if (match) {
      return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
    }
    return color;
  }
  
  // rgb() -> rgba()
  if (color.startsWith('rgb(')) {
    const match = color.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (match) {
      return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
    }
    return color;
  }
  
  // hsl() -> hsla()
  if (color.startsWith('hsl(')) {
    const match = color.match(/hsl\s*\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/);
    if (match) {
      return `hsla(${match[1]}, ${match[2]}%, ${match[3]}%, ${alpha})`;
    }
    return color;
  }
  
  // hsla() - just update alpha
  if (color.startsWith('hsla(')) {
    const match = color.match(/hsla\s*\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*,\s*[\d.]+\s*\)/);
    if (match) {
      return `hsla(${match[1]}, ${match[2]}%, ${match[3]}%, ${alpha})`;
    }
    return color;
  }
  
  // Hex color
  if (color.startsWith('#')) {
    let hex = color.slice(1);
    
    // Handle 3-char hex (#RGB -> #RRGGBB)
    if (hex.length === 3) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    
    // Handle 4-char hex (#RGBA -> #RRGGBBAA) - ignore existing alpha
    if (hex.length === 4) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    
    // Handle 8-char hex (#RRGGBBAA) - ignore existing alpha
    if (hex.length === 8) {
      hex = hex.slice(0, 6);
    }
    
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      
      if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }
    }
  }
  
  // Named colors or unrecognized format - return as-is
  // Canvas will handle named colors, but alpha won't be applied
  console.warn(`[Atlas] Unrecognized color format: ${color}`);
  return color;
}

// Phase 8: Constants for recent file highlighting
export const RECENT_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const RECENT_SIZE_MULTIPLIER = 1.5;
export const RECENT_BRIGHTEN_AMOUNT = 35; // Lightness increase percentage

/**
 * Convert hex color to HSL components
 */
function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  let hexClean = hex.slice(1);
  
  // Handle 3-char hex
  if (hexClean.length === 3) {
    hexClean = hexClean[0] + hexClean[0] + hexClean[1] + hexClean[1] + hexClean[2] + hexClean[2];
  }
  
  if (hexClean.length !== 6) return null;
  
  const r = parseInt(hexClean.slice(0, 2), 16) / 255;
  const g = parseInt(hexClean.slice(2, 4), 16) / 255;
  const b = parseInt(hexClean.slice(4, 6), 16) / 255;
  
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  
  if (max === min) {
    return { h: 0, s: 0, l: l * 100 };
  }
  
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  
  let h = 0;
  if (max === r) {
    h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  } else if (max === g) {
    h = ((b - r) / d + 2) / 6;
  } else {
    h = ((r - g) / d + 4) / 6;
  }
  
  return { h: h * 360, s: s * 100, l: l * 100 };
}

/**
 * Brighten a color by increasing its lightness.
 * Handles both HSL and hex formats, returns HSL string.
 * 
 * Phase 8: Used for highlighting recent files
 */
export function brightenColor(color: string, amount: number): string {
  // HSL format
  if (color.startsWith('hsl(')) {
    const match = color.match(/hsl\s*\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/);
    if (match) {
      const h = parseFloat(match[1]);
      const s = parseFloat(match[2]);
      const l = Math.min(90, parseFloat(match[3]) + amount); // Cap at 90% to avoid white
      return `hsl(${h}, ${s}%, ${l}%)`;
    }
    return color;
  }
  
  // HSLA format
  if (color.startsWith('hsla(')) {
    const match = color.match(/hsla\s*\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*,\s*([\d.]+)\s*\)/);
    if (match) {
      const h = parseFloat(match[1]);
      const s = parseFloat(match[2]);
      const l = Math.min(90, parseFloat(match[3]) + amount);
      const a = parseFloat(match[4]);
      return `hsla(${h}, ${s}%, ${l}%, ${a})`;
    }
    return color;
  }
  
  // Hex format - convert to HSL, brighten, return as HSL
  if (color.startsWith('#')) {
    const hsl = hexToHsl(color);
    if (hsl) {
      const l = Math.min(90, hsl.l + amount);
      return `hsl(${Math.round(hsl.h)}, ${Math.round(hsl.s)}%, ${Math.round(l)}%)`;
    }
    return color;
  }
  
  // Unknown format - return as-is
  return color;
}

/**
 * Check if a file is considered "recent" based on its mtime
 * Handles clock skew by treating future mtimes as recent
 */
export function isRecentFile(mtime: number | undefined): boolean {
  if (!mtime) return false;
  const now = Date.now();
  const age = Math.max(0, now - mtime); // Clamp to 0 for future mtimes (clock skew)
  return age < RECENT_THRESHOLD_MS;
}

/**
 * Get color for a file extension
 */
export function getNodeColor(extension: string): string {
  const ext = extension.toLowerCase().replace(/^\./, '');
  return EXTENSION_COLORS[ext] || DEFAULT_COLOR;
}

/**
 * Simple string hash for generating consistent colors
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

// Predefined distinct hues for root-level spaces (well-separated on color wheel)
const ROOT_HUES = [
  210,  // Blue
  340,  // Pink/Magenta  
  45,   // Orange/Gold
  160,  // Teal/Cyan
  280,  // Purple
  100,  // Green
  20,   // Red-Orange
  190,  // Blue-Cyan
];

// Cache for root space -> hue mapping
const rootHueCache = new Map<string, number>();
let nextHueIndex = 0;

/**
 * Get a distinct hue for a root-level space
 * Uses predefined well-separated hues for visual distinction
 */
function getRootHue(rootName: string): number {
  const cachedHue = rootHueCache.get(rootName);
  if (cachedHue !== undefined) {
    return cachedHue;
  }
  
  // Assign next predefined hue, or fall back to hash-based if we run out
  let hue: number;
  if (nextHueIndex < ROOT_HUES.length) {
    hue = ROOT_HUES[nextHueIndex];
    nextHueIndex++;
  } else {
    // Fall back to hash-based for additional roots
    const hash = hashString(rootName);
    hue = (hash * 137.508) % 360;
  }
  
  rootHueCache.set(rootName, hue);
  return hue;
}

/**
 * Extract root space name from a relative space path
 * e.g., "work/mindstone/General" -> "work"
 * e.g., "personal" -> "personal"
 */
function extractRootSpaceName(relativePath: string): string {
  // Normalize separators
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  
  // First part is the root space
  return parts[0] || relativePath;
}

/**
 * Calculate nesting depth within a root space using relative path
 * e.g., "work" = 0, "work/mindstone" = 1, "work/mindstone/General" = 2
 */
function getSpaceDepth(relativePath: string): number {
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  
  // Depth is number of parts minus 1 (root = 0)
  return Math.max(0, parts.length - 1);
}

/**
 * Generate a color for a space using hierarchical coloring:
 * - Root spaces get distinct, well-separated hues
 * - Nested spaces get variations (different lightness/saturation)
 * 
 * @param relativePath - Path relative to workspace root (e.g., "work/mindstone/General")
 * @param spaceName - Display name of the space
 */
export function getSpaceColor(relativePath: string, spaceName: string): string {
  const rootName = extractRootSpaceName(relativePath);
  const depth = getSpaceDepth(relativePath);
  const hue = getRootHue(rootName);
  
  // Vary saturation and lightness based on depth
  // Deeper = slightly less saturated, different lightness
  const baseSaturation = 70;
  const baseLightness = 50;
  
  // Create variation based on depth and a hash of the full name for uniqueness
  const nameHash = hashString(spaceName);
  const lightnessOffset = (depth * 8) + ((nameHash % 3) * 5) - 5; // -5 to +15 range
  const saturationOffset = -(depth * 5); // Slightly less saturated for nested
  
  const saturation = Math.max(40, Math.min(80, baseSaturation + saturationOffset));
  const lightness = Math.max(35, Math.min(65, baseLightness + lightnessOffset));
  
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

/**
 * Space info for coloring
 */
export interface SpaceColorInfo {
  name: string;
  path: string; // Absolute path
  color: string;
}

/**
 * Check if filesystem is case-insensitive (macOS, Windows)
 * Linux is typically case-sensitive, macOS/Windows are not
 */
function isCaseInsensitiveFS(): boolean {
  // In renderer process, check navigator.platform
  const platform = typeof navigator !== 'undefined' ? navigator.platform.toLowerCase() : '';
  // macOS: "MacIntel", "MacPPC", etc. Windows: "Win32", "Win64"
  return platform.includes('mac') || platform.includes('win');
}

/**
 * Build a map of file paths to space colors
 * Uses boundary-aware path matching to prevent false positives
 * Case-insensitive on macOS/Windows to match filesystem behavior
 */
export function buildSpaceColorMap(
  filePaths: string[],
  spaces: SpaceColorInfo[]
): Map<string, string> {
  const colorMap = new Map<string, string>();
  const caseInsensitive = isCaseInsensitiveFS();
  
  // Sort spaces by path length (longest first) for most specific match
  const sortedSpaces = [...spaces].sort((a, b) => b.path.length - a.path.length);
  
  // Pre-normalize space paths for comparison
  const normalizedSpaces = sortedSpaces.map(space => ({
    ...space,
    normalizedPath: caseInsensitive 
      ? space.path.replace(/\\/g, '/').toLowerCase()
      : space.path.replace(/\\/g, '/'),
  }));
  
  for (const filePath of filePaths) {
    // Normalize path separators (and case on case-insensitive filesystems)
    const normalizedPath = caseInsensitive
      ? filePath.replace(/\\/g, '/').toLowerCase()
      : filePath.replace(/\\/g, '/');
    
    for (const space of normalizedSpaces) {
      // Boundary-aware match: file must be inside space directory
      // Check if path starts with space path followed by separator or end
      if (normalizedPath.startsWith(space.normalizedPath + '/') || 
          normalizedPath === space.normalizedPath) {
        colorMap.set(filePath, space.color);
        break; // Use first (most specific) match
      }
    }
  }
  
  return colorMap;
}
