import { describe, expect, it } from 'vitest';

import { bundledInboxBridgeStateReducer as mainReducer } from '../bundledInboxBridge';
import { bundledInboxBridgeStateReducer as coreReducer } from '@core/services/inbox/inboxBridgeStateMachine';

describe('bundledInboxBridge shim', () => {
  it('shares reducer reference with core state-machine source-of-truth', () => {
    expect(mainReducer).toBe(coreReducer);
  });
});
