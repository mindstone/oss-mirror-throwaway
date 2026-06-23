// mobile/src/hooks/useMobileFileAttachments.ts
// Mobile file attachment hook using expo-image-picker + expo-document-picker.
// Mirrors the web's UseWebFileAttachmentsReturn interface (minus drag-drop).

import { useState, useCallback } from 'react';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import type {
  WebFileAttachment,
  WebImageAttachment,
  WebDocumentAttachment,
  WebTextFileAttachment,
  WebImageMimeType,
} from '@rebel/cloud-client';

// ---------------------------------------------------------------------------
// Size limits — imported from shared (web/mobile defaults)
// ---------------------------------------------------------------------------

import {
  MAX_IMAGE_SIZE_BYTES,
  MAX_PDF_SIZE_BYTES,
  MAX_TEXT_FILE_SIZE_BYTES,
  MAX_FILE_ATTACHMENTS,
  MAX_TOTAL_PAYLOAD_BYTES,
  VALID_IMAGE_MIME_TYPES,
  TEXT_BASED_MIME_TYPES,
} from '@rebel/shared';

const MAX_ATTACHMENTS = MAX_FILE_ATTACHMENTS;
const VALID_IMAGE_TYPES = VALID_IMAGE_MIME_TYPES;

const TEXT_MIME_PREFIXES = ['text/'];

let idCounter = 0;
function createId(): string {
  return `att-${Date.now()}-${++idCounter}`;
}

function isTextMimeType(mimeType: string): boolean {
  return (
    TEXT_MIME_PREFIXES.some((p) => mimeType.startsWith(p)) ||
    TEXT_BASED_MIME_TYPES.includes(mimeType)
  );
}

function estimatePayloadBytes(att: WebFileAttachment): number {
  if (att.type === 'textfile') return att.contentSizeBytes;
  return att.base64Data.length;
}

// ---------------------------------------------------------------------------
// Hook interface
// ---------------------------------------------------------------------------

export interface UseMobileFileAttachmentsReturn {
  attachments: WebFileAttachment[];
  pickImage: () => Promise<void>;
  pickDocument: () => Promise<void>;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  /**
   * Re-seed the attachment list with a previously snapshotted set
   * (e.g. draft preservation after a failed send). Merges with any
   * current attachments; duplicates (by id) are resolved to the snapshot.
   */
  restoreAttachments: (snapshot: WebFileAttachment[]) => void;
  canAddMore: boolean;
}

