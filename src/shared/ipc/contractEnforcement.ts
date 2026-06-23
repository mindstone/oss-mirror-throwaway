/**
 * SSOT gate for the dev/test contract-parse seams (invoke seam, broadcast
 * sink-seam, cloud-ingress parse).
 *
 * Pure `process.env` logic with no main/electron deps, so it lives in `@shared`
 * and is importable from `@core` and `@main` alike — one gate across all three
 * parse points means the fail-safe-OFF property can't drift between them.
 */

/**
 * Is the contract-parse seam enforced (parse-and-throw) right now?
 *
 * Fail-safe-OFF: true ONLY when
 *   - running under test (`NODE_ENV==='test'`, which vitest sets), OR
 *   - the explicit `REBEL_CONTRACT_ENFORCE` opt-in flag is allowlist-enabling
 *     AND we are running in development (`NODE_ENV === 'development'`).
 *
 * The opt-in flag is parsed via a normalize-then-allowlist: only
 * `'1'`/`'true'` (after `.trim().toLowerCase()`) enable. Every other value —
 * `''`, `' '`, `'0'`, `'0 '`, `'false'`, `'FALSE'`, `'off'`, `'no'`, undefined —
 * is OFF (no-op passthrough). This is the production default and is explicitly
 * asserted by the "ships disabled in prod" test.
 *
 * KILL-BY-CONSTRUCTION — prod enforcement is unrepresentable here. We require a
 * POSITIVE non-prod signal (`NODE_ENV === 'development'` or `=== 'test'`), NOT
 * merely "not production". WHY: packaged Electron leaves `NODE_ENV` UNSET (it is
 * neither `'production'` nor `'development'`), so a "!== 'production'" gate would
 * let `REBEL_CONTRACT_ENFORCE=1` flip enforcement ON in a packaged production
 * build — exactly the prod-enforce backdoor we must close. Enabling contract
 * enforcement in packaged production is the deferred "shape B" (a
 * separately-approved audit + differently-named lever): Zod default-strips
 * unknown keys and `.refine`/`.min` may reject real-world payloads, so an
 * accidental prod-enforce would be a user-visible regression. By requiring an
 * explicit dev/test env, only those two environments can ever enable it; the
 * packaged-prod default (unset NODE_ENV) and explicit production are both OFF by
 * construction, so this flag MUST NOT be reachable as a production-enforce
 * backdoor.
 */
export function isContractEnforcementOn(): boolean {
  if (process.env.NODE_ENV === 'test') {
    return true;
  }
  // The opt-in flag enables ONLY under an explicit development env. Packaged
  // Electron leaves NODE_ENV unset, so we demand a positive 'development' signal
  // (never "!== production") — that keeps the flag unreachable in packaged prod.
  if (process.env.NODE_ENV !== 'development') {
    return false;
  }
  // Normalize then allowlist: only an explicit '1'/'true' opt-in enables.
  const flag = process.env.REBEL_CONTRACT_ENFORCE?.trim().toLowerCase();
  return flag === '1' || flag === 'true';
}
