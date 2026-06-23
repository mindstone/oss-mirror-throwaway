import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTurnMessage } from '@shared/types';
import { deriveConversationFromMessages, type ConversationState } from '@core/services/conversationState';
import * as rendererSelectors from '@renderer/features/agent-session/store/selectors';
import * as sharedVisibility from '@rebel/shared/utils/selectVisibleMessages';

interface ConversationStateFixture {
  name: string;
  input: AgentTurnMessage[];
  expected: {
    visibleIds: string[];
    messagesByTurnIds: Record<string, string[]>;
    activeTurnId: string | null;
    isBusy: boolean;
  };
}

interface ComparableConversationState {
  visibleIds: string[];
  messagesByTurnIds: Record<string, string[]>;
  activeTurnId: string | null;
  isBusy: boolean;
}

const fixturesDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'conversation-state',
);

const loadFixtures = (): ConversationStateFixture[] =>
  fs
    .readdirSync(fixturesDirectory)
    .filter(fileName => fileName.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b))
    .map((fileName) => {
      const raw = fs.readFileSync(path.join(fixturesDirectory, fileName), 'utf8');
      return JSON.parse(raw) as ConversationStateFixture;
    });

const toComparableState = (state: ConversationState): ComparableConversationState => ({
  visibleIds: state.visibleMessages.map(message => message.id),
  messagesByTurnIds: Object.fromEntries(
    [...state.messagesByTurn.entries()].map(([turnId, turnMessages]) => [
      turnId,
      turnMessages.map(message => message.id),
    ]),
  ),
  activeTurnId: state.activeTurnId,
  isBusy: state.isBusy,
});

const withVisibleSelector = (
  input: AgentTurnMessage[],
  selectVisibleMessages: (messages: AgentTurnMessage[]) => AgentTurnMessage[],
): ConversationState => {
  const baseState = deriveConversationFromMessages(input);
  return {
    ...baseState,
    visibleMessages: selectVisibleMessages(input),
  };
};

const rendererWrapper = (input: AgentTurnMessage[]): ConversationState =>
  withVisibleSelector(input, rendererSelectors.selectVisibleMessages);

const sharedWrapper = (input: AgentTurnMessage[]): ConversationState =>
  withVisibleSelector(input, sharedVisibility.selectVisibleMessages);

const coreWrapper = (input: AgentTurnMessage[]): ConversationState =>
  deriveConversationFromMessages(input);

const assertParityForFixture = (fixture: ConversationStateFixture): void => {
  const rendererState = toComparableState(rendererWrapper(fixture.input));
  const sharedState = toComparableState(sharedWrapper(fixture.input));
  const coreState = toComparableState(coreWrapper(fixture.input));

  expect(rendererState).toEqual(sharedState);
  expect(sharedState).toEqual(coreState);
  expect(coreState).toEqual(fixture.expected);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('conversationState parity', () => {
  it('loads 17 fixtures for Stage 0.A + Stage 4.A coverage', () => {
    expect(loadFixtures()).toHaveLength(17);
  });

  describe.each(loadFixtures())('$name', (fixture) => {
    it('produces byte-identical state across renderer/shared/core wrappers', () => {
      assertParityForFixture(fixture);
    });
  });

  it('fails when one wrapper is mutated (synthetic divergence check)', () => {
    const [fixture] = loadFixtures();
    const originalSelectVisible = sharedVisibility.selectVisibleMessages;

    vi.spyOn(sharedVisibility, 'selectVisibleMessages').mockImplementation((messages) => {
      const original = originalSelectVisible(messages);
      return original.length > 0 ? original.slice(1) : original;
    });

    expect(() => {
      assertParityForFixture(fixture);
    }).toThrow();
  });
});
