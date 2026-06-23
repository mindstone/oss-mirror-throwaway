import { describe, expect, it } from 'vitest';
import { isThirdPartyInitiative, isUserDirectedByThirdParty, isWinsLearningsSource } from '../inboxQualityPatterns';

describe('isThirdPartyInitiative', () => {
  it('matches "[Name] flagged" pattern', () => {
    expect(isThirdPartyInitiative('Liam flagged need for a proper discussion with Josh')).toBe(true);
  });

  it('matches "[Name] agreed both" pattern', () => {
    expect(isThirdPartyInitiative('Greg agreed both need deeper conversation')).toBe(true);
  });

  it('matches "[Name] proposed" pattern', () => {
    expect(isThirdPartyInitiative('Sarah proposed a new pricing model')).toBe(true);
  });

  it('does not match generic team discussion (no person name)', () => {
    expect(isThirdPartyInitiative('The team discussed pricing')).toBe(false);
  });

  it('does not match plain action text', () => {
    expect(isThirdPartyInitiative('Review the proposal')).toBe(false);
  });

  it('matches "[Name] suggested" pattern', () => {
    expect(isThirdPartyInitiative('Mike suggested we revisit the timeline')).toBe(true);
  });

  it('matches "[Name] will schedule" pattern', () => {
    expect(isThirdPartyInitiative('Emma will schedule the follow-up meeting')).toBe(true);
  });

  it('matches "[Name] plans to" pattern', () => {
    expect(isThirdPartyInitiative('Angus plans to call the lost prospect')).toBe(true);
  });

  it('matches "assigned to [Name]" pattern', () => {
    expect(isThirdPartyInitiative('This was assigned to James last week')).toBe(true);
  });

  it('matches "[Name]\'s responsibility" pattern', () => {
    expect(isThirdPartyInitiative("This is Sarah's responsibility going forward")).toBe(true);
  });

  it('does not match excluded words like "The" or "My"', () => {
    expect(isThirdPartyInitiative('The proposal was flagged by the system')).toBe(false);
    expect(isThirdPartyInitiative('My suggestion is to proceed')).toBe(false);
  });

  it('matches names that start with excluded prefixes (Theo, Allison, Noah)', () => {
    expect(isThirdPartyInitiative('Theo flagged a concern about the timeline')).toBe(true);
    expect(isThirdPartyInitiative('Allison proposed a different approach')).toBe(true);
    expect(isThirdPartyInitiative('Noah agreed to handle the migration')).toBe(true);
  });
});

describe('isUserDirectedByThirdParty', () => {
  it('matches "[Name] asked you to" pattern', () => {
    expect(isUserDirectedByThirdParty('Liam asked you to prepare the deck')).toBe(true);
  });

  it('matches "[Name] assigned you to" pattern', () => {
    expect(isUserDirectedByThirdParty('Sarah assigned you to handle the follow-up')).toBe(true);
  });

  it('does not match "[Name] flagged need" (not directed at user)', () => {
    expect(isUserDirectedByThirdParty('Liam flagged need for a discussion')).toBe(false);
  });

  it('matches "your task" pattern', () => {
    expect(isUserDirectedByThirdParty('This is your task to complete by Friday')).toBe(true);
  });

  it('matches "requested that you" pattern', () => {
    expect(isUserDirectedByThirdParty('Sarah requested that you review the brief')).toBe(true);
  });

  it('matches "delegated to you" pattern', () => {
    expect(isUserDirectedByThirdParty('The project was delegated to you')).toBe(true);
  });

  it('does not match generic action text', () => {
    expect(isUserDirectedByThirdParty('Review the quarterly report')).toBe(false);
  });
});

describe('isWinsLearningsSource', () => {
  it('matches common wins/learnings automation source variants', () => {
    expect(isWinsLearningsSource({ kind: 'automation', automationId: 'system-wins-learnings-uncover' })).toBe(true);
    expect(isWinsLearningsSource({ kind: 'automation', automationId: 'automation-wins-learnings-uncover--abc' })).toBe(true);
    expect(isWinsLearningsSource({ kind: 'automation', automationName: 'Wins & Learnings Coach' })).toBe(true);
    expect(isWinsLearningsSource({ kind: 'automation', automationName: 'Wins and Learnings Uncover' })).toBe(true);
    expect(isWinsLearningsSource({ kind: 'text', label: 'Daily wins/learnings automation' })).toBe(true);
  });

  it('does not match unrelated automation sources', () => {
    expect(isWinsLearningsSource({ kind: 'automation', automationName: 'Morning Triage' })).toBe(false);
    expect(isWinsLearningsSource({ kind: 'meeting', label: 'Company standup' })).toBe(false);
    expect(isWinsLearningsSource(undefined)).toBe(false);
  });
});
