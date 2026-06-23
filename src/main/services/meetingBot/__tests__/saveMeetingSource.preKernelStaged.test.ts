import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type SourceScenario =
  | 'recall'
  | 'external_fireflies'
  | 'external_fathom'
  | 'plaud'
  | 'limitless'
  | 'desktop_sdk'
  | 'quick_capture';

interface FirefliesMappingInput {
  meetingUrl: string;
  calendarEventId?: string;
}

interface FirefliesMappingScenario {
  name: string;
  input: FirefliesMappingInput;
  expected_frontmatter_calendar_event_id: string | null;
}

interface FirefliesMappingFile {
  scenarios: FirefliesMappingScenario[];
}

type FsPromisesMock = {
  writeFile: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  access: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
  readdir: ReturnType<typeof vi.fn>;
  unlink: ReturnType<typeof vi.fn>;
};

const FIXED_NOW_ISO = '2026-01-15T10:00:00.000Z';
const FIXED_START_TIME = FIXED_NOW_ISO;
const FIXED_TRANSCRIPT = [
  'Speaker 1: Hello team.',
  'Speaker 2: Thanks for joining today.',
  "Speaker 1: Let's begin.",
].join('\n');
const FIXED_MEETING_TITLE = 'Q1 Planning Sync';
const FIXED_PARTICIPANTS = ['Alice', 'Bob'];
const FIXED_DURATION_SECONDS = 1800;
const FIXED_MEETING_URL = 'https://meet.google.com/abc-defg-hij';
const FIXED_FIREFLIES_CALENDAR_ID = 'fixture-cal-event-fireflies-001';
const FIXED_CORE_DIRECTORY = '/mock/workspace';
const FIXED_CHIEF_OF_STAFF_PATH = '/mock/workspace/Chief-of-Staff';
const FIXED_LOCALE_TIME = '10:00 AM';
const require = createRequire(import.meta.url);
const { load: parseYaml } = require('js-yaml') as {
  load: (raw: string) => unknown;
};

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures');

const FIXTURE_BY_SOURCE: Record<SourceScenario, string> = {
  recall: 'preKernelStaged_recall.md',
  external_fireflies: 'preKernelStaged_external_fireflies.md',
  external_fathom: 'preKernelStaged_external_fathom.md',
  plaud: 'preKernelStaged_plaud.md',
  limitless: 'preKernelStaged_limitless.md',
  desktop_sdk: 'preKernelStaged_desktop_sdk.md',
  quick_capture: 'preKernelStaged_quick_capture.md',
};

function fixturePath(source: SourceScenario): string {
  return path.join(FIXTURE_DIR, FIXTURE_BY_SOURCE[source]);
}

