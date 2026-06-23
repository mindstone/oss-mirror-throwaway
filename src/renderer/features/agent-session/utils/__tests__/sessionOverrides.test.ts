import { describe, expect, it } from 'vitest';
import {
  buildSessionModelOverrides,
  decodeSessionModelChoice,
  encodeSessionModelChoice,
  type SessionModelOverrideOptions,
  type SessionModelOverridePayload,
  type SessionModelOverrideStateSlice,
} from '../sessionOverrides';

const EMPTY_PAYLOAD: SessionModelOverridePayload = {
  modelOverride: undefined,
  thinkingModelOverride: undefined,
  workingProfileOverrideId: undefined,
  thinkingProfileOverrideId: undefined,
  thinkingEffortOverride: undefined,
};

describe('buildSessionModelOverrides', () => {
  it('returns undefined payload fields for state-only paths when all state fields are unset', () => {
    expect(buildSessionModelOverrides({})).toEqual(EMPTY_PAYLOAD);
  });

  it('mirrors state values for state-only paths when all fields are set', () => {
    expect(buildSessionModelOverrides({
      sessionWorkingModel: 'claude-sonnet-4-6',
      sessionThinkingModel: 'claude-opus-4-7',
      sessionWorkingProfileId: 'profile-working',
      sessionThinkingProfileId: 'profile-thinking',
      sessionThinkingEffort: 'xhigh',
    })).toEqual({
      modelOverride: 'claude-sonnet-4-6',
      thinkingModelOverride: 'claude-opus-4-7',
      workingProfileOverrideId: 'profile-working',
      thinkingProfileOverrideId: 'profile-thinking',
      thinkingEffortOverride: 'xhigh',
    });
  });

  it('collapses empty state thinking model in state-only Site A/C call style', () => {
    expect(buildSessionModelOverrides({ sessionThinkingModel: '' }).thinkingModelOverride).toBeUndefined();
  });

  it('uses state values when options-aware truthy-fallback fields are empty strings', () => {
    expect(buildSessionModelOverrides(
      {
        sessionWorkingModel: 'claude-sonnet-4-6',
        sessionThinkingModel: 'claude-opus-4-7',
        sessionWorkingProfileId: 'profile-working',
        sessionThinkingProfileId: 'profile-thinking',
      },
      {
        modelOverride: '',
        workingProfileOverrideId: '',
        thinkingProfileOverrideId: '',
      },
    )).toEqual({
      ...EMPTY_PAYLOAD,
      modelOverride: 'claude-sonnet-4-6',
      thinkingModelOverride: 'claude-opus-4-7',
      workingProfileOverrideId: 'profile-working',
      thinkingProfileOverrideId: 'profile-thinking',
    });
  });

  it('preserves empty options thinking model as explicit clear in Site B call style', () => {
    expect(buildSessionModelOverrides(
      { sessionThinkingModel: 'claude-opus-4-7' },
      { thinkingModelOverride: '' },
    ).thinkingModelOverride).toBe('');
  });

  it('falls through to state thinking model when options thinking model is undefined', () => {
    expect(buildSessionModelOverrides(
      { sessionThinkingModel: 'claude-opus-4-7' },
      { thinkingModelOverride: undefined },
    ).thinkingModelOverride).toBe('claude-opus-4-7');
  });

  it('preserves empty state thinking model for Site B when options parameter is undefined but call site passes options ?? {}', () => {
    const options = undefined as SessionModelOverrideOptions | undefined;

    expect(buildSessionModelOverrides(
      { sessionThinkingModel: '' },
      options ?? {},
    ).thinkingModelOverride).toBe('');
  });

  it('cross-checks that raw state-only call style still collapses empty state thinking model', () => {
    expect(buildSessionModelOverrides({ sessionThinkingModel: '' }).thinkingModelOverride).toBeUndefined();
  });

  it('keeps thinking effort state-only even if a caller supplies a runtime options value', () => {
    const optionsWithEffort = {
      thinkingEffortOverride: 'low',
    } as unknown as SessionModelOverrideOptions & { thinkingEffortOverride: 'low' };

    expect(buildSessionModelOverrides(
      { sessionThinkingEffort: 'high' },
      optionsWithEffort,
    ).thinkingEffortOverride).toBe('high');
  });

  it('uses || rather than ?? for the other options-aware fields', () => {
    expect(buildSessionModelOverrides(
      {
        sessionWorkingModel: 'claude-sonnet-4-6',
        sessionWorkingProfileId: 'profile-working',
        sessionThinkingProfileId: 'profile-thinking',
      },
      {
        modelOverride: '',
        workingProfileOverrideId: '',
        thinkingProfileOverrideId: '',
      },
    )).toEqual({
      ...EMPTY_PAYLOAD,
      modelOverride: 'claude-sonnet-4-6',
      workingProfileOverrideId: 'profile-working',
      thinkingProfileOverrideId: 'profile-thinking',
    });
  });

  it.each([
    {
      stateField: 'sessionWorkingModel',
      value: 'claude-sonnet-4-6',
      payloadField: 'modelOverride',
    },
    {
      stateField: 'sessionThinkingModel',
      value: 'claude-opus-4-7',
      payloadField: 'thinkingModelOverride',
    },
    {
      stateField: 'sessionWorkingProfileId',
      value: 'profile-working',
      payloadField: 'workingProfileOverrideId',
    },
    {
      stateField: 'sessionThinkingProfileId',
      value: 'profile-thinking',
      payloadField: 'thinkingProfileOverrideId',
    },
    {
      stateField: 'sessionThinkingEffort',
      value: 'medium',
      payloadField: 'thinkingEffortOverride',
    },
  ] as const)('maps only $stateField to $payloadField in state-only calls', ({ stateField, value, payloadField }) => {
    const state = { [stateField]: value } as SessionModelOverrideStateSlice;

    expect(buildSessionModelOverrides(state)).toEqual({
      ...EMPTY_PAYLOAD,
      [payloadField]: value,
    });
  });

  it.each([
    {
      optionField: 'modelOverride',
      value: 'claude-sonnet-4-6',
      payloadField: 'modelOverride',
    },
    {
      optionField: 'thinkingModelOverride',
      value: 'claude-opus-4-7',
      payloadField: 'thinkingModelOverride',
    },
    {
      optionField: 'workingProfileOverrideId',
      value: 'profile-working',
      payloadField: 'workingProfileOverrideId',
    },
    {
      optionField: 'thinkingProfileOverrideId',
      value: 'profile-thinking',
      payloadField: 'thinkingProfileOverrideId',
    },
  ] as const)('maps only $optionField to $payloadField in options-aware calls', ({ optionField, value, payloadField }) => {
    const options = { [optionField]: value } as SessionModelOverrideOptions;

    expect(buildSessionModelOverrides({}, options)).toEqual({
      ...EMPTY_PAYLOAD,
      [payloadField]: value,
    });
  });
});

