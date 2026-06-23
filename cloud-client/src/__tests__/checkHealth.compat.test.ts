import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkHealth,
  clearConfig,
  configure,
  getServerCapabilities,
} from '../cloudClient';

const TEST_URL = 'https://test.example.com';
const TEST_TOKEN = 'test-token';

function jsonResponse(body: unknown, capabilitiesHeader?: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: capabilitiesHeader === undefined ? undefined : { 'X-Rebel-Capabilities': capabilitiesHeader },
  });
}

describe('checkHealth compatibility', () => {
  beforeEach(() => {
    clearConfig();
    configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearConfig();
  });

  it('keeps pressure undefined and capability false on older cloud payloads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse(
        {
          status: 'ok',
          version: '1.0.0',
        },
        'session-event-delta-push',
      ),
    ));

    const health = await checkHealth();
    expect(health.pressure).toBeUndefined();

    const capabilities = await getServerCapabilities();
    expect(capabilities.supportsResourcePressure).toBe(false);
  });

  it('keeps pressure undefined and capability false when capabilities header is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({
        status: 'ok',
        version: '1.0.0',
      }),
    ));

    const health = await checkHealth();
    expect(health.pressure).toBeUndefined();

    const capabilities = await getServerCapabilities();
    expect(capabilities.supportsResourcePressure).toBe(false);
  });

  it('parses pressure payload and capability when cloud supports resource pressure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse(
        {
          status: 'ok',
          version: '1.0.0',
          pressure: {
            state: 'warning',
            oomRecent: true,
            recentRestart: false,
          },
        },
        'session-event-delta-push,cloud-resource-pressure',
      ),
    ));

    const health = await checkHealth();
    expect(health.pressure).toEqual({
      state: 'warning',
      oomRecent: true,
      recentRestart: false,
    });

    const capabilities = await getServerCapabilities();
    expect(capabilities.supportsResourcePressure).toBe(true);
  });

  it('coerces malformed pressure state to undefined without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse(
        {
          status: 'ok',
          version: '1.0.0',
          pressure: {
            state: 'invalid_value',
            oomRecent: true,
            recentRestart: false,
          },
        },
        'cloud-resource-pressure',
      ),
    ));

    const health = await checkHealth();
    expect(health.pressure).toBeUndefined();
  });
});