export function useMobileFileAttachments(
  onError?: (message: string) => void,
): UseMobileFileAttachmentsReturn {
  const [attachments, setAttachments] = useState<WebFileAttachment[]>([]);

  const canAddMore = attachments.length < MAX_ATTACHMENTS;

  const showError = useCallback(
    (message: string) => {
      if (onError) onError(message);
    },
    [onError],
  );

  const checkTotalPayload = useCallback(
    (current: WebFileAttachment[], newAtt: WebFileAttachment): boolean => {
      const currentTotal = current.reduce((sum, a) => sum + estimatePayloadBytes(a), 0);
      if (currentTotal + estimatePayloadBytes(newAtt) > MAX_TOTAL_PAYLOAD_BYTES) {
        showError('Total attachment size too large. Remove some files and try again.');
        return false;
      }
      return true;
    },
    [showError],
  );

  // -------------------------------------------------------------------------
  // Image picker
  // -------------------------------------------------------------------------

  const pickImage = useCallback(async () => {
    if (attachments.length >= MAX_ATTACHMENTS) {
      showError(`Maximum ${MAX_ATTACHMENTS} files allowed`);
      return;
    }

    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        base64: true,
        quality: 0.8,
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) return;

      const asset = result.assets[0];
      if (!asset.base64) {
        showError('Failed to read image data.');
        return;
      }

      // Estimate raw size from base64 length
      const sizeBytes = Math.ceil((asset.base64.length * 3) / 4);
      if (sizeBytes > MAX_IMAGE_SIZE_BYTES) {
        showError(
          `Image too large (${(sizeBytes / 1024 / 1024).toFixed(1)}MB). Max: ${MAX_IMAGE_SIZE_BYTES / 1024 / 1024}MB`,
        );
        return;
      }

      // Determine MIME type from the asset
      const mimeType = (asset.mimeType ?? 'image/jpeg') as WebImageMimeType;
      if (!VALID_IMAGE_TYPES.includes(mimeType)) {
        showError(`Unsupported image type: ${mimeType}`);
        return;
      }

      const attachment: WebImageAttachment = {
        id: createId(),
        name: asset.fileName ?? `image-${Date.now()}.jpg`,
        type: 'image',
        mimeType,
        base64Data: asset.base64,
        sizeBytes,
        width: asset.width,
        height: asset.height,
      };

      setAttachments((prev) => {
        if (prev.length >= MAX_ATTACHMENTS) return prev;
        if (!checkTotalPayload(prev, attachment)) return prev;
        return [...prev, attachment];
      });
    } catch {
      showError('Failed to pick image.');
    }
  }, [attachments.length, showError, checkTotalPayload]);

  // -------------------------------------------------------------------------
  // Document picker (PDF + text)
  // -------------------------------------------------------------------------

  const pickDocument = useCallback(async () => {
    if (attachments.length >= MAX_ATTACHMENTS) {
      showError(`Maximum ${MAX_ATTACHMENTS} files allowed`);
      return;
    }

    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'text/*'],
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) return;

      const asset = result.assets[0];
      const { uri, name, mimeType, size } = asset;

      if (mimeType === 'application/pdf') {
        // PDF document
        if (size && size > MAX_PDF_SIZE_BYTES) {
          showError(
            `PDF too large (${((size) / 1024 / 1024).toFixed(1)}MB). Max: ${MAX_PDF_SIZE_BYTES / 1024 / 1024}MB`,
          );
          return;
        }

        const base64Data = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const sizeBytes = Math.ceil((base64Data.length * 3) / 4);

        if (sizeBytes > MAX_PDF_SIZE_BYTES) {
          showError(
            `PDF too large (${(sizeBytes / 1024 / 1024).toFixed(1)}MB). Max: ${MAX_PDF_SIZE_BYTES / 1024 / 1024}MB`,
          );
          return;
        }

        const attachment: WebDocumentAttachment = {
          id: createId(),
          name: name || `document-${Date.now()}.pdf`,
          type: 'document',
          mimeType: 'application/pdf',
          base64Data,
          sizeBytes,
        };

        setAttachments((prev) => {
          if (prev.length >= MAX_ATTACHMENTS) return prev;
          if (!checkTotalPayload(prev, attachment)) return prev;
          return [...prev, attachment];
        });
      } else if (mimeType && isTextMimeType(mimeType)) {
        // Text file
        if (size && size > MAX_TEXT_FILE_SIZE_BYTES) {
          showError(
            `File too large (${((size) / 1024 / 1024).toFixed(1)}MB). Max: ${MAX_TEXT_FILE_SIZE_BYTES / 1024 / 1024}MB`,
          );
          return;
        }

        const content = await FileSystem.readAsStringAsync(uri);
        if (!content || content.trim().length === 0) {
          showError('File is empty.');
          return;
        }

        const contentSizeBytes = new TextEncoder().encode(content).length;

        if (contentSizeBytes > MAX_TEXT_FILE_SIZE_BYTES) {
          showError(
            `File too large (${(contentSizeBytes / 1024 / 1024).toFixed(1)}MB). Max: ${MAX_TEXT_FILE_SIZE_BYTES / 1024 / 1024}MB`,
          );
          return;
        }

        const attachment: WebTextFileAttachment = {
          id: createId(),
          name: name || `file-${Date.now()}.txt`,
          type: 'textfile',
          mimeType: mimeType || 'text/plain',
          content,
          originalSizeBytes: size ?? contentSizeBytes,
          contentSizeBytes,
        };

        setAttachments((prev) => {
          if (prev.length >= MAX_ATTACHMENTS) return prev;
          if (!checkTotalPayload(prev, attachment)) return prev;
          return [...prev, attachment];
        });
      } else {
        showError(`Unsupported file type: ${mimeType || 'unknown'}. Try PDFs or text files.`);
      }
    } catch {
      showError('Failed to pick document.');
    }
  }, [attachments.length, showError, checkTotalPayload]);

  // -------------------------------------------------------------------------
  // Remove / Clear
  // -------------------------------------------------------------------------

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((att) => att.id !== id));
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments([]);
  }, []);

  const restoreAttachments = useCallback((snapshot: WebFileAttachment[]) => {
    if (!snapshot || snapshot.length === 0) return;
    setAttachments((prev) => {
      // Prefer snapshot entries over same-id current entries (snapshot is the
      // authoritative "pre-send" state). De-dupe by id.
      const snapshotIds = new Set(snapshot.map((a) => a.id));
      const remaining = prev.filter((a) => !snapshotIds.has(a.id));
      return [...snapshot, ...remaining];
    });
  }, []);

  return {
    attachments,
    pickImage,
    pickDocument,
    removeAttachment,
    clearAttachments,
    restoreAttachments,
    canAddMore,
  };
}
