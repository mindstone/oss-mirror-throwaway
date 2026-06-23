import { AlertTriangle } from 'lucide-react';
import { Button } from '@renderer/components/ui';
import type { DocumentWriteConflict } from '../hooks/useDocumentFileIO';
import styles from './UnifiedDocumentEditor.module.css';

interface DocumentConflictBannerProps {
  conflict: DocumentWriteConflict;
  onResolve: (resolution: 'keep-editor' | 'keep-disk') => void;
}

export function DocumentConflictBanner({ conflict, onResolve }: DocumentConflictBannerProps) {
  const message = conflict.writerKind === 'agent'
    ? 'Rebel updated this file while you were editing'
    : conflict.writerKind === 'cloud-sync'
      ? 'This file was updated from cloud sync'
      : 'This file was changed externally';

  return (
    <div className={styles.conflictBanner}>
      <AlertTriangle size={16} aria-hidden />
      <span className={styles.conflictMessage}>{message}</span>
      <div className={styles.conflictActions}>
        <Button variant="outline" size="sm" onClick={() => onResolve('keep-disk')}>
          Keep external version
        </Button>
        <Button variant="default" size="sm" onClick={() => onResolve('keep-editor')}>
          Keep my version
        </Button>
      </div>
    </div>
  );
}
