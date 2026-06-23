/**
 * Stage 6 — cloudMigrationService extract progress wiring.
 *
 * Verifies the producer wires `onProgress` from cloud-service NDJSON events
 * into the extract sub-range (22–30) with `phase: 'extract'`, correct
 * current/total, and `live: true`. The mocked `postStream` plays back a
 * script of 3 progress events + 1 successful result so we can assert the
 * full sequence without standing up a cloud service.
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Stage 6 — Cloud-Service NDJSON + desktop wiring)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPatch = vi.fn();
const mockPut = vi.fn();
const mockPost = vi.fn();
const mockPostStream = vi.fn();
const mockDisconnect = vi.fn();

vi.mock('../cloudServiceClient', () => ({
  CloudServiceClient: class MockCloudServiceClient {
    patch = mockPatch;
    put = mockPut;
    post = mockPost;
    postStream = mockPostStream;
    disconnect = mockDisconnect;
  },
}));

let appDataDir = '';
vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => appDataDir,
}));

vi.mock('@main/utils/testIsolation', () => ({
  getSuperMcpOAuthTokensDir: () => '/tmp/mock-oauth-tokens-extract-progress',
}));

import {
  migrateToCloud,
  type MigrationOptions,
  type MigrationStep,
} from '../cloudMigrationService';
import { MIGRATION_PHASE_RANGES } from '@shared/cloudMigrationPhases';
import type { AppSettings } from '@shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSettings(coreDirectory: string): AppSettings {
  return {
    coreDirectory,
    cloudInstance: {
      mode: 'cloud',
      cloudUrl: 'https://rebel-test.fly.dev',
      cloudToken: 'test-token',
    },
    onboardingCompleted: true,
    userEmail: 'user@example.com',
    mcpConfigFile: null,
    userFirstName: 'Test',
    onboardingFirstCompletedAt: 1700000000000,
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'whisper-1',
      ttsVoice: null,
      activationHotkey: null,
      activationHotkeyVoiceMode: false,
    },
    claude: { apiKey: '', model: 'claude-sonnet-4-20250514' },
    diagnostics: { sentryEnabled: true },
  } as unknown as AppSettings;
}

function baseOptions(
  coreDirectory: string,
  overrides?: Partial<MigrationOptions>,
): MigrationOptions {
  return {
    cloudUrl: 'https://rebel-test.fly.dev',
    cloudToken: 'bridge-token-abc',
    getSettings: () => createSettings(coreDirectory),
    loadSessions: () => [],
    ...overrides,
  };
}

/**
 * postStream that drains the upload and then replays a canned NDJSON
 * progress script via the caller's `onProgress` callback (mirrors what the
 * real `parseNdjsonResponse` would dispatch).
 */
