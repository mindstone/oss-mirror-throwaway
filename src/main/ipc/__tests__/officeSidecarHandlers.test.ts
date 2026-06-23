import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OfficeSidecarStatusResponseSchema,
  type OfficeSidecarStatusResponse,
} from '@shared/ipc/channels/officeSidecar';
import type {
  OfficeSidecarManager,
  OfficeSidecarRuntimeState,
  OfficeSidecarSkipReason,
  SanitizedOfficeSidecarError,
} from '../../services/officeSidecarManager';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('../utils/registerHandler', () => ({
  registerHandler: (channel: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(channel, handler);
  },
}));

import { registerOfficeSidecarHandlers } from '../officeSidecarHandlers';

const RAW_ERROR_MESSAGE = 'literal raw err.message /Users/tester/token /Applications/Microsoft Word.app stateFilePath';
const RAW_STACK = 'Error: literal raw err.message\n    at /Users/tester/private/stack.js:1:1';
const RAW_MANIFEST_PATH = '/Users/tester/Library/Application Support/Rebel/manifest.xml';
const RAW_STATE_FILE_PATH = '/Users/tester/Library/Application Support/Rebel/state.json';

function createManager(options: {
  state?: OfficeSidecarRuntimeState | null;
  skipReason?: OfficeSidecarSkipReason | null;
  lastError?: SanitizedOfficeSidecarError | null;
  retryStart?: () => Promise<OfficeSidecarRuntimeState | null>;
} = {}): OfficeSidecarManager {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn(() => options.state !== null && options.state !== undefined),
    getState: vi.fn(() => options.state ?? null),
    getSkipReason: vi.fn(() => options.skipReason ?? null),
    getLastError: vi.fn(() => options.lastError ?? null),
    retryStart: vi.fn(options.retryStart ?? (async () => options.state ?? null)),
  } as unknown as OfficeSidecarManager;
}

async function invoke<T>(channel: string, request?: unknown): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`Missing handler for ${channel}`);
  }

  return await handler({}, request) as T;
}

