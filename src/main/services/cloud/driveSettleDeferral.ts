import fs from 'node:fs';
import path from 'node:path';
import { toPortablePath } from '@core/utils/portablePath';

export const DRIVE_SETTLE_MAX_DEFERRALS = 5;
export const DRIVE_SETTLE_MAX_AGE_MS = 15 * 60 * 1000;

export type DriveSettleAction = 'defer' | 'force_pull' | 'delivered';

export interface DriveSettleDecision {
  action: DriveSettleAction;
  deferralCount: number;
  ageMs: number;
  firstDeferredAt: number | null;
}

export interface ActiveDriveSettleDeferral {
  relativePath: string;
  deferralCount: number;
  firstDeferredAt: number;
  ageMs: number;
}

interface DriveSettleDeferralState {
  firstDeferredAt: number;
  deferralCount: number;
}

const CASE_INSENSITIVE_PLATFORMS = new Set(['darwin', 'win32']);
const driveSettleDeferrals = new Map<string, DriveSettleDeferralState>();

function normalizePathForKey(inputPath: string): string {
  const portable = toPortablePath(inputPath).normalize('NFC');
  if (CASE_INSENSITIVE_PLATFORMS.has(process.platform)) {
    return portable.toLowerCase();
  }
  return portable;
}

function normalizeRelativePath(inputPath: string): string {
  const portable = toPortablePath(inputPath).normalize('NFC').replace(/^\/+/, '');
  if (CASE_INSENSITIVE_PLATFORMS.has(process.platform)) {
    return portable.toLowerCase();
  }
  return portable;
}

function buildDeferralKey(coreDirectory: string, relativePath: string): string {
  const normalizedWorkspace = normalizePathForKey(path.resolve(coreDirectory));
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  return `${normalizedWorkspace}::${normalizedRelativePath}`;
}

export function evaluateDriveSettleDeferral(params: {
  coreDirectory: string;
  relativePath: string;
  localPath: string;
  nowMs?: number;
}): DriveSettleDecision {
  const nowMs = params.nowMs ?? Date.now();
  const key = buildDeferralKey(params.coreDirectory, params.relativePath);
  const existing = driveSettleDeferrals.get(key);

  if (fs.existsSync(params.localPath)) {
    driveSettleDeferrals.delete(key);
    if (!existing) {
      return {
        action: 'delivered',
        deferralCount: 0,
        ageMs: 0,
        firstDeferredAt: null,
      };
    }
    return {
      action: 'delivered',
      deferralCount: existing.deferralCount,
      ageMs: Math.max(0, nowMs - existing.firstDeferredAt),
      firstDeferredAt: existing.firstDeferredAt,
    };
  }

  if (!existing) {
    driveSettleDeferrals.set(key, {
      firstDeferredAt: nowMs,
      deferralCount: 1,
    });
    return {
      action: 'defer',
      deferralCount: 1,
      ageMs: 0,
      firstDeferredAt: nowMs,
    };
  }

  const deferralCount = existing.deferralCount + 1;
  const ageMs = Math.max(0, nowMs - existing.firstDeferredAt);
  driveSettleDeferrals.set(key, {
    firstDeferredAt: existing.firstDeferredAt,
    deferralCount,
  });

  const shouldForcePull = deferralCount > DRIVE_SETTLE_MAX_DEFERRALS || ageMs >= DRIVE_SETTLE_MAX_AGE_MS;
  return {
    action: shouldForcePull ? 'force_pull' : 'defer',
    deferralCount,
    ageMs,
    firstDeferredAt: existing.firstDeferredAt,
  };
}

export function getActiveDriveSettleDeferrals(
  coreDirectory: string,
  nowMs = Date.now(),
): ActiveDriveSettleDeferral[] {
  const workspacePrefix = `${normalizePathForKey(path.resolve(coreDirectory))}::`;
  const activeDeferrals: ActiveDriveSettleDeferral[] = [];

  for (const [key, state] of driveSettleDeferrals) {
    if (!key.startsWith(workspacePrefix)) continue;
    const relativePath = key.slice(workspacePrefix.length);
    if (!relativePath) continue;

    activeDeferrals.push({
      relativePath,
      deferralCount: state.deferralCount,
      firstDeferredAt: state.firstDeferredAt,
      ageMs: Math.max(0, nowMs - state.firstDeferredAt),
    });
  }

  activeDeferrals.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return activeDeferrals;
}

export function clearDriveSettleDeferral(coreDirectory: string, relativePath: string): void {
  driveSettleDeferrals.delete(buildDeferralKey(coreDirectory, relativePath));
}

export function _resetDriveSettleDeferralsForTesting(): void {
  driveSettleDeferrals.clear();
}
