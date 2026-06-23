import { randomUUID } from 'node:crypto';

export interface NonceScope {
  sourcePackageId: string;
  sessionId: string;
  conversationId: string;
  toolUseId: string;
  iframeInstanceId: string;
}

function nonceKey(scope: NonceScope): string {
  return [
    scope.sourcePackageId,
    scope.sessionId,
    scope.conversationId,
    scope.toolUseId,
    scope.iframeInstanceId,
  ].join('\u0000');
}

const activeNonces = new Map<string, { scope: NonceScope; nonce: string }>();

export function issueNonce(scope: NonceScope): string {
  const nonce = randomUUID();
  activeNonces.set(nonceKey(scope), { scope: { ...scope }, nonce });
  return nonce;
}

export function validateNonce(scope: NonceScope, nonce: string): boolean {
  const active = activeNonces.get(nonceKey(scope));
  return active?.nonce === nonce;
}

export function validateAndConsume(scope: NonceScope, nonce: string): boolean {
  const key = nonceKey(scope);
  const active = activeNonces.get(key);
  if (active?.nonce !== nonce) {
    return false;
  }
  activeNonces.delete(key);
  return true;
}

export function invalidateForConversation(conversationId: string): void {
  for (const [key, entry] of activeNonces) {
    if (entry.scope.conversationId === conversationId) {
      activeNonces.delete(key);
    }
  }
}

export function invalidateForSession(sessionId: string): void {
  for (const [key, entry] of activeNonces) {
    if (entry.scope.sessionId === sessionId) {
      activeNonces.delete(key);
    }
  }
}

export function invalidateForIframeInstance(iframeInstanceId: string): void {
  for (const [key, entry] of activeNonces) {
    if (entry.scope.iframeInstanceId === iframeInstanceId) {
      activeNonces.delete(key);
    }
  }
}

export function _resetNonceManagerForTests(): void {
  activeNonces.clear();
}
