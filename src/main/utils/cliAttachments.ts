import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import type {
  AnyAttachmentPayload,
  BinaryFileAttachmentPayload,
  DocumentAttachmentPayload,
  ExtractedPdfAttachmentPayload,
  ImageAttachmentMimeType,
  ImageAttachmentPayload,
  OfficeDocumentAttachmentPayload,
  OfficeDocumentMimeType,
  TextFileAttachmentPayload,
} from '@shared/types';
import {
  MAX_EXTRACTED_TEXT_BYTES,
  MAX_TEXT_FILE_SIZE_BYTES,
  isTextBasedFile,
} from '@rebel/shared';
import { estimateBase64Bytes } from '@rebel/shared';
import {
  MAX_BINARY_SIZE_BYTES,
  MAX_OFFICE_EXTRACTED_BYTES,
  MAX_PDF_SIZE_BYTES,
  validateAndFilterAttachments,
} from './attachmentValidation';

const PDF_EXTRACTION_THRESHOLD_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_OFFICE_SIZE_BYTES = 50 * 1024 * 1024;

const IMAGE_MIME_BY_EXT: Record<string, ImageAttachmentMimeType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const OFFICE_MIME_BY_EXT: Record<string, OfficeDocumentMimeType> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.rtf': 'application/rtf',
};

const MIME_BY_EXT: Record<string, string> = {
  ...IMAGE_MIME_BY_EXT,
  ...OFFICE_MIME_BY_EXT,
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.zip': 'application/zip',
};

const detectMimeType = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
};

const resolveOriginalSizeCap = (filePath: string, mimeType: string): number => {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_MIME_BY_EXT[ext]) return MAX_IMAGE_SIZE_BYTES;
  if (mimeType === 'application/pdf') return MAX_PDF_SIZE_BYTES;
  if (OFFICE_MIME_BY_EXT[ext]) return MAX_OFFICE_SIZE_BYTES;
  if (isTextBasedFile(path.basename(filePath), mimeType)) return MAX_TEXT_FILE_SIZE_BYTES;
  return MAX_BINARY_SIZE_BYTES;
};

const officeTypeForMime = (mimeType: OfficeDocumentMimeType): OfficeDocumentAttachmentPayload['officeType'] => {
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/msword'
  ) {
    return 'word';
  }
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel'
  ) {
    return 'excel';
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
    return 'powerpoint';
  }
  return 'rtf';
};

const decodeXmlEntities = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

const extractTextFromPowerPoint = async (buffer: Buffer): Promise<string> => {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0));

  const slideTexts: string[] = [];
  for (const slideFile of slideFiles) {
    const xml = await zip.file(slideFile)?.async('string');
    if (!xml) continue;
    const text = Array.from(xml.matchAll(/<a:t[^>]*>(.*?)<\/a:t>/g))
      .map((match) => decodeXmlEntities(match[1] ?? '').trim())
      .filter(Boolean)
      .join(' ');
    if (text) {
      slideTexts.push(text);
    }
  }
  return slideTexts.join('\n\n').trim();
};

