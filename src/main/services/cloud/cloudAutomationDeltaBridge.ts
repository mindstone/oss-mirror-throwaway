/**
 * Cloud Automation Delta Bridge
 *
 * Glue between the cloud event channel and the desktop automation scheduler
 * for slim cloud→desktop delta merges (`automation:cloud-delta`). Lives in a
 * dedicated module so `cloudEventChannel.ts` can dynamically import it without
 * pulling the full automation scheduler into the ws/event critical path.
 *
 * Wired once at startup from `src/main/index.ts` after the scheduler is
 * constructed. See `docs-private/investigations/260515_cloud_automation_bugs.md`
 * § BUG 1+11.
 */

import { createScopedLogger } from '@core/logger';
import type { CloudAutomationDelta } from '@shared/types';
import type { AutomationScheduler } from '../automationScheduler';

const log = createScopedLogger({ service: 'cloudAutomationDeltaBridge' });

let schedulerGetter: (() => AutomationScheduler) | null = null;

export function setAutomationSchedulerForCloudDelta(getter: () => AutomationScheduler): void {
  schedulerGetter = getter;
}

export function applyAutomationCloudDelta(delta: CloudAutomationDelta): void {
  if (!schedulerGetter) {
    log.warn(
      { deltaType: delta.type, automationId: delta.automationId },
      'Cloud automation delta arrived before scheduler getter was wired; ignoring',
    );
    return;
  }
  try {
    schedulerGetter().applyCloudDelta(delta);
  } catch (err) {
    log.warn(
      { err, deltaType: delta.type, automationId: delta.automationId },
      'Failed to apply cloud automation delta',
    );
  }
}
