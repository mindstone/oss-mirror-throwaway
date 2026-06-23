/**
 * Cloud capability probe — synchronous accessor for the last-seen server
 * capabilities, injected at bootstrap. Lives in `src/core/` so producers
 * inside the platform-agnostic agent loop can gate optional features
 * (e.g. content-ref offloading) without taking a hard dependency on
 * `cloud-client`. Returns `null` when no probe has been wired (e.g. in
 * test setups) or when capabilities have not yet been negotiated.
 *
 * See `docs/plans/260518_cloud_sync_reconciliation_hardening.md` § Stage B1a.
 */

export type CloudCapabilityProbe = () => readonly string[] | null;

let _probe: CloudCapabilityProbe | null = null;

export function setCloudCapabilityProbe(probe: CloudCapabilityProbe): void {
  _probe = probe;
}

export function clearCloudCapabilityProbeForTesting(): void {
  _probe = null;
}

export function peekCloudCapabilities(): readonly string[] | null {
  if (!_probe) return null;
  return _probe();
}

export function isCloudCapabilityAdvertised(name: string): boolean {
  const snapshot = peekCloudCapabilities();
  if (!snapshot) return false;
  return snapshot.includes(name);
}
