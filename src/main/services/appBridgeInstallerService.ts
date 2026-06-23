import { app, shell } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createScopedLogger } from '../../core/logger';
import type { ErrorReporter } from '../../core/errorReporter';
import { BROWSER_DEFS, detectBrowsers, DetectedBrowser, BrowserId } from '../../core/appBridge/installer/browserDetect';
import type {
  HostToolReason,
  HostToolResult,
} from '../../core/appBridge/installer/hostToolContracts';
import {
  BOOT_TOKEN_FILENAME,
  readBootTokenFile,
  writeBootTokenFile,
} from '../../core/appBridge/installer/bootToken';
import {
  readManifest,
  planExtraction,
  readExtractionState,
  writeExtractionState,
  computeExtensionSourceHash,
  EXTRACTION_STATE_FILENAME,
  type ExtractionState,
} from '../../core/appBridge/installer/extensionFolder';
import { installEvent } from '../../core/appBridge/shared/installEvent';
import { buildNmhManifests } from '../../core/appBridge/installer/nmhManifest';
import { isBrowserRunning } from './browserProbe';
import { installFunnelStats } from './installFunnelStats';

const log = createScopedLogger({ service: 'appBridgeInstallerService' });

const GENERIC_BROWSER_ID = 'none-of-the-above' as const;
const GENERIC_EXTENSION_DIR = 'generic' as const;
const GENERIC_EXTENSIONS_PAGE_URL = 'chrome://extensions' as const;
const PREPARE_INSTALL_STEP_TIMEOUT_MS = {
  extract_extension: 15_000,
  reveal_extension_folder: 5_000,
  open_extensions_page: 10_000,
} satisfies Record<
  'extract_extension' | 'reveal_extension_folder' | 'open_extensions_page',
  number
>;

const EXTENSIONS_PAGE_URLS = Object.fromEntries(
  BROWSER_DEFS.map((browser) => [browser.id, browser.extensionsPageUrl]),
) as Partial<Record<BrowserId, string>>;
const BROWSER_DEF_MAP = new Map<BrowserId, (typeof BROWSER_DEFS)[number]>(
  BROWSER_DEFS.map((browser) => [browser.id, browser]),
);

type StructuredUnsupportedBrowserResult = HostToolResult<never> & {
  ok: false;
  reason: 'unsupported-browser';
  retryable: false;
};

class PrepareInstallStepTimeoutError extends Error {
  constructor(
    readonly step: PrepareInstallStep['name'],
    readonly timeoutMs: number,
  ) {
    super(`prepare-install step ${step} timed out after ${timeoutMs}ms`);
    this.name = 'PrepareInstallStepTimeoutError';
  }
}

export interface AppBridgeInstallerDiagnoseContext {
  isBridgeReachable: () => boolean;
  getActiveInstallSessions: () => ReadonlyArray<{
    installSessionId: string;
    browserId?: string;
  }>;
  hasActiveInstallSession?: (installSessionId: string) => boolean;
  hasAnyActiveInstallSessionForBrowser?: (browserId: BrowserId) => boolean;
  getActiveInstallSessionForBrowser?: (browserId: BrowserId) => string | undefined;
}

export interface AppBridgeInstallDiagnosis {
  browserRunning: boolean;
  extensionExtracted: boolean;
  recentInstallBreadcrumbCount: number;
  recentInstallFailureCount: number;
  lastFailureReason: HostToolReason | null;
  bridgeReachable: boolean;
  pairSessionActive: boolean;
}

type OpenExtensionsPageFailureReason =
  | 'browser-not-running'
  | 'launch-failed'
  | 'unknown-browser-id'
  | 'unsupported-browser'
  | 'no-default-browser'
  | 'open-failed';

export type OpenExtensionsPageResult =
  | { ok: true }
  | {
      ok: false;
      reason: OpenExtensionsPageFailureReason | string;
      fallbackUrl?: string;
      userMessage?: string;
      instructions?: string;
      retryable?: boolean;
    };

type RevealExtensionFolderResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      userMessage?: string;
      instructions?: string;
      retryable?: boolean;
    };

export type PrepareInstallSetupStatus =
  | 'needs_browser_choice'
  | 'prepared'
  | 'awaiting_user_handoff'
  | 'connected'
  | 'degraded'
  | 'failed';

export interface PrepareInstallStep {
  name: 'detect_browsers' | 'extract_extension' | 'reveal_extension_folder' | 'open_extensions_page';
  ok: boolean;
  status?: 'completed' | 'skipped' | 'failed';
  reason?: string;
  retryable?: boolean;
}

export interface PrepareInstallData {
  attemptId: string;
  setupStatus: PrepareInstallSetupStatus;
  selectedBrowser?: {
    id: BrowserId;
    displayName: string;
    extensionsPageUrl: string;
  };
  browserChoices?: Array<{
    id: BrowserId;
    displayName: string;
    extensionsPageUrl: string;
  }>;
  pairSessionId?: string;
  nextStep: string;
  steps: PrepareInstallStep[];
}

export type PrepareInstallResult = HostToolResult<PrepareInstallData>;

function classifyOpenExtensionsPageFailure(error: unknown): Exclude<
  OpenExtensionsPageFailureReason,
  'unsupported-browser' | 'unknown-browser-id'
> {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const errCode = (error as NodeJS.ErrnoException | undefined)?.code;

  if (normalized.includes('not running')) {
    return 'browser-not-running';
  }
  if (
    normalized.includes('no default browser') ||
    normalized.includes('default browser') ||
    normalized.includes('default application') ||
    normalized.includes('no application')
  ) {
    return 'no-default-browser';
  }
  if (errCode === 'ENOENT' || normalized.includes('not found')) {
    return 'launch-failed';
  }
  return 'open-failed';
}

export interface AppBridgeInstallerServiceDeps {
  app: Pick<typeof app, 'getPath' | 'isPackaged'>;
  shell: Pick<typeof shell, 'showItemInFolder' | 'openExternal'>;
  fs: typeof fs;
  processPlatform: NodeJS.Platform;
  processCwd: () => string;
  processResourcesDir?: string;
  isPackaged: boolean;
  /** Env lookup for `HOME` / `USERPROFILE`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  browserProbe?: (browserId: BrowserId) => Promise<boolean>;
  diagnosticsContext?: AppBridgeInstallerDiagnoseContext;
}

interface BridgeRuntimeStateSnapshot {
  routerToken: string;
  port: number;
  startedAt: string;
  bridgeOrigin: string;
  /**
   * Flat list of revoked `installSessionId` strings parsed from
   * `state.json`'s `installSessionDenylist` array. Callers do not need the
   * `revokedAt` timestamps — they only need to know whether a given id has
   * been revoked so they can mint a fresh one in its place.
   */
  installSessionDenylistIds: readonly string[];
}

