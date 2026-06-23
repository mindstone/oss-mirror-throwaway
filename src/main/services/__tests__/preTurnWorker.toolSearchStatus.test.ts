import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let resolveToolSearchStatus: typeof import('../../workers/preTurnWorker').resolveToolSearchStatus;
const originalParentPort = Reflect.get(process, 'parentPort');

beforeAll(async () => {
  Object.defineProperty(process, 'parentPort', {
    value: {
      on: vi.fn(),
      postMessage: vi.fn(),
    },
    configurable: true,
  });

  ({ resolveToolSearchStatus } = await import('../../workers/preTurnWorker'));
});

afterAll(() => {
  if (originalParentPort === undefined) {
    Reflect.deleteProperty(process, 'parentPort');
    return;
  }

  Object.defineProperty(process, 'parentPort', {
    value: originalParentPort,
    configurable: true,
  });
});

describe('resolveToolSearchStatus', () => {
  it('returns skipped when tool search was intentionally skipped', () => {
    expect(resolveToolSearchStatus(true, 'unavailable')).toBe('skipped');
  });

  it('returns ok when search executed successfully', () => {
    expect(resolveToolSearchStatus(false, 'ok')).toBe('ok');
  });

  it('returns unavailable when search could not run', () => {
    expect(resolveToolSearchStatus(false, 'unavailable')).toBe('unavailable');
  });

  it('preserves skipped status on the early-return path with no embeddings', () => {
    expect(resolveToolSearchStatus(true, undefined)).toBe('skipped');
  });

  it('returns undefined when not skipped and no search status (triggers fallback)', () => {
    expect(resolveToolSearchStatus(false, undefined)).toBeUndefined();
  });
});
