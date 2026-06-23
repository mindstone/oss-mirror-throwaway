#!/usr/bin/env tsx
/**
 * Capture a CDP-direct screenshot of the user's running Rebel dev app.
 *
 * Why this exists:
 * - The rebel-electron MCP's `electron_list_apps` only sees Electron processes
 *   the MCP itself spawned. When the user runs `REMOTE_DEBUGGING_PORT=9222 npm run dev`
 *   in their own terminal, the MCP can't see it and Chief Designer / DSR agents
 *   give up with "No Electron apps are currently running" — even though the
 *   dev app is healthy and accessible via CDP.
 * - This script bypasses the MCP entirely. It connects directly to the dev
 *   app's Chrome DevTools Protocol port, optionally navigates the in-app
 *   router, and captures one viewport or a stitched full-page image. Output
 *   is saved under docs/project/ux_testing/reports/screenshots/ and the
 *   resulting path is printed as JSON on stdout.
 *
 * Usage:
 *   REMOTE_DEBUGGING_PORT=9222 npm run dev      # in another terminal
 *   npx tsx scripts/capture-rebel-dev-screenshot.ts \
 *     --destination=settings --settings-tab=meetings \
 *     --label=cd-meetings-review --mode=scroll --theme=current
 *
 * Output (stdout):
 *   { "ok": true, "path": "docs/.../<file>.png", "width": ..., "height": ..., "theme": "light" }
 *   { "ok": false, "error": "<reason>" }
 *
 * Stitching algorithm mirrors src/main/services/screenshotService.ts so the
 * coding-context capture path and the in-app capture path produce comparable
 * full-page images.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';

interface Args {
  port?: number;
  destination?: 'home' | 'conversations' | 'actions' | 'automations' | 'spark' | 'library' | 'settings';
  settingsTab?: string;
  settingsSection?: string;
  label?: string;
  mode: 'viewport' | 'scroll';
  theme: 'current' | 'light' | 'dark';
  outDir: string;
}

const DEFAULT_OUT_DIR = path.join('docs', 'project', 'ux_testing', 'reports', 'screenshots');
const SCROLL_DEFAULT_MAX = 6;
const NAV_BRIDGE_RETRY_MS = 150;
const NAV_BRIDGE_ATTEMPTS = 40;
// Probed in order when --port is not given. Covers REBEL_DEBUGGING_PORT envvar,
// the canonical dev port (9222), the installed-app port we've seen in the wild
// (9911), and the rebel-electron MCP defaults (9444, 9333).
const PROBE_PORTS = [9222, 9911, 9444, 9333, 9000];

const VALID_DESTINATIONS = new Set([
  'home',
  'conversations',
  'actions',
  'automations',
  'spark',
  'library',
  'settings',
]);

const DESTINATION_TO_SURFACE: Record<NonNullable<Args['destination']>, string> = {
  home: 'home',
  conversations: 'sessions',
  actions: 'tasks',
  automations: 'automations',
  spark: 'usecases',
  library: 'library',
  settings: 'settings',
};

const SURFACE_RESTORE_URLS: Record<string, string> = {
  home: 'rebel://home',
  sessions: 'rebel://sessions',
  tasks: 'rebel://tasks',
  automations: 'rebel://automations',
  usecases: 'rebel://usecases',
  library: 'rebel://library',
  settings: 'rebel://settings',
  focus: 'rebel://focus',
  team: 'rebel://team',
};

class SurfaceMismatchError extends Error {
  constructor(
    readonly currentSurface: string,
    readonly expectedSurface: string,
    readonly destination: NonNullable<Args['destination']>,
  ) {
    super(
      `Captured surface ${JSON.stringify(currentSurface)} does not match expected surface ` +
        `${JSON.stringify(expectedSurface)} for destination ${JSON.stringify(destination)}`,
    );
  }
}

class InvalidDestinationModifiersError extends Error {
  constructor() {
    super('--settings-tab and --settings-section can only be used with --destination=settings');
  }
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    port: process.env.REMOTE_DEBUGGING_PORT ? Number(process.env.REMOTE_DEBUGGING_PORT) : undefined,
    mode: 'viewport',
    theme: 'current',
    outDir: DEFAULT_OUT_DIR,
  };

  for (const raw of argv.slice(2)) {
    const [keyRaw, ...rest] = raw.startsWith('--') ? raw.slice(2).split('=') : [raw];
    const key = keyRaw;
    const value = rest.length > 0 ? rest.join('=') : 'true';
    switch (key) {
      case 'port':
        out.port = Number(value);
        break;
      case 'destination':
        if (!VALID_DESTINATIONS.has(value)) {
          throw new Error(
            `--destination must be one of: ${[...VALID_DESTINATIONS].join(', ')} (got "${value}")`,
          );
        }
        out.destination = value as Args['destination'];
        break;
      case 'settings-tab':
        out.settingsTab = value;
        break;
      case 'settings-section':
        out.settingsSection = value;
        break;
      case 'label':
        if (!/^[a-z0-9-]{0,48}$/.test(value)) {
          throw new Error(`--label must match /^[a-z0-9-]{0,48}$/ (got "${value}")`);
        }
        out.label = value;
        break;
      case 'mode':
        if (value !== 'viewport' && value !== 'scroll') {
          throw new Error(`--mode must be "viewport" or "scroll" (got "${value}")`);
        }
        out.mode = value;
        break;
      case 'theme':
        if (value !== 'current' && value !== 'light' && value !== 'dark') {
          throw new Error(`--theme must be one of: current, light, dark (got "${value}")`);
        }
        out.theme = value;
        break;
      case 'out-dir':
        out.outDir = value;
        break;
      case 'help':
      case 'h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: --${key}`);
    }
  }

  if ((out.settingsTab !== undefined || out.settingsSection !== undefined) && out.destination !== 'settings') {
    throw new InvalidDestinationModifiersError();
  }

  return out;
}

function printHelp(): void {
  process.stdout.write(`Usage: capture-rebel-dev-screenshot [options]

Required setup: a running Rebel Electron app exposing Chrome DevTools Protocol.
The most reliable launch is REMOTE_DEBUGGING_PORT=9222 npm run dev. If you don't
set REMOTE_DEBUGGING_PORT but you have an installed Rebel running, the script
will probe common ports (9222, 9911, 9444, 9333, 9000) and pick the first that
identifies as a Rebel app.

Options:
  --port=<n>                  CDP port (default: REMOTE_DEBUGGING_PORT env, then auto-probe)
  --destination=<surface>     home | conversations | actions | automations | spark | library | settings
  --settings-tab=<tab>        e.g. meetings, tools, agents — only used with --destination=settings
  --settings-section=<id>     anchor within a settings tab (optional)
  --label=<slug>              filename slug, /^[a-z0-9-]{0,48}$/
  --mode=viewport|scroll      "scroll" stitches the visible scrollable area into one tall image (default: viewport)
  --theme=current|light|dark  force theme by toggling document.body classes (default: current)
  --out-dir=<path>            output directory (default: docs/project/ux_testing/reports/screenshots)
  --help                      show this message

Output (stdout): single line of JSON with { ok, path, width, height, theme } on success,
or { ok: false, error } on failure.
`);
}

function buildRebelUrl(args: Args): string | null {
  if (!args.destination) return null;
  if (args.destination === 'settings') {
    let url = 'rebel://settings';
    if (args.settingsTab) url += `/${encodeURIComponent(args.settingsTab)}`;
    if (args.settingsSection) url += `#${encodeURIComponent(args.settingsSection)}`;
    return url;
  }
  const map: Record<string, string> = {
    home: 'home',
    conversations: 'conversation',
    actions: 'tasks',
    automations: 'automations',
    spark: 'usecases',
    library: 'library',
  };
  return `rebel://${map[args.destination]}`;
}

function timestampSlug(now = new Date()): string {
  const yy = String(now.getFullYear() % 100).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yy}${mm}${dd}_${hh}${mi}${ss}`;
}

interface RebelTarget {
  id: string;
  webSocketDebuggerUrl: string;
  port: number;
  appLabel: string;
}

async function fetchJsonWithTimeout(url: string, timeoutMs = 1500): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function probeRebelOnPort(port: number): Promise<RebelTarget | null> {
  let version: { 'User-Agent'?: string } | null = null;
  try {
    version = (await fetchJsonWithTimeout(`http://127.0.0.1:${port}/json/version`, 1500)) as {
      'User-Agent'?: string;
    };
  } catch {
    return null;
  }

  const userAgent = version?.['User-Agent'] ?? '';
  const targets = (await fetchJsonWithTimeout(`http://127.0.0.1:${port}/json/list`)) as Array<{
    id: string;
    type: string;
    title?: string;
    url?: string;
    webSocketDebuggerUrl?: string;
  }>;

  const pageTargets = targets.filter(
    (t) => t.type === 'page' && Boolean(t.webSocketDebuggerUrl) && !(t.url ?? '').startsWith('devtools://'),
  );
  const preferred =
    pageTargets.find(
      (t) =>
        (t.url ?? '').includes('main_window') ||
        (t.title ?? '').toLowerCase().includes('rebel') ||
        (t.title ?? '').toLowerCase().includes('mindstone'),
    ) ??
    (await findFirstRebelBridgeTarget(pageTargets));

  if (!preferred?.webSocketDebuggerUrl) return null;

  const versionMatch = /mindstone-rebel\/([^\s]+)/i.exec(userAgent);
  const appLabel = versionMatch
    ? `mindstone-rebel ${versionMatch[1]}`
    : preferred.title || 'mindstone-rebel';
  return {
    id: preferred.id,
    webSocketDebuggerUrl: preferred.webSocketDebuggerUrl,
    port,
    appLabel,
  };
}

async function findFirstRebelBridgeTarget<T extends { webSocketDebuggerUrl?: string }>(
  targets: T[],
): Promise<T | null> {
  for (const target of targets) {
    if (!target.webSocketDebuggerUrl) continue;
    const client = await CDP({ target: target.webSocketDebuggerUrl }).catch(() => null);
    if (!client) continue;
    try {
      await client.Runtime.enable();
      const fingerprint = await evaluate<{
        title?: string;
        href?: string;
        hasNavigationBridge?: boolean;
        hasSurfaceBridge?: boolean;
      }>(
        client,
        `(() => ({
          title: document.title,
          href: location.href,
          hasNavigationBridge: typeof globalThis.__rebelNavigateForTool === 'function',
          hasSurfaceBridge: typeof globalThis.__rebelGetCurrentSurfaceForTool === 'function',
        }))()`,
      );
      const text = `${fingerprint.title ?? ''} ${fingerprint.href ?? ''}`;
      if (
        fingerprint.hasNavigationBridge === true ||
        fingerprint.hasSurfaceBridge === true ||
        /mindstone|rebel/i.test(text)
      ) {
        return target;
      }
    } finally {
      await client.close().catch(() => {});
    }
  }
  return null;
}

async function findRebelTarget(forcedPort?: number): Promise<RebelTarget> {
  if (forcedPort) {
    const found = await probeRebelOnPort(forcedPort);
    if (!found) {
      throw new Error(
        `No Rebel app responding on CDP port ${forcedPort}. ` +
          `Confirm the dev app is running with REMOTE_DEBUGGING_PORT=${forcedPort} npm run dev, ` +
          `or omit --port to auto-probe common ports.`,
      );
    }
    return found;
  }

  const tried: number[] = [];
  for (const port of PROBE_PORTS) {
    tried.push(port);
    const found = await probeRebelOnPort(port);
    if (found) return found;
  }
  throw new Error(
    `No Rebel app found on any probed CDP port. Tried: ${tried.join(', ')}. ` +
      `Launch the dev app with REMOTE_DEBUGGING_PORT=9222 npm run dev, or pass --port=<n> directly.`,
  );
}

interface CdpClientLike {
  Page: {
    enable: () => Promise<void>;
    captureScreenshot: (params: {
      format: 'png';
      clip?: { x: number; y: number; width: number; height: number; scale: number };
      captureBeyondViewport?: boolean;
    }) => Promise<{ data: string }>;
  };
  Runtime: {
    enable: () => Promise<void>;
    evaluate: (params: {
      expression: string;
      returnByValue?: boolean;
      awaitPromise?: boolean;
    }) => Promise<{ result: { value?: unknown; type: string } }>;
  };
  close: () => Promise<void>;
}

type CdpFactory = (options: { target: string }) => Promise<CdpClientLike>;

const require = createRequire(import.meta.url);
// chrome-remote-interface does not ship types here; this script uses only the CdpClientLike surface above.
const CDP = require('chrome-remote-interface') as CdpFactory;

async function evaluate<T = unknown>(
  client: CdpClientLike,
  expression: string,
  awaitPromise = false,
): Promise<T> {
  const { result } = await client.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise,
  });
  return result.value as T;
}

async function waitForNavigationBridge(client: CdpClientLike): Promise<boolean> {
  for (let i = 0; i < NAV_BRIDGE_ATTEMPTS; i += 1) {
    const ready = await evaluate<boolean>(
      client,
      `typeof globalThis.__rebelNavigateForTool === 'function' && typeof globalThis.__rebelGetCurrentSurfaceForTool === 'function'`,
    ).catch(() => false);
    if (ready === true) return true;
    await sleep(NAV_BRIDGE_RETRY_MS);
  }
  return false;
}

async function setTheme(client: CdpClientLike, theme: 'light' | 'dark'): Promise<void> {
  const expression = `(() => {
    const body = document.body;
    if (!body) return false;
    body.classList.remove('light', 'dark');
    body.classList.add(${JSON.stringify(theme)});
    document.documentElement.style.colorScheme = ${JSON.stringify(theme)};
    return true;
  })()`;
  await evaluate(client, expression);
  await sleep(120);
}

interface RestoreStatus {
  needed: boolean;
  attempted: boolean;
  ok: boolean;
  from?: string | null;
  to?: string | null;
  error?: string;
}

async function detectCurrentTheme(client: CdpClientLike): Promise<'light' | 'dark' | null> {
  return await evaluate<'light' | 'dark' | null>(
    client,
    `(() => {
      const body = document.body;
      if (!body) return null;
      if (body.classList.contains('light')) return 'light';
      if (body.classList.contains('dark')) return 'dark';
      const cs = document.documentElement?.style?.colorScheme;
      if (cs === 'light' || cs === 'dark') return cs;
      return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
    })()`,
  );
}

async function getCurrentSurface(client: CdpClientLike): Promise<string | null> {
  return await evaluate<string | null>(
    client,
    `(() => {
      const surface = globalThis.__rebelGetCurrentSurfaceForTool?.();
      return typeof surface === 'string' && surface.trim() ? surface : null;
    })()`,
  );
}

async function restoreTheme(
  client: CdpClientLike,
  originalTheme: 'light' | 'dark' | null,
  forcedTheme: 'current' | 'light' | 'dark',
): Promise<RestoreStatus> {
  if (forcedTheme === 'current') {
    return { needed: false, attempted: false, ok: true, from: originalTheme, to: originalTheme };
  }

  if (!originalTheme) {
    return {
      needed: true,
      attempted: false,
      ok: false,
      from: forcedTheme,
      to: null,
      error: 'original-theme-unavailable',
    };
  }

  if (originalTheme === forcedTheme) {
    return { needed: false, attempted: false, ok: true, from: originalTheme, to: originalTheme };
  }

  try {
    await setTheme(client, originalTheme);
    return { needed: true, attempted: true, ok: true, from: forcedTheme, to: originalTheme };
  } catch (error) {
    return {
      needed: true,
      attempted: true,
      ok: false,
      from: forcedTheme,
      to: originalTheme,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function restoreSurface(
  client: CdpClientLike,
  originalSurface: string | null,
  navigationOccurred: boolean,
): Promise<RestoreStatus> {
  if (!navigationOccurred) {
    return { needed: false, attempted: false, ok: true, from: originalSurface, to: originalSurface };
  }

  const currentSurface = await getCurrentSurface(client).catch(() => null);

  if (!originalSurface) {
    return {
      needed: true,
      attempted: false,
      ok: false,
      from: currentSurface,
      to: null,
      error: 'original-surface-unavailable',
    };
  }

  if (currentSurface === originalSurface) {
    return { needed: false, attempted: false, ok: true, from: originalSurface, to: originalSurface };
  }

  const restoreUrl = SURFACE_RESTORE_URLS[originalSurface];
  if (!restoreUrl) {
    return {
      needed: true,
      attempted: false,
      ok: false,
      from: currentSurface,
      to: originalSurface,
      error: `unsupported-restore-surface:${originalSurface}`,
    };
  }

  try {
    const restored = await evaluate<boolean>(
      client,
      `globalThis.__rebelNavigateForTool?.(${JSON.stringify(restoreUrl)})`,
      true,
    );
    await sleep(250);
    return {
      needed: true,
      attempted: true,
      ok: restored === true,
      from: currentSurface,
      to: originalSurface,
      ...(restored === true ? {} : { error: `restore-navigation-returned:${JSON.stringify(restored)}` }),
    };
  } catch (error) {
    return {
      needed: true,
      attempted: true,
      ok: false,
      from: currentSurface,
      to: originalSurface,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

interface ScrollState {
  available: boolean;
  originalScrollTop: number;
  maxScrollTop: number;
  viewportHeight: number;
  rect: { x: number; y: number; width: number; height: number };
}

async function getScrollState(client: CdpClientLike): Promise<ScrollState> {
  return await evaluate<ScrollState>(
    client,
    `(() => {
      const scrollingElement = document.scrollingElement || document.documentElement;
      const candidates = [scrollingElement, ...Array.from(document.querySelectorAll('*'))]
        .filter((el, idx, all) => el && all.indexOf(el) === idx)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const scrollableByStyle = ['auto','scroll','overlay'].includes(style.overflowY);
          const scrollableBySize = el.scrollHeight > el.clientHeight + 32;
          const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          const isDocument = el === scrollingElement;
          if (!visible || !scrollableBySize || (!scrollableByStyle && !isDocument)) return null;
          const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
          const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
          return {
            element: el,
            score: Math.max(0, visibleWidth) * Math.max(0, visibleHeight) + Math.max(0, el.scrollHeight - el.clientHeight),
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);

      const target = candidates[0]?.element || scrollingElement;
      const rect = target === scrollingElement
        ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
        : target.getBoundingClientRect();
      const left = Math.max(0, rect.left);
      const top = Math.max(0, rect.top);
      const right = Math.min(window.innerWidth, rect.right);
      const bottom = Math.min(window.innerHeight, rect.bottom);
      const width = Math.max(1, Math.round(right - left));
      const height = Math.max(1, Math.round(bottom - top));
      const maxScrollTop = Math.max(0, target.scrollHeight - target.clientHeight);
      window.__rebelDevCaptureScrollTarget = target;
      return {
        available: maxScrollTop > 32,
        originalScrollTop: target.scrollTop,
        maxScrollTop,
        viewportHeight: height,
        rect: { x: Math.round(left), y: Math.round(top), width, height },
      };
    })()`,
  );
}

async function setScrollTop(client: CdpClientLike, scrollTop: number): Promise<void> {
  await evaluate(
    client,
    `(() => {
      const target = window.__rebelDevCaptureScrollTarget || document.scrollingElement || document.documentElement;
      target.scrollTop = ${JSON.stringify(scrollTop)};
      target.dispatchEvent(new Event('scroll', { bubbles: true }));
      window.dispatchEvent(new Event('scroll'));
    })()`,
  );
  await sleep(180);
}

async function restoreScroll(client: CdpClientLike, originalScrollTop: number): Promise<void> {
  await evaluate(
    client,
    `(() => {
      const target = window.__rebelDevCaptureScrollTarget || document.scrollingElement || document.documentElement;
      target.scrollTop = ${JSON.stringify(originalScrollTop)};
      target.dispatchEvent(new Event('scroll', { bubbles: true }));
      window.dispatchEvent(new Event('scroll'));
      delete window.__rebelDevCaptureScrollTarget;
    })()`,
  );
}

function buildScrollPositions(state: ScrollState, max: number): number[] {
  if (!state.available || state.maxScrollTop <= 0 || max <= 1) return [0];
  const stepBased =
    Math.ceil(state.maxScrollTop / Math.max(1, Math.floor(state.viewportHeight * 0.85))) + 1;
  const count = Math.max(2, Math.min(max, stepBased));
  return Array.from({ length: count }, (_, i) => {
    if (i === 0) return 0;
    if (i === count - 1) return state.maxScrollTop;
    return Math.round((state.maxScrollTop * i) / (count - 1));
  });
}

async function captureClip(
  client: CdpClientLike,
  clip?: { x: number; y: number; width: number; height: number },
): Promise<Buffer> {
  const { data } = await client.Page.captureScreenshot({
    format: 'png',
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    captureBeyondViewport: false,
  });
  return Buffer.from(data, 'base64');
}

interface StitchSegment {
  pngBuffer: Buffer;
  scrollTop: number;
  index: number;
}

function stitchSegments(segments: StitchSegment[], cssViewportHeight: number): Buffer {
  if (segments.length === 1) return segments[0].pngBuffer;

  const decoded = segments.map((s) => ({ ...s, png: PNG.sync.read(s.pngBuffer) }));
  const cropped = decoded
    .map((d, i) => {
      const prev = decoded[i - 1];
      const cssOverlap = prev
        ? Math.max(0, prev.scrollTop + cssViewportHeight - d.scrollTop)
        : 0;
      const cssToImageScale = d.png.height / Math.max(1, cssViewportHeight);
      const cropTop = Math.min(d.png.height, Math.round(cssOverlap * cssToImageScale));
      const cropHeight = d.png.height - cropTop;
      return { png: d.png, cropTop, cropHeight };
    })
    .filter((c) => c.cropHeight > 0);

  const width = Math.max(...cropped.map((c) => c.png.width));
  const height = cropped.reduce((sum, c) => sum + c.cropHeight, 0);
  const out = new PNG({ width, height });
  let yOffset = 0;
  for (const seg of cropped) {
    for (let row = 0; row < seg.cropHeight; row += 1) {
      const srcStart = (seg.cropTop + row) * seg.png.width * 4;
      const srcEnd = srcStart + seg.png.width * 4;
      const dstStart = (yOffset + row) * width * 4;
      seg.png.data.copy(out.data, dstStart, srcStart, srcEnd);
    }
    yOffset += seg.cropHeight;
  }
  return PNG.sync.write(out);
}

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height };
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv);
  } catch (error) {
    if (error instanceof InvalidDestinationModifiersError) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          errorCode: 'invalid-destination-modifiers',
          error: error.message,
        }) + '\n',
      );
      process.exit(2);
    }
    process.stdout.write(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + '\n',
    );
    process.exit(2);
  }

  let client: CdpClientLike | null = null;
  let originalTheme: 'light' | 'dark' | null = null;
  let originalSurface: string | null = null;
  let navigationOccurred = false;
  try {
    const target = await findRebelTarget(args.port);
    client = await CDP({ target: target.webSocketDebuggerUrl });
    await client.Page.enable();
    await client.Runtime.enable();
    originalTheme = await detectCurrentTheme(client);
    originalSurface = await getCurrentSurface(client).catch(() => null);

    if (args.destination) {
      const url = buildRebelUrl(args);
      if (!url) throw new Error('Failed to build navigation URL');
      const bridgeReady = await waitForNavigationBridge(client);
      if (!bridgeReady) {
        throw new Error(
          `Navigation bridge __rebelNavigateForTool is not exposed by ${target.appLabel} ` +
            `on port ${target.port}. This typically means: ` +
            `(a) the running app is older than the in-app navigation bridge feature ` +
            `(see commit "feat(visual-verification): Add safe in-app navigation for capture"), or ` +
            `(b) the renderer is still starting. ` +
            `Fix: relaunch the dev app with REMOTE_DEBUGGING_PORT=9222 npm run dev so the ` +
            `latest bridge is available, or omit --destination/--settings-tab and capture whichever ` +
            `surface is currently visible.`,
        );
      }
      const navOk = await evaluate<boolean>(
        client,
        `globalThis.__rebelNavigateForTool?.(${JSON.stringify(url)})`,
        true,
      );
      if (navOk !== true) {
        throw new Error(`Navigation to ${url} returned ${JSON.stringify(navOk)} instead of true`);
      }
      navigationOccurred = true;
      // Wait long enough for the surface to mount, layout, and settle.
      await sleep(750);
      const currentSurface = await getCurrentSurface(client);
      const expectedSurface = DESTINATION_TO_SURFACE[args.destination];
      if (currentSurface !== expectedSurface) {
        throw new SurfaceMismatchError(currentSurface ?? 'unknown', expectedSurface, args.destination);
      }
    }

    if (args.theme === 'light' || args.theme === 'dark') {
      await setTheme(client, args.theme);
    }

    const resolvedTheme: 'light' | 'dark' =
      args.theme === 'current' ? (await detectCurrentTheme(client)) ?? 'light' : args.theme;
    const currentSurface = await getCurrentSurface(client);

    let pngBuffer: Buffer;
    if (args.mode === 'scroll') {
      const state = await getScrollState(client);
      const positions = buildScrollPositions(state, SCROLL_DEFAULT_MAX);
      const segments: StitchSegment[] = [];
      try {
        for (let i = 0; i < positions.length; i += 1) {
          const scrollTop = positions[i];
          await setScrollTop(client, scrollTop);
          const buf = await captureClip(client, state.rect);
          segments.push({ pngBuffer: buf, scrollTop, index: i });
        }
      } finally {
        await restoreScroll(client, state.originalScrollTop).catch(() => {});
      }
      pngBuffer = stitchSegments(segments, state.viewportHeight);
    } else {
      pngBuffer = await captureClip(client);
    }

    const dims = pngDimensions(pngBuffer);
    const labelSegment = args.label ? `_${args.label}` : '';
    const filename = `${timestampSlug()}_${resolvedTheme}${labelSegment}.png`;
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const outDir = path.isAbsolute(args.outDir) ? args.outDir : path.join(repoRoot, args.outDir);
    await mkdir(outDir, { recursive: true });
    const absPath = path.join(outDir, filename);
    await writeFile(absPath, pngBuffer);

    const relativePath = path.relative(repoRoot, absPath).split(path.sep).join('/');
    const themeRestore = await restoreTheme(client, originalTheme, args.theme);
    const surfaceRestore = await restoreSurface(client, originalSurface, navigationOccurred);
    const restoreFailed = !themeRestore.ok || !surfaceRestore.ok;

    if (restoreFailed) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          errorCode: 'restore-failed',
          error: 'Capture completed, but restoring the live app state failed.',
          path: relativePath,
          theme_restore: themeRestore,
          surface_restore: surfaceRestore,
        }) + '\n',
      );
      process.exit(1);
    }

    process.stdout.write(
      JSON.stringify({
        ok: true,
        path: relativePath,
        width: dims.width,
        height: dims.height,
        theme: resolvedTheme,
        mode: args.mode,
        port: target.port,
        appLabel: target.appLabel,
        ...(currentSurface ? { current_surface: currentSurface } : {}),
        ...(args.destination ? { destination: args.destination } : {}),
        ...(args.settingsTab ? { settingsTab: args.settingsTab } : {}),
        theme_restore: themeRestore,
        surface_restore: surfaceRestore,
        bytes: pngBuffer.length,
      }) + '\n',
    );
  } catch (error) {
    const themeRestore = client
      ? await restoreTheme(client, originalTheme, args.theme).catch((restoreError): RestoreStatus => ({
          needed: args.theme !== 'current',
          attempted: true,
          ok: false,
          from: args.theme,
          to: originalTheme,
          error: restoreError instanceof Error ? restoreError.message : String(restoreError),
        }))
      : null;
    const surfaceRestore = client
      ? await restoreSurface(client, originalSurface, navigationOccurred).catch((restoreError): RestoreStatus => ({
          needed: navigationOccurred,
          attempted: true,
          ok: false,
          from: null,
          to: originalSurface,
          error: restoreError instanceof Error ? restoreError.message : String(restoreError),
        }))
      : null;

    const restoreFailed = themeRestore?.ok === false || surfaceRestore?.ok === false;
    if (restoreFailed) {
      const originalErrorCode = error instanceof SurfaceMismatchError ? 'surface-mismatch' : undefined;
      process.stdout.write(
        JSON.stringify({
          ok: false,
          errorCode: 'restore-failed',
          error: 'Capture failed, and restoring the live app state also failed.',
          ...(originalErrorCode ? { original_error_code: originalErrorCode } : {}),
          original_error: error instanceof Error ? error.message : String(error),
          ...(themeRestore ? { theme_restore: themeRestore } : {}),
          ...(surfaceRestore ? { surface_restore: surfaceRestore } : {}),
        }) + '\n',
      );
      process.exit(1);
    }

    if (error instanceof SurfaceMismatchError) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          errorCode: 'surface-mismatch',
          error: error.message,
          current_surface: error.currentSurface,
          expected_surface: error.expectedSurface,
          destination: error.destination,
          ...(themeRestore ? { theme_restore: themeRestore } : {}),
          ...(surfaceRestore ? { surface_restore: surfaceRestore } : {}),
        }) + '\n',
      );
      process.exit(1);
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: message,
        ...(themeRestore ? { theme_restore: themeRestore } : {}),
        ...(surfaceRestore ? { surface_restore: surfaceRestore } : {}),
      }) + '\n',
    );
    process.exit(1);
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
  }
}

main();