export interface RegenerateBootTokenFilesResult {
  ok: boolean;
  rewritten: number;
  skipped: number;
  /**
   * How many target dirs kept their existing `installSessionId` unchanged
   * (file already existed and the id was not in the denylist). A nice
   * operability signal: on a healthy app launch, `preserved` should equal
   * the number of extracted extensions and `rewritten` should be >= that
   * value (every file gets a fresh routerToken; only the id is preserved).
   */
  preserved?: number;
  reason?: string;
}

export class AppBridgeInstallerService {
  private diagnosticsContext?: AppBridgeInstallerDiagnoseContext;

  constructor(private deps: AppBridgeInstallerServiceDeps) {
    this.diagnosticsContext = deps.diagnosticsContext;
  }

  setDiagnoseContext(context: AppBridgeInstallerDiagnoseContext): void {
    this.diagnosticsContext = context;
  }

  private getResolvedInstallSessionId(
    browserId: BrowserId,
    installSessionId?: string,
  ): string | undefined {
    return (
      installSessionId ?? this.diagnosticsContext?.getActiveInstallSessionForBrowser?.(browserId)
    );
  }

  private getInstallFunnelTags(browserId: BrowserId, installSessionId?: string) {
    return {
      browserId,
      pairSessionId: this.getResolvedInstallSessionId(browserId, installSessionId),
    };
  }

