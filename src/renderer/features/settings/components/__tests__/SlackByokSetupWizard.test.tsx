// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlackByokSetupWizard, type SlackByokCredentialsInput } from '../SlackByokSetupWizard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function buttonByName(name: string): HTMLButtonElement {
  const match = Array.from(document.body.querySelectorAll('button'))
    .find((button) => button.textContent?.includes(name));
  if (!match) throw new Error(`Button not found: ${name}`);
  return match as HTMLButtonElement;
}

function inputByLabel(label: string): HTMLInputElement {
  const labelNode = Array.from(document.body.querySelectorAll('label'))
    .find((item) => item.textContent === label);
  const id = labelNode?.getAttribute('for');
  if (!id) throw new Error(`Input label not found: ${label}`);
  return document.getElementById(id) as HTMLInputElement;
}

function changeInput(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function flushFocus(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
  });
}

describe('SlackByokSetupWizard', () => {
  let mounted: Mounted[] = [];
  let connectByok: (creds: SlackByokCredentialsInput) => Promise<void>;
  let connectByokSpy: ReturnType<typeof vi.fn<(creds: SlackByokCredentialsInput) => Promise<void>>>;
  let onOpenChange: (open: boolean) => void;
  let onOpenChangeSpy: ReturnType<typeof vi.fn<(open: boolean) => void>>;

  beforeEach(() => {
    connectByokSpy = vi.fn().mockResolvedValue(undefined);
    connectByok = (creds) => connectByokSpy(creds) as Promise<void>;
    onOpenChangeSpy = vi.fn();
    onOpenChange = (open) => onOpenChangeSpy(open);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    Object.defineProperty(window, 'appApi', {
      configurable: true,
      writable: true,
      value: { openUrl: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    for (const instance of mounted) instance.unmount();
    mounted = [];
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function renderWizard(extra: Partial<React.ComponentProps<typeof SlackByokSetupWizard>> = {}) {
    const instance = mount(
      <SlackByokSetupWizard
        open
        onOpenChange={onOpenChange}
        cloudBaseUrl="https://cloud.example.test/"
        connectByok={connectByok}
        {...extra}
      />,
    );
    mounted.push(instance);
    return instance;
  }

  it('renders the six-step sidebar flow in order', async () => {
    renderWizard();
    expect(document.body.textContent).toContain('Create a Slack app');
    expect(document.body.textContent).toContain('Basic Information → OAuth & Permissions → App Home → Event Subscriptions → Authorise');

    changeInput(inputByLabel('Slack app URL or App ID'), 'A1234567890');
    act(() => buttonByName('Next: app credentials').click());
    expect(document.body.textContent).toContain('Paste app credentials');

    changeInput(inputByLabel('Client ID'), '123.456');
    changeInput(inputByLabel('Client Secret'), 'client-secret');
    changeInput(inputByLabel('Signing Secret'), 'signing-secret');
    act(() => buttonByName('Next: OAuth & Permissions').click());
    expect(document.body.textContent).toContain('Add the redirect URL and permissions');

    act(() => buttonByName('Next: App Home').click());
    expect(document.body.textContent).toContain('Allow people to message Rebel directly');
    expect(document.body.textContent).toContain('Messages Tab');
    expect(document.body.textContent).toContain('Allow users to send Slash commands and messages from the messages tab');

    act(() => buttonByName('Next: events').click());
    expect(document.body.textContent).toContain('Turn on Slack events');

    act(() => buttonByName('I saved events in Slack').click());
    expect(document.body.textContent).toContain('Authorise Slack');

    act(() => buttonByName('Back').click());
    expect(document.body.textContent).toContain('Turn on Slack events');
  });

  it('step 4 deep-links to App Home and warns DMs are disabled until Messages Tab is enabled', () => {
    renderWizard({ initialStep: 4, initialAppReference: 'A1234567890' });
    expect(document.body.textContent).toContain('Allow people to message Rebel directly');
    expect(document.body.textContent).toContain('the DM input box will be greyed out');
    act(() => buttonByName('Open App Home').click());
    expect(window.appApi.openUrl).toHaveBeenCalledWith('https://api.slack.com/apps/A1234567890/app-home');
  });

  it('step 1 validates app URL or App ID with exact copy', () => {
    renderWizard();
    act(() => buttonByName('Next: app credentials').click());
    expect(document.body.textContent).toContain('Paste the Slack app page URL or App ID so Rebel can open the right Slack pages.');

    changeInput(inputByLabel('Slack app URL or App ID'), 'definitely-not-slack');
    expect(document.body.textContent).toContain('That doesn\'t look like a Slack app URL or App ID. It usually starts with "A".');

    changeInput(inputByLabel('Slack app URL or App ID'), 'https://api.slack.com/apps/A1234567890/general');
    expect(document.body.textContent).toContain('Got it. Future Slack links will open this app directly.');
  });

  it('step 2 disables Next for empty fields and renders per-field Required errors', () => {
    renderWizard({ initialStep: 2, initialAppReference: 'A1234567890', showValidationOnMount: true });
    expect(buttonByName('Next: OAuth & Permissions').disabled).toBe(true);
    expect(document.body.textContent?.match(/Required/g)).toHaveLength(3);
  });

  it('step 2 shows invalid client ID and short-secret inline errors', () => {
    renderWizard({ initialStep: 2, initialAppReference: 'A1234567890', showValidationOnMount: true });

    changeInput(inputByLabel('Client ID'), 'not-right');
    changeInput(inputByLabel('Client Secret'), 'short');
    changeInput(inputByLabel('Signing Secret'), 'short');

    expect(document.body.textContent).toContain('Client ID looks like 12345.67890');
    expect(document.body.textContent?.match(/Looks too short to be valid/g)).toHaveLength(2);
    expect(buttonByName('Next: OAuth & Permissions').disabled).toBe(true);
  });

  it('step 6 calls connectByok with all credential fields', async () => {
    renderWizard({
      initialStep: 6,
      initialAppReference: 'A1234567890',
      initialCopyClicked: { redirect: true, botScopes: true, userScopes: true, eventUrl: true, eventNames: true },
      initialCredentials: { clientId: '123.456', clientSecret: 'client-secret', signingSecret: 'signing-secret' },
    });

    await act(async () => {
      buttonByName('Connect Slack').click();
      await Promise.resolve();
    });

    expect(connectByokSpy).toHaveBeenCalledWith({
      clientId: '123.456',
      clientSecret: 'client-secret',
      signingSecret: 'signing-secret',
    });
    expect(onOpenChangeSpy).toHaveBeenCalledWith(false);
  });

  it.each([1, 2, 3, 4, 5, 6] as const)('Cancel or close from step %s closes without connecting', (initialStep) => {
    renderWizard({
      initialStep,
      initialAppReference: 'A1234567890',
      initialCredentials: { clientId: '123.456', clientSecret: 'client-secret', signingSecret: 'signing-secret' },
      initialCopyClicked: { redirect: true, botScopes: true, userScopes: true, eventUrl: true, eventNames: true },
    });

    act(() => {
      const closeButton = document.body.querySelector('button[aria-label="Close dialog"]') as HTMLButtonElement | null;
      (initialStep === 1 ? buttonByName('Cancel') : closeButton)?.click();
    });

    expect(onOpenChangeSpy).toHaveBeenCalledWith(false);
    expect(connectByokSpy).not.toHaveBeenCalled();
  });

  it('copy buttons write redirect URL, scopes, event URL, and event names', async () => {
    renderWizard({ initialStep: 3, initialAppReference: 'A1234567890' });

    await act(async () => {
      buttonByName('Copy redirect URL').click();
      await Promise.resolve();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://cloud.example.test/api/integrations/slack/oauth/callback');
    await act(async () => {
      buttonByName('Copy bot scopes').click();
      await Promise.resolve();
    });
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(expect.stringContaining('chat:write'));
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(expect.not.stringContaining('search:read'));
    await act(async () => {
      buttonByName('Copy user scopes').click();
      await Promise.resolve();
    });
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(expect.stringContaining('search:read'));
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(expect.stringContaining('bookmarks:write'));

    act(() => buttonByName('Next: App Home').click());
    act(() => buttonByName('Next: events').click());
    await act(async () => {
      buttonByName('Copy event URL').click();
      await Promise.resolve();
    });
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('https://cloud.example.test/api/integrations/slack/events');
    await act(async () => {
      buttonByName('Copy event names').click();
      await Promise.resolve();
    });
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
      'app_mention\nmessage.channels\nmessage.groups\nmessage.im\nmessage.mpim\ntokens_revoked',
    );
  });

  it('shows secrets as text on focus and password again on blur', () => {
    renderWizard({ initialStep: 2, initialAppReference: 'A1234567890' });
    const clientSecret = inputByLabel('Client Secret');

    expect(clientSecret.type).toBe('password');
    act(() => clientSecret.focus());
    expect(clientSecret.type).toBe('text');
    act(() => clientSecret.blur());
    expect(clientSecret.type).toBe('password');
  });

  it('surfaces INVALID_FIELD setup errors in step 2 without closing the wizard', async () => {
    connectByokSpy = vi.fn().mockRejectedValue({ code: 'INVALID_FIELD', field: 'clientId', message: 'Client ID looks like 12345.67890' });
    connectByok = (creds) => connectByokSpy(creds) as Promise<void>;
    renderWizard({
      initialStep: 6,
      initialAppReference: 'A1234567890',
      initialCredentials: { clientId: '123.456', clientSecret: 'client-secret', signingSecret: 'signing-secret' },
      initialCopyClicked: { redirect: true, botScopes: true, userScopes: true, eventUrl: true, eventNames: true },
    });

    await act(async () => {
      buttonByName('Connect Slack').click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Check the highlighted field');
    expect(document.body.textContent).toContain('Paste app credentials');
    expect(document.body.textContent).toContain('Client ID looks like 12345.67890');
    expect(onOpenChangeSpy).not.toHaveBeenCalledWith(false);
  });

  it('surfaces NETWORK_UNREACHABLE on the authorise step and offers Open Cloud settings', async () => {
    connectByokSpy = vi.fn().mockRejectedValue({ code: 'NETWORK_UNREACHABLE', message: 'No cloud connection is available for Slack setup.' });
    connectByok = (creds) => connectByokSpy(creds) as Promise<void>;
    renderWizard({
      initialStep: 6,
      initialAppReference: 'A1234567890',
      initialCredentials: { clientId: '123.456', clientSecret: 'client-secret', signingSecret: 'signing-secret' },
      initialCopyClicked: { redirect: true, botScopes: true, userScopes: true, eventUrl: true, eventNames: true },
    });

    await act(async () => {
      buttonByName('Connect Slack').click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Couldn't reach Rebel Cloud");
    expect(document.body.textContent).toContain('Diagnostic code: NETWORK_UNREACHABLE');
    act(() => buttonByName('Open Cloud settings').click());
    expect(onOpenChangeSpy).toHaveBeenCalledWith(false);
  });

  it('renders exactly one dialog role labelled by the title', () => {
    renderWizard({ initialStep: 2, initialAppReference: 'A1234567890' });

    const dialogs = document.body.querySelectorAll('[role="dialog"]');
    expect(dialogs).toHaveLength(1);
    const labelledBy = dialogs[0].getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe('Paste app credentials');
  });

  it('moves focus between steps', async () => {
    renderWizard();
    await flushFocus();
    expect(document.activeElement).toBe(inputByLabel('Slack app URL or App ID'));

    changeInput(inputByLabel('Slack app URL or App ID'), 'A1234567890');
    act(() => buttonByName('Next: app credentials').click());
    await flushFocus();
    expect(document.activeElement).toBe(inputByLabel('Client ID'));

    for (const instance of mounted) instance.unmount();
    mounted = [];

    renderWizard({ initialStep: 2, initialAppReference: 'A1234567890' });
    await flushFocus();
    expect(document.activeElement).toBe(inputByLabel('Client ID'));
  });
});
