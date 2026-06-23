import { describe, expect, it } from 'vitest'
import type { AgentSessionWithRuntime } from '../../../types'
import { createRuntimeState } from '../../../utils/runtimeState'
import { createSessionStore, stripRuntime } from '../../sessionStore'
import { createInitialConversationState } from '../conversationReducer'

describe('focusedTurnId stage-1 plumbing', () => {
  it('createInitialConversationState initializes focusedTurnId to null', () => {
    const state = createInitialConversationState()

    expect(state.focusedTurnId).toBeNull()
  })

  it('session store initial state initializes focusedTurnId to null', () => {
    const store = createSessionStore()

    expect(store.getState().focusedTurnId).toBeNull()
  })

  it('stripRuntime clears focusedTurnId from persisted snapshots', () => {
    const inMemorySession = {
      id: 'session-1',
      title: 'Session',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      eventsByTurn: {},
      activeTurnId: null,
      focusedTurnId: 'some-turn-id',
      isBusy: false,
      lastError: null,
      resolvedAt: null,
      runtime: createRuntimeState(),
      terminatedTurnIds: new Set<string>(),
    } as AgentSessionWithRuntime & { focusedTurnId: string | null }

    const persisted = stripRuntime(inMemorySession)
    const persistedFocused = (persisted as { focusedTurnId?: string | null }).focusedTurnId

    expect(persistedFocused ?? null).toBeNull()
    expect('focusedTurnId' in persisted).toBe(false)
  })
})
