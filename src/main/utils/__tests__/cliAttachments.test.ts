import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_TEXT_FILE_SIZE_BYTES } from '@rebel/shared';
import { loadAttachmentsFromPaths } from '../cliAttachments';

 
vi.mock('unpdf', () => ({
  getDocumentProxy: vi.fn(async () => ({ totalPages: 2 })),
  extractText: vi.fn(async () => ({ totalPages: 2, text: 'Extracted PDF text' })),
}));

describe('loadAttachmentsFromPaths', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-cli-attachments-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const writeFile = async (name: string, contents: string | Buffer): Promise<string> => {
    const filePath = path.join(tmpDir, name);
    await fs.writeFile(filePath, contents);
    return filePath;
  };

  it('loads image attachments from disk', async () => {
    const filePath = await writeFile('image.png', Buffer.from('png-bytes'));

    const [attachment] = await loadAttachmentsFromPaths([filePath]);

    expect(attachment).toMatchObject({
      name: 'image.png',
      type: 'image',
      mimeType: 'image/png',
      originalPath: filePath,
    });
  });

  it('loads PDF document attachments from disk', async () => {
    const filePath = await writeFile('brief.pdf', Buffer.from('%PDF-1.4'));

    const [attachment] = await loadAttachmentsFromPaths([filePath]);

    expect(attachment).toMatchObject({
      name: 'brief.pdf',
      type: 'document',
      mimeType: 'application/pdf',
      originalPath: filePath,
    });
  });

  it('loads large PDFs as extracted-pdf attachments', async () => {
    const filePath = await writeFile('large.pdf', Buffer.from('%PDF-1.4'));
    const originalStat = fs.stat;
    vi.spyOn(fs, 'stat').mockImplementation(async (target) => {
      const stats = await originalStat(target);
      if (String(target).endsWith('large.pdf')) {
        return { ...stats, size: 26 * 1024 * 1024 } as Awaited<ReturnType<typeof fs.stat>>;
      }
      return stats;
    });

    const [attachment] = await loadAttachmentsFromPaths([filePath]);

    expect(attachment).toMatchObject({
      name: 'large.pdf',
      type: 'extracted-pdf',
      mimeType: 'application/pdf',
      extractedText: 'Extracted PDF text',
      pageCount: 2,
      originalPath: filePath,
    });
  });

  it('loads office attachments from RTF files', async () => {
    const filePath = await writeFile('notes.rtf', '{\\rtf1\\ansi Hello office text}');

    const [attachment] = await loadAttachmentsFromPaths([filePath]);

    expect(attachment).toMatchObject({
      name: 'notes.rtf',
      type: 'office',
      mimeType: 'application/rtf',
      extractedText: 'Hello office text',
      officeType: 'rtf',
      originalPath: filePath,
    });
  });

  it('loads text file attachments from disk', async () => {
    const filePath = await writeFile('notes.txt', 'hello from a text file');

    const [attachment] = await loadAttachmentsFromPaths([filePath]);

    expect(attachment).toMatchObject({
      name: 'notes.txt',
      type: 'textfile',
      mimeType: 'text/plain',
      content: 'hello from a text file',
      originalPath: filePath,
    });
  });

  it('loads binary attachments from disk', async () => {
    const filePath = await writeFile('archive.zip', Buffer.from([0, 1, 2, 3]));

    const [attachment] = await loadAttachmentsFromPaths([filePath]);

    expect(attachment).toMatchObject({
      name: 'archive.zip',
      type: 'binary',
      mimeType: 'application/zip',
      originalPath: filePath,
    });
  });

  it('fails oversized text files with a path-aware error', async () => {
    const filePath = await writeFile('huge.txt', 'tiny');
    const originalStat = fs.stat;
    vi.spyOn(fs, 'stat').mockImplementation(async (target) => {
      const stats = await originalStat(target);
      if (String(target).endsWith('huge.txt')) {
        return { ...stats, size: MAX_TEXT_FILE_SIZE_BYTES + 1 } as Awaited<ReturnType<typeof fs.stat>>;
      }
      return stats;
    });

    await expect(loadAttachmentsFromPaths([filePath])).rejects.toThrow(filePath);
  });

  it('fails unsupported HEIC images with a path-aware error', async () => {
    const filePath = await writeFile('photo.heic', Buffer.from('heic'));

    await expect(loadAttachmentsFromPaths([filePath])).rejects.toThrow(filePath);
  });
});
