/**
 * IPC Contract Completeness Tests
 *
 * Registry-derived contract tests that verify IPC channel wiring is complete.
 * Enumerates channels from the canonical ipcContract registry and asserts that:
 *
 * 1. Every domain has a corresponding ipcBridge API export
 * 2. Every channel has valid request/response schemas
 * 3. No duplicate channel names exist across domains
 * 4. Channel names follow the domain:action naming convention
 * 5. All channel definitions have the required 'invoke' type
 *
 * These tests catch integration_gap bugs where handlers are defined in the
 * contract but not registered, or channels are missing from the preload bridge.
 *
 * @see docs/plans/260406_test_suite_improvements.md (D.3)
 */

import { describe, expect, it } from 'vitest';
import { ipcContract, allChannels } from '@shared/ipc/contracts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flatten the domain-grouped ipcContract into an array of [channelName, channelDef] tuples. */
function flattenContract(): Array<[string, { type: string; channel: string; request: unknown; response: unknown }]> {
  const entries: Array<[string, { type: string; channel: string; request: unknown; response: unknown }]> = [];
  for (const [, domainChannels] of Object.entries(ipcContract)) {
    for (const [key, channelDef] of Object.entries(domainChannels)) {
      entries.push([key, channelDef as { type: string; channel: string; request: unknown; response: unknown }]);
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Test: Structural integrity of the contract registry
// ---------------------------------------------------------------------------

describe('ipcContract structural integrity', () => {
  const domainKeys = Object.keys(ipcContract);
  const allEntries = flattenContract();

  it('has at least one domain', () => {
    expect(domainKeys.length).toBeGreaterThan(0);
  });

  it('every domain has at least one channel', () => {
    for (const [domainName, domainChannels] of Object.entries(ipcContract)) {
      const channelCount = Object.keys(domainChannels).length;
      expect(channelCount, `domain "${domainName}" has no channels`).toBeGreaterThan(0);
    }
  });

  it('every channel definition has type, channel, request, and response', () => {
    for (const [channelName, channelDef] of allEntries) {
      expect(channelDef.type, `${channelName} missing type`).toBeDefined();
      expect(channelDef.channel, `${channelName} missing channel`).toBeDefined();
      expect(channelDef.request, `${channelName} missing request schema`).toBeDefined();
      expect(channelDef.response, `${channelName} missing response schema`).toBeDefined();
    }
  });

  it('every channel has a recognized type ("invoke" or "sync")', () => {
    const validTypes = new Set(['invoke', 'sync']);
    for (const [channelName, channelDef] of allEntries) {
      expect(
        validTypes.has(channelDef.type),
        `${channelName} has unrecognized type "${channelDef.type}" — expected "invoke" or "sync"`,
      ).toBe(true);
    }
  });

  it('sync channels are explicitly expected (prevent accidental additions)', () => {
    const syncChannels = allEntries
      .filter(([, def]) => def.type === 'sync')
      .map(([name]) => name);

    // Known sync channels — they use ipcRenderer.sendSync because async invoke won't fit
    // their timing: *:save-sync fire during beforeunload; telemetry-config:sync is a
    // startup read the renderer needs synchronously before React mounts (OSS telemetry
    // gate reads user creds before any client construction — see B6.a).
    // If you're adding a new sync channel, add it here and document why async won't work.
    const expectedSyncChannels = ['folders:save-sync', 'sessions:save-sync', 'telemetry-config:sync'];
    expect(syncChannels.sort()).toEqual(expectedSyncChannels.sort());
  });

  it('channel key matches channel name in definition', () => {
    for (const [channelName, channelDef] of allEntries) {
      expect(
        channelDef.channel,
        `key "${channelName}" does not match channel property "${channelDef.channel}"`,
      ).toBe(channelName);
    }
  });
});

// ---------------------------------------------------------------------------
// Test: No duplicate channel names across domains
// ---------------------------------------------------------------------------

describe('ipcContract — no duplicate channels', () => {
  it('every channel name is unique across all domains', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];

    for (const [domainName, domainChannels] of Object.entries(ipcContract)) {
      for (const channelName of Object.keys(domainChannels)) {
        const existingDomain = seen.get(channelName);
        if (existingDomain) {
          duplicates.push(`"${channelName}" in both "${existingDomain}" and "${domainName}"`);
        }
        seen.set(channelName, domainName);
      }
    }

    expect(duplicates, `Duplicate channels found: ${duplicates.join(', ')}`).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test: allChannels flat map matches ipcContract domains
// ---------------------------------------------------------------------------

describe('ipcContract — allChannels consistency', () => {
  it('allChannels contains every channel from ipcContract domains', () => {
    const contractChannelNames = new Set<string>();
    for (const [, domainChannels] of Object.entries(ipcContract)) {
      for (const channelName of Object.keys(domainChannels)) {
        contractChannelNames.add(channelName);
      }
    }

    const flatChannelNames = new Set(Object.keys(allChannels));

    // Every channel in ipcContract should be in allChannels
    for (const name of contractChannelNames) {
      expect(flatChannelNames.has(name), `allChannels missing "${name}" from ipcContract`).toBe(true);
    }
  });

  it('allChannels does not contain channels missing from ipcContract', () => {
    const contractChannelNames = new Set<string>();
    for (const [, domainChannels] of Object.entries(ipcContract)) {
      for (const channelName of Object.keys(domainChannels)) {
        contractChannelNames.add(channelName);
      }
    }

    const flatChannelNames = Object.keys(allChannels);

    for (const name of flatChannelNames) {
      expect(
        contractChannelNames.has(name),
        `allChannels has "${name}" but it's missing from ipcContract domains`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Test: Channel naming convention
// ---------------------------------------------------------------------------

describe('ipcContract — channel naming conventions', () => {
  /**
   * Known channels that don't follow the domain:action pattern.
   * These are legacy or special-purpose channels. New channels MUST use domain:action.
   */
  const KNOWN_EXCEPTIONS = new Set([
    'check-for-updates', // Legacy misc channel — predates naming convention
  ]);

  it('every channel name follows domain:action pattern (with documented exceptions)', () => {
    const allEntries = flattenContract();
    const violations: string[] = [];

    for (const [channelName] of allEntries) {
      if (!channelName.includes(':') && !KNOWN_EXCEPTIONS.has(channelName)) {
        violations.push(channelName);
      }
    }

    expect(
      violations,
      `Channels without ":" separator (not in KNOWN_EXCEPTIONS): ${violations.join(', ')}. ` +
      `New channels should use the domain:action pattern. If this is intentional, add to KNOWN_EXCEPTIONS.`,
    ).toHaveLength(0);
  });

  it('known exceptions still exist in the contract', () => {
    const allChannelNames = new Set(flattenContract().map(([name]) => name));
    for (const exception of KNOWN_EXCEPTIONS) {
      expect(
        allChannelNames.has(exception),
        `KNOWN_EXCEPTIONS contains "${exception}" but it's no longer in the contract — remove it.`,
      ).toBe(true);
    }
  });
});
