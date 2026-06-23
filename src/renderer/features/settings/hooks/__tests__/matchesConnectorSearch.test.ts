import { describe, it, expect } from 'vitest';
import { matchesConnectorSearch } from '../useUnifiedConnections';

describe('matchesConnectorSearch', () => {
  it('matches substring in name', () => {
    expect(
      matchesConnectorSearch(
        { name: 'Beeper (WhatsApp, iMessage & more)', description: 'messaging app' },
        'WhatsApp',
      ),
    ).toBe(true);
  });

  it('matches substring in description', () => {
    expect(
      matchesConnectorSearch(
        { name: 'Browser Automation', description: 'log in once to LinkedIn/WhatsApp/etc' },
        'WhatsApp',
      ),
    ).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(
      matchesConnectorSearch({ name: 'Beeper', description: 'whatsapp bridge' }, 'WHATSAPP'),
    ).toBe(true);
  });

  it('returns false when neither name nor description matches', () => {
    expect(
      matchesConnectorSearch({ name: 'Slack', description: 'Team messaging' }, 'WhatsApp'),
    ).toBe(false);
  });

  it('matches at the start of name', () => {
    expect(
      matchesConnectorSearch({ name: 'Notion', description: 'workspace' }, 'Not'),
    ).toBe(true);
  });

  it('handles empty description', () => {
    expect(
      matchesConnectorSearch({ name: 'Gmail', description: '' }, 'Gmail'),
    ).toBe(true);
  });
});
