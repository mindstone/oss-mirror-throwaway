import { describe, it, expect } from 'vitest';
import { resolveComposerSubmitMode, resolveAltEnterSubmitMode } from '../resolveComposerSubmitMode';

describe('resolveComposerSubmitMode', () => {
  it('returns sendNow when editing, even if busy', () => {
    expect(resolveComposerSubmitMode({ isBusy: true, isEditing: true })).toBe('sendNow');
    expect(resolveComposerSubmitMode({ isBusy: false, isEditing: true })).toBe('sendNow');
  });

  it('returns queue when busy and not editing', () => {
    expect(resolveComposerSubmitMode({ isBusy: true, isEditing: false })).toBe('queue');
  });

  it('returns undefined when idle and not editing', () => {
    expect(resolveComposerSubmitMode({ isBusy: false, isEditing: false })).toBeUndefined();
  });

  it('NEVER returns sendNow when busy and not editing (Stage 4 invariant)', () => {
    // This test pins the user-stated invariant: "the button default (for clicking
    // and ENTER) to be Queue rather than Send Now." Send-now must only be reachable
    // via the explicit secondary button — never via the default submit path, and
    // (since 2026-06-06) never via Alt+Enter either. A regression here would
    // re-introduce the silent-supersede class of bugs Stages 1-3 fixed.
    expect(resolveComposerSubmitMode({ isBusy: true, isEditing: false })).not.toBe('sendNow');
  });
});

describe('resolveAltEnterSubmitMode', () => {
  it('queues when busy with text (2026-06-06 decision: Alt+Enter no longer sends-now)', () => {
    expect(resolveAltEnterSubmitMode({ isBusy: true, hasText: true })).toBe('queue');
  });

  it('NEVER returns sendNow — send-now is button-only', () => {
    // Pins the behavior change: the Alt+Enter keyboard send-now/interrupt path
    // was removed because it re-introduced the accidental-supersede footgun.
    expect(resolveAltEnterSubmitMode({ isBusy: true, hasText: true })).not.toBe('sendNow');
  });

  it('does not intercept when idle (lets the key fall through)', () => {
    expect(resolveAltEnterSubmitMode({ isBusy: false, hasText: true })).toBeNull();
  });

  it('does not intercept when there is no text', () => {
    expect(resolveAltEnterSubmitMode({ isBusy: true, hasText: false })).toBeNull();
  });
});
