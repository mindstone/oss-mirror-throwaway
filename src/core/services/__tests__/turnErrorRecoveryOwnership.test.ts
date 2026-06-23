import { describe, expect, it } from 'vitest';
import { AGENT_ERROR_KINDS, type AgentErrorKind } from '@shared/utils/agentErrorCatalog';
import { RECOVERY_OWNER_BY_KIND } from '../turnErrorRecoveryOwnership';

describe('RECOVERY_OWNER_BY_KIND', () => {
  it('keeps runtime keys aligned to AgentErrorKind', () => {
    const _compileOnlyExhaustive: Record<AgentErrorKind, (typeof RECOVERY_OWNER_BY_KIND)[AgentErrorKind]> =
      RECOVERY_OWNER_BY_KIND;
    void _compileOnlyExhaustive;

    expect(new Set(Object.keys(RECOVERY_OWNER_BY_KIND))).toEqual(new Set(AGENT_ERROR_KINDS));
  });

  it('routes network ownership to the transient retry owner, not server-error fallback', () => {
    expect(RECOVERY_OWNER_BY_KIND.network).toBe('alt_model_then_transient_retry');
  });
});
