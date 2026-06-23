/**
 * Browser App Bridge tool safety helpers (Stage 6b).
 *
 * The `rebel_browser_fill_form` and `rebel_browser_click` tools carry
 * value-level risk the generic safety layer can't detect from tool name
 * alone:
 *
 *   - `fill_form` may receive password / OTP / payment / file-upload / hidden
 *     field values. Those must be denied by default (R10 / D15) and never
 *     appear in the LLM's evaluation prompt verbatim.
 *
 *   - `click` may target destructive elements ("Delete account", "Pay now",
 *     "Cancel subscription"). The `elementLabel` is scanned so the safety
 *     prompt sees a clear "destructive" signal and requires explicit approval.
 *
 * This module is the single source of truth for the heuristics. It's imported
 * both by `toolSafetyService.ts` (for the value-aware LLM eval path) and by
 * the approval UI (so the per-field rendering matches the server-side call).
 *
 * The content script in the browser extension runs the same heuristic as
 * defence-in-depth — if the safety layer ever misses something, the content
 * script still refuses to set a password field without `includeSensitive: true`.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 6b)
 */

export const BROWSER_FILL_FORM_TOOL = 'rebel_browser_fill_form';
export const BROWSER_CLICK_TOOL = 'rebel_browser_click';

const MASKED_PLACEHOLDER = '***';

/**
 * NFKC-normalise + lowercase. Defence-in-depth for B3: an attacker
 * could slip homoglyph-based labels past the destructive-click filter
 * or the sensitive-field heuristic by using fullwidth characters
 * (`ｄｅｌｅｔｅ`), ligatures (`ﬁle`), or decomposed codepoints. NFKC
 * folds those to ASCII equivalents.
 */
function nfkcLower(input: string): string {
  if (typeof input !== 'string') return '';
  // String.prototype.normalize is ES2015+; present everywhere we target.
  try {
    return input.normalize('NFKC').toLowerCase();
  } catch {
    return input.toLowerCase();
  }
}

/**
 * Heuristic: does a field look sensitive based on its selector + hints from
 * the agent's payload? Mirrors the content-script check in
 * `packages/browser-extension/src/content/capabilityHandlers.ts`.
 *
 * Post-review B2 — the list was widened to cover credit-card synonyms
 * (`card`, `pan`, `cvc`, `csc`), identity (`social-security`, `tax-id`,
 * `dob`, `date-of-birth`), banking (`iban`, `swift`, `routing`, `account-number`),
 * and crypto (`seed-phrase`, `mnemonic`, `private-key`). We'd rather
 * over-match and force an extra approval than leak a secret.
 *
 * Matches on:
 *   - `type` / `selector` / `elementLabel` containing any of the sensitive
 *     keywords. NFKC normalisation runs first so fullwidth or ligature
 *     variants still match.
 *   - explicit `type=password|otp|hidden|file` attributes in the selector.
 */
