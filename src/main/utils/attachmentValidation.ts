/**
 * Attachment Validation and Filtering
 *
 * Pure function that validates and filters all attachment types for an agent turn.
 * Extracted from agentTurnExecutor to enable independent testing and reduce executor size.
 *
 * Each attachment type is validated against count and size limits, with oversized
 * or invalid attachments logged and dropped.
 */

import type {
  AgentAttachmentPayload,
  ImageAttachmentPayload,
  DocumentAttachmentPayload,
  ExtractedPdfAttachmentPayload,
  OfficeDocumentAttachmentPayload,
  TextFileAttachmentPayload,
  BinaryFileAttachmentPayload,
} from '@shared/types';
import {
  MAX_RENDERER_ATTACHMENTS,
  MAX_ATTACHMENT_CHAR_LENGTH,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_SIZE_BYTES,
  MAX_TEXT_FILE_ATTACHMENTS,
  MAX_TEXT_FILE_CONTENT_BYTES,
  attachSkillMetadataToTextAttachments,
  collectSkillModelRecommendations,
  type TextAttachmentWithSkillMetadata,
  type SkillMetadataEffort,
} from './agentTurnUtils';
import { resolveLibraryPath } from './systemUtils';

// --- Exported constants (previously inline in executor) ---

/** Max PDF size per Anthropic API limits */
export const MAX_PDF_SIZE_BYTES = 32 * 1024 * 1024;
export const MAX_DOCUMENT_ATTACHMENTS = 5;
export const MAX_OFFICE_EXTRACTED_BYTES = MAX_TEXT_FILE_CONTENT_BYTES;
export const MAX_OFFICE_ATTACHMENTS = 5;
export const MAX_EXTRACTED_PDF_ATTACHMENTS = 5;
export const MAX_BINARY_ATTACHMENTS = 5;
/** 50MB */
export const MAX_BINARY_SIZE_BYTES = 50 * 1024 * 1024;

// --- Input/Output interfaces ---

export interface AttachmentValidationInput {
  rawTextAttachments: AgentAttachmentPayload[];
  rawImageAttachments: ImageAttachmentPayload[];
  rawDocumentAttachments: DocumentAttachmentPayload[];
  rawExtractedPdfAttachments: ExtractedPdfAttachmentPayload[];
  rawOfficeAttachments: OfficeDocumentAttachmentPayload[];
  rawTextFileAttachments: TextFileAttachmentPayload[];
  rawBinaryAttachments: BinaryFileAttachmentPayload[];
  coreDirectory: string;
  turnLogger: { warn: (obj: unknown, msg: string) => void };
}

export interface ValidatedAttachments {
  textAttachmentPayload: TextAttachmentWithSkillMetadata[];
  imageAttachmentPayload: ImageAttachmentPayload[];
  documentAttachmentPayload: DocumentAttachmentPayload[];
  extractedPdfAttachmentPayload: ExtractedPdfAttachmentPayload[];
  officeAttachmentPayload: OfficeDocumentAttachmentPayload[];
  textFileAttachmentPayload: TextFileAttachmentPayload[];
  binaryAttachmentPayload: BinaryFileAttachmentPayload[];
  skillModelRecommendations: ReturnType<typeof collectSkillModelRecommendations>;
  skillEffortRecommendations: SkillMetadataEffort[];
}

// --- Main function ---

