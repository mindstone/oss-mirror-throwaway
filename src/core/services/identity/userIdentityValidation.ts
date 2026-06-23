/**
 * Shared, platform-agnostic validation for user-supplied identity (first name +
 * email). Electron-free so it runs in the renderer, the Electron main process,
 * and any other surface.
 *
 * These rules are the CANONICAL copy, lifted char-for-char from the inbox
 * bridge's identity guard (`src/core/services/inbox/inboxBridgeStateMachine.ts`,
 * the strict 2–30 / starts-with-letter / placeholder-reject set). The bridge,
 * the MCP `rebel-settings` server, and the use-case generator each carry their
 * own copy today; consolidating them onto this module is deliberately DEFERRED
 * (PLAN Stage 2b — see docs/plans/260623_oss-identity-ask-lead-capture/PLAN.md).
 * Do NOT change these rules without updating the shared corpus in
 * `__tests__/identityValidationCorpus.ts` (mirrored on rebel-platform to lock
 * client/server parity).
 */

export type ValidationResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/** Lowercased placeholder names rejected as non-identifying. */
const PLACEHOLDER_NAMES = ['null', 'undefined', 'unknown', 'user', 'name', 'n/a', 'none'];

/** Canonical email shape (matches the bridge's regex exactly). */
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/**
 * Validate a first name. Trims, then enforces 2–30 chars, a leading ASCII
 * letter, and rejects known placeholder values. Returns the trimmed value on
 * success.
 */
export function validateFirstName(value: string): ValidationResult {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 30) {
    return { ok: false, error: 'firstName must be 2-30 characters.' };
  }
  if (!/^[A-Za-z]/.test(trimmed)) {
    return { ok: false, error: 'firstName must start with a letter.' };
  }
  if (PLACEHOLDER_NAMES.includes(trimmed.toLowerCase())) {
    return { ok: false, error: 'firstName appears to be a placeholder value.' };
  }
  return { ok: true, value: trimmed };
}

/**
 * Validate an email. Trims + lowercases, then checks the canonical regex.
 * Returns the normalised (trimmed, lowercased) value on success.
 */
export function validateEmail(value: string): ValidationResult {
  const normalized = value.trim().toLowerCase();
  if (!EMAIL_REGEX.test(normalized)) {
    return { ok: false, error: 'email is not a valid email address.' };
  }
  return { ok: true, value: normalized };
}
