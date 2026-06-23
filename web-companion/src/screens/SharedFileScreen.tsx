// web-companion/src/screens/SharedFileScreen.tsx
// Standalone read-only view for shared files — no auth required.
// Renders markdown/text inline; shows a download page for other file types.

import type { SharedFile } from '@rebel/cloud-client';
import { SafeWebMarkdown } from '../components/SafeWebMarkdown';
import styles from './SharedFileScreen.module.css';

const REBEL_MARKETING_URL = 'https://www.mindstone.com/rebel';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function friendlyMimeLabel(mimeType: string): string {
  const map: Record<string, string> = {
    'text/markdown': 'Markdown',
    'text/plain': 'Text',
    'application/json': 'JSON',
    'text/csv': 'CSV',
    'application/pdf': 'PDF',
    'image/png': 'PNG image',
    'image/jpeg': 'JPEG image',
    'image/gif': 'GIF image',
    'image/svg+xml': 'SVG image',
  };
  return map[mimeType] ?? mimeType.split('/').pop()?.toUpperCase() ?? 'File';
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Footer() {
  return (
    <footer className={styles.footer}>
      <span className={styles.footerText}>
        <a href={REBEL_MARKETING_URL} target="_blank" rel="noopener noreferrer" className={styles.footerLink}>
          Powered by Rebel
        </a>
        {' \u00b7 '}
        <a href={REBEL_MARKETING_URL} target="_blank" rel="noopener noreferrer" className={styles.footerLink}>
          Try Rebel
        </a>
      </span>
    </footer>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

interface SharedFileScreenProps {
  file: SharedFile;
  downloadUrl: string;
}

export function SharedFileScreen({ file, downloadUrl }: SharedFileScreenProps) {
  // Narrow `file.content` to string once so TS keeps the non-null proof
  // inside the render branch below (and we drop the non-null assertion).
  const inlineContent =
    file.content != null && file.content.length > 0 ? file.content : null;

  // Markdown/text files — render inline
  if (inlineContent !== null) {
    return (
      <div className={styles.container}>
        <header className={styles.header}>
          <div className={styles.headerInner}>
            <span className={styles.title}>{file.fileName}</span>
            <span className={styles.sharedLabel}>Shared file</span>
          </div>
        </header>

        <div className={styles.content}>
          <div className={styles.contentInner}>
            <div className={styles.markdown}>
              <SafeWebMarkdown>{inlineContent}</SafeWebMarkdown>
            </div>
            <div className={styles.inlineDownload}>
              <a
                href={downloadUrl}
                download={file.fileName}
                className={styles.inlineDownloadLink}
              >
                <DownloadIcon /> Download original
              </a>
            </div>
          </div>
        </div>

        <Footer />
      </div>
    );
  }

  // Non-text files — download page
  return (
    <div className={styles.container}>
      <div className={styles.downloadPage}>
        <div className={styles.downloadIcon}>
          <FileIcon />
        </div>
        <div className={styles.downloadInfo}>
          <span className={styles.downloadFileName}>{file.fileName}</span>
          <span className={styles.downloadMeta}>
            {friendlyMimeLabel(file.mimeType)}
            {file.size > 0 && ` \u00b7 ${formatFileSize(file.size)}`}
          </span>
        </div>
        <p className={styles.downloadDescription}>
          This file was shared via Rebel.
        </p>
        <a
          href={downloadUrl}
          download={file.fileName}
          className={styles.downloadButton}
        >
          <DownloadIcon /> Download
        </a>
      </div>

      <Footer />
    </div>
  );
}
