import { useState, useCallback, useEffect, useRef } from 'react';
import JSZip from 'jszip';
import { RTFJS } from 'rtf.js';
import type {
  ImageAttachmentPayload,
  ImageAttachmentMimeType,
  DocumentAttachmentPayload,
  DocumentAttachmentMimeType,
  ExtractedPdfAttachmentPayload,
  OfficeDocumentAttachmentPayload,
  OfficeDocumentMimeType,
  TextFileAttachmentPayload,
  BinaryFileAttachmentPayload
} from '@shared/types';
import { createId } from '@renderer/utils/stringUtils';
import {
  MAX_EXTRACTED_TEXT_BYTES,
  MAX_FILE_ATTACHMENTS,
  MAX_HEIC_SIZE_BYTES,
  IMAGE_HARD_DIMENSION_LIMIT,
  ANTHROPIC_IMAGE_BYTE_LIMIT,
} from '@shared/attachmentLimits';
import {
  estimateBase64Bytes,
  getBase64EncodedByteLength,
  isValidImageMimeType,
  isHeicFileType,
  isTextBasedFile,
  nextDimensionForByteTarget,
} from '@rebel/shared';
import { extractClipboardHtmlImageSources } from '../utils/clipboardPaste';

const VALID_DOCUMENT_MIME_TYPES: DocumentAttachmentMimeType[] = ['application/pdf'];
const VALID_OFFICE_MIME_TYPES: OfficeDocumentMimeType[] = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/msword', // .doc
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/rtf', // .rtf
  'text/rtf' // .rtf (alternative MIME type)
];
// Desktop overrides: larger limits due to greater bandwidth and Anthropic API limits
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB (shared default: 5MB)
const MAX_PDF_SIZE_BYTES = 32 * 1024 * 1024; // 32MB Anthropic limit (shared default: 5MB)
const MAX_TEXT_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB (shared default: 2MB)
// Desktop-only constants
const PDF_EXTRACTION_THRESHOLD_BYTES = 25 * 1024 * 1024; // 25MB - extract text for PDFs above this size
const MAX_OFFICE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB for office docs (extraction reduces size)
const MAX_ATTACHMENTS = MAX_FILE_ATTACHMENTS;
const CHAT_ATTACHMENT_PREVIEW_MAX_DIMENSION = 640;

/** Union type for file attachments (images, documents, office files, text files, and binary files) */
export type FileAttachment =
  | ImageAttachmentPayload
  | DocumentAttachmentPayload
  | ExtractedPdfAttachmentPayload
  | OfficeDocumentAttachmentPayload
  | TextFileAttachmentPayload
  | BinaryFileAttachmentPayload;

type UseFileAttachmentsOptions = {
  maxAttachments?: number;
  maxImageSizeBytes?: number;
  maxPdfSizeBytes?: number;
  optimalMaxDimension?: number;
  onError?: (message: string) => void;
  initialAttachments?: FileAttachment[];
  onAttachmentsChange?: (attachments: FileAttachment[]) => void;
};

type UseFileAttachmentsResult = {
  attachments: FileAttachment[];
  addFromClipboard: (clipboardData: DataTransfer) => Promise<boolean>;
  addFromFile: (file: File) => Promise<boolean>;
  addFromFileList: (files: FileList) => Promise<number>;
  addImageAttachment: (payload: ImageAttachmentPayload) => boolean;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  canAddMore: boolean;
  isDragging: boolean;
  handleDragEnter: (e: React.DragEvent) => void;
  handleDragLeave: (e: React.DragEvent) => void;
  handleDragOver: (e: React.DragEvent) => void;
  handleDrop: (e: React.DragEvent) => Promise<void>;
};

const isValidImageType = (mimeType: string): mimeType is ImageAttachmentMimeType =>
  isValidImageMimeType(mimeType);

export const isHeicFile = (file: File): boolean =>
  isHeicFileType(file.name, file.type);

