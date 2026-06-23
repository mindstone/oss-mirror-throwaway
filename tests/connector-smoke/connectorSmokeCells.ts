/**
 * Connector-smoke cell definitions (TEST-ONLY).
 *
 * Each cell describes how to exercise the REAL desktop path for one connector — resolve its
 * stored token/key + commercial OAuth client creds, spawn the published MCP via
 * `npx -y @mindstone/mcp-server-<x>@<pin>` over stdio, and call a STATIC read-only allowlist.
 * The spawn command/version mirror `resources/connector-catalog.json`; the per-instance env
 * (client creds, token/config paths) mirrors what the desktop IPC handlers inject at spawn
 * time (slackHandlers / googleWorkspaceHandlers / microsoftHandlers).
 *
 * SAFETY — credential isolation (the core guarantee):
 *  - NO external/service-side mutation: `readOnlyOps` is the only thing called, every op is
 *    guard-proven `readOnlyHint:true` / not `destructiveHint:true`, fail-closed.
 *  - The user's REAL credential dirs are NEVER used as spawn targets. Each connected cell
 *    COPIES the credential material it needs into a fresh mkdtemp dir and points the spawn
 *    env/config paths at the COPY, then rm -rf's it in teardown (`ConnectorSpawn.cleanup`). So
 *    any OAuth token-refresh rewrite or SSH known_hosts TOFU append lands in the disposable
 *    copy — the real state is untouched.
 *
 * On this machine only Slack + Google have stored creds, so the other 4 cells skip-green
 * until connected (or until their *_SMOKE_* env vars are supplied). That's honest coverage,
 * not a harness gap.
 */
// Side-effect import FIRST: registers the commercial OAuth provider (when the opt-in gate is
// on) before any cell prereq is evaluated at collection time, so the OAuth connector cells'
// client-cred resolution works and they run live instead of skipping. See that module's docs.
import './registerCommercialOAuthProvider';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  googleCredentialSource,
  microsoftCredentialSource,
  resolveMicrosoftClientId,
  resolveOAuthCredentials,
  slackCredentialSource,
} from '@core/services/oauthCredentials';
import type { ConnectorSmokeCell } from '../../src/test-utils/connectorSmokeHarness';
// NOTE: the read-only op set is NOT defined here — the harness resolves it from the SSOT
// (connectorSmokeAllowlist.ts) keyed by `connector`, so a cell can never diverge from what the
// static guard checks. Cells only supply per-op call-arg overrides via `argsFor` (e.g. replit).

// ---------------------------------------------------------------------------
// Shared paths (desktop userData layout on macOS — the operator's machine). These are READ
// ONLY: nothing here is ever passed to a spawned MCP as a writable target — we copy into a
// temp dir first (see makeTempDir / the per-cell copy helpers below).
// ---------------------------------------------------------------------------
const USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'mindstone-rebel');
const SLACK_CONFIG_DIR = path.join(USER_DATA, 'mcp', 'slack');
const GOOGLE_WORKSPACE_DIR = path.join(USER_DATA, 'google-workspace-mcp');
const MICROSOFT_CONFIG_DIR = path.join(USER_DATA, 'microsoft-mcp');
const APP_SETTINGS_PATH = path.join(USER_DATA, 'app-settings.json');
// Remote-OAuth MCP token store (super-mcp), used by the Notion (http) cell.
const SUPER_MCP_TOKENS_DIR = path.join(os.homedir(), '.super-mcp', 'oauth-tokens');
const NOTION_MCP_URL = 'https://mcp.notion.com/mcp';

/**
 * Resolve the ElevenLabs API key the same way the desktop voice feature does: env wins, else
 * the key configured in app-settings at `voice.elevenlabsApiKey`. Returns undefined when neither
 * is present (→ the cell skips-green). This is the account API key shared with the voice
 * feature; `list_voices` is a read-only GET, so a valid key validates fine.
 */
