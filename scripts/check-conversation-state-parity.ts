#!/usr/bin/env npx tsx

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveConversationFromMessages, isMessageHidden as isCoreMessageHidden } from '../src/core/services/conversationState';
import { isMessageHidden as isSharedMessageHidden, selectVisibleMessages } from '../packages/shared/src/utils/selectVisibleMessages';
import type { AgentTurnMessage } from '../src/shared/types';

interface ConversationStateFixture {
  name: string;
  input: AgentTurnMessage[];
}

const fixturesDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'tests',
  'parity',
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

const formatIds = (messages: readonly AgentTurnMessage[]): string =>
  messages.map(message => message.id).join(', ');

function main(): void {
  const fixtures = loadFixtures();
  const mismatches: string[] = [];

  for (const fixture of fixtures) {
    const coreVisible = deriveConversationFromMessages(fixture.input).visibleMessages;
    const sharedVisible = selectVisibleMessages(fixture.input);

    if (formatIds(coreVisible) !== formatIds(sharedVisible)) {
      mismatches.push(
        `[${fixture.name}] visible mismatch\n  core:   ${formatIds(coreVisible)}\n  shared: ${formatIds(sharedVisible)}`,
      );
    }

    for (const message of fixture.input) {
      const coreHidden = isCoreMessageHidden(message);
      const sharedHidden = isSharedMessageHidden(message);
      if (coreHidden !== sharedHidden) {
        mismatches.push(
          `[${fixture.name}] isMessageHidden mismatch for "${message.id}"\n  core: ${String(coreHidden)}\n  shared: ${String(sharedHidden)}`,
        );
      }
    }
  }

  if (mismatches.length > 0) {
    console.error('Conversation-state parity check failed.');
    for (const mismatch of mismatches) {
      console.error(`- ${mismatch}`);
    }
    process.exit(1);
  }

  console.log(`Conversation-state parity check passed (${fixtures.length} fixtures).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export { loadFixtures };
