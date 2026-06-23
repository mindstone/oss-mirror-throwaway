export type ClipboardAttachmentPasteMode = 'none' | 'mixed' | 'attachment-only';

export function extractClipboardHtmlImageSources(html: string): string[] {
  if (!html.trim()) {
    return [];
  }

  const sources = new Set<string>();
  const imgSrcPattern = /<img\b[^>]*\bsrc=(['"])(.*?)\1/gi;

  for (const match of html.matchAll(imgSrcPattern)) {
    const src = match[2]?.trim();
    if (src) {
      sources.add(src);
    }
  }

  return Array.from(sources);
}

export function getClipboardAttachmentPasteMode(
  clipboardData: Pick<DataTransfer, 'items' | 'getData'>,
): ClipboardAttachmentPasteMode {
  const hasFiles = Array.from(clipboardData.items).some((item) => item.kind === 'file');
  const htmlImageSources = extractClipboardHtmlImageSources(clipboardData.getData('text/html'));

  if (!hasFiles && htmlImageSources.length === 0) {
    return 'none';
  }

  // Office and browser copies can include both a preview image and real text.
  // In that case we want both outcomes: let the text paste normally and also
  // hand the file payload to the attachment pipeline.
  const plainText = clipboardData.getData('text/plain').trim();
  return plainText.length === 0 ? 'attachment-only' : 'mixed';
}

export function shouldHandlePasteAsAttachment(
  clipboardData: Pick<DataTransfer, 'items' | 'getData'>,
): boolean {
  return getClipboardAttachmentPasteMode(clipboardData) === 'attachment-only';
}
