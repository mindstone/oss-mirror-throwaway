import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { Search, X } from 'lucide-react';
import { IconButton, Input } from '@renderer/components/ui';
import drawerStyles from './LibraryDrawer.module.css';

type LibraryRailSearchProps = {
  query: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  onQueryChange: (nextQuery: string) => void;
  onClear: () => void;
  onEscape: () => void;
  truncationNotice?: ReactNode;
};

export function LibraryRailSearch({
  query,
  inputRef,
  onQueryChange,
  onClear,
  onEscape,
  truncationNotice,
}: LibraryRailSearchProps) {
  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onEscape();
  };

  return (
    <div className={drawerStyles.kioskRailSearch} data-testid="library-kiosk-rail-search">
      <div className={drawerStyles.kioskRailSearchInputRow}>
        <Search size={14} className={drawerStyles.kioskRailSearchIcon} aria-hidden />
        <Input
          ref={inputRef}
          inputSize="sm"
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          onKeyDown={handleInputKeyDown}
          placeholder="Search files…"
          aria-label="Search files"
          className={drawerStyles.kioskRailSearchInput}
          data-testid="library-kiosk-rail-search-input"
        />
        {query.trim().length > 0 ? (
          <IconButton
            variant="ghost"
            size="xs"
            className={drawerStyles.kioskRailSearchClear}
            aria-label="Clear file search"
            onClick={onClear}
            data-testid="library-kiosk-rail-search-clear"
          >
            <X size={14} />
          </IconButton>
        ) : null}
      </div>
      {truncationNotice ? (
        <div className={drawerStyles.kioskRailSearchNotice} data-testid="library-kiosk-rail-search-notice">
          {truncationNotice}
        </div>
      ) : null}
    </div>
  );
}
