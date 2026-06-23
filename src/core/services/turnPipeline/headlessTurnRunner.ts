/**
 * Headless Turn Runner
 *
 * Simple wrapper around executeAgentTurn for headless contexts.
 * Creates a turnId, registers the event listener on agentTurnRegistry,
 * calls executeAgentTurn, and cleans up in finally.
 *
 * Used by CLI commands, meeting analysis, bot Q&A, live coach, calendar sync,
 * and MCP server — all via dependency injection from index.ts.
 */

import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentSession } from '@shared/types';
import { assertNever } from '@shared/utils/assertNever';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import { LazyContextAccumulator } from '@core/services/lazyContextAccumulator';
import type { HeadlessTurnOptions } from '@core/types/headlessTurnOptions';
import type { IncrementalSessionStore } from '@core/services/incrementalSessionStore';
import type { OwnerKind } from '@core/services/superMcpOwnerRegistry';
import type { SessionLockManager } from '@core/utils/sessionFileLock';
import {
  CliSessionContentionError,
  CliSessionModifiedExternallyError,
  CliSessionPersistDroppedError,
  persistSessionFromCli,
} from './persistSessionFromCli';
import type { executeAgentTurn as executeAgentTurnFn } from './agentTurnExecute';

type ExecuteAgentTurn = typeof executeAgentTurnFn;

type CliSessionPersistenceDeps = {
  getSessionStore: () => IncrementalSessionStore;
  lockManager: SessionLockManager;
  ownerKind: OwnerKind;
  onSessionsSaved?: (sessions: AgentSession[]) => void | Promise<void>;
  onSessionsSavedLocally?: (sessions: AgentSession[]) => void | Promise<void>;
};

let cliSessionPersistenceDeps: CliSessionPersistenceDeps | null = null;
let headlessTurnExecutor: ExecuteAgentTurn | null = null;

export const configureHeadlessTurnExecutor = (executeAgentTurn: ExecuteAgentTurn): void => {
  headlessTurnExecutor = executeAgentTurn;
};

export const configureCliSessionPersistence = (deps: CliSessionPersistenceDeps): void => {
  cliSessionPersistenceDeps = deps;
};

export const runHeadlessTurn = async (params: {
  prompt: string;
  onEvent: (event: AgentEvent) => void;
  options: HeadlessTurnOptions;
}): Promise<void> => {
  if (params.options.persistMode.kind === 'cli-session' && params.options.sessionType !== 'cli') {
    throw new Error('Headless CLI session persistence requires sessionType "cli".');
  }
  if (!headlessTurnExecutor) {
    throw new Error('runHeadlessTurn requires configureHeadlessTurnExecutor() before use.');
  }

  const turnId = randomUUID();
  const localAccumulator = new LazyContextAccumulator(turnId, params.options.sessionId);
  const onEvent = (event: AgentEvent): void => {
    try {
      localAccumulator.appendEvent(event, params.options.sessionId);
    } catch {
      // Event delivery must remain best-effort; persistence will fail clearly if no snapshot exists.
    }
    params.onEvent(event);
  };
  agentTurnRegistry.setEventListener(turnId, onEvent);
  if (params.options.approvalHandler) {
    agentTurnRegistry.setApprovalHandler(turnId, params.options.approvalHandler);
  }
  try {
    await headlessTurnExecutor(null, turnId, params.prompt, {
      sessionId: params.options.sessionId,
      resetConversation: params.options.resetConversation,
      attachments: params.options.attachments,
      privateMode: params.options.privateMode,
      modelOverride: params.options.modelOverride,
      thinkingModelOverride: params.options.thinkingModelOverride,
      workingProfileOverrideId: params.options.workingProfileOverrideId,
      thinkingProfileOverrideId: params.options.thinkingProfileOverrideId,
      thinkingEffortOverride: params.options.thinkingEffortOverride,
      councilMode: params.options.councilMode,
      unleashedMode: params.options.unleashedMode,
      finishLine: params.options.finishLine,
      activeProviderOverride: params.options.activeProviderOverride,
      bypassToolSafety: params.options.bypassToolSafety,
      sessionType: params.options.sessionType,
      ...(params.options.policy ? { policyOverrides: params.options.policy } : {}),
    });
    if (params.options.persistMode.kind === 'cli-session') {
      if (!params.options.sessionId) {
        throw new Error('runHeadlessTurn: persistMode.kind === "cli-session" requires options.sessionId.');
      }
      if (!cliSessionPersistenceDeps) {
        throw new Error('runHeadlessTurn: persistMode.kind === "cli-session" requires CLI persistence deps to be configured via configureCliSessionPersistence().');
      }
      const snapshotShape = localAccumulator.getConversationShape();
      const snapshotRegistry = {
        getContextAccumulator: (requestedTurnId: string) =>
          requestedTurnId === turnId ? snapshotShape : undefined,
        getTurnPrompt: (requestedTurnId: string) =>
          requestedTurnId === turnId ? params.prompt : undefined,
      } as typeof agentTurnRegistry;
      const result = await persistSessionFromCli({
        turnId,
        sessionId: params.options.sessionId,
        store: cliSessionPersistenceDeps.getSessionStore(),
        lockManager: cliSessionPersistenceDeps.lockManager,
        ownerKind: cliSessionPersistenceDeps.ownerKind,
        registry: snapshotRegistry,
        resetConversation: params.options.resetConversation,
        onSessionsSaved: cliSessionPersistenceDeps.onSessionsSaved,
        onSessionsSavedLocally: cliSessionPersistenceDeps.onSessionsSavedLocally,
      });
      if ('kind' in result) {
        // Exhaustive by construction (260618 #17): every typed persist result that
        // is not the success `{ persistedSession }` branch MUST map to an explicit
        // error here, and must NOT fall through to emit `session_persisted` below.
        // A new `SessionPersist*Result` kind added to the union without a case here
        // fails to compile at `assertNever` — rather than silently inheriting one of
        // these errors, which is the trap that hid the contention kind before #17
        // (it used to land in the `modified_externally` fallback).
        switch (result.kind) {
          case 'session_persist_dropped':
            // store-refused write (tombstoned id, read-only, corrupt/forward-version index abort).
            throw new CliSessionPersistDroppedError(result);
          case 'session_persist_contention':
            throw new CliSessionContentionError(result);
          case 'session_modified_externally':
            throw new CliSessionModifiedExternallyError(result);
          default:
            assertNever(result, 'headlessTurnRunner: unhandled persist result kind');
        }
      }
      const sessionPersistedEvent = {
        type: 'session_persisted',
        sessionId: result.persistedSession.id,
        persistedAt: result.persistedSession.updatedAt,
        timestamp: Date.now(),
      };
      (params.onEvent as unknown as (event: typeof sessionPersistedEvent) => void)(sessionPersistedEvent);
    }
  } finally {
    agentTurnRegistry.deleteEventListener(turnId);
    agentTurnRegistry.deleteApprovalHandler(turnId);
  }
};
