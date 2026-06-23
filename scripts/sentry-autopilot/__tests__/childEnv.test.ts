import { describe, expect, it } from 'vitest';

import { buildChildPath, STANDARD_SYSTEM_PATHS } from '../childEnv.ts';

const STANDARD = STANDARD_SYSTEM_PATHS.join(':');

describe('buildChildPath — cron/tmux PATH matrix (260531_always_append_standard_paths_to_path)', () => {
  it('unset PATH → standard system paths only', () => {
    expect(buildChildPath(undefined)).toBe(STANDARD);
  });

  it('empty PATH → standard system paths only (no leading empty segment)', () => {
    expect(buildChildPath('')).toBe(STANDARD);
  });

  it('set-incomplete PATH → preserves custom entry and appends the missing standard dirs', () => {
    expect(buildChildPath('/opt/homebrew/bin')).toBe(`/opt/homebrew/bin:${STANDARD}`);
  });

  it('set-incomplete PATH with one standard dir present → fills only the gaps, no duplicates', () => {
    expect(buildChildPath('/opt/bin:/usr/bin')).toBe('/opt/bin:/usr/bin:/usr/local/bin:/bin');
  });

  it('set-complete PATH (all standard dirs already present) → returned unchanged, de-duplicated', () => {
    expect(buildChildPath(STANDARD)).toBe(STANDARD);
    // operator entries preserved ahead of the standard dirs
    expect(buildChildPath(`/custom:${STANDARD}`)).toBe(`/custom:${STANDARD}`);
  });

  it('always guarantees every standard system dir is present', () => {
    for (const input of [undefined, '', '/only/custom', '/usr/bin', STANDARD]) {
      const result = buildChildPath(input).split(':');
      for (const std of STANDARD_SYSTEM_PATHS) {
        expect(result).toContain(std);
      }
    }
  });
});
