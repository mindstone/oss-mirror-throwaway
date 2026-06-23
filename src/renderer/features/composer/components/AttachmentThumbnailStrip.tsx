import { memo, useMemo } from 'react';
import { X, File, FileText, Table, Code, Presentation } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui';
import type {
  ImageAttachmentPayload,
  DocumentAttachmentPayload,
  ExtractedPdfAttachmentPayload,
  OfficeDocumentAttachmentPayload,
  TextFileAttachmentPayload,
  BinaryFileAttachmentPayload
} from '@shared/types';
import {
  isImageAttachment,
  isDocumentAttachment,
  isExtractedPdfAttachment,
  isOfficeDocumentAttachment,
  isTextFileAttachment,
  isBinaryFileAttachment
} from '@shared/types';
import type { FileAttachment } from '../hooks/useFileAttachments';
import styles from './ImageThumbnailStrip.module.css';

type AttachmentThumbnailStripProps = {
  attachments: FileAttachment[];
  onRemove: (id: string) => void;
  maxAttachments?: number;
};

const estimateImageTokens = (width?: number, height?: number): number => {
  if (!width || !height) return 0;
  return Math.ceil((width * height) / 750);
};

const estimatePdfTokens = (sizeBytes: number): number => {
  // Rough estimate: ~1500-3000 tokens per page, assume ~100KB per page
  const estimatedPages = Math.ceil(sizeBytes / 100000);
  return estimatedPages * 2000; // Conservative middle estimate
};

const estimateTextTokens = (textSizeBytes: number): number => {
  // Rough estimate: ~4 characters per token for English text
  return Math.ceil(textSizeBytes / 4);
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};

type MediaThumbnailProps = {
  attachment: FileAttachment;
  onRemove: (id: string) => void;
};

type ImageThumbnailProps = {
  image: ImageAttachmentPayload;
  onRemove: (id: string) => void;
};

const ImageThumbnail = memo(({ image, onRemove }: ImageThumbnailProps) => {
  const dataUrl = useMemo(
    () => `data:${image.mimeType};base64,${image.base64Data}`,
    [image.mimeType, image.base64Data]
  );

  const tokens = estimateImageTokens(image.width, image.height);
  const tooltipContent = useMemo(() => {
    const parts = [image.name];
    if (image.width && image.height) {
      parts.push(`${image.width}x${image.height}`);
    }
    parts.push(formatBytes(image.sizeBytes));
    if (tokens > 0) {
      parts.push(`~${tokens.toLocaleString()} tokens`);
    }
    return parts.join(' · ');
  }, [image.name, image.width, image.height, image.sizeBytes, tokens]);

  return (
    <div className={styles.thumbnail} role="listitem">
      <Tooltip content={tooltipContent} placement="top">
        <div className={styles.thumbnailInner}>
          <img
            src={dataUrl}
            alt={image.name}
            className={styles.thumbnailImage}
            draggable={false}
          />
          <button
            type="button"
            className={styles.removeButton}
            onClick={() => onRemove(image.id)}
            aria-label={`Remove ${image.name}`}
          >
            <X size={12} />
          </button>
        </div>
      </Tooltip>
    </div>
  );
});

ImageThumbnail.displayName = 'ImageThumbnail';

type DocumentThumbnailProps = {
  document: DocumentAttachmentPayload;
  onRemove: (id: string) => void;
};

const DocumentThumbnail = memo(({ document, onRemove }: DocumentThumbnailProps) => {
  const tokens = estimatePdfTokens(document.sizeBytes);
  const tooltipContent = useMemo(() => {
    const parts = [document.name];
    parts.push(formatBytes(document.sizeBytes));
    parts.push(`~${tokens.toLocaleString()} tokens`);
    return parts.join(' · ');
  }, [document.name, document.sizeBytes, tokens]);

  return (
    <div className={styles.thumbnail} role="listitem">
      <Tooltip content={tooltipContent} placement="top">
        <div className={styles.thumbnailInner + ' ' + styles.documentThumbnail}>
          <File className={styles.documentIcon} />
          <span className={styles.documentLabel}>PDF</span>
          <button
            type="button"
            className={styles.removeButton}
            onClick={() => onRemove(document.id)}
            aria-label={`Remove ${document.name}`}
          >
            <X size={12} />
          </button>
        </div>
      </Tooltip>
    </div>
  );
});

