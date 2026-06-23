import { describe, expect, it, test } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { ModelChoice, RoleId } from '@shared/types/modelChoice';
import type { ModelClient } from '@core/rebelCore/modelClient';
import {
  decodePrefixed,
  decodeRoleChoice,
  encodeRoleChoice,
  normalizeStoredBtsModelValue,
  unsafeAssertRoutingModelId,
  rejectionReasonLabel,
  stripStoredModelPrefix,
  type ProfileRef,
  type StoredModelChoice,
} from '../modelChoiceCodec';
import { mintAnthropicWireModel, mintOpenAiWireModel } from '../wireModelId';

const DECODE_OPTIONS = {
  defaultWorkingModel: 'claude-sonnet-4-6',
  defaultBackgroundModel: 'claude-haiku-4-5',
};

const ROLES: readonly RoleId[] = ['working', 'thinking', 'background', 'recovery'];
const KINDS: readonly ModelChoice['kind'][] = ['model', 'profile', 'inherit', 'auto', 'off'];

function makeChoice(role: RoleId, kind: ModelChoice['kind']): ModelChoice {
  switch (kind) {
    case 'model':
      return { kind: 'model', modelId: `${role}-model` };
    case 'profile':
      return { kind: 'profile', profileId: `${role}-profile` };
    case 'inherit':
      return { kind: 'inherit' };
    case 'auto':
      return { kind: 'auto' };
    case 'off':
      return { kind: 'off' };
  }
}

function expectedDecodedChoice(role: RoleId, choice: ModelChoice): ModelChoice {
  if (choice.kind === 'model' || choice.kind === 'profile') return choice;

  switch (role) {
    case 'working':
      return { kind: 'model', modelId: DECODE_OPTIONS.defaultWorkingModel };
    case 'thinking':
      return { kind: 'off' };
    case 'background':
      return { kind: 'model', modelId: DECODE_OPTIONS.defaultBackgroundModel };
    case 'recovery':
      return { kind: 'auto' };
  }
}

function settingsFromEncoding(
  encoding: ReturnType<typeof encodeRoleChoice>,
): Partial<Pick<AppSettings, 'models' | 'behindTheScenesModel'>> {
  if (encoding.scope === 'models') {
    return { models: encoding.fields as AppSettings['models'] };
  }
  return { behindTheScenesModel: encoding.fields.behindTheScenesModel };
}

function encodeBackground(choice: ModelChoice): string | undefined {
  const encoded = encodeRoleChoice('background', choice);
  return encoded.scope === 'top' ? encoded.fields.behindTheScenesModel : undefined;
}

describe('modelChoiceCodec round-trip behavior', () => {
  const roleKindMatrix: Array<[RoleId, ModelChoice['kind']]> = ROLES.flatMap((role) =>
    KINDS.map((kind) => [role, kind] as [RoleId, ModelChoice['kind']]),
  );

  test.each(roleKindMatrix)('encodeRoleChoice/decodeRoleChoice canonicalizes %s + %s', (role, kind) => {
    const choice = makeChoice(role, kind);
    const settings = settingsFromEncoding(encodeRoleChoice(role, choice));

    const decoded = decodeRoleChoice(role, settings, DECODE_OPTIONS);
    expect(decoded).toEqual(expectedDecodedChoice(role, choice));
  });

  it('decodePrefixed round-trips a model value encoded through the background codec path', () => {
    const encoded = encodeBackground({ kind: 'model', modelId: 'gpt-5.4-mini' });
    expect(decodePrefixed(encoded)).toEqual({ kind: 'model', modelId: 'gpt-5.4-mini' });
  });

  it('decodePrefixed round-trips a profile value encoded through the background codec path', () => {
    const encoded = encodeBackground({ kind: 'profile', profileId: 'abc-123' });
    expect(decodePrefixed(encoded)).toEqual({ kind: 'profile', profileId: 'abc-123' });
  });
});

