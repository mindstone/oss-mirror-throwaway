/**
 * allowedExtensionIds — unit tests (A2).
 *
 * The allowlist is the final gate between the App Bridge and the outside
 * world, so we test every documented invariant:
 *
 *   - `resolveAllowedExtensionIds()` returns the production list when the
 *     env var is absent.
 *   - `REBEL_APP_BRIDGE_EXTRA_EXTENSION_IDS` appends validated entries
 *     (32-char `[a-p]`) to the production list, de-duplicated.
 *   - Malformed env entries are silently dropped (we never want a bad env
 *     var to crash startup) so the resolved list is "production + valid
 *     extras" — invalid tokens never land.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_EXTENSION_IDS,
  readExtraExtensionIdsFromEnv,
  resolveAllowedExtensionIds,
} from '@core/appBridge/shared/allowedExtensionIds';

describe('appBridge/shared/allowedExtensionIds', () => {
  it('resolveAllowedExtensionIds returns the production list when env is empty', () => {
    const resolved = resolveAllowedExtensionIds({});
    expect(resolved).toEqual(PRODUCTION_EXTENSION_IDS);
  });

  it('readExtraExtensionIdsFromEnv returns [] when env var is missing', () => {
    expect(readExtraExtensionIdsFromEnv({})).toEqual([]);
  });

  it('readExtraExtensionIdsFromEnv parses comma-separated 32-char IDs', () => {
    const ids = readExtraExtensionIdsFromEnv({
      REBEL_APP_BRIDGE_EXTRA_EXTENSION_IDS:
        'aaaabbbbccccddddeeeeffffgggghhhh,iiiikkkklllllmmmnnnnooooppppabcd'.slice(0, 65),
    });
    expect(ids).toContain('aaaabbbbccccddddeeeeffffgggghhhh');
  });

  it('readExtraExtensionIdsFromEnv drops malformed entries silently', () => {
    const ids = readExtraExtensionIdsFromEnv({
      REBEL_APP_BRIDGE_EXTRA_EXTENSION_IDS:
        'aaaabbbbccccddddeeeeffffgggghhhh,TOO-SHORT,zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', // 3rd has uppercase, 2nd is short
    });
    expect(ids).toEqual(['aaaabbbbccccddddeeeeffffgggghhhh']);
  });

  it('readExtraExtensionIdsFromEnv drops IDs with characters outside [a-p]', () => {
    // `y` is not in `[a-p]` — Chromium-style IDs only use the first 16 letters.
    const ids = readExtraExtensionIdsFromEnv({
      REBEL_APP_BRIDGE_EXTRA_EXTENSION_IDS:
        'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy,aaaabbbbccccddddeeeeffffgggghhhh',
    });
    expect(ids).toEqual(['aaaabbbbccccddddeeeeffffgggghhhh']);
  });

  it('resolveAllowedExtensionIds unions production + extras with de-duplication', () => {
    const resolved = resolveAllowedExtensionIds({
      REBEL_APP_BRIDGE_EXTRA_EXTENSION_IDS:
        PRODUCTION_EXTENSION_IDS[0] + ',aaaabbbbccccddddeeeeffffgggghhhh',
    });
    expect(resolved.filter((id) => id === PRODUCTION_EXTENSION_IDS[0])).toHaveLength(1);
    expect(resolved).toContain('aaaabbbbccccddddeeeeffffgggghhhh');
  });

  it('resolveAllowedExtensionIds returns a readonly array (caller must not mutate)', () => {
    const resolved = resolveAllowedExtensionIds({});
    // TypeScript won't let us `.push` — this is a runtime sanity check that
    // the function's output is concrete (not a lazy proxy).
    expect(Array.isArray(resolved)).toBe(true);
  });
});