DocumentThumbnail.displayName = 'DocumentThumbnail';

type ExtractedPdfThumbnailProps = {
  extractedPdf: ExtractedPdfAttachmentPayload;
  onRemove: (id: string) => void;
};

const ExtractedPdfThumbnail = memo(({ extractedPdf, onRemove }: ExtractedPdfThumbnailProps) => {
  const tokens = estimateTextTokens(extractedPdf.extractedSizeBytes);

  const tooltipContent = useMemo(() => {
    const parts = [
      `${extractedPdf.name} (text extracted)`,
      `Original: ${formatBytes(extractedPdf.originalSizeBytes)} → Text: ${formatBytes(extractedPdf.extractedSizeBytes)}`,
      `~${tokens.toLocaleString()} tokens`,
      'Note: Images and formatting not included'
    ];
    return parts.join(' · ');
  }, [extractedPdf.name, extractedPdf.originalSizeBytes, extractedPdf.extractedSizeBytes, tokens]);

  return (
    <div className={styles.thumbnail} role="listitem">
      <Tooltip content={tooltipContent} placement="top">
        <div className={`${styles.thumbnailInner} ${styles.extractedPdfThumbnail}`}>
          <FileText className={styles.extractedPdfIcon} />
          <span className={styles.extractedPdfLabel}>TXT</span>
          <button
            type="button"
            className={styles.removeButton}
            onClick={() => onRemove(extractedPdf.id)}
            aria-label={`Remove ${extractedPdf.name}`}
          >
            <X size={12} />
          </button>
        </div>
      </Tooltip>
    </div>
  );
});

ExtractedPdfThumbnail.displayName = 'ExtractedPdfThumbnail';

type OfficeThumbnailProps = {
  officeDoc: OfficeDocumentAttachmentPayload;
  onRemove: (id: string) => void;
};

const OFFICE_TYPE_CONFIG: Record<OfficeDocumentAttachmentPayload['officeType'], { label: string; Icon: typeof FileText; styleClass: string }> = {
  word: { label: 'DOCX', Icon: FileText, styleClass: 'wordThumbnail' },
  excel: { label: 'XLSX', Icon: Table, styleClass: 'excelThumbnail' },
  powerpoint: { label: 'PPTX', Icon: Presentation, styleClass: 'pptxThumbnail' },
  rtf: { label: 'RTF', Icon: FileText, styleClass: 'rtfThumbnail' },
};

const OfficeThumbnail = memo(({ officeDoc, onRemove }: OfficeThumbnailProps) => {
  const tokens = estimateTextTokens(officeDoc.extractedSizeBytes);
  const config = OFFICE_TYPE_CONFIG[officeDoc.officeType] ?? OFFICE_TYPE_CONFIG.word;
  const { label: typeLabel, Icon, styleClass } = config;

  const tooltipContent = useMemo(() => {
    const parts = [officeDoc.name];
    parts.push(`Original: ${formatBytes(officeDoc.originalSizeBytes)}`);
    parts.push(`Extracted: ${formatBytes(officeDoc.extractedSizeBytes)}`);
    parts.push(`~${tokens.toLocaleString()} tokens`);
    return parts.join(' · ');
  }, [officeDoc.name, officeDoc.originalSizeBytes, officeDoc.extractedSizeBytes, tokens]);

  return (
    <div className={styles.thumbnail} role="listitem">
      <Tooltip content={tooltipContent} placement="top">
        <div className={`${styles.thumbnailInner} ${styles.officeThumbnail} ${styles[styleClass]}`}>
          <Icon className={styles.officeIcon} />
          <span className={styles.officeLabel}>{typeLabel}</span>
          <button
            type="button"
            className={styles.removeButton}
            onClick={() => onRemove(officeDoc.id)}
            aria-label={`Remove ${officeDoc.name}`}
          >
            <X size={12} />
          </button>
        </div>
      </Tooltip>
    </div>
  );
});

OfficeThumbnail.displayName = 'OfficeThumbnail';

type TextFileThumbnailProps = {
  textFile: TextFileAttachmentPayload;
  onRemove: (id: string) => void;
};

const getFileExtension = (filename: string): string => {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filename.slice(lastDot + 1).toUpperCase();
};