function resolveElevenLabsApiKey(): string | undefined {
  const fromEnv = process.env.ELEVENLABS_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const settings = JSON.parse(fs.readFileSync(APP_SETTINGS_PATH, 'utf8')) as {
      voice?: { elevenlabsApiKey?: unknown };
    };
    const fromSettings = settings.voice?.elevenlabsApiKey;
    if (typeof fromSettings === 'string' && fromSettings.trim().length > 0) {
      return fromSettings.trim();
    }
  } catch {
    // missing/unreadable settings → treat as absent (skip-green)
  }
  return undefined;
}

/**
 * Resolve the Notion remote-MCP bearer access token from the super-mcp OAuth token store.
 * Prefer `Notion-teammember-mindstone-com_tokens.json`; else fall back to any other
 * `Notion-*_tokens.json` with a non-empty `access_token`. Returns only the access_token — the
 * refresh_token is never read out / passed anywhere. Returns undefined → the cell skips-green.
 */
function resolveNotionAccessToken(): string | undefined {
  const readToken = (file: string): string | undefined => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(SUPER_MCP_TOKENS_DIR, file), 'utf8')) as {
        access_token?: unknown;
      };
      const token = typeof parsed.access_token === 'string' ? parsed.access_token.trim() : '';
      return token.length > 0 ? token : undefined;
    } catch {
      return undefined;
    }
  };
  const preferred = readToken('Notion-teammember-mindstone-com_tokens.json');
  if (preferred) return preferred;
  let files: string[];
  try {
    files = fs.readdirSync(SUPER_MCP_TOKENS_DIR);
  } catch {
    return undefined;
  }
  for (const file of files) {
    if (!/^Notion-.*_tokens\.json$/.test(file)) continue;
    const token = readToken(file);
    if (token) return token;
  }
  return undefined;
}

/**
 * Base spawn env for a stdio child. `PATH` is inherited so `npx` resolves, but `HOME` is set to
 * a DISPOSABLE temp dir (not the real home) so any missed/renamed credential-path override falls
 * back to a throwaway location instead of the user's real credential dirs (e.g. Google's
 * `$HOME/.google-workspace-mcp`, Replit's `$HOME/.replit-mcp/known_hosts` + `~/.ssh`). `npm_config_cache`
 * is also routed into the temp home so npx writes nothing under the real `~/.npm`.
 */
function stdioSpawnEnv(tempHome: string): Record<string, string> {
  return {
    HOME: tempHome,
    PATH: process.env.PATH ?? '',
    npm_config_cache: path.join(tempHome, '.npm-cache'),
    LOG_MODE: 'strict',
  };
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Create a fresh disposable temp dir + a cleanup closure that rm -rf's it. The cell's
 * `buildSpawn` returns the cleanup as `ConnectorSpawn.cleanup`, which the harness always
 * invokes in teardown. Mode 0o700 mirrors how the desktop stores credential dirs.
 */
function makeTempDir(tag: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `connector-smoke-${tag}-`));
  fs.chmodSync(dir, 0o700);
  return {
    dir,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Make a disposable temp dir that doubles as the spawn HOME for a stdio child. Returns the temp
 * root (used as HOME) + a cleanup. Credential material is copied UNDER this root by each cell.
 */
function makeTempHome(tag: string): { home: string; cleanup: () => void } {
  const { dir, cleanup } = makeTempDir(tag);
  fs.mkdirSync(path.join(dir, '.npm-cache'), { recursive: true, mode: 0o700 });
  return { home: dir, cleanup };
}

/** The single connected Slack workspace on this machine (see config.json). */
function firstSlackTeamId(): string | undefined {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(SLACK_CONFIG_DIR, 'config.json'), 'utf8')) as {
      workspaces?: Array<{ teamId?: string }>;
    };
    return config.workspaces?.find((w) => typeof w.teamId === 'string')?.teamId;
  } catch {
    return undefined;
  }
}

interface GoogleInstance {
  instanceDir: string;
  accountsPath: string;
  credentialsPath: string;
  /** Furthest-future token expiry (ms epoch) found in this instance's credentials/, or 0. */
  maxExpiryMs: number;
}

