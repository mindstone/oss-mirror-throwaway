// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types/settings';
import type { InboundAuthorPolicy } from '@rebel/shared';
import { SettingsProvider, type SettingsContextValue } from '../../SettingsProvider';
import {
  INBOUND_AUTHOR_UPGRADE_DISMISSED_AT_KEY,
  useInboundAuthorPolicy,
  type UseInboundAuthorPolicyResult,
} from '../useInboundAuthorPolicy';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function buildPolicy(overrides: Partial<InboundAuthorPolicy> = {}): InboundAuthorPolicy {
  return {
    inboundAuthorPolicySchemaVersion: 1,
    policyRevision: 7,
    mode: 'legacyPermissive',
    allowlist: { slack: ['UALLOW1'] },
    blocklist: { slack: [] },
    surfaceTrusted: { slack: ['C1'] },
    agentAllowlist: { slack: [] },
    notices: { upgradeReviewPending: true },
    ...overrides,
  };
}

function buildSettings(policy: InboundAuthorPolicy): AppSettings {
  return {
    experimental: {
      inboundAuthorPolicy: policy,
    },
  } as AppSettings;
}

interface MountedHook {
  result: { current: UseInboundAuthorPolicyResult };
  rerender: (settings: AppSettings | null) => void;
  unmount: () => void;
}

