import { describe, expect, it } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import {
  resolveCredentialsForProfile,
  isProfileCredentialReachable,
  type CredentialResolution,
} from '../credentialResolution';

/**
 * Truth-table for the canonical credential chokepoint (Stage E2a).
 *
 * These rows mirror the `providerRouting.profileCredentialMatrix` integration net, but assert
 * the chokepoint's verdict DIRECTLY: `{ kind, source }` and (for reachable verdicts) the
 * dispatch material. The matrix proves the client resolver (`resolveConnectionCredentials`)
 * still projects faithfully over this chokepoint; this test pins the chokepoint's own
 * classification so a future regression in the ladder is caught at the source.
 */

function baseSettings(overrides: Record<string, unknown> = {}): AppSettings {
  return {
    models: { apiKey: 'fake-ant-test', oauthToken: null, authMethod: 'api-key', model: 'claude-sonnet-4-6' },
    openRouter: { enabled: false, oauthToken: null, selectedModel: '' },
    providerKeys: {},
    customProviders: [],
    ...overrides,
  } as unknown as AppSettings;
}

function profile(overrides: Partial<ModelProfile> & Pick<ModelProfile, 'id'>): ModelProfile {
  return {
    name: overrides.name ?? overrides.id,
    serverUrl: '',
    createdAt: 1,
    ...overrides,
  } as ModelProfile;
}

interface Row {
  readonly name: string;
  readonly profile: ModelProfile;
  readonly settings: AppSettings;
  readonly codexMode?: unknown;
  readonly expected:
    | { kind: 'reachable'; source: CredentialResolution['source']; credentials: Record<string, unknown> }
    | { kind: 'unreachable'; source: CredentialResolution['source'] };
}

