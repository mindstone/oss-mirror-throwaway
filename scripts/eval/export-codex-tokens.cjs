/**
 * Codex Token Export Helper (eval-only)
 *
 * One-shot Electron script that decrypts the user's stored Codex OAuth tokens
 * via Electron's `safeStorage` and prints the decrypted JSON to stdout. Used
 * by the eval harness when running with `--use-codex` so the headless eval
 * process — which can't access `safeStorage` — can authenticate to ChatGPT
 * Pro using the user's existing desktop login.
 *
 * Run via:
 *   <repo>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
 *     <repo>/scripts/eval/export-codex-tokens.cjs
 *
 * Environment:
 *   ELECTRON_RUN_AS_NODE — must NOT be set (we need real Electron, not Node).
 *
 * Output:
 *   stdout: decrypted Codex tokens JSON (single line, no trailing newline)
 *   stderr: human-readable error messages on failure
 *   exit code: 0 on success, 1 on any error
 *
 * Security:
 *   The decrypted tokens are written to stdout. The eval harness captures
 *   stdout in-memory and never logs it. Do not run this helper outside the
 *   eval harness, and do not redirect stdout to a file you intend to keep.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const CODEX_STORE_FILE = 'codex-oauth-tokens.json';
const CODEX_STORE_KEY = 'encryptedTokens';

// When this script is launched by the Electron binary directly (not the
// Rebel app), `app.getPath('userData')` resolves to "Electron" (Electron's
// fallback app name). Force the Rebel userData directory so we read the
// real token file. Mirrors getRebelSettingsPath() in evals/shared.ts.
function getRebelUserDataDir() {
  const appName = 'mindstone-rebel';
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, appName);
  }
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configDir, appName);
}

// Set BEFORE app.whenReady() so safeStorage initializes against the right
// keychain identity. On macOS, safeStorage uses the app's bundle id /
// signing identity for keychain lookups, but the encrypted blob format is
// compatible across the same login session — we still need the correct
// userData path for the file lookup.
app.setName('mindstone-rebel');
app.setPath('userData', getRebelUserDataDir());

function fail(message) {
  process.stderr.write(`[export-codex-tokens] ${message}\n`);
  if (app && typeof app.exit === 'function') {
    app.exit(1);
  } else {
    process.exit(1);
  }
}

async function run() {
  try {
    // Hide Dock icon during the brief Electron run.
    if (app.dock && typeof app.dock.hide === 'function') {
      app.dock.hide();
    }

    if (!safeStorage.isEncryptionAvailable()) {
      fail('safeStorage is not available — cannot decrypt Codex tokens.');
      return;
    }

    // app.getPath('userData') resolves to the per-app appdata directory using
    // the name from the nearest package.json — for this repo, 'mindstone-rebel'.
    const userDataDir = app.getPath('userData');
    const tokenPath = path.join(userDataDir, CODEX_STORE_FILE);

    if (!fs.existsSync(tokenPath)) {
      fail(
        `Codex token file not found at ${tokenPath}. ` +
          'Sign in with ChatGPT Pro in the Rebel app first.',
      );
      return;
    }

    let raw;
    try {
      raw = fs.readFileSync(tokenPath, 'utf-8');
    } catch (error) {
      fail(`Could not read ${tokenPath}: ${error && error.message ? error.message : error}`);
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      fail(`Codex token file is not valid JSON: ${error && error.message ? error.message : error}`);
      return;
    }

    const encryptedB64 = parsed && parsed[CODEX_STORE_KEY];
    if (typeof encryptedB64 !== 'string' || encryptedB64.length === 0) {
      fail(`Codex token file is missing "${CODEX_STORE_KEY}". Try signing in again.`);
      return;
    }

    let decrypted;
    try {
      const buffer = Buffer.from(encryptedB64, 'base64');
      decrypted = safeStorage.decryptString(buffer);
    } catch (error) {
      fail(
        'safeStorage.decryptString failed. The tokens were encrypted with a different ' +
          'OS keychain entry (different user, different machine, or the keychain entry was ' +
          `removed). Sign in again in the Rebel app. Underlying error: ${error && error.message ? error.message : error}`,
      );
      return;
    }

    // Sanity-check the decrypted shape so we fail loudly on garbage rather
    // than letting the eval harness blow up later with a confusing error.
    let parsedTokens;
    try {
      parsedTokens = JSON.parse(decrypted);
    } catch (error) {
      fail(`Decrypted Codex tokens are not valid JSON: ${error && error.message ? error.message : error}`);
      return;
    }
    if (
      !parsedTokens ||
      typeof parsedTokens.accessToken !== 'string' ||
      typeof parsedTokens.refreshToken !== 'string' ||
      typeof parsedTokens.expiresAt !== 'number' ||
      typeof parsedTokens.accountId !== 'string'
    ) {
      fail('Decrypted Codex tokens have an unexpected shape (missing accessToken/refreshToken/expiresAt/accountId).');
      return;
    }

    // Single line, no trailing newline.
    process.stdout.write(decrypted);
    app.exit(0);
  } catch (error) {
    fail(`Unexpected error: ${error && error.stack ? error.stack : error}`);
  }
}

app.whenReady().then(run).catch((error) => {
  fail(`app.whenReady rejected: ${error && error.stack ? error.stack : error}`);
});
