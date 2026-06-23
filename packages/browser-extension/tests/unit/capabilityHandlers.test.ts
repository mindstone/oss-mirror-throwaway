/**
 * Stage 6b — capability-handler unit tests (happy-dom).
 *
 * Covers read / selection / URL / fill_form / click / scroll including:
 *   - React-compatible native value setter (R23)
 *   - Sensitive-field detection + denial (R10 / D15)
 *   - TOCTOU label re-read (R22)
 *   - 200K char cap on read_page (D28 / R33)
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 6b)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  click,
  fill_form,
  get_current_tab_url,
  get_selection,
  read_page,
  isSensitiveField,
  resolveElementLabel,
  scroll,
  setValueReactCompatibly,
  READ_PAGE_DEFAULT_MAX_CHARS,
} from '../../src/content/capabilityHandlers';

const CTX = {};

function resetDom(): void {
  document.body.innerHTML = '';
  document.title = '';
  // In happy-dom, window.scrollTo is a no-op but defined; make it a spy for scroll tests.
}

beforeEach(() => {
  resetDom();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// read_page
// ---------------------------------------------------------------------------

describe('read_page', () => {
  it('returns title + url + full text when under the cap', () => {
    document.title = 'Hello';
    document.body.textContent = 'Plain text body.';
    const result = read_page(CTX);
    expect(result.title).toBe('Hello');
    expect(result.url).toMatch(/^https?:/);
    expect(result.text).toContain('Plain text body.');
    expect(result.truncated).toBe(false);
  });

  it('truncates at the cap and flips truncated=true', () => {
    document.body.textContent = 'X'.repeat(READ_PAGE_DEFAULT_MAX_CHARS + 500);
    const result = read_page(CTX);
    expect(result.text.length).toBe(READ_PAGE_DEFAULT_MAX_CHARS);
    expect(result.truncated).toBe(true);
  });

  it('respects caller-provided maxChars', () => {
    document.body.textContent = 'hello world';
    const result = read_page(CTX, { maxChars: 5 });
    expect(result.text).toBe('hello');
    expect(result.truncated).toBe(true);
  });

  it('returns empty text when body is empty', () => {
    // An empty body but present root element — expect text to be '' not throw.
    const result = read_page(CTX);
    expect(result.text).toBe('');
    expect(result.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// get_selection
// ---------------------------------------------------------------------------

describe('get_selection', () => {
  it('returns an empty string when no text is selected', () => {
    const result = get_selection(CTX);
    expect(result.text).toBe('');
  });

  it('returns the selected text when window.getSelection has a range', () => {
    const spy = vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => 'selected bit',
    } as unknown as Selection);
    const result = get_selection(CTX);
    expect(result.text).toBe('selected bit');
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// get_current_tab_url
// ---------------------------------------------------------------------------

describe('get_current_tab_url', () => {
  it('returns the current href and title', () => {
    document.title = 'Current Tab';
    const result = get_current_tab_url(CTX);
    expect(result.url).toBe(location.href);
    expect(result.title).toBe('Current Tab');
  });
});

// ---------------------------------------------------------------------------
// fill_form
// ---------------------------------------------------------------------------

describe('fill_form', () => {
  it('sets a plain-text input and fires input+change events', () => {
    document.body.innerHTML = '<input id="email" name="email" type="email" />';
    const input = document.querySelector<HTMLInputElement>('#email');
    expect(input).not.toBeNull();
    const events: string[] = [];
    input!.addEventListener('input', () => events.push('input'));
    input!.addEventListener('change', () => events.push('change'));

    const result = fill_form(CTX, {
      fields: [{ selector: '#email', value: '[external-email]' }],
    });

    expect(input!.value).toBe('[external-email]');
    expect(events).toEqual(['input', 'change']);
    expect(result.summary).toEqual({ set: 1, skipped: 0 });
    expect(result.fields[0]).toMatchObject({ selector: '#email', set: true });
  });

  it('React-compatible setter reaches the prototype descriptor', () => {
    document.body.innerHTML = '<input id="nm" name="first_name" />';
    const input = document.querySelector<HTMLInputElement>('#nm')!;
    // Simulate a React-controlled input that hijacks the instance descriptor.
    Object.defineProperty(input, 'value', {
      get: () => 'stuck',
      set: () => {
        throw new Error('React would ignore this instance-level setter');
      },
      configurable: true,
    });
    // setValueReactCompatibly should still reach the prototype setter without
    // hitting the instance-level one we poisoned above.
    expect(() => setValueReactCompatibly(input, 'new value')).not.toThrow();
    // Instance getter still returns 'stuck' because we replaced it, but the
    // native setter did its job at the prototype level — dispatching an event.
    let dispatched = false;
    input.addEventListener('input', () => {
      dispatched = true;
    });
    setValueReactCompatibly(input, 'second');
    expect(dispatched).toBe(true);
  });

  it('denies a password field by default', () => {
    document.body.innerHTML =
      '<input id="pw" name="password" type="password" />';
    const input = document.querySelector<HTMLInputElement>('#pw')!;
    const result = fill_form(CTX, {
      fields: [{ selector: '#pw', value: 'hunter2' }],
    });
    expect(result.fields[0]).toEqual({
      selector: '#pw',
      set: false,
      skipped: true,
      reason: 'sensitive_denied_by_default',
    });
    expect(input.value).toBe('');
    expect(result.summary).toEqual({ set: 0, skipped: 1 });
  });

  it('sets a password field when includeSensitive: true', () => {
    document.body.innerHTML =
      '<input id="pw" name="password" type="password" />';
    const input = document.querySelector<HTMLInputElement>('#pw')!;
    const result = fill_form(CTX, {
      fields: [{ selector: '#pw', value: 'hunter2', includeSensitive: true }],
    });
    expect(input.value).toBe('hunter2');
    expect(result.fields[0]).toMatchObject({ set: true });
  });

  it('denies a cvv by the name/id heuristic', () => {
    document.body.innerHTML = '<input id="ccv" name="cvv" type="text" />';
    const result = fill_form(CTX, {
      fields: [{ selector: '#ccv', value: '123' }],
    });
    expect(result.fields[0]).toMatchObject({
      skipped: true,
      reason: 'sensitive_denied_by_default',
    });
  });

  it('denies a hidden input', () => {
    document.body.innerHTML = '<input id="h" name="csrf" type="hidden" />';
    const result = fill_form(CTX, {
      fields: [{ selector: '#h', value: 'tok' }],
    });
    expect(result.fields[0]).toMatchObject({
      skipped: true,
      reason: 'sensitive_denied_by_default',
    });
  });

  it('denies a file-upload input', () => {
    document.body.innerHTML = '<input id="up" name="upload" type="file" />';
    const result = fill_form(CTX, {
      fields: [{ selector: '#up', value: 'anything' }],
    });
    expect(result.fields[0]).toMatchObject({
      skipped: true,
      reason: 'sensitive_denied_by_default',
    });
  });

  it('returns not_found for a missing selector', () => {
    document.body.innerHTML = '<input id="x" />';
    const result = fill_form(CTX, {
      fields: [{ selector: '#nope', value: 'v' }],
    });
    expect(result.fields[0]).toEqual({
      selector: '#nope',
      set: false,
      skipped: true,
      reason: 'not_found',
    });
  });

  it('detects TOCTOU label mismatch and skips the field', () => {
    document.body.innerHTML =
      '<label for="em">Email address</label><input id="em" name="email" />';
    const result = fill_form(CTX, {
      fields: [
        {
          selector: '#em',
          value: '[external-email]',
          elementLabel: 'Company name', // what the agent/approval thought the label was
        },
      ],
    });
    expect(result.fields[0]).toMatchObject({
      skipped: true,
      reason: 'label_mismatch',
      expected: 'Company name',
      got: 'Email address',
    });
  });

  it('allows a matching elementLabel (case-insensitive)', () => {
    document.body.innerHTML =
      '<label for="em">Email Address</label><input id="em" name="email" />';
    const result = fill_form(CTX, {
      fields: [
        {
          selector: '#em',
          value: '[external-email]',
          elementLabel: 'email address',
        },
      ],
    });
    expect(result.fields[0]).toMatchObject({ set: true });
  });

  it('aggregates the summary count across multiple fields', () => {
    document.body.innerHTML =
      '<input id="a" name="firstname" /><input id="b" name="password" type="password" /><input id="c" name="company" />';
    const result = fill_form(CTX, {
      fields: [
        { selector: '#a', value: 'Ada' },
        { selector: '#b', value: 'pw' },
        { selector: '#c', value: 'Rebel' },
      ],
    });
    expect(result.summary).toEqual({ set: 2, skipped: 1 });
  });

  it('skips non-fillable targets (contenteditable div) with not_fillable', () => {
    document.body.innerHTML = '<div id="d" contenteditable="true">existing</div>';
    const result = fill_form(CTX, {
      fields: [{ selector: '#d', value: 'new' }],
    });
    expect(result.fields[0]).toMatchObject({
      skipped: true,
      reason: 'not_fillable',
    });
  });

  it('treats an invalid CSS selector as not_found rather than throwing', () => {
    const result = fill_form(CTX, {
      fields: [{ selector: ':::not-a-valid-selector', value: 'x' }],
    });
    expect(result.fields[0]).toMatchObject({
      skipped: true,
      reason: 'not_found',
    });
  });

  it('exposes isSensitiveField for direct checks (autocomplete heuristic)', () => {
    document.body.innerHTML =
      '<input id="ac" autocomplete="current-password" type="text" />';
    const input = document.querySelector<HTMLInputElement>('#ac')!;
    expect(isSensitiveField(input)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// click
// ---------------------------------------------------------------------------

describe('click', () => {
  it('clicks a matching element when labels agree', () => {
    document.body.innerHTML = '<button id="go">Save draft</button>';
    const btn = document.querySelector<HTMLButtonElement>('#go')!;
    const spy = vi.fn();
    btn.addEventListener('click', spy);
    const result = click(CTX, {
      selector: '#go',
      elementLabel: 'Save draft',
    });
    expect(result).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns BAD_REQUEST when the selector matches nothing', () => {
    const result = click(CTX, {
      selector: '#nope',
      elementLabel: 'Save draft',
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'BAD_REQUEST',
      reason: 'not_found',
    });
  });

  it('refuses to click when the label drifted (TOCTOU)', () => {
    document.body.innerHTML = '<button id="danger">Delete account</button>';
    const btn = document.querySelector<HTMLButtonElement>('#danger')!;
    const spy = vi.fn();
    btn.addEventListener('click', spy);
    const result = click(CTX, {
      selector: '#danger',
      elementLabel: 'Save draft',
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'BAD_REQUEST',
      reason: 'label_mismatch',
      expected: 'Save draft',
      got: 'Delete account',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to aria-label for label resolution', () => {
    document.body.innerHTML =
      '<button id="b" aria-label="Save draft">&nbsp;</button>';
    const result = click(CTX, {
      selector: '#b',
      elementLabel: 'Save draft',
    });
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// scroll
// ---------------------------------------------------------------------------

describe('scroll', () => {
  it('calls window.scrollTo with the requested y and returns current scrollY', async () => {
    // happy-dom doesn't actually scroll, but we can spy on the call.
    const spy = vi
      .spyOn(window, 'scrollTo')
      .mockImplementation(((_opts: unknown): void => {
        // simulate settle: push scrollY after the call
        Object.defineProperty(window, 'scrollY', {
          configurable: true,
          value: 200,
        });
      }) as unknown as typeof window.scrollTo);
    const result = await scroll(CTX, { y: 200 });
    expect(spy).toHaveBeenCalled();
    expect(result.y).toBe(200);
  });

  it('clamps non-finite y to 0', async () => {
    const spy = vi
      .spyOn(window, 'scrollTo')
      .mockImplementation((() => {}) as unknown as typeof window.scrollTo);
    await scroll(CTX, { y: NaN });
    expect(spy).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });
});

// ---------------------------------------------------------------------------
// resolveElementLabel (direct)
// ---------------------------------------------------------------------------

describe('resolveElementLabel', () => {
  it('prefers aria-label over everything else', () => {
    document.body.innerHTML =
      '<label for="x">Visible label</label><input id="x" aria-label="Aria wins" placeholder="ph" />';
    const el = document.getElementById('x')!;
    expect(resolveElementLabel(el)).toBe('Aria wins');
  });

  it('falls back to associated <label> on a form field', () => {
    document.body.innerHTML =
      '<label for="x">Company name</label><input id="x" />';
    const el = document.getElementById('x')!;
    expect(resolveElementLabel(el)).toBe('Company name');
  });

  it('falls back to placeholder then title then innerText', () => {
    document.body.innerHTML =
      '<input id="x" placeholder="fill me" /> <button id="b" title="tooltip"></button>';
    const ph = document.getElementById('x')!;
    expect(resolveElementLabel(ph)).toBe('fill me');
    const b = document.getElementById('b')!;
    expect(resolveElementLabel(b)).toBe('tooltip');
  });
});