export function validateAndFilterAttachments(input: AttachmentValidationInput): ValidatedAttachments {
  const {
    rawTextAttachments,
    rawImageAttachments,
    rawDocumentAttachments,
    rawExtractedPdfAttachments,
    rawOfficeAttachments,
    rawTextFileAttachments,
    rawBinaryAttachments,
    coreDirectory,
    turnLogger,
  } = input;

  // Validate and filter text attachments
  if (rawTextAttachments.length > MAX_RENDERER_ATTACHMENTS) {
    turnLogger.warn(
      {
        requested: rawTextAttachments.length,
        allowed: MAX_RENDERER_ATTACHMENTS,
      },
      'Too many text attachments provided - extra files will be dropped'
    );
  }

  const filteredTextAttachments = rawTextAttachments
    .slice(0, MAX_RENDERER_ATTACHMENTS)
    .filter((attachment) => {
      if (attachment.content.length > MAX_ATTACHMENT_CHAR_LENGTH) {
        turnLogger.warn(
          {
            relativePath: attachment.relativePath,
            size: attachment.content.length,
            max: MAX_ATTACHMENT_CHAR_LENGTH,
          },
          'Dropping oversized text attachment'
        );
        return false;
      }
      try {
        resolveLibraryPath(attachment.relativePath, coreDirectory);
        return true;
      } catch (validationError) {
        turnLogger.warn(
          {
            relativePath: attachment.relativePath,
            err: validationError instanceof Error ? validationError.message : validationError,
          },
          'Dropping attachment that could not be resolved in workspace'
        );
        return false;
      }
    });
  const textAttachmentPayload = attachSkillMetadataToTextAttachments(filteredTextAttachments);
  const skillModelRecommendations = collectSkillModelRecommendations(textAttachmentPayload);
  const skillEffortRecommendations = textAttachmentPayload
    .map((attachment) => attachment.skillMetadata?.effort)
    .filter((effort): effort is SkillMetadataEffort => Boolean(effort));

  // Validate and filter image attachments
  if (rawImageAttachments.length > MAX_IMAGE_ATTACHMENTS) {
    turnLogger.warn(
      {
        requested: rawImageAttachments.length,
        allowed: MAX_IMAGE_ATTACHMENTS,
      },
      'Too many image attachments provided - extra images will be dropped'
    );
  }

  const imageAttachmentPayload = rawImageAttachments
    .slice(0, MAX_IMAGE_ATTACHMENTS)
    .filter((attachment) => {
      if (attachment.sizeBytes > MAX_IMAGE_SIZE_BYTES) {
        turnLogger.warn(
          {
            name: attachment.name,
            size: attachment.sizeBytes,
            max: MAX_IMAGE_SIZE_BYTES,
          },
          'Dropping oversized image attachment'
        );
        return false;
      }
      return true;
    });

  // Validate and filter document attachments (PDFs)
  // Max PDF size is 32MB per Anthropic API limits
  if (rawDocumentAttachments.length > MAX_DOCUMENT_ATTACHMENTS) {
    turnLogger.warn(
      {
        requested: rawDocumentAttachments.length,
        allowed: MAX_DOCUMENT_ATTACHMENTS,
      },
      'Too many document attachments provided - extra documents will be dropped'
    );
  }

  const documentAttachmentPayload = rawDocumentAttachments
    .slice(0, MAX_DOCUMENT_ATTACHMENTS)
    .filter((attachment) => {
      if (attachment.sizeBytes > MAX_PDF_SIZE_BYTES) {
        turnLogger.warn(
          {
            name: attachment.name,
            size: attachment.sizeBytes,
            max: MAX_PDF_SIZE_BYTES,
          },
          'Dropping oversized document attachment'
        );
        return false;
      }
      return true;
    });

  // Validate and filter office attachments (Word/Excel)
  if (rawOfficeAttachments.length > MAX_OFFICE_ATTACHMENTS) {
    turnLogger.warn(
      {
        requested: rawOfficeAttachments.length,
        allowed: MAX_OFFICE_ATTACHMENTS,
      },
      'Too many office attachments provided - extra documents will be dropped'
    );
  }

  const officeAttachmentPayload = rawOfficeAttachments
    .slice(0, MAX_OFFICE_ATTACHMENTS)
    .filter((attachment) => {
      if (attachment.extractedSizeBytes > MAX_OFFICE_EXTRACTED_BYTES) {
        turnLogger.warn(
          {
            name: attachment.name,
            size: attachment.extractedSizeBytes,
            max: MAX_OFFICE_EXTRACTED_BYTES,
          },
          'Dropping office attachment with oversized extracted text'
        );
        return false;
      }
      return true;
    });

  // Validate and filter extracted PDF attachments (large PDFs with text extraction)
  // Uses same limits as office docs since they're both extracted text
  if (rawExtractedPdfAttachments.length > MAX_EXTRACTED_PDF_ATTACHMENTS) {
    turnLogger.warn(
      {
        requested: rawExtractedPdfAttachments.length,
        allowed: MAX_EXTRACTED_PDF_ATTACHMENTS,
      },
      'Too many extracted PDF attachments provided - extra documents will be dropped'
    );
  }

  const extractedPdfAttachmentPayload = rawExtractedPdfAttachments
    .slice(0, MAX_EXTRACTED_PDF_ATTACHMENTS)
    .filter((attachment) => {
      if (attachment.extractedSizeBytes > MAX_OFFICE_EXTRACTED_BYTES) {
        turnLogger.warn(
          {
            name: attachment.name,
            size: attachment.extractedSizeBytes,
            max: MAX_OFFICE_EXTRACTED_BYTES,
          },
          'Dropping extracted PDF attachment with oversized text'
        );
        return false;
      }
      return true;
    });

  // Validate and filter text file attachments (uploaded via drag-drop/paste)
  if (rawTextFileAttachments.length > MAX_TEXT_FILE_ATTACHMENTS) {
    turnLogger.warn(
      {
        requested: rawTextFileAttachments.length,
        allowed: MAX_TEXT_FILE_ATTACHMENTS,
      },
      'Too many text file attachments provided - extra files will be dropped'
    );
  }

  const textFileAttachmentPayload = rawTextFileAttachments
    .slice(0, MAX_TEXT_FILE_ATTACHMENTS)
    .filter((attachment) => {
      if (attachment.contentSizeBytes > MAX_TEXT_FILE_CONTENT_BYTES) {
        turnLogger.warn(
          {
            name: attachment.name,
            size: attachment.contentSizeBytes,
            max: MAX_TEXT_FILE_CONTENT_BYTES,
          },
          'Dropping text file attachment with oversized content'
        );
        return false;
      }
      return true;
    });

  // Validate and filter binary file attachments
  if (rawBinaryAttachments.length > MAX_BINARY_ATTACHMENTS) {
    turnLogger.warn(
      {
        requested: rawBinaryAttachments.length,
        allowed: MAX_BINARY_ATTACHMENTS,
      },
      'Too many binary attachments provided - extra files will be dropped'
    );
  }

  const binaryAttachmentPayload: BinaryFileAttachmentPayload[] = rawBinaryAttachments
    .slice(0, MAX_BINARY_ATTACHMENTS)
    .filter((attachment) => {
      if (attachment.sizeBytes > MAX_BINARY_SIZE_BYTES) {
        turnLogger.warn(
          { name: attachment.name, size: attachment.sizeBytes, max: MAX_BINARY_SIZE_BYTES },
          'Dropping binary attachment exceeding size limit'
        );
        return false;
      }
      return true;
    });

  return {
    textAttachmentPayload,
    imageAttachmentPayload,
    documentAttachmentPayload,
    extractedPdfAttachmentPayload,
    officeAttachmentPayload,
    textFileAttachmentPayload,
    binaryAttachmentPayload,
    skillModelRecommendations,
    skillEffortRecommendations,
  };
}
