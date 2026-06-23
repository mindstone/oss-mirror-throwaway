import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetNonceManagerForTests,
  invalidateForConversation,
  invalidateForIframeInstance,
  invalidateForSession,
  issueNonce,
  validateAndConsume,
  validateNonce,
  type NonceScope,
} from '../nonceManager';

const scope: NonceScope = {
  sourcePackageId: 'GoogleWorkspace-joshua-example-com',
  sessionId: 'session-1',
  conversationId: 'conversation-1',
  toolUseId: 'tool-1',
  iframeInstanceId: 'iframe-1',
};

describe('mcpAppsTrust nonceManager', () => {
  beforeEach(() => {
    _resetNonceManagerForTests();
  });

  it('issues and validates a nonce for the exact scope', () => {
    const nonce = issueNonce(scope);

    expect(nonce).toMatch(/^[0-9a-f-]{36}$/iu);
    expect(validateNonce(scope, nonce)).toBe(true);
    expect(validateNonce({ ...scope, iframeInstanceId: 'iframe-2' }, nonce)).toBe(false);
  });

  it('consumes a nonce on successful validation', () => {
    const nonce = issueNonce(scope);

    expect(validateAndConsume(scope, nonce)).toBe(true);
    expect(validateAndConsume(scope, nonce)).toBe(false);
    expect(validateNonce(scope, nonce)).toBe(false);
  });

  it('replaces the active nonce when reissued for the same scope', () => {
    const first = issueNonce(scope);
    const second = issueNonce(scope);

    expect(validateNonce(scope, first)).toBe(false);
    expect(validateNonce(scope, second)).toBe(true);
  });

  it('invalidates by conversation, session, and iframe instance', () => {
    const conversationNonce = issueNonce(scope);
    invalidateForConversation(scope.conversationId);
    expect(validateNonce(scope, conversationNonce)).toBe(false);

    const sessionNonce = issueNonce(scope);
    invalidateForSession(scope.sessionId);
    expect(validateNonce(scope, sessionNonce)).toBe(false);

    const iframeNonce = issueNonce(scope);
    invalidateForIframeInstance(scope.iframeInstanceId);
    expect(validateNonce(scope, iframeNonce)).toBe(false);
  });
});
