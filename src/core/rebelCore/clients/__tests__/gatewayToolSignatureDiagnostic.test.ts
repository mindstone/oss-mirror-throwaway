import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setTracker, type Tracker } from '@core/tracking';
import {
  classifyToolCallSignature,
  aggregateToolCallSignatures,
  aggregatePreClassifiedSignatures,
  emitGatewayToolSignatureObserved,
  GATEWAY_TOOL_SIGNATURE_EVENT,
  GATEWAY_TOOL_SIGNATURE_SCHEMA_VERSION,
  LITELLM_THOUGHT_ID_DELIMITER,
} from '../gatewayToolSignatureDiagnostic';
import { surfacesCustomGatewayToolSignature } from '../../providerFeatureGuards';

// A realistic-looking (but fake) signature value. The whole point of the
// diagnostic is that this VALUE never escapes into events/logs — the assertions
// below verify it is absent from every emitted property.
const FAKE_SIG = 'CioKChIQ-FAKE-THOUGHT-SIGNATURE-VALUE-MUST-NEVER-LEAK';

interface Captured {
  event: string;
  props?: Record<string, unknown>;
}

function installCapturingTracker(): { events: Captured[] } {
  const events: Captured[] = [];
  const tracker: Tracker = {
    track: (event, props) => {
      events.push({ event, props });
    },
    identify: () => {},
    getAnonymousId: () => 'anon',
    isAvailable: () => true,
  };
  setTracker(tracker);
  return { events };
}

const NOOP_TRACKER: Tracker = {
  track: () => {},
  identify: () => {},
  getAnonymousId: () => '',
  isAvailable: () => false,
};

afterEach(() => {
  setTracker(NOOP_TRACKER);
});

describe('classifyToolCallSignature', () => {
  it('detects litellm id-embedded signature', () => {
    const c = classifyToolCallSignature({ id: `call_abc123${LITELLM_THOUGHT_ID_DELIMITER}${FAKE_SIG}` });
    expect(c.idEmbedded).toBe(true);
    expect(c.providerSpecificFields).toBe(false);
    expect(c.extraContent).toBe(false);
    expect(c.any).toBe(true);
  });

  it('detects litellm provider_specific_fields signature', () => {
    const c = classifyToolCallSignature({
      id: 'call_abc123',
      provider_specific_fields: { thought_signature: FAKE_SIG },
    });
    expect(c.idEmbedded).toBe(false);
    expect(c.providerSpecificFields).toBe(true);
    expect(c.extraContent).toBe(false);
    expect(c.any).toBe(true);
  });

  it('detects Google extra_content signature', () => {
    const c = classifyToolCallSignature({
      id: 'call_abc123',
      extra_content: { google: { thought_signature: FAKE_SIG } },
    });
    expect(c.idEmbedded).toBe(false);
    expect(c.providerSpecificFields).toBe(false);
    expect(c.extraContent).toBe(true);
    expect(c.any).toBe(true);
  });

  it('returns all-false for a plain GPT-style id with no signature anywhere', () => {
    const c = classifyToolCallSignature({ id: 'call_abc123' });
    expect(c).toEqual({
      idEmbedded: false,
      providerSpecificFields: false,
      extraContent: false,
      any: false,
    });
  });

  it('treats an empty-string provider_specific_fields/extra_content as absent', () => {
    const c = classifyToolCallSignature({
      id: 'call_abc123',
      provider_specific_fields: { thought_signature: '' },
      extra_content: { google: { thought_signature: '' } },
    });
    expect(c.any).toBe(false);
  });
});

describe('aggregateToolCallSignatures', () => {
  it('counts each convention and any-signature across multiple tool-calls', () => {
    const agg = aggregateToolCallSignatures([
      { id: `call_1${LITELLM_THOUGHT_ID_DELIMITER}${FAKE_SIG}` }, // id-embedded
      { id: 'call_2', provider_specific_fields: { thought_signature: FAKE_SIG } }, // psf
      { id: 'call_3', extra_content: { google: { thought_signature: FAKE_SIG } } }, // extra_content
      { id: 'call_4' }, // none
    ]);
    expect(agg).toEqual({
      toolCallCount: 4,
      withIdEmbedded: 1,
      withProviderSpecificFields: 1,
      withExtraContent: 1,
      withAnySignature: 3,
    });
  });

  it('is empty for zero tool-calls', () => {
    expect(aggregateToolCallSignatures([])).toEqual({
      toolCallCount: 0,
      withIdEmbedded: 0,
      withProviderSpecificFields: 0,
      withExtraContent: 0,
      withAnySignature: 0,
    });
  });
});

