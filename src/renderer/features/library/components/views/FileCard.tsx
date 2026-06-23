import { FileText, Folder } from 'lucide-react';
import type { LibraryViewEntry } from './viewShared';
import { LibraryItemCard } from './LibraryItemCard';

export interface FileCardProps {
  entry: LibraryViewEntry;
  className?: string;
  onOpenPath?: (path: string) => void;
}

export function FileCard({ entry, className, onOpenPath }: FileCardProps) {
  const Icon = entry.kind === 'directory' ? Folder : FileText;
  return (
    <LibraryItemCard
      className={className}
      title={entry.name}
      icon={<Icon size={14} />}
      badgeLabel={entry.kind === 'directory' ? 'Folder' : 'File'}
      path={entry.relativePath}
      summary={entry.summary}
      onOpen={() => onOpenPath?.(entry.path)}
    />
  );
}
