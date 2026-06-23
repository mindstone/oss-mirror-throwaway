// cloud-client/src/hooks/useWebFileAttachments.ts
// Web-native file attachment hook — images, PDFs, and text files.

import { useState, useCallback, useRef } from 'react';
import type {
  WebFileAttachment,
  WebImageAttachment,
  WebDocumentAttachment,
  WebTextFileAttachment,
  WebImageMimeType,
} from '../types';
import { createLogger } from '../utils/logger';
import {
  MAX_HEIC_SIZE_BYTES,
  MAX_IMAGE_SIZE_BYTES,
  MAX_PDF_SIZE_BYTES,
  MAX_TEXT_FILE_SIZE_BYTES,
  MAX_EXTRACTED_TEXT_BYTES,
  MAX_FILE_ATTACHMENTS,
  IMAGE_HARD_DIMENSION_LIMIT,
  ANTHROPIC_IMAGE_BYTE_LIMIT,
  MAX_TOTAL_PAYLOAD_BYTES,
  isValidImageMimeType,
  isHeicFileType,
  isTextBasedFile,
  estimateBase64Bytes,
  getBase64EncodedByteLength,
  estimateAttachmentPayloadBytes,
  nextDimensionForByteTarget,
} from '@rebel/shared';

const log = createLogger('useWebFileAttachments');

const MAX_ATTACHMENTS = MAX_FILE_ATTACHMENTS;

let idCounter = 0;
function createId(): string {
  return `att-${Date.now()}-${++idCounter}`;
}

// ---------------------------------------------------------------------------
// Validation helpers (delegates to @rebel/shared for pure logic)
// ---------------------------------------------------------------------------

const isValidImageType = (mimeType: string): mimeType is WebImageMimeType =>
  isValidImageMimeType(mimeType);

const isHeicFile = (file: File): boolean =>
  isHeicFileType(file.name, file.type);

const isValidTextFile = (file: File): boolean =>
  isTextBasedFile(file.name, file.type);

const isValidFile = (file: File): boolean =>
  isValidImageType(file.type) || isHeicFile(file) || file.type === 'application/pdf' || isValidTextFile(file);

// ---------------------------------------------------------------------------
// File processing
// ---------------------------------------------------------------------------

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

async function resizeImage(
  base64: string,
  mimeType: string,
  maxDimension: number,
): Promise<{ base64: string; width: number; height: number; sizeBytes: number }> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = `data:${mimeType};base64,${base64}`;
  });

  const { width, height } = img;

  if (width <= maxDimension && height <= maxDimension) {
    return { base64, width, height, sizeBytes: estimateBase64Bytes(base64) };
  }

  const scale = maxDimension / Math.max(width, height);
  const newWidth = Math.round(width * scale);
  const newHeight = Math.round(height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = newWidth;
  canvas.height = newHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, newWidth, newHeight);

  let dataUrl: string;
  try {
    const quality = mimeType === 'image/jpeg' ? 0.92 : undefined;
    dataUrl = canvas.toDataURL(mimeType, quality);
  } catch {
    throw new Error('Image too large to process');
  }
  const resizedBase64 = dataUrl.split(',')[1];

  return { base64: resizedBase64, width: newWidth, height: newHeight, sizeBytes: estimateBase64Bytes(resizedBase64) };
}

