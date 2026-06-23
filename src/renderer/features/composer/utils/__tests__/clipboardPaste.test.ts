import { describe, expect, it } from 'vitest';
import {
  getClipboardAttachmentPasteMode,
  shouldHandlePasteAsAttachment,
} from '../clipboardPaste';

type ClipboardLike = Pick<DataTransfer, 'items' | 'getData'>;

function createClipboardLike({
  itemKinds,
  plainText = '',
  html = '',
}: {
  itemKinds: Array<'file' | 'string'>;
  plainText?: string;
  html?: string;
}): ClipboardLike {
  return {
    items: itemKinds.map((kind) => ({ kind })) as unknown as DataTransferItemList,
    getData: (type: string) => {
      if (type === 'text/plain') return plainText;
      if (type === 'text/html') return html;
      return '';
    },
  };
}

describe('shouldHandlePasteAsAttachment', () => {
  it('returns none when the clipboard has no file items', () => {
    expect(
      getClipboardAttachmentPasteMode(
        createClipboardLike({ itemKinds: ['string'], plainText: 'Copied text' }),
      ),
    ).toBe('none');
  });

  it('returns attachment-only for file-only clipboard content', () => {
    expect(
      getClipboardAttachmentPasteMode(
        createClipboardLike({ itemKinds: ['file'], plainText: '' }),
      ),
    ).toBe('attachment-only');
  });

  it('returns mixed when clipboard includes both a file and meaningful plain text', () => {
    expect(
      getClipboardAttachmentPasteMode(
        createClipboardLike({
          itemKinds: ['file', 'string'],
          plainText: 'Pasted from a DOCX selection',
        }),
      ),
    ).toBe('mixed');
  });

  it('returns mixed when clipboard HTML includes an image alongside plain text', () => {
    expect(
      getClipboardAttachmentPasteMode(
        createClipboardLike({
          itemKinds: ['string'],
          plainText: 'Newsletter copy',
          html: '<p>Newsletter copy</p><img src="data:image/png;base64,abc123" />',
        }),
      ),
    ).toBe('mixed');
  });

  it('returns attachment-only when clipboard HTML only contains an image', () => {
    expect(
      getClipboardAttachmentPasteMode(
        createClipboardLike({
          itemKinds: ['string'],
          plainText: '',
          html: '<img src="data:image/png;base64,abc123" />',
        }),
      ),
    ).toBe('attachment-only');
  });

  it('returns false when the clipboard has no file items', () => {
    expect(
      shouldHandlePasteAsAttachment(
        createClipboardLike({ itemKinds: ['string'], plainText: 'Copied text' }),
      ),
    ).toBe(false);
  });

  it('returns true for file-only clipboard content', () => {
    expect(
      shouldHandlePasteAsAttachment(
        createClipboardLike({ itemKinds: ['file'], plainText: '' }),
      ),
    ).toBe(true);
  });

  it('returns false when clipboard includes a file and meaningful plain text', () => {
    expect(
      shouldHandlePasteAsAttachment(
        createClipboardLike({
          itemKinds: ['file', 'string'],
          plainText: 'Pasted from a DOCX selection',
        }),
      ),
    ).toBe(false);
  });

  it('treats whitespace-only plain text as no text payload', () => {
    expect(
      shouldHandlePasteAsAttachment(
        createClipboardLike({
          itemKinds: ['file', 'string'],
          plainText: '   \n\t  ',
        }),
      ),
    ).toBe(true);
  });
});
