/**
 * Stage 2 (260503_unify_learned_limits_into_profiles.md): the cloud
 * `PATCH /api/settings` route must invoke
 * `mergeIncomingProfilesPreservingLearned` so a stale auto-learn payload
 * sent via cloud sync cannot clobber a fresher local user value (or a
 * fresher local auto value).
 *
 * The merge semantics are unit-tested in
 * `src/shared/utils/__tests__/learnedLimitsMergeGuard.test.ts`. This
 * test verifies the route wiring.
 */
import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { AppSettings, ModelProfile } from '@shared/types';
import { handleSettings } from '../settings';
import type { CloudServiceDeps } from '../../bootstrap';

function createMockReq(
  body: unknown,
  method: 'PATCH' | 'PUT' | 'GET' = 'PATCH',
): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = method;
  req.headers = { host: 'cloud.local', 'content-type': 'application/json' };
  req.url = '/api/settings';
  setImmediate(() => {
    if (body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(body), 'utf-8'));
    }
    req.emit('end');
  });
  return req;
}

interface MockRes {
  _status: number;
  _body: string;
  _headers: Record<string, string>;
  statusCode: number;
  setHeader(key: string, value: string): void;
  getHeader(key: string): string | undefined;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

function createMockRes(): http.ServerResponse & MockRes {
  const res: MockRes = {
    _status: 0,
    _body: '',
    _headers: {},
    statusCode: 0,
    setHeader(key: string, value: string) {
      this._headers[key] = value;
    },
    getHeader(key: string) {
      return this._headers[key];
    },
    writeHead(status: number, headers?: Record<string, string>) {
      this._status = status;
      if (headers) Object.assign(this._headers, headers);
    },
    end(body?: string) {
      if (body) this._body = body;
    },
  };
  return res as unknown as http.ServerResponse & MockRes;
}

const baseProfile: ModelProfile = {
  id: 'cloud-merge-guard',
  name: 'Cloud Merge Guard',
  model: 'gpt-test',
  providerType: 'other',
  serverUrl: 'https://example.test',
  createdAt: 1,
};

function buildSettings(profile: ModelProfile): AppSettings {
  return {
    coreDirectory: '/tmp',
    localModel: { profiles: [profile], activeProfileId: null },
  } as unknown as AppSettings;
}

function buildIncomingPatch(profile: ModelProfile): Partial<AppSettings> {
  return {
    localModel: { profiles: [profile], activeProfileId: null },
  } as Partial<AppSettings>;
}

function makeDeps(initial: AppSettings): CloudServiceDeps {
  let state = initial;
  return {
    getSettings: () => state,
    updateSettings: (partial: Partial<AppSettings>) => {
      state = { ...state, ...partial } as AppSettings;
    },
    refreshAnalyticsIdentity: vi.fn(),
  } as unknown as CloudServiceDeps;
}

describe('PATCH /api/settings — Stage 2 stale-sync merge guard', () => {
  it('rejects coreDirectory updates so cloud workspace root cannot be request-controlled', async () => {
    const updateSettings = vi.fn();
    const state = buildSettings(baseProfile);
    const deps = {
      getSettings: () => state,
      updateSettings,
    } as unknown as CloudServiceDeps;

    const req = createMockReq({ coreDirectory: '/tmp/evil' });
    const res = createMockRes();
    await handleSettings(req, res, deps);

    expect(res._status).toBe(400);
    expect(res._body).toContain('coreDirectory');
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('strips local-only settings keys from inbound cloud updates', async () => {
    let state = {
      ...buildSettings(baseProfile),
      coreDirectory: '/data/workspace',
      mcpConfigFile: '/data/mcp/router.json',
      theme: 'dark',
      enforceSoftwareEngineerEvidence: false,
    } as AppSettings;
    const deps = {
      getSettings: () => state,
      updateSettings: (partial: Partial<AppSettings>) => {
        state = { ...state, ...partial } as AppSettings;
      },
      refreshAnalyticsIdentity: vi.fn(),
    } as unknown as CloudServiceDeps;

    const req = createMockReq({
      theme: 'light',
      mcpConfigFile: '/tmp/override',
      cloudInstance: { cloudUrl: 'https://example.invalid' },
      enforceSoftwareEngineerEvidence: true,
    });
    const res = createMockRes();
    await handleSettings(req, res, deps);

    expect(res._status).toBe(200);
    expect(state.theme).toBe('light');
    expect(state.mcpConfigFile).toBe('/data/mcp/router.json');
    expect(state.enforceSoftwareEngineerEvidence).toBe(false);
    expect(state.cloudInstance).toBeUndefined();
  });

  it('preserves a local user-set context window when an older auto payload arrives', async () => {
    const localProfile: ModelProfile = {
      ...baseProfile,
      contextWindow: 1_500_000,
      contextWindowSource: 'user',
    };
    const deps = makeDeps(buildSettings(localProfile));

    const incomingProfile: ModelProfile = {
      ...baseProfile,
      contextWindow: 880_000,
      contextWindowSource: 'auto',
      contextWindowLearnedAt: 1,
    };

    const req = createMockReq(buildIncomingPatch(incomingProfile));
    const res = createMockRes();
    await handleSettings(req, res, deps);

    expect(res._status).toBe(200);
    const persisted = deps.getSettings().localModel!.profiles![0];
    expect(persisted.contextWindow).toBe(1_500_000);
    expect(persisted.contextWindowSource).toBe('user');
  });

  it('takes incoming user-set value over local auto-learned (user wins inverse)', async () => {
    const localProfile: ModelProfile = {
      ...baseProfile,
      contextWindow: 600_000,
      contextWindowSource: 'auto',
      contextWindowLearnedAt: 9_999,
    };
    const deps = makeDeps(buildSettings(localProfile));

    const incomingProfile: ModelProfile = {
      ...baseProfile,
      contextWindow: 1_400_000,
      contextWindowSource: 'user',
    };

    const req = createMockReq(buildIncomingPatch(incomingProfile));
    const res = createMockRes();
    await handleSettings(req, res, deps);

    expect(res._status).toBe(200);
    const persisted = deps.getSettings().localModel!.profiles![0];
    expect(persisted.contextWindow).toBe(1_400_000);
    expect(persisted.contextWindowSource).toBe('user');
  });

  it('preserves existing profileSource when an older client omits the field', async () => {
    const localProfile: ModelProfile = {
      ...baseProfile,
      profileSource: 'connection',
    };
    const deps = makeDeps(buildSettings(localProfile));

    const incomingProfile: ModelProfile = {
      ...baseProfile,
      profileSource: undefined,
    };

    const req = createMockReq(buildIncomingPatch(incomingProfile));
    const res = createMockRes();
    await handleSettings(req, res, deps);

    expect(res._status).toBe(200);
    const persisted = deps.getSettings().localModel!.profiles![0];
    expect(persisted.profileSource).toBe('connection');
  });

  it('takes incoming profileSource over local profileSource when a newer value arrives', async () => {
    const localProfile: ModelProfile = {
      ...baseProfile,
      profileSource: 'connection',
    };
    const deps = makeDeps(buildSettings(localProfile));

    const incomingProfile: ModelProfile = {
      ...baseProfile,
      profileSource: 'user',
    };

    const req = createMockReq(buildIncomingPatch(incomingProfile));
    const res = createMockRes();
    await handleSettings(req, res, deps);

    expect(res._status).toBe(200);
    const persisted = deps.getSettings().localModel!.profiles![0];
    expect(persisted.profileSource).toBe('user');
  });

  it('takes incoming connection profileSource when the local profile has no source', async () => {
    const localProfile: ModelProfile = {
      ...baseProfile,
      profileSource: undefined,
    };
    const deps = makeDeps(buildSettings(localProfile));

    const incomingProfile: ModelProfile = {
      ...baseProfile,
      profileSource: 'connection',
    };

    const req = createMockReq(buildIncomingPatch(incomingProfile));
    const res = createMockRes();
    await handleSettings(req, res, deps);

    expect(res._status).toBe(200);
    const persisted = deps.getSettings().localModel!.profiles![0];
    expect(persisted.profileSource).toBe('connection');
  });

  it('preserves local auto profileSource when an older client omits the field', async () => {
    const localProfile: ModelProfile = {
      ...baseProfile,
      profileSource: 'auto',
    };
    const deps = makeDeps(buildSettings(localProfile));

    const incomingProfile: ModelProfile = {
      ...baseProfile,
      profileSource: undefined,
    };

    const req = createMockReq(buildIncomingPatch(incomingProfile));
    const res = createMockRes();
    await handleSettings(req, res, deps);

    expect(res._status).toBe(200);
    const persisted = deps.getSettings().localModel!.profiles![0];
    expect(persisted.profileSource).toBe('auto');
  });

  it('preserves local connection profileSource when incoming payload sends profileSource: null', async () => {
    const localProfile: ModelProfile = {
      ...baseProfile,
      profileSource: 'connection',
    };
    const deps = makeDeps(buildSettings(localProfile));

    const incomingProfile: ModelProfile = {
      ...baseProfile,
      profileSource: null as unknown as ModelProfile['profileSource'],
    };

    const req = createMockReq(buildIncomingPatch(incomingProfile), 'PATCH');
    const res = createMockRes();
    await handleSettings(req, res, deps);

    expect(res._status).toBe(200);
    const persisted = deps.getSettings().localModel!.profiles![0];
    expect(persisted.profileSource).toBe('connection');
  });

  // Stage 3 review fix: the inbound dual-write is the live-recovery seam for
  // cloud analytics identity (the settings store has no change-event seam), so
  // a successful PATCH/PUT must re-evaluate owner identity after applying.
  it('calls refreshAnalyticsIdentity after a successful settings update (live identity recovery hook)', async () => {
    let state = buildSettings(baseProfile);
    const refreshAnalyticsIdentity = vi.fn();
    const deps = {
      getSettings: () => state,
      updateSettings: (partial: Partial<AppSettings>) => {
        state = { ...state, ...partial } as AppSettings;
      },
      refreshAnalyticsIdentity,
    } as unknown as CloudServiceDeps;

    const req = createMockReq({ userEmail: 'owner@example.com' }, 'PATCH');
    const res = createMockRes();
    await handleSettings(req, res, deps);

    expect(res._status).toBe(200);
    expect(refreshAnalyticsIdentity).toHaveBeenCalledTimes(1);
  });

  it('does NOT call refreshAnalyticsIdentity when the update is rejected (coreDirectory guard)', async () => {
    const refreshAnalyticsIdentity = vi.fn();
    const state = buildSettings(baseProfile);
    const deps = {
      getSettings: () => state,
      updateSettings: vi.fn(),
      refreshAnalyticsIdentity,
    } as unknown as CloudServiceDeps;

    const req = createMockReq({ coreDirectory: '/tmp/evil' });
    const res = createMockRes();
    await handleSettings(req, res, deps);

    expect(res._status).toBe(400);
    expect(refreshAnalyticsIdentity).not.toHaveBeenCalled();
  });
});
