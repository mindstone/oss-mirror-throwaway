import { describe, expect, it } from 'vitest';

import {
  COMPACTION_POLICY_FROM_MANIFEST,
  policyFor as zodPolicyFor,
} from '@shared/contracts/agentEventManifest';
import {
  COMPACTION_POLICY_FROM_POLICY_MANIFEST,
  policyFor as policyOnlyPolicyFor,
} from '@shared/contracts/agentEventPolicyManifest';

type ZodManifestVariant = keyof typeof COMPACTION_POLICY_FROM_MANIFEST;
type PolicyManifestVariant = keyof typeof COMPACTION_POLICY_FROM_POLICY_MANIFEST;
type ManifestVariant = ZodManifestVariant & PolicyManifestVariant;

const VARIANTS = Object.keys(COMPACTION_POLICY_FROM_MANIFEST) as ManifestVariant[];

const EXPECTED_POLICY_AXES = [
  'type',
  'compactionPolicy',
  'sanitization',
  'runtimeEffect',
  'uiVisibility',
  'modelContextVisibility',
  'producerSurface',
  'legacyCompatibility',
  'unknownRuntimePolicy',
  'telemetryPolicy',
  'errorClassPolicy',
  'envelope',
] as const;

describe('policyFor lookup parity', () => {
  describe('all 31 variants resolve in both manifests', () => {
    it.each(VARIANTS)('%s', (variant) => {
      const zodEntry = zodPolicyFor(variant);
      const policyOnlyEntry = policyOnlyPolicyFor(variant);

      expect(zodEntry).toBeDefined();
      expect(policyOnlyEntry).toBeDefined();

      if (!zodEntry || !policyOnlyEntry) {
        throw new Error(`Missing policy entry for variant "${variant}"`);
      }

      for (const axis of EXPECTED_POLICY_AXES) {
        expect(zodEntry).toHaveProperty(axis);
        expect(policyOnlyEntry).toHaveProperty(axis);
      }

      expect(Array.isArray(zodEntry.envelope.requiredForNewEvents)).toBe(true);
      expect(Array.isArray(policyOnlyEntry.envelope.requiredForNewEvents)).toBe(true);
    });
  });

  describe('per-axis parity between Zod-bearing and Zod-free entries (excluding payloadSchema)', () => {
    it.each(VARIANTS)('%s', (variant) => {
      const zodEntry = zodPolicyFor(variant);
      const policyOnlyEntry = policyOnlyPolicyFor(variant);

      expect(zodEntry).toBeDefined();
      expect(policyOnlyEntry).toBeDefined();

      if (!zodEntry || !policyOnlyEntry) {
        throw new Error(`Missing policy entry for variant "${variant}"`);
      }

      const { payloadSchema: _payloadSchema, ...zodAxes } = zodEntry;
      expect(zodAxes).toEqual(policyOnlyEntry);
    });
  });

  it('unknown variant returns undefined in both lookups', () => {
    const unknownVariant = 'definitely-not-a-real-variant' as unknown as ManifestVariant;

    expect(zodPolicyFor(unknownVariant)).toBeUndefined();
    expect(policyOnlyPolicyFor(unknownVariant)).toBeUndefined();
  });
});
