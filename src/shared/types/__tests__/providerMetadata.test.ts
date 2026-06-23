import { describe, expect, it } from 'vitest';
import {
  FulfillmentProviderSchema,
  FulfillmentReceiptSchema,
  FulfillmentServerHintsSchema,
  FULFILLMENT_SERVER_HINT_ALLOWLIST,
} from '../providerMetadata';

describe('providerMetadata schemas', () => {
  describe('FulfillmentServerHintsSchema (privacy boundary)', () => {
    it('accepts every allowlisted key', () => {
      const hints = Object.fromEntries(
        FULFILLMENT_SERVER_HINT_ALLOWLIST.map((k) => [k, 'value']),
      );
      expect(FulfillmentServerHintsSchema.safeParse(hints).success).toBe(true);
    });

    it('rejects an organization-id-like key', () => {
      const result = FulfillmentServerHintsSchema.safeParse({
        'anthropic-organization-id': 'org-leak-12345',
      });
      expect(result.success).toBe(false);
    });

    it('rejects authorization-style keys', () => {
      const result = FulfillmentServerHintsSchema.safeParse({ authorization: 'Bearer secret' });
      expect(result.success).toBe(false);
    });

    it('rejects mixed allowed + disallowed keys', () => {
      const result = FulfillmentServerHintsSchema.safeParse({
        'cf-ray': 'abc-123',
        'openai-organization': 'org-secret',
      });
      expect(result.success).toBe(false);
    });

    it('accepts an empty hints map', () => {
      expect(FulfillmentServerHintsSchema.safeParse({}).success).toBe(true);
    });

    it('accepts openai-processing-ms as an allowlisted server hint', () => {
      const result = FulfillmentServerHintsSchema.safeParse({
        'openai-processing-ms': '412',
      });
      expect(result.success).toBe(true);
    });

    it('rejects x-request-id as a non-allowlisted header', () => {
      const result = FulfillmentServerHintsSchema.safeParse({
        'x-request-id': 'req_123',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('FulfillmentProviderSchema', () => {
    it('parses a minimal OR sub-broker receipt', () => {
      const parsed = FulfillmentProviderSchema.parse({
        name: 'Fireworks',
        transport: 'openrouter',
        source: 'or-body',
      });
      expect(parsed.name).toBe('Fireworks');
    });

    it('accepts a null name (direct transport with no server-side provenance)', () => {
      const parsed = FulfillmentProviderSchema.parse({
        name: null,
        transport: 'anthropic-direct',
        source: 'unknown',
      });
      expect(parsed.name).toBeNull();
    });

    it('rejects unknown transport values', () => {
      const result = FulfillmentProviderSchema.safeParse({
        name: 'X',
        transport: 'mystery-transport',
        source: 'or-body',
      });
      expect(result.success).toBe(false);
    });

    it('refuses smuggled keys via serverHints', () => {
      const result = FulfillmentProviderSchema.safeParse({
        name: 'Fireworks',
        transport: 'openrouter',
        source: 'or-body',
        serverHints: { 'anthropic-organization-id': 'org-leak' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('FulfillmentReceiptSchema', () => {
    it('parses a multi-provider receipt with observation count', () => {
      const parsed = FulfillmentReceiptSchema.parse({
        provider: {
          name: 'DeepInfra',
          transport: 'openrouter',
          source: 'or-sse',
        },
        providersSeen: ['Fireworks', 'DeepInfra'],
        observationCount: 2,
      });
      expect(parsed.providersSeen).toEqual(['Fireworks', 'DeepInfra']);
    });

    it('allows a fully-unknown receipt (capture failed)', () => {
      const parsed = FulfillmentReceiptSchema.parse({
        provider: null,
        providersSeen: [],
        observationCount: 0,
      });
      expect(parsed.provider).toBeNull();
    });
  });
});
