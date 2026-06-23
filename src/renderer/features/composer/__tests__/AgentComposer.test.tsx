// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import React, { createRef } from 'react';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = require('react-dom/client');
const { act: reactAct } = require('react');

vi.mock('../components/TipTapPromptEditor', () => ({
  TipTapPromptEditor: React.forwardRef((_props: unknown, _ref: unknown) => (
    <div contentEditable="true" data-testid="composer-input" />
  )),
}));

vi.mock('@renderer/features/voice/hooks/useAudioInputDevice', () => ({
  useAudioInputDevice: () => ({ deviceLabel: 'Default microphone' }),
}));

vi.mock('@renderer/components/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  IconButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Spinner: () => <span data-testid="spinner" />,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { AgentComposer, type AgentComposerProps } from '../AgentComposer';

function buildProps(overrides: Partial<AgentComposerProps> = {}): AgentComposerProps {
  return {
    commandInputRef: createRef<HTMLTextAreaElement>(),
    textPrompt: '',
    placeholder: 'Ask Rebel',
    isEditing: false,
    isBusy: false,
    isStopping: false,
    isTextPending: false,
    isPreparingMentionContext: false,
    mentionPopoverContent: null,
    currentMentionedFiles: [],
    maxAttachmentCount: 5,
    primaryButtonDisabled: false,
    isTranscribing: false,
    isTranscribeProcessing: false,
    onToggleTranscription: vi.fn(),
    onChange: vi.fn(),
    onKeyDown: vi.fn(),
    onSubmit: vi.fn(),
    onRefreshMentionContext: vi.fn(),
    ...overrides,
  };
}

function renderComponent(props: AgentComposerProps): {
  container: HTMLElement;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: any;

  reactAct(() => {
    root = ReactDOMClient.createRoot(container);
    root.render(React.createElement(AgentComposer, props));
  });

  return {
    container,
    unmount: () => {
      reactAct(() => root.unmount());
      document.body.removeChild(container);
    },
  };
}

describe('AgentComposer', () => {
  it('renders the active-turn stop action as a calm labelled control', () => {
    const onStopActiveTurn = vi.fn();
    const { container, unmount } = renderComponent(
      buildProps({
        isBusy: true,
        processingTurnId: 'turn-1',
        onStopActiveTurn,
      }),
    );

    const stopButton = container.querySelector('[data-testid="stop-turn-button"]') as HTMLButtonElement | null;

    expect(stopButton).not.toBeNull();
    expect(stopButton?.textContent).toContain('Stop');
    expect(stopButton?.getAttribute('variant')).toBe('secondary');
    expect(stopButton?.getAttribute('aria-label')).toBe('Stop current response');

    reactAct(() => {
      stopButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(onStopActiveTurn).toHaveBeenCalledOnce();
    unmount();
  });

  it('keeps the stop action disabled and announced while stopping', () => {
    const { container, unmount } = renderComponent(
      buildProps({
        isBusy: true,
        isStopping: true,
        processingTurnId: 'turn-1',
        onStopActiveTurn: vi.fn(),
      }),
    );

    const stopButton = container.querySelector('[data-testid="stop-turn-button"]') as HTMLButtonElement | null;

    expect(stopButton).not.toBeNull();
    expect(stopButton?.disabled).toBe(true);
    expect(stopButton?.textContent).toContain('Stopping');
    expect(stopButton?.getAttribute('aria-label')).toBe('Stopping current response');
    unmount();
  });

  it('does not render the legacy mentioned-file preview when rich mention chips are enabled', () => {
    const { container, unmount } = renderComponent(
      buildProps({
        textPrompt: '@`work/Mindstone/General/skills/operations/supplier-onboarding-form-completion` tests',
        currentMentionedFiles: [
          {
            key: 'skill:supplier-onboarding-form-completion',
            absolutePath:
              '/Users/example/work/Mindstone/General/skills/operations/supplier-onboarding-form-completion',
            relativePath:
              'work/Mindstone/General/skills/operations/supplier-onboarding-form-completion',
            name: 'supplier-onboarding-form-completion',
            kind: 'directory',
          },
        ],
      }),
    );

    expect(container.textContent).not.toContain('supplier-onboarding-form-completion/');
    expect(container.textContent).not.toContain(
      'work/Mindstone/General/skills/operations/supplier-onboarding-form-completion',
    );
    unmount();
  });

  describe('Stage 4 send-default audit — Queue is the click default when busy', () => {
    it('clicking the primary submit button while busy with text submits with mode=queue (NOT sendNow)', () => {
      const onSubmit = vi.fn();
      const { container, unmount } = renderComponent(
        buildProps({
          textPrompt: 'follow-up note',
          isBusy: true,
          processingTurnId: 'turn-1',
          onSubmit,
        }),
      );

      const sendQueueButton = container.querySelector(
        '[data-testid="send-queue-button"]',
      ) as HTMLButtonElement | null;
      expect(sendQueueButton).not.toBeNull();
      expect(sendQueueButton?.getAttribute('type')).toBe('submit');

      const form = sendQueueButton?.closest('form');
      reactAct(() => {
        form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      expect(onSubmit).toHaveBeenCalledOnce();
      expect(onSubmit).toHaveBeenCalledWith('queue');
      expect(onSubmit).not.toHaveBeenCalledWith('sendNow');
      unmount();
    });

    it('primary button reads "Queue" (not "Send") when busy with text and not editing', () => {
      const { container, unmount } = renderComponent(
        buildProps({
          textPrompt: 'follow-up note',
          isBusy: true,
          processingTurnId: 'turn-1',
        }),
      );

      const sendQueueButton = container.querySelector(
        '[data-testid="send-queue-button"]',
      ) as HTMLButtonElement | null;
      expect(sendQueueButton?.textContent).toContain('Queue');
      expect(sendQueueButton?.textContent).not.toMatch(/^Send$/);
      unmount();
    });

    it('explicit secondary send-now button submits with mode=sendNow', () => {
      const onSubmit = vi.fn();
      const { container, unmount } = renderComponent(
        buildProps({
          textPrompt: 'urgent correction',
          isBusy: true,
          processingTurnId: 'turn-1',
          onSubmit,
        }),
      );

      const sendNowButton = container.querySelector(
        '[data-testid="send-now-button"]',
      ) as HTMLButtonElement | null;
      expect(sendNowButton).not.toBeNull();
      expect(sendNowButton?.getAttribute('aria-label')).toBe(
        'Send now and interrupt current task',
      );

      reactAct(() => {
        sendNowButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });

      expect(onSubmit).toHaveBeenCalledOnce();
      expect(onSubmit).toHaveBeenCalledWith('sendNow');
      unmount();
    });

    it('idle composer click submits without mode override (no queue, no sendNow)', () => {
      const onSubmit = vi.fn();
      const { container, unmount } = renderComponent(
        buildProps({
          textPrompt: 'first message',
          isBusy: false,
          onSubmit,
        }),
      );

      const sendButton = container.querySelector(
        '[data-testid="composer-send-button"]',
      ) as HTMLButtonElement | null;
      expect(sendButton).not.toBeNull();

      const form = sendButton?.closest('form');
      reactAct(() => {
        form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      expect(onSubmit).toHaveBeenCalledOnce();
      expect(onSubmit).toHaveBeenCalledWith(undefined);
      unmount();
    });
  });
});
