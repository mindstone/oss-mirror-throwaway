import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorReporter } from '@core/errorReporter';
import {
  assertAllowedOriginAsync,
  persistTrustedExtensionId,
} from '@core/appBridge/server/originGuard';

const GOOD_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

function mockRequest(headers: Record<string, string | undefined> = {}): IncomingMessage {
  const normalized: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    normalized[k.toLowerCase()] = v;
  }
  return { headers: normalized } as unknown as IncomingMessage;
}

function mockErrorReporter(): ErrorReporter {
  return {
    captureException: () => {},
    captureMessage: () => {},
    addBreadcrumb: () => {},
  };
}

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('originGuard preview-mode trusted extension persistence', () => {
  it('rehydrates a preview-approved extension across a fresh origin guard instance', async () => {
    const stateDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'origin-guard-preview-persistence-'),
    );
    tempDirs.push(stateDirectory);

    const reporter = mockErrorReporter();
    const firstApproval = persistTrustedExtensionId(
      stateDirectory,
      GOOD_EXTENSION_ID,
      reporter,
    );
    expect(firstApproval).toEqual({ added: true, alreadyPresent: false });

    const onUnknownExtensionOrigin = vi.fn(async () => false);
    const request = mockRequest({ origin: `chrome-extension://${GOOD_EXTENSION_ID}` });

    await expect(
      assertAllowedOriginAsync(request, {
        chromeExtensionIds: [],
        stateDirectory,
        devMode: false,
        previewMode: true,
        onUnknownExtensionOrigin,
        errorReporter: reporter,
      }),
    ).resolves.toEqual({ source: 'allowlist', degraded: false });

    expect(onUnknownExtensionOrigin).not.toHaveBeenCalled();
  });
});
