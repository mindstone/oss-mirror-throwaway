/**
 * Shared accept/reject corpus for the canonical identity validation rules.
 *
 * This corpus is the parity contract between the app (this repo's
 * `userIdentityValidation.ts`) and the rebel-platform `POST /api/oss/lead`
 * endpoint. These DATA literals are byte-identical to the backend's
 * `oss-lead-validation-corpus.ts` (same names + values), so a divergence in
 * either repo's rules trips a test. Keep the two copies identical when editing.
 */

export const FIRST_NAME_ACCEPT = ["Al", "Alex", "Bob-Smith", "Zoe"] as const;
export const FIRST_NAME_REJECT = ["A", "x".repeat(31), "1Bob", "user", "USER", "n/a", "N/A", "none", "null"] as const;
export const EMAIL_ACCEPT = ["[external-email]", "[external-email]"] as const;
export const EMAIL_REJECT = ["no-at", "a@b", "a@b.c", "@b.com", ""] as const;

/**
 * Expected normalised (lowercased) value for each accepted email, keyed by the
 * raw input. The validator normalises to lowercase; the backend stores
 * lowercased. Derived from EMAIL_ACCEPT to keep the data single-sourced.
 */
export const EMAIL_NORMALIZED: Readonly<Record<(typeof EMAIL_ACCEPT)[number], string>> = {
  '[external-email]': '[external-email]',
  '[external-email]': 'jane.doe+x@example.com',
};
