/**
 * Space Health Checks
 *
 * Validates space configurations and content health.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppSettings } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import type { CheckResult } from '../types';
import { readSpaceReadmeFrontmatter, scanSpaces } from '../../spaceService';

const log = createScopedLogger({ service: 'healthCheck:spaces' });

// Size thresholds for README files
const README_SIZE_WARN_BYTES = 7 * 1024;   // 7KB - getting verbose
const README_SIZE_FAIL_BYTES = 15 * 1024;  // 15KB - definitely bloated

// Valid sharing levels for spaces
const VALID_SHARING_LEVELS = ['private', 'restricted', 'company-wide', 'public'] as const;

interface SpaceReadmeInfo {
  spacePath: string;
  spaceName: string;
  readmePath: string;
  sizeBytes: number;
}

/**
 * Scan all spaces and collect README size information.
 */
async function scanSpaceReadmes(workspacePath: string): Promise<SpaceReadmeInfo[]> {
  const results: SpaceReadmeInfo[] = [];
  const root = path.resolve(workspacePath);

  // Collect space candidates (same logic as spaceService.scanSpaces)
  const spaceCandidates: string[] = [];

  // Scan root for Chief-of-Staff and Personal
  try {
    const rootContents = await fs.readdir(root, { withFileTypes: true });
    for (const entry of rootContents) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const nameLower = entry.name.toLowerCase();
        if (nameLower === 'chief-of-staff' || nameLower === 'personal') {
          spaceCandidates.push(entry.name);
        }
      }
    }
  } catch {
    // Root not accessible
  }

  // Scan work/ directory for company spaces
  const workDir = path.join(root, 'work');
  try {
    const workContents = await fs.readdir(workDir, { withFileTypes: true });
    for (const company of workContents) {
      if (company.isDirectory() || company.isSymbolicLink()) {
        const companyPath = path.join(workDir, company.name);
        try {
          const stat = await fs.stat(companyPath);
          if (stat.isDirectory()) {
            // Check if the company directory itself is a space (has README.md/AGENTS.md with valid frontmatter)
            // This matches the fix in spaceService.scanSpaces() to avoid treating memory/, skills/, scripts/ as spaces
            const companyFrontmatter = await readSpaceReadmeFrontmatter(companyPath);
            if (companyFrontmatter) {
              // Company directory is itself a space - add it and skip descending into children
              spaceCandidates.push(`work/${company.name}`);
            } else {
              // Company is a container for multiple spaces
              const companyContents = await fs.readdir(companyPath, { withFileTypes: true });
              for (const space of companyContents) {
                if (space.isDirectory() || space.isSymbolicLink()) {
                  spaceCandidates.push(`work/${company.name}/${space.name}`);
                }
              }
            }
          }
        } catch {
          // Skip inaccessible directories
        }
      }
    }
  } catch {
    // work/ directory doesn't exist yet
  }

  // Check each space for README.md or AGENTS.md
  for (const candidate of spaceCandidates) {
    const spacePath = path.join(root, candidate);
    const pathParts = candidate.split('/').filter(Boolean);
    const spaceName = pathParts[pathParts.length - 1];

    // Try README.md first, fall back to legacy AGENTS.md
    for (const filename of ['README.md', 'AGENTS.md']) {
      const readmePath = path.join(spacePath, filename);
      try {
        const stat = await fs.stat(readmePath);
        if (stat.isFile()) {
          results.push({
            spacePath: candidate,
            spaceName,
            readmePath,
            sizeBytes: stat.size,
          });
          break; // Found one, don't check for AGENTS.md
        }
      } catch {
        // File doesn't exist, try next
      }
    }
  }

  return results;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export async function checkSpaceReadmeSizes(settings: AppSettings): Promise<CheckResult> {
  const id = 'spaceReadmeSizes';
  const name = 'Space README Sizes';

  if (!settings.coreDirectory) {
    return {
      id,
      name,
      status: 'skip',
      message: 'Library not configured',
    };
  }

  try {
    const readmes = await scanSpaceReadmes(settings.coreDirectory);

    if (readmes.length === 0) {
      return {
        id,
        name,
        status: 'skip',
        message: 'No space READMEs found',
      };
    }

    const oversized = readmes.filter(r => r.sizeBytes >= README_SIZE_FAIL_BYTES);
    const verbose = readmes.filter(r => r.sizeBytes >= README_SIZE_WARN_BYTES && r.sizeBytes < README_SIZE_FAIL_BYTES);
    const healthy = readmes.filter(r => r.sizeBytes < README_SIZE_WARN_BYTES);

    // Build details for all spaces
    const spaceDetails = readmes
      .sort((a, b) => b.sizeBytes - a.sizeBytes)
      .map(r => ({
        space: r.spaceName,
        size: formatBytes(r.sizeBytes),
        sizeBytes: r.sizeBytes,
        status: r.sizeBytes >= README_SIZE_FAIL_BYTES ? 'bloated' :
                r.sizeBytes >= README_SIZE_WARN_BYTES ? 'verbose' : 'healthy',
      }));

    if (oversized.length > 0) {
      const top = oversized.sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
      return {
        id,
        name,
        status: 'fail',
        message: `${oversized.length} space README${oversized.length > 1 ? 's' : ''} bloated. Largest: ${top.spaceName} (${formatBytes(top.sizeBytes)})`,
        details: {
          totalSpaces: readmes.length,
          oversizedCount: oversized.length,
          verboseCount: verbose.length,
          healthyCount: healthy.length,
          spaces: spaceDetails,
          thresholds: {
            warnBytes: README_SIZE_WARN_BYTES,
            failBytes: README_SIZE_FAIL_BYTES,
          },
        },
        remediation: 'Space READMEs should be succinct (under 10KB). Move detailed documentation to separate files or memory.',
      };
    }

    if (verbose.length > 0) {
      const top = verbose.sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
      return {
        id,
        name,
        status: 'warn',
        message: `${verbose.length} space README${verbose.length > 1 ? 's' : ''} getting verbose. Largest: ${top.spaceName} (${formatBytes(top.sizeBytes)})`,
        details: {
          totalSpaces: readmes.length,
          oversizedCount: oversized.length,
          verboseCount: verbose.length,
          healthyCount: healthy.length,
          spaces: spaceDetails,
          thresholds: {
            warnBytes: README_SIZE_WARN_BYTES,
            failBytes: README_SIZE_FAIL_BYTES,
          },
        },
        remediation: 'Consider trimming README content. Move detailed instructions to memory files or separate docs.',
      };
    }

    return {
      id,
      name,
      status: 'pass',
      message: `All ${readmes.length} space READMEs are succinct`,
      details: {
        totalSpaces: readmes.length,
        healthyCount: healthy.length,
        spaces: spaceDetails,
        thresholds: {
          warnBytes: README_SIZE_WARN_BYTES,
          failBytes: README_SIZE_FAIL_BYTES,
        },
      },
    };
  } catch (error) {
    log.warn({ err: error }, 'Space README size check failed unexpectedly');
    return {
      id,
      name,
      status: 'warn',
      message: 'Check failed unexpectedly',
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

/**
 * Check that all tracked spaces have a valid sharing configuration.
 * Memory safety behavior is derived from sharing level, so missing or invalid
 * sharing values will cause unpredictable approval behavior.
 */
export async function checkSpaceSharingConfig(settings: AppSettings): Promise<CheckResult> {
  const id = 'spaceSharingConfig';
  const name = 'Space Sharing Configuration';

  const trackedSpaces = settings.spaces ?? [];
  
  if (trackedSpaces.length === 0) {
    return {
      id,
      name,
      status: 'skip',
      message: 'No tracked spaces configured',
    };
  }

  try {
    const missingSharing: string[] = [];
    const invalidSharing: Array<{ path: string; sharing: string }> = [];
    const legacyTeam: string[] = [];
    
    for (const space of trackedSpaces) {
      if (!space.sharing) {
        missingSharing.push(space.path);
      } else if ((space.sharing as string) === 'team') {
        // Legacy value - should be migrated to 'restricted'
        legacyTeam.push(space.path);
      } else if (!VALID_SHARING_LEVELS.includes(space.sharing as typeof VALID_SHARING_LEVELS[number])) {
        invalidSharing.push({ path: space.path, sharing: space.sharing });
      }
    }

    const issues = missingSharing.length + invalidSharing.length;
    const warnings = legacyTeam.length;

    if (issues > 0) {
      return {
        id,
        name,
        status: 'fail',
        message: `${issues} space${issues > 1 ? 's' : ''} missing or have invalid sharing configuration`,
        details: {
          totalSpaces: trackedSpaces.length,
          missingSharing,
          invalidSharing,
          legacyTeam,
          validValues: VALID_SHARING_LEVELS,
        },
        remediation: 'Open Settings > Spaces and edit each space to set a sharing level. Memory safety behavior depends on this.',
      };
    }

    if (warnings > 0) {
      return {
        id,
        name,
        status: 'warn',
        message: `${warnings} space${warnings > 1 ? 's have' : ' has'} legacy "team" sharing (now called "restricted")`,
        details: {
          totalSpaces: trackedSpaces.length,
          legacyTeam,
          validValues: VALID_SHARING_LEVELS,
        },
        remediation: 'Settings will auto-migrate on next load, but you can manually update in Settings > Spaces.',
      };
    }

    return {
      id,
      name,
      status: 'pass',
      message: `All ${trackedSpaces.length} tracked spaces have valid sharing configuration`,
      details: {
        totalSpaces: trackedSpaces.length,
        breakdown: {
          private: trackedSpaces.filter(s => s.sharing === 'private').length,
          restricted: trackedSpaces.filter(s => s.sharing === 'restricted').length,
          companyWide: trackedSpaces.filter(s => s.sharing === 'company-wide').length,
          public: trackedSpaces.filter(s => s.sharing === 'public').length,
        },
      },
    };
  } catch (error) {
    log.warn({ err: error }, 'Space sharing config check failed unexpectedly');
    return {
      id,
      name,
      status: 'warn',
      message: 'Check failed unexpectedly',
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

/**
 * Check for spaces with broken or missing frontmatter.
 * Uses read-only mode (skipAutoFix) to detect issues without modifying files.
 */
export async function checkBrokenSpaceFrontmatter(settings: AppSettings): Promise<CheckResult> {
  const id = 'brokenSpaceFrontmatter';
  const name = 'Space Frontmatter';

  if (!settings.coreDirectory) {
    return {
      id,
      name,
      status: 'skip',
      message: 'Library not configured',
    };
  }

  try {
    // Scan spaces in read-only mode (no auto-fix)
    const spaces = await scanSpaces(settings.coreDirectory, { skipAutoFix: true });

    if (spaces.length === 0) {
      return {
        id,
        name,
        status: 'skip',
        message: 'No spaces found',
      };
    }

    // Find spaces that need attention
    const brokenSpaces = spaces.filter(s => s.status === 'needs_attention');

    if (brokenSpaces.length === 0) {
      return {
        id,
        name,
        status: 'pass',
        message: `All ${spaces.length} spaces have valid configuration`,
      };
    }

    // Return warning with details about broken spaces
    const brokenList = brokenSpaces.map(s => ({
      path: s.path,
      name: s.name,
      issue: s.statusMessage || 'Configuration issue',
    }));

    return {
      id,
      name,
      status: 'warn',
      message: brokenSpaces.length === 1
        ? `"${brokenSpaces[0].name}" space needs configuration`
        : `${brokenSpaces.length} spaces need configuration`,
      details: {
        totalSpaces: spaces.length,
        brokenCount: brokenSpaces.length,
        brokenSpaces: brokenList,
      },
      remediation: 'Open Settings > Spaces to repair space configuration, or ask Rebel to fix it.',
    };
  } catch (error) {
    log.warn({ err: error }, 'Broken space frontmatter check failed unexpectedly');
    return {
      id,
      name,
      status: 'warn',
      message: 'Check failed unexpectedly',
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}