describe('aggregatePreClassifiedSignatures', () => {
  it('counts pre-accumulated streaming flags', () => {
    const agg = aggregatePreClassifiedSignatures([
      { idEmbedded: true, providerSpecificFields: false, extraContent: false },
      { idEmbedded: false, providerSpecificFields: true, extraContent: true },
      { idEmbedded: false, providerSpecificFields: false, extraContent: false },
    ]);
    expect(agg).toEqual({
      toolCallCount: 3,
      withIdEmbedded: 1,
      withProviderSpecificFields: 1,
      withExtraContent: 1,
      withAnySignature: 2,
    });
  });
});

describe('emitGatewayToolSignatureObserved', () => {
  beforeEach(() => {
    setTracker(NOOP_TRACKER);
  });

  it('emits once with presence counts for a providerType:other response carrying a signature', () => {
    const { events } = installCapturingTracker();
    emitGatewayToolSignatureObserved({
      shouldEmit: surfacesCustomGatewayToolSignature('other'),
      providerType: 'other',
      provider: 'custom-gateway',
      modelId: 'gemini-2.5-pro',
      streaming: true,
      aggregate: aggregateToolCallSignatures([
        { id: 'call_1', provider_specific_fields: { thought_signature: FAKE_SIG } },
        { id: 'call_2' },
      ]),
    });

    expect(events).toHaveLength(1);
    const { event, props } = events[0];
    expect(event).toBe(GATEWAY_TOOL_SIGNATURE_EVENT);
    expect(props).toMatchObject({
      schemaVersion: GATEWAY_TOOL_SIGNATURE_SCHEMA_VERSION,
      providerType: 'other',
      provider: 'custom-gateway',
      modelId: 'gemini-2.5-pro',
      streaming: true,
      toolCallCount: 2,
      withIdEmbedded: 0,
      withProviderSpecificFields: 1,
      withExtraContent: 0,
      withAnySignature: 1,
    });
    // The raw signature VALUE must NEVER appear in any emitted property.
    const serialized = JSON.stringify(props);
    expect(serialized).not.toContain(FAKE_SIG);
  });

  it('does NOT emit for first-party providerType:openai (gating via the predicate)', () => {
    const { events } = installCapturingTracker();
    // The predicate gates first-party providers OUT — same data, but shouldEmit:false.
    expect(surfacesCustomGatewayToolSignature('openai')).toBe(false);
    emitGatewayToolSignatureObserved({
      shouldEmit: surfacesCustomGatewayToolSignature('openai'),
      providerType: 'openai',
      provider: 'openai',
      modelId: 'gpt-5.5',
      streaming: true,
      aggregate: aggregateToolCallSignatures([
        { id: 'call_1', provider_specific_fields: { thought_signature: FAKE_SIG } },
      ]),
    });
    expect(events).toHaveLength(0);
  });

  it('does NOT emit when there are no tool-calls', () => {
    const { events } = installCapturingTracker();
    emitGatewayToolSignatureObserved({
      shouldEmit: true,
      providerType: 'other',
      provider: 'custom-gateway',
      modelId: 'gemini-2.5-pro',
      streaming: false,
      aggregate: aggregateToolCallSignatures([]),
    });
    expect(events).toHaveLength(0);
  });

  it('is fail-open: a throwing tracker does not propagate', () => {
    const throwingTracker: Tracker = {
      track: () => {
        throw new Error('tracker boom');
      },
      identify: () => {},
      getAnonymousId: () => '',
      isAvailable: () => true,
    };
    setTracker(throwingTracker);
    expect(() =>
      emitGatewayToolSignatureObserved({
        shouldEmit: true,
        providerType: 'other',
        provider: 'custom-gateway',
        modelId: 'gemini-2.5-pro',
        streaming: false,
        aggregate: aggregateToolCallSignatures([{ id: 'call_1', extra_content: { google: { thought_signature: FAKE_SIG } } }]),
      }),
    ).not.toThrow();
  });
});