describe('officeSidecarHandlers', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('returns the empty status shape when the manager is unavailable', async () => {
    registerOfficeSidecarHandlers({ getManager: () => null });

    const response = await invoke<OfficeSidecarStatusResponse>('office-sidecar:status');
    expect(response).toEqual({
      running: false,
      port: null,
      adopted: false,
      skipReason: null,
      lastError: null,
      startedAt: null,
    });
  });

  it.each([
    ['port-in-use', 'Port 52100 is already in use by another program.'],
    ['cert-failed', "Couldn't set up the local secure connection Office requires."],
    ['wef-install-failed', "Couldn't register the Office add-in with the system."],
    ['script-not-found', 'The Office connection files are incomplete. Please reconnect Microsoft Office in settings.'],
    ['spawn-timeout', 'The Office connection took too long to start.'],
    ['child-crashed', 'The Office connection stopped unexpectedly.'],
    ['unknown', "Couldn't start the Office connection."],
  ] as const)(
    'sanitizes %s errors for status responses',
    async (code, expectedMessage) => {
      const manager = createManager({
        lastError: {
          code,
          message: RAW_ERROR_MESSAGE,
          at: 1_717_171_717,
        },
      });

      registerOfficeSidecarHandlers({ getManager: () => manager });

      const response = await invoke<OfficeSidecarStatusResponse>('office-sidecar:status');
      expect(response).toEqual({
        running: false,
        port: null,
        adopted: false,
        skipReason: null,
        lastError: {
          code,
          message: expectedMessage,
          at: 1_717_171_717,
        },
        startedAt: null,
      });

      const json = JSON.stringify(response);
      expect(json).not.toContain('/Users/');
      expect(json).not.toContain('/Applications/');
      expect(json).not.toContain('stateFilePath');
      expect(json).not.toContain('token');
      expect(json).not.toContain(RAW_ERROR_MESSAGE);
    },
  );

  it('returns the current running state for status responses', async () => {
    const manager = createManager({
      state: {
        pid: 1234,
        port: 52100,
        adopted: true,
        startedAt: 1_717_171_000,
      },
      skipReason: null,
    });

    registerOfficeSidecarHandlers({ getManager: () => manager });

    const response = await invoke<OfficeSidecarStatusResponse>('office-sidecar:status');
    expect(response).toEqual({
      running: true,
      port: 52100,
      adopted: true,
      skipReason: null,
      lastError: null,
      startedAt: 1_717_171_000,
    });
  });

  it('returns the sanitized retry result when the manager restarts successfully', async () => {
    const state: OfficeSidecarRuntimeState = {
      pid: 2222,
      port: 52101,
      adopted: false,
      startedAt: 1_717_171_222,
    };
    const manager = createManager({
      state: null,
      retryStart: async () => state,
    });

    registerOfficeSidecarHandlers({ getManager: () => manager });

    const response = await invoke('office-sidecar:retry-start');
    expect(response).toEqual({
      restarted: true,
      port: 52101,
      adopted: false,
      skipReason: null,
      error: null,
    });
  });

  it('returns a sanitized retry failure without leaking raw details', async () => {
    const manager = createManager({
      lastError: {
        code: 'child-crashed',
        message: RAW_ERROR_MESSAGE,
        at: 1_717_171_717,
      },
      retryStart: async () => {
        throw new Error(RAW_ERROR_MESSAGE);
      },
    });

    registerOfficeSidecarHandlers({ getManager: () => manager });

    const response = await invoke('office-sidecar:retry-start');
    expect(response).toEqual({
      restarted: false,
      port: null,
      adopted: false,
      skipReason: null,
      error: {
        code: 'child-crashed',
        message: 'The Office connection stopped unexpectedly.',
        at: 1_717_171_717,
      },
    });

    const json = JSON.stringify(response);
    expect(json).not.toContain('/Users/');
    expect(json).not.toContain('/Applications/');
    expect(json).not.toContain('stateFilePath');
    expect(json).not.toContain('token');
    expect(json).not.toContain(RAW_ERROR_MESSAGE);
  });

  it('drops stack and path fields from status responses', async () => {
    const manager = createManager({
      lastError: {
        code: 'unknown',
        message: RAW_ERROR_MESSAGE,
        at: 1_717_171_717,
        stack: RAW_STACK,
        manifestPath: RAW_MANIFEST_PATH,
        stateFilePath: RAW_STATE_FILE_PATH,
        err: {
          message: RAW_ERROR_MESSAGE,
        },
      } as unknown as SanitizedOfficeSidecarError,
    });

    registerOfficeSidecarHandlers({ getManager: () => manager });

    const response = await invoke<OfficeSidecarStatusResponse>('office-sidecar:status');
    const json = JSON.stringify(response);

    expect(json).not.toContain('stack');
    expect(json).not.toContain('manifestPath');
    expect(json).not.toContain('stateFilePath');
    expect(json).not.toContain(RAW_STACK);
    expect(json).not.toContain(RAW_MANIFEST_PATH);
    expect(json).not.toContain(RAW_STATE_FILE_PATH);
    expect(json).not.toContain(RAW_ERROR_MESSAGE);
  });

  it('rejects extra keys at the status boundary', () => {
    expect(() => OfficeSidecarStatusResponseSchema.parse({
      running: false,
      port: null,
      adopted: false,
      skipReason: null,
      lastError: null,
      startedAt: null,
      stateFilePath: '/Users/tester/Library/Application Support/Rebel/state.json',
    } as unknown)).toThrow();

    expect(() => OfficeSidecarStatusResponseSchema.parse({
      running: false,
      port: null,
      adopted: false,
      skipReason: null,
      lastError: null,
      startedAt: null,
      token: '0123456789abcdef0123456789abcdef',
    } as unknown)).toThrow();
  });
});