function makeEnoent(): NodeJS.ErrnoException {
  const error = new Error('ENOENT') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

function createFsPromisesMock(
  overrides: Partial<FsPromisesMock> = {},
): FsPromisesMock {
  const base: FsPromisesMock = {
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockImplementation(async () => {
      throw makeEnoent();
    }),
    access: vi.fn().mockImplementation(async () => {
      throw makeEnoent();
    }),
    stat: vi.fn().mockImplementation(async () => {
      throw makeEnoent();
    }),
    readdir: vi.fn().mockResolvedValue([]),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
  return { ...base, ...overrides };
}

function installBaseMocks(
  fsMock: FsPromisesMock,
  options: { smartTitle?: string } = {},
): void {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  vi.doMock('node:fs/promises', () => ({
    default: fsMock,
    ...fsMock,
  }));

  vi.doMock('@core/logger', () => ({
    createScopedLogger: () => logger,
  }));

  vi.doMock('@core/services/settingsStore', () => ({
    setSettingsStoreAdapter: vi.fn(),
    getSettings: () => ({
      coreDirectory: FIXED_CORE_DIRECTORY,
      providerKeys: { openai: 'test-openai-key' },
      voice: {
        provider: 'openai-whisper',
        voiceInputLanguage: 'auto',
        transcriptionVocabulary: [],
        model: 'scribe_v1',
      },
      meetingBot: {
        physicalMeetingSpaceId: null,
      },
    }),
    updateSettings: vi.fn(),
    updateSettingsAtomic: vi.fn(),
  }));

  vi.doMock('@main/services/authService', () => ({
    getAuthState: () => ({
      user: {
        id: 'user-fixture-001',
        name: 'Test User',
        email: 'test@example.com',
      },
    }),
    hasValidAuth: () => true,
  }));

  vi.doMock('@main/utils/authEnvUtils', () => ({
    hasValidAuth: () => true,
  }));

  vi.doMock('@core/rebelAuth', () => ({
    getRebelAuthProvider: () => ({
      getAuthState: () => ({
        user: {
          id: 'user-fixture-001',
          name: 'Test User',
          email: 'test@example.com',
        },
      }),
    }),
    setRebelAuthProvider: vi.fn(),
    NULL_REBEL_AUTH_PROVIDER: {},
  }));

  vi.doMock('@main/services/spaceService', () => ({
    scanSpaces: vi.fn(async () => [
      {
        name: 'Chief of Staff',
        path: 'Chief-of-Staff',
        absolutePath: FIXED_CHIEF_OF_STAFF_PATH,
        type: 'chief-of-staff',
        sharing: 'private',
      },
    ]),
    getSpaceDisplayName: vi.fn(() => 'Chief of Staff'),
  }));

  vi.doMock('@main/services/meetingBot/transcriptSensitivityGuard', () => ({
    evaluateTranscriptForSharedSpace: vi.fn(async () => ({ decision: 'allow' })),
    broadcastTranscriptStagingEvents: vi.fn(),
  }));

  vi.doMock('@main/services/safety/cosPendingService', () => ({
    writeToPending: vi.fn(async () => null),
  }));

  vi.doMock('@main/services/safety/memoryWriteHook', () => ({
    normalizeSharing: (sharing: string | undefined) => sharing ?? 'private',
  }));

  vi.doMock('@core/services/promptFileService', () => ({
    getPrompt: vi.fn(() => ''),
    PROMPT_IDS: { UTILITY_TRANSCRIPT_CLEANUP: 'cleanup' },
  }));

  vi.doMock('@main/services/behindTheScenesClient', () => ({
    callBehindTheScenesWithAuth: vi.fn(async () => ({
      content: [{ type: 'text', text: options.smartTitle ?? 'Extracted Q1 Planning Sync' }],
    })),
  }));

  vi.doMock('@core/services/costLedgerService', () => ({
    appendCostEntry: vi.fn(),
  }));

  vi.doMock('@core/tracking', () => ({
    getTracker: () => ({
      track: vi.fn(),
    }),
  }));
}

function getCapturedMarkdown(fsMock: FsPromisesMock): string {
  const markdownWrites = fsMock.writeFile.mock.calls.filter((call) => {
    const [filePath, content] = call;
    return String(filePath).endsWith('.md') && typeof content === 'string';
  });

  const write = markdownWrites.at(-1);
  if (!write) {
    throw new Error('Expected one markdown write in scenario');
  }
  return write[1] as string;
}

function splitFrontmatter(markdown: string): { frontmatterRaw: string; body: string } {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    throw new Error('Missing YAML frontmatter');
  }
  return {
    frontmatterRaw: match[1],
    body: markdown.slice(match[0].length),
  };
}

function parseFrontmatter(markdown: string): Record<string, unknown> {
  const { frontmatterRaw } = splitFrontmatter(markdown);
  const parsed = parseYaml(frontmatterRaw);
  if (!parsed || typeof parsed !== 'object') {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function extractFullContent(markdown: string): string {
  const { body } = splitFrontmatter(markdown);
  const lines = body.split('\n');
  const start = lines.findIndex((line) => line.trim() === '## Full Content');
  if (start < 0) {
    throw new Error('Missing ## Full Content section');
  }

  const sectionLines: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) {
      break;
    }
    sectionLines.push(lines[i]);
  }
  return sectionLines.join('\n').trimEnd();
}

async function runWithDeterminism<T>(runner: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(FIXED_NOW_ISO));
  const localeTimeSpy = vi
    .spyOn(Date.prototype, 'toLocaleTimeString')
    .mockReturnValue(FIXED_LOCALE_TIME);

  try {
    return await runner();
  } finally {
    localeTimeSpy.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
}

async function runRecallScenario(): Promise<string> {
  const fsMock = createFsPromisesMock();
  installBaseMocks(fsMock);

  const { saveTranscript } = await import('@main/services/meetingBot/transcriptStorage');
  const result = await saveTranscript({
    botId: 'bot-fixture-recall',
    meetingTitle: FIXED_MEETING_TITLE,
    meetingUrl: FIXED_MEETING_URL,
    participants: FIXED_PARTICIPANTS,
    duration: FIXED_DURATION_SECONDS,
    startTime: FIXED_START_TIME,
    rawTranscript: FIXED_TRANSCRIPT,
    sourceSystem: 'recall',
  });

  expect(result.success).toBe(true);
  return getCapturedMarkdown(fsMock);
}

async function runExternalFirefliesScenario(
  inputOverrides?: FirefliesMappingInput,
): Promise<string> {
  const fsMock = createFsPromisesMock();
  installBaseMocks(fsMock);

  const { saveExternalTranscript } = await import('@main/services/meetingBot/transcriptStorage');
  const result = await saveExternalTranscript({
    externalId: 'fireflies-fixture-001',
    provider: 'fireflies',
    meetingTitle: FIXED_MEETING_TITLE,
    meetingUrl: inputOverrides?.meetingUrl ?? FIXED_MEETING_URL,
    transcriptUrl: 'https://app.fireflies.ai/view/fireflies-fixture-001',
    participants: FIXED_PARTICIPANTS,
    duration: FIXED_DURATION_SECONDS,
    startTime: FIXED_START_TIME,
    rawTranscript: FIXED_TRANSCRIPT,
    calendarId: inputOverrides?.calendarEventId,
  });

  expect(result.success).toBe(true);
  return getCapturedMarkdown(fsMock);
}

async function runExternalFathomScenario(): Promise<string> {
  const fsMock = createFsPromisesMock();
  installBaseMocks(fsMock);

  const { saveExternalTranscript } = await import('@main/services/meetingBot/transcriptStorage');
  const result = await saveExternalTranscript({
    externalId: 'fathom-fixture-001',
    provider: 'fathom',
    meetingTitle: FIXED_MEETING_TITLE,
    meetingUrl: FIXED_MEETING_URL,
    transcriptUrl: 'https://fathom.video/share/fathom-fixture-001',
    participants: FIXED_PARTICIPANTS,
    duration: FIXED_DURATION_SECONDS,
    startTime: FIXED_START_TIME,
    rawTranscript: FIXED_TRANSCRIPT,
  });

  expect(result.success).toBe(true);
  return getCapturedMarkdown(fsMock);
}

async function runPlaudScenario(): Promise<string> {
  const plaudMetadata = {
    id: 'plaud-fixture-001',
    name: 'Plaud Fixture Recording',
    created_at: FIXED_START_TIME,
    start_at: FIXED_START_TIME,
    duration: 1_800_000,
    serial_number: 'PLAUD-SN-001',
  };

  const fsMock = createFsPromisesMock({
    readFile: vi.fn().mockImplementation(async (filePath: string) => {
      if (String(filePath).endsWith('.mp3')) {
        return Buffer.from('mock-plaud-audio');
      }
      if (String(filePath).endsWith('.meta.json')) {
        return JSON.stringify(plaudMetadata);
      }
      throw makeEnoent();
    }),
    stat: vi.fn().mockImplementation(async (filePath: string) => {
      if (String(filePath).endsWith('.mp3')) {
        return { size: 1024 * 1024 };
      }
      throw makeEnoent();
    }),
  });

  installBaseMocks(fsMock, { smartTitle: 'Extracted Smart Title Bug' });

  vi.doMock('electron', () => ({
    app: {
      getPath: () => '/mock/userData',
    },
  }));

  vi.doMock('@main/services/plaud/plaudAuthService', () => ({
    getPlaudConfigDir: () => '/mock/userData/plaud',
    isPlaudConnected: vi.fn(async () => true),
    ensureValidToken: vi.fn(async () => undefined),
  }));

  vi.doMock('@main/services/plaud/plaudApiClient', () => ({
    fetchAllPlaudFiles: vi.fn(async () => [plaudMetadata]),
    fetchPlaudFileDetails: vi.fn(async () => ({
      id: plaudMetadata.id,
      presigned_url: 'https://example.com/plaud-fixture-001.mp3',
    })),
    downloadAudioFile: vi.fn(async () => undefined),
    fileExists: vi.fn(async () => false),
  }));

  vi.doMock('@main/services/inboxStore', () => ({
    addInboxItem: vi.fn(),
  }));

  vi.doMock('@main/services/meetingBot/transcriptEventBus', () => ({
    emitTranscriptSaved: vi.fn(),
    deferTranscriptSaved: vi.fn(),
    emitTranscriptDistributionReady: vi.fn(),
  }));

  vi.doMock('@main/services/localSttService', () => ({
    isModelReady: vi.fn(async () => false),
    transcribeWithLocalModel: vi.fn(),
  }));

  vi.doMock('axios', () => ({
    default: {
      post: vi.fn(async () => ({ data: { text: FIXED_TRANSCRIPT } })),
    },
  }));

  const { initializePlaudSyncService, syncPlaudRecordings } = await import(
    '@main/services/plaud/plaudSyncService'
  );

  initializePlaudSyncService({
    getSyncIntervalMinutes: () => 15,
  });
  const result = await syncPlaudRecordings();

  expect(result.synced).toBe(1);
  expect(result.errors).toBe(0);
  return getCapturedMarkdown(fsMock);
}

async function runPhysicalRecordingScenario(
  sourceSystem: 'limitless' | 'quick_capture',
): Promise<string> {
  const fsMock = createFsPromisesMock();
  installBaseMocks(fsMock);

  vi.doMock('axios', () => ({
    default: {
      post: vi.fn(async () => ({ data: { text: FIXED_TRANSCRIPT } })),
    },
  }));

  const randomUuidSpy = vi
    .spyOn(crypto, 'randomUUID')
    .mockReturnValue(
      sourceSystem === 'limitless'
        ? '11111111-1111-4111-8111-111111111111'
        : '22222222-2222-4222-8222-222222222222',
    );

  try {
    const { transcribePhysicalRecording } = await import(
      '@main/services/physicalRecording/transcriptionService'
    );

    const result = await transcribePhysicalRecording(
      Buffer.alloc(1024),
      FIXED_DURATION_SECONDS,
      new Date(FIXED_START_TIME),
      undefined,
      sourceSystem === 'quick_capture'
        ? {
            sourceSystem: 'quick_capture',
            deviceName: 'Built-in Microphone',
            audioMimeType: 'audio/wav',
          }
        : undefined,
    );

    expect(result.savedPath).toContain(
      sourceSystem === 'quick_capture' ? 'quick-capture' : 'limitless',
    );
    return getCapturedMarkdown(fsMock);
  } finally {
    randomUuidSpy.mockRestore();
  }
}

async function runDesktopSdkScenario(): Promise<string> {
  const fsMock = createFsPromisesMock();
  installBaseMocks(fsMock);

  vi.doMock('electron', () => ({
    BrowserWindow: {
      getAllWindows: () => [],
    },
    systemPreferences: {
      getMediaAccessStatus: vi.fn(() => 'granted'),
      isTrustedAccessibilityClient: vi.fn(() => true),
      askForMediaAccess: vi.fn(async () => true),
    },
    dialog: {
      showMessageBox: vi.fn(async () => ({ response: 1 })),
    },
    shell: {
      openExternal: vi.fn(async () => undefined),
    },
    app: {
      on: vi.fn(),
      quit: vi.fn(),
    },
  }));

  vi.doMock('@main/services/gracefulShutdown', () => ({
    isUpdateQuit: () => false,
  }));

  vi.doMock('@main/services/meetingBot/backendAuth', () => ({
    generateBackendAuthHeader: () => 'mock-auth-header',
  }));

  vi.doMock('@core/services/meetingBotBackendConfig', async () => {
    const actual = await vi.importActual<typeof import('@core/services/meetingBotBackendConfig')>(
      '@core/services/meetingBotBackendConfig',
    );
    return {
      ...actual,
      resolveMeetingBotBackendConfig: vi.fn(() => ({
        configured: true,
        url: 'https://backend.example',
        authKey: 'test-key',
      })),
    };
  });

  vi.doMock('@main/services/meetingBot/transcriptEventBus', () => ({
    emitTranscriptSaved: vi.fn(),
    deferTranscriptSaved: vi.fn(),
    emitTranscriptDistributionReady: vi.fn(),
  }));

  vi.doMock('@main/services/meetingBot/pendingLocalUploadsStore', () => ({
    addPendingLocalUpload: vi.fn(),
    getPendingLocalUploadsNeedingPoll: vi.fn(() => []),
    updatePendingLocalUploadStatus: vi.fn(),
    removePendingLocalUpload: vi.fn(),
    cleanupExpiredUploads: vi.fn(),
  }));

  vi.doMock('@main/services/physicalRecording/physicalRecordingService', () => ({
    isPhysicalRecordingActive: () => false,
  }));

  vi.doMock('@main/ipc/quickCaptureState', () => ({
    isQuickCaptureActive: () => false,
  }));

  vi.doMock('@main/services/meetingBot/meetingBotRuntimeRegistry', () => ({
    registerIsLocalRecordingCapturingProvider: vi.fn(),
    registerLocalRecordingStatusProvider: vi.fn(),
    registerStopLocalRecordingHandler: vi.fn(),
    getActiveBotState: vi.fn(() => null),
    getCurrentMeeting: vi.fn(() => null),
  }));

  vi.doMock('@main/services/meetingBot/botQAService', () => ({
    startLocalTranscriptBuffer: vi.fn(),
    stopBotQA: vi.fn(),
    processTranscriptSegment: vi.fn(),
  }));

  vi.doMock('@main/services/meetingBot/conversationStateService', () => ({
    startStateTracking: vi.fn(),
    stopStateTracking: vi.fn(),
  }));

  vi.doMock('@main/services/liveCoachService', () => ({
    resetBotCoachState: vi.fn(),
    setCoachStartTime: vi.fn(),
  }));

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        transcript: FIXED_TRANSCRIPT,
        participants: FIXED_PARTICIPANTS,
        duration: FIXED_DURATION_SECONDS,
        meetingTitle: FIXED_MEETING_TITLE,
        startTime: FIXED_START_TIME,
      }),
      text: async () => '',
    })),
  );

  const { processAndSaveLocalRecording } = await import(
    '@main/services/meetingBot/localRecordingService'
  );

  const result = await processAndSaveLocalRecording({
    uploadId: 'desktop-fixture-001',
    clientSecret: 'desktop-secret',
    meetingTitle: FIXED_MEETING_TITLE,
  });

  expect(result.success).toBe(true);
  return getCapturedMarkdown(fsMock);
}

