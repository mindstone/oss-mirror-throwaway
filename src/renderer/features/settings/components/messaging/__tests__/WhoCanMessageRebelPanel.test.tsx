// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboundAuthorPolicy } from '@rebel/shared';
import type { UseInboundAuthorPolicyResult } from '../../../hooks/useInboundAuthorPolicy';
import { WhoCanMessageRebelPanel } from '../WhoCanMessageRebelPanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function render(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function buildPolicy(overrides: Partial<InboundAuthorPolicy> = {}): InboundAuthorPolicy {
  return {
    inboundAuthorPolicySchemaVersion: 1,
    policyRevision: 2,
    mode: 'allowlist',
    allowlist: { slack: ['UALLOW001'] },
    blocklist: { slack: ['UBLOCK001'] },
    surfaceTrusted: { slack: ['C-TRUSTED'] },
    agentAllowlist: { slack: [] },
    notices: { upgradeReviewPending: false },
    ...overrides,
  };
}

function createPolicyState(
  policy: InboundAuthorPolicy,
  overrides: Partial<UseInboundAuthorPolicyResult> = {},
): UseInboundAuthorPolicyResult {
  const base: UseInboundAuthorPolicyResult = {
    policy,
    legacyAllowlistSlack: [],
    legacyBlocklistSlack: [],
    slackAuthorMetadata: {},
    setMode: vi.fn().mockResolvedValue(undefined),
    addToAllowlist: vi.fn().mockResolvedValue({ ok: true, canonicalId: 'U_RESOLVED' }),
    addToBlocklist: vi.fn().mockResolvedValue({ ok: true, canonicalId: 'U_RESOLVED' }),
    removeFromAllowlist: vi.fn().mockResolvedValue(undefined),
    removeFromBlocklist: vi.fn().mockResolvedValue(undefined),
    reresolveLegacyAllowlistEntry: vi.fn().mockResolvedValue({ ok: true, canonicalId: 'U_RERESOLVED' }),
    reresolveLegacyBlocklistEntry: vi.fn().mockResolvedValue({ ok: true, canonicalId: 'U_RERESOLVED' }),
    setSurfaceTrusted: vi.fn().mockResolvedValue(undefined),
    addToAgentAllowlist: vi.fn().mockResolvedValue(undefined),
    dismissUpgradeReviewNotice: vi.fn().mockResolvedValue(undefined),
    markUpgradeReviewDismissedNow: vi.fn(),
  };
  return {
    ...base,
    ...overrides,
  };
}

