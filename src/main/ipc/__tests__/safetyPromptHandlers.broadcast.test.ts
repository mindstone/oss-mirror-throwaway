/**
 * F-R2-1 — Safety-prompt broadcast coverage.
 *
 * Asserts that every successful mutation path in safetyPromptHandlers
 * broadcasts `safety-prompt:updated` with the correct payload shape.
 * Asserts that no broadcast fires when a mutation fails.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted above any import of the handlers module.
// ---------------------------------------------------------------------------

const mockBroadcast = { sendToAllWindows: vi.fn(), sendToFocusedWindow: vi.fn() };

vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock({ getBroadcastService: () => mockBroadcast });
});

vi.mock('@core/safetyPromptStore', () => {
  let version = 1;
  let prompt = 'default prompt';
  const meta = () => ({
    prompt,
    version,
    lastUpdatedAt: 1713200000000 + version,
    lastUpdatedBy: 'user' as const,
    history: [],
    migrationComplete: true,
  });
  return {
    DEFAULT_SAFETY_PROMPT: 'default prompt',
    getSafetyPrompt: () => prompt,
    getSafetyPromptVersion: () => version,
    getSafetyPromptWithMeta: meta,
    updateSafetyPrompt: (p: string, _by: string) => {
      prompt = p;
      version++;
    },
    revertToVersion: (target: number) => {
      if (target < 1) return null;
      version++;
      return meta();
    },
  };
});

vi.mock('@core/safetyPromptLogic', () => ({
  clearCache: vi.fn(),
  consolidateSafetyPrompt: vi.fn().mockResolvedValue(null),
  generatePrincipleOptions: vi.fn(),
  applySelectedPrinciple: vi.fn(),
  generateDenyPrincipleOptions: vi.fn(),
  applySelectedDenyPrinciple: vi.fn(),
}));

vi.mock('@core/safetyActivityLogStore', () => ({
  addVersionChangeEntry: vi.fn(),
}));

vi.mock('../../services/safety/approvalReEvalService', () => ({
  reEvaluatePendingApprovals: vi.fn().mockResolvedValue(undefined),
}));

// Capture registered handlers so we can invoke them directly.
const handlers = new Map<string, (...args: any[]) => any>();
vi.mock('../utils/registerHandler', () => ({
  registerHandler: (channel: string, fn: (...args: any[]) => any) => {
    handlers.set(channel, fn);
  },
}));

// Import after mocks are set up.
import { registerSafetyPromptHandlers } from '../safetyPromptHandlers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function broadcastCalls(): Array<{ channel: string; payload: unknown }> {
  return (mockBroadcast.sendToAllWindows as Mock).mock.calls
    .filter((args: unknown[]) => args[0] === 'safety-prompt:updated')
    .map((args: unknown[]) => ({ channel: args[0] as string, payload: args[1] }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('safetyPromptHandlers — safety-prompt:updated broadcast', () => {
  beforeEach(() => {
    handlers.clear();
    mockBroadcast.sendToAllWindows.mockClear();
    registerSafetyPromptHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('broadcasts after safety-prompt:update', async () => {
    const handler = handlers.get('safety-prompt:update')!;
    await handler(null, { prompt: 'new rules', updatedBy: 'user' });
    const calls = broadcastCalls();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.payload).toEqual(
      expect.objectContaining({
        version: expect.any(Number),
        lastUpdatedAt: expect.any(Number),
        lastUpdatedBy: expect.any(String),
      }),
    );
  });

  it('broadcasts after safety-prompt:revert', async () => {
    const handler = handlers.get('safety-prompt:revert')!;
    await handler(null, { targetVersion: 1 });
    const calls = broadcastCalls();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.payload).toEqual(
      expect.objectContaining({
        version: expect.any(Number),
        lastUpdatedAt: expect.any(Number),
        lastUpdatedBy: expect.any(String),
      }),
    );
  });

  it('broadcasts after safety-prompt:reset', async () => {
    const handler = handlers.get('safety-prompt:reset')!;
    await handler(null);
    const calls = broadcastCalls();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.payload).toEqual(
      expect.objectContaining({
        version: expect.any(Number),
        lastUpdatedAt: expect.any(Number),
        lastUpdatedBy: expect.any(String),
      }),
    );
  });

  it('broadcasts after consolidation write', async () => {
    // Make consolidation return a different prompt so the write path fires.
    const { consolidateSafetyPrompt } = await import('@core/safetyPromptLogic');
    (consolidateSafetyPrompt as Mock).mockResolvedValueOnce('consolidated prompt');

    const handler = handlers.get('safety-prompt:update')!;
    await handler(null, { prompt: 'new rules', updatedBy: 'user' });

    // Wait for the deferred consolidation microtask.
    await new Promise((r) => setTimeout(r, 50));

    const calls = broadcastCalls();
    // At least 2: one from the update, one from the consolidation.
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does NOT broadcast on revert failure (version not found)', async () => {
    // The mock's revertToVersion returns null for target < 1, which causes
    // the handler to throw before reaching the broadcast call.
    const handler = handlers.get('safety-prompt:revert')!;
    mockBroadcast.sendToAllWindows.mockClear();
    await expect(handler(null, { targetVersion: -999 })).rejects.toThrow();

    const calls = broadcastCalls();
    expect(calls).toHaveLength(0);
  });
});