  async detectBrowsers(): Promise<DetectedBrowser[]> {
    log.info({}, 'Detecting browsers');
    installFunnelStats.start('detect-browsers', {
      browserId: undefined,
      pairSessionId: undefined,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    let funnelReason = 'ok';
    try {
      const results = await detectBrowsers({
        platform: this.deps.processPlatform,
        fs: this.deps.fs,
        signal: controller.signal
      });
      log.info({ count: results.length }, 'Browser detection complete');
      return results;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      funnelReason = 'internal-error';
      log.error({ error: message }, 'Browser detection failed');
      throw error;
    } finally {
      clearTimeout(timer);
      installFunnelStats.end(
        'detect-browsers',
        {
          browserId: undefined,
          pairSessionId: undefined,
        },
        { reason: funnelReason },
      );
    }
  }

  private browserSummary(browserId: BrowserId, detectedBrowsers: DetectedBrowser[] = []) {
    const detected = detectedBrowsers.find((browser) => browser.id === browserId);
    const browserDef = BROWSER_DEF_MAP.get(browserId);
    return {
      id: browserId,
      displayName: detected?.displayName ?? browserDef?.displayName ?? browserId,
      extensionsPageUrl:
        detected?.extensionsPageUrl ??
        browserDef?.extensionsPageUrl ??
        GENERIC_EXTENSIONS_PAGE_URL,
    };
  }

  private stepFromResult(
    name: PrepareInstallStep['name'],
    result: { ok: boolean; reason?: string; retryable?: boolean },
  ): PrepareInstallStep {
    return result.ok
      ? { name, ok: true, status: 'completed' }
      : {
          name,
          ok: false,
          status: 'failed',
          reason: result.reason ?? 'unknown-error',
          retryable: result.retryable,
        };
  }

  private prepareFailure(
    args: {
      attemptId: string;
      reason: HostToolReason;
      userMessage: string;
      instructions: string;
      retryable: boolean;
      selectedBrowser?: PrepareInstallData['selectedBrowser'];
      browserChoices?: PrepareInstallData['browserChoices'];
      steps: PrepareInstallStep[];
    },
  ): PrepareInstallResult {
    return {
      ok: false,
      reason: args.reason,
      userMessage: args.userMessage,
      instructions: args.instructions,
      retryable: args.retryable,
      data: {
        attemptId: args.attemptId,
        setupStatus: 'failed',
        ...(args.selectedBrowser ? { selectedBrowser: args.selectedBrowser } : {}),
        ...(args.browserChoices ? { browserChoices: args.browserChoices } : {}),
        nextStep: args.instructions,
        steps: args.steps,
      },
    };
  }

  private prepareTimeoutResult(
    step: PrepareInstallStep['name'],
    timeoutMs: number,
  ) {
    log.warn(
      { step, timeoutMs },
      'Prepare-install step timed out',
    );
    return {
      ok: false,
      reason: 'timeout',
      userMessage: 'That install step took too long.',
      instructions: 'Give Rebel a moment, then try again. If it keeps happening, restart Rebel and retry.',
      retryable: true,
    } as const;
  }

  private async runPrepareStep<T>(
    step: keyof typeof PREPARE_INSTALL_STEP_TIMEOUT_MS,
    operation: () => Promise<T>,
  ): Promise<T> {
    const timeoutMs = PREPARE_INSTALL_STEP_TIMEOUT_MS[step];
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new PrepareInstallStepTimeoutError(step, timeoutMs)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async prepareInstall(browserId?: BrowserId): Promise<PrepareInstallResult> {
    const attemptId = `install_${randomUUID()}`;
    const steps: PrepareInstallStep[] = [];
    let detectedBrowsers: DetectedBrowser[];
    try {
      detectedBrowsers = await this.detectBrowsers();
      steps.push({ name: 'detect_browsers', ok: true, status: 'completed' });
    } catch {
      steps.push({
        name: 'detect_browsers',
        ok: false,
        status: 'failed',
        reason: 'internal-error',
        retryable: true,
      });
      return this.prepareFailure({
        attemptId,
        reason: 'internal-error',
        userMessage: "I couldn't check installed browsers right now.",
        instructions: 'Try again. If it keeps failing, restart Rebel and retry.',
        retryable: true,
        steps,
      });
    }

    if (!browserId) {
      const choices = detectedBrowsers.map((browser) =>
        this.browserSummary(browser.id as BrowserId, detectedBrowsers),
      );
      if (choices.length === 0) {
        return this.prepareFailure({
          attemptId,
          reason: 'browser-not-installed',
          userMessage: "I couldn't find a supported Chromium browser.",
          instructions:
            'Install a supported Chromium browser, or choose “Something else...” and load the Rebel extension manually.',
          retryable: false,
          browserChoices: [],
          steps,
        });
      }
      if (choices.length > 1) {
        return {
          ok: true,
          reason: 'ok',
          retryable: false,
          data: {
            attemptId,
            setupStatus: 'needs_browser_choice',
            browserChoices: choices,
            nextStep: 'Ask the user which browser to set up, then call rebel_bridge_prepare_install with browser_id.',
            steps,
          },
        };
      }
      browserId = choices[0]?.id;
    }

    if (!browserId) {
      return this.prepareFailure({
        attemptId,
        reason: 'browser-not-installed',
        userMessage: "I couldn't pick a browser to prepare.",
        instructions: 'Call rebel_bridge_list_browsers, then choose one of its browser ids.',
        retryable: false,
        steps,
      });
    }

    const selectedBrowser = this.browserSummary(browserId, detectedBrowsers);
    const extractResult = await this.runPrepareStep(
      'extract_extension',
      () => this.extractExtensionFolder(browserId),
    ).catch((error: unknown) => {
      if (error instanceof PrepareInstallStepTimeoutError) {
        return this.prepareTimeoutResult(error.step, error.timeoutMs);
      }
      throw error;
    });
    steps.push(this.stepFromResult('extract_extension', extractResult));
    if (!extractResult.ok) {
      const reason =
        extractResult.reason === 'timeout'
          ? 'timeout'
          : extractResult.reason === 'permission-denied'
            ? 'permission-denied'
            : extractResult.reason === 'unsupported-browser'
              ? 'unsupported-browser'
              : 'extract-failed';
      return this.prepareFailure({
        attemptId,
        reason,
        userMessage:
          reason === 'timeout'
            ? 'Preparing the Rebel Browser extension folder took too long.'
            : "I couldn't prepare the Rebel Browser extension folder.",
        instructions:
          reason === 'timeout'
            ? 'Give Rebel a moment, then try again. If it keeps happening, restart Rebel and retry.'
            : 'Try again. If it keeps failing, restart Rebel and retry.',
        retryable: reason !== 'unsupported-browser',
        selectedBrowser,
        steps,
      });
    }

    const revealResult = await this.runPrepareStep(
      'reveal_extension_folder',
      () => this.revealExtensionFolder(browserId),
    ).catch((error: unknown) => {
      if (error instanceof PrepareInstallStepTimeoutError) {
        return this.prepareTimeoutResult(error.step, error.timeoutMs);
      }
      throw error;
    });
    steps.push(this.stepFromResult('reveal_extension_folder', revealResult));

    const openResult = await this.runPrepareStep(
      'open_extensions_page',
      () => this.openBrowserExtensionsPage(browserId),
    ).catch((error: unknown) => {
      if (error instanceof PrepareInstallStepTimeoutError) {
        return this.prepareTimeoutResult(error.step, error.timeoutMs);
      }
      throw error;
    });
    steps.push(this.stepFromResult('open_extensions_page', openResult));

    const degraded = !revealResult.ok || !openResult.ok;
    const nextStep =
      'In the browser extensions page, enable Developer Mode if needed, then load the revealed Rebel Browser extension folder.';
    return {
      ok: true,
      reason: 'ok',
      retryable: false,
      data: {
        attemptId,
        setupStatus: degraded ? 'degraded' : 'awaiting_user_handoff',
        selectedBrowser,
        ...(typeof extractResult.pairSessionId === 'string'
          ? { pairSessionId: extractResult.pairSessionId }
          : {}),
        nextStep,
        steps,
      },
    };
  }

  private redactHome(p: string): string {
    const userData = this.deps.app.getPath('userData');
    return p.startsWith(userData) ? path.join('<userData>', path.relative(userData, p)) : p;
  }

  private getExtensionSourceDir(): string {
    if (this.deps.isPackaged) {
      return path.join(this.deps.processResourcesDir || '', 'browser-extension');
    }

    return path.resolve(this.deps.processCwd(), 'packages', 'browser-extension', 'dist');
  }

  private getExtensionsRootDir(): string {
    return path.join(this.deps.app.getPath('userData'), 'appBridge', 'extensions');
  }

  private getBridgeStateFilePath(): string {
    return path.join(
      this.deps.app.getPath('userData'),
      'mcp',
      'rebel-app-bridge',
      'state.json',
    );
  }

  private getExtensionTargetDir(browserId: BrowserId, manifestVersion?: string): string {
    const extensionsRoot = this.getExtensionsRootDir();
    if (browserId === GENERIC_BROWSER_ID) {
      if (!manifestVersion) {
        throw new Error('Generic extension target requires a manifest version');
      }

      return path.join(extensionsRoot, GENERIC_EXTENSION_DIR, manifestVersion);
    }

    return path.join(extensionsRoot, browserId);
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await this.deps.fs.stat(targetPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  private createInstallSessionId(): string {
    return `inst_${randomUUID()}`;
  }

  /**
   * Read the bridge's `state.json` and surface only the fields the installer
   * needs (routerToken, port, startedAt, and the install-session denylist).
   *
   * Canonical writer: `buildStatePayload` in `src/core/appBridge/server/bridge.ts`.
   * If the shape of `installSessionDenylist` entries or the state-file schema
   * changes there, update this parser in lockstep. The parse is intentionally
   * defensive — a shape mismatch degrades to "empty denylist" rather than
   * misbehaving, but a silent drift can still hide regressions.
   */
  private async readBridgeRuntimeState(): Promise<BridgeRuntimeStateSnapshot | null> {
    try {
      const raw = await this.deps.fs.readFile(this.getBridgeStateFilePath(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<{
        routerToken: unknown;
        port: unknown;
        startedAt: unknown;
        installSessionDenylist: unknown;
      }>;

      if (
        typeof parsed.routerToken !== 'string' ||
        parsed.routerToken.length === 0 ||
        typeof parsed.port !== 'number' ||
        !Number.isFinite(parsed.port) ||
        parsed.port <= 0 ||
        typeof parsed.startedAt !== 'string' ||
        parsed.startedAt.length === 0
      ) {
        return null;
      }

      const installSessionDenylistIds = Array.isArray(parsed.installSessionDenylist)
        ? parsed.installSessionDenylist.reduce<string[]>((acc, entry) => {
            if (
              entry &&
              typeof entry === 'object' &&
              typeof (entry as { installSessionId?: unknown }).installSessionId === 'string' &&
              ((entry as { installSessionId: string }).installSessionId.length) > 0
            ) {
              acc.push((entry as { installSessionId: string }).installSessionId);
            }
            return acc;
          }, [])
        : [];

      return {
        routerToken: parsed.routerToken,
        port: parsed.port,
        startedAt: parsed.startedAt,
        bridgeOrigin: `http://127.0.0.1:${parsed.port}`,
        installSessionDenylistIds,
      };
    } catch {
      return null;
    }
  }

  /**
   * Decide which `installSessionId` to write into a boot-token file during
   * regeneration. Preserving the existing id is critical: the browser
   * extension's service worker calls `chrome.runtime.reload()` whenever
   * it observes a changed on-disk `installSessionId`, so minting a new
   * id on every bridge start would trigger a full extension reload on
   * every Rebel launch. We only mint fresh when the existing id is
   * missing/corrupt or has been explicitly revoked (denylisted).
   *
   * The file-write test helper `setDiagnoseContext` is unrelated to this
   * — the denylist set is parsed straight from `state.json` bytes.
   */
  private resolveInstallSessionId(args: {
    existingId: string | null;
    denylistIds: ReadonlySet<string>;
  }): string {
    const { existingId, denylistIds } = args;
    if (existingId && !denylistIds.has(existingId)) {
      return existingId;
    }
    return this.createInstallSessionId();
  }

  private async writeBootTokenFileToDirectory(
    targetDir: string,
    runtimeState: BridgeRuntimeStateSnapshot,
    installSessionId: string,
  ): Promise<string> {
    const filePath = path.join(targetDir, BOOT_TOKEN_FILENAME);
    const chmod =
      'chmod' in this.deps.fs && typeof this.deps.fs.chmod === 'function'
        ? this.deps.fs.chmod.bind(this.deps.fs)
        : undefined;
    await writeBootTokenFile(
      {
        writeFile: (pathToWrite, contents, options) =>
          this.deps.fs.writeFile(pathToWrite, contents, options),
        ...(chmod ? { chmod } : {}),
      },
      filePath,
      {
        schemaVersion: 1,
        routerToken: runtimeState.routerToken,
        bridgeOrigin: runtimeState.bridgeOrigin,
        port: runtimeState.port,
        startedAt: runtimeState.startedAt,
        installSessionId,
      },
    );
    return filePath;
  }

  private async ensureBootTokenFileInDirectory(targetDir: string): Promise<string | null> {
    const bootTokenPath = path.join(targetDir, BOOT_TOKEN_FILENAME);
    try {
      const existing = await readBootTokenFile(
        (filePath, encoding) => this.deps.fs.readFile(filePath, encoding),
        bootTokenPath,
      );
      return existing.installSessionId;
    } catch {
      const runtimeState = await this.readBridgeRuntimeState();
      if (!runtimeState) {
        return null;
      }
      const installSessionId = this.createInstallSessionId();
      await this.writeBootTokenFileToDirectory(targetDir, runtimeState, installSessionId);
      return installSessionId;
    }
  }

  private assertBrowserSupportedOnPlatform(
    browserId: BrowserId,
  ): StructuredUnsupportedBrowserResult | null {
    if (browserId === GENERIC_BROWSER_ID) {
      return null;
    }

    const browser = BROWSER_DEF_MAP.get(browserId);
    const platform = this.deps.processPlatform;
    if (
      browser &&
      (platform === 'darwin' || platform === 'win32' || platform === 'linux') &&
      browser.supportedOnPlatforms.includes(platform)
    ) {
      return null;
    }

    const platformLabel = platform === 'darwin'
      ? 'macOS'
      : platform === 'win32'
        ? 'Windows'
        : platform === 'linux'
          ? 'Linux'
          : platform;

    return {
      ok: false,
      reason: 'unsupported-browser',
      userMessage: `Rebel doesn't support ${browser?.displayName ?? 'that browser'} on ${platformLabel} yet.`,
      instructions: 'Try installing Rebel in a different browser.',
      retryable: false,
    };
  }

  async extractExtensionFolder(browserId: BrowserId): Promise<
    { ok: true; targetDir: string; action: 'written' | 'skipped'; pairSessionId?: string } |
    { ok: false; reason: string }
  > {
    log.info({ browserId }, 'Extracting extension folder');
    installEvent(log, 'info', 'app-bridge.install.extract.start', { browserId });
    const funnelTags = this.getInstallFunnelTags(browserId);
    installFunnelStats.start('extract-extension', funnelTags);
    let stagingDir: string | undefined;
    let funnelReason = 'extract-failed';
    try {
      const unsupportedBrowser = this.assertBrowserSupportedOnPlatform(browserId);
      if (unsupportedBrowser) {
        funnelReason = 'unsupported-browser';
        return unsupportedBrowser;
      }

      const sourceDir = this.getExtensionSourceDir();
      const parent = this.getExtensionsRootDir();
      
      const sourceManifest = await readManifest(
        async (p) => this.deps.fs.readFile(p, 'utf-8'),
        path.join(sourceDir, 'manifest.json'),
      );

      if (!sourceManifest) {
        log.warn({ sourceDir: this.redactHome(sourceDir) }, 'Source manifest not found');
        funnelReason = 'extract-failed';
        return { ok: false, reason: 'missing-source-asset' };
      }

      const targetDir = this.getExtensionTargetDir(browserId, sourceManifest.version);

      const resolvedParent = path.resolve(parent);
      const resolvedTarget = path.resolve(targetDir);
      if (path.relative(resolvedParent, resolvedTarget).startsWith('..')) {
        funnelReason = 'internal-error';
        return { ok: false, reason: 'invalid-target-path' };
      }

      const targetManifest = await readManifest(
        async (p) => this.deps.fs.readFile(p, 'utf-8'),
        path.join(targetDir, 'manifest.json'),
      );

      // Read the existing marker (if any) and compute the fresh source
      // hash. A missing/corrupt marker is treated as "no state" and
      // forces a re-extract — intentional fail-safe for pre-marker
      // installs and partially-written targets.
      const existingState = await readExtractionState(
        async (p) => this.deps.fs.readFile(p, 'utf-8'),
        path.join(targetDir, EXTRACTION_STATE_FILENAME),
      );
      const newSourceHash = await computeExtensionSourceHash(sourceDir, {
        readdir: (p, opts) => this.deps.fs.readdir(p, opts) as Promise<
          Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
        >,
        readFile: (p) => this.deps.fs.readFile(p),
        pathJoin: path.join,
      });

      const plan = planExtraction({
        sourceDir,
        targetDir,
        existingManifest: targetManifest,
        newManifest: sourceManifest,
        existingState,
        newSourceHash,
      });

      log.info(
        {
          plan,
          sourceDir: this.redactHome(sourceDir),
          targetDir: this.redactHome(targetDir),
          newSourceHash,
          existingSourceHash: existingState?.sourceHash,
          existingSourceManifestVersion: existingState?.sourceManifestVersion,
        },
        'Extraction plan',
      );

      if (plan.action === 'write') {
        stagingDir = path.join(
          path.dirname(targetDir),
          `.${browserId}.incoming.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`,
        );
        try {
          await this.deps.fs.rm(stagingDir, { recursive: true, force: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn({ err: message, step: 'rm-staging' }, 'Pre-rename cleanup failed');
        }
        try {
          await this.deps.fs.mkdir(path.dirname(stagingDir), { recursive: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn({ err: message, step: 'mkdir-staging-parent' }, 'Failed to create staging parent dir');
        }
        await this.deps.fs.cp(sourceDir, stagingDir, { recursive: true });

        // Write the extraction-state marker INTO the staging dir before
        // rename. Whatever ends up at targetDir after rename is now
        // self-describing — there is no window where a fresh copy is in
        // place without a matching marker. The only failure mode is a
        // failed rename, which leaves the OLD targetDir untouched (its
        // old marker is still consistent with its content) or leaves
        // no targetDir at all (next call will see `target-missing`
        // and re-extract cleanly).
        const newState: ExtractionState = {
          schemaVersion: 1,
          sourceHash: newSourceHash,
          sourceManifestVersion: sourceManifest.version,
          extractedAt: Date.now(),
        };
        try {
          await writeExtractionState(
            async (p, content) => {
              await this.deps.fs.writeFile(p, content, 'utf-8');
            },
            path.join(stagingDir, EXTRACTION_STATE_FILENAME),
            newState,
          );
        } catch (err) {
          // Marker write failure is fatal for a write action — without
          // it, the next call would re-extract unnecessarily (pollution
          // of the skip path). We let the outer catch handle it so the
          // funnel reason is still structured.
          throw err;
        }

        const bridgeRuntimeState = await this.readBridgeRuntimeState();
        if (!bridgeRuntimeState) {
          log.warn(
            { browserId, stateFilePath: this.redactHome(this.getBridgeStateFilePath()) },
            'Bridge runtime state unavailable; cannot write boot-token file during extraction',
          );
          funnelReason = 'bridge-runtime-state-unavailable';
          return { ok: false, reason: 'bridge-runtime-state-unavailable' };
        }

        const installSessionId = this.createInstallSessionId();
        await this.writeBootTokenFileToDirectory(
          stagingDir,
          bridgeRuntimeState,
          installSessionId,
        );

        try {
          await this.deps.fs.rm(targetDir, { recursive: true, force: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn({ err: message, step: 'rm-target' }, 'Failed to remove target dir');
        }
        await this.deps.fs.rename(stagingDir, targetDir);
        funnelReason = 'ok';
        installEvent(log, 'info', 'app-bridge.install.extract.written', {
          browserId,
          newSourceHash,
          planReason: plan.reason,
        });
        return { ok: true, targetDir, action: 'written', pairSessionId: installSessionId };
      }

      funnelReason = 'ok';
      const installSessionId = await this.ensureBootTokenFileInDirectory(targetDir);
      installEvent(log, 'info', 'app-bridge.install.extract.skipped', {
        browserId,
        planReason: plan.reason,
      });
      return {
        ok: true,
        targetDir,
        action: 'skipped',
        ...(installSessionId ? { pairSessionId: installSessionId } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errCode = error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      log.error({ browserId, error: message }, 'Failed to extract extension');
      let reason = 'unknown-error';
      if (errCode === 'ENOSPC') reason = 'disk-full';
      else if (errCode === 'EPERM' || errCode === 'EACCES') reason = 'permission-denied';
      installEvent(log, 'error', 'app-bridge.install.extract.failed', {
        browserId,
        reason,
        errCode: typeof errCode === 'string' ? errCode : undefined,
      });
      funnelReason = reason === 'permission-denied' ? 'permission-denied' : 'extract-failed';
      return { ok: false, reason };
    } finally {
      if (stagingDir) {
        try {
          await this.deps.fs.rm(stagingDir, { recursive: true, force: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn({ err: message, step: 'rm-staging-finally' }, 'Post-rename cleanup failed');
        }
      }
      installFunnelStats.end(
        'extract-extension',
        funnelTags,
        { reason: funnelReason },
      );
    }
  }

  private async listChildDirectories(parentDir: string): Promise<string[]> {
    try {
      const entries = (await this.deps.fs.readdir(parentDir, {
        withFileTypes: true,
      })) as Array<string | { name: string; isDirectory(): boolean }>;

      return entries.flatMap((entry) => {
        if (typeof entry === 'string') {
          return [path.join(parentDir, entry)];
        }
        return entry.isDirectory() ? [path.join(parentDir, entry.name)] : [];
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async listExtractedExtensionDirs(
    browserIds: BrowserId[] | 'all',
  ): Promise<string[]> {
    const extensionsRoot = this.getExtensionsRootDir();
    const explicitBrowserIds = browserIds === 'all' ? null : [...new Set(browserIds)];
    const candidateDirs =
      explicitBrowserIds === null
        ? await (async () => {
            const topLevelDirs = await this.listChildDirectories(extensionsRoot);
            const resolved: string[] = [];
            for (const dir of topLevelDirs) {
              if (path.basename(dir) === GENERIC_EXTENSION_DIR) {
                resolved.push(...(await this.listChildDirectories(dir)));
                continue;
              }
              resolved.push(dir);
            }
            return resolved;
          })()
        : (
            await Promise.all(
              explicitBrowserIds.map(async (browserId) => {
                if (browserId === GENERIC_BROWSER_ID) {
                  return await this.listChildDirectories(
                    path.join(extensionsRoot, GENERIC_EXTENSION_DIR),
                  );
                }
                return [this.getExtensionTargetDir(browserId)];
              }),
            )
          ).flat();

    return [...new Set(candidateDirs)].filter((dir) => this.isWithinRoot(dir, extensionsRoot));
  }

  async regenerateBootTokenFiles(
    browserIds: BrowserId[] | 'all',
    errorReporter?: ErrorReporter,
  ): Promise<RegenerateBootTokenFilesResult> {
    const runtimeState = await this.readBridgeRuntimeState();
    if (!runtimeState) {
      const data = {
        browserIds: browserIds === 'all' ? 'all' : [...browserIds],
        stateFilePath: this.redactHome(this.getBridgeStateFilePath()),
      };
      log.warn(data, 'Bridge runtime state unavailable; skipping boot-token regeneration');
      errorReporter?.addBreadcrumb({
        category: 'app-bridge.install',
        level: 'warning',
        message: 'boot-token-regeneration-skipped',
        data,
      });
      return {
        ok: false,
        reason: 'bridge-runtime-state-unavailable',
        rewritten: 0,
        skipped: 0,
      };
    }

    const targetDirs = await this.listExtractedExtensionDirs(browserIds);
    const denylistIds = new Set(runtimeState.installSessionDenylistIds);
    let rewritten = 0;
    let skipped = 0;
    let preserved = 0;

    for (const targetDir of targetDirs) {
      const manifest = await readManifest(
        async (manifestPath) => this.deps.fs.readFile(manifestPath, 'utf-8'),
        path.join(targetDir, 'manifest.json'),
      );
      if (!manifest) {
        skipped += 1;
        continue;
      }

      let existingId: string | null = null;
      try {
        const existing = await readBootTokenFile(
          (filePath, encoding) => this.deps.fs.readFile(filePath, encoding),
          path.join(targetDir, BOOT_TOKEN_FILENAME),
        );
        existingId = existing.installSessionId;
      } catch {
        // Missing or corrupt boot-token file — treat as "no existing id"
        // so the resolver mints a fresh one. Not an error path: this is
        // the expected state for first-extract or after a revoke-induced
        // delete.
        existingId = null;
      }

      const resolvedId = this.resolveInstallSessionId({ existingId, denylistIds });
      const reusedExistingId = existingId !== null && resolvedId === existingId;

      try {
        await this.writeBootTokenFileToDirectory(targetDir, runtimeState, resolvedId);
        rewritten += 1;
        if (reusedExistingId) {
          preserved += 1;
        }
      } catch (error) {
        skipped += 1;
        const data = {
          targetDir: this.redactHome(targetDir),
          error: error instanceof Error ? error.message : String(error),
        };
        log.warn(data, 'Failed to regenerate boot-token file');
        errorReporter?.addBreadcrumb({
          category: 'app-bridge.install',
          level: 'warning',
          message: 'boot-token-regeneration-failed',
          data,
        });
      }
    }

    log.info(
      {
        browserIds: browserIds === 'all' ? 'all' : [...browserIds],
        rewritten,
        skipped,
        preserved,
      },
      'Boot-token regeneration finished',
    );

    return { ok: true, rewritten, skipped, preserved };
  }

  async revealExtensionFolder(browserId: BrowserId): Promise<RevealExtensionFolderResult> {
    log.info({ browserId }, 'Revealing extension folder');
    const funnelTags = this.getInstallFunnelTags(browserId);
    installFunnelStats.start('reveal-extension', funnelTags);
    let funnelReason = 'reveal-failed';
    try {
      const unsupportedBrowser = this.assertBrowserSupportedOnPlatform(browserId);
      if (unsupportedBrowser) {
        funnelReason = 'unsupported-browser';
        return unsupportedBrowser;
      }

      const parent = this.getExtensionsRootDir();
      let targetDir: string;
      if (browserId === GENERIC_BROWSER_ID) {
        const sourceManifest = await readManifest(
          async (manifestPath) => this.deps.fs.readFile(manifestPath, 'utf-8'),
          path.join(this.getExtensionSourceDir(), 'manifest.json'),
        );
        if (!sourceManifest) {
          return { ok: false, reason: 'missing-source-asset' };
        }
        targetDir = this.getExtensionTargetDir(browserId, sourceManifest.version);
      } else {
        targetDir = this.getExtensionTargetDir(browserId);
      }
      
      const resolvedParent = path.resolve(parent);
      const resolvedTarget = path.resolve(targetDir);
      if (path.relative(resolvedParent, resolvedTarget).startsWith('..')) {
        return { ok: false, reason: 'invalid-target-path' };
      }

      if (!(await this.pathExists(targetDir))) {
        return {
          ok: false,
          reason: 'reveal-failed',
          userMessage: "There's nothing to reveal yet. Extract the extension first.",
          instructions: 'Run rebel_bridge_extract_extension before rebel_bridge_reveal_extension_folder.',
          retryable: false,
        };
      }

      this.deps.shell.showItemInFolder(targetDir);
      funnelReason = 'ok';
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ browserId, error: message }, 'Failed to reveal folder');
      return { ok: false, reason: 'reveal-failed' };
    } finally {
      installFunnelStats.end(
        'reveal-extension',
        funnelTags,
        { reason: funnelReason },
      );
    }
  }

  async openBrowserExtensionsPage(browserId: BrowserId): Promise<OpenExtensionsPageResult> {
    log.info({ browserId }, 'Opening browser extensions page');
    const funnelTags = this.getInstallFunnelTags(browserId);
    installFunnelStats.start('open-extensions-page', funnelTags);
    let funnelReason = 'open-failed';
    const unsupportedBrowser = this.assertBrowserSupportedOnPlatform(browserId);
    if (unsupportedBrowser) {
      funnelReason = 'unsupported-browser';
      return unsupportedBrowser;
    }

    const fallbackUrl = browserId === GENERIC_BROWSER_ID
      ? GENERIC_EXTENSIONS_PAGE_URL
      : EXTENSIONS_PAGE_URLS[browserId];
    if (!fallbackUrl) {
      funnelReason = 'unsupported-browser';
      return { ok: false, reason: 'unsupported-browser' };
    }
    if (browserId === GENERIC_BROWSER_ID) {
      funnelReason = 'unknown-browser-id';
      return {
        ok: false,
        reason: 'unknown-browser-id',
        userMessage: "I don't know your browser, so open chrome://extensions manually.",
        instructions: "Paste chrome://extensions into your browser's address bar, then drag the Rebel extension folder into the page.",
        fallbackUrl,
        retryable: false,
      };
    }
    try {
      await this.deps.shell.openExternal(fallbackUrl);
      funnelReason = 'ok';
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = classifyOpenExtensionsPageFailure(error);
      funnelReason = reason;
      log.warn(
        { browserId, fallbackUrl, reason, error: message },
        'Failed to open external, providing fallback',
      );
      return { ok: false, reason, fallbackUrl };
    } finally {
      installFunnelStats.end(
        'open-extensions-page',
        funnelTags,
        { reason: funnelReason },
      );
    }
  }

  private async isExtensionExtracted(browserId: BrowserId): Promise<boolean> {
    // Diagnose reports "extracted" when:
    //   1. target manifest.version matches the source, AND
    //   2. the extraction-state marker exists with a matching source hash.
    // Condition 2 is what catches the stale-bundle bug — a folder whose
    // manifest.version happens to match the source but whose contents
    // are older will report `false` here and trigger re-extract guidance.
    try {
      const sourceDir = this.getExtensionSourceDir();
      const sourceManifest = await readManifest(
        async (manifestPath) => this.deps.fs.readFile(manifestPath, 'utf-8'),
        path.join(sourceDir, 'manifest.json'),
      );
      if (!sourceManifest) {
        return false;
      }

      const targetDir = this.getExtensionTargetDir(browserId, sourceManifest.version);
      const targetManifest = await readManifest(
        async (manifestPath) => this.deps.fs.readFile(manifestPath, 'utf-8'),
        path.join(targetDir, 'manifest.json'),
      );
      if (targetManifest?.version !== sourceManifest.version) {
        return false;
      }

      const existingState = await readExtractionState(
        async (p) => this.deps.fs.readFile(p, 'utf-8'),
        path.join(targetDir, EXTRACTION_STATE_FILENAME),
      );
      if (!existingState) {
        // Pre-v1 install or partial write. Treat as "not extracted"
        // so the next extractExtensionFolder() call refreshes.
        return false;
      }

      const sourceHash = await computeExtensionSourceHash(sourceDir, {
        readdir: (p, opts) => this.deps.fs.readdir(p, opts) as Promise<
          Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
        >,
        readFile: (p) => this.deps.fs.readFile(p),
        pathJoin: path.join,
      });
      return existingState.sourceHash === sourceHash;
    } catch (error) {
      log.warn(
        {
          browserId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to inspect extracted extension state during diagnose',
      );
      return false;
    }
  }

  async revertExtractionArtifacts(args: {
    browserId?: BrowserId;
    sessionStartedAt?: number;
  }): Promise<{ removed: boolean }> {
    const { browserId, sessionStartedAt } = args;
    if (!browserId || sessionStartedAt === undefined) {
      return { removed: false };
    }

    try {
      let targetDir: string;
      if (browserId === GENERIC_BROWSER_ID) {
        const sourceManifest = await readManifest(
          async (manifestPath) => this.deps.fs.readFile(manifestPath, 'utf-8'),
          path.join(this.getExtensionSourceDir(), 'manifest.json'),
        );
        if (!sourceManifest) {
          return { removed: false };
        }
        targetDir = this.getExtensionTargetDir(browserId, sourceManifest.version);
      } else {
        targetDir = this.getExtensionTargetDir(browserId);
      }

      if (!this.isWithinRoot(targetDir, this.getExtensionsRootDir())) {
        return { removed: false };
      }

      const stats = await this.deps.fs.stat(targetDir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return null;
        }
        throw error;
      });
      if (!stats) {
        return { removed: false };
      }
      if (typeof stats.mtimeMs !== 'number' || stats.mtimeMs < sessionStartedAt) {
        return { removed: false };
      }

      await this.deps.fs.rm(targetDir, { recursive: true, force: true });
      return { removed: true };
    } catch (error) {
      log.warn(
        {
          browserId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to revert extracted app-bridge artifacts',
      );
      return { removed: false };
    }
  }

  private hasActiveInstallSession(browserId: BrowserId, installSessionId?: string): boolean {
    if (installSessionId !== undefined) {
      if (this.diagnosticsContext?.hasActiveInstallSession) {
        return this.diagnosticsContext.hasActiveInstallSession(installSessionId);
      }

      const activeInstallSessions = this.diagnosticsContext?.getActiveInstallSessions() ?? [];
      return activeInstallSessions.some(
        (session) => session.installSessionId === installSessionId,
      );
    }

    if (this.diagnosticsContext?.hasAnyActiveInstallSessionForBrowser) {
      return this.diagnosticsContext.hasAnyActiveInstallSessionForBrowser(browserId);
    }

    const activeInstallSessions = this.diagnosticsContext?.getActiveInstallSessions() ?? [];
    return activeInstallSessions.some(
      (session) => session.browserId != null && session.browserId === browserId,
    );
  }

  async diagnose(args: {
    browserId: BrowserId;
    pairSessionId?: string;
  }): Promise<AppBridgeInstallDiagnosis> {
    const browserProbe = this.deps.browserProbe ?? isBrowserRunning;
    const browserRunning = await browserProbe(args.browserId);
    const extensionExtracted = await this.isExtensionExtracted(args.browserId);
    const installSessionId = this.getResolvedInstallSessionId(args.browserId, args.pairSessionId);
    const breadcrumbStats = installFunnelStats.getRecentBreadcrumbs({
      browserId: args.browserId,
      ...(installSessionId ? { pairSessionId: installSessionId } : {}),
      sinceMs: 5 * 60 * 1000,
    });

    return {
      browserRunning,
      extensionExtracted,
      recentInstallBreadcrumbCount: breadcrumbStats.count,
      recentInstallFailureCount: breadcrumbStats.failureCount,
      lastFailureReason: breadcrumbStats.lastFailureReason,
      bridgeReachable: this.diagnosticsContext?.isBridgeReachable() ?? false,
      pairSessionActive: this.hasActiveInstallSession(args.browserId, args.pairSessionId),
    };
  }

  private pathMod() {
    return this.deps.processPlatform === 'win32' ? path.win32 : path.posix;
  }

  private getHomeDir(): string {
    const env = this.deps.env ?? process.env;
    return env.HOME || env.USERPROFILE || os.homedir();
  }

  private normalizePathForComparison(value: string): string {
    const resolved = this.pathMod().resolve(value);
    return this.deps.processPlatform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  private isWithinRoot(candidate: string, root: string): boolean {
    const pathMod = this.pathMod();
    const normalizedCandidate = this.normalizePathForComparison(candidate);
    const normalizedRoot = this.normalizePathForComparison(root);
    const relative = pathMod.relative(normalizedRoot, normalizedCandidate);
    return relative === '' || (!relative.startsWith('..') && !pathMod.isAbsolute(relative));
  }

  private redactPath(manifestPath: string): string {
    const pathMod = this.pathMod();
    const userDataDir = this.deps.app.getPath('userData');
    if (this.isWithinRoot(manifestPath, userDataDir)) {
      const relative = pathMod.relative(userDataDir, manifestPath);
      return relative ? pathMod.join('<userData>', relative) : '<userData>';
    }

    const homeDir = this.getHomeDir();
    if (this.isWithinRoot(manifestPath, homeDir)) {
      const relative = pathMod.relative(homeDir, manifestPath);
      return relative ? pathMod.join('<home>', relative) : '<home>';
    }

    return manifestPath;
  }

  private async hasSafeManifestAncestry(manifestPath: string): Promise<boolean> {
    const pathMod = this.pathMod();
    const allowedRoots = [this.getHomeDir(), this.deps.app.getPath('userData')];
    const allowedRootComparisons = [...allowedRoots];
    for (const root of allowedRoots) {
      try {
        allowedRootComparisons.push(await this.deps.fs.realpath(root));
      } catch {
        // Ignore missing roots — lexical path checks still apply.
      }
    }
    let cursor = pathMod.dirname(manifestPath);

    while (true) {
      try {
        const realPath = await this.deps.fs.realpath(cursor);
        const resolvedCursor = this.normalizePathForComparison(cursor);
        const resolvedRealPath = this.normalizePathForComparison(realPath);
        const shouldValidateCursor = allowedRoots.some((root) => this.isWithinRoot(cursor, root));
        const withinAllowedRoots = allowedRootComparisons.some((root) =>
          this.isWithinRoot(resolvedRealPath, root),
        );
        if (shouldValidateCursor && resolvedRealPath !== resolvedCursor && !withinAllowedRoots) {
          return false;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          return false;
        }
      }

      const parent = pathMod.dirname(cursor);
      if (parent === cursor) {
        return true;
      }
      cursor = parent;
    }
  }

  private async ensureManifestParentDir(manifestPath: string): Promise<void> {
    const parentDir = this.pathMod().dirname(manifestPath);
    await this.deps.fs.mkdir(parentDir, { recursive: true });
    await this.deps.fs.chmod(parentDir, 0o700);
  }

  private async classifyExistingManifest(manifestPath: string): Promise<'absent' | 'owned' | 'conflict'> {
    try {
      const raw = await this.deps.fs.readFile(manifestPath, 'utf8');
      const parsed = JSON.parse(raw) as { name?: unknown };
      return parsed.name === 'ai.rebel.browser_bridge' ? 'owned' : 'conflict';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return 'absent';
      }
      return 'conflict';
    }
  }

  private async writeManifestAtomically(manifestPath: string, manifestContent: string): Promise<void> {
    const tempPath = `${manifestPath}.tmp`;
    await this.deps.fs.writeFile(tempPath, manifestContent, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });

    try {
      await this.deps.fs.chmod(tempPath, 0o600);
      await this.deps.fs.rename(tempPath, manifestPath);
      await this.deps.fs.chmod(manifestPath, 0o600);
    } catch (error) {
      await this.deps.fs.rm(tempPath, { force: true });
      throw error;
    }
  }

  private mapWriteErrorReason(error: unknown): string {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'EACCES' || code === 'EPERM') {
      return 'permission-denied';
    }
    if (code === 'ENOSPC') {
      return 'disk-full';
    }
    return 'write-failed';
  }

  async registerNmhManifests(params: {
    detectedBrowsers: DetectedBrowser[];
    allowedExtensionIds: string[];
  }): Promise<Array<{ browserId: string; ok: boolean; reason?: string }>> {
    if (params.allowedExtensionIds.length === 0) {
      return [];
    }

    const manifests = buildNmhManifests({
      platform: this.deps.processPlatform,
      homeDir: this.getHomeDir(),
      userDataDir: this.deps.app.getPath('userData'),
      detectedBrowsers: params.detectedBrowsers,
      allowedExtensionIds: params.allowedExtensionIds,
    });

    const results: Array<{ browserId: string; ok: boolean; reason?: string }> = [];

    for (const manifest of manifests) {
      let reason: string | undefined;
      try {
        const safeAncestry = await this.hasSafeManifestAncestry(manifest.manifestPath);
        if (!safeAncestry) {
          reason = 'symlink-escape';
        } else {
          await this.ensureManifestParentDir(manifest.manifestPath);
          const existingManifest = await this.classifyExistingManifest(manifest.manifestPath);
          if (existingManifest === 'conflict') {
            reason = 'conflict';
          } else {
            await this.writeManifestAtomically(manifest.manifestPath, manifest.manifestContent);
          }
        }
      } catch (error) {
        reason = this.mapWriteErrorReason(error);
      }

      const ok = reason == null;
      log.info(
        {
          browserId: manifest.browserId,
          ok,
          reason,
          manifestPath: this.redactPath(manifest.manifestPath),
        },
        'NMH manifest registration finished',
      );
      results.push(reason ? { browserId: manifest.browserId, ok, reason } : { browserId: manifest.browserId, ok });
    }

    return results;
  }

  async unregisterNmhManifests(params: {
    browserIds: string[];
  }): Promise<Array<{ browserId: string; ok: boolean; reason?: string }>> {
    const manifests = buildNmhManifests({
      platform: this.deps.processPlatform,
      homeDir: this.getHomeDir(),
      userDataDir: this.deps.app.getPath('userData'),
      detectedBrowsers: params.browserIds.map((browserId) => ({
        id: browserId,
        displayName: browserId,
        installPath: '',
      })),
      allowedExtensionIds: [],
    });

    const results: Array<{ browserId: string; ok: boolean; reason?: string }> = [];

    for (const manifest of manifests) {
      let reason: string | undefined;
      try {
        const safeAncestry = await this.hasSafeManifestAncestry(manifest.manifestPath);
        if (!safeAncestry) {
          reason = 'symlink-escape';
        } else {
          const existingManifest = await this.classifyExistingManifest(manifest.manifestPath);
          if (existingManifest === 'conflict') {
            reason = 'conflict';
          } else if (existingManifest === 'owned') {
            await this.deps.fs.unlink(manifest.manifestPath);
          }
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          reason = this.mapWriteErrorReason(error);
        }
      }

      const ok = reason == null;
      log.info(
        {
          browserId: manifest.browserId,
          ok,
          reason,
          manifestPath: this.redactPath(manifest.manifestPath),
        },
        'NMH manifest unregister finished',
      );
      results.push(reason ? { browserId: manifest.browserId, ok, reason } : { browserId: manifest.browserId, ok });
    }

    return results;
  }

  async registerNmhManifest(
    browserId: BrowserId,
    extensionId: string,
  ): Promise<{ ok: true; manifestPath: string } | { ok: false; reason: string }> {
    const detectedBrowsers = await this.detectBrowsers();
    const targetBrowser = detectedBrowsers.find((browser) => browser.id === browserId);
    if (!targetBrowser) {
      return { ok: false, reason: 'unsupported-browser' };
    }

    const [manifest] = buildNmhManifests({
      platform: this.deps.processPlatform,
      homeDir: this.getHomeDir(),
      userDataDir: this.deps.app.getPath('userData'),
      detectedBrowsers: [targetBrowser],
      allowedExtensionIds: [extensionId],
    });
    if (!manifest) {
      return { ok: false, reason: 'unsupported-browser' };
    }

    const [result] = await this.registerNmhManifests({
      detectedBrowsers: [targetBrowser],
      allowedExtensionIds: [extensionId],
    });
    if (!result?.ok) {
      return { ok: false, reason: result?.reason ?? 'write-failed' };
    }

    return {
      ok: true,
      manifestPath: manifest.manifestPath,
    };
  }

  async unregisterNmhManifest(
    browserId: BrowserId,
  ): Promise<{ ok: true; removed: boolean } | { ok: false; reason: string }> {
    const [manifest] = buildNmhManifests({
      platform: this.deps.processPlatform,
      homeDir: this.getHomeDir(),
      userDataDir: this.deps.app.getPath('userData'),
      detectedBrowsers: [{ id: browserId, displayName: browserId, installPath: '' }],
      allowedExtensionIds: [],
    });
    if (!manifest) {
      return { ok: false, reason: 'unsupported-browser' };
    }

    const existedBefore = await this.classifyExistingManifest(manifest.manifestPath)
      .then((status) => status === 'owned')
      .catch(() => false);
    const [result] = await this.unregisterNmhManifests({ browserIds: [browserId] });
    if (!result?.ok) {
      return { ok: false, reason: result?.reason ?? 'write-failed' };
    }

    return {
      ok: true,
      removed: existedBefore,
    };
  }
}

let instance: AppBridgeInstallerService | null = null;

export function getAppBridgeInstallerService(deps?: Partial<AppBridgeInstallerServiceDeps>): AppBridgeInstallerService {
  if (!instance || deps) {
    instance = new AppBridgeInstallerService({
      app: deps?.app || app,
      shell: deps?.shell || shell,
      fs: deps?.fs || fs,
      processPlatform: deps?.processPlatform || process.platform,
      processCwd: deps?.processCwd || process.cwd,
      processResourcesDir: deps?.processResourcesDir || process.resourcesPath,
      isPackaged: deps?.isPackaged ?? app.isPackaged,
      env: deps?.env,
      browserProbe: deps?.browserProbe,
      diagnosticsContext: deps?.diagnosticsContext,
    });
  }
  return instance;
}
