/**
 * Allowed extension IDs for the Rebel App Bridge's Origin check.
 *
 * The bridge refuses any WS upgrade, /intent/*, or /pair/* request whose
 * Origin isn't one of these IDs (see `originGuard.ts`). Keep in sync with:
 *
 *   1. `packages/browser-extension/manifest.json` — the production key
 *      used by Chrome / Edge to compute the extension ID.
 *   2. The Chrome Web Store listing + Edge Add-ons listing — Chrome
 *      assigns the store-published extension a stable 32-char ID derived
 *      from the uploaded `.crx` key. Edge uses a distinct ID even though
 *      the underlying package is the same.
 *
 * Environment override:
 *
 *   - `REBEL_APP_BRIDGE_EXTRA_EXTENSION_IDS` (comma-separated 32-char
 *     `[a-p]{32}` strings) appends additional IDs at startup. Internal
 *     builds and beta extensions can use this without needing to patch
 *     the source. Ignored silently in prod builds if unset.
 *
 * Why a const tuple + env override rather than a JSON file?
 *
 *   - The prod allowlist is a hard-coded contract — compiled into the
 *     binary so no runtime surface (env, disk, network) can widen it
 *     without a deploy.
 *   - The env override exists specifically for dev/beta loops where the
 *     extension ID is not yet known. `REBEL_APP_BRIDGE_DEV=1` in
 *     combination with `dev-extension-ids.json` handles unpacked-extension
 *     cases (see `originGuard.ts`).
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (D12)
 * @see src/core/appBridge/server/originGuard.ts
 */

/**
 * Production extension IDs — one per Chromium store listing.
 *
 * TODO(app-bridge): replace the placeholder with the real Chrome Web Store
 * + Edge Add-ons extension IDs once the listings are published. The
 * placeholder is `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` — deliberately a
 * known-invalid string so side-loaded unpacked extensions can't
 * accidentally match it. Real IDs are 32 chars in `[a-p]`.
 */
export const PRODUCTION_EXTENSION_IDS: readonly string[] = [
  // TODO(app-bridge): replace with real Chrome Web Store extension ID once published.
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  // TODO(app-bridge): replace with real Edge Add-ons extension ID once published.
  // (Edge IDs are still `[a-p]{32}` but distinct from Chrome's.)
] as const;

const EXTRA_IDS_ENV = 'REBEL_APP_BRIDGE_EXTRA_EXTENSION_IDS';

/** Matches the 32-character `[a-p]` shape that Chromium uses. */
const EXTENSION_ID_RE = /^[a-p]{32}$/;

/**
 * Read the `REBEL_APP_BRIDGE_EXTRA_EXTENSION_IDS` env var into a validated
 * list of extension IDs. Entries that don't match `[a-p]{32}` are dropped
 * silently (we never want a malformed env var to crash startup).
 */
export function readExtraExtensionIdsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const raw = env[EXTRA_IDS_ENV];
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => EXTENSION_ID_RE.test(id));
}

/**
 * Resolve the final production allowlist: placeholder/production IDs
 * unioned with any extras from env, de-duplicated.
 */
export function resolveAllowedExtensionIds(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const extras = readExtraExtensionIdsFromEnv(env);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...PRODUCTION_EXTENSION_IDS, ...extras]) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
