/**
 * Re-exports from `packages/shared/src/utils/attachmentLimits.ts` — the single
 * source of truth for attachment constants.
 *
 * This file exists so that main-process and renderer code can continue
 * importing via `@shared/attachmentLimits`.  The canonical definitions live
 * in `packages/shared` so that cloud-client and mobile can also reach them
 * through `@rebel/shared`.
 */
export {
  MAX_EXTRACTED_TEXT_BYTES,
  MAX_FILE_ATTACHMENTS,
  MAX_IMAGE_SIZE_BYTES,
  MAX_PDF_SIZE_BYTES,
  MAX_TEXT_FILE_SIZE_BYTES,
  MAX_TOTAL_PAYLOAD_BYTES,
  MAX_HEIC_SIZE_BYTES,
  OPTIMAL_MAX_DIMENSION,
  IMAGE_HARD_DIMENSION_LIMIT,
  ANTHROPIC_IMAGE_BYTE_LIMIT,
  nextDimensionForByteTarget,
  VALID_IMAGE_MIME_TYPES,
  TEXT_BASED_MIME_TYPES,
  TEXT_FILE_EXTENSIONS,
} from '@rebel/shared';
