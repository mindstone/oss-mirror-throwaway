/**
 * F4 defense-in-depth: the `identity:capture-oss-lead` main handler is the
 * egress boundary for the OSS-only lead POST. `identityApi` and this handler
 * exist in every build, so a direct renderer call in a COMMERCIAL build could
 * otherwise reach `postOssLeadCapture`. The handler must NO-OP unless this is
 * an OSS build (`getPlatformConfig().isOss === true`), and must FAIL CLOSED
 * (no egress) when PlatformConfig is unavailable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('@core/handlerRegistry', () => ({
  getHandlerRegistry: () => ({
    register: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  }),
}));

const mockGetPlatformConfig = vi.fn<() => { version: string; platform: string; isOss: boolean }>();
vi.mock('@core/platform', () => ({
  getPlatformConfig: () => mockGetPlatformConfig(),
}));

const mockPostOssLeadCapture = vi.fn().mockResolvedValue(undefined);
vi.mock('@core/services/identity/leadCapture', () => ({
  postOssLeadCapture: (...args: unknown[]) => mockPostOssLeadCapture(...args),
}));

import { registerIdentityHandlers } from '../identityHandlers';

const VALID_REQUEST = { firstName: 'Alex', email: 'alex@example.com' };

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  registerIdentityHandlers();
});

function getHandler() {
  const handler = handlers.get('identity:capture-oss-lead');
  expect(handler).toBeDefined();
  return handler!;
}

describe('identity:capture-oss-lead — OSS egress guard (F4)', () => {
  it('POSTs the lead in an OSS build', async () => {
    mockGetPlatformConfig.mockReturnValue({ version: '1.2.3', platform: 'darwin', isOss: true });

    await getHandler()({}, VALID_REQUEST);
    // Detached fire-and-forget — allow the microtask queue to drain.
    await Promise.resolve();

    expect(mockPostOssLeadCapture).toHaveBeenCalledTimes(1);
    const [input] = mockPostOssLeadCapture.mock.calls[0];
    expect(input).toMatchObject({ email: 'alex@example.com', appVersion: '1.2.3', platform: 'darwin' });
  });

  it('NO-OPs in a commercial (non-OSS) build — never reaches the lead POST', async () => {
    mockGetPlatformConfig.mockReturnValue({ version: '1.2.3', platform: 'darwin', isOss: false });

    await getHandler()({}, VALID_REQUEST);
    await Promise.resolve();

    expect(mockPostOssLeadCapture).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED (no egress) when PlatformConfig is unavailable', async () => {
    mockGetPlatformConfig.mockImplementation(() => {
      throw new Error('PlatformConfig not initialised');
    });

    await getHandler()({}, VALID_REQUEST);
    await Promise.resolve();

    expect(mockPostOssLeadCapture).not.toHaveBeenCalled();
  });

  it('skips name-only submissions (empty email) before any OSS/egress logic', async () => {
    mockGetPlatformConfig.mockReturnValue({ version: '1.2.3', platform: 'darwin', isOss: true });

    await getHandler()({}, { firstName: 'Alex', email: '' });
    await Promise.resolve();

    expect(mockPostOssLeadCapture).not.toHaveBeenCalled();
  });
});
