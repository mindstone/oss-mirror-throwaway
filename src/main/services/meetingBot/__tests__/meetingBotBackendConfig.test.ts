import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => logger,
}));

import {
  MEETING_BOT_BACKEND_CONFIG_MISSING_REASON,
  resolveMeetingBotBackendConfig,
  setMeetingBotBackendConfigProvider,
  type MeetingBotBackendConfigError,
} from '@core/services/meetingBotBackendConfig';
import { generateBackendAuthHeader } from '../backendAuth';
import { WorkerRecallTransport } from '../recallTransport';

const ENV_KEYS = ['MEETING_BOT_BACKEND_URL', 'MEETING_BOT_BACKEND_AUTH_KEY'] as const;

let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
  savedEnv = {
    MEETING_BOT_BACKEND_URL: process.env.MEETING_BOT_BACKEND_URL,
    MEETING_BOT_BACKEND_AUTH_KEY: process.env.MEETING_BOT_BACKEND_AUTH_KEY,
  };
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  setMeetingBotBackendConfigProvider(null);
  logger.error.mockClear();
});

afterEach(() => {
  setMeetingBotBackendConfigProvider(null);
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('meeting bot backend config resolver', () => {
  it('resolves a complete env pair', () => {
    process.env.MEETING_BOT_BACKEND_URL = ' https://env-backend.example ';
    process.env.MEETING_BOT_BACKEND_AUTH_KEY = ' env-key ';

    expect(resolveMeetingBotBackendConfig()).toEqual({
      configured: true,
      url: 'https://env-backend.example',
      authKey: 'env-key',
    });
  });

  it('resolves URL and auth key from the injected provider', () => {
    setMeetingBotBackendConfigProvider({
      get: () => ({
        url: ' https://backend.example ',
        authKey: ' provider-key ',
      }),
    });

    expect(resolveMeetingBotBackendConfig()).toEqual({
      configured: true,
      url: 'https://backend.example',
      authKey: 'provider-key',
    });
  });

  it('prefers env vars over the injected provider', () => {
    process.env.MEETING_BOT_BACKEND_URL = ' https://env-backend.example ';
    process.env.MEETING_BOT_BACKEND_AUTH_KEY = ' env-key ';
    setMeetingBotBackendConfigProvider({
      get: () => ({
        url: 'https://provider-backend.example',
        authKey: 'provider-key',
      }),
    });

    expect(resolveMeetingBotBackendConfig()).toEqual({
      configured: true,
      url: 'https://env-backend.example',
      authKey: 'env-key',
    });
  });

  it('falls through from a URL-only env source to a complete provider pair', () => {
    process.env.MEETING_BOT_BACKEND_URL = 'https://env-backend.example';
    setMeetingBotBackendConfigProvider({
      get: () => ({
        url: 'https://provider-backend.example',
        authKey: 'provider-key',
      }),
    });

    expect(resolveMeetingBotBackendConfig()).toEqual({
      configured: true,
      url: 'https://provider-backend.example',
      authKey: 'provider-key',
    });
  });

  it('falls through from a key-only env source to a complete provider pair', () => {
    process.env.MEETING_BOT_BACKEND_AUTH_KEY = 'env-key';
    setMeetingBotBackendConfigProvider({
      get: () => ({
        url: 'https://provider-backend.example',
        authKey: 'provider-key',
      }),
    });

    expect(resolveMeetingBotBackendConfig()).toEqual({
      configured: true,
      url: 'https://provider-backend.example',
      authKey: 'provider-key',
    });
  });

  it('does not mix a partial env source with a partial provider source', () => {
    process.env.MEETING_BOT_BACKEND_URL = 'https://env-backend.example';
    setMeetingBotBackendConfigProvider({
      get: () => ({
        authKey: 'provider-key',
      }),
    });

    expect(resolveMeetingBotBackendConfig()).toEqual({
      configured: false,
      missing: ['url', 'authKey'],
    });
  });

  it('reports missing values from a partial env source when no provider source is present', () => {
    process.env.MEETING_BOT_BACKEND_AUTH_KEY = 'env-key';

    expect(resolveMeetingBotBackendConfig()).toEqual({
      configured: false,
      missing: ['url'],
    });
  });

  it('reports exactly which values are missing', () => {
    setMeetingBotBackendConfigProvider({
      get: () => ({
        url: 'https://backend.example',
      }),
    });

    expect(resolveMeetingBotBackendConfig()).toEqual({
      configured: false,
      missing: ['authKey'],
    });
  });
});

describe('meeting bot backend config fail-closed behavior', () => {
  it('refuses to sign and logs the structured missing-config reason', () => {
    expect(generateBackendAuthHeader('user-1')).toBeNull();

    expect(logger.error).toHaveBeenCalledWith(
      {
        service: 'meetingBot',
        reason: MEETING_BOT_BACKEND_CONFIG_MISSING_REASON,
        missing: ['url', 'authKey'],
      },
      'Meeting bot backend config missing; refusing to sign backend request',
    );
  });

  it('surfaces a typed not-configured error before the Worker fetch helper sends a request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const transport = new WorkerRecallTransport(() => 'user-1');
    await expect(
      transport.createUploadSession({ meetingTitle: 'Standup' }),
    ).rejects.toMatchObject({
      name: 'MeetingBotBackendConfigError',
      code: MEETING_BOT_BACKEND_CONFIG_MISSING_REASON,
      missing: ['url', 'authKey'],
    } satisfies Partial<MeetingBotBackendConfigError>);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      {
        service: 'meetingBot',
        reason: MEETING_BOT_BACKEND_CONFIG_MISSING_REASON,
        missing: ['url', 'authKey'],
      },
      'Meeting bot backend config missing; refusing backend request',
    );
  });
});
