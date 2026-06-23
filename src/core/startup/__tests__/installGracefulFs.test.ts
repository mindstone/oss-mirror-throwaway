import { createRequire } from 'node:module';
import { describe, it, expect, vi } from 'vitest';

const requireCjs = createRequire(import.meta.url);
const fsCjs = requireCjs('node:fs') as { close: Record<symbol, unknown> };
const GRACEFUL_PREVIOUS_SYMBOL = Symbol.for('graceful-fs.previous');

describe('installGracefulFs (core)', () => {
  it('is idempotent when called twice', async () => {
    const previousDisable = process.env.REBEL_DISABLE_GRACEFUL_FS;
    process.env.REBEL_DISABLE_GRACEFUL_FS = '1';
    vi.resetModules();

    try {
      const { installGracefulFs } = await import('../installGracefulFs');
      const firstApplied = installGracefulFs();
      const afterFirst = fsCjs.close[GRACEFUL_PREVIOUS_SYMBOL];

      const secondApplied = installGracefulFs();
      const afterSecond = fsCjs.close[GRACEFUL_PREVIOUS_SYMBOL];

      expect(firstApplied).toBe(true);
      expect(secondApplied).toBe(false);
      expect(afterFirst).toBeDefined();
      expect(afterSecond).toBe(afterFirst);
    } finally {
      if (previousDisable === undefined) {
        delete process.env.REBEL_DISABLE_GRACEFUL_FS;
      } else {
        process.env.REBEL_DISABLE_GRACEFUL_FS = previousDisable;
      }
    }
  });
});