const SENSITIVE_PATTERN =
  /password|passcode|passwd|pin\b|otp|totp|2fa|mfa|one[-_]?time[-_]?code|verification[-_]?code|cvv|cvc|csc|cc[-_]?(?:number|num|code|csc|cvv|cvc)|card[-_]?(?:number|num)|\bcard\b|\bpan\b|ssn|social[-_]?security|secret|tax[-_]?id|\btin\b|\bdob\b|date[-_]?of[-_]?birth|iban|swift|bic|routing|account[-_]?number|routing[-_]?number|sort[-_]?code|seed[-_]?phrase|mnemonic|private[-_]?key|api[-_]?key|token|bearer|api[-_]?secret|type=(?:"|')?(?:password|hidden|file)(?:"|')?/i;

const SENSITIVE_AUTOCOMPLETE_PATTERN =
  /autocomplete=(?:"|')?(?:current-password|new-password|one-time-code|cc-number|cc-exp|cc-exp-month|cc-exp-year|cc-csc|cc-name|cc-type|bday|bday-day|bday-month|bday-year)(?:"|')?/i;

/**
 * Value-level heuristics (post-review B2). When the field's name/label
 * doesn't match but the VALUE looks like a sensitive identifier, we
 * still mask it. Cheap defence-in-depth against misnamed fields.
 *
 *   - Credit card: 13–19 digits with optional spaces/dashes, passing a
 *     Luhn check.
 *   - US SSN: `NNN-NN-NNNN` (dashes required) — not a universal format
 *     but high-confidence when it does match.
 *   - OTP: 4–8 consecutive digits OR 6-digit alphanumerics commonly used
 *     by TOTP apps. We cap the length so long account numbers don't
 *     match accidentally.
 */
const CREDIT_CARD_DIGITS_RE = /^[0-9\s-]{13,23}$/;
const SSN_RE = /^\d{3}-\d{2}-\d{4}$/;
const OTP_RE = /^\d{4,8}$/;

function luhnPasses(digits: string): boolean {
  // Standard Luhn (mod-10) check. Treat non-digit input as "not a card".
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const ch = digits.charCodeAt(i) - 48;
    if (ch < 0 || ch > 9) return false;
    let val = ch;
    if (alt) {
      val *= 2;
      if (val > 9) val -= 9;
    }
    sum += val;
    alt = !alt;
  }
  return sum > 0 && sum % 10 === 0;
}

export function valueLooksSensitive(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (SSN_RE.test(trimmed)) return true;
  if (CREDIT_CARD_DIGITS_RE.test(trimmed)) {
    const digitsOnly = trimmed.replace(/[\s-]/g, '');
    if (digitsOnly.length >= 13 && digitsOnly.length <= 19 && luhnPasses(digitsOnly)) {
      return true;
    }
  }
  if (OTP_RE.test(trimmed)) return true;
  return false;
}

export interface BrowserFillField {
  selector: string;
  value: string;
  includeSensitive?: boolean;
  elementLabel?: string;
}

export interface SanitizedFillField {
  selector: string;
  /** Masked value for safety-evaluator + approval-card display. */
  valuePreview: string;
  /** Present if heuristic thinks this is a sensitive field. */
  sensitive: boolean;
  /** Agent's explicit opt-in signal — still requires user approval per D15. */
  includeSensitive: boolean;
  /** Label echoed back unchanged — used for per-field UI rendering. */
  elementLabel?: string;
}

/**
 * Return true if the field matches the sensitive heuristic. We intentionally
 * over-match rather than under-match here — the cost of a false positive is
 * one extra user approval; the cost of a false negative is a leaked secret.
 *
 * Post-review B2: additionally inspects the VALUE — a raw credit-card /
 * SSN / OTP pattern flips the field to sensitive even if its selector
 * and label look benign.
 */
export function isSensitiveBrowserField(field: BrowserFillField): boolean {
  // B3: NFKC-normalise before pattern matching so ﬁle (U+FB01) and
  // fullwidth `ｄｅｌｅｔｅ` are treated the same as ASCII.
  const haystack = nfkcLower(
    [field.selector ?? '', field.elementLabel ?? ''].join(' '),
  );
  if (SENSITIVE_PATTERN.test(haystack)) return true;
  if (SENSITIVE_AUTOCOMPLETE_PATTERN.test(haystack)) return true;
  if (valueLooksSensitive(field.value)) return true;
  return false;
}

/**
 * Produce a sanitized copy of the fill_form field list where sensitive values
 * are masked to `***`. Non-sensitive values are passed through untouched so
 * the LLM can still reason about their content (a plain-text "Acme Corp" in a
 * company-name field is fine to show; a hex CVV is not).
 */
export function sanitizeFillFormFields(
  fields: readonly BrowserFillField[] | undefined,
): SanitizedFillField[] {
  if (!Array.isArray(fields)) return [];
  return fields.map((raw): SanitizedFillField => {
    const sensitive = isSensitiveBrowserField(raw);
    const valuePreview = sensitive ? MASKED_PLACEHOLDER : (raw.value ?? '');
    const result: SanitizedFillField = {
      selector: raw.selector ?? '',
      valuePreview,
      sensitive,
      includeSensitive: raw.includeSensitive === true,
    };
    if (raw.elementLabel) {
      result.elementLabel = raw.elementLabel;
    }
    return result;
  });
}

/**
 * Build the redacted ActionContext toolInput for the LLM safety prompt.
 * Preserves the shape but replaces `fields[].value` with the masked preview
 * and adds a `sensitiveFieldCount` counter so the LLM's decision can hinge on
 * a simple integer rather than string matching.
 */
export function sanitizeFillFormToolInputForLlm(
  toolInput: Record<string, unknown>,
): Record<string, unknown> {
  const raw = toolInput?.fields as BrowserFillField[] | undefined;
  const sanitized = sanitizeFillFormFields(raw);
  const sensitiveCount = sanitized.filter((f) => f.sensitive).length;

  // Copy top-level keys (tabContext, etc.) but drop `fields` — replace with
  // the sanitized + annotated shape.
  const { fields: _fields, ...rest } = toolInput ?? {};
  return {
    ...rest,
    fields: sanitized.map((f) => ({
      selector: f.selector,
      value: f.valuePreview,
      sensitive: f.sensitive,
      includeSensitive: f.includeSensitive,
      ...(f.elementLabel ? { elementLabel: f.elementLabel } : {}),
    })),
    sensitiveFieldCount: sensitiveCount,
    // Surface the safety contract to the LLM explicitly so the prompt
    // doesn't need to re-derive it from the tool name.
    safetyPolicy:
      'Sensitive fields (password / OTP / payment / hidden / file-upload) are denied by default. Set includeSensitive: true per field AND the user must approve each sensitive field individually.',
  };
}

// ---------------------------------------------------------------------------
// Destructive click-label heuristic (R22)
// ---------------------------------------------------------------------------

const DESTRUCTIVE_LABEL_PATTERN =
  /\b(?:delete|delete\s+account|permanently\s+delete|remove|uninstall|unsubscribe|cancel\s+subscription|confirm\s+purchase|pay\s+now|pay|submit\s+payment|buy\s+now|place\s+order|checkout|terminate|revoke|wipe|drop|erase|reset)\b/i;

/**
 * Return true if the provided elementLabel contains a destructive phrase that
 * should require explicit user approval regardless of the LLM's opinion.
 *
 * Post-review B3: the label is NFKC-normalised before pattern matching so
 * fullwidth / ligature variants (`Ｄｅｌｅｔｅ`, `ﬁle`) and combining-mark
 * decompositions don't slip past. We keep returning `false` for empty input
 * because a missing label can't be confidently classified as destructive.
 */
export function isDestructiveClickLabel(label: string | undefined): boolean {
  if (!label || typeof label !== 'string') return false;
  return DESTRUCTIVE_LABEL_PATTERN.test(nfkcLower(label));
}

/**
 * Case-insensitive, NFKC-normalised label match. Post-review B3: mirrors
 * the content-script version so server-side safety decisions and
 * client-side "label mismatch?" checks stay in lock-step even against
 * Unicode-folded inputs.
 */
export function labelsMatch(expected: string, actual: string): boolean {
  if (typeof expected !== 'string' || typeof actual !== 'string') return true;
  const a = nfkcLower(expected).trim();
  const b = nfkcLower(actual).trim();
  if (!a || !b) return true;
  return a === b;
}

/**
 * Augment the ActionContext toolInput for `rebel_browser_click` with a
 * boolean `destructiveLabel` signal. Preserves the original shape so the
 * downstream approval card still has selector + label for rendering.
 */
export function annotateClickToolInputForLlm(
  toolInput: Record<string, unknown>,
): Record<string, unknown> {
  const label =
    typeof toolInput?.elementLabel === 'string'
      ? (toolInput.elementLabel as string)
      : '';
  return {
    ...toolInput,
    destructiveLabel: isDestructiveClickLabel(label),
    safetyPolicy:
      'Destructive labels (delete, pay, cancel subscription, uninstall, remove, unsubscribe, confirm purchase, permanently delete) always require explicit user approval.',
  };
}

/**
 * Central pre-processor for browser tool inputs entering the safety evaluator.
 * Returns an unchanged copy for any tool this module doesn't know about.
 */
export function preprocessBrowserToolInputForLlm(
  toolName: string,
  toolInput: unknown,
): Record<string, unknown> {
  const safeInput = (toolInput && typeof toolInput === 'object')
    ? (toolInput as Record<string, unknown>)
    : {};
  if (toolName === BROWSER_FILL_FORM_TOOL) {
    return sanitizeFillFormToolInputForLlm(safeInput);
  }
  if (toolName === BROWSER_CLICK_TOOL) {
    return annotateClickToolInputForLlm(safeInput);
  }
  return safeInput;
}
