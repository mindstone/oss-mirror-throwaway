/**
 * Day-2 add-account fixture tests for the Microsoft 365 IPC handlers.
 *
 * These tests pin the current day-2 (multi-account) behaviour of
 * `microsoftHandlers.ts` so a Phase D refactor that changes the flow has to
 * make the change explicit.
 *
 * Observed behaviour (microsoftHandlers.ts:88-110, in-tree at commit
 * documenting Phase B1):
 *   - On `microsoft:start-auth`, the handler resolves the FIRST existing
 *     account (active, falling back to the first array entry) and reads its
 *     stored extra scopes via `getExtraScopesForAccount(existingAccount.email)`.
 *   - If extras exist, the handler passes the first account's email as
 *     `loginHint` (login_hint) to `startMicrosoftAuth`, AND merges those
 *     extras into `additionalScopes` to preserve previously-granted
 *     org/SharePoint scopes across reconnections (FOX-2581).
 *   - If the first account has only base scopes, both `additionalScopes`
 *     and `loginHint` stay undefined → OAuth opens with `prompt=select_account`,
 *     which lets the user pick a different account at the picker.
 *
 * KNOWN LIMITATION (raised as a Phase B3.5 finding; out of scope for Phase B):
 *   - When the first account has extras (e.g. Sites.Read.All) AND the user
 *     wants to ADD a different account, login_hint forces Microsoft to
 *     sign the user in as the first account. The "add Account B" flow is
 *     blocked in that case unless the user manually disconnects Account A
 *     first. Phase D should add a "Connect another account" UI affordance
 *     that bypasses the scope-preservation branch when the user explicitly
 *     wants to add a new account; the orchestrator should accept a
 *     `forceAccountPicker` option that disables login_hint.
 *
 * Tests below assert the current behaviour as a regression baseline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test.
// ---------------------------------------------------------------------------

const mockGetMcpServerNames = vi.fn();
const mockRemoveMcpServerEntry = vi.fn();
const mockUpsertMcpServerEntry = vi.fn();

vi.mock('../../services/mcpConfigManager', () => ({
  getMcpServerNames: (...args: unknown[]) => mockGetMcpServerNames(...args),
  removeMcpServerEntry: (...args: unknown[]) => mockRemoveMcpServerEntry(...args),
  upsertMcpServerEntry: (...args: unknown[]) => mockUpsertMcpServerEntry(...args),
}));

const mockBuildMicrosoft365MailPayload = vi.fn((..._args: unknown[]) => ({ name: 'Microsoft365Mail-instance' }));
const mockBuildMicrosoft365CalendarPayload = vi.fn((..._args: unknown[]) => ({ name: 'Microsoft365Calendar-instance' }));
const mockBuildMicrosoft365FilesPayload = vi.fn((..._args: unknown[]) => ({ name: 'Microsoft365Files-instance' }));
const mockBuildMicrosoft365TeamsPayload = vi.fn((..._args: unknown[]) => ({ name: 'Microsoft365Teams-instance' }));
const mockBuildMicrosoft365SharePointPayload = vi.fn((..._args: unknown[]) => ({ name: 'Microsoft365SharePoint-instance' }));

vi.mock('../../services/bundledMcpManager', () => ({
  MICROSOFT_SERVER_BASE_NAMES: [
    'Microsoft365Mail',
    'Microsoft365Calendar',
    'Microsoft365Files',
    'Microsoft365Teams',
    'Microsoft365SharePoint',
  ],
  buildMicrosoft365MailPayload: (...args: unknown[]) => mockBuildMicrosoft365MailPayload(...args),
  buildMicrosoft365CalendarPayload: (...args: unknown[]) => mockBuildMicrosoft365CalendarPayload(...args),
  buildMicrosoft365FilesPayload: (...args: unknown[]) => mockBuildMicrosoft365FilesPayload(...args),
  buildMicrosoft365TeamsPayload: (...args: unknown[]) => mockBuildMicrosoft365TeamsPayload(...args),
  buildMicrosoft365SharePointPayload: (...args: unknown[]) => mockBuildMicrosoft365SharePointPayload(...args),
}));

const mockIpcHandlers: Record<string, (...args: unknown[]) => unknown> = {};
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mockIpcHandlers[channel] = handler;
    },
  },
}));

const mockGetSettings = vi.fn((..._args: unknown[]) => ({}));

const mockGetMicrosoftAccounts = vi.fn();
const mockGetMicrosoftConfigDir = vi.fn((..._args: unknown[]) => '/tmp/microsoft-mcp');
const mockStartMicrosoftAuth = vi.fn();
const mockRemoveMicrosoftAccount = vi.fn();
const mockCancelMicrosoftAuth = vi.fn();
const mockIsMicrosoftConnected = vi.fn();
const mockGetExtraScopesForAccount = vi.fn();

vi.mock('../../services/microsoftAuthService', () => ({
  getMicrosoftAccounts: (...args: unknown[]) => mockGetMicrosoftAccounts(...args),
  getMicrosoftConfigDir: (...args: unknown[]) => mockGetMicrosoftConfigDir(...args),
  startMicrosoftAuth: (...args: unknown[]) => mockStartMicrosoftAuth(...args),
  removeMicrosoftAccount: (...args: unknown[]) => mockRemoveMicrosoftAccount(...args),
  cancelMicrosoftAuth: (...args: unknown[]) => mockCancelMicrosoftAuth(...args),
  isMicrosoftConnected: (...args: unknown[]) => mockIsMicrosoftConnected(...args),
  getExtraScopesForAccount: (...args: unknown[]) => mockGetExtraScopesForAccount(...args),
  MICROSOFT_SHAREPOINT_SCOPES: ['Sites.Read.All'],
}));

const mockResolveMicrosoftClientId = vi.fn();
vi.mock('../../services/oauthCredentials', () => ({
  resolveMicrosoftClientId: (...args: unknown[]) => mockResolveMicrosoftClientId(...args),
  microsoftCredentialSource: {},
}));

vi.mock('../../services/mcpServerRemovalService', () => ({
  removeMcpServerWithCleanup: vi.fn(),
  performPostRemovalCleanup: vi.fn(),
}));

vi.mock('@shared/utils/mcpInstanceUtils', () => ({
  generateInstanceId: (base: string, email: string) =>
    `${base}-${email.replace(/[^a-zA-Z0-9]/g, '-')}`,
}));

vi.mock('../../services/mcpService', () => ({
  resolveMcpConfigPath: vi.fn((..._args: unknown[]) => '/tmp/mcp-config.json'),
  // Merge synthesis: connect sites use the resolve-on-deferral form (idle
  // path preserves "connect => usable"; deferred path resolves { queued: true }
  // promptly — the renderer queued-UX/launchRebel gate consumes it).
  reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral: vi.fn(async () => ({ queued: true })),
  // Never resolves: simulates the drain-deferred restart. The handlers must
  // never await this (260610 API split) — if a revert reintroduces an await,
  // the prompt-resolution tests below go red.
  reconfigureSuperMcpWithCacheRefreshAndAwaitExecution: vi.fn(() => new Promise<never>(() => {})),
}));

vi.mock('../../settingsStore', () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
}));

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------
import { registerMicrosoftHandlers } from '../microsoftHandlers';
import { reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral } from '../../services/mcpService';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('microsoftHandlers — day-2 add-account flow (2-account fixture)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const channel of Object.keys(mockIpcHandlers)) {
      delete mockIpcHandlers[channel];
    }
    mockResolveMicrosoftClientId.mockReturnValue('ms-client-id');
    mockGetMcpServerNames.mockResolvedValue([]);
    registerMicrosoftHandlers();
  });

  // ── Day-1: first account, no existing accounts on disk ──

  it('day-1 connect (no accounts on disk) → no loginHint, no additionalScopes, account picker opens', async () => {
    mockGetMicrosoftAccounts.mockResolvedValue([]);
    mockStartMicrosoftAuth.mockResolvedValue('alice@example.com');

    const handler = mockIpcHandlers['microsoft:start-auth'];
    expect(handler).toBeDefined();
    const result = await handler();

    expect(result).toEqual({ success: true, email: 'alice@example.com' });
    expect(mockStartMicrosoftAuth).toHaveBeenCalledTimes(1);
    expect(mockStartMicrosoftAuth).toHaveBeenCalledWith(
      'ms-client-id',
      undefined, // additionalScopes
      undefined, // loginHint — picker stays open
    );
    expect(mockGetExtraScopesForAccount).not.toHaveBeenCalled();
  });

  // ── Day-2: second account with FIRST account holding only base scopes ──

  it('day-2 add (existing account has only base scopes) → no loginHint, picker stays open for new account', async () => {
    mockGetMicrosoftAccounts.mockResolvedValue([
      { email: 'alice@example.com', status: 'active' },
    ]);
    mockGetExtraScopesForAccount.mockResolvedValue([]); // alice has only base scopes
    mockStartMicrosoftAuth.mockResolvedValue('bob@example.com');

    const handler = mockIpcHandlers['microsoft:start-auth'];
    const result = await handler();

    expect(result).toEqual({ success: true, email: 'bob@example.com' });
    expect(mockGetExtraScopesForAccount).toHaveBeenCalledWith('alice@example.com');
    // No loginHint, no additionalScopes — prompt=select_account allows the user
    // to pick bob@example.com (or any other account) at the Microsoft picker.
    expect(mockStartMicrosoftAuth).toHaveBeenCalledWith(
      'ms-client-id',
      undefined,
      undefined,
    );
    // After auth, instance MCPs are registered against the new (bob) account.
    expect(mockBuildMicrosoft365MailPayload).toHaveBeenCalledWith(expect.objectContaining({
      email: 'bob@example.com',
    }));
    expect(mockUpsertMcpServerEntry).toHaveBeenCalledTimes(5);
  });

  // ── Day-2: second account with FIRST account holding ORG/SHAREPOINT scopes ──
  // BEHAVIOURAL BASELINE (and known limitation flagged above):

  it('day-2 add (existing account has org extras) → loginHint locks add-account flow to first account', async () => {
    // Alice has Sites.Read.All. The handler preserves her extras and forwards
    // her email as login_hint. Microsoft will then sign the user back in as
    // Alice — NOT as Bob — so this flow does not actually add Bob until
    // Alice is disconnected. Documented as a Phase D follow-up; this test
    // ensures the behaviour does not change silently before Phase D lands.
    mockGetMicrosoftAccounts.mockResolvedValue([
      { email: 'alice@example.com', status: 'active' },
    ]);
    mockGetExtraScopesForAccount.mockResolvedValue(['Sites.Read.All', 'Files.ReadWrite.All']);
    mockStartMicrosoftAuth.mockResolvedValue('alice@example.com');

    const handler = mockIpcHandlers['microsoft:start-auth'];
    const result = await handler();

    expect(result).toEqual({ success: true, email: 'alice@example.com' });
    expect(mockStartMicrosoftAuth).toHaveBeenCalledWith(
      'ms-client-id',
      ['Sites.Read.All', 'Files.ReadWrite.All'],
      'alice@example.com',
    );
  });

  // ── Day-2: existing account is expired/error → fallback path still preserves scopes ──

  it('day-2 add (no active account, falls back to first expired account) → scopes still preserved', async () => {
    mockGetMicrosoftAccounts.mockResolvedValue([
      { email: 'expired@example.com', status: 'expired' },
    ]);
    mockGetExtraScopesForAccount.mockResolvedValue(['Sites.Read.All']);
    mockStartMicrosoftAuth.mockResolvedValue('expired@example.com');

    const handler = mockIpcHandlers['microsoft:start-auth'];
    const result = await handler();

    expect(result).toEqual({ success: true, email: 'expired@example.com' });
    expect(mockGetExtraScopesForAccount).toHaveBeenCalledWith('expired@example.com');
    expect(mockStartMicrosoftAuth).toHaveBeenCalledWith(
      'ms-client-id',
      ['Sites.Read.All'],
      'expired@example.com',
    );
  });

  // ── 2-account MCP registration verifies per-account instance IDs ──

  it('day-2 successful add registers 5 instance-specific MCPs under the NEW account email', async () => {
    mockGetMicrosoftAccounts.mockResolvedValue([
      { email: 'alice@example.com', status: 'active' },
    ]);
    mockGetExtraScopesForAccount.mockResolvedValue([]);
    mockStartMicrosoftAuth.mockResolvedValue('[external-email]');

    const handler = mockIpcHandlers['microsoft:start-auth'];
    await handler();

    expect(mockUpsertMcpServerEntry).toHaveBeenCalledTimes(5);
    for (const payloadBuilder of [
      mockBuildMicrosoft365MailPayload,
      mockBuildMicrosoft365CalendarPayload,
      mockBuildMicrosoft365FilesPayload,
      mockBuildMicrosoft365TeamsPayload,
      mockBuildMicrosoft365SharePointPayload,
    ]) {
      expect(payloadBuilder).toHaveBeenCalledWith(expect.objectContaining({
        clientId: 'ms-client-id',
        email: '[external-email]',
      }));
    }
  });

  // ── SharePoint scope-upgrade path — 2-account case ──

  it('SharePoint connect picks the FIRST active account (not the picker) and forwards Sites.Read.All', async () => {
    // SharePoint connect is explicitly a scope-UPGRADE flow on an existing
    // account, so login_hint is mandatory. With 2 accounts present, only
    // the first ACTIVE account is targeted; if neither is active the
    // handler must return a fail-loud error so the UI can prompt the user
    // to reconnect first.
    mockGetMicrosoftAccounts.mockResolvedValue([
      { email: 'alice@example.com', status: 'active' },
      { email: 'bob@example.com',   status: 'active' },
    ]);
    mockStartMicrosoftAuth.mockResolvedValue('alice@example.com');

    const handler = mockIpcHandlers['microsoft:start-auth-sharepoint'];
    expect(handler).toBeDefined();
    const result = await handler();

    expect(result).toEqual({ success: true, email: 'alice@example.com' });
    expect(mockStartMicrosoftAuth).toHaveBeenCalledWith(
      'ms-client-id',
      ['Sites.Read.All'],
      'alice@example.com',
    );
  });

  it('SharePoint connect with no active account returns a fail-loud error (no implicit picker fallback)', async () => {
    mockGetMicrosoftAccounts.mockResolvedValue([
      { email: 'expired@example.com', status: 'expired' },
    ]);

    const handler = mockIpcHandlers['microsoft:start-auth-sharepoint'];
    const result = await handler();

    expect(result).toEqual({
      success: false,
      error: expect.stringMatching(/no active microsoft account/i),
    });
    expect(mockStartMicrosoftAuth).not.toHaveBeenCalled();
  });
});

describe('microsoftHandlers — not-configured returns structured setupGuidance (Stage 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const channel of Object.keys(mockIpcHandlers)) {
      delete mockIpcHandlers[channel];
    }
    registerMicrosoftHandlers();
  });

  it('microsoft:start-auth with no client id returns setupGuidance for microsoft (no auth attempt)', async () => {
    mockResolveMicrosoftClientId.mockReturnValue(null);

    const handler = mockIpcHandlers['microsoft:start-auth'];
    const result = (await handler()) as {
      success: boolean;
      error?: string;
      setupGuidance?: { code: string; provider: string; message: string; envVars: string[] };
    };

    expect(result.success).toBe(false);
    expect(result.setupGuidance?.code).toBe('oauth-credentials-not-configured');
    expect(result.setupGuidance?.provider).toBe('microsoft');
    expect(result.error).toBe(result.setupGuidance?.message);
    // Microsoft is a PKCE public client — client id only, no secret env var.
    expect(result.setupGuidance?.envVars).toEqual(['MICROSOFT_CLIENT_ID']);
    expect(mockStartMicrosoftAuth).not.toHaveBeenCalled();
  });

  it('microsoft:start-auth-sharepoint with no client id returns setupGuidance for microsoft (F2)', async () => {
    // F2 (Stage 3 refinement): the SharePoint incremental-consent path must no longer be the odd
    // Microsoft path that can only emit a bare string — on a null clientId it returns the same
    // structured guidance as microsoft:start-auth so the renderer can open the setup dialog.
    mockResolveMicrosoftClientId.mockReturnValue(null);

    const handler = mockIpcHandlers['microsoft:start-auth-sharepoint'];
    expect(handler).toBeDefined();
    const result = (await handler()) as {
      success: boolean;
      error?: string;
      setupGuidance?: { code: string; provider: string; message: string; envVars: string[] };
    };

    expect(result.success).toBe(false);
    expect(result.setupGuidance?.code).toBe('oauth-credentials-not-configured');
    expect(result.setupGuidance?.provider).toBe('microsoft');
    expect(result.error).toBe(result.setupGuidance?.message);
    expect(result.setupGuidance?.envVars).toEqual(['MICROSOFT_CLIENT_ID']);
    expect(mockGetMicrosoftAccounts).not.toHaveBeenCalled();
    expect(mockStartMicrosoftAuth).not.toHaveBeenCalled();
  });

  // ── Regression (260610 API split): connect must not block on the deferred
  // Super-MCP restart (deferred up to 30 min while agent turns drain) — the
  // connect leg of the disconnect-hang class. The mocked execution-awaiting
  // reconfigure never resolves, so any reintroduced `await` turns these red. ──

  it('microsoft:start-auth resolves promptly while the Super-MCP restart is deferred', async () => {
    mockResolveMicrosoftClientId.mockReturnValue('ms-client-id');
    mockGetMicrosoftAccounts.mockResolvedValue([]);
    mockStartMicrosoftAuth.mockResolvedValue('alice@example.com');

    const handler = mockIpcHandlers['microsoft:start-auth'];
    expect(handler).toBeDefined();

    const sentinel = Symbol('connect-still-pending');
    const winner = await Promise.race([
      handler(),
      // Macrotask fires only after all pending microtasks drain.
      new Promise((resolve) => setTimeout(() => resolve(sentinel), 0)),
    ]);

    expect(winner).toEqual({ success: true, email: 'alice@example.com' });
    // Merge synthesis: the restart goes through the resolve-on-deferral form
    // (NOT detached), with the context string the renderer's deferred-op
    // matching exact-matches on.
    expect(reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral).toHaveBeenCalledWith(
      '/tmp/mcp-config.json',
      expect.objectContaining({ context: 'microsoft-connect' }),
    );
  });

  it('microsoft:start-auth-sharepoint resolves promptly while the Super-MCP restart is deferred', async () => {
    mockResolveMicrosoftClientId.mockReturnValue('ms-client-id');
    mockGetMicrosoftAccounts.mockResolvedValue([
      { email: 'alice@example.com', status: 'active' },
    ]);
    mockStartMicrosoftAuth.mockResolvedValue('alice@example.com');

    const handler = mockIpcHandlers['microsoft:start-auth-sharepoint'];
    expect(handler).toBeDefined();

    const sentinel = Symbol('sharepoint-connect-still-pending');
    const winner = await Promise.race([
      handler(),
      new Promise((resolve) => setTimeout(() => resolve(sentinel), 0)),
    ]);

    expect(winner).toEqual({ success: true, email: 'alice@example.com' });
    expect(reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral).toHaveBeenCalledWith(
      '/tmp/mcp-config.json',
      expect.objectContaining({ context: 'microsoft-sharepoint-connect' }),
    );
  });
});