const TextFileThumbnail = memo(({ textFile, onRemove }: TextFileThumbnailProps) => {
  const tokens = estimateTextTokens(textFile.contentSizeBytes);
  const ext = getFileExtension(textFile.name);
  const displayLabel = ext || 'TXT';

  const tooltipContent = useMemo(() => {
    const parts = [textFile.name];
    parts.push(formatBytes(textFile.contentSizeBytes));
    parts.push(`~${tokens.toLocaleString()} tokens`);
    return parts.join(' · ');
  }, [textFile.name, textFile.contentSizeBytes, tokens]);

  return (
    <div className={styles.thumbnail} role="listitem">
      <Tooltip content={tooltipContent} placement="top">
        <div className={`${styles.thumbnailInner} ${styles.textFileThumbnail}`}>
          <Code className={styles.textFileIcon} />
          <span className={styles.textFileLabel}>{displayLabel}</span>
          <button
            type="button"
            className={styles.removeButton}
            onClick={() => onRemove(textFile.id)}
            aria-label={`Remove ${textFile.name}`}
          >
            <X size={12} />
          </button>
        </div>
      </Tooltip>
    </div>
  );
});

TextFileThumbnail.displayName = 'TextFileThumbnail';

type BinaryFileThumbnailProps = {
  binaryFile: BinaryFileAttachmentPayload;
  onRemove: (id: string) => void;
};

const BinaryFileThumbnail = memo(({ binaryFile, onRemove }: BinaryFileThumbnailProps) => {
  const ext = getFileExtension(binaryFile.name);
  const displayLabel = ext || 'FILE';

  const tooltipContent = useMemo(() => {
    const parts = [binaryFile.name];
    parts.push(formatBytes(binaryFile.sizeBytes));
    if (binaryFile.originalPath) {
      parts.push('Has file path');
    }
    return parts.join(' · ');
  }, [binaryFile.name, binaryFile.sizeBytes, binaryFile.originalPath]);

  return (
    <div className={styles.thumbnail} role="listitem">
      <Tooltip content={tooltipContent} placement="top">
        <div className={`${styles.thumbnailInner} ${styles.textFileThumbnail}`}>
          <File className={styles.textFileIcon} />
          <span className={styles.textFileLabel}>{displayLabel}</span>
          <button
            type="button"
            className={styles.removeButton}
            onClick={() => onRemove(binaryFile.id)}
            aria-label={`Remove ${binaryFile.name}`}
          >
            <X size={12} />
          </button>
        </div>
      </Tooltip>
    </div>
  );
});

BinaryFileThumbnail.displayName = 'BinaryFileThumbnail';

const MediaThumbnail = memo(({ attachment, onRemove }: MediaThumbnailProps) => {
  if (isImageAttachment(attachment)) {
    return <ImageThumbnail image={attachment} onRemove={onRemove} />;
  }
  if (isDocumentAttachment(attachment)) {
    return <DocumentThumbnail document={attachment} onRemove={onRemove} />;
  }
  if (isExtractedPdfAttachment(attachment)) {
    return <ExtractedPdfThumbnail extractedPdf={attachment} onRemove={onRemove} />;
  }
  if (isOfficeDocumentAttachment(attachment)) {
    return <OfficeThumbnail officeDoc={attachment} onRemove={onRemove} />;
  }
  if (isTextFileAttachment(attachment)) {
    return <TextFileThumbnail textFile={attachment} onRemove={onRemove} />;
  }
  if (isBinaryFileAttachment(attachment)) {
    return <BinaryFileThumbnail binaryFile={attachment} onRemove={onRemove} />;
  }
  return null;
});

MediaThumbnail.displayName = 'MediaThumbnail';

const AttachmentThumbnailStripComponent = ({ attachments, onRemove, maxAttachments = 5 }: AttachmentThumbnailStripProps) => {
  if (attachments.length === 0) return null;

  return (
    <div className={styles.strip} role="list" aria-label="Attached files">
      {attachments.map((attachment) => (
        <MediaThumbnail key={attachment.id} attachment={attachment} onRemove={onRemove} />
      ))}
      {attachments.length >= maxAttachments && (
        <span className={styles.limitReached}>Max {maxAttachments}</span>
      )}
    </div>
  );
};

export const AttachmentThumbnailStrip = memo(AttachmentThumbnailStripComponent);
AttachmentThumbnailStrip.displayName = 'AttachmentThumbnailStrip';