describe('WhoCanMessageRebelPanel', () => {
  const mounted: Mounted[] = [];

  afterEach(() => {
    for (const instance of mounted) {
      instance.unmount();
    }
    mounted.length = 0;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('shows the disconnected Slack panel notice with locked copy', () => {
    const policyState = createPolicyState(buildPolicy());
    const m = render(
      <WhoCanMessageRebelPanel
        policyState={policyState}
        slackConnected={false}
      />,
    );
    mounted.push(m);

    expect(m.container.textContent).toContain('Connect Slack to add people from recent attempts.');
  });

  it('calls setMode when the access mode changes', async () => {
    const setMode = vi.fn().mockResolvedValue(undefined);
    const policyState = createPolicyState(buildPolicy(), { setMode });
    const m = render(<WhoCanMessageRebelPanel policyState={policyState} />);
    mounted.push(m);

    const select = m.container.querySelector(
      '#who-can-message-rebel-mode',
    ) as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    select!.value = 'ownerOnly';
    await act(async () => {
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(setMode).toHaveBeenCalledWith('ownerOnly');
  });

  it('renders allowlist controls in allowlist mode and sends add/remove actions', async () => {
    const addToAllowlist = vi.fn().mockResolvedValue({ ok: true, canonicalId: 'UADD1234' });
    const removeFromAllowlist = vi.fn().mockResolvedValue(undefined);
    const policyState = createPolicyState(buildPolicy(), {
      addToAllowlist,
      removeFromAllowlist,
    });
    const m = render(<WhoCanMessageRebelPanel policyState={policyState} />);
    mounted.push(m);

    const allowInput = m.container.querySelector(
      '[data-testid="who-can-message-rebel-allowlist-input"]',
    ) as HTMLInputElement | null;
    expect(allowInput).not.toBeNull();

    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    valueSetter?.call(allowInput, 'UADD1234');
    await act(async () => {
      allowInput!.dispatchEvent(new Event('input', { bubbles: true }));
      allowInput!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const addButton = m.container.querySelector(
      '[data-testid="who-can-message-rebel-allowlist-add"]',
    ) as HTMLButtonElement | null;
    expect(addButton).not.toBeNull();
    await click(addButton!);
    expect(addToAllowlist).toHaveBeenCalledWith('UADD1234');

    const removeButton = m.container.querySelector(
      'button[aria-label="Remove UALLOW001"]',
    ) as HTMLButtonElement | null;
    expect(removeButton).not.toBeNull();
    await click(removeButton!);
    expect(removeFromAllowlist).toHaveBeenCalledWith('UALLOW001');
  });

  it('hides allowlist controls when mode is ownerOnly', () => {
    const policyState = createPolicyState(buildPolicy({ mode: 'ownerOnly' }));
    const m = render(<WhoCanMessageRebelPanel policyState={policyState} />);
    mounted.push(m);

    expect(
      m.container.querySelector('[data-testid="who-can-message-rebel-allowlist-input"]'),
    ).toBeNull();
  });

  it('shows the trusted channels locked copy', () => {
    const policyState = createPolicyState(buildPolicy({ mode: 'allowlist' }));
    const m = render(<WhoCanMessageRebelPanel policyState={policyState} />);
    mounted.push(m);

    expect(m.container.textContent).toContain(
      "Trusted channels. Any Slack member of these channels can trigger Rebel — including people who aren't on your allowlist. Avoid public channels like #general.",
    );
  });

  it('shows the bypass warning banner when bypass status is active', () => {
    const policyState = createPolicyState(buildPolicy({ mode: 'allowlist' }), {
      inboundAuthorPolicyBypassActive: true,
    });
    const m = render(<WhoCanMessageRebelPanel policyState={policyState} />);
    mounted.push(m);

    expect(m.container.textContent).toContain(
      'Inbound author policy is currently bypassed.',
    );
    expect(m.container.textContent).toContain(
      "An operator set REBEL_INBOUND_AUTHOR_POLICY_BYPASS=1 on the cloud. While this is active, anyone who DMs Rebel or @-mentions it in Slack can trigger replies — your policy below has no effect. Remove the env flag on the cloud service to restore enforcement.",
    );
  });

  it('hides the bypass warning banner when bypass status is false or undefined', () => {
    const withFalse = render(
      <WhoCanMessageRebelPanel
        policyState={createPolicyState(buildPolicy(), {
          inboundAuthorPolicyBypassActive: false,
        })}
      />,
    );
    mounted.push(withFalse);
    expect(withFalse.container.textContent).not.toContain('Inbound author policy is currently bypassed.');

    const withUndefined = render(
      <WhoCanMessageRebelPanel policyState={createPolicyState(buildPolicy())} />,
    );
    mounted.push(withUndefined);
    expect(withUndefined.container.textContent).not.toContain('Inbound author policy is currently bypassed.');
  });

  it('shows the missing owner identity notice with locked copy', () => {
    const policyState = createPolicyState(buildPolicy({ mode: 'ownerOnly' }));
    const m = render(
      <WhoCanMessageRebelPanel
        policyState={policyState}
        ownerIdentityUnknown
      />,
    );
    mounted.push(m);

    expect(m.container.textContent).toContain(
      "Rebel can't tell which Slack user is you. Reconnect Slack to keep owner-only messaging working.",
    );
  });

  it('renders the helper text and updated placeholder for the allowlist input', () => {
    const policyState = createPolicyState(buildPolicy({ mode: 'allowlist' }));
    const m = render(<WhoCanMessageRebelPanel policyState={policyState} />);
    mounted.push(m);

    const input = m.container.querySelector(
      '[data-testid="who-can-message-rebel-allowlist-input"]',
    ) as HTMLInputElement | null;
    expect(input?.placeholder).toBe('@hannah or U12345678');
    expect(input?.getAttribute('aria-describedby')).toBe('who-can-message-rebel-allowlist-helper');

    const helper = m.container.querySelector(
      '[data-testid="who-can-message-rebel-allowlist-helper"]',
    );
    expect(helper?.textContent).toBe(
      'Rebel checks Slack before saving, so @handles match the right person.',
    );
  });

  it('renders the helper text and updated placeholder for the blocklist input', () => {
    const policyState = createPolicyState(buildPolicy({ mode: 'allowlist' }));
    const m = render(<WhoCanMessageRebelPanel policyState={policyState} />);
    mounted.push(m);

    const input = m.container.querySelector(
      '[data-testid="who-can-message-rebel-blocklist-input"]',
    ) as HTMLInputElement | null;
    expect(input?.placeholder).toBe('@hannah or U12345678');
    expect(input?.getAttribute('aria-describedby')).toBe('who-can-message-rebel-blocklist-helper');

    const helper = m.container.querySelector(
      '[data-testid="who-can-message-rebel-blocklist-helper"]',
    );
    expect(helper?.textContent).toBe(
      'Rebel checks Slack before saving, so @handles match the right person.',
    );
  });

  const errorScenarios = [
    {
      name: 'not_found',
      result: { ok: false, error: "Couldn't find @ghost in this Slack workspace. Double-check the spelling, or paste their Slack user ID (starts with U)." },
    },
    {
      name: 'auth_failed',
      result: { ok: false, error: "Slack wouldn't let Rebel check that person. Reconnect Slack, then try again." },
    },
    {
      name: 'deactivated',
      result: { ok: false, error: "That Slack account is deactivated, so it can't message Rebel. Not adding a ghost." },
    },
    {
      name: 'ambiguous',
      result: { ok: false, error: 'More than one person matched @hannah. Be more specific — try @handle or paste their U-ID.' },
    },
    {
      name: 'transport_error',
      result: { ok: false, error: 'Could not reach Slack to verify that user. Try again in a moment.' },
    },
  ] as const;

  for (const scenario of errorScenarios) {
    it(`surfaces the Rebel-voice copy for ${scenario.name} on the allowlist`, async () => {
      const addToAllowlist = vi.fn().mockResolvedValue(scenario.result);
      const policyState = createPolicyState(buildPolicy({ mode: 'allowlist' }), {
        addToAllowlist,
      });
      const m = render(<WhoCanMessageRebelPanel policyState={policyState} />);
      mounted.push(m);

      const input = m.container.querySelector(
        '[data-testid="who-can-message-rebel-allowlist-input"]',
      ) as HTMLInputElement | null;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, '@ghost');
      await act(async () => {
        input!.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const addButton = m.container.querySelector(
        '[data-testid="who-can-message-rebel-allowlist-add"]',
      ) as HTMLButtonElement | null;
      await click(addButton!);

      const errorNotice = m.container.querySelector(
        '[data-testid="who-can-message-rebel-allowlist-error"]',
      );
      expect(errorNotice?.textContent).toContain(scenario.result.error);
      expect(input?.getAttribute('aria-invalid')).toBe('true');
    });
  }

  it('renders legacy allowlist chips with Re-resolve and Remove buttons', () => {
    const policyState = createPolicyState(
      buildPolicy({
        mode: 'allowlist',
        allowlist: { slack: ['UALLOW001', '@legacy-handle'] },
      }),
      { legacyAllowlistSlack: ['@legacy-handle'] },
    );
    const m = render(<WhoCanMessageRebelPanel policyState={policyState} />);
    mounted.push(m);

    expect(
      m.container.querySelector('[data-testid="who-can-message-rebel-allowlist-legacy-notice"]'),
    ).not.toBeNull();
    expect(
      m.container.querySelector('[data-testid="who-can-message-rebel-allowlist-legacy-value-@legacy-handle"]'),
    ).not.toBeNull();
    expect(
      m.container.querySelector('[data-testid="who-can-message-rebel-allowlist-legacy-reresolve-@legacy-handle"]'),
    ).not.toBeNull();
    expect(
      m.container.querySelector('[data-testid="who-can-message-rebel-allowlist-legacy-remove-@legacy-handle"]'),
    ).not.toBeNull();
  });

  it('triggers reresolveLegacyAllowlistEntry when the Re-resolve button is clicked', async () => {
    const reresolveLegacyAllowlistEntry = vi.fn().mockResolvedValue({ ok: true, canonicalId: 'UFIXED' });
    const policyState = createPolicyState(
      buildPolicy({
        mode: 'allowlist',
        allowlist: { slack: ['@legacy-handle'] },
      }),
      {
        legacyAllowlistSlack: ['@legacy-handle'],
        reresolveLegacyAllowlistEntry,
      },
    );
    const m = render(<WhoCanMessageRebelPanel policyState={policyState} />);
    mounted.push(m);

    const button = m.container.querySelector(
      '[data-testid="who-can-message-rebel-allowlist-legacy-reresolve-@legacy-handle"]',
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    await click(button!);
    expect(reresolveLegacyAllowlistEntry).toHaveBeenCalledWith('@legacy-handle');
  });

  it('removes legacy entries verbatim via removeFromAllowlist', async () => {
    const removeFromAllowlist = vi.fn().mockResolvedValue(undefined);
    const policyState = createPolicyState(
      buildPolicy({
        mode: 'allowlist',
        allowlist: { slack: ['@legacy-handle'] },
      }),
      {
        legacyAllowlistSlack: ['@legacy-handle'],
        removeFromAllowlist,
      },
    );
    const m = render(<WhoCanMessageRebelPanel policyState={policyState} />);
    mounted.push(m);

    const button = m.container.querySelector(
      '[data-testid="who-can-message-rebel-allowlist-legacy-remove-@legacy-handle"]',
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    await click(button!);
    expect(removeFromAllowlist).toHaveBeenCalledWith('@legacy-handle');
  });

  it('renders rich chip format `Display (@handle) · U_ID` when metadata is available', () => {
    const policyState = createPolicyState(
      buildPolicy({
        mode: 'allowlist',
        allowlist: { slack: ['UALLOW001'] },
      }),
      {
        slackAuthorMetadata: {
          UALLOW001: { displayName: 'Hannah', handle: 'hannah' },
        },
      },
    );
    const m = render(<WhoCanMessageRebelPanel policyState={policyState} />);
    mounted.push(m);

    const chip = m.container.querySelector(
      '[data-testid="who-can-message-rebel-allowlist-value-UALLOW001"]',
    );
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('Hannah (@hannah)');
    expect(chip?.textContent).toContain('UALLOW001');
    const muted = m.container.querySelector(
      '[data-testid="who-can-message-rebel-allowlist-canonical-UALLOW001"]',
    );
    expect(muted?.textContent).toContain('UALLOW001');
  });

  it('falls back to canonical ID when no metadata is cached', () => {
    const policyState = createPolicyState(
      buildPolicy({
        mode: 'allowlist',
        allowlist: { slack: ['UNOSDATA'] },
      }),
    );
    const m = render(<WhoCanMessageRebelPanel policyState={policyState} />);
    mounted.push(m);

    const chip = m.container.querySelector(
      '[data-testid="who-can-message-rebel-allowlist-value-UNOSDATA"]',
    );
    expect(chip?.textContent).toContain('UNOSDATA');
    expect(
      m.container.querySelector('[data-testid="who-can-message-rebel-allowlist-canonical-UNOSDATA"]'),
    ).toBeNull();
  });

  it('disables the Add button while a resolve is pending so the second submit is dropped', async () => {
    let resolveAdd: ((result: { ok: boolean; canonicalId?: string }) => void) | null = null;
    const addToAllowlist = vi.fn().mockImplementation(
      () => new Promise<{ ok: boolean; canonicalId?: string }>((resolve) => {
        resolveAdd = resolve;
      }),
    );
    const policyState = createPolicyState(
      buildPolicy({ mode: 'allowlist' }),
      { addToAllowlist },
    );
    const m = render(<WhoCanMessageRebelPanel policyState={policyState} />);
    mounted.push(m);

    const input = m.container.querySelector(
      '[data-testid="who-can-message-rebel-allowlist-input"]',
    ) as HTMLInputElement | null;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, '@hannah');
    await act(async () => {
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const addButton = m.container.querySelector(
      '[data-testid="who-can-message-rebel-allowlist-add"]',
    ) as HTMLButtonElement | null;
    await click(addButton!);
    expect(addButton?.disabled).toBe(true);
    expect(input?.disabled).toBe(true);
    expect(addButton?.textContent).toContain('Resolving');

    await click(addButton!);
    await click(addButton!);
    expect(addToAllowlist).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveAdd?.({ ok: true, canonicalId: 'UHANNAH1' });
    });
  });
});
