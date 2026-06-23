/**
 * Parity guard: the IPC wire schema `OAuthSetupGuidanceSchema` must stay aligned with the core
 * single-source-of-truth interface `OAuthCredentialsNotConfigured`
 * (`src/core/services/oauthConnectorSetup.ts`).
 *
 * Single-source-of-truth decision (Stage 2): the CORE interface stays canonical. The Zod schema
 * deliberately widens `provider` to `z.string()` (the discriminated `SetupConnector` union is a
 * core-domain concern; on the wire any string connector id could arrive), so a strict
 * bidirectional type-equality assertion is the wrong tool here. Instead this test enforces the
 * two guarantees that actually matter for the IPC bridge:
 *   1. (runtime) every real `describeMissingOAuthCredentials(...)` value parses cleanly — proving
 *      the schema is not narrower than the core shape (no missing/extra-required field can drift in).
 *   2. (compile-time) a fresh core value is assignable to the schema-inferred type — proving the
 *      schema is not wider than core in a way the renderer (Stage 5) couldn't consume.
 * If either guarantee breaks (a renamed field, a flipped optional, a new required field), the
 * relevant assertion fails and the drift is caught before it crosses the preload bridge.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  describeMissingOAuthCredentials,
  setupConnectors,
  type OAuthCredentialsNotConfigured,
} from '@core/services/oauthConnectorSetup';
import { OAuthSetupGuidanceSchema } from '../common';

type SchemaGuidance = z.infer<typeof OAuthSetupGuidanceSchema>;

// Compile-time: a canonical core value must be assignable to the schema-inferred wire type. If core
// gains a field the schema lacks (or a field's optionality diverges in a renderer-breaking way),
// this `extends` resolves to `false` and `AssertAssignable` (which requires `true`) stops
// compiling. Pure type-level — emits NO runtime code, so it is safe under vitest's transform and
// is checked by tsc (lint:ts).
// eslint-disable-next-line @typescript-eslint/naming-convention -- compile-time assertion, not a runtime type
type AssertAssignable<_T extends true> = never;
// eslint-disable-next-line @typescript-eslint/naming-convention -- compile-time assertion, not a runtime type
type _CoreAssignableToWire = AssertAssignable<
  OAuthCredentialsNotConfigured extends SchemaGuidance ? true : false
>;

describe('OAuthSetupGuidanceSchema ↔ core OAuthCredentialsNotConfigured parity', () => {
  it('parses describeMissingOAuthCredentials() output for every in-scope connector', () => {
    for (const provider of setupConnectors) {
      const value = describeMissingOAuthCredentials(provider);
      const result = OAuthSetupGuidanceSchema.safeParse(value);
      expect(result.success, `parse failed for ${provider}: ${
        result.success ? '' : JSON.stringify(result.error.issues)
      }`).toBe(true);
      if (result.success) {
        // Parse must be lossless — the wire value equals the core value (incl. optional redirectNote).
        expect(result.data).toEqual(value);
      }
    }
  });

  it('round-trips a worker-topology connector through JSON + parse (survives the bridge)', () => {
    const value = describeMissingOAuthCredentials('slack');
    const roundTripped = OAuthSetupGuidanceSchema.parse(JSON.parse(JSON.stringify(value)));
    expect(roundTripped).toEqual(value);
    expect(roundTripped.code).toBe('oauth-credentials-not-configured');
    expect(roundTripped.envVars.length).toBeGreaterThan(0);
  });

  it('omits redirectNote for worker connectors and includes it for loopback connectors', () => {
    const slack = OAuthSetupGuidanceSchema.parse(describeMissingOAuthCredentials('slack'));
    expect(slack.redirectNote).toBeUndefined();
    expect(slack.redirectUris.length).toBe(1);

    const google = OAuthSetupGuidanceSchema.parse(describeMissingOAuthCredentials('google'));
    expect(google.redirectNote).toBeTypeOf('string');
    expect(google.redirectUris).toEqual([]);
  });
});