function mountHook(
  settings: AppSettings | null,
  saveSettingsWith: unknown,
): MountedHook {
  const result = { current: undefined as unknown as UseInboundAuthorPolicyResult };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  function TestHarness() {
    result.current = useInboundAuthorPolicy();
    return null;
  }

  function render(nextSettings: AppSettings | null) {
    root.render(
      React.createElement(
        SettingsProvider,
        {
          value: {
            settings: nextSettings,
            saveSettingsWith,
          } as unknown as SettingsContextValue,
          children: React.createElement(TestHarness),
        },
      ),
    );
  }

  act(() => {
    render(settings);
  });

  return {
    result,
    rerender(nextSettings: AppSettings | null) {
      act(() => {
        render(nextSettings);
      });
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('useInboundAuthorPolicy', () => {
  let saveSettingsWith: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    saveSettingsWith = vi.fn().mockResolvedValue(undefined);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('returns a safe fallback policy when no settings are available', () => {
    const mounted = mountHook(null, saveSettingsWith);
    expect(mounted.result.current.policy.mode).toBe('ownerOnly');
    expect(mounted.result.current.policy.notices.upgradeReviewPending).toBe(false);
    mounted.unmount();
  });

  it('setMode writes through settings:update and clears upgradeReviewPending when leaving legacyPermissive', async () => {
    const settings = buildSettings(buildPolicy());
    const mounted = mountHook(settings, saveSettingsWith);

    await act(async () => {
      await mounted.result.current.setMode('allowlist');
    });

    expect(saveSettingsWith).toHaveBeenCalledTimes(1);
    const updater = saveSettingsWith.mock.calls[0][0] as (current: AppSettings) => AppSettings;
    const next = updater(settings);
    expect(next.experimental?.inboundAuthorPolicy?.mode).toBe('allowlist');
    expect(next.experimental?.inboundAuthorPolicy?.notices.upgradeReviewPending).toBe(false);
    expect(next.experimental?.inboundAuthorPolicy?.policyRevision).toBe(8);
    mounted.unmount();
  });

  it('normalizes and writes allowlist/blocklist edits', async () => {
    const settings = buildSettings(buildPolicy({
      mode: 'allowlist',
      allowlist: { slack: [] },
      blocklist: { slack: [] },
    }));
    const mounted = mountHook(settings, saveSettingsWith);

    await act(async () => {
      await mounted.result.current.addToAllowlist(' @u123abc ');
    });

    const addUpdater = saveSettingsWith.mock.calls[0][0] as (current: AppSettings) => AppSettings;
    const afterAdd = addUpdater(settings);
    expect(afterAdd.experimental?.inboundAuthorPolicy?.allowlist.slack).toEqual(['U123ABC']);

    await act(async () => {
      await mounted.result.current.addToBlocklist('u123abc');
    });
    const blockUpdater = saveSettingsWith.mock.calls[1][0] as (current: AppSettings) => AppSettings;
    const afterBlock = blockUpdater(afterAdd);
    expect(afterBlock.experimental?.inboundAuthorPolicy?.blocklist.slack).toEqual(['U123ABC']);
    expect(afterBlock.experimental?.inboundAuthorPolicy?.allowlist.slack).toEqual([]);
    mounted.unmount();
  });

  it('setSurfaceTrusted deduplicates and trims surface IDs', async () => {
    const settings = buildSettings(buildPolicy({
      mode: 'allowlist',
      surfaceTrusted: { slack: ['C1'] },
    }));
    const mounted = mountHook(settings, saveSettingsWith);

    await act(async () => {
      await mounted.result.current.setSurfaceTrusted('slack', [' C1 ', 'C2', 'C2', '']);
    });

    const updater = saveSettingsWith.mock.calls[0][0] as (current: AppSettings) => AppSettings;
    const next = updater(settings);
    expect(next.experimental?.inboundAuthorPolicy?.surfaceTrusted.slack).toEqual(['C1', 'C2']);
    mounted.unmount();
  });

  it('dismissUpgradeReviewNotice flips the notice flag without changing mode', async () => {
    const settings = buildSettings(buildPolicy({ mode: 'legacyPermissive' }));
    const mounted = mountHook(settings, saveSettingsWith);

    await act(async () => {
      await mounted.result.current.dismissUpgradeReviewNotice();
    });

    const updater = saveSettingsWith.mock.calls[0][0] as (current: AppSettings) => AppSettings;
    const next = updater(settings);
    expect(next.experimental?.inboundAuthorPolicy?.mode).toBe('legacyPermissive');
    expect(next.experimental?.inboundAuthorPolicy?.notices.upgradeReviewPending).toBe(false);
    mounted.unmount();
  });

  it('markUpgradeReviewDismissedNow writes dismissal time to localStorage', () => {
    const mounted = mountHook(buildSettings(buildPolicy()), saveSettingsWith);
    mounted.result.current.markUpgradeReviewDismissedNow();
    const raw = window.localStorage.getItem(INBOUND_AUTHOR_UPGRADE_DISMISSED_AT_KEY);
    expect(raw).not.toBeNull();
    expect(Number(raw)).toBeGreaterThan(0);
    mounted.unmount();
  });

  it('preserves legacy non-canonical entries on read and exposes them via legacyAllowlistSlack/legacyBlocklistSlack', () => {
    const settings = buildSettings(buildPolicy({
      mode: 'allowlist',
      allowlist: { slack: ['UCANON001', '@hannah-handle'] },
      blocklist: { slack: ['UBLOCK001', '[external-email]'] },
    }));
    const mounted = mountHook(settings, saveSettingsWith);

    expect(mounted.result.current.policy.allowlist.slack).toEqual(['UCANON001', '@hannah-handle']);
    expect(mounted.result.current.policy.blocklist.slack).toEqual(['UBLOCK001', '[external-email]']);
    expect(mounted.result.current.legacyAllowlistSlack).toEqual(['@hannah-handle']);
    expect(mounted.result.current.legacyBlocklistSlack).toEqual(['[external-email]']);
    mounted.unmount();
  });

  it('removes legacy allowlist entries verbatim (without normalization)', async () => {
    const settings = buildSettings(buildPolicy({
      mode: 'allowlist',
      allowlist: { slack: ['UCANON001', '@hannah-handle'] },
    }));
    const mounted = mountHook(settings, saveSettingsWith);

    await act(async () => {
      await mounted.result.current.removeFromAllowlist('@hannah-handle');
    });

    const updater = saveSettingsWith.mock.calls[0][0] as (current: AppSettings) => AppSettings;
    const next = updater(settings);
    expect(next.experimental?.inboundAuthorPolicy?.allowlist.slack).toEqual(['UCANON001']);
    mounted.unmount();
  });
});
