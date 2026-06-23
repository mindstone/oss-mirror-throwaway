/**
 * Rebel browser extension — content-script capability handlers (Stage 6b).
 *
 * These run inside the page's isolated world (via `chrome.scripting.executeScript`)
 * and implement the DOM side of every `rebel_browser_*` tool:
 *
 *   - read_page / get_selection / get_current_tab_url — read-only
 *   - fill_form / click / scroll — mutations gated by the safety layer
 *
 * Safety posture (R10 / D15):
 *   - Sensitive form fields (password / OTP / payment / hidden / file-upload)
 *     are denied by default. The agent must explicitly pass `includeSensitive`
 *     AND the user must approve in the heavier per-field card.
 *   - Click destructive phrases are scanned server-side, but the content
 *     script re-reads `elementLabel` at execution as TOCTOU defence: if the
 *     page mutated between approval and execution, the command is rejected.
 *
 * React-compatible mutation (R23 / D23):
 *   - `fill_form` uses the native value-setter + synthetic `input` / `change`
 *     events so React-controlled inputs pick up the new value.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 6b)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Execution context propagated from the bridge. Stage 6b accepts it but does
 * not yet enforce that `tabId === current tabId` — that wiring is Stage 6c.
 */
export interface ExecutionContext {
  tabId?: number;
  url?: string;
}

/** Upper bound on serialised page text (D28 / R33). */
export const READ_PAGE_DEFAULT_MAX_CHARS = 200_000;

export interface ReadPageParams {
  maxChars?: number;
}

export interface ReadPageResult {
  title: string;
  url: string;
  text: string;
  truncated: boolean;
}

export interface GetSelectionResult {
  text: string;
}

export interface GetCurrentTabUrlResult {
  url: string;
  title: string;
}

export interface FillFormField {
  selector: string;
  value: string;
  includeSensitive?: boolean;
  elementLabel?: string;
}

export interface FillFormParams {
  fields: FillFormField[];
}

export type FillFormSkipReason =
  | 'not_found'
  | 'not_fillable'
  | 'sensitive_denied_by_default'
  | 'label_mismatch';

export interface FillFormFieldResult {
  selector: string;
  set: boolean;
  skipped?: true;
  reason?: FillFormSkipReason;
  expected?: string;
  got?: string;
}

export interface FillFormResult {
  fields: FillFormFieldResult[];
  summary: { set: number; skipped: number };
}

export interface ClickParams {
  selector: string;
  elementLabel: string;
}

export interface ClickResult {
  ok: true;
}

export interface BadRequestError {
  ok: false;
  code: 'BAD_REQUEST';
  reason: 'not_found' | 'label_mismatch';
  expected?: string;
  got?: string;
}

export interface ScrollParams {
  y: number;
}

export interface ScrollResult {
  y: number;
}

// ---------------------------------------------------------------------------
// Sensitive-field heuristic (defence-in-depth with toolSafetyService)
// ---------------------------------------------------------------------------

const SENSITIVE_TYPE_ATTRS: ReadonlySet<string> = new Set([
  'password',
  'hidden',
  'file',
]);

const SENSITIVE_NAME_PATTERN =
  /password|passcode|passwd|otp|cvv|cc[-_]?number|ssn|cardnumber|card[-_]?num|secret|totp/i;

const SENSITIVE_AUTOCOMPLETE_PATTERN =
  /current-password|new-password|one-time-code|cc-number|cc-csc/i;

/**
 * Return true if the field should be treated as sensitive and denied by
 * default (unless the agent explicitly passed `includeSensitive: true` AND the
 * user approved it per-field).
 */