/**
 * Parse a token file's expiry as ms-epoch. Google stores `expiry_date` (ms); other connectors
 * use `expiry` (ISO/seconds) or `expires_at` — handle all, normalising seconds→ms heuristically
 * (values below ~1e12 are treated as seconds). Returns 0 when nothing parses.
 */
function tokenExpiryMs(tokenPath: string): number {
  let token: Record<string, unknown>;
  try {
    token = JSON.parse(fs.readFileSync(tokenPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return 0;
  }
  for (const field of ['expiry_date', 'expires_at', 'expiry'] as const) {
    const raw = token[field];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw < 1e12 ? raw * 1000 : raw; // seconds → ms
    }
    if (typeof raw === 'string') {
      const asNum = Number(raw);
      if (Number.isFinite(asNum) && asNum > 0) return asNum < 1e12 ? asNum * 1000 : asNum;
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

/**
 * Pick the Google Workspace instance (GoogleWorkspace-*) whose token has the FURTHEST-FUTURE
 * expiry — i.e. the most recently refreshed / active account. The alphabetically-first instance
 * may be a dormant account whose refresh token was revoked (→ auth_required), so a plain
 * "first" pick produced a false negative. Single-pick heuristic by design. Falls back to the
 * first instance with accounts+token if no expiry parses.
 */
function bestGoogleInstance(): GoogleInstance | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(GOOGLE_WORKSPACE_DIR);
  } catch {
    return undefined;
  }
  const candidates: GoogleInstance[] = [];
  for (const name of entries) {
    if (!name.startsWith('GoogleWorkspace-')) continue;
    const instanceDir = path.join(GOOGLE_WORKSPACE_DIR, name);
    const accountsPath = path.join(instanceDir, 'accounts.json');
    const credentialsPath = path.join(instanceDir, 'credentials');
    if (!fileExists(accountsPath) || !fileExists(credentialsPath)) continue;
    let maxExpiryMs = 0;
    try {
      for (const file of fs.readdirSync(credentialsPath)) {
        if (!file.endsWith('.token.json')) continue;
        maxExpiryMs = Math.max(maxExpiryMs, tokenExpiryMs(path.join(credentialsPath, file)));
      }
    } catch {
      // unreadable credentials dir — treat as expiry 0 (only chosen if nothing else parses)
    }
    candidates.push({ instanceDir, accountsPath, credentialsPath, maxExpiryMs });
  }
  if (candidates.length === 0) return undefined;
  // Max expiry wins; ties / all-zero fall back to the first encountered (stable).
  return candidates.reduce((best, c) => (c.maxExpiryMs > best.maxExpiryMs ? c : best), candidates[0]);
}

/**
 * Does the (single, shared) Microsoft config dir have a CONNECTED account? The dir +
 * accounts.json can exist with `{"accounts": []}` (no account ever connected); in that case
 * the MCP returns "No Microsoft account found" and a spawn would hard-fail, so we treat it as
 * not-connected → skip-green. Require a non-empty `accounts` array.
 */
function microsoftHasConnectedAccount(): boolean {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(MICROSOFT_CONFIG_DIR, 'accounts.json'), 'utf8'),
    ) as { accounts?: unknown };
    return Array.isArray(parsed.accounts) && parsed.accounts.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// slack — OAuth + client secret; bot+user tokens + refresh. (LIVE on this machine.)
// Token refresh rewrites the workspace token JSON → we copy config.json + the workspace token
// into a temp config dir and point SLACK_CONFIG_PATH at the COPY (mirrors live-probe.ts).
// ---------------------------------------------------------------------------
export const slackCell: ConnectorSmokeCell = {
  connector: 'slack',
  authFamily: 'oauth+secret (bot+user tokens, refresh)',
  label: 'connector-smoke: slack (oauth+secret)',
  prereqs: [
    {
      name: 'slack-config',
      ok: () => fileExists(path.join(SLACK_CONFIG_DIR, 'config.json')) && firstSlackTeamId() !== undefined,
      diagnostic: `no connected Slack workspace at ${SLACK_CONFIG_DIR}/config.json`,
    },
    {
      name: 'slack-workspace-token',
      ok: () => {
        const teamId = firstSlackTeamId();
        return teamId !== undefined && fileExists(path.join(SLACK_CONFIG_DIR, 'workspaces', `${teamId}.json`));
      },
      diagnostic: `no stored workspace token file under ${SLACK_CONFIG_DIR}/workspaces/`,
    },
    {
      name: 'slack-oauth-client-creds',
      ok: () => resolveOAuthCredentials(slackCredentialSource) !== null,
      diagnostic: 'Slack OAuth client creds did not resolve (commercial provider not registered / env unset)',
    },
  ],
  clientCredsResolved: () => resolveOAuthCredentials(slackCredentialSource) !== null,
  secretsToScrub: () => {
    const creds = resolveOAuthCredentials(slackCredentialSource);
    const scrub = creds ? [creds.clientId, creds.clientSecret] : [];
    // Defensive: the operator's smoke permalink isn't a secret, but it embeds
    // workspace/channel ids — keep it out of persisted diagnostics.
    const permalink = process.env.SLACK_SMOKE_PERMALINK?.trim();
    if (permalink) scrub.push(permalink);
    return scrub;
  },
  buildSpawn: () => {
    const teamId = firstSlackTeamId();
    if (!teamId) throw new Error('slack teamId disappeared between prereq and spawn');
    const creds = resolveOAuthCredentials(slackCredentialSource);
    if (!creds) throw new Error('slack OAuth creds disappeared between prereq and spawn');

    // Temp HOME (isolates any missed credential-path fallback) + temp config dir UNDER it. Any
    // refresh-time rewrite of the token file lands here, never in the user's real slack dir.
    const { home: tempHome, cleanup } = makeTempHome('slack');
    const tempConfigDir = path.join(tempHome, 'slack-config');
    fs.mkdirSync(tempConfigDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(SLACK_CONFIG_DIR, 'config.json'), path.join(tempConfigDir, 'config.json'));
    const tempWorkspaces = path.join(tempConfigDir, 'workspaces');
    fs.mkdirSync(tempWorkspaces, { recursive: true, mode: 0o700 });
    fs.copyFileSync(
      path.join(SLACK_CONFIG_DIR, 'workspaces', `${teamId}.json`),
      path.join(tempWorkspaces, `${teamId}.json`),
    );
    fs.chmodSync(path.join(tempWorkspaces, `${teamId}.json`), 0o600);

    return {
      command: 'npx',
      args: ['-y', '@mindstone/mcp-server-slack@0.1.6'],
      env: {
        ...stdioSpawnEnv(tempHome),
        SLACK_CONFIG_PATH: tempConfigDir,
        SLACK_TEAM_ID: teamId,
        SLACK_CLIENT_ID: creds.clientId,
        SLACK_CLIENT_SECRET: creds.clientSecret,
        // Never rotate the user's REAL refresh token: an expired token → auth_required → our
        // skip-with-DEGRADED path, instead of a refresh that server-side invalidates the real one.
        SLACK_DISABLE_REFRESH: '1',
      },
      cleanup,
    };
  },
};

// ---------------------------------------------------------------------------
// google — OAuth + client secret; multi-instance store, token refresh. (LIVE.)
// Refresh rewrites the per-account token JSON → we copy accounts.json + credentials/ into a
// temp instance dir and point ACCOUNTS_PATH/CREDENTIALS_PATH at the COPY (mirrors
// copyCredentialInstance in google-workspace/test/live.test.ts).
// ---------------------------------------------------------------------------
export const googleCell: ConnectorSmokeCell = {
  connector: 'google',
  authFamily: 'oauth+secret (multi-instance store)',
  label: 'connector-smoke: google-workspace (oauth+secret)',
  prereqs: [
    {
      name: 'google-instance',
      ok: () => bestGoogleInstance() !== undefined,
      diagnostic: `no connected Google Workspace instance under ${GOOGLE_WORKSPACE_DIR} (GoogleWorkspace-*)`,
    },
    {
      name: 'google-oauth-client-creds',
      ok: () => resolveOAuthCredentials(googleCredentialSource) !== null,
      diagnostic: 'Google OAuth client creds did not resolve (commercial provider not registered / env unset)',
    },
  ],
  clientCredsResolved: () => resolveOAuthCredentials(googleCredentialSource) !== null,
  secretsToScrub: () => {
    const creds = resolveOAuthCredentials(googleCredentialSource);
    return creds ? [creds.clientId, creds.clientSecret] : [];
  },
  buildSpawn: () => {
    const instance = bestGoogleInstance();
    if (!instance) throw new Error('google instance disappeared between prereq and spawn');
    const creds = resolveOAuthCredentials(googleCredentialSource);
    if (!creds) throw new Error('google OAuth creds disappeared between prereq and spawn');

    // Temp HOME (also isolates Google's `$HOME/.google-workspace-mcp` fallback) + copy
    // accounts.json + the whole credentials/ dir into a disposable temp instance dir under it.
    const { home: tempHome, cleanup } = makeTempHome('google');
    const tempInstanceDir = path.join(tempHome, 'gws-instance');
    fs.mkdirSync(tempInstanceDir, { recursive: true, mode: 0o700 });
    const tempAccountsPath = path.join(tempInstanceDir, 'accounts.json');
    const tempCredentialsPath = path.join(tempInstanceDir, 'credentials');
    fs.copyFileSync(instance.accountsPath, tempAccountsPath);
    fs.cpSync(instance.credentialsPath, tempCredentialsPath, { recursive: true });
    fs.chmodSync(tempCredentialsPath, 0o700);

    return {
      command: 'npx',
      args: ['-y', '@mindstone/mcp-server-google-workspace@0.1.3'],
      env: {
        ...stdioSpawnEnv(tempHome),
        GOOGLE_CLIENT_ID: creds.clientId,
        GOOGLE_CLIENT_SECRET: creds.clientSecret,
        ACCOUNTS_PATH: tempAccountsPath,
        CREDENTIALS_PATH: tempCredentialsPath,
        ENABLE_GOOGLE_TASKS_FORMS: 'true',
        // Never rotate the user's REAL refresh token: expired → auth_required → skip-with-DEGRADED.
        GOOGLE_WORKSPACE_DISABLE_REFRESH: '1',
      },
      cleanup,
    };
  },
};

// ---------------------------------------------------------------------------
// microsoft (calendar) — OAuth PKCE, clientId-only. (Skip-green: not connected here.)
// Refresh rewrites the token store under the config dir → copy accounts.json + credentials/ +
// tokens.json into a temp config dir and point MS_CONFIG_DIR at the COPY.
// ---------------------------------------------------------------------------
export const microsoftCell: ConnectorSmokeCell = {
  connector: 'microsoft',
  authFamily: 'oauth-pkce (clientId only)',
  label: 'connector-smoke: microsoft-calendar (oauth-pkce)',
  prereqs: [
    {
      name: 'microsoft-account',
      // Microsoft uses a single shared config dir (not per-instance like Google). The dir +
      // accounts.json can exist with an EMPTY accounts array (no account ever connected) — that
      // must skip-green, NOT spawn against an empty account list and hard-fail with "No Microsoft
      // account found". Require a non-empty `accounts` array, mirroring Google's accounts+token rigor.
      ok: () => microsoftHasConnectedAccount(),
      diagnostic: `no connected Microsoft account (empty/absent accounts in ${MICROSOFT_CONFIG_DIR}/accounts.json)`,
    },
    {
      name: 'microsoft-client-id',
      ok: () => resolveMicrosoftClientId(microsoftCredentialSource) !== null,
      diagnostic: 'Microsoft clientId did not resolve (commercial provider not registered / env unset)',
    },
  ],
  clientCredsResolved: () => resolveMicrosoftClientId(microsoftCredentialSource) !== null,
  buildSpawn: () => {
    const clientId = resolveMicrosoftClientId(microsoftCredentialSource);
    if (!clientId) throw new Error('microsoft clientId disappeared between prereq and spawn');

    // Temp HOME + copy the whole config dir into a disposable temp dir under it, so token-refresh
    // rewrites (and any HOME-relative fallback) are isolated.
    const { home: tempHome, cleanup } = makeTempHome('microsoft');
    const tempConfigDir = path.join(tempHome, 'microsoft-mcp');
    fs.cpSync(MICROSOFT_CONFIG_DIR, tempConfigDir, { recursive: true });
    fs.chmodSync(tempConfigDir, 0o700);

    return {
      command: 'npx',
      args: ['-y', '@mindstone/mcp-server-microsoft-calendar@0.1.1'],
      env: {
        ...stdioSpawnEnv(tempHome),
        MS_CLIENT_ID: clientId,
        MS_CONFIG_DIR: tempConfigDir,
        // Never rotate the user's REAL refresh token: expired → auth_required → skip-with-DEGRADED.
        MICROSOFT_DISABLE_REFRESH: '1',
      },
      cleanup,
    };
  },
};

// ---------------------------------------------------------------------------
// elevenlabs — API key (bearer only, no local credential write). (Skip-green unless set.)
// Key source: ELEVENLABS_API_KEY env (wins) → else voice.elevenlabsApiKey in app-settings.json
// (the key shared with the desktop voice feature). Route any config/cache path to a temp dir.
// ---------------------------------------------------------------------------
export const elevenlabsCell: ConnectorSmokeCell = {
  connector: 'elevenlabs',
  authFamily: 'api-key',
  label: 'connector-smoke: elevenlabs (api-key)',
  prereqs: [
    {
      name: 'elevenlabs-api-key',
      ok: () => resolveElevenLabsApiKey() !== undefined,
      diagnostic:
        'ELEVENLABS_API_KEY is not set and voice.elevenlabsApiKey is absent from app-settings.json',
    },
  ],
  secretsToScrub: () => {
    const key = resolveElevenLabsApiKey();
    return key ? [key] : [];
  },
  buildSpawn: () => {
    const apiKey = resolveElevenLabsApiKey();
    if (!apiKey) throw new Error('ElevenLabs API key disappeared between prereq and spawn');
    const { home: tempHome, cleanup } = makeTempHome('elevenlabs');
    return {
      command: 'npx',
      args: ['-y', '@mindstone/mcp-server-elevenlabs@0.3.0'],
      env: {
        ...stdioSpawnEnv(tempHome),
        ELEVENLABS_API_KEY: apiKey,
        MCP_WORKSPACE_PATH: path.join(tempHome, 'workspace'),
      },
      cleanup,
    };
  },
};

// ---------------------------------------------------------------------------
// replit — SSH key. Two real-home write/read hazards: TOFU APPENDS to the user's known_hosts,
// and the connector resolves the private key + ~/.ssh/config from `os.homedir()`. We force a
// temp HOME so the connector reads `<tempHOME>/.ssh` (NOT the real ~/.ssh) — we copy ONLY the
// `rebel-replit` key into it — and route known_hosts into the temp HOME with strict host-key
// checking (no TOFU). So the real ~/.ssh and ~/.replit-mcp/known_hosts are never read or written.
// In strict mode an unknown host fails closed → the host key must be pre-known, else skip-green.
// (Skip-green unless REPLIT_SMOKE_HOST/USER + a known-hosts line + the rebel-replit key are present.)
// ---------------------------------------------------------------------------
const REPLIT_KNOWN_HOSTS_SEED = process.env.REPLIT_SMOKE_KNOWN_HOSTS_LINE?.trim();
const REAL_REPLIT_SSH_KEY = path.join(os.homedir(), '.ssh', 'rebel-replit');
export const replitCell: ConnectorSmokeCell = {
  connector: 'replit',
  authFamily: 'ssh-key',
  label: 'connector-smoke: replit-ssh (ssh-key)',
  prereqs: [
    {
      name: 'replit-ssh-target',
      ok: () =>
        (process.env.REPLIT_SMOKE_HOST?.trim().length ?? 0) > 0 &&
        (process.env.REPLIT_SMOKE_USER?.trim().length ?? 0) > 0,
      diagnostic: 'REPLIT_SMOKE_HOST and/or REPLIT_SMOKE_USER are not set',
    },
    {
      // The private key is copied into the temp HOME's .ssh (default resolution path), so it must
      // exist in the real ~/.ssh. Skip-green if absent (replit not set up on this machine).
      name: 'replit-ssh-key',
      ok: () => fileExists(REAL_REPLIT_SSH_KEY),
      diagnostic: `no Replit SSH key at ${REAL_REPLIT_SSH_KEY} (run replit_setup_ssh in the app first)`,
    },
    {
      // Strict host-key checking is forced (see buildSpawn), so an unknown host fails closed.
      // To run, the host key must be pre-known: supply REPLIT_SMOKE_KNOWN_HOSTS_LINE
      // (e.g. from `ssh-keyscan` → "host SHA256:..."). Without it we skip-green rather than
      // either (a) appending to the user's real known_hosts via TOFU or (b) failing red.
      name: 'replit-known-host',
      ok: () => (REPLIT_KNOWN_HOSTS_SEED?.length ?? 0) > 0,
      diagnostic:
        'REPLIT_SMOKE_KNOWN_HOSTS_LINE is not set; strict host-key checking is forced, so the ' +
        'host key must be pre-known (set it to a "host SHA256:..." line from ssh-keyscan) to avoid ' +
        'trust-on-first-use writing to your real known_hosts.',
    },
  ],
  // replit_check_connection needs host/user as CALL ARGS. argsFor overrides the arguments of the
  // already-allowlisted op (it cannot introduce a new op — the name set comes from the SSOT).
  argsFor: (opName) => {
    const host = process.env.REPLIT_SMOKE_HOST?.trim();
    const user = process.env.REPLIT_SMOKE_USER?.trim();
    if (opName === 'replit_check_connection' && host && user) return { host, user };
    return undefined;
  },
  buildSpawn: () => {
    // Temp HOME so the connector reads <tempHOME>/.ssh (NOT the real ~/.ssh). Copy ONLY the
    // rebel-replit key in (default key path resolution), and route known_hosts into the temp HOME
    // pre-seeded with the operator-supplied, out-of-band-verified host-key line (strict mode, no TOFU).
    const { home: tempHome, cleanup } = makeTempHome('replit');
    const tempSshDir = path.join(tempHome, '.ssh');
    fs.mkdirSync(tempSshDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(REAL_REPLIT_SSH_KEY, path.join(tempSshDir, 'rebel-replit'));
    fs.chmodSync(path.join(tempSshDir, 'rebel-replit'), 0o600);
    const knownHostsPath = path.join(tempHome, 'known_hosts');
    if (REPLIT_KNOWN_HOSTS_SEED) {
      fs.writeFileSync(knownHostsPath, `${REPLIT_KNOWN_HOSTS_SEED}\n`, { mode: 0o600 });
    }
    return {
      command: 'npx',
      args: ['-y', '@mindstone/mcp-server-replit-ssh@0.1.2'],
      env: {
        ...stdioSpawnEnv(tempHome),
        // Fail closed on an unknown host instead of trust-on-first-use (which would append to
        // known_hosts); combined with the pre-seeded temp known_hosts + temp HOME, the user's real
        // ~/.ssh and ~/.replit-mcp/known_hosts are never read or written. See hostVerification.ts.
        MCP_REPLIT_SSH_STRICT_HOST_KEY: '1',
        MCP_REPLIT_SSH_KNOWN_HOSTS_PATH: knownHostsPath,
        MCP_WORKSPACE_PATH: path.join(tempHome, 'workspace'),
      },
      cleanup,
    };
  },
};

// ---------------------------------------------------------------------------
// vanta — OAuth client_credentials (M2M); bearer token minted in-memory, no local credential
// write. (Skip-green unless VANTA_CLIENT_* set.) Route any cache path to a temp dir.
// ---------------------------------------------------------------------------
export const vantaCell: ConnectorSmokeCell = {
  connector: 'vanta',
  authFamily: 'oauth-client-credentials (m2m)',
  label: 'connector-smoke: vanta (oauth-client-credentials)',
  prereqs: [
    {
      name: 'vanta-client-creds',
      ok: () =>
        (process.env.VANTA_CLIENT_ID?.trim().length ?? 0) > 0 &&
        (process.env.VANTA_CLIENT_SECRET?.trim().length ?? 0) > 0,
      diagnostic: 'VANTA_CLIENT_ID and/or VANTA_CLIENT_SECRET are not set',
    },
  ],
  secretsToScrub: () => {
    const id = process.env.VANTA_CLIENT_ID?.trim();
    const secret = process.env.VANTA_CLIENT_SECRET?.trim();
    return [id, secret].filter((v): v is string => typeof v === 'string' && v.length > 0);
  },
  buildSpawn: () => {
    const clientId = process.env.VANTA_CLIENT_ID?.trim();
    const clientSecret = process.env.VANTA_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) throw new Error('VANTA creds disappeared between prereq and spawn');
    const { home: tempHome, cleanup } = makeTempHome('vanta');
    return {
      command: 'npx',
      args: ['-y', '@mindstone/mcp-server-vanta@0.1.0'],
      env: {
        ...stdioSpawnEnv(tempHome),
        VANTA_CLIENT_ID: clientId,
        VANTA_CLIENT_SECRET: clientSecret,
        VANTA_REGION: process.env.VANTA_REGION?.trim() || 'us',
        MCP_WORKSPACE_PATH: path.join(tempHome, 'workspace'),
      },
      cleanup,
    };
  },
};

// ---------------------------------------------------------------------------
// notion — REMOTE OAuth MCP over Streamable-HTTP (https://mcp.notion.com/mcp). Not stdio: we
// connect to the hosted server and pass the bearer access token as an Authorization header. The
// remote path only READS the token file (super-mcp store) and writes NOTHING locally — it spawns
// no process. No temp-copy needed. refresh_token is never read out. (Skip-green when no token.)
// Safety: curated allowlist (REMOTE_READONLY_OPS, guard-enforced) + runtime readOnlyHint check.
// ---------------------------------------------------------------------------
export const notionCell: ConnectorSmokeCell = {
  connector: 'notion',
  authFamily: 'remote-oauth-http',
  label: 'connector-smoke: notion (remote-oauth-http)',
  transport: 'http',
  prereqs: [
    {
      name: 'notion-access-token',
      ok: () => resolveNotionAccessToken() !== undefined,
      diagnostic: `no Notion-*_tokens.json with a non-empty access_token under ${SUPER_MCP_TOKENS_DIR}`,
    },
  ],
  // A resolved token that the server rejects (401) is surfaced as DEGRADED before the skip.
  clientCredsResolved: () => resolveNotionAccessToken() !== undefined,
  secretsToScrub: () => {
    const token = resolveNotionAccessToken();
    return token ? [token] : [];
  },
  buildHttpConnection: () => {
    const token = resolveNotionAccessToken();
    if (!token) throw new Error('notion access token disappeared between prereq and connect');
    return {
      url: NOTION_MCP_URL,
      headers: { Authorization: `Bearer ${token}` },
    };
  },
};

/**
 * The full matrix of live cells. The read-only allowlist + tool source dirs the static guard
 * checks live in the pure, side-effect-free `connectorSmokeAllowlist.ts` (the single source of
 * truth) — the cells above derive their `readOnlyOps` from it so they can't drift.
 */
export const CONNECTOR_SMOKE_CELLS: readonly ConnectorSmokeCell[] = [
  slackCell,
  googleCell,
  microsoftCell,
  elevenlabsCell,
  replitCell,
  vantaCell,
  notionCell,
];