const rows: readonly Row[] = [
  // ── OpenRouter shared-OAuth (the 260513/260611 shape) ──────────────────────
  {
    name: 'openrouter+connection / oauth present',
    profile: profile({ id: 'or-conn', providerType: 'openrouter', profileSource: 'connection', serverUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.6' }),
    settings: baseSettings({ openRouter: { enabled: true, oauthToken: 'or-oauth-token', selectedModel: '' } }),
    expected: { kind: 'reachable', source: 'openrouter-oauth-token', credentials: { oauthToken: 'or-oauth-token', sessionMode: 'oauth' } },
  },
  {
    name: 'openrouter+connection / oauth absent',
    profile: profile({ id: 'or-conn', providerType: 'openrouter', profileSource: 'connection', serverUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.6' }),
    settings: baseSettings({ openRouter: { enabled: false, oauthToken: null, selectedModel: '' } }),
    expected: { kind: 'unreachable', source: 'missing-openrouter' },
  },
  {
    name: 'openrouter+user / oauth present (user-added custom model — 260611 shape)',
    profile: profile({ id: 'or-user-oauth', providerType: 'openrouter', profileSource: 'user', serverUrl: 'https://openrouter.ai/api/v1', model: 'x-ai/grok-4' }),
    settings: baseSettings({ openRouter: { enabled: true, oauthToken: 'or-oauth-token', selectedModel: '' } }),
    expected: { kind: 'reachable', source: 'openrouter-oauth-token', credentials: { oauthToken: 'or-oauth-token', sessionMode: 'oauth' } },
  },
  {
    name: 'openrouter+undefined-source / oauth present (literal wizard output)',
    profile: profile({ id: 'or-undef-oauth', providerType: 'openrouter', serverUrl: 'https://openrouter.ai/api/v1', model: 'x-ai/grok-4' }),
    settings: baseSettings({ openRouter: { enabled: true, oauthToken: 'or-oauth-token', selectedModel: '' } }),
    expected: { kind: 'reachable', source: 'openrouter-oauth-token', credentials: { oauthToken: 'or-oauth-token', sessionMode: 'oauth' } },
  },
  {
    name: 'openrouter+user / whitespace-only oauth (normalized to missing)',
    profile: profile({ id: 'or-user-blank', providerType: 'openrouter', profileSource: 'user', serverUrl: 'https://openrouter.ai/api/v1', model: 'x-ai/grok-4' }),
    settings: baseSettings({ openRouter: { enabled: true, oauthToken: '   ', selectedModel: '' } }),
    expected: { kind: 'unreachable', source: 'missing-openrouter' },
  },
  {
    name: 'openrouter+user / per-profile key (BYOK wins over absent oauth)',
    profile: profile({ id: 'or-user-key', providerType: 'openrouter', profileSource: 'user', serverUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.6', apiKey: 'or-profile-key' }),
    settings: baseSettings(),
    expected: { kind: 'reachable', source: 'profile-api-key', credentials: { apiKey: 'or-profile-key', sessionMode: 'api-key' } },
  },
  {
    name: 'openrouter+user / providerKeys.openrouter AND oauth present (BYOK wins)',
    profile: profile({ id: 'or-user-pk-oauth', providerType: 'openrouter', profileSource: 'user', serverUrl: 'https://openrouter.ai/api/v1', model: 'x-ai/grok-4' }),
    settings: baseSettings({ providerKeys: { openrouter: 'or-shared-key' }, openRouter: { enabled: true, oauthToken: 'or-oauth-token', selectedModel: '' } }),
    expected: { kind: 'reachable', source: 'profile-api-key', credentials: { apiKey: 'or-shared-key', sessionMode: 'api-key' } },
  },
  // ── Anthropic (managed profile reads the settings key) ──────────────────────
  {
    name: 'anthropic managed profile / settings api-key present',
    profile: profile({ id: 'ant', providerType: 'anthropic', profileSource: 'connection', serverUrl: '', model: 'claude-sonnet-4-6' }),
    settings: baseSettings({ models: { apiKey: 'fake-ant-test', oauthToken: null, authMethod: 'api-key', model: 'claude-sonnet-4-6' } }),
    expected: { kind: 'reachable', source: 'anthropic-api-key', credentials: { apiKey: 'fake-ant-test', sessionMode: 'api-key' } },
  },
  {
    name: 'anthropic managed profile / settings api-key absent',
    profile: profile({ id: 'ant', providerType: 'anthropic', profileSource: 'connection', serverUrl: '', model: 'claude-sonnet-4-6' }),
    settings: baseSettings({ models: { apiKey: null, oauthToken: null, authMethod: 'api-key', model: 'claude-sonnet-4-6' } }),
    expected: { kind: 'unreachable', source: 'missing-anthropic' },
  },
  // ── OpenAI / together (profile + shared-key reachability) ───────────────────
  {
    name: 'openai profile / per-profile key present',
    profile: profile({ id: 'oai', providerType: 'openai', serverUrl: 'https://api.openai.com/v1', model: 'gpt-5.5', apiKey: 'fake-openai-key' }),
    settings: baseSettings(),
    expected: { kind: 'reachable', source: 'openai-api-key', credentials: { apiKey: 'fake-openai-key', sessionMode: 'api-key' } },
  },
  {
    name: 'openai profile / key absent',
    profile: profile({ id: 'oai', providerType: 'openai', serverUrl: 'https://api.openai.com/v1', model: 'gpt-5.5' }),
    settings: baseSettings(),
    expected: { kind: 'unreachable', source: 'missing-profile' },
  },
  {
    name: 'together profile / shared providerKeys key present',
    profile: profile({ id: 'tog', providerType: 'together', serverUrl: 'https://api.together.xyz/v1', model: 'deepseek-ai/DeepSeek-V3' }),
    settings: baseSettings({ providerKeys: { together: 'fake-together-key' } }),
    expected: { kind: 'reachable', source: 'profile-api-key', credentials: { apiKey: 'fake-together-key', sessionMode: 'api-key' } },
  },
  {
    name: 'together profile / no key anywhere',
    profile: profile({ id: 'tog', providerType: 'together', serverUrl: 'https://api.together.xyz/v1', model: 'deepseek-ai/DeepSeek-V3' }),
    settings: baseSettings(),
    expected: { kind: 'unreachable', source: 'missing-profile' },
  },
  // ── Codex subscription (session reachability) ───────────────────────────────
  {
    name: 'codex-subscription profile / session present',
    profile: profile({ id: 'codex', providerType: 'openai', authSource: 'codex-subscription', profileSource: 'auto', serverUrl: 'https://api.openai.com/v1', model: 'gpt-5.5' }),
    settings: baseSettings(),
    codexMode: 'connected',
    expected: { kind: 'reachable', source: 'codex-subscription', credentials: { sessionMode: 'codex' } },
  },
  {
    name: 'codex-subscription profile / no session',
    profile: profile({ id: 'codex', providerType: 'openai', authSource: 'codex-subscription', profileSource: 'auto', serverUrl: 'https://api.openai.com/v1', model: 'gpt-5.5' }),
    settings: baseSettings(),
    codexMode: undefined,
    expected: { kind: 'unreachable', source: 'missing-codex' },
  },
  // ── Local (no credential required) ──────────────────────────────────────────
  {
    name: 'local profile / no credential required',
    profile: profile({ id: 'local', providerType: 'local', serverUrl: 'http://localhost:1234/v1', model: 'llama-3' }),
    settings: baseSettings(),
    expected: { kind: 'reachable', source: 'local-none', credentials: {} },
  },
  // ── Divergence guards (the edges the cross-family review flagged the matrix can't catch) ──
  {
    // DIV-2: a non-managed localhost-URL profile with real material must NOT be pre-empted by a
    // local-none short-circuit — the credential still resolves. (OpenRouter OAuth here.)
    name: 'non-managed localhost-URL openrouter + oauth / material is NOT dropped',
    profile: profile({ id: 'or-localhost', providerType: 'openrouter', profileSource: 'user', serverUrl: 'http://localhost:7777/v1', model: 'x-ai/grok-4' }),
    settings: baseSettings({ openRouter: { enabled: true, oauthToken: 'tok', selectedModel: '' } }),
    expected: { kind: 'reachable', source: 'openrouter-oauth-token', credentials: { oauthToken: 'tok', sessionMode: 'oauth' } },
  },
  {
    // DIV-3: a non-managed `local` profile with an explicit per-profile key dispatches with that
    // key (the key wins over the local-none fall-through).
    name: 'non-managed local profile + explicit profile key / key wins over local-none',
    profile: profile({ id: 'local-keyed', providerType: 'local', profileSource: 'user', serverUrl: 'http://localhost:1234/v1', model: 'llama-3', apiKey: 'local-key' }),
    settings: baseSettings(),
    expected: { kind: 'reachable', source: 'profile-api-key', credentials: { apiKey: 'local-key', sessionMode: 'api-key' } },
  },
  {
    // DIV-1: a managed `local`-typed profile with a NON-localhost URL is unreachable (the
    // projection throws) — the localhost short-circuit is URL-based, not providerType-based.
    name: 'managed local-typed profile + non-localhost URL / unreachable (projection throws)',
    profile: profile({ id: 'local-managed-remote', providerType: 'local', profileSource: 'connection', serverUrl: 'https://remote.example/v1', model: 'llama-3' }),
    settings: baseSettings(),
    expected: { kind: 'unreachable', source: 'missing-profile' },
  },
];

describe('resolveCredentialsForProfile — credential chokepoint truth-table', () => {
  it.each(rows.map((row) => ({ ...row })))('$name', (row) => {
    const result = resolveCredentialsForProfile(row.profile, row.settings, row.codexMode);
    expect(result.kind).toBe(row.expected.kind);
    expect(result.source).toBe(row.expected.source);
    if (row.expected.kind === 'reachable') {
      expect(result.kind === 'reachable' && result.credentials).toEqual(row.expected.credentials);
    }
    // isProfileCredentialReachable is the boolean projection.
    expect(isProfileCredentialReachable(row.profile, row.settings, row.codexMode)).toBe(
      row.expected.kind === 'reachable',
    );
  });

  it('recovery path: adding the shared OAuth token flips a keyless OpenRouter profile reachable', () => {
    const orProfile = profile({ id: 'or-recover', providerType: 'openrouter', profileSource: 'user', serverUrl: 'https://openrouter.ai/api/v1', model: 'x-ai/grok-4' });

    const before = resolveCredentialsForProfile(orProfile, baseSettings());
    expect(before).toEqual({ kind: 'unreachable', source: 'missing-openrouter' });

    const after = resolveCredentialsForProfile(
      orProfile,
      baseSettings({ openRouter: { enabled: true, oauthToken: 'newly-connected', selectedModel: '' } }),
    );
    expect(after).toEqual({
      kind: 'reachable',
      source: 'openrouter-oauth-token',
      credentials: { oauthToken: 'newly-connected', sessionMode: 'oauth' },
    });
  });
});
