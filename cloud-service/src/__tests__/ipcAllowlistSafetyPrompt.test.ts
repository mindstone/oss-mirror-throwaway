/**
 * F-R2-2 — Cloud-service IPC allowlist coverage for safety-prompt and
 * narrow settings channels.
 *
 * Asserts that mobile-adapter-used channels ARE in the allowlist, and that
 * broad settings channels (settings:get, settings:update) are NOT.
 */

import { describe, it, expect } from 'vitest';
import { CLOUD_IPC_ALLOWLIST } from '../routes/ipc';

describe('cloud-service IPC allowlist — safety-prompt channels', () => {
  const required = [
    'safety-prompt:generate-options',
    'safety-prompt:apply-selection',
    'safety-prompt:generate-deny-options',
    'safety-prompt:apply-deny-selection',
  ];

  for (const ch of required) {
    it(`allows ${ch}`, () => {
      expect(CLOUD_IPC_ALLOWLIST.has(ch)).toBe(true);
    });
  }
});

describe('cloud-service IPC allowlist — narrow settings channels', () => {
  it('allows settings:set-space-safety-level', () => {
    expect(CLOUD_IPC_ALLOWLIST.has('settings:set-space-safety-level')).toBe(true);
  });

  it('allows settings:add-trusted-tool', () => {
    expect(CLOUD_IPC_ALLOWLIST.has('settings:add-trusted-tool')).toBe(true);
  });
});

describe('cloud-service IPC allowlist — broad settings NOT allowed (D11)', () => {
  it('does NOT allow settings:get', () => {
    expect(CLOUD_IPC_ALLOWLIST.has('settings:get')).toBe(false);
  });

  it('does NOT allow settings:update', () => {
    expect(CLOUD_IPC_ALLOWLIST.has('settings:update')).toBe(false);
  });
});
