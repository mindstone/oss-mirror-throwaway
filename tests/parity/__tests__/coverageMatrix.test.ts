import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentTurnMessage, MessageOrigin } from '@shared/types';

interface ConversationStateFixture {
  name: string;
  input: AgentTurnMessage[];
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

const REQUIRED_ROLES: ReadonlyArray<AgentTurnMessage['role']> = [
  'user',
  'assistant',
  'result',
];

const REQUIRED_MESSAGE_ORIGINS: ReadonlyArray<MessageOrigin> = [
  'system-continuation',
];

const EXEMPT_MESSAGE_ORIGINS: ReadonlySet<MessageOrigin> = new Set([
  'user-typed',
  'queue-drain',
  'voice',
  'automation',
]);

describe('parity fixture coverage matrix', () => {
  it('covers user/assistant/result roles at least once', () => {
    const fixtures = loadFixtures();
    const coveredRoles = new Set<AgentTurnMessage['role']>();

    for (const fixture of fixtures) {
      for (const message of fixture.input) {
        coveredRoles.add(message.role);
      }
    }

    for (const role of REQUIRED_ROLES) {
      expect(coveredRoles, `role ${role} missing from fixtures`).toSatisfy(
        (covered: Set<AgentTurnMessage['role']>) => covered.has(role),
      );
    }
  });

  it('covers the system-continuation MessageOrigin (drift fixture must remain)', () => {
    const fixtures = loadFixtures();
    const coveredOrigins = new Set<MessageOrigin>();

    for (const fixture of fixtures) {
      for (const message of fixture.input) {
        if (message.messageOrigin) coveredOrigins.add(message.messageOrigin);
      }
    }

    for (const origin of REQUIRED_MESSAGE_ORIGINS) {
      expect(
        coveredOrigins,
        `MessageOrigin '${origin}' is required (this is the drift Stage 0.A closes)`,
      ).toSatisfy((covered: Set<MessageOrigin>) => covered.has(origin));
    }
  });

  it('classifies every observed MessageOrigin as either required or explicitly exempt', () => {
    const fixtures = loadFixtures();
    const known = new Set<MessageOrigin>([
      ...REQUIRED_MESSAGE_ORIGINS,
      ...EXEMPT_MESSAGE_ORIGINS,
    ]);

    for (const fixture of fixtures) {
      for (const message of fixture.input) {
        if (!message.messageOrigin) continue;
        expect(
          known.has(message.messageOrigin),
          `Unknown MessageOrigin '${message.messageOrigin}' in fixture ${fixture.name} — ` +
            'add it to REQUIRED_MESSAGE_ORIGINS or EXEMPT_MESSAGE_ORIGINS so the coverage ' +
            'matrix reflects the deliberate classification.',
        ).toBe(true);
      }
    }
  });
});
