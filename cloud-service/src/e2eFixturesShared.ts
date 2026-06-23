import type { AgentSession, AgentTurnMessage } from '@shared/types';
import { markSessionAsCloudActive } from '@core/services/cloudContinuityStateService';

import type { CloudServiceDeps } from './bootstrap';
import { cloudEventBroadcaster } from './cloudEventBroadcaster';
import { RouteError } from './httpUtils';

export const FIXED_E2E_TIMESTAMP = 1_700_000_000_000;
export const DEFAULT_E2E_SESSION_ID = 'e2e-seeded-conversation';
export const DEFAULT_E2E_TITLE = 'Seed conversation for Maestro';

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function normalizeSeedMessages(input: unknown, sessionId: string): AgentTurnMessage[] {
  if (input === undefined) {
    const turnId = `${sessionId}-turn-1`;
    return [
      {
        id: `${sessionId}-msg-1`,
        turnId,
        role: 'user',
        text: 'Seed conversation for Maestro',
        createdAt: FIXED_E2E_TIMESTAMP,
        messageOrigin: 'user-typed',
      },
      {
        id: `${sessionId}-msg-2`,
        turnId,
        role: 'assistant',
        text: 'Seeded reply for Maestro.',
        createdAt: FIXED_E2E_TIMESTAMP + 1,
      },
    ];
  }

  if (!Array.isArray(input)) {
    throw new RouteError('INVALID_BODY', { status: 400, message: 'messages must be an array when provided' });
  }

  return input.map((message, index): AgentTurnMessage => {
    if (!isPlainRecord(message)) {
      throw new RouteError('INVALID_BODY', { status: 400, message: 'messages must contain objects' });
    }
    const role = message.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'result') {
      throw new RouteError('INVALID_BODY', { status: 400, message: 'message.role must be user, assistant, or result' });
    }
    const text = nonEmptyString(message.text);
    if (text === null) {
      throw new RouteError('INVALID_BODY', { status: 400, message: 'message.text must be a non-empty string' });
    }

    return {
      id: nonEmptyString(message.id) ?? `${sessionId}-msg-${index + 1}`,
      turnId: nonEmptyString(message.turnId) ?? `${sessionId}-turn-1`,
      role,
      text,
      createdAt: finiteNumber(message.createdAt) ?? FIXED_E2E_TIMESTAMP + index,
    };
  });
}

export async function activateE2eSession(id: string): Promise<void> {
  await markSessionAsCloudActive(id);
  cloudEventBroadcaster.broadcast('cloud:session-changed', { sessionId: id, action: 'upserted' });
}

export async function ensureE2eSession(
  deps: Pick<CloudServiceDeps, 'getSession' | 'upsertSession'>,
  id: string,
  title = DEFAULT_E2E_TITLE,
): Promise<void> {
  const existing = await deps.getSession(id);
  if (existing) {
    await activateE2eSession(id);
    return;
  }

  const session: AgentSession = {
    id,
    title,
    createdAt: FIXED_E2E_TIMESTAMP,
    updatedAt: FIXED_E2E_TIMESTAMP,
    messages: normalizeSeedMessages(undefined, id),
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    // Active session (doneAt null = Active).
    doneAt: null,
    origin: 'manual',
  };

  await deps.upsertSession(session);
  await activateE2eSession(id);
}