const isValidDocumentType = (mimeType: string): mimeType is DocumentAttachmentMimeType => {
  return VALID_DOCUMENT_MIME_TYPES.includes(mimeType as DocumentAttachmentMimeType);
};

const isValidOfficeType = (mimeType: string): mimeType is OfficeDocumentMimeType => {
  return VALID_OFFICE_MIME_TYPES.includes(mimeType as OfficeDocumentMimeType);
};

const isWordDocument = (mimeType: string): boolean => {
  return (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/msword'
  );
};

const isExcelDocument = (mimeType: string): boolean => {
  return (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel'
  );
};

const isPowerPointDocument = (mimeType: string): boolean => {
  return mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
};

const isRtfDocument = (mimeType: string): boolean => {
  return mimeType === 'application/rtf' || mimeType === 'text/rtf';
};

const isValidTextFile = (file: File): boolean =>
  isTextBasedFile(file.name, file.type);

const extractTextFromWord = async (arrayBuffer: ArrayBuffer): Promise<string> => {
  const mammoth = await import('mammoth');
  const result = await mammoth.default.extractRawText({ arrayBuffer });
  return result.value;
};

export const extractTextFromExcel = async (arrayBuffer: ArrayBuffer): Promise<string> => {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const textParts: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    textParts.push(`=== Sheet: ${sheetName} ===`);
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    textParts.push(csv);
    textParts.push('');
  }

  return textParts.join('\n').trim();
};

/**
 * Extract text from PowerPoint (.pptx) files using JSZip.
 * PPTX files are ZIP archives containing XML files with slide content.
 * Text is stored in <a:t> elements within ppt/slides/slide*.xml files.
 */
const extractTextFromPowerPoint = async (arrayBuffer: ArrayBuffer): Promise<string> => {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const slideTexts: string[] = [];

  // Get all slide files and sort them numerically
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)\.xml$/)?.[1] || '0', 10);
      const numB = parseInt(b.match(/slide(\d+)\.xml$/)?.[1] || '0', 10);
      return numA - numB;
    });

  for (const slideFile of slideFiles) {
    const xml = await zip.file(slideFile)?.async('string');
    if (!xml) continue;

    // Extract slide number from filename (e.g., "slide3.xml" -> 3)
    const slideNum = slideFile.match(/slide(\d+)\.xml$/)?.[1] || '?';

    // Parse XML and extract text from <a:t> elements
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');

    // Check for parse errors (DOMParser doesn't throw, returns error document)
    const parseError = doc.querySelector('parsererror');
    if (parseError) continue;

    const textElements = doc.getElementsByTagName('a:t');
    const texts = Array.from(textElements)
      .map((el) => el.textContent?.trim())
      .filter(Boolean)
      .join(' ');

    if (texts) {
      slideTexts.push(`=== Slide ${slideNum} ===\n${texts}`);
    }
  }

  return slideTexts.join('\n\n').trim();
};

/**
 * Extract text from RTF files using rtf.js.
 * Renders RTF to HTML elements, then extracts text content.
 */
const extractTextFromRtf = async (arrayBuffer: ArrayBuffer): Promise<string> => {
  // Disable logging to avoid console noise
  RTFJS.loggingEnabled(false);

  const doc = new RTFJS.Document(arrayBuffer);
  const htmlElements = await doc.render();

  // Create a container and append all rendered elements
  const container = document.createElement('div');
  container.append(...htmlElements);

  // Extract text content
  const text = container.textContent || container.innerText || '';
  return text.trim();
};

const extractTextFromPdf = async (
  arrayBuffer: ArrayBuffer
): Promise<{ text: string; pageCount: number }> => {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(arrayBuffer));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { text, pageCount: totalPages };
};

const fileToBase64 = (file: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
};

const extensionForImageMimeType = (mimeType: ImageAttachmentMimeType): string => {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
  }
};

const _getImageDimensions = (base64: string, mimeType: string): Promise<{ width: number; height: number }> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = `data:${mimeType};base64,${base64}`;
  });
};

