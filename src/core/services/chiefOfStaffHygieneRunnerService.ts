import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { isPathInsideLexical } from '@core/utils/systemUtils';
import type { AppSettings, SpaceConfig } from '@shared/types';
import {
  clearChiefOfStaffHygieneNeededMarker,
  readChiefOfStaffHygieneNeededMarker,
} from './chiefOfStaffHygieneBackupService';
import {
  evaluateChiefOfStaffReadmeHygieneFile,
  type ChiefOfStaffHygieneEvaluationResult,
} from './chiefOfStaffHygieneEligibilityService';
import {
  rewriteChiefOfStaffReadmeSafeSections,
  type ChiefOfStaffHygieneRewriteResult,
} from './chiefOfStaffHygieneRewriteService';

const log = createScopedLogger({ service: 'chief-of-staff-hygiene' });

export type ChiefOfStaffHygieneSkipReason =
  | 'workspace_not_configured'
  | 'chief_of_staff_not_found';

export interface ChiefOfStaffHygieneRunResult {
  readmePath: string | null;
  eligibility: ChiefOfStaffHygieneEvaluationResult | null;
  rewrite: ChiefOfStaffHygieneRewriteResult | null;
  skippedReason: ChiefOfStaffHygieneSkipReason | null;
  errors: string[];
  elapsedMs: number;
}

export interface ChiefOfStaffHygieneRunOptions {
  now?: Date;
}

const CHIEF_OF_STAFF_DIRECTORY_CANDIDATES = [
  'Chief-of-Staff',
  'chief-of-staff',
  'Chief of Staff',
  'chiefofstaff',
] as const;

export async function resolveChiefOfStaffReadmePath(
  coreDirectory: string | null | undefined,
  settings: Pick<AppSettings, 'spaces'>,
): Promise<string | null> {
  if (!coreDirectory) {
    return null;
  }

  const configuredChiefOfStaff = (settings.spaces ?? []).find(isChiefOfStaffSpace);
  if (configuredChiefOfStaff) {
    if (configuredChiefOfStaff.isSymlink) {
      log.warn(
        {
          configuredPath: configuredChiefOfStaff.path,
        },
        'Skipping symlinked Chief-of-Staff space until automatic hygiene symlink policy is defined',
      );
      return null;
    }
    const configuredReadmePath = path.join(coreDirectory, configuredChiefOfStaff.path, 'README.md');
    if (!isPathInsideLexical(configuredReadmePath, coreDirectory)) {
      log.warn(
        {
          configuredPath: configuredChiefOfStaff.path,
        },
        'Skipping Chief-of-Staff README outside workspace boundary',
      );
      return null;
    }
    if (await isSymlinkedChiefOfStaffTarget(path.dirname(configuredReadmePath), configuredReadmePath)) {
      log.warn(
        {
          configuredPath: configuredChiefOfStaff.path,
        },
        'Skipping symlinked Chief-of-Staff target until automatic hygiene symlink policy is defined',
      );
      return null;
    }
    return configuredReadmePath;
  }

  for (const candidate of CHIEF_OF_STAFF_DIRECTORY_CANDIDATES) {
    const candidateDirectory = path.join(coreDirectory, candidate);
    const readmePath = path.join(candidateDirectory, 'README.md');
    try {
      if (await isSymlinkedChiefOfStaffTarget(candidateDirectory, readmePath)) {
        log.warn({ readmePath }, 'Skipping symlinked Chief-of-Staff fallback target');
        continue;
      }
      const readmeStat = await fsp.lstat(readmePath);
      if (readmeStat.isFile()) {
        return readmePath;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.debug({ err: error, readmePath }, 'Failed while probing Chief-of-Staff README fallback path');
      }
    }
  }

  return null;
}