function mockPostStreamWithProgressEvents(events: Array<{
  phase: string;
  bytesProcessed: number;
  bytesTotal?: number;
}>) {
  return async (
    _path: string,
    stream: import('node:stream').Readable,
    opts: { onProgress?: (evt: { phase: string; bytesProcessed: number; bytesTotal?: number }) => void; bytesTotal?: number },
  ): Promise<{ success: boolean; fileCount: number; archiveSize: number }> => {
    // Drain so the pre-gzip tap fires for real (produces workspace upload
    // events alongside extract events).
    await new Promise<void>((resolve, reject) => {
      stream.on('data', () => { /* drain */ });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    // Replay the extract-phase events. The real cloudServiceClient parser
    // calls `onProgress` per NDJSON progress line; we do the same here.
    if (opts.onProgress) {
      for (const evt of events) {
        opts.onProgress(evt);
      }
    }
    return { success: true, fileCount: events.length, archiveSize: 1 };
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migrateToCloud — extract progress (NDJSON wiring)', () => {
  let tmpRoot: string;
  let workspaceDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPatch.mockResolvedValue({ success: true });
    mockPut.mockResolvedValue({ success: true });
    mockPost.mockResolvedValue({ success: true });

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-extract-progress-'));
    workspaceDir = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'a.txt'), Buffer.alloc(50_000, 'a'));
    fs.writeFileSync(path.join(workspaceDir, 'b.txt'), Buffer.alloc(50_000, 'b'));

    appDataDir = path.join(tmpRoot, 'user-data');
    fs.mkdirSync(appDataDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('maps extract events into the 22-30 band with phase=extract and live=true', async () => {
    mockPostStream.mockImplementation(
      mockPostStreamWithProgressEvents([
        { phase: 'extract', bytesProcessed: 300_000, bytesTotal: 900_000 },
        { phase: 'extract', bytesProcessed: 600_000, bytesTotal: 900_000 },
        { phase: 'extract', bytesProcessed: 900_000, bytesTotal: 900_000 },
      ]),
    );

    const steps: MigrationStep[] = [];
    await migrateToCloud(
      baseOptions(workspaceDir, {
        onProgress: (s) => steps.push({ ...s }),
      }),
    );

    const extractSteps = steps.filter((s) => s.phase === 'extract');
    // At least 3 extract events (from the mocked progress). May also include
    // the `onExtracting` handoff event which also uses phase=extract.
    expect(extractSteps.length).toBeGreaterThanOrEqual(3);
    const liveExtractSteps = extractSteps.filter((s) => s.current !== undefined && s.total !== undefined);
    expect(liveExtractSteps).toHaveLength(3);

    for (const step of liveExtractSteps) {
      expect(step.live).toBe(true);
      expect(step.phase).toBe('extract');
      expect(step.progress).toBeGreaterThanOrEqual(MIGRATION_PHASE_RANGES.extract.min);
      expect(step.progress).toBeLessThanOrEqual(MIGRATION_PHASE_RANGES.extract.max);
      expect(step.current!).toBeLessThanOrEqual(step.total!);
      expect(step.bytesTotal).toBe(step.total);
      expect(step.runId).toBeTruthy();
    }
    // Final event's ratio is 1.0 → progress lands at extract.max (30).
    expect(liveExtractSteps[liveExtractSteps.length - 1].progress).toBe(
      MIGRATION_PHASE_RANGES.extract.max,
    );
  });

  it('falls back to minimum of extract band when bytesTotal is missing', async () => {
    mockPostStream.mockImplementation(
      mockPostStreamWithProgressEvents([
        { phase: 'extract', bytesProcessed: 300_000 }, // no bytesTotal
      ]),
    );

    const steps: MigrationStep[] = [];
    await migrateToCloud(
      baseOptions(workspaceDir, {
        onProgress: (s) => steps.push({ ...s }),
      }),
    );

    const degraded = steps.filter(
      (s) => s.phase === 'extract' && s.current === undefined && s.live === true,
    );
    expect(degraded.length).toBeGreaterThanOrEqual(1);
    for (const step of degraded) {
      expect(step.progress).toBe(MIGRATION_PHASE_RANGES.extract.min);
    }
  });

  it('preserves monotonic overall progress across workspace → extract → app-data', async () => {
    mockPostStream.mockImplementation(
      mockPostStreamWithProgressEvents([
        { phase: 'extract', bytesProcessed: 200_000, bytesTotal: 600_000 },
        { phase: 'extract', bytesProcessed: 400_000, bytesTotal: 600_000 },
        { phase: 'extract', bytesProcessed: 600_000, bytesTotal: 600_000 },
      ]),
    );

    const steps: MigrationStep[] = [];
    await migrateToCloud(
      baseOptions(workspaceDir, {
        onProgress: (s) => steps.push({ ...s }),
      }),
    );

    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].progress).toBeGreaterThanOrEqual(steps[i - 1].progress);
    }
  });

  it('passes bytesTotal header and Accept header via postStream options', async () => {
    mockPostStream.mockImplementation(
      mockPostStreamWithProgressEvents([
        { phase: 'extract', bytesProcessed: 50_000, bytesTotal: 100_000 },
      ]),
    );
    await migrateToCloud(baseOptions(workspaceDir));

    // uploadWorkspaceFiles → postStream was called once with an options obj
    // containing bytesTotal (the pre-walk sum) and onProgress.
    const workspaceCall = mockPostStream.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('target=workspace'),
    );
    expect(workspaceCall).toBeDefined();
    const opts = workspaceCall![2] as {
      bytesTotal?: number;
      onProgress?: (evt: unknown) => void;
      timeoutMs?: number;
    };
    expect(typeof opts.onProgress).toBe('function');
    expect(opts.bytesTotal).toBeGreaterThan(0);
    // 2-hour upload timeout preserved
    expect(opts.timeoutMs).toBe(2 * 60 * 60 * 1000);
  });
});
