import { describe, expect, it } from 'vitest';
import { buildToolDisplayName } from '../stagedToolCallsService';

describe('buildToolDisplayName', () => {
  const packageId = 'test-package';

  it('formats display name with to + subject', () => {
    expect(
      buildToolDisplayName(packageId, 'send_email', {
        to: 'alice@example.com',
        subject: 'Quarterly update',
      }),
    ).toBe('Send email to alice@example.com: "Quarterly update"');
  });

  it('formats display name with recipient alias', () => {
    expect(
      buildToolDisplayName(packageId, 'send_message', {
        recipient: '@rebel',
      }),
    ).toBe('Send message to @rebel');
  });

  it('formats display name with email alias', () => {
    expect(
      buildToolDisplayName(packageId, 'send_message', {
        email: '[Mindstone-email]',
      }),
    ).toBe('Send message to [Mindstone-email]');
  });

  it('formats display name with title alias', () => {
    expect(
      buildToolDisplayName(packageId, 'create_draft', {
        title: 'Weekly planning',
      }),
    ).toBe('Create draft: "Weekly planning"');
  });

  it('formats display name with name alias', () => {
    expect(
      buildToolDisplayName(packageId, 'create_folder', {
        name: 'Q2 Planning',
      }),
    ).toBe('Create folder: "Q2 Planning"');
  });

  it('falls back to package and cleaned tool id when no to/subject values are present', () => {
    expect(
      buildToolDisplayName(packageId, 'reply_to_thread', {
        channel: 'general',
      }),
    ).toBe('test-package - Reply to thread');
  });

  it('truncates subject values to 50 characters', () => {
    const longSubject = 'x'.repeat(51);
    expect(
      buildToolDisplayName(packageId, 'send_email', {
        subject: longSubject,
      }),
    ).toBe(`Send email: "${'x'.repeat(50)}"`);
  });

  it('converts underscores to spaces and capitalizes the tool id', () => {
    expect(buildToolDisplayName(packageId, 'send_email', {})).toBe('test-package - Send email');
  });

  it('deduplicates packageId when toolId starts with the package name', () => {
    const result = buildToolDisplayName('Slack-mindstone', 'Slack-mindstone_reply_to_slack_thread', {});
    expect(result).toBe('Reply to slack thread');
  });

  it('ignores non-string to/subject aliases and falls through to fallback', () => {
    expect(
      buildToolDisplayName(packageId, 'send_email', {
        to: 123,
        subject: false,
      }),
    ).toBe('test-package - Send email');

    expect(
      buildToolDisplayName(packageId, 'send_email', {
        recipient: true,
        title: ['roadmap'],
      }),
    ).toBe('test-package - Send email');

    expect(
      buildToolDisplayName(packageId, 'send_email', {
        email: ['[Mindstone-email]'],
        name: 42,
      }),
    ).toBe('test-package - Send email');
  });

  it('falls back with an empty args object', () => {
    expect(buildToolDisplayName(packageId, 'archive_message', {})).toBe('test-package - Archive message');
  });
});
