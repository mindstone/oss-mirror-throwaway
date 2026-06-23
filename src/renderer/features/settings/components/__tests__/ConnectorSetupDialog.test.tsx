// @vitest-environment happy-dom

/**
 * Render-level coverage for `ConnectorSetupDialog` (Stage 5 of
 * `docs/plans/260608_oss-connector-guidance/PLAN.md`). Manual `createRoot` + `act`
 * because `@testing-library/react` is not installed (mirrors the sibling tests).
 *
 * Pins the chief-designer requirements:
 *  - selfServe=true → "needs an OAuth app" walkthrough; selfServe=false (Plaud) → limited-access copy.
 *  - Microsoft env-var block omits the secret (client ID only).
 *  - Google (empty redirectUris) → redirect note + NO empty redirect copy field.
 *  - HubSpot → all four redirect URIs + the register-all note.
 *  - Copy buttons carry provider-scoped aria-labels.
 *  - Focus returns to the invoking control on close.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorSetupDialog } from '../ConnectorSetupDialog';
import type { OAuthSetupGuidance } from '@shared/ipc/schemas/common';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  root: Root;
  container: HTMLDivElement;
  unmount: () => void;
}

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    root,
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const slackGuidance: OAuthSetupGuidance = {
  code: 'oauth-credentials-not-configured',
  provider: 'slack',
  displayName: 'Slack',
  message: 'Slack needs OAuth client credentials before anyone can connect.',
  selfServe: true,
  setupUrl: 'https://api.slack.com/apps',
  envVars: ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET'],
  redirectUris: ['https://rebel-auth.mindstone.com/slack/callback'],
};

const microsoftGuidance: OAuthSetupGuidance = {
  code: 'oauth-credentials-not-configured',
  provider: 'microsoft',
  displayName: 'Microsoft',
  message: 'Microsoft needs OAuth client credentials before anyone can connect.',
  selfServe: true,
  setupUrl: 'https://entra.microsoft.com/',
  envVars: ['MICROSOFT_CLIENT_ID'],
  redirectUris: ['https://rebel-auth.mindstone.com/microsoft/callback'],
};

const googleGuidance: OAuthSetupGuidance = {
  code: 'oauth-credentials-not-configured',
  provider: 'google',
  displayName: 'Google',
  message: 'Google needs OAuth client credentials before anyone can connect.',
  selfServe: true,
  setupUrl: 'https://console.cloud.google.com/apis/credentials',
  envVars: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  redirectUris: [],
  redirectNote: 'Create the OAuth client as a "Desktop app".',
};

const hubspotGuidance: OAuthSetupGuidance = {
  code: 'oauth-credentials-not-configured',
  provider: 'hubspot',
  displayName: 'HubSpot',
  message: 'HubSpot needs OAuth client credentials before anyone can connect.',
  selfServe: true,
  setupUrl: 'https://app.hubspot.com/developer',
  envVars: ['HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET'],
  redirectUris: [
    'http://localhost:8081/callback',
    'http://localhost:8082/callback',
    'http://localhost:8083/callback',
    'http://localhost:8084/callback',
  ],
  redirectNote: 'Add all four localhost callback URLs as redirect URLs in your HubSpot app.',
};

const plaudGuidance: OAuthSetupGuidance = {
  code: 'oauth-credentials-not-configured',
  provider: 'plaud',
  displayName: 'Plaud',
  message: 'Plaud needs OAuth client credentials before anyone can connect.',
  selfServe: false,
  setupUrl: 'https://plaud.mintlify.app/api_guide/api_intro/authorization',
  envVars: ['PLAUD_CLIENT_ID', 'PLAUD_CLIENT_SECRET'],
  redirectUris: ['https://rebel-auth.mindstone.com/plaud/callback'],
};

function getDialog(): HTMLElement {
  const dialog = document.querySelector<HTMLElement>('[data-testid="connector-setup-dialog"]');
  if (!dialog) throw new Error('dialog not rendered');
  return dialog;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('ConnectorSetupDialog', () => {
  it('renders nothing when closed or guidance is null', () => {
    const closed = mount(
      <ConnectorSetupDialog guidance={slackGuidance} open={false} onOpenChange={() => {}} />,
    );
    expect(document.querySelector('[data-testid="connector-setup-dialog"]')).toBeNull();
    closed.unmount();

    const noGuidance = mount(
      <ConnectorSetupDialog guidance={null} open onOpenChange={() => {}} />,
    );
    expect(document.querySelector('[data-testid="connector-setup-dialog"]')).toBeNull();
    noGuidance.unmount();
  });

  it('selfServe=true renders the four-step OAuth-app walkthrough', () => {
    const m = mount(<ConnectorSetupDialog guidance={slackGuidance} open onOpenChange={() => {}} />);
    const dialog = getDialog();
    expect(dialog.getAttribute('data-self-serve')).toBe('true');
    expect(dialog.textContent).toContain('Slack needs an OAuth app');
    expect(dialog.textContent).toContain('Create the OAuth app');
    expect(dialog.textContent).toContain('Add the redirect URI');
    expect(dialog.textContent).toContain('Set the credentials');
    expect(dialog.textContent).toContain('Restart and connect again');
    // Build-aware credential copy (chief-designer F1).
    expect(dialog.textContent).toContain('.env.local');
    // Open console + Setup guide actions present.
    expect(dialog.querySelector('[data-testid="connector-setup-open-console"]')).not.toBeNull();
    expect(dialog.querySelector('[data-testid="connector-setup-docs"]')).not.toBeNull();
    m.unmount();
  });

  it('Microsoft env-var block omits the client secret', () => {
    const m = mount(<ConnectorSetupDialog guidance={microsoftGuidance} open onOpenChange={() => {}} />);
    const envBlock = getDialog().querySelector('[data-testid="connector-setup-env-vars"]');
    expect(envBlock?.textContent).toContain('MICROSOFT_CLIENT_ID');
    expect(envBlock?.textContent).not.toContain('SECRET');
    m.unmount();
  });

  it('env-var block uses placeholder values, not blank assignments (chief-designer F2)', () => {
    const slack = mount(<ConnectorSetupDialog guidance={slackGuidance} open onOpenChange={() => {}} />);
    const slackEnv = getDialog().querySelector('[data-testid="connector-setup-env-vars"]');
    expect(slackEnv?.textContent).toContain('SLACK_CLIENT_ID=your_client_id');
    expect(slackEnv?.textContent).toContain('SLACK_CLIENT_SECRET=your_client_secret');
    // No bare `KEY=` (trailing-equals-then-newline-or-end) left behind.
    expect(slackEnv?.textContent ?? '').not.toMatch(/=\s*(\n|$)/);
    slack.unmount();

    const ms = mount(<ConnectorSetupDialog guidance={microsoftGuidance} open onOpenChange={() => {}} />);
    const msEnv = getDialog().querySelector('[data-testid="connector-setup-env-vars"]');
    expect(msEnv?.textContent).toBe('MICROSOFT_CLIENT_ID=your_client_id');
    ms.unmount();
  });

  it('role="dialog" carries BOTH aria-labelledby and aria-describedby (chief-designer F1)', () => {
    const m = mount(<ConnectorSetupDialog guidance={slackGuidance} open onOpenChange={() => {}} />);
    const roleDialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(roleDialog).not.toBeNull();
    const labelledBy = roleDialog!.getAttribute('aria-labelledby');
    const describedBy = roleDialog!.getAttribute('aria-describedby');
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    // The referenced ids must resolve to real nodes inside the dialog.
    expect(document.getElementById(labelledBy!)).not.toBeNull();
    expect(document.getElementById(describedBy!)).not.toBeNull();
    m.unmount();
  });

  it('Google (empty redirectUris) shows the note and NO empty redirect copy field', () => {
    const m = mount(<ConnectorSetupDialog guidance={googleGuidance} open onOpenChange={() => {}} />);
    const dialog = getDialog();
    expect(dialog.querySelector('[data-testid="connector-setup-redirect-note"]')?.textContent)
      .toContain('Desktop app');
    expect(dialog.querySelector('[data-testid="connector-setup-redirect-uri-0"]')).toBeNull();
    m.unmount();
  });

  it('HubSpot shows all four redirect URIs plus the register-all note', () => {
    const m = mount(<ConnectorSetupDialog guidance={hubspotGuidance} open onOpenChange={() => {}} />);
    const dialog = getDialog();
    for (let i = 0; i < 4; i += 1) {
      expect(dialog.querySelector(`[data-testid="connector-setup-redirect-uri-${i}"]`)).not.toBeNull();
    }
    expect(dialog.querySelector('[data-testid="connector-setup-redirect-uri-4"]')).toBeNull();
    expect(dialog.querySelector('[data-testid="connector-setup-redirect-note"]')?.textContent)
      .toContain('all four');
    m.unmount();
  });

  it('copy buttons carry provider-scoped aria-labels', () => {
    const m = mount(<ConnectorSetupDialog guidance={slackGuidance} open onOpenChange={() => {}} />);
    const dialog = getDialog();
    const labels = Array.from(dialog.querySelectorAll('button'))
      .map((b) => b.getAttribute('aria-label'))
      .filter(Boolean) as string[];
    expect(labels.some((l) => l === 'Copy Slack redirect URI')).toBe(true);
    expect(labels.some((l) => l === 'Copy Slack environment variables')).toBe(true);
    m.unmount();
  });

  it('selfServe=false (Plaud) renders honest limited-access copy and NO register steps', () => {
    const m = mount(<ConnectorSetupDialog guidance={plaudGuidance} open onOpenChange={() => {}} />);
    const dialog = getDialog();
    expect(dialog.getAttribute('data-self-serve')).toBe('false');
    expect(dialog.textContent).toContain('Plaud OAuth access is limited');
    expect(dialog.textContent).not.toContain('Create the OAuth app');
    expect(dialog.querySelector('[data-testid="connector-setup-env-vars"]')).toBeNull();
    expect(dialog.querySelector('[data-testid="connector-setup-open-docs"]')).not.toBeNull();
    m.unmount();
  });

  it('returns focus to the invoking control when closed', () => {
    const invoker = document.createElement('button');
    invoker.textContent = 'Connect';
    document.body.appendChild(invoker);
    invoker.focus();
    expect(document.activeElement).toBe(invoker);

    function Harness() {
      const [open, setOpen] = React.useState(true);
      return (
        <ConnectorSetupDialog guidance={slackGuidance} open={open} onOpenChange={setOpen} />
      );
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<Harness />));

    // Close via the footer Close button.
    const closeButton = Array.from(getDialog().querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Close');
    expect(closeButton).toBeDefined();
    act(() => closeButton!.click());

    expect(document.querySelector('[data-testid="connector-setup-dialog"]')).toBeNull();
    expect(document.activeElement).toBe(invoker);

    act(() => root.unmount());
    container.remove();
    invoker.remove();
  });

  it('surfaces an announced error when clipboard copy is rejected (design-system F1)', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('not allowed'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const m = mount(<ConnectorSetupDialog guidance={slackGuidance} open onOpenChange={() => {}} />);
    const dialog = getDialog();
    const copyButton = Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Copy Slack environment variables',
    );
    expect(copyButton).toBeDefined();

    await act(async () => {
      copyButton!.click();
      // Let the rejected writeText microtask settle.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    const alert = dialog.querySelector('[data-testid="connector-setup-env-vars-error"]');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('Select the text above');
    // Selectable fallback stays present.
    expect(dialog.querySelector('[data-testid="connector-setup-env-vars"]')).not.toBeNull();
    m.unmount();
  });

  it('traps Tab focus inside the dialog (last→first wrap)', () => {
    const m = mount(<ConnectorSetupDialog guidance={slackGuidance} open onOpenChange={() => {}} />);
    const dialog = getDialog();
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]'),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    expect(document.activeElement).toBe(last);
    act(() => {
      dialog.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
    });
    // React onKeyDown is synthetic; dispatch a native event the handler is bound to via React.
    expect(document.activeElement).toBe(first);
    m.unmount();
  });

  it('traps Shift+Tab focus inside the dialog (first→last wrap)', () => {
    const m = mount(<ConnectorSetupDialog guidance={slackGuidance} open onOpenChange={() => {}} />);
    const dialog = getDialog();
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]'),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    first.focus();
    expect(document.activeElement).toBe(first);
    act(() => {
      dialog.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(last);
    m.unmount();
  });

  it('moves initial focus into the dialog on open', () => {
    vi.useFakeTimers();
    try {
      const m = mount(<ConnectorSetupDialog guidance={slackGuidance} open onOpenChange={() => {}} />);
      // Initial focus is scheduled via setTimeout(0); flush it.
      act(() => {
        vi.advanceTimersByTime(1);
      });
      const dialog = getDialog();
      const firstFocusable = dialog.querySelector<HTMLElement>('button:not([disabled]), a[href]');
      expect(firstFocusable).not.toBeNull();
      expect(document.activeElement).toBe(firstFocusable);
      m.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
