import { describe, it, expect } from 'vitest';
import { settingsChannels } from '../channels/settings';
import { allChannels } from '../contracts';

/**
 * Stage 1b regression (docs/plans/260622_mobile-setup-investigation): the
 * `settings:update` REQUEST contract must accept a TOP-LEVEL PARTIAL, because the
 * desktop handler shallow-merges the incoming payload over current settings.
 *
 * Before the fix the request was the FULL `AppSettingsSchema` (with required fields
 * like `onboardingCompleted: z.boolean()`). The dev/test contract-parse seam
 * `.parse()`-rejects on a schema violation BEFORE the handler body runs, so a
 * legitimate bare partial (e.g. `{ cloudInstance }` from `useCloudProvisioning.ts`)
 * threw a ZodError instead of being merged — the contract lied about what the
 * handler accepts.
 *
 * These tests assert the request schema now WIDENS to accept bare partials while
 * still accepting full documents, exercised both directly and through the real
 * dev/test contract-parse seam.
 */
describe('settings:update request contract (top-level partial)', () => {
  const requestSchema = settingsChannels['settings:update'].request;

  it('is registered in allChannels with both request + response schemas', () => {
    const def = allChannels['settings:update'];
    expect(def).toBeDefined();
    expect(typeof def.request.safeParse).toBe('function');
    expect(typeof def.response.safeParse).toBe('function');
  });

  it('ACCEPTS a bare partial (only { cloudUpdateChannel }) — the regression', () => {
    // A bare partial that omits all required AppSettings fields (onboardingCompleted,
    // voice, models, …). Under the old full-schema request this threw ZodError.
    const result = requestSchema.safeParse({ cloudUpdateChannel: 'beta' });
    expect(result.success).toBe(true);
  });

  it('ACCEPTS an empty object (every top-level key optional)', () => {
    expect(requestSchema.safeParse({}).success).toBe(true);
  });

  it('still ACCEPTS a full settings document (partial strictly widens)', () => {
    const full = {
      coreDirectory: '/tmp/workspace',
      mcpConfigFile: null,
      onboardingCompleted: true,
      userEmail: 'user@example.com',
      onboardingFirstCompletedAt: 1_700_000_000_000,
      voice: {
        provider: 'openai-whisper',
        openaiApiKey: 'fake-openai-key',
        elevenlabsApiKey: null,
        model: 'whisper-1',
        ttsVoice: null,
        activationHotkey: null,
        activationHotkeyVoiceMode: false,
      },
      models: {
        apiKey: 'fake-anthropic-key',
        model: 'claude-opus-4-7',
        permissionMode: 'bypassPermissions' as const,
        executablePath: null,
        planMode: false,
        extendedContext: true,
        thinkingEffort: 'high',
      },
      diagnostics: { debugBreadcrumbsUntil: null },
      experimental: {},
    };
    expect(requestSchema.safeParse(full).success).toBe(true);
  });

  it('still REJECTS a present-but-malformed top-level field (validation not lost)', () => {
    // `.partial()` makes the key optional, but when PRESENT it is still validated.
    const result = requestSchema.safeParse({ cloudUpdateChannel: 'not-a-channel' });
    expect(result.success).toBe(false);
  });
});

/**
 * Through the REAL dev/test contract-parse seam: a bare-partial `settings:update`
 * must no longer throw ZodError before the handler body runs.
 */
describe('settings:update bare partial passes the dev/test contract-parse seam', () => {
  it('does NOT throw ZodError at the seam and runs the real body (gate ON)', async () => {
    const { ZodError } = await import('zod');
    const { vi } = await import('vitest');
    vi.stubEnv('NODE_ENV', 'test'); // contract enforcement ON
    vi.stubEnv('REBEL_CONTRACT_ENFORCE', '');

    const { wrapHandlerWithContractParse } = await import(
      '../../../main/ipc/utils/registerContractHandler'
    );

    // A full settings document is the contract-valid RESPONSE shape; the seam
    // parses the response after the body, so return a value that satisfies it.
    const validResponse = {
      coreDirectory: null,
      mcpConfigFile: null,
      onboardingCompleted: true,
      userEmail: null,
      onboardingFirstCompletedAt: null,
      voice: {
        provider: 'openai-whisper',
        openaiApiKey: null,
        elevenlabsApiKey: null,
        model: 'whisper-1',
        ttsVoice: null,
        activationHotkey: null,
        activationHotkeyVoiceMode: false,
      },
      models: {
        apiKey: null,
        model: 'claude-opus-4-7',
        permissionMode: 'bypassPermissions',
        executablePath: null,
        planMode: false,
        extendedContext: true,
        thinkingEffort: 'high',
      },
      diagnostics: { debugBreadcrumbsUntil: null },
      experimental: {},
    };

    const body = vi.fn().mockResolvedValue(validResponse);
    const wrapped = wrapHandlerWithContractParse('settings:update', body);

    // The bug: a bare partial threw ZodError at the request-parse seam before the
    // body ran. Now it flows through to the body.
    let threw: unknown = null;
    try {
      await wrapped(null, { cloudInstance: { mode: 'local' } });
    } catch (err) {
      threw = err;
    }
    expect(threw).not.toBeInstanceOf(ZodError);
    expect(threw).toBeNull();
    expect(body).toHaveBeenCalledTimes(1);

    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
});