const extractTextFromRtf = (buffer: Buffer): string =>
  buffer
    .toString('utf8')
    .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
    .replace(/\\[a-z]+-?\d* ?/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const extractOfficeText = async (
  buffer: Buffer,
  mimeType: OfficeDocumentMimeType,
): Promise<string> => {
  switch (officeTypeForMime(mimeType)) {
    case 'word': {
      const mammoth = await import('mammoth');
      const result = await mammoth.default.extractRawText({ buffer });
      return result.value.trim();
    }
    case 'excel': {
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      return workbook.SheetNames.map((sheetName) => {
        const sheet = workbook.Sheets[sheetName];
        return sheet ? XLSX.utils.sheet_to_csv(sheet, { blankrows: false }) : '';
      }).filter(Boolean).join('\n\n').trim();
    }
    case 'powerpoint':
      return extractTextFromPowerPoint(buffer);
    case 'rtf':
      return extractTextFromRtf(buffer);
  }
};

const extractPdfText = async (buffer: Buffer): Promise<{ text: string; pageCount?: number }> => {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { text: text.trim(), pageCount: totalPages };
};

const createPayload = async (filePath: string): Promise<AnyAttachmentPayload> => {
  const stats = await fs.stat(filePath);
  const name = path.basename(filePath);
  const mimeType = detectMimeType(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.heic' || ext === '.heif') {
    throw new Error('HEIC images are not supported by the CLI attachment loader yet.');
  }

  const sizeCap = resolveOriginalSizeCap(filePath, mimeType);
  if (stats.size > sizeCap) {
    throw new Error(
      `File size (${Math.floor(stats.size / 1024 / 1024)}MB) exceeds the ${Math.floor(sizeCap / 1024 / 1024)}MB limit for this attachment type.`,
    );
  }

  const buffer = await fs.readFile(filePath);

  if (IMAGE_MIME_BY_EXT[ext]) {
    const base64Data = buffer.toString('base64');
    return {
      id: randomUUID(),
      name,
      type: 'image',
      mimeType: IMAGE_MIME_BY_EXT[ext],
      base64Data,
      sizeBytes: estimateBase64Bytes(base64Data),
      originalPath: filePath,
    } satisfies ImageAttachmentPayload;
  }

  if (mimeType === 'application/pdf') {
    if (stats.size > PDF_EXTRACTION_THRESHOLD_BYTES) {
      const { text, pageCount } = await extractPdfText(buffer);
      if (!text) {
        throw new Error('Could not extract text from PDF.');
      }
      const extractedSizeBytes = new TextEncoder().encode(text).length;
      return {
        id: randomUUID(),
        name,
        type: 'extracted-pdf',
        mimeType: 'application/pdf',
        extractedText: text,
        originalSizeBytes: stats.size,
        extractedSizeBytes,
        pageCount,
        originalPath: filePath,
      } satisfies ExtractedPdfAttachmentPayload;
    }

    const base64Data = buffer.toString('base64');
    return {
      id: randomUUID(),
      name,
      type: 'document',
      mimeType: 'application/pdf',
      base64Data,
      sizeBytes: estimateBase64Bytes(base64Data),
      originalPath: filePath,
    } satisfies DocumentAttachmentPayload;
  }

  if (OFFICE_MIME_BY_EXT[ext]) {
    const officeMimeType = OFFICE_MIME_BY_EXT[ext];
    const extractedText = await extractOfficeText(buffer, officeMimeType);
    if (!extractedText) {
      return {
        id: randomUUID(),
        name,
        type: 'binary',
        mimeType,
        sizeBytes: stats.size,
        originalPath: filePath,
      } satisfies BinaryFileAttachmentPayload;
    }
    return {
      id: randomUUID(),
      name,
      type: 'office',
      mimeType: officeMimeType,
      extractedText,
      originalSizeBytes: stats.size,
      extractedSizeBytes: new TextEncoder().encode(extractedText).length,
      officeType: officeTypeForMime(officeMimeType),
      originalPath: filePath,
    } satisfies OfficeDocumentAttachmentPayload;
  }

  if (isTextBasedFile(name, mimeType)) {
    const content = buffer.toString('utf8');
    if (content.includes('\0')) {
      throw new Error('File appears to be binary, despite its text-like extension.');
    }
    const contentSizeBytes = new TextEncoder().encode(content).length;
    return {
      id: randomUUID(),
      name,
      type: 'textfile',
      mimeType,
      content,
      originalSizeBytes: stats.size,
      contentSizeBytes,
      originalPath: filePath,
    } satisfies TextFileAttachmentPayload;
  }

  return {
    id: randomUUID(),
    name,
    type: 'binary',
    mimeType,
    sizeBytes: stats.size,
    originalPath: filePath,
  } satisfies BinaryFileAttachmentPayload;
};

const assertValid = (payloads: AnyAttachmentPayload[]): void => {
  const result = validateAndFilterAttachments({
    rawTextAttachments: [],
    rawImageAttachments: payloads.filter((payload): payload is ImageAttachmentPayload => 'type' in payload && payload.type === 'image'),
    rawDocumentAttachments: payloads.filter((payload): payload is DocumentAttachmentPayload => 'type' in payload && payload.type === 'document'),
    rawExtractedPdfAttachments: payloads.filter((payload): payload is ExtractedPdfAttachmentPayload => 'type' in payload && payload.type === 'extracted-pdf'),
    rawOfficeAttachments: payloads.filter((payload): payload is OfficeDocumentAttachmentPayload => 'type' in payload && payload.type === 'office'),
    rawTextFileAttachments: payloads.filter((payload): payload is TextFileAttachmentPayload => 'type' in payload && payload.type === 'textfile'),
    rawBinaryAttachments: payloads.filter((payload): payload is BinaryFileAttachmentPayload => 'type' in payload && payload.type === 'binary'),
    coreDirectory: process.cwd(),
    turnLogger: { warn: () => undefined },
  });

  const validCount =
    result.imageAttachmentPayload.length +
    result.documentAttachmentPayload.length +
    result.extractedPdfAttachmentPayload.length +
    result.officeAttachmentPayload.length +
    result.textFileAttachmentPayload.length +
    result.binaryAttachmentPayload.length;

  if (validCount !== payloads.length) {
    throw new Error('One or more attachments failed validation.');
  }

  for (const payload of payloads) {
    if ('type' in payload && payload.type === 'office' && payload.extractedSizeBytes > MAX_OFFICE_EXTRACTED_BYTES) {
      throw new Error('Office attachment exceeds extracted text limit.');
    }
    if ('type' in payload && payload.type === 'extracted-pdf' && payload.extractedSizeBytes > MAX_EXTRACTED_TEXT_BYTES) {
      throw new Error('PDF extracted text exceeds attachment limit.');
    }
    if ('type' in payload && payload.type === 'textfile' && payload.originalSizeBytes > MAX_TEXT_FILE_SIZE_BYTES) {
      throw new Error('Text file exceeds attachment limit.');
    }
    if ('type' in payload && payload.type === 'document' && payload.sizeBytes > MAX_PDF_SIZE_BYTES) {
      throw new Error('PDF exceeds attachment limit.');
    }
  }
};

export async function loadAttachmentsFromPaths(paths: string[]): Promise<AnyAttachmentPayload[]> {
  const payloads: AnyAttachmentPayload[] = [];
  for (const filePath of paths) {
    try {
      const payload = await createPayload(filePath);
      assertValid([payload]);
      payloads.push(payload);
    } catch (error) {
      throw new Error(
        `Failed to load attachment "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  try {
    assertValid(payloads);
  } catch (error) {
    throw new Error(
      `Failed to validate attachments: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return payloads;
}
