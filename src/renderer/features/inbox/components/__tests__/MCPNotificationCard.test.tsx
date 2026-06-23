// @vitest-environment happy-dom
/**
 * Tests for MCPNotificationCard — callback wiring for all notification states.
 *
 * Validates:
 * - approved notifications have onViewConnector callback
 * - changes_requested notifications have onMakeChanges callback
 * - ci_pass/ci_fail/rejected use onAcknowledge
 * - onOpenInGitHub works for changes_requested with prUrl
 * - Buttons are disabled when callbacks are not provided
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';

// Enable React act() environment
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = require('react-dom/client');
const { act: reactAct } = require('react');

import { MCPNotificationCard, type MCPNotificationCardProps } from '../MCPNotificationCard';

// ── Minimal render helper ───────────────────────────────────────────

function renderComponent(props: MCPNotificationCardProps): {
  container: HTMLElement;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: any;

  reactAct(() => {
    root = ReactDOMClient.createRoot(container);
    root.render(React.createElement(MCPNotificationCard, props));
  });

  return {
    container,
    unmount: () => {
      reactAct(() => root.unmount());
      document.body.removeChild(container);
    },
  };
}

function clickButton(container: HTMLElement, text: string): void {
  const buttons = Array.from(container.querySelectorAll('button'));
  const btn = buttons.find(b => b.textContent?.trim() === text);
  if (!btn) {
    throw new Error(`Button "${text}" not found. Available: ${buttons.map(b => b.textContent?.trim()).join(', ')}`);
  }
  reactAct(() => {
    btn.click();
  });
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement | null {
  const buttons = Array.from(container.querySelectorAll('button'));
  return buttons.find(b => b.textContent?.trim() === text) ?? null;
}

// ── Tests ───────────────────────────────────────────────────────────

describe('MCPNotificationCard', () => {
  describe('approved state', () => {
    it('calls onViewConnector when "View tool" is clicked', () => {
      const onViewConnector = vi.fn();
      const { container, unmount } = renderComponent({
        state: 'approved',
        connectorName: 'my-connector',
        onViewConnector,
      });

      clickButton(container, 'View tool');
      expect(onViewConnector).toHaveBeenCalledOnce();
      unmount();
    });

    it('disables "View tool" when onViewConnector is not provided', () => {
      const { container, unmount } = renderComponent({
        state: 'approved',
        connectorName: 'my-connector',
      });

      const btn = findButton(container, 'View tool');
      expect(btn).not.toBeNull();
      expect(btn!.disabled).toBe(true);
      unmount();
    });
  });

  describe('changes-requested state', () => {
    it('calls onMakeChanges when "Make the tweaks" is clicked', () => {
      const onMakeChanges = vi.fn();
      const { container, unmount } = renderComponent({
        state: 'changes-requested',
        connectorName: 'my-connector',
        reviewNotes: 'Please fix the tests',
        onMakeChanges,
      });

      clickButton(container, 'Make the tweaks');
      expect(onMakeChanges).toHaveBeenCalledOnce();
      unmount();
    });

    it('disables "Make the tweaks" when onMakeChanges is not provided', () => {
      const { container, unmount } = renderComponent({
        state: 'changes-requested',
        connectorName: 'my-connector',
      });

      const btn = findButton(container, 'Make the tweaks');
      expect(btn).not.toBeNull();
      expect(btn!.disabled).toBe(true);
      unmount();
    });

    it('calls onOpenInGitHub when "Open in GitHub" is clicked', () => {
      const onOpenInGitHub = vi.fn();
      const { container, unmount } = renderComponent({
        state: 'changes-requested',
        connectorName: 'my-connector',
        prUrl: 'https://github.com/org/repo/pull/1',
        onMakeChanges: vi.fn(),
        onOpenInGitHub,
      });

      clickButton(container, 'Open in GitHub');
      expect(onOpenInGitHub).toHaveBeenCalledOnce();
      unmount();
    });

    it('shows review notes when provided', () => {
      const { container, unmount } = renderComponent({
        state: 'changes-requested',
        connectorName: 'my-connector',
        reviewNotes: 'Please add error handling',
        onMakeChanges: vi.fn(),
      });

      expect(container.textContent).toContain('Please add error handling');
      expect(container.textContent).toContain('Feedback from review');
      unmount();
    });
  });

  describe('ci-pass state', () => {
    it('calls onAcknowledge when "OK" is clicked', () => {
      const onAcknowledge = vi.fn();
      const { container, unmount } = renderComponent({
        state: 'ci-pass',
        connectorName: 'my-connector',
        onAcknowledge,
      });

      clickButton(container, 'OK');
      expect(onAcknowledge).toHaveBeenCalledOnce();
      unmount();
    });

    it('disables "OK" when onAcknowledge is not provided', () => {
      const { container, unmount } = renderComponent({
        state: 'ci-pass',
        connectorName: 'my-connector',
      });

      const btn = findButton(container, 'OK');
      expect(btn).not.toBeNull();
      expect(btn!.disabled).toBe(true);
      unmount();
    });
  });

  describe('ci-fail state', () => {
    it('calls onAcknowledge when "OK" is clicked', () => {
      const onAcknowledge = vi.fn();
      const { container, unmount } = renderComponent({
        state: 'ci-fail',
        connectorName: 'my-connector',
        onAcknowledge,
      });

      clickButton(container, 'OK');
      expect(onAcknowledge).toHaveBeenCalledOnce();
      unmount();
    });
  });

  describe('rejected state', () => {
    it('calls onAcknowledge when "OK" is clicked', () => {
      const onAcknowledge = vi.fn();
      const { container, unmount } = renderComponent({
        state: 'rejected',
        connectorName: 'my-connector',
        onAcknowledge,
      });

      clickButton(container, 'OK');
      expect(onAcknowledge).toHaveBeenCalledOnce();
      unmount();
    });

    it('shows rejection reason when reviewNotes provided', () => {
      const { container, unmount } = renderComponent({
        state: 'rejected',
        connectorName: 'my-connector',
        reviewNotes: 'Does not meet quality standards',
        onAcknowledge: vi.fn(),
      });

      expect(container.textContent).toContain('Does not meet quality standards');
      expect(container.textContent).toContain('Why it was not accepted');
      unmount();
    });
  });

  describe('display copy', () => {
    it.each([
      ['ci-pass', 'passed its checks'],
      ['ci-fail', 'needs a fix before review'],
      ['approved', 'was approved'],
      ['changes-requested', 'needs a small update'],
      ['rejected', "wasn't accepted"],
    ] as const)('shows correct title for %s state', (state, expectedSubstring) => {
      const { container, unmount } = renderComponent({
        state,
        connectorName: 'test-connector',
        onAcknowledge: vi.fn(),
        onViewConnector: vi.fn(),
        onMakeChanges: vi.fn(),
      });

      expect(container.textContent).toContain(expectedSubstring);
      unmount();
    });
  });
});