async function runScenario(
  source: SourceScenario,
  firefliesInput?: FirefliesMappingInput,
): Promise<string> {
  vi.resetModules();
  vi.clearAllMocks();

  return runWithDeterminism(async () => {
    switch (source) {
      case 'recall':
        return runRecallScenario();
      case 'external_fireflies':
        return runExternalFirefliesScenario(firefliesInput);
      case 'external_fathom':
        return runExternalFathomScenario();
      case 'plaud':
        return runPlaudScenario();
      case 'limitless':
        return runPhysicalRecordingScenario('limitless');
      case 'desktop_sdk':
        return runDesktopSdkScenario();
      case 'quick_capture':
        return runPhysicalRecordingScenario('quick_capture');
      default:
        throw new Error(`Unhandled source scenario: ${source}`);
    }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Pre-kernel staged: characterisation fixtures', () => {
  const sources: SourceScenario[] = [
    'recall',
    'external_fireflies',
    'external_fathom',
    'plaud',
    'limitless',
    'desktop_sdk',
    'quick_capture',
  ];

  for (const source of sources) {
    it(`captures and verifies ${source}`, async () => {
      const captured = await runScenario(
        source,
        source === 'external_fireflies'
          ? {
              meetingUrl: FIXED_MEETING_URL,
              calendarEventId: FIXED_FIREFLIES_CALENDAR_ID,
            }
          : undefined,
      );
      const destination = fixturePath(source);

      if (process.env.CAPTURE_FIXTURES === '1') {
        fs.mkdirSync(FIXTURE_DIR, { recursive: true });
        fs.writeFileSync(destination, captured, 'utf-8');
      } else {
        const expected = fs.readFileSync(destination, 'utf-8');
        expect(parseFrontmatter(captured)).toEqual(parseFrontmatter(expected));
        expect(extractFullContent(captured)).toEqual(extractFullContent(expected));
      }
    });
  }

  it('Fireflies calendar_event_id mapping (A11)', async () => {
    const mappingPath = path.join(FIXTURE_DIR, 'firefliesCalendarIdMapping.json');
    const mapping = JSON.parse(
      fs.readFileSync(mappingPath, 'utf-8'),
    ) as FirefliesMappingFile;

    for (const scenario of mapping.scenarios) {
      const captured = await runScenario('external_fireflies', scenario.input);
      const frontmatter = parseFrontmatter(captured);
      const calendarEventId =
        (frontmatter.calendar_event_id ?? frontmatter.calendar_id ?? null) as string | null;

      expect(calendarEventId, scenario.name).toEqual(
        scenario.expected_frontmatter_calendar_event_id,
      );
    }
  });
});
