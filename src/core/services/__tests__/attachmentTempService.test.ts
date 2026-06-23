import { describe, it, expect, vi, beforeEach } from 'vitest';
import _path from 'node:path';
import _fs from 'node:fs/promises';
import { resolveAttachmentSourcePath, cleanupTempAttachments } from '../attachmentTempService';
import type {
  ImageAttachmentPayload,
  TextFileAttachmentPayload,
  BinaryFileAttachmentPayload,
  AgentAttachmentPayload,
  OfficeDocumentAttachmentPayload,
} from '@shared/types';

vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/rebel-test-userdata',
  isPackaged: () => false,
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
}));

const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockReaddir = vi.fn().mockResolvedValue([]);
const mockStat = vi.fn();
const mockUnlink = vi.fn().mockResolvedValue(undefined);

vi.mock('node:fs/promises', () => ({
  default: {
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    readdir: (...args: unknown[]) => mockReaddir(...args),
    stat: (...args: unknown[]) => mockStat(...args),
    unlink: (...args: unknown[]) => mockUnlink(...args),
  },
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  readdir: (...args: unknown[]) => mockReaddir(...args),
  stat: (...args: unknown[]) => mockStat(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

describe('resolveAttachmentSourcePath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns originalPath for disk-backed image attachments', async () => {
    const attachment: ImageAttachmentPayload = {
      id: 'img-1',
      name: 'photo.png',
      type: 'image',
      mimeType: 'image/png',
      base64Data: 'aW1n',
      sizeBytes: 3,
      originalPath: '/Users/test/Downloads/photo.png',
    };

    const result = await resolveAttachmentSourcePath(attachment);
    expect(result).toBe('/Users/test/Downloads/photo.png');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('writes temp file for clipboard image (no originalPath)', async () => {
    const attachment: ImageAttachmentPayload = {
      id: 'img-2',
      name: 'screenshot.png',
      type: 'image',
      mimeType: 'image/png',
      base64Data: 'aW1n',
      sizeBytes: 3,
    };

    const result = await resolveAttachmentSourcePath(attachment);
    expect(result).toMatch(/temp-attachments/);
    expect(result).toMatch(/screenshot\.png$/);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it('returns path for workspace text attachments (AgentAttachmentPayload)', async () => {
    const attachment = {
      id: 'txt-1',
      name: 'notes.md',
      path: '/Users/test/workspace/notes.md',
      relativePath: 'notes.md',
      size: 100,
      content: '# Notes',
    } as AgentAttachmentPayload;

    const result = await resolveAttachmentSourcePath(attachment);
    expect(result).toBe('/Users/test/workspace/notes.md');
  });

  it('returns originalPath for binary file with disk path', async () => {
    const attachment: BinaryFileAttachmentPayload = {
      id: 'bin-1',
      name: 'archive.zip',
      type: 'binary',
      mimeType: 'application/zip',
      sizeBytes: 1000,
      originalPath: '/Users/test/Downloads/archive.zip',
    };

    const result = await resolveAttachmentSourcePath(attachment);
    expect(result).toBe('/Users/test/Downloads/archive.zip');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('writes temp file for clipboard binary (no originalPath)', async () => {
    const attachment: BinaryFileAttachmentPayload = {
      id: 'bin-2',
      name: 'data.bin',
      type: 'binary',
      mimeType: 'application/octet-stream',
      sizeBytes: 100,
      base64Data: 'YmluYXJ5',
    };

    const result = await resolveAttachmentSourcePath(attachment);
    expect(result).toMatch(/temp-attachments/);
    expect(result).toMatch(/data\.bin$/);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it('writes temp file for text file without originalPath', async () => {
    const attachment: TextFileAttachmentPayload = {
      id: 'tf-1',
      name: 'readme.md',
      type: 'textfile',
      mimeType: 'text/plain',
      content: '# Hello',
      originalSizeBytes: 7,
      contentSizeBytes: 7,
    };

    const result = await resolveAttachmentSourcePath(attachment);
    expect(result).toMatch(/temp-attachments/);
    expect(result).toMatch(/readme\.md$/);
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.any(String),
      '# Hello',
      'utf-8'
    );
  });

  it('returns originalPath for office doc with disk path', async () => {
    const attachment: OfficeDocumentAttachmentPayload = {
      id: 'off-1',
      name: 'report.docx',
      type: 'office',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extractedText: 'Report content...',
      originalSizeBytes: 5000,
      extractedSizeBytes: 100,
      officeType: 'word',
      originalPath: '/Users/test/Documents/report.docx',
    };

    const result = await resolveAttachmentSourcePath(attachment);
    expect(result).toBe('/Users/test/Documents/report.docx');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('returns undefined when no source can be determined', async () => {
    const attachment: BinaryFileAttachmentPayload = {
      id: 'bin-3',
      name: 'mystery.dat',
      type: 'binary',
      mimeType: 'application/octet-stream',
      sizeBytes: 100,
      // No originalPath, no base64Data
    };

    const result = await resolveAttachmentSourcePath(attachment);
    expect(result).toBeUndefined();
  });

  it('returns undefined on write error', async () => {
    mockWriteFile.mockRejectedValueOnce(new Error('Disk full'));

    const attachment: ImageAttachmentPayload = {
      id: 'img-err',
      name: 'photo.png',
      type: 'image',
      mimeType: 'image/png',
      base64Data: 'aW1n',
      sizeBytes: 3,
    };

    const result = await resolveAttachmentSourcePath(attachment);
    expect(result).toBeUndefined();
  });
});

describe('cleanupTempAttachments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes files older than 24 hours', async () => {
    const oldTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
    mockReaddir.mockResolvedValueOnce(['old-file.pdf']);
    mockStat.mockResolvedValueOnce({ mtimeMs: oldTime });

    const count = await cleanupTempAttachments();
    expect(count).toBe(1);
    expect(mockUnlink).toHaveBeenCalledTimes(1);
  });

  it('keeps recent files', async () => {
    const recentTime = Date.now() - 1 * 60 * 60 * 1000; // 1 hour ago
    mockReaddir.mockResolvedValueOnce(['recent-file.pdf']);
    mockStat.mockResolvedValueOnce({ mtimeMs: recentTime });

    const count = await cleanupTempAttachments();
    expect(count).toBe(0);
    expect(mockUnlink).not.toHaveBeenCalled();
  });
});
