import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSession } from '@shared/types';
import {
  mergeSessionTurns,
  stripConversationAnnotations,
} from '../cloudRouterHelpers';

const { mockWarn } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    warn: mockWarn,
  }),
}));

const makeSession = (overrides: Partial<AgentSession> = {}): AgentSession => ({
  id: 'session-1',
  title: 'Annotated session',
  createdAt: 1_000,
  updatedAt: 2_000,
  messages: [],
  eventsByTurn: {},
  activeTurnId: null,
  isBusy: false,
  lastError: null,
  resolvedAt: null,
  annotations: [{
    id: 'ann-1',
    messageId: 'msg-1',
    text: 'selected text',
    comment: 'private comment',
    createdAt: 2_000,
    startOffset: 0,
    endOffset: 13,
  }],
  ...overrides,
});

beforeEach(() => {
  mockWarn.mockClear();
});

describe('cloudRouterHelpers annotation stripping', () => {
  it('removes pending conversation annotations from cloud-bound sessions with an observable warning', () => {
    const stripped = stripConversationAnnotations(makeSession());

    expect(stripped).not.toHaveProperty('annotations');
    expect(stripped.id).toBe('session-1');
    expect(stripped.messages).toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith(
      { sessionId: 'session-1', annotationCount: 1 },
      'stripConversationAnnotations: cloud-bound session unexpectedly carried annotations; stripping (this indicates a non-stripping client or contract violation)',
    );
  });

  it('preserves local annotations when reverse-merging a cloud session without annotations', () => {
    const local = makeSession({
      messages: [{
        id: 'msg-1',
        turnId: 'turn-1',
        role: 'assistant',
        text: 'local reply',
        createdAt: 1_500,
      }],
      eventsByTurn: { 'turn-1': [] },
    });
    const cloud = makeSession({
      annotations: undefined,
      messages: [
        {
          id: 'msg-1',
          turnId: 'turn-1',
          role: 'assistant',
          text: 'local reply',
          createdAt: 1_500,
        },
        {
          id: 'msg-2',
          turnId: 'turn-2',
          role: 'assistant',
          text: 'cloud-only reply',
          createdAt: 2_500,
        },
      ],
      eventsByTurn: { 'turn-1': [], 'turn-2': [] },
      updatedAt: 3_000,
    });

    const merged = mergeSessionTurns(local, cloud);

    expect(merged?.annotations).toEqual(local.annotations);
    expect(merged?.messages.map((message) => message.id)).toEqual([
      'msg-1',
      'msg-2',
    ]);
  });

  it('keeps annotation stripping wired at the outbox, direct-push, and migration chokepoints', () => {
    const cloudDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
    );
    const outboxSource = fs.readFileSync(
      path.join(cloudDir, 'cloudOutbox.ts'),
      'utf8',
    );
    const routerSource = fs.readFileSync(
      path.join(cloudDir, 'cloudRouter.ts'),
      'utf8',
    );
    const migrationSource = fs.readFileSync(
      path.join(cloudDir, 'cloudMigrationService.ts'),
      'utf8',
    );

    expect(outboxSource).toMatch(
      /const sessionToSend = stripConversationAnnotations\(sessionWithoutDesktopOnlyFields as AgentSession\)/,
    );
    expect(routerSource).toMatch(
      /pushFullSessionWithCapabilityGate\(client, stripConversationAnnotations\(session\)\)/,
    );
    expect(migrationSource).toMatch(
      /client\.put\([\s\S]*stripConversationAnnotations\(session\),[\s\S]*\)/,
    );
  });
});
