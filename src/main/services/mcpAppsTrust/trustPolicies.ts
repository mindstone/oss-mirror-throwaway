import type { IframeMessageMethod } from '@shared/types/agent';

export type PermissionScopeMode = 'none' | 'firstUse' | 'allowlistOnly';

export interface TrustMethodPolicy {
  permissionScope: PermissionScopeMode;
  rateLimit: {
    iframe: number;
    conversation: number;
    session: number;
    aggregate?: number;
  };
  windowMs: number;
}

export const TRUST_POLICIES = {
  'ui/initialize': {
    permissionScope: 'none',
    rateLimit: { iframe: 30, conversation: 100, session: 500, aggregate: 500 },
    windowMs: 60_000,
  },
  'ui/sendMessage': {
    permissionScope: 'firstUse',
    rateLimit: { iframe: 3, conversation: 10, session: 50, aggregate: 50 },
    windowMs: 60_000,
  },
  'ui/updateModelContext': {
    permissionScope: 'firstUse',
    rateLimit: { iframe: 5, conversation: 20, session: 100, aggregate: 100 },
    windowMs: 60_000,
  },
  'ui/resize': {
    permissionScope: 'none',
    rateLimit: { iframe: 30, conversation: 100, session: 1000, aggregate: 500 },
    windowMs: 60_000,
  },
  'tools/call': {
    permissionScope: 'allowlistOnly',
    rateLimit: { iframe: 10, conversation: 50, session: 200, aggregate: 200 },
    windowMs: 60_000,
  },
} satisfies Record<IframeMessageMethod, TrustMethodPolicy>;