describe('session ModelChoice adapters', () => {
  it('round-trips model overrides through ModelChoice', () => {
    const choice = decodeSessionModelChoice('claude-opus-4-7', undefined);
    expect(choice).toEqual({ kind: 'model', modelId: 'claude-opus-4-7' });
    expect(encodeSessionModelChoice(choice)).toEqual({
      model: 'claude-opus-4-7',
      profileId: undefined,
    });
  });

  it('round-trips profile overrides and preserves the resolved model', () => {
    const choice = decodeSessionModelChoice('gpt-5.5', 'profile-working');
    expect(choice).toEqual({ kind: 'profile', profileId: 'profile-working' });
    expect(encodeSessionModelChoice(choice, [{
      id: 'profile-working',
      name: 'Working profile',
      providerType: 'openai',
      serverUrl: 'https://example.test/v1',
      model: 'gpt-5.5',
      createdAt: 1,
    }])).toEqual({
      model: 'gpt-5.5',
      profileId: 'profile-working',
    });
  });

  it('maps off/global choices to cleared session override fields', () => {
    expect(encodeSessionModelChoice({ kind: 'off' })).toEqual({
      model: undefined,
      profileId: undefined,
    });
    expect(decodeSessionModelChoice(undefined, undefined)).toEqual({ kind: 'off' });
  });
});
