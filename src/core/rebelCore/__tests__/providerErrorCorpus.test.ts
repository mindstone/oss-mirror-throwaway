import { describe, expect, it } from 'vitest';
import { classifyBillingSubtype } from '@shared/utils/friendlyErrors';
import { classifyHttpError } from '../modelErrors';
import { PROVIDER_ERROR_BODY_FIXTURES } from './__fixtures__/providerErrorBodies';

describe('provider error body corpus', () => {
  it.each(PROVIDER_ERROR_BODY_FIXTURES)(
    '$id ($provider $status $cause) classifies as $expected.kind',
    (fixture) => {
      const error = classifyHttpError(fixture.status, fixture.body, fixture.provider);

      expect(error.kind).toBe(fixture.expected.kind);

      if (fixture.expected.billingSubtype) {
        expect(classifyBillingSubtype(error.__rawMessage)).toBe(fixture.expected.billingSubtype);
      }
    },
  );
});
