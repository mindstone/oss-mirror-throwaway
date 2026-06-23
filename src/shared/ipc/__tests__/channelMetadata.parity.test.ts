import { describe, expect, it } from 'vitest';
import { allChannels } from '../contracts';
import { channelMetadataOverrides, getChannelMetadata } from '../channelMetadata';

/**
 * Stage 4 fix-up: 4-reviewer convergent finding (codex MEDIUM,
 * behavioral-safety MEDIUM) — bypass overrides that don't correspond to a
 * real channel are silent dead code that drifts with no signal. This drift
 * gate catches:
 *
 *   1. Bypass override keys that don't exist in `allChannels` (typos, dead
 *      configs, or channels that were removed without cleaning metadata).
 *   2. `featureFlag === 'REBEL_E2E_TEST_MODE'` keys that ARE in `allChannels`
 *      (those should not need the e2e-bypass — they're real channels).
 *   3. Inversely, e2e:* keys SHOULD currently be absent from `allChannels`
 *      (they're test-mode synthetic; if one ever lands in the real contract,
 *      this test surfaces it so the metadata can be updated intentionally).
 */
describe('channelMetadata <-> allChannels parity (Stage 4 drift gate)', () => {
  it('every non-e2e override key exists in allChannels', () => {
    const allChannelNames = new Set(Object.keys(allChannels));
    const orphanOverrides: string[] = [];

    for (const channel of Object.keys(channelMetadataOverrides)) {
      const metadata = getChannelMetadata(channel);
      if (metadata.featureFlag === 'REBEL_E2E_TEST_MODE') continue;
      if (!allChannelNames.has(channel)) {
        orphanOverrides.push(channel);
      }
    }

    expect(orphanOverrides, `Orphan bypass override keys (no matching channel in allChannels): ${orphanOverrides.join(', ')}`).toEqual([]);
  });

  it('every e2e:* bypass key is intentionally OUTSIDE allChannels (test-mode synthetic)', () => {
    const allChannelNames = new Set(Object.keys(allChannels));
    const e2eInsideContracts: string[] = [];

    for (const channel of Object.keys(channelMetadataOverrides)) {
      const metadata = getChannelMetadata(channel);
      if (metadata.featureFlag !== 'REBEL_E2E_TEST_MODE') continue;
      if (allChannelNames.has(channel)) {
        e2eInsideContracts.push(channel);
      }
    }

    expect(
      e2eInsideContracts,
      `e2e:* channels that landed inside allChannels — update metadata to drop featureFlag (or remove from real contract): ${e2eInsideContracts.join(', ')}`,
    ).toEqual([]);
  });

  it('no channel currently uses degrade-channel policy (precondition for safe synthetic IpcDisabledError shape)', () => {
    const usingDegrade: string[] = [];
    for (const channel of Object.keys(channelMetadataOverrides)) {
      if (getChannelMetadata(channel).productionFailurePolicy === 'degrade-channel') {
        usingDegrade.push(channel);
      }
    }
    // If this assertion fires, audit the channel's response schema for
    // compatibility with the IpcDisabledError synthetic shape ({ ok: false,
    // error: 'IPC_DISABLED', ... }). Most contract schemas (z.string(),
    // z.array(), z.boolean(), z.void()) will reject this shape at the
    // renderer boundary. Either (a) keep policy='sentry-only', or (b) adapt
    // the synthetic handler per-channel.
    expect(
      usingDegrade,
      `Channels using degrade-channel policy detected — verify response-schema compatibility with IpcDisabledError shape: ${usingDegrade.join(', ')}`,
    ).toEqual([]);
  });
});
