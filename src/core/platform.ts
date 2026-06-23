/**
 * PlatformConfig — platform-agnostic configuration interface.
 *
 * Replaces direct `app.getPath()`, `app.getVersion()`, etc. calls.
 * Set once at startup by the host environment (Electron or cloud).
 */

/**
 * Deployment surface the core modules are running on. Used by features that
 * must only activate on one surface — e.g. the App Bridge listens on a local
 * HTTP/WS port, which only makes sense on a user's desktop (R34 in
 * docs/plans/260418_rebel_app_bridge_and_browser_extension.md).
 */
export type PlatformSurface = 'desktop' | 'cloud' | 'mobile' | 'cli';

/**
 * Typed capability manifest for the current host surface. Lets feature code
 * gate on a specific capability (e.g. `capabilities.appBridgeServer`) rather
 * than scattering `surface !== 'desktop'` checks across the codebase.
 *
 * Currently used by 7 gate sites. Add new flags only when a real gate site
 * needs them — do not add speculative future flags.
 *
 * To add a new capability:
 *   1. Add the field to {@link SurfaceCapabilities} below.
 *   2. Add the desktop/cloud/mobile values in {@link defaultCapabilities}.
 *   3. Update the consumer to read `getPlatformConfig().capabilities.<flag>`.
 *   4. Update the defaults-table test at `@core/__tests__/platform.test.ts`.
 */
export interface SurfaceCapabilities {
  /** Desktop: HTTP/WS server for browser-extension app bridge. */
  readonly appBridgeServer: boolean;
  /** Desktop: Microsoft Office add-in sidecar process. */
  readonly officeSidecar: boolean;
  /**
   * Host has read/write access to a local filesystem the user owns.
   * Covers: space-maintenance startup cleanup, drive-history migration,
   * attachment source-path resolution (originalPath OR temp file under app data).
   * True on desktop and standalone CLI; false on cloud and mobile.
   */
  readonly localFilesystemAccess: boolean;
  /**
   * Desktop/cloud: ability to spawn local subprocesses for bundled MCP servers
   * and media processing (ffmpeg, silence-boundary). True on desktop and cloud,
   * false on mobile.
   */
  readonly localSubprocessSpawn: boolean;
}

/**
 * Default capability set for a given surface. Single source of truth.
 *
 * Reviewer test at `@core/__tests__/platform.test.ts` asserts this exact table.
 */
export function defaultCapabilities(surface: PlatformSurface): SurfaceCapabilities {
  switch (surface) {
    case 'desktop':
      return {
        appBridgeServer: true,
        officeSidecar: true,
        localFilesystemAccess: true,
        localSubprocessSpawn: true,
      };
    case 'cloud':
      return {
        appBridgeServer: false,
        officeSidecar: false,
        localFilesystemAccess: false,
        localSubprocessSpawn: true,
      };
    case 'cli':
      return {
        appBridgeServer: false,
        officeSidecar: false,
        localFilesystemAccess: true,
        localSubprocessSpawn: true,
      };
    case 'mobile':
      return {
        appBridgeServer: false,
        officeSidecar: false,
        localFilesystemAccess: false,
        localSubprocessSpawn: false,
      };
    default: {
      const _exhaustive: never = surface;
      throw new Error(`Unknown surface: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Subset of Electron's `ProcessMetric` consumed by the agent-turn watchdog.
 *
 * Strongly-typed alias (NOT `unknown[]`) so consumers get autocomplete and
 * the watchdog's structured-log payload stays type-checked. Electron's full
 * `ProcessMetric` is a structural superset, so `app.getAppMetrics()` is
 * directly assignable on desktop.
 */
export interface ProcessMetricSubset {
  type: string;
  pid: number;
  cpu: { percentCPUUsage: number };
  memory: { workingSetSize: number };
  name?: string;
}

export interface PlatformConfig {
  userDataPath: string;
  appPath: string;
  tempPath: string;
  logsPath: string;
  homePath: string;
  documentsPath: string;
  desktopPath: string;
  appDataPath: string;
  version: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  /** Total system RAM in bytes (from os.totalmem()). Used for local model recommendations. */
  totalMemoryBytes: number;
  /** CPU architecture (from process.arch), e.g. 'arm64', 'x64'. Used for local inference binary selection. */
  arch: string;
  /**
   * Deployment surface — populated by each host bootstrap.
   * `'desktop'` in Electron, `'cloud'` in cloud-service, `'mobile'` in the
   * React Native app. Features like the App Bridge gate on this value.
   */
  surface: PlatformSurface;
  /**
   * True when this is an OSS (community) build, false for the enterprise/cloud
   * build. Set EXACTLY ONCE per surface at host bootstrap, before any core
   * module imports; never mutated thereafter.
   *
   * REQUIRED (not auto-derived): each host bootstrap must supply intent —
   * desktop maps it from `PRIVATE_MINDSTONE_BOOTSTRAP_MODE === 'stub'`
   * (via the pure `@private/mindstone/mode` module); cloud/CLI/eval/test
   * harnesses set `false` (they model enterprise infra). Making it required
   * means a forgotten surface fails to compile rather than silently defaulting
   * to "enterprise" — which is the high-blast failure mode this seam guards.
   *
   * Stage 1 (260607_oss-b6-launch-polish) introduces the seam only; no module
   * consumes it behaviourally yet (Stages 2-4 do).
   */
  isOss: boolean;
  /**
   * Typed capability manifest for this surface. Auto-derived from `surface`
   * by {@link setPlatformConfig} when the caller doesn't supply an explicit
   * override. Always defined on the value returned from {@link getPlatformConfig}.
   */
  capabilities: SurfaceCapabilities;
  /**
   * Optional process-metrics accessor for diagnostic reporting. Desktop wires
   * Electron's `app.getAppMetrics()`. Cloud wires `() => []`. Mobile leaves
   * unwired (undefined) — consumers null-guard via the `?.` short-circuit.
   */
  getAppMetrics?: () => ProcessMetricSubset[];
}

/**
 * Input type accepted by {@link setPlatformConfig}. `capabilities` is optional:
 * when omitted, {@link defaultCapabilities}`(surface)` is used. The output type
 * {@link PlatformConfig} always has `capabilities` defined.
 */
export type PlatformConfigInput = Omit<PlatformConfig, 'capabilities'> & {
  capabilities?: SurfaceCapabilities;
};

let _config: PlatformConfig | undefined;

export function setPlatformConfig(config: PlatformConfigInput): void {
  _config =
    config.capabilities !== undefined
      ? (config as PlatformConfig)
      : { ...config, capabilities: defaultCapabilities(config.surface) };
}

export function getPlatformConfig(): PlatformConfig {
  if (!_config) {
    throw new Error(
      'PlatformConfig not initialized. Call setPlatformConfig() before importing core modules.',
    );
  }
  return _config;
}
