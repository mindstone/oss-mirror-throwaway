// @vitest-environment happy-dom

/**
 * CompactionOverlay — reason-aware error copy + button-label tests.
 *
 * Covers REBEL-5BM Stage 2 + Phase-7 allow-list inversion. The error-phase copy
 * is now an ALLOW-LIST:
 *   - bespoke reason copy:  agent_loop_error_after_recovery → "That cleanup
 *     worked…" + "Close"
 *   - genuine size/capacity failures (summary_generation_failed, depth_limit_reached,
 *     attempt_limit_reached) → "fresh start / still too large" + "Start fresh"
 *   - NEUTRAL default (everything else: long_context_fallback_failed provider
 *     errors, null/unknown, future reasons) → "That step didn't complete." +
 *     "Close" — NOT the misleading "too large" copy.
 * Across all reasons the button ACTION is identical (dismiss → onDismiss); only
 * the label/copy differs.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompactionOverlay, type CompactionOverlayProps } from '../CompactionOverlay';
import type { ExhaustedReason } from '@renderer/features/agent-session/store/sessionStore';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseProps: CompactionOverlayProps = {
  isOpen: true,
  phase: 'error',
  statusMessage: 'Recovery failed: something',
  depth: 1,
  onDismiss: () => {},
};

// Bespoke reason copy (agent_loop_error_after_recovery)
const AFTER_RECOVERY_HEADLINE = 'That cleanup worked. The next step tripped.';
const AFTER_RECOVERY_SUBTEXT_FRAGMENT = 'send your message again';

// Genuine size/capacity copy ("fresh start")
const SIZE_HEADLINE = 'This conversation needs a fresh start';
const SIZE_SUBTEXT_FRAGMENT = 'still too large';
const SIZE_BUTTON_LABEL = 'Start fresh';

// Neutral default copy
const NEUTRAL_HEADLINE = "That step didn't complete.";
const NEUTRAL_SUBTEXT_FRAGMENT = "the last step didn't finish";

const CLOSE_BUTTON_LABEL = 'Close';

// renderToString HTML-encodes apostrophes as &#x27;; decode so assertions can use
// human-readable copy fragments (e.g. "didn't").
const decodeApostrophes = (html: string) => html.replace(/&#x27;/g, "'");

const renderHtml = (reason: CompactionOverlayProps['reason'], extra: Partial<CompactionOverlayProps> = {}) =>
  decodeApostrophes(renderToString(createElement(CompactionOverlay, { ...baseProps, reason, ...extra })));

describe('CompactionOverlay error-phase allow-list copy', () => {
  it('bespoke: agent_loop_error_after_recovery → its copy + "Close"', () => {
    const html = renderHtml('agent_loop_error_after_recovery');
    expect(html).toContain(AFTER_RECOVERY_HEADLINE);
    expect(html).toContain(AFTER_RECOVERY_SUBTEXT_FRAGMENT);
    expect(html).toContain(CLOSE_BUTTON_LABEL);
    // Not the size copy nor the neutral default.
    expect(html).not.toContain(SIZE_SUBTEXT_FRAGMENT);
    expect(html).not.toContain(SIZE_HEADLINE);
    expect(html).not.toContain(SIZE_BUTTON_LABEL);
    expect(html).not.toContain(NEUTRAL_HEADLINE);
  });

  it('size: summary_generation_failed → "fresh start / too large" + "Start fresh"', () => {
    const html = renderHtml('summary_generation_failed');
    expect(html).toContain(SIZE_HEADLINE);
    expect(html).toContain(SIZE_SUBTEXT_FRAGMENT);
    expect(html).toContain(SIZE_BUTTON_LABEL);
    expect(html).not.toContain(NEUTRAL_HEADLINE);
    expect(html).not.toContain(AFTER_RECOVERY_HEADLINE);
  });

  it('size: depth_limit_reached → "fresh start / too large" + "Start fresh"', () => {
    const html = renderHtml('depth_limit_reached');
    expect(html).toContain(SIZE_HEADLINE);
    expect(html).toContain(SIZE_SUBTEXT_FRAGMENT);
    expect(html).toContain(SIZE_BUTTON_LABEL);
    expect(html).not.toContain(NEUTRAL_HEADLINE);
  });

  it('size: attempt_limit_reached → "fresh start / too large" + "Start fresh"', () => {
    const html = renderHtml('attempt_limit_reached');
    expect(html).toContain(SIZE_HEADLINE);
    expect(html).toContain(SIZE_BUTTON_LABEL);
    expect(html).not.toContain(NEUTRAL_HEADLINE);
  });

  it('neutral: long_context_fallback_failed (provider error) → neutral copy + "Close", NOT "too large"', () => {
    const html = renderHtml('long_context_fallback_failed');
    expect(html).toContain(NEUTRAL_HEADLINE);
    expect(html).toContain(NEUTRAL_SUBTEXT_FRAGMENT);
    expect(html).toContain(CLOSE_BUTTON_LABEL);
    // The whole point of the inversion: a non-size failure must NOT claim "too large".
    expect(html).not.toContain(SIZE_SUBTEXT_FRAGMENT);
    expect(html).not.toContain(SIZE_HEADLINE);
    expect(html).not.toContain(SIZE_BUTTON_LABEL);
  });

  it('neutral: null and undefined reason → neutral copy + "Close", NOT "too large"', () => {
    for (const html of [renderHtml(null), renderHtml(undefined)]) {
      expect(html).toContain(NEUTRAL_HEADLINE);
      expect(html).toContain(CLOSE_BUTTON_LABEL);
      expect(html).not.toContain(SIZE_SUBTEXT_FRAGMENT);
      expect(html).not.toContain(SIZE_HEADLINE);
      expect(html).not.toContain(SIZE_BUTTON_LABEL);
    }
  });

  it('neutral: an unrelated/non-size reason (aborted) → neutral copy + "Close"', () => {
    const html = renderHtml('aborted');
    expect(html).toContain(NEUTRAL_HEADLINE);
    expect(html).toContain(CLOSE_BUTTON_LABEL);
    expect(html).not.toContain(SIZE_HEADLINE);
  });

  it('ignores reason outside the error phase (non-error phases are unaffected)', () => {
    const html = renderHtml('agent_loop_error_after_recovery', { phase: 'compacting' });
    expect(html).toContain('Tidying the conversation');
    expect(html).not.toContain(AFTER_RECOVERY_HEADLINE);
    expect(html).not.toContain(NEUTRAL_HEADLINE);
  });
});

// Exhaustive bucket coverage + open-union runtime safety for the ERROR_COPY_BUCKET
// classifier (Stage 1, 260607_invert_overlay_error_copy / reason_aware_recovery_overlay_copy).
// The classifier is an exhaustive `Record<ExhaustedReason, 'size' | 'neutral'>`, so a new
// union member fails to COMPILE until bucketed — this table is the behavioural twin of that
// compile-time guarantee. If you add an ExhaustedReason, add it here too.
describe('CompactionOverlay error-phase exhaustive bucket classification', () => {
  type Bucket = 'size' | 'neutral' | 'bespoke';
  // Every ExhaustedReason member and its expected copy bucket. 'bespoke' = has its
  // own ERROR_REASON_CONTENT entry (layered on top of an underlying neutral bucket).
  const EVERY_REASON: Array<{ reason: ExhaustedReason; bucket: Bucket }> = [
    { reason: 'summary_generation_failed', bucket: 'size' },
    { reason: 'depth_limit_reached', bucket: 'size' },
    { reason: 'attempt_limit_reached', bucket: 'size' },
    { reason: 'no_qualifying_profile', bucket: 'neutral' },
    { reason: 'rate_limited', bucket: 'neutral' },
    { reason: 'recovery_disabled', bucket: 'neutral' },
    { reason: 'no_messages_to_compact', bucket: 'neutral' },
    { reason: 'agent_loop_error_before_recovery', bucket: 'neutral' },
    { reason: 'agent_loop_error_after_recovery', bucket: 'bespoke' },
    { reason: 'long_context_fallback_failed', bucket: 'neutral' },
    { reason: 'aborted', bucket: 'neutral' },
  ];

  for (const { reason, bucket } of EVERY_REASON) {
    it(`${reason} → ${bucket} copy`, () => {
      const html = renderHtml(reason);
      if (bucket === 'size') {
        expect(html).toContain(SIZE_HEADLINE);
        expect(html).toContain(SIZE_BUTTON_LABEL);
        expect(html).not.toContain(NEUTRAL_HEADLINE);
      } else if (bucket === 'bespoke') {
        expect(html).toContain(AFTER_RECOVERY_HEADLINE);
        expect(html).toContain(CLOSE_BUTTON_LABEL);
        expect(html).not.toContain(SIZE_HEADLINE);
      } else {
        expect(html).toContain(NEUTRAL_HEADLINE);
        expect(html).toContain(CLOSE_BUTTON_LABEL);
        expect(html).not.toContain(SIZE_HEADLINE);
        expect(html).not.toContain(SIZE_BUTTON_LABEL);
      }
    });
  }

  // OPEN-UNION SAFETY: ExhaustedReason is derived from AgentEvent and arrives over
  // IPC/stream + JSON, so a runtime value outside the compile-time union can reach
  // the overlay. It must default to the neutral copy, NOT crash and NOT falsely
  // claim "too large". (The cast simulates a future/garbage reason from the wire.)
  it('open-union: an unknown runtime reason → neutral copy, no crash, NOT "too large"', () => {
    const html = renderHtml('some_future_reason_from_the_wire' as unknown as ExhaustedReason);
    expect(html).toContain(NEUTRAL_HEADLINE);
    expect(html).toContain(CLOSE_BUTTON_LABEL);
    expect(html).not.toContain(SIZE_HEADLINE);
    expect(html).not.toContain(SIZE_SUBTEXT_FRAGMENT);
    expect(html).not.toContain(SIZE_BUTTON_LABEL);
  });

  // Prototype-pollution keys are the dangerous open-union edge: the copy maps are
  // plain objects, so a bare `MAP[reason]` would return an INHERITED member
  // (e.g. Object.prototype.toString — a truthy function) for these keys and bypass
  // the neutral fallback. resolveErrorContent guards every lookup with Object.hasOwn,
  // so these must still resolve to neutral copy (and never crash on rendering a function).
  it('open-union: prototype-key reasons (__proto__/constructor/toString) → neutral copy, no crash', () => {
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const html = renderHtml(key as unknown as ExhaustedReason);
      expect(html).toContain(NEUTRAL_HEADLINE);
      expect(html).toContain(CLOSE_BUTTON_LABEL);
      expect(html).not.toContain(SIZE_HEADLINE);
      expect(html).not.toContain(SIZE_BUTTON_LABEL);
      // The bespoke after-recovery copy must not leak in either.
      expect(html).not.toContain(AFTER_RECOVERY_HEADLINE);
    }
  });
});

// ─── Action-identity (behavioral) ────────────────────────────────────────────
// The copy/label changes are presentation-only: the button's onClick stays
// `onDismiss` for EVERY reason. These tests mount the real component, click the
// button, and assert `onDismiss` fires identically regardless of reason/label.
// `handleDismiss` defers `onDismiss` by 400ms, so we advance fake timers.

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

describe('CompactionOverlay error button action is dismiss-only across all reasons', () => {
  const mounted: Mounted[] = [];

  afterEach(() => {
    mounted.forEach((m) => m.unmount());
    mounted.length = 0;
    vi.useRealTimers();
  });

  const cases: Array<{ reason: CompactionOverlayProps['reason']; label: string; desc: string }> = [
    { reason: 'agent_loop_error_after_recovery', label: CLOSE_BUTTON_LABEL, desc: 'bespoke reason ("Close")' },
    { reason: 'summary_generation_failed', label: SIZE_BUTTON_LABEL, desc: 'genuine size failure ("Start fresh")' },
    { reason: 'long_context_fallback_failed', label: CLOSE_BUTTON_LABEL, desc: 'provider error / neutral ("Close")' },
    { reason: null, label: CLOSE_BUTTON_LABEL, desc: 'null reason / neutral ("Close")' },
  ];

  for (const { reason, label, desc } of cases) {
    it(`calls onDismiss for ${desc}`, () => {
      vi.useFakeTimers();
      const onDismiss = vi.fn();
      const m = render(createElement(CompactionOverlay, { ...baseProps, reason, onDismiss }));
      mounted.push(m);

      const button = m.container.querySelector('button');
      expect(button).not.toBeNull();
      expect(button!.textContent).toBe(label);

      act(() => {
        button!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      // onDismiss is deferred by the 400ms exit animation.
      expect(onDismiss).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  }
});
