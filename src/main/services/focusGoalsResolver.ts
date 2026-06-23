/**
 * Focus Goals Resolver — shared helper for main-process space goal resolution.
 *
 * Encapsulates the "scan spaces → read READMEs → extract goals" pipeline
 * used by both focusHandlers.ts (IPC) and focusAutomationContext.ts (automations).
 *
 * Lives in src/main/ because it uses node:fs and scanSpaces (Electron-only).
 * The actual goal parsing is delegated to the core-layer spaceGoalsReader.
 *
 * @see src/core/services/spaceGoalsReader.ts — pure goal extraction
 * @see docs/plans/260407_focus_goals_redesign.md
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { getSettings } from '@core/services/settingsStore';
import { extractGoalsFromAllSpaces } from '@core/services/spaceGoalsReader';
import type { SpaceGoals, SpaceReadmeInput } from '@core/services/spaceGoalsReader';
import { scanSpaces } from './spaceService';

const log = createScopedLogger({ service: 'focusGoalsResolver' });

/**
 * Resolve goals from all space READMEs in the user's workspace.
 *
 * Pipeline:
 * 1. Get core directory from settings
 * 2. Scan all spaces via spaceService
 * 3. Read README.md content for each space
 * 4. Extract goals from frontmatter via spaceGoalsReader (core-layer pure function)
 * 5. Return only spaces that have goals
 *
 * Returns empty array if Focus is not enabled, no core directory is set,
 * or no spaces have goals in their frontmatter.
 */
export interface ResolvedSpaceGoals {
  withGoals: SpaceGoals[];
  spacesWithoutGoals: Array<{ spaceName: string; spacePath: string }>;
}

export async function resolveAllSpaceGoals(): Promise<SpaceGoals[]> {
  const result = await resolveAllSpaceGoalsDetailed();
  return result.withGoals;
}

export async function resolveAllSpaceGoalsDetailed(): Promise<ResolvedSpaceGoals> {
  const coreDir = getCoreDirectory();
  if (!coreDir) {
    log.warn('No core directory configured, cannot resolve space goals');
    return { withGoals: [], spacesWithoutGoals: [] };
  }

  try {
    // Read-only: focus goal resolution must not mutate space frontmatter.
    // See docs/plans/260411_shared_space_maintenance.md Stage 3 Refinement.
    const spaceList = await scanSpaces(coreDir, { skipAutoFix: true });

    const readmeInputs: SpaceReadmeInput[] = [];
    for (const space of spaceList) {
      if (!space.hasReadme) continue;
      try {
        const readmePath = path.join(space.absolutePath, 'README.md');
        const content = await fs.readFile(readmePath, 'utf-8');
        readmeInputs.push({
          spaceName: space.name,
          spacePath: space.path,
          spaceType: space.type,
          readmeContent: content,
        });
      } catch (err) {
        log.warn({ spacePath: space.path, err }, 'Failed to read space README for goals');
      }
    }

    const results = extractGoalsFromAllSpaces(readmeInputs);

    const withGoals = results
      .filter(r => r.status === 'ok' && r.goals !== null)
      .flatMap(r => r.goals ? [r.goals] : []);

    const spacesWithoutGoals = results
      .filter(r => r.status === 'no_goals')
      .map(r => ({ spaceName: r.spaceName, spacePath: r.spacePath }));

    return { withGoals, spacesWithoutGoals };
  } catch (err) {
    log.warn({ err }, 'Failed to resolve space goals');
    return { withGoals: [], spacesWithoutGoals: [] };
  }
}

/** Get the core directory from settings, or null if not set. */
function getCoreDirectory(): string | null {
  try {
    const settings = getSettings();
    return settings.coreDirectory || null;
  } catch {
    return null;
  }
}
