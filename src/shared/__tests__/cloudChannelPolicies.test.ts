import { describe, expect, it } from 'vitest';
import {
  CLOUD_CHANNEL_POLICIES,
  CLOUD_IPC_ALLOWLIST,
  CLOUD_ROUTABLE_CHANNELS,
  DUAL_WRITE_CHANNELS,
} from '../cloudChannelPolicies';
import { operatorsChannels } from '../ipc/channels/operators';

/**
 * Known channels that have dedicated REST route handlers in cloudRouter.ts
 * (entries in CHANNEL_TO_ENDPOINT). These bypass the generic /api/ipc/:channel
 * endpoint, so they must NOT be in CLOUD_IPC_ALLOWLIST. Update this list when
 * adding new REST endpoints to CHANNEL_TO_ENDPOINT.
 */
const KNOWN_REST_ENDPOINT_CHANNELS = new Set([
  'codex:sync-tokens',
  'settings:update',
]);

describe('cloudChannelPolicies', () => {
  it('every DUAL_WRITE channel is also in CLOUD_ROUTABLE', () => {
    for (const channel of DUAL_WRITE_CHANNELS) {
      expect(CLOUD_ROUTABLE_CHANNELS.has(channel)).toBe(true);
    }
  });

  it('every CLOUD_IPC_ALLOWLIST channel is also in CLOUD_ROUTABLE', () => {
    for (const channel of CLOUD_IPC_ALLOWLIST) {
      expect(CLOUD_ROUTABLE_CHANNELS.has(channel)).toBe(true);
    }
  });

  it('sessions:save-sync is NOT in any derived set', () => {
    expect(CLOUD_ROUTABLE_CHANNELS.has('sessions:save-sync')).toBe(false);
    expect(DUAL_WRITE_CHANNELS.has('sessions:save-sync')).toBe(false);
    expect(CLOUD_IPC_ALLOWLIST.has('sessions:save-sync')).toBe(false);
  });

  it('every transport:rest channel has a matching entry in CHANNEL_TO_ENDPOINT', () => {
    const restChannels = Object.entries(CLOUD_CHANNEL_POLICIES)
      .filter(([, p]) => p.transport === 'rest')
      .map(([ch]) => ch);

    for (const channel of restChannels) {
      expect(
        KNOWN_REST_ENDPOINT_CHANNELS.has(channel),
        `Channel "${channel}" has transport:'rest' but no matching CHANNEL_TO_ENDPOINT entry. ` +
        `Either add an endpoint mapping in cloudRouter.ts or change the transport to 'ipc'.`,
      ).toBe(true);
    }
  });

  it('agent:turn and agent:stop-turn are not cloud-routable (execute-where-triggered)', () => {
    expect(CLOUD_ROUTABLE_CHANNELS.has('agent:turn')).toBe(false);
    expect(CLOUD_ROUTABLE_CHANNELS.has('agent:stop-turn')).toBe(false);
  });

  it('agent:tool-safety-response is routable with dual-write', () => {
    const policy = CLOUD_CHANNEL_POLICIES['agent:tool-safety-response'];
    expect(policy.routable).toBe(true);
    expect(policy.dualWrite).toBe(true);
    expect(policy.transport).toBe('ipc');
  });

  it('diagnostics:get-recent-context is routable WITHOUT dual-write (read honors surface)', () => {
    const policy = CLOUD_CHANNEL_POLICIES['diagnostics:get-recent-context'];
    expect(policy.routable).toBe(true);
    expect('dualWrite' in policy ? policy.dualWrite : false).toBe(false);
    expect(policy.transport).toBe('ipc');
    expect(CLOUD_ROUTABLE_CHANNELS.has('diagnostics:get-recent-context')).toBe(true);
    expect(CLOUD_IPC_ALLOWLIST.has('diagnostics:get-recent-context')).toBe(true);
    expect(DUAL_WRITE_CHANNELS.has('diagnostics:get-recent-context')).toBe(false);
  });

  it('operators channels are desktop-only', () => {
    const operatorChannels = Object.keys(operatorsChannels);

    for (const channel of operatorChannels) {
      expect(CLOUD_CHANNEL_POLICIES).not.toHaveProperty(channel);
      expect(CLOUD_ROUTABLE_CHANNELS.has(channel)).toBe(false);
      expect(CLOUD_IPC_ALLOWLIST.has(channel)).toBe(false);
      expect(DUAL_WRITE_CHANNELS.has(channel)).toBe(false);
    }
  });

  it('dual-write channels include core + inbox mutation channels', () => {
    expect([...DUAL_WRITE_CHANNELS].sort()).toEqual([
      'agent:tool-safety-response',
      'automations:delete',
      'automations:upsert',
      'codex:sync-tokens',
      'inbox:add',
      'inbox:delete',
      'inbox:execute',
      'inbox:mark-archived',
      'inbox:record-execution',
      'inbox:set-archived',
      'inbox:set-dueBy',
      'inbox:set-executing',
      'inbox:set-quadrant',
      'inbox:set-status',
      'inbox:set-tags',
      'memory:write-approval-response',
      'safety-prompt:reset',
      'safety-prompt:revert',
      'safety-prompt:update',
      'settings:update',
    ]);
  });

  // Snapshot tests for stability — catches accidental additions or removals
  it('CLOUD_ROUTABLE_CHANNELS snapshot', () => {
    expect([...CLOUD_ROUTABLE_CHANNELS].sort()).toMatchSnapshot();
  });

  it('DUAL_WRITE_CHANNELS snapshot', () => {
    expect([...DUAL_WRITE_CHANNELS].sort()).toMatchSnapshot();
  });

  it('CLOUD_IPC_ALLOWLIST snapshot', () => {
    expect([...CLOUD_IPC_ALLOWLIST].sort()).toMatchSnapshot();
  });
});
