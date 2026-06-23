/**
 * Boot Success Marker
 *
 * Schedules the post-grace work that proves the current boot is healthy:
 *   1. Writes a Last-Known-Good record (rotating the previous LKG into
 *      `previousLastKnownGood`).
 *   2. Clears `bootPending` in the boot-state store.
 *
 * The grace period (default 30s, override with `REBEL_BOOT_GRACE_MS`) gives
 * the server time to fail after `server.listen()` resolves — for example, a
 * background scheduler that throws ~5s after listen would otherwise be
 * mis-recorded as healthy if we stamped LKG synchronously inside the listen
 * callback. See Decision D9 of
 * docs/plans/260510_cloud_image_rollback_defense_in_depth.md.
 *
 * The cross-boot pre-bootstrap watchdog (Stage C2) reads the records written
 * by this module on the NEXT boot. Stage C1 in isolation simply writes the
 * marker; it has no observable behavior change without the watchdog. That
 * is intentional — separating "record what healthy looks like" from "react
 * to a missing record" keeps each commit's blast radius small.
 *
 * Intentionally narrow imports — `node:process` plus the two boundary
 * stores. Errors during the marker write are caught and reported via the
 * injected `log` callback; they never crash the running server.
 */

import type { BootStateStore } from './bootStateStore';
import type {
  LastKnownGoodImageTagStore,
  LkgRecord,
} from './lastKnownGoodImageTagStore';
import { LKG_RECORD_VERSION } from './lastKnownGoodImageTagStore';

export const DEFAULT_BOOT_GRACE_MS = 30_000;

export interface BootSuccessMarkerDeps {
  imageTag: string;
  buildCommit: string;
  schemaFingerprint: string;
  lkgStore: LastKnownGoodImageTagStore;
  bootStateStore: BootStateStore;
  /** Override the grace duration. Tests pass small values. */
  graceMs?: number;
  /** Schedule primitive. Defaults to global `setTimeout` (production). */
  schedule?: (cb: () => void, ms: number) => { cancel(): void };
  /** Clock source. Defaults to `Date.now`. */
  now?: () => number;
  /** Logger callback. Receives structured records; defaults to a no-op. */
  log?: (event: BootSuccessMarkerEvent) => void;
}

export type BootSuccessMarkerEvent =
  | { kind: 'scheduled'; graceMs: number; imageTag: string }
  | { kind: 'cancelled' }
  | { kind: 'marker-written'; imageTag: string }
  | { kind: 'marker-failed'; error: string };

export interface BootSuccessMarkerHandle {
  /** Cancel the pending marker. Safe to call multiple times. */
  cancel(): void;
  /** Run the marker logic synchronously. Used by tests and graceful shutdown. */
  runNow(): void;
}

function defaultSchedule(cb: () => void, ms: number): { cancel(): void } {
  const handle = setTimeout(cb, ms);
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    (handle as { unref: () => void }).unref();
  }
  return {
    cancel(): void {
      clearTimeout(handle);
    },
  };
}

export function scheduleBootSuccessMarker(
  deps: BootSuccessMarkerDeps,
): BootSuccessMarkerHandle {
  const graceMs = Math.max(0, deps.graceMs ?? DEFAULT_BOOT_GRACE_MS);
  const log = deps.log ?? (() => {});
  const schedule = deps.schedule ?? defaultSchedule;
  const now = deps.now ?? Date.now;

  let cancelled = false;
  let executed = false;

  const performMarker = (): void => {
    if (cancelled || executed) return;
    executed = true;

    try {
      const previous = deps.lkgStore.read();
      const nextRecord: LkgRecord = {
        version: LKG_RECORD_VERSION,
        imageTag: deps.imageTag,
        buildCommit: deps.buildCommit,
        schemaFingerprint: deps.schemaFingerprint,
        recordedAt: now(),
        previousLastKnownGood:
          previous !== null && previous.imageTag !== deps.imageTag
            ? {
                imageTag: previous.imageTag,
                schemaFingerprint: previous.schemaFingerprint,
                recordedAt: previous.recordedAt,
              }
            : (previous?.previousLastKnownGood ?? null),
      };

      deps.lkgStore.write(nextRecord);
      deps.bootStateStore.clearBootPending(deps.imageTag, now());
      log({ kind: 'marker-written', imageTag: deps.imageTag });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log({ kind: 'marker-failed', error: message });
    }
  };

  const handle = schedule(performMarker, graceMs);
  log({ kind: 'scheduled', graceMs, imageTag: deps.imageTag });

  return {
    cancel(): void {
      if (cancelled || executed) return;
      cancelled = true;
      handle.cancel();
      log({ kind: 'cancelled' });
    },
    runNow(): void {
      handle.cancel();
      performMarker();
    },
  };
}
