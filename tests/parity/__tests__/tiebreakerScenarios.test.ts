import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SessionSurfaceTag } from '@core/services/cloudSessionMergeService';
import { getConflictDetector } from '@core/services/conflictDetector';

type ScenarioName =
  | 'unresolvable-conflict-desktop-wins'
  | 'three-way-race-desktop-wins'
  | 'three-way-race-no-desktop'
  | 'tiebreaker-ineligible-field'
  | 'cli-surface';

type TiebreakerWrite = {
  surface: SessionSurfaceTag;
  field: string;
  value: unknown;
  changedAt: number;
};

type TiebreakerFixture = {
  name: string;
  tiebreaker: {
    scenario: ScenarioName;
    writes: TiebreakerWrite[];
    now: number;
    expected: {
      winnerSurface: SessionSurfaceTag;
      winnerValue: unknown;
      reason: 'within-race-window' | 'outside-race-window' | 'ineligible-field';
    };
  };
};

const fixtureDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'conversation-state',
);

const tiebreakerFixtureNames = [
  'cli-surface.json',
  'unresolvable-conflict-desktop-wins.json',
  'three-way-race-desktop-wins.json',
  'three-way-race-no-desktop.json',
  'tiebreaker-ineligible-field.json',
] as const;

function loadTiebreakerFixtures(): TiebreakerFixture[] {
  return tiebreakerFixtureNames.map((fileName) => {
    const raw = fs.readFileSync(path.join(fixtureDirectory, fileName), 'utf8');
    return JSON.parse(raw) as TiebreakerFixture;
  });
}

function runScenario(scenario: TiebreakerFixture['tiebreaker']): {
  winnerSurface: SessionSurfaceTag;
  winnerValue: unknown;
  reason: 'within-race-window' | 'outside-race-window' | 'ineligible-field';
} {
  const detector = getConflictDetector();
  let winner = scenario.writes[0];
  let reason: 'within-race-window' | 'outside-race-window' | 'ineligible-field' = 'outside-race-window';

  for (let index = 1; index < scenario.writes.length; index += 1) {
    const challenger = scenario.writes[index];
    const winnerIsDesktop = winner.surface === 'desktop';
    const challengerIsDesktop = challenger.surface === 'desktop';

    if (!winnerIsDesktop && !challengerIsDesktop) {
      winner = challenger;
      reason = 'outside-race-window';
      continue;
    }

    if (winnerIsDesktop && challengerIsDesktop) {
      winner = challenger;
      reason = 'outside-race-window';
      continue;
    }

    const desktopWrite = winnerIsDesktop ? winner : challenger;
    const otherWrite = winnerIsDesktop ? challenger : winner;
    const decision = detector.resolveSurfaceTiebreaker({
      sessionId: `fixture:${scenario.scenario}`,
      field: challenger.field,
      desktopWrite,
      otherWrite,
      now: scenario.now,
    });
    reason = decision.reason;
    winner = decision.winner === 'desktop' ? desktopWrite : challenger;
  }

  return {
    winnerSurface: winner.surface,
    winnerValue: winner.value,
    reason,
  };
}

describe('conversation-state parity tiebreaker scenarios', () => {
  it('loads exactly the five Stage 0.C + Stage 4.A tiebreaker fixtures', () => {
    expect(loadTiebreakerFixtures()).toHaveLength(5);
  });

  describe.each(loadTiebreakerFixtures())('$name', (fixture) => {
    it('matches expected desktop tiebreaker outcome', () => {
      expect(fixture.tiebreaker).toBeDefined();
      const result = runScenario(fixture.tiebreaker);
      expect(result).toEqual(fixture.tiebreaker.expected);
    });
  });
});
