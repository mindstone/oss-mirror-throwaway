/**
 * CapabilityRegistry — per-app capability catalogue (Stage 3).
 *
 * Apps advertise which capabilities they support during `register`; the
 * RebelAppBridge MCP server and the HTTP relay consult this registry to
 * decide whether to forward a command. Stage 3 wires the WS server to
 * populate the registry on `register` and clear it on `disconnect`.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import type { AppType, CapabilityDescriptor } from '../shared/protocol';

export class CapabilityRegistry<TApp extends string = AppType> {
  private readonly byApp = new Map<TApp, Map<string, CapabilityDescriptor>>();

  /** Replace all capabilities advertised by `appId`. */
  register(appId: TApp, capabilities: readonly CapabilityDescriptor[]): void {
    const map = new Map<string, CapabilityDescriptor>();
    for (const cap of capabilities) {
      map.set(cap.id, cap);
    }
    this.byApp.set(appId, map);
  }

  /** Remove everything advertised by `appId`. */
  unregister(appId: TApp): void {
    this.byApp.delete(appId);
  }

  /** True if `appId` advertised `capabilityId`. */
  has(appId: TApp, capabilityId: string): boolean {
    const map = this.byApp.get(appId);
    return map ? map.has(capabilityId) : false;
  }

  /** The set of currently-registered app ids. */
  listAppIds(): readonly TApp[] {
    return Array.from(this.byApp.keys());
  }

  /**
   * Return the capability list for `appId`, or `undefined` when the app is
   * not registered. Used by the HTTP relay / MCP server to decide between
   * `APP_NOT_CONNECTED` and `CAPABILITY_NOT_SUPPORTED`.
   */
  getCapabilities(appId: TApp): readonly CapabilityDescriptor[] | undefined {
    const map = this.byApp.get(appId);
    if (!map) {
      return undefined;
    }
    return Array.from(map.values());
  }

  /**
   * Alias of `getCapabilities` retained for symmetry with earlier drafts.
   * Returns an empty array (not `undefined`) when no app is registered.
   */
  listCapabilities(appId: TApp): readonly CapabilityDescriptor[] {
    const map = this.byApp.get(appId);
    return map ? Array.from(map.values()) : [];
  }
}
