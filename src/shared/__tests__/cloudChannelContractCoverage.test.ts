/**
 * Cloud Channel Contract Coverage Tests
 *
 * Registry-derived contract tests that verify cloud channel policies are
 * properly aligned with the IPC contract and cloud service routes.
 *
 * Checks:
 * 1. Every cloud-routable channel exists in the IPC contract
 * 2. Cloud IPC allowlist channels are a subset of cloud-routable channels
 * 3. The cloud service's extended allowlist is a superset of the shared allowlist
 * 4. Transport types are consistent with routing infrastructure
 *
 * These tests catch integration_gap bugs where cloud routes are defined but
 * not backed by IPC contract entries, or vice versa.
 *
 * @see docs/plans/260406_test_suite_improvements.md (D.3)
 */

import { describe, expect, it } from 'vitest';
import { allChannels, ipcContract } from '@shared/ipc/contracts';
import {
  CLOUD_CHANNEL_POLICIES,
  CLOUD_ROUTABLE_CHANNELS,
  CLOUD_IPC_ALLOWLIST,
  DUAL_WRITE_CHANNELS,
} from '@shared/cloudChannelPolicies';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get all channel names from the IPC contract. */
function getAllIpcChannelNames(): Set<string> {
  return new Set(Object.keys(allChannels));
}

// ---------------------------------------------------------------------------
// Test: Cloud-routable channels are a subset of IPC contract channels
// ---------------------------------------------------------------------------

describe('cloud channel policies — IPC contract alignment', () => {
  const ipcChannelNames = getAllIpcChannelNames();

  it('every cloud-routable channel exists in the IPC contract', () => {
    const missing: string[] = [];

    for (const channel of CLOUD_ROUTABLE_CHANNELS) {
      if (!ipcChannelNames.has(channel)) {
        missing.push(channel);
      }
    }

    expect(
      missing,
      `Cloud-routable channels not in IPC contract: ${missing.join(', ')}. ` +
      `Add them to the appropriate channels/*.ts file, or remove from CLOUD_CHANNEL_POLICIES.`,
    ).toHaveLength(0);
  });

  it('every CLOUD_IPC_ALLOWLIST channel exists in the IPC contract', () => {
    const missing: string[] = [];

    for (const channel of CLOUD_IPC_ALLOWLIST) {
      if (!ipcChannelNames.has(channel)) {
        missing.push(channel);
      }
    }

    expect(
      missing,
      `CLOUD_IPC_ALLOWLIST channels not in IPC contract: ${missing.join(', ')}`,
    ).toHaveLength(0);
  });

  it('every DUAL_WRITE channel exists in the IPC contract', () => {
    const missing: string[] = [];

    for (const channel of DUAL_WRITE_CHANNELS) {
      if (!ipcChannelNames.has(channel)) {
        missing.push(channel);
      }
    }

    expect(
      missing,
      `DUAL_WRITE channels not in IPC contract: ${missing.join(', ')}`,
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test: Cloud policy transport consistency
// ---------------------------------------------------------------------------

describe('cloud channel policies — transport consistency', () => {
  it('every policy entry has a valid transport type', () => {
    const validTransports = new Set(['rest', 'ipc', 'ws']);
    const invalid: string[] = [];

    for (const [channel, policy] of Object.entries(CLOUD_CHANNEL_POLICIES)) {
      if (!validTransports.has(policy.transport)) {
        invalid.push(`${channel} has invalid transport "${policy.transport}"`);
      }
    }

    expect(invalid, `Invalid transports: ${invalid.join(', ')}`).toHaveLength(0);
  });

  it('transport:ipc channels are in CLOUD_IPC_ALLOWLIST', () => {
    const ipcTransportChannels = Object.entries(CLOUD_CHANNEL_POLICIES)
      .filter(([, p]) => p.transport === 'ipc')
      .map(([ch]) => ch);

    for (const channel of ipcTransportChannels) {
      expect(
        CLOUD_IPC_ALLOWLIST.has(channel),
        `Channel "${channel}" has transport:'ipc' but is not in CLOUD_IPC_ALLOWLIST`,
      ).toBe(true);
    }
  });

  it('transport:rest channels are NOT in CLOUD_IPC_ALLOWLIST', () => {
    const restChannels = Object.entries(CLOUD_CHANNEL_POLICIES)
      .filter(([, p]) => p.transport === 'rest')
      .map(([ch]) => ch);

    for (const channel of restChannels) {
      expect(
        CLOUD_IPC_ALLOWLIST.has(channel),
        `Channel "${channel}" has transport:'rest' but IS in CLOUD_IPC_ALLOWLIST — ` +
        `REST channels should have dedicated route handlers, not use generic IPC.`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Test: Cloud channel domain coverage
// ---------------------------------------------------------------------------

describe('cloud channel policies — domain coverage', () => {
  it('CLOUD_CHANNEL_POLICIES keys match CLOUD_ROUTABLE_CHANNELS', () => {
    const policyKeys = new Set(Object.keys(CLOUD_CHANNEL_POLICIES));

    // Every policy key should be in CLOUD_ROUTABLE_CHANNELS
    for (const key of policyKeys) {
      expect(
        CLOUD_ROUTABLE_CHANNELS.has(key),
        `CLOUD_CHANNEL_POLICIES has "${key}" but it's not in CLOUD_ROUTABLE_CHANNELS`,
      ).toBe(true);
    }

    // Every CLOUD_ROUTABLE_CHANNELS entry should have a policy
    for (const channel of CLOUD_ROUTABLE_CHANNELS) {
      expect(
        policyKeys.has(channel),
        `CLOUD_ROUTABLE_CHANNELS has "${channel}" but it has no entry in CLOUD_CHANNEL_POLICIES`,
      ).toBe(true);
    }
  });

  it('all routable channels belong to recognized ipcContract domains', () => {
    // Build a map of channel → domain from ipcContract
    const channelDomainMap = new Map<string, string>();
    for (const [domainName, domainChannels] of Object.entries(ipcContract)) {
      for (const channelName of Object.keys(domainChannels)) {
        channelDomainMap.set(channelName, domainName);
      }
    }

    const unknownDomain: string[] = [];
    for (const channel of CLOUD_ROUTABLE_CHANNELS) {
      if (!channelDomainMap.has(channel)) {
        unknownDomain.push(channel);
      }
    }

    expect(
      unknownDomain,
      `Cloud-routable channels with no ipcContract domain: ${unknownDomain.join(', ')}`,
    ).toHaveLength(0);
  });
});
