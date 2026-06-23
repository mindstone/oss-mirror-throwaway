import { describe, expect, it } from 'vitest';
import type { IframeMessageMethod } from '@shared/types/agent';
import { TRUST_POLICIES } from '../trustPolicies';

const knownMethods: IframeMessageMethod[] = [
  'ui/initialize',
  'ui/sendMessage',
  'ui/updateModelContext',
  'ui/resize',
  'tools/call',
];

describe('mcpAppsTrust TRUST_POLICIES', () => {
  it('has an exhaustive runtime entry for every iframe-host method', () => {
    expect(Object.keys(TRUST_POLICIES).sort()).toEqual([...knownMethods].sort());
  });

  it('permission-gates model-influencing updateModelContext', () => {
    expect(TRUST_POLICIES['ui/updateModelContext'].permissionScope).toBe('firstUse');
    expect(TRUST_POLICIES['ui/updateModelContext'].rateLimit).toMatchObject({
      iframe: 5,
      conversation: 20,
      session: 100,
    });
  });

  it('permission-gates model-influencing sendMessage', () => {
    expect(TRUST_POLICIES['ui/sendMessage'].permissionScope).toBe('firstUse');
    expect(TRUST_POLICIES['ui/sendMessage'].rateLimit).toMatchObject({
      iframe: 3,
      conversation: 10,
      session: 50,
    });
  });
});
