/**
 * Live-API test helper: source the user's ChatGPT Pro (Codex) OAuth credentials
 * for a real round-trip, WITHOUT mutating the user's real token store.
 *
 * TEST-ONLY. Codex tokens are `safeStorage`-encrypted on disk and can only be
 * decrypted by Electron, so we spawn the sanctioned one-shot helper
 * `scripts/eval/export-codex-tokens.cjs` (the same path the eval harness uses)
 * and build an in-memory {@link CodexModeConfig} from the decrypted tokens.
 *
 * Deliberate differences from the eval's `createEvalCodexAuthProvider`:
 *  - We do NOT call `saveCodexTokens(...)`. The eval seeds a *sandbox* token
 *    store (it runs under a temp `REBEL_USER_DATA`); a vitest live run has no
 *    such sandbox, so seeding would write to the user's REAL store. This helper
 *    is strictly read-only against the desktop credential.
 *  - `forceRefreshToken()` returns null (no refresh, no write-back). On a 401 the
 *    client surfaces an auth error — exactly the "reconnect needed" signal we
 *    want a live test to expose, rather than silently mutating stored tokens.
 *
 * Secret hygiene: the decrypted access token lives only inside the returned
 * config's closures. This module never logs it (only the account email + expiry).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CODEX_ENDPOINT_URL } from '@core/codexAuth';
import type { CodexModeConfig } from '@core/rebelCore/codexModeTypes';

const CODEX_STORE_FILE = 'codex-oauth-tokens.json';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Mirror of `getRebelUserDataDir()` in `scripts/eval/export-codex-tokens.cjs`. */
function rebelUserDataDir(): string {
  const appName = 'mindstone-rebel';
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, appName);
  }
  const configDir = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(configDir, appName);
}

function codexTokenFilePath(): string {
  return path.join(rebelUserDataDir(), CODEX_STORE_FILE);
}

/**
 * Cheap, synchronous availability probe for the live-API harness `credentialProbe`.
 * Checks ONLY that the encrypted token file exists — no decryption, no secrets.
 * Absent file => the cell SKIPS (no ChatGPT Pro login on this machine / in CI).
 */
export function codexTokenFileProbe(): { available: boolean; diagnostic: string } {
  const tokenPath = codexTokenFilePath();
  if (fs.existsSync(tokenPath)) {
    return { available: true, diagnostic: 'codex-oauth-tokens.json present' };
  }
  return {
    available: false,
    diagnostic:
      `no Codex token file at ${tokenPath} — sign in with ChatGPT Pro in the ` +
      'Rebel desktop app to run this cell.',
  };
}

export interface LiveCodexAuth {
  codexMode: CodexModeConfig;
  accountId: string;
  accountEmail?: string;
  /** Epoch ms the access token expires. */
  expiresAt: number;
  /** True if the token is already past `expiresAt` (the live call will 401). */
  expired: boolean;
}

interface DecryptedCodexTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
  accountEmail?: string;
}

/**
 * Decrypt the desktop Codex tokens via the Electron helper and build a read-only
 * {@link CodexModeConfig}. Throws (fail-loud) if Electron/the helper is missing
 * or decryption fails — by the time this runs the cell has already confirmed the
 * token file exists and the tier is opted-in, so a failure here is a real,
 * surfaceable problem, not an environmental skip.
 *
 * @param now epoch-ms clock (injectable for tests; defaults to Date.now()).
 */
export function loadLiveCodexAuth(now: number = Date.now()): LiveCodexAuth {
  // Resolve the Electron binary from the npm package's `path.txt` (same trick the
  // eval bootstrap uses — `require('electron')` may be stubbed in test envs).
  const electronPkgDir = path.join(REPO_ROOT, 'node_modules', 'electron');
  const electronPathFile = path.join(electronPkgDir, 'path.txt');
  if (!fs.existsSync(electronPathFile)) {
    throw new Error(`[codexLiveAuth] ${electronPathFile} not found. Run \`npm ci\` to install Electron.`);
  }
  const electronBinary = path.join(electronPkgDir, 'dist', fs.readFileSync(electronPathFile, 'utf-8').trim());
  if (!fs.existsSync(electronBinary)) {
    throw new Error(`[codexLiveAuth] Electron binary not found at ${electronBinary}.`);
  }
  const helperPath = path.join(REPO_ROOT, 'scripts', 'eval', 'export-codex-tokens.cjs');
  if (!fs.existsSync(helperPath)) {
    throw new Error(`[codexLiveAuth] decrypt helper not found at ${helperPath}.`);
  }

  // Run as real Electron (need safeStorage), not Node. Pass a string-only env.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') childEnv[k] = v;
  }
  delete childEnv.ELECTRON_RUN_AS_NODE;

  let stdout: Buffer;
  try {
    stdout = execFileSync(electronBinary, [helperPath], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      '[codexLiveAuth] Electron helper failed to decrypt Codex tokens. Make sure you are ' +
        'signed in with ChatGPT Pro in the Rebel desktop app. Underlying error: ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  const decrypted = stdout.toString('utf-8').trim();
  if (!decrypted) {
    throw new Error('[codexLiveAuth] Electron helper returned empty stdout.');
  }

  let tokens: DecryptedCodexTokens;
  try {
    tokens = JSON.parse(decrypted) as DecryptedCodexTokens;
  } catch (error) {
    throw new Error(
      `[codexLiveAuth] helper stdout was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !tokens.accessToken ||
    !tokens.refreshToken ||
    typeof tokens.expiresAt !== 'number' ||
    !tokens.accountId
  ) {
    throw new Error('[codexLiveAuth] decrypted tokens have an unexpected shape.');
  }

  const expired = tokens.expiresAt <= now;

  // Read-only config. getAccessToken returns the token regardless of expiry so
  // the live endpoint is the source of truth (an expired token surfaces as a 401
  // → ModelError('auth'), the genuine "reconnect needed" outcome). No refresh,
  // no write-back to the real store.
  const codexMode: CodexModeConfig = {
    endpointUrl: CODEX_ENDPOINT_URL,
    isConnected: () => true,
    getAccessToken: async () => tokens.accessToken,
    getAccountId: () => tokens.accountId,
    forceRefreshToken: async () => null,
  };

  return {
    codexMode,
    accountId: tokens.accountId,
    accountEmail: tokens.accountEmail,
    expiresAt: tokens.expiresAt,
    expired,
  };
}
