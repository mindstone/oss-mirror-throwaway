import { describe, it } from 'vitest';
import type { ErrorReporterCaptureContext, InternalCaptureContext } from '@core/errorReporter';

describe('ErrorReporter capture context types', () => {
  it('allows internal sentinel context construction and blocks public sentinel assignment', () => {
    const _internalContext: InternalCaptureContext = {
      _knownConditionWrapped: true,
      fingerprint: ['x', 'y'],
      level: 'warning',
      tags: { foo: 'bar' },
      extra: { z: 1 },
    };
    void _internalContext;

    const _publicContext: ErrorReporterCaptureContext = {
      fingerprint: ['x', 'y'],
      level: 'warning',
      tags: { foo: 'bar' },
      extra: { z: 1 },
    };
    void _publicContext;

    // @ts-expect-error _knownConditionWrapped is wrapper-internal and must not be set by public callers.
    const _invalidPublicContext: ErrorReporterCaptureContext = { _knownConditionWrapped: true };
    void _invalidPublicContext;
  });
});
