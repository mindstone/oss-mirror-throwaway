import { describe, expect, it } from 'vitest';
import {
  extractMentionedUserIds,
  extractMessageText,
  type SlackBlock,
} from '../slackMentionParser';

function idsFromText(text: string): string[] {
  return [...extractMentionedUserIds({ text })].sort();
}

describe('slackMentionParser', () => {
  it('F1: returns an empty set for channel text without a bot mention', () => {
    expect(idsFromText('ordinary channel chatter')).toEqual([]);
  });

  it('F1: extracts a plain bot mention', () => {
    expect(idsFromText('<@UBOT> please help')).toEqual(['UBOT']);
  });

  it('F13: recovers prompt text from rich text blocks when event text is empty', () => {
    const blocks: SlackBlock[] = [{
      type: 'rich_text',
      elements: [
        { type: 'rich_text_section', elements: [{ type: 'text', text: 'First part' }] },
        { type: 'rich_text_section', elements: [{ type: 'text', text: 'second part' }] },
      ],
    }];

    expect(extractMessageText({ text: '', blocks })).toBe('First part\nsecond part');
  });

  it('F16: does not extract a mention inside inline backticks', () => {
    expect(idsFromText('literal `<@UBOT>` mention')).toEqual([]);
  });

  it('F16: does not extract a mention inside a triple-backtick fence', () => {
    expect(idsFromText('before ```\n<@UBOT>\n``` after')).toEqual([]);
  });

  it('F16: skips rich_text_preformatted blocks', () => {
    const blocks: SlackBlock[] = [{
      type: 'rich_text',
      elements: [
        { type: 'rich_text_preformatted', elements: [{ type: 'user', user_id: 'UBOT' }] },
      ],
    }];

    expect([...extractMentionedUserIds({ blocks })]).toEqual([]);
  });

  it('F17: extracts pretty-printed mention labels', () => {
    expect(idsFromText('<@UBOT|botname> please help')).toEqual(['UBOT']);
  });

  it('F18 parser baseline: mpim without mention has no extracted ids', () => {
    expect(idsFromText('hello group dm')).toEqual([]);
  });

  it('extracts block-only rich_text_section user mentions', () => {
    const blocks: SlackBlock[] = [{
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [
            { type: 'text', text: 'hi ' },
            { type: 'user', user_id: 'UBOT' },
          ],
        },
      ],
    }];

    expect([...extractMentionedUserIds({ blocks })]).toEqual(['UBOT']);
  });

  it('extracts mentions from rich_text_quote blocks', () => {
    const blocks: SlackBlock[] = [{
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_quote',
          elements: [
            { type: 'user', user_id: 'UQUOTE' },
          ],
        },
      ],
    }];

    expect([...extractMentionedUserIds({ blocks })]).toEqual(['UQUOTE']);
  });

  it('keeps mentions outside code and drops mentions inside code', () => {
    expect(idsFromText('<@UFOO> outside `<@UBAR>` inside')).toEqual(['UFOO']);
  });

  it('extracts multiple distinct mentions', () => {
    expect(idsFromText('<@UONE> <@UTWO|two> <@UTHREE>')).toEqual(['UONE', 'UTHREE', 'UTWO']);
  });

  it('deduplicates repeated mentions', () => {
    expect(idsFromText('<@UBOT> <@UBOT|bot> <@UBOT>')).toEqual(['UBOT']);
  });

  it('prefers non-empty text over block text', () => {
    const blocks: SlackBlock[] = [{
      type: 'rich_text',
      elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'block text' }] }],
    }];

    expect(extractMessageText({ text: 'event text', blocks })).toBe('event text');
  });
});