const resizeImage = async (
  base64: string,
  mimeType: string,
  maxDimension: number
): Promise<{ base64: string; width: number; height: number; sizeBytes: number }> => {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Failed to load image for resize'));
    img.src = `data:${mimeType};base64,${base64}`;
  });

  const { width, height } = img;

  // If within limits, return original
  if (width <= maxDimension && height <= maxDimension) {
    return { base64, width, height, sizeBytes: estimateBase64Bytes(base64) };
  }

  // Calculate new dimensions maintaining aspect ratio
  const scale = maxDimension / Math.max(width, height);
  const newWidth = Math.round(width * scale);
  const newHeight = Math.round(height * scale);

  // Use canvas to resize
  const canvas = document.createElement('canvas');
  canvas.width = newWidth;
  canvas.height = newHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get canvas context');
  }

  // Use high-quality image smoothing
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, newWidth, newHeight);

  // Convert back to base64 (use same mime type, with quality for jpeg)
  const quality = mimeType === 'image/jpeg' ? 0.92 : undefined;
  const dataUrl = canvas.toDataURL(mimeType, quality);
  const resizedBase64 = dataUrl.split(',')[1];

  return { base64: resizedBase64, width: newWidth, height: newHeight, sizeBytes: estimateBase64Bytes(resizedBase64) };
};