// Byte-aware second-pass resize. Compares against `targetMaxBytes` using the
// base64 STRING byte length (what Anthropic checks against its 5 MB per-image
// ceiling) — NOT the decoded payload size. The returned `sizeBytes` follows
// the project-wide convention of decoded bytes (matches `resizeImage`).
async function reduceImageBytesUnderLimit(
  base64: string,
  mimeType: string,
  width: number,
  height: number,
  targetMaxBytes: number,
): Promise<{ base64: string; width: number; height: number; sizeBytes: number }> {
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

  const MAX_PASSES = 5;
  for (let i = 0; i < MAX_PASSES; i++) {
    if (currentEncodedBytes <= targetMaxBytes) break;
    const currentMaxDim = Math.max(currentWidth, currentHeight);
    const nextMaxDim = nextDimensionForByteTarget(currentMaxDim, currentEncodedBytes, targetMaxBytes);
    if (nextMaxDim >= currentMaxDim) break;
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
}

async function processImage(file: File): Promise<WebImageAttachment | null> {
  if (file.size > MAX_IMAGE_SIZE_BYTES) return null;

  const base64 = await fileToBase64(file);
  const dimensionPass = await resizeImage(
    base64,
    file.type,
    IMAGE_HARD_DIMENSION_LIMIT,
  );
  const dimensionPassEncodedBytes = getBase64EncodedByteLength(dimensionPass.base64);
  const { base64: resizedBase64, width, height, sizeBytes } = await reduceImageBytesUnderLimit(
    dimensionPass.base64,
    file.type,
    dimensionPass.width,
    dimensionPass.height,
    ANTHROPIC_IMAGE_BYTE_LIMIT,
  );

  if (dimensionPassEncodedBytes > ANTHROPIC_IMAGE_BYTE_LIMIT) {
    const finalEncodedBytes = getBase64EncodedByteLength(resizedBase64);
    log.warn('Byte-aware image reduction engaged', {
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
    mimeType: file.type as WebImageMimeType,
    base64Data: resizedBase64,
    sizeBytes,
    width,
    height,
  };
}

async function processDocument(file: File): Promise<WebDocumentAttachment | null> {
  if (file.size > MAX_PDF_SIZE_BYTES) return null;

  const base64 = await fileToBase64(file);
  const sizeBytes = estimateBase64Bytes(base64);

  return {
    id: createId(),
    name: file.name || `document-${Date.now()}.pdf`,
    type: 'document',
    mimeType: 'application/pdf',
    base64Data: base64,
    sizeBytes,
  };
}

async function processTextFile(file: File): Promise<WebTextFileAttachment | null> {
  if (file.size > MAX_TEXT_FILE_SIZE_BYTES) return null;

  const content = await file.text();
  if (!content || content.trim().length === 0) return null;
  if (content.includes('\0')) return null; // Binary file

  const contentSizeBytes = new TextEncoder().encode(content).length;
  if (contentSizeBytes > MAX_EXTRACTED_TEXT_BYTES) return null;

  return {
    id: createId(),
    name: file.name || `file-${Date.now()}`,
    type: 'textfile',
    mimeType: file.type || 'text/plain',
    content,
    originalSizeBytes: file.size,
    contentSizeBytes,
  };
}

async function processFile(
  file: File,
  onError: (msg: string) => void,
): Promise<WebFileAttachment | null> {
  try {
    if (isHeicFile(file)) {
      if (file.size > MAX_HEIC_SIZE_BYTES) {
        onError(`Image too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max: ${MAX_HEIC_SIZE_BYTES / 1024 / 1024}MB`);
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
        if (jpegFile.size > MAX_IMAGE_SIZE_BYTES) {
          onError(`Converted image too large (${(jpegFile.size / 1024 / 1024).toFixed(1)}MB). Max: ${MAX_IMAGE_SIZE_BYTES / 1024 / 1024}MB`);
          return null;
        }
        return await processImage(jpegFile);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error('HEIC conversion failed', { name: file.name, error: errMsg });
        onError(`Couldn't process this photo. Try saving it as JPEG first.`);
        return null;
      }
    }
    if (isValidImageType(file.type)) {
      if (file.size > MAX_IMAGE_SIZE_BYTES) {
        onError(`Image too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max: ${MAX_IMAGE_SIZE_BYTES / 1024 / 1024}MB`);
        return null;
      }
      return await processImage(file);
    }
    if (file.type === 'application/pdf') {
      if (file.size > MAX_PDF_SIZE_BYTES) {
        onError(`PDF too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max: ${MAX_PDF_SIZE_BYTES / 1024 / 1024}MB`);
        return null;
      }
      return await processDocument(file);
    }
    if (isValidTextFile(file)) {
      if (file.size > MAX_TEXT_FILE_SIZE_BYTES) {
        onError(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max: ${MAX_TEXT_FILE_SIZE_BYTES / 1024 / 1024}MB`);
        return null;
      }
      return await processTextFile(file);
    }
    onError(`Unsupported file type: ${file.type || 'unknown'}. Try images, PDFs, or text files.`);
    return null;
  } catch (err) {
    log.error('File processing error', { name: file.name, error: (err as Error).message });
    onError(`Failed to process ${file.name}`);
    return null;
  }
}

// Thin wrapper over shared estimateAttachmentPayloadBytes for local usage
const estimatePayloadBytes = (att: WebFileAttachment): number =>
  estimateAttachmentPayloadBytes(att);

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseWebFileAttachmentsOptions {
  maxAttachments?: number;
  onError?: (message: string) => void;
}

export interface UseWebFileAttachmentsReturn {
  attachments: WebFileAttachment[];
  addFiles: (files: FileList) => Promise<void>;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  canAddMore: boolean;
  isDragging: boolean;
  dragHandlers: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => Promise<void>;
  };
}

export function useWebFileAttachments(
  options: UseWebFileAttachmentsOptions = {},
): UseWebFileAttachmentsReturn {
  const { maxAttachments = MAX_ATTACHMENTS, onError } = options;

  const [attachments, setAttachments] = useState<WebFileAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);

  const canAddMore = attachments.length < maxAttachments;

  const showError = useCallback(
    (message: string) => {
      if (onError) onError(message);
      else log.warn(message);
    },
    [onError],
  );

  const addFiles = useCallback(
    async (files: FileList) => {
      const remainingSlots = maxAttachments - attachments.length;
      if (remainingSlots <= 0) {
        showError(`Maximum ${maxAttachments} files allowed`);
        return;
      }

      const validFiles = Array.from(files).filter(isValidFile).slice(0, remainingSlots);
      if (validFiles.length === 0) {
        showError('No supported files found. Try images, PDFs, or text files.');
        return;
      }

      if (files.length > remainingSlots) {
        showError(
          `Only ${remainingSlots} slot${remainingSlots === 1 ? '' : 's'} available. ${files.length - remainingSlots} file${files.length - remainingSlots === 1 ? '' : 's'} skipped.`,
        );
      }

      let runningPayload = attachments.reduce((sum, a) => sum + estimatePayloadBytes(a), 0);

      for (const file of validFiles) {
        const attachment = await processFile(file, showError);
        if (attachment) {
          const attSize = estimatePayloadBytes(attachment);
          if (runningPayload + attSize > MAX_TOTAL_PAYLOAD_BYTES) {
            showError('Total attachment size too large. Remove some files and try again.');
            break;
          }
          runningPayload += attSize;
          setAttachments((prev) => [...prev, attachment]);
        }
      }
    },
    [attachments.length, maxAttachments, showError],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((att) => att.id !== id));
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments([]);
  }, []);

  // Drag-and-drop handlers
  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragging(false);

      const files = e.dataTransfer.files;
      if (files.length > 0) {
        await addFiles(files);
      }
    },
    [addFiles],
  );

  return {
    attachments,
    addFiles,
    removeAttachment,
    clearAttachments,
    canAddMore,
    isDragging,
    dragHandlers: { onDragEnter, onDragLeave, onDragOver, onDrop },
  };
}
