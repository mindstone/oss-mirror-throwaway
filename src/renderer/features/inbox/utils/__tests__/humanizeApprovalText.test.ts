import { describe, expect, it } from 'vitest';
import { humanizeApprovalText } from '../humanizeApprovalText';

describe('humanizeApprovalText', () => {
  it('produces meeting-template action text and participant context line', () => {
    const result = humanizeApprovalText(
      {
        description: 'Q3 quarterly review',
        sourceType: 'meeting',
        participants: ['Jane Smith', 'Bob Chen', 'Carol Davis'],
        occurredAt: '2026-04-18',
      },
      'Mindstone General',
    );
    expect(result).toEqual({
      actionText: 'Share Q3 quarterly review meeting notes with your Mindstone General space?',
      contextLine: 'From a meeting with Jane Smith, Bob Chen, and Carol Davis on 18 Apr',
    });
  });

  it('formats two participants with "and"', () => {
    const result = humanizeApprovalText(
      {
        description: '1:1 catch-up',
        sourceType: 'meeting',
        participants: ['Jane Smith', 'Bob Chen'],
        occurredAt: '2026-04-18',
      },
      'Chief-of-Staff',
    );
    expect(result?.contextLine).toBe('From a meeting with Jane Smith and Bob Chen on 18 Apr');
  });

  it('formats a single participant without commas', () => {
    const result = humanizeApprovalText(
      {
        description: 'Solo review',
        sourceType: 'meeting',
        participants: ['Jane Smith'],
        occurredAt: '2026-04-18',
      },
      'Chief-of-Staff',
    );
    expect(result?.contextLine).toBe('From a meeting with Jane Smith on 18 Apr');
  });

  it('omits participants segment when none are provided', () => {
    const result = humanizeApprovalText(
      {
        description: 'Quick sync',
        sourceType: 'meeting',
        occurredAt: '2026-04-18',
      },
      'Chief-of-Staff',
    );
    expect(result?.contextLine).toBe('From a meeting on 18 Apr');
  });

  it('produces email-template action text and context line', () => {
    const result = humanizeApprovalText(
      {
        description: 'Client proposal discussion',
        sourceType: 'email',
        occurredAt: '2026-04-18',
      },
      'Sales',
    );
    expect(result).toEqual({
      actionText: 'Share Client proposal discussion email thread with your Sales space?',
      contextLine: 'Email thread from 18 Apr',
    });
  });

  it('produces thread-template action text', () => {
    const result = humanizeApprovalText(
      {
        description: 'Architecture discussion',
        sourceType: 'thread',
        occurredAt: '2026-04-18',
      },
      'Engineering',
    );
    expect(result?.actionText).toBe(
      'Share Architecture discussion thread with your Engineering space?',
    );
    expect(result?.contextLine).toBe('Captured on 18 Apr');
  });

  it('produces doc-template action text for pdf', () => {
    const result = humanizeApprovalText(
      {
        description: 'Annual report',
        sourceType: 'pdf',
        occurredAt: '2026-04-20',
      },
      'Mindstone General',
    );
    expect(result?.actionText).toBe(
      'Share Annual report with your Mindstone General space?',
    );
    expect(result?.contextLine).toBe('Captured on 20 Apr');
  });

  it('returns null when description is missing', () => {
    expect(
      humanizeApprovalText({ sourceType: 'meeting', occurredAt: '2026-04-18' }, 'Sales'),
    ).toBeNull();
  });

  it('returns null when sourceType is missing', () => {
    expect(
      humanizeApprovalText({ description: 'Something', occurredAt: '2026-04-18' }, 'Sales'),
    ).toBeNull();
  });

  it('returns null when spaceName is empty', () => {
    expect(
      humanizeApprovalText(
        { description: 'Something', sourceType: 'meeting', occurredAt: '2026-04-18' },
        '',
      ),
    ).toBeNull();
  });

  it('returns null for unknown source types', () => {
    expect(
      humanizeApprovalText(
        { description: 'Something', sourceType: 'widget', occurredAt: '2026-04-18' },
        'Sales',
      ),
    ).toBeNull();
  });

  it('omits the context line when occurredAt is missing and no participants', () => {
    const result = humanizeApprovalText(
      {
        description: 'Something',
        sourceType: 'email',
      },
      'Sales',
    );
    expect(result).toEqual({
      actionText: 'Share Something email thread with your Sales space?',
    });
  });

  it('still produces participants context when date is missing', () => {
    const result = humanizeApprovalText(
      {
        description: 'Something',
        sourceType: 'meeting',
        participants: ['Jane', 'Bob'],
      },
      'Sales',
    );
    expect(result?.contextLine).toBe('From a meeting with Jane and Bob');
  });

  it('safely ignores malformed occurredAt', () => {
    const result = humanizeApprovalText(
      {
        description: 'Something',
        sourceType: 'email',
        occurredAt: 'not-a-date',
      },
      'Sales',
    );
    expect(result?.contextLine).toBeUndefined();
  });
});