// Byte-aware second-pass resize. Compares against `targetMaxBytes` using the
// base64 STRING byte length (what Anthropic checks against its 5 MB per-image
// ceiling) — NOT the decoded payload size. The returned `sizeBytes` follows
// the project-wide convention of decoded bytes (matches `resizeImage`).
const reduceImageBytesUnderLimit = async (
  base64: string,
  mimeType: string,
  width: number,
  height: number,
  targetMaxBytes: number,
): Promise<{ base64: string; width: number; height: number; sizeBytes: number }> => {
  let currentBase64 = base64;
  let currentWidth = width;
  let currentHeight = height;
  let currentEncodedBytes = getBase64EncodedByteLength(currentBase64);

  if (currentEncodedBytes <= targetMaxBytes) {
    return {
      base64: currentBase64,
      width: currentWidth,
      height: currentHeight,
      sizeBytes: estimateBase64Bytes(currentBase64),
    };
  }

  // For JPEG, try a quality ladder first (preserves dimensions, less destructive for photos).
  // PNG/GIF/WebP re-encoding via canvas at the same dimensions doesn't help meaningfully
  // (canvas re-encodes lossy as PNG → bigger; we go straight to dimension downscale for those).
  if (mimeType === 'image/jpeg') {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to load image for byte-aware resize'));
      img.src = `data:${mimeType};base64,${currentBase64}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = currentWidth;
    canvas.height = currentHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get canvas context');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0);

    for (const quality of [0.85, 0.75, 0.65]) {
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      const newBase64 = dataUrl.split(',')[1];
      currentBase64 = newBase64;
      currentEncodedBytes = getBase64EncodedByteLength(newBase64);
      if (currentEncodedBytes <= targetMaxBytes) {
        return {
          base64: currentBase64,
          width: currentWidth,
          height: currentHeight,
          sizeBytes: estimateBase64Bytes(currentBase64),
        };
      }
    }
  }

  // Dimension downscale ladder. Cap at 5 passes; floor at 512 px.
  const MAX_PASSES = 5;
  for (let i = 0; i < MAX_PASSES; i++) {
    if (currentEncodedBytes <= targetMaxBytes) break;
    const currentMaxDim = Math.max(currentWidth, currentHeight);
    const nextMaxDim = nextDimensionForByteTarget(currentMaxDim, currentEncodedBytes, targetMaxBytes);
    if (nextMaxDim >= currentMaxDim) {
      // Already at floor — give up; caller should preserve last result and rely on detector for graceful UX.
      break;
    }
    const result = await resizeImage(currentBase64, mimeType, nextMaxDim);
    currentBase64 = result.base64;
    currentWidth = result.width;
    currentHeight = result.height;
    currentEncodedBytes = getBase64EncodedByteLength(currentBase64);
  }

  return {
    base64: currentBase64,
    width: currentWidth,
    height: currentHeight,
    sizeBytes: estimateBase64Bytes(currentBase64),
  };
};

export const useFileAttachments = (options: UseFileAttachmentsOptions = {}): UseFileAttachmentsResult => {
  const {
    maxAttachments = MAX_ATTACHMENTS,
    maxImageSizeBytes = MAX_IMAGE_SIZE_BYTES,
    maxPdfSizeBytes = MAX_PDF_SIZE_BYTES,
    optimalMaxDimension = IMAGE_HARD_DIMENSION_LIMIT,
    onError,
    initialAttachments,
    onAttachmentsChange,
  } = options;

  const [attachments, setAttachments] = useState<FileAttachment[]>(() => initialAttachments ?? []);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);

  const canAddMore = attachments.length < maxAttachments;

  useEffect(() => {
    if (initialAttachments) {
      setAttachments(initialAttachments);
    } else {
      setAttachments([]);
    }
  }, [initialAttachments]);

  useEffect(() => {
    onAttachmentsChange?.(attachments);
  }, [attachments, onAttachmentsChange]);

  const showError = useCallback(
    (message: string) => {
      if (onError) {
        onError(message);
      } else {
        console.warn('[useFileAttachments]', message);
      }
    },
    [onError]
  );

  const processDocument = useCallback(
    async (file: File): Promise<DocumentAttachmentPayload | ExtractedPdfAttachmentPayload | BinaryFileAttachmentPayload | null> => {
      const originalPath = window.fileApi?.getFileSourcePath(file) || '';

      // For large PDFs, extract text instead of sending base64
      if (file.size > PDF_EXTRACTION_THRESHOLD_BYTES) {
        try {
          const arrayBuffer = await file.arrayBuffer();

          let base64Data: string | undefined;
          if (!originalPath) {
            base64Data = await fileToBase64(file);
          }

          const { text, pageCount } = await extractTextFromPdf(arrayBuffer);

          if (!text || text.trim().length === 0) {
            if (originalPath) {
              // Can't extract text but have the file path — fall back to binary
              return {
                id: createId(),
                name: file.name || `document-${Date.now()}.pdf`,
                type: 'binary' as const,
                mimeType: 'application/pdf',
                sizeBytes: file.size,
                originalPath,
              };
            }
            showError(`Could not extract text from ${file.name}. The PDF may contain only images.`);
            return null;
          }

          const extractedSizeBytes = new TextEncoder().encode(text).length;

          if (extractedSizeBytes > MAX_EXTRACTED_TEXT_BYTES) {
            if (originalPath) {
              // Too much text for a single message but have the file path — fall back to binary
              return {
                id: createId(),
                name: file.name || `document-${Date.now()}.pdf`,
                type: 'binary' as const,
                mimeType: 'application/pdf',
                sizeBytes: file.size,
                originalPath,
              };
            }
            showError(
              `This PDF has too much text to include in a single message. Save it to your Library and ask Rebel to read it — that way it can work through it in sections.`
            );
            return null;
          }

          // Notify user about text extraction (using showError for now - it shows as toast)
          showError(`Large PDF — extracting text only. Images and charts won't be included.`);

          return {
            id: createId(),
            name: file.name || `document-${Date.now()}.pdf`,
            type: 'extracted-pdf',
            mimeType: 'application/pdf',
            extractedText: text,
            originalSizeBytes: file.size,
            extractedSizeBytes,
            pageCount,
            ...(base64Data ? { base64Data } : {}),
            ...(originalPath ? { originalPath } : {})
          };
        } catch (err) {
          // If extraction fails, try sending as regular PDF (may still hit API limit)
          console.warn('[useFileAttachments] PDF extraction failed, falling back to base64:', err);
        }
      }

      // Standard PDF processing for smaller files or extraction fallback
      if (file.size > maxPdfSizeBytes) {
        showError(`PDF too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum: ${maxPdfSizeBytes / 1024 / 1024}MB`);
        return null;
      }

      try {
        const arrayBuffer = await file.arrayBuffer();
        const base64 = await fileToBase64(file);
        const sizeBytes = estimateBase64Bytes(base64);

        // Best-effort text extraction for session recovery.
        // When the session is lost (auth switch, app restart), base64 document
        // blocks are dropped. Extracted text is persisted on the message so
        // buildConversationHistoryContext can include the document content.
        let extractedText: string | undefined;
        try {
          const { text } = await extractTextFromPdf(arrayBuffer);
          if (text && text.trim().length > 0) {
            extractedText = text;
          }
        } catch {
          // Non-fatal: the base64 document block is still the primary path
        }

        return {
          id: createId(),
          name: file.name || `document-${Date.now()}.pdf`,
          type: 'document',
          mimeType: 'application/pdf',
          base64Data: base64,
          sizeBytes,
          extractedText,
          ...(originalPath ? { originalPath } : {})
        };
      } catch (err) {
        showError(`Failed to process PDF: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },
    [maxPdfSizeBytes, showError]
  );

  const processOfficeDocument = useCallback(
    async (file: File): Promise<OfficeDocumentAttachmentPayload | BinaryFileAttachmentPayload | null> => {
      const originalPath = window.fileApi?.getFileSourcePath(file) || '';

      if (file.size > MAX_OFFICE_SIZE_BYTES) {
        showError(
          `Office document too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum: ${MAX_OFFICE_SIZE_BYTES / 1024 / 1024}MB`
        );
        return null;
      }

      try {
        const arrayBuffer = await file.arrayBuffer();

        // Preserve original binary for clipboard pastes (no disk path available)
        // When originalPath is available, main process reads from disk directly
        let base64Data: string | undefined;
        if (!originalPath) {
          base64Data = await fileToBase64(file);
        }

        let extractedText: string;
        let officeType: 'word' | 'excel' | 'powerpoint' | 'rtf';

        if (isWordDocument(file.type)) {
          extractedText = await extractTextFromWord(arrayBuffer);
          officeType = 'word';
        } else if (isExcelDocument(file.type)) {
          extractedText = await extractTextFromExcel(arrayBuffer);
          officeType = 'excel';
        } else if (isPowerPointDocument(file.type)) {
          extractedText = await extractTextFromPowerPoint(arrayBuffer);
          officeType = 'powerpoint';
        } else if (isRtfDocument(file.type)) {
          extractedText = await extractTextFromRtf(arrayBuffer);
          officeType = 'rtf';
        } else {
          showError(`Unsupported office document type: ${file.type}`);
          return null;
        }

        if (!extractedText || extractedText.trim().length === 0) {
          if (originalPath) {
            return {
              id: createId(),
              name: file.name || `office-document-${Date.now()}`,
              type: 'binary' as const,
              mimeType: file.type || 'application/octet-stream',
              sizeBytes: file.size,
              originalPath,
            };
          }
          showError(`Could not extract text from ${file.name}. The document may be empty or corrupted.`);
          return null;
        }

        const extractedSizeBytes = new TextEncoder().encode(extractedText).length;

        if (extractedSizeBytes > MAX_EXTRACTED_TEXT_BYTES) {
          if (originalPath) {
            return {
              id: createId(),
              name: file.name || `office-document-${Date.now()}`,
              type: 'binary' as const,
              mimeType: file.type || 'application/octet-stream',
              sizeBytes: file.size,
              originalPath,
            };
          }
          showError(
            `This document has too much text to include in a single message. Save it to your Library and ask Rebel to read it — that way it can work through it in sections.`
          );
          return null;
        }

        return {
          id: createId(),
          name: file.name || `office-document-${Date.now()}`,
          type: 'office',
          mimeType: file.type as OfficeDocumentMimeType,
          extractedText,
          originalSizeBytes: file.size,
          extractedSizeBytes,
          officeType,
          ...(base64Data ? { base64Data } : {}),
          ...(originalPath ? { originalPath } : {})
        };
      } catch (err) {
        const docTypeMap: Record<string, string> = {
          word: 'Word document',
          excel: 'Excel spreadsheet',
          powerpoint: 'PowerPoint presentation',
          rtf: 'RTF document'
        };
        let docType = 'document';
        if (isWordDocument(file.type)) docType = docTypeMap.word;
        else if (isExcelDocument(file.type)) docType = docTypeMap.excel;
        else if (isPowerPointDocument(file.type)) docType = docTypeMap.powerpoint;
        else if (isRtfDocument(file.type)) docType = docTypeMap.rtf;
        showError(`Failed to process ${docType}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },
    [showError]
  );

  const processImage = useCallback(
    async (file: File): Promise<ImageAttachmentPayload | null> => {
      const originalPath = window.fileApi?.getFileSourcePath(file) || '';

      if (file.size > maxImageSizeBytes) {
        showError(`Image too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum: ${maxImageSizeBytes / 1024 / 1024}MB`);
        return null;
      }

      try {
        const base64 = await fileToBase64(file);
        const dimensionPass = await resizeImage(
          base64,
          file.type,
          optimalMaxDimension
        );
        const dimensionPassEncodedBytes = getBase64EncodedByteLength(dimensionPass.base64);
        const { base64: resizedBase64, width, height, sizeBytes } = await reduceImageBytesUnderLimit(
          dimensionPass.base64,
          file.type,
          dimensionPass.width,
          dimensionPass.height,
          ANTHROPIC_IMAGE_BYTE_LIMIT,
        );
        const { base64: previewBase64Data } = await resizeImage(
          resizedBase64,
          file.type,
          CHAT_ATTACHMENT_PREVIEW_MAX_DIMENSION
        );

        if (dimensionPassEncodedBytes > ANTHROPIC_IMAGE_BYTE_LIMIT) {
          const finalEncodedBytes = getBase64EncodedByteLength(resizedBase64);
          console.warn('[useFileAttachments] Byte-aware image reduction engaged', {
            mimeType: file.type,
            beforeEncodedBytes: dimensionPassEncodedBytes,
            afterEncodedBytes: finalEncodedBytes,
            beforeWidth: dimensionPass.width,
            beforeHeight: dimensionPass.height,
            afterWidth: width,
            afterHeight: height,
            withinLimit: finalEncodedBytes <= ANTHROPIC_IMAGE_BYTE_LIMIT,
          });
        }

        return {
          id: createId(),
          name: file.name || `image-${Date.now()}`,
          type: 'image',
          mimeType: file.type as ImageAttachmentMimeType,
          base64Data: resizedBase64,
          previewBase64Data,
          sizeBytes,
          width,
          height,
          ...(originalPath ? { originalPath } : {})
        };
      } catch (err) {
        showError(`Failed to process image: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },
    [maxImageSizeBytes, optimalMaxDimension, showError]
  );

  const processHeicImage = useCallback(
    async (file: File): Promise<ImageAttachmentPayload | null> => {
      const originalPath = window.fileApi?.getFileSourcePath(file) || '';

      if (file.size > MAX_HEIC_SIZE_BYTES) {
        showError(`Image too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum: ${MAX_HEIC_SIZE_BYTES / 1024 / 1024}MB`);
        return null;
      }

      try {
        const { heicTo } = await import('heic-to');
        const jpegBlob = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.92 });

        const hasHeicExt = /\.heic$/i.test(file.name) || /\.heif$/i.test(file.name);
        const baseName = file.name || `image-${Date.now()}`;
        const jpegName = hasHeicExt
          ? baseName.replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg')
          : `${baseName}.jpg`;
        const jpegFile = new File([jpegBlob], jpegName, { type: 'image/jpeg' });
        const result = await processImage(jpegFile);

        if (result && originalPath) {
          result.originalPath = originalPath;
        }

        return result;
      } catch (err: unknown) {
        const errMsg = err instanceof Error
          ? err.message
          : (typeof err === 'object' && err !== null && 'message' in err)
            ? String((err as { message: unknown }).message)
            : String(err);
        showError(`Couldn't process this photo. Try saving it as JPEG first.`);
        console.warn('[useFileAttachments] HEIC conversion failed:', errMsg, { name: file.name, type: file.type, size: file.size });
        return null;
      }
    },
    [processImage, showError]
  );

  const processTextFile = useCallback(
    async (file: File): Promise<TextFileAttachmentPayload | null> => {
      const originalPath = window.fileApi?.getFileSourcePath(file) || '';

      if (file.size > MAX_TEXT_FILE_SIZE_BYTES) {
        showError(
          `Text file too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum: ${MAX_TEXT_FILE_SIZE_BYTES / 1024 / 1024}MB`
        );
        return null;
      }

      try {
        const content = await file.text();

        // Check for empty file
        if (!content || content.trim().length === 0) {
          showError(`File ${file.name} appears to be empty.`);
          return null;
        }

        // Check for binary content (null bytes indicate binary file)
        if (content.includes('\0')) {
          showError(`File ${file.name} appears to be a binary file. Only text files are supported.`);
          return null;
        }

        const contentSizeBytes = new TextEncoder().encode(content).length;

        if (contentSizeBytes > MAX_EXTRACTED_TEXT_BYTES) {
          showError(
            `This file has too much text to include in a single message. Save it to your Library and ask Rebel to read it — that way it can work through it in sections.`
          );
          return null;
        }

        return {
          id: createId(),
          name: file.name || `file-${Date.now()}`,
          type: 'textfile',
          mimeType: file.type || 'text/plain',
          content,
          originalSizeBytes: file.size,
          contentSizeBytes,
          ...(originalPath ? { originalPath } : {})
        };
      } catch (err) {
        showError(`Failed to read text file: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },
    [showError]
  );

  const processBinaryFile = useCallback(
    async (file: File): Promise<BinaryFileAttachmentPayload | null> => {
      const originalPath = window.fileApi?.getFileSourcePath(file) || '';

      if (file.size > MAX_OFFICE_SIZE_BYTES) {
        showError(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum: ${MAX_OFFICE_SIZE_BYTES / 1024 / 1024}MB`);
        return null;
      }

      // Only base64 encode if no disk path available (clipboard paste)
      let base64Data: string | undefined;
      if (!originalPath) {
        try {
          base64Data = await fileToBase64(file);
        } catch (err) {
          showError(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      }

      return {
        id: createId(),
        name: file.name || `file-${Date.now()}`,
        type: 'binary',
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        ...(originalPath ? { originalPath } : {}),
        ...(base64Data ? { base64Data } : {}),
      };
    },
    [showError]
  );

  const processFile = useCallback(
    async (file: File): Promise<FileAttachment | null> => {
      if (isHeicFile(file)) {
        return processHeicImage(file);
      }
      if (isValidImageType(file.type)) {
        return processImage(file);
      }
      if (isValidDocumentType(file.type)) {
        return processDocument(file);
      }
      if (isValidOfficeType(file.type)) {
        return processOfficeDocument(file);
      }
      if (isValidTextFile(file)) {
        return processTextFile(file);
      }
      // For any other file type, create a binary attachment (no content extraction)
      return processBinaryFile(file);
    },
    [processHeicImage, processImage, processDocument, processOfficeDocument, processTextFile, processBinaryFile]
  );

  const addFromFile = useCallback(
    async (file: File): Promise<boolean> => {
      if (!canAddMore) {
        showError(`Maximum ${maxAttachments} files allowed`);
        return false;
      }

      const attachment = await processFile(file);
      if (attachment) {
        setAttachments((prev) => [...prev, attachment]);
        return true;
      }
      return false;
    },
    [canAddMore, maxAttachments, processFile, showError]
  );

  const addFromFileList = useCallback(
    async (files: FileList): Promise<number> => {
      let added = 0;
      const remainingSlots = maxAttachments - attachments.length;
      const filesToProcess = Array.from(files).slice(0, remainingSlots);

      for (const file of filesToProcess) {
        const attachment = await processFile(file);
        if (attachment) {
          setAttachments((prev) => [...prev, attachment]);
          added++;
        }
      }

      if (files.length > remainingSlots) {
        showError(`Only ${remainingSlots} slot${remainingSlots === 1 ? '' : 's'} available. ${files.length - remainingSlots} file${files.length - remainingSlots === 1 ? '' : 's'} skipped.`);
      }

      return added;
    },
    [attachments.length, maxAttachments, processFile, showError]
  );

  const addFromClipboard = useCallback(
    async (clipboardData: DataTransfer): Promise<boolean> => {
      const items = Array.from(clipboardData.items);
      const fileItems = items.filter((item) => item.kind === 'file');
      let added = 0;
      const remainingSlots = maxAttachments - attachments.length;

      for (const item of fileItems) {
        if (added >= remainingSlots) {
          break;
        }
        const file = item.getAsFile();
        if (!file) continue;
        const attachment = await processFile(file);
        if (!attachment) continue;
        setAttachments((prev) => [...prev, attachment]);
        added++;
      }

      const htmlImageSources = extractClipboardHtmlImageSources(clipboardData.getData('text/html'));
      for (const [index, src] of htmlImageSources.entries()) {
        if (added >= remainingSlots) {
          break;
        }

        try {
          if (!/^data:image\/|^https?:\/\//i.test(src)) {
            continue;
          }

          const response = await fetch(src);
          if (!response.ok) {
            continue;
          }

          const blob = await response.blob();
          const normalizedMimeType = blob.type.split(';')[0].toLowerCase();
          if (!isValidImageType(normalizedMimeType)) {
            continue;
          }

          const mimeType = normalizedMimeType as ImageAttachmentMimeType;
          const extension = extensionForImageMimeType(mimeType);
          const file = new File([blob], `Pasted image ${index + 1}.${extension}`, { type: mimeType });
          const attachment = await processFile(file);
          if (!attachment) {
            continue;
          }
          setAttachments((prev) => [...prev, attachment]);
          added++;
        } catch {
          // Best-effort: some clipboard HTML images use protected or transient URLs.
        }
      }

      const candidateCount = fileItems.length + htmlImageSources.length;
      if (candidateCount > remainingSlots && remainingSlots >= 0) {
        const skipped = candidateCount - remainingSlots;
        if (skipped > 0) {
          showError(`Only ${remainingSlots} slot${remainingSlots === 1 ? '' : 's'} available. ${skipped} item${skipped === 1 ? '' : 's'} skipped.`);
        }
      }

      return added > 0;
    },
    [attachments.length, maxAttachments, processFile, showError]
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((att) => att.id !== id));
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments([]);
  }, []);

  /**
   * Add a pre-processed image attachment (e.g., from screenshot capture).
   * The image should already be resized and encoded as base64.
   * Returns true if added, false if max attachments reached.
   */
  const addImageAttachment = useCallback(
    (payload: ImageAttachmentPayload): boolean => {
      if (!canAddMore) {
        showError(`Maximum ${maxAttachments} files allowed`);
        return false;
      }
      setAttachments((prev) => [...prev, payload]);
      return true;
    },
    [canAddMore, maxAttachments, showError]
  );

  // Drag and drop handlers
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragging(false);

      const files = e.dataTransfer.files;
      if (files.length === 0) return;

      await addFromFileList(files);
    },
    [addFromFileList]
  );

  return {
    attachments,
    addFromClipboard,
    addFromFile,
    addFromFileList,
    addImageAttachment,
    removeAttachment,
    clearAttachments,
    canAddMore,
    isDragging,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop
  };
};