export function isSensitiveField(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  // `<input type="otp">` isn't a real HTML type but some libraries use it;
  // we still match it here via name/id/autocomplete heuristics.
  if (tag === 'input') {
    const input = el as HTMLInputElement;
    const type = (input.getAttribute('type') ?? 'text').toLowerCase();
    if (SENSITIVE_TYPE_ATTRS.has(type)) return true;
    if (type === 'otp') return true;
  }

  const attrs = [
    el.getAttribute('name') ?? '',
    el.getAttribute('id') ?? '',
    el.getAttribute('autocomplete') ?? '',
    el.getAttribute('data-testid') ?? '',
  ].join(' ');

  if (SENSITIVE_NAME_PATTERN.test(attrs)) return true;
  if (SENSITIVE_AUTOCOMPLETE_PATTERN.test(attrs)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Label resolution (shared by fill_form + click TOCTOU guard)
// ---------------------------------------------------------------------------

/**
 * Derive the "visible label" of an element using the same precedence order
 * the safety service used when it evaluated the approval:
 *
 *   1. `aria-label`
 *   2. associated `<label for="…">` or enclosing `<label>` (form fields)
 *   3. `placeholder`
 *   4. `title`
 *   5. `innerText` of the element itself
 *
 * Returns an empty string if none are present. Caller should `.trim()`
 * and compare case-insensitively.
 */
export function resolveElementLabel(el: Element): string {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();

  // `<label for="id">` — iterate labels of form-controls, or enclosing label.
  const asField = el as
    | HTMLInputElement
    | HTMLTextAreaElement
    | HTMLSelectElement
    | HTMLButtonElement;
  const labels = (asField as { labels?: NodeListOf<HTMLLabelElement> }).labels;
  if (labels && labels.length > 0) {
    const text = Array.from(labels)
      .map((l) => (l.innerText ?? l.textContent ?? '').trim())
      .filter(Boolean)
      .join(' ')
      .trim();
    if (text) return text;
  }

  const placeholder = el.getAttribute('placeholder');
  if (placeholder) return placeholder.trim();

  const title = el.getAttribute('title');
  if (title) return title.trim();

  const anyEl = el as HTMLElement;
  const innerText = (anyEl.innerText ?? el.textContent ?? '').trim();
  return innerText;
}

/**
 * NFKC-normalise + lowercase. Kept inline (rather than imported from
 * `@rebel/shared`) so the content script stays self-contained — content
 * scripts run in the page's world and can't cleanly pull in workspace
 * deps at runtime.
 *
 * Post-review B3: defence-in-depth against homoglyph / fullwidth /
 * ligature attacks on element labels (e.g. `Ｄｅｌｅｔｅ` or `ﬁle`).
 */
function foldForLabelCompare(input: string): string {
  if (typeof input !== 'string') return '';
  try {
    return input.normalize('NFKC').toLowerCase();
  } catch {
    return input.toLowerCase();
  }
}

/**
 * Case-insensitive, NFKC-normalised label match. Returns true if either side
 * is empty (no mismatch can be asserted) OR both fold to the same string.
 */
function labelsMatch(expected: string, actual: string): boolean {
  const a = foldForLabelCompare(expected).trim();
  const b = foldForLabelCompare(actual).trim();
  if (!a || !b) return true;
  return a === b;
}

// ---------------------------------------------------------------------------
// React-compatible native value setter (R23 / D23)
// ---------------------------------------------------------------------------

type ValueCarryingElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function isValueCarryingElement(el: Element): el is ValueCarryingElement {
  return (
    el instanceof HTMLInputElement
    || el instanceof HTMLTextAreaElement
    || el instanceof HTMLSelectElement
  );
}

/**
 * Set a form-control's value using the prototype's native setter so that
 * React's synthetic event system picks up the change. Falls back to direct
 * assignment if the prototype descriptor isn't available (e.g. custom element).
 */
export function setValueReactCompatibly(el: ValueCarryingElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as object | null;
  if (proto) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.set) {
      descriptor.set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
  }
  // Fallback — covers contenteditable and custom elements reached via `value`.
  (el as unknown as { value: string }).value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// ---------------------------------------------------------------------------
// Capability handlers
// ---------------------------------------------------------------------------

export function read_page(
  _ctx: ExecutionContext,
  params: ReadPageParams = {},
): ReadPageResult {
  const maxChars =
    typeof params.maxChars === 'number' && params.maxChars > 0
      ? Math.floor(params.maxChars)
      : READ_PAGE_DEFAULT_MAX_CHARS;

  const body = document.body;
  const fullText =
    (body as HTMLElement | null)?.innerText
    ?? document.documentElement?.textContent
    ?? '';

  const truncated = fullText.length > maxChars;
  const text = truncated ? fullText.slice(0, maxChars) : fullText;

  return {
    title: document.title ?? '',
    url: location.href,
    text,
    truncated,
  };
}

export function get_selection(_ctx: ExecutionContext): GetSelectionResult {
  const sel = window.getSelection();
  return { text: sel ? sel.toString() : '' };
}

export function get_current_tab_url(_ctx: ExecutionContext): GetCurrentTabUrlResult {
  return { url: location.href, title: document.title ?? '' };
}

export function fill_form(
  _ctx: ExecutionContext,
  params: FillFormParams,
): FillFormResult {
  const results: FillFormFieldResult[] = [];
  let setCount = 0;
  let skippedCount = 0;

  for (const field of params.fields ?? []) {
    const entry = evaluateFillField(field);
    results.push(entry);
    if (entry.skipped) {
      skippedCount += 1;
    } else {
      setCount += 1;
    }
  }

  return {
    fields: results,
    summary: { set: setCount, skipped: skippedCount },
  };
}

function evaluateFillField(field: FillFormField): FillFormFieldResult {
  let el: Element | null = null;
  try {
    el = document.querySelector(field.selector);
  } catch {
    // Invalid selector syntax — treat as not_found (no silent success).
    return { selector: field.selector, set: false, skipped: true, reason: 'not_found' };
  }

  if (!el) {
    return { selector: field.selector, set: false, skipped: true, reason: 'not_found' };
  }

  // TOCTOU guard — re-read label at execution, fail if it drifted from the
  // one the safety layer approved (R22).
  if (field.elementLabel && field.elementLabel.length > 0) {
    const actualLabel = resolveElementLabel(el);
    if (!labelsMatch(field.elementLabel, actualLabel)) {
      return {
        selector: field.selector,
        set: false,
        skipped: true,
        reason: 'label_mismatch',
        expected: field.elementLabel,
        got: actualLabel,
      };
    }
  }

  if (isSensitiveField(el) && field.includeSensitive !== true) {
    return {
      selector: field.selector,
      set: false,
      skipped: true,
      reason: 'sensitive_denied_by_default',
    };
  }

  if (!isValueCarryingElement(el)) {
    // contenteditable / canvas / custom element — unsupported for fill_form.
    return {
      selector: field.selector,
      set: false,
      skipped: true,
      reason: 'not_fillable',
    };
  }

  setValueReactCompatibly(el, field.value);
  return { selector: field.selector, set: true };
}

export function click(
  _ctx: ExecutionContext,
  params: ClickParams,
): ClickResult | BadRequestError {
  let el: Element | null = null;
  try {
    el = document.querySelector(params.selector);
  } catch {
    return { ok: false, code: 'BAD_REQUEST', reason: 'not_found' };
  }

  if (!el) {
    return { ok: false, code: 'BAD_REQUEST', reason: 'not_found' };
  }

  const expected = params.elementLabel ?? '';
  if (expected.length > 0) {
    const actual = resolveElementLabel(el);
    if (!labelsMatch(expected, actual)) {
      return {
        ok: false,
        code: 'BAD_REQUEST',
        reason: 'label_mismatch',
        expected,
        got: actual,
      };
    }
  }

  (el as HTMLElement).click();
  return { ok: true };
}

export async function scroll(
  _ctx: ExecutionContext,
  params: ScrollParams,
): Promise<ScrollResult> {
  const target = Number.isFinite(params.y) ? Math.round(params.y) : 0;
  window.scrollTo({ top: target, behavior: 'smooth' });
  // Give smooth-scroll a tick to settle before sampling the landing position.
  await new Promise<void>((r) => setTimeout(r, 50));
  return { y: window.scrollY };
}

// ---------------------------------------------------------------------------
// Handler registry (consumed by contentScript.ts)
// ---------------------------------------------------------------------------

export type CapabilityName =
  | 'read_page'
  | 'get_selection'
  | 'get_current_tab_url'
  | 'fill_form'
  | 'click'
  | 'scroll';

export const capabilityHandlers = {
  read_page,
  get_selection,
  get_current_tab_url,
  fill_form,
  click,
  scroll,
} as const;