describe('decodePrefixed edge cases', () => {
  it('returns null for null input', () => {
    expect(decodePrefixed(null)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(decodePrefixed('')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(decodePrefixed('   ')).toBeNull();
  });

  it('returns null for model: with empty model id', () => {
    expect(decodePrefixed('model:')).toBeNull();
  });

  it('passes bare model ids through UN-trimmed (routing passthrough contract)', () => {
    // Deliberate: resolveRuntimeModels routes through decodePrefixed and its contract is
    // untrimmed passthrough (see modelResolution.test.ts). Whitespace is cleaned downstream
    // by the dialect wire minters, not here.
    expect(decodePrefixed('  claude-haiku-4-5  ')).toEqual({
      kind: 'model',
      modelId: '  claude-haiku-4-5  ',
    });
  });

  it('trims prefixed model ids (the prefix strip trims)', () => {
    expect(decodePrefixed('model:  x  ')).toEqual({ kind: 'model', modelId: 'x' });
  });

  it('returns profile with empty id for profile:', () => {
    expect(decodePrefixed('profile:')).toEqual({ kind: 'profile', profileId: '' });
  });
});

describe('model-id brand regression', () => {
  it('requires raw model strings to pass through the codec before wire minting', () => {
    const storedModel = 'model:claude-sonnet-4-6';
    const plainModel = 'claude-sonnet-4-6';

    // @ts-expect-error model-id lifecycle: stored strings must decode before wire minting
    mintAnthropicWireModel(storedModel);
    // @ts-expect-error model-id lifecycle: plain strings must decode before wire minting
    mintOpenAiWireModel(plainModel);

    expect(mintAnthropicWireModel(unsafeAssertRoutingModelId(storedModel))).toBe('claude-sonnet-4-6');
  });
});

declare const typeOnlyClient: ModelClient;
declare const rawModelString: string;
declare const storedModelChoice: StoredModelChoice;
declare const profileRef: ProfileRef;

if (false) {
  // @ts-expect-error model-id lifecycle: raw strings cannot reach the client create sink
  void typeOnlyClient.create({ model: rawModelString, systemPrompt: 's', messages: [], maxTokens: 1 });
  // @ts-expect-error model-id lifecycle: stored choices cannot reach the client stream sink
  void typeOnlyClient.stream({ model: storedModelChoice, systemPrompt: 's', messages: [], maxTokens: 1 }, () => {});
  // @ts-expect-error model-id lifecycle: profile refs must resolve before the client create sink
  void typeOnlyClient.create({ model: profileRef, systemPrompt: 's', messages: [], maxTokens: 1 });
}

describe('stripStoredModelPrefix', () => {
  test.each([
    ['model:gpt-5.4-mini', 'gpt-5.4-mini'],
    ['gpt-5.4-mini', 'gpt-5.4-mini'],
    ['profile:abc-123', 'abc-123'],
    ['model:', null],
    ['modelX:foo', 'modelX:foo'],
    ['', ''],
  ])('strips %j to %j', (input, expected) => {
    expect(stripStoredModelPrefix(input)).toBe(expected);
  });
});

describe('normalizeStoredBtsModelValue', () => {
  test.each([
    [undefined, { ok: false, reason: 'invalid-type' }],
    [null, { ok: false, reason: 'invalid-type' }],
    [42, { ok: false, reason: 'invalid-type' }],
    [{}, { ok: false, reason: 'invalid-type' }],
    [[], { ok: false, reason: 'invalid-type' }],
    [true, { ok: false, reason: 'invalid-type' }],
    ['', { ok: false, reason: 'empty-or-whitespace' }],
    ['   ', { ok: false, reason: 'empty-or-whitespace' }],
    ['\t\n ', { ok: false, reason: 'empty-or-whitespace' }],
    ['model:', { ok: false, reason: 'empty-model-id' }],
    ['model:   ', { ok: false, reason: 'empty-model-id' }],
    ['model:gpt-5.5-mini', { ok: true, kind: 'model', modelId: 'gpt-5.5-mini' }],
    ['  model:gpt-5.5-mini  ', { ok: true, kind: 'model', modelId: 'gpt-5.5-mini' }],
    ['model:profile:abc', { ok: false, reason: 'model-with-profile-prefix' }],
    ['model:profile:', { ok: false, reason: 'model-with-profile-prefix' }],
    ['profile:', { ok: false, reason: 'empty-profile-id' }],
    ['profile:   ', { ok: false, reason: 'empty-profile-id' }],
    ['profile:abc', { ok: true, kind: 'profile', profileId: 'abc' }],
    ['profile: abc ', { ok: true, kind: 'profile', profileId: 'abc' }],
    ['gpt-5.5-mini', { ok: true, kind: 'model', modelId: 'gpt-5.5-mini' }],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeStoredBtsModelValue(input)).toEqual(expected);
  });
});

describe('rejectionReasonLabel', () => {
  test.each([
    ['invalid-type', 'invalid type (not a string)'],
    ['empty-or-whitespace', 'empty or whitespace input'],
    ['empty-model-id', 'empty model id'],
    ['empty-profile-id', 'empty profile id'],
    ['model-with-profile-prefix', 'model value with profile prefix (model:profile:...)'],
  ] as const)('labels %s', (reason, label) => {
    expect(rejectionReasonLabel(reason)).toBe(label);
  });
});