export async function runChiefOfStaffHygieneCheck(
  coreDirectory: string | null | undefined,
  settings: AppSettings,
  options: ChiefOfStaffHygieneRunOptions = {},
): Promise<ChiefOfStaffHygieneRunResult> {
  const startedAt = Date.now();
  if (!coreDirectory) {
    return {
      readmePath: null,
      eligibility: null,
      rewrite: null,
      skippedReason: 'workspace_not_configured',
      errors: [],
      elapsedMs: 0,
    };
  }

  const readmePath = await resolveChiefOfStaffReadmePath(coreDirectory, settings);
  if (!readmePath) {
    const result: ChiefOfStaffHygieneRunResult = {
      readmePath: null,
      eligibility: null,
      rewrite: null,
      skippedReason: 'chief_of_staff_not_found',
      errors: [],
      elapsedMs: Math.max(0, Date.now() - startedAt),
    };
    return result;
  }

  const eligibility = await evaluateChiefOfStaffReadmeHygieneFile(readmePath);
  const errors = eligibility.error ? [eligibility.error] : [];
  let rewrite: ChiefOfStaffHygieneRewriteResult | null = null;
  if (eligibility.eligible && errors.length === 0) {
    try {
      // Production v1 stays deterministic: LLM distillation is kept behind tests
      // until live-output validation proves it preserves active work reliably.
      rewrite = await rewriteChiefOfStaffReadmeSafeSections(coreDirectory, readmePath, {
        now: options.now,
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const result: ChiefOfStaffHygieneRunResult = {
    readmePath,
    eligibility,
    rewrite,
    skippedReason: null,
    errors,
    elapsedMs: Math.max(0, Date.now() - startedAt),
  };

  await updateNeededMarkerAfterRun(coreDirectory, result);

  if (eligibility.eligible) {
    log.info(
      {
        readmePath,
        triggerReasons: eligibility.triggerReasons,
        byteSize: eligibility.metrics.byteSize,
        riskIndicators: eligibility.riskIndicators.map((indicator) => indicator.kind),
        rewriteChanged: rewrite?.changed ?? false,
        sectionsMoved: rewrite?.sectionsMoved.map((section) => section.heading) ?? [],
        sectionsDistilled: rewrite?.sectionsDistilled.map((section) => section.heading) ?? [],
        skippedRiskyItems: rewrite?.skippedRiskyItems.length ?? 0,
      },
      'Chief-of-Staff hygiene check found eligible README',
    );
  } else {
    log.debug(
      {
        readmePath,
        noOpReason: eligibility.noOpReason,
        byteSize: eligibility.metrics.byteSize,
      },
      'Chief-of-Staff hygiene check no-op',
    );
  }

  return result;
}

async function updateNeededMarkerAfterRun(
  coreDirectory: string,
  result: ChiefOfStaffHygieneRunResult,
): Promise<void> {
  try {
    if (result.rewrite?.changed || result.eligibility?.eligible === false) {
      await clearChiefOfStaffHygieneNeededMarker(coreDirectory);
      return;
    }
    if (result.eligibility?.eligible) {
      const existing = await readChiefOfStaffHygieneNeededMarker(coreDirectory);
      if (!existing) {
        return;
      }
      log.info(
        {
          reason: existing.reason,
          readmePath: existing.readmePath,
        },
        'Chief-of-Staff hygiene marker retained for next modifying window',
      );
    }
  } catch (error) {
    log.warn({ err: error }, 'Failed to update Chief-of-Staff hygiene marker after run');
  }
}

async function isSymlinkedChiefOfStaffTarget(
  candidateDirectory: string,
  readmePath: string,
): Promise<boolean> {
  try {
    const directoryStat = await fsp.lstat(candidateDirectory);
    if (directoryStat.isSymbolicLink()) {
      return true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    const readmeStat = await fsp.lstat(readmePath);
    return readmeStat.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function isChiefOfStaffSpace(space: SpaceConfig): boolean {
  return space.type === 'chief-of-staff'
    || normalizeSpacePath(space.path) === 'chief-of-staff'
    || normalizeSpacePath(space.name) === 'chief-of-staff';
}

function normalizeSpacePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}


