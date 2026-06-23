import { AlertCircle, Map, Search, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button, Spinner } from '@renderer/components/ui';
import { cn } from '@renderer/lib/utils';
import { assertNever } from '@shared/utils/assertNever';
import type { LibraryFilter, LibraryView } from '../types/lens';

export type LibraryLensEmptyMode =
  | 'empty-library'
  | 'atlas-indexing'
  | 'filter-mismatch'
  | 'search-no-results'
  | 'atlas-sparse'
  | 'loading'
  | 'error';

interface EmptyStateDefinition {
  icon: LucideIcon | null;
  title: string;
  description: string;
}

export interface LibraryLensEmptyStateProps {
  mode: LibraryLensEmptyMode;
  filter: LibraryFilter;
  view: LibraryView;
  query?: string;
  errorMessage?: string | null;
  className?: string;
  onRetry?: () => void;
}

function buildStateDefinition({
  mode,
  filter,
  query,
  errorMessage,
}: Pick<LibraryLensEmptyStateProps, 'mode' | 'filter' | 'query' | 'errorMessage'>): EmptyStateDefinition {
  switch (mode) {
    case 'empty-library':
      return {
        icon: Sparkles,
        title: 'Your Library is empty.',
        description:
          "Create a note, add a Space, or drop files here. Rebel is surprisingly literal about files.",
      };
    case 'atlas-indexing':
      return {
        icon: Map,
        title: 'Drawing the first map',
        description:
          'Rebel is plotting your files so Atlas can show how they relate. The first map usually takes a few minutes for a moderate library; future Atlas opens are instant.',
      };
    case 'filter-mismatch':
      if (filter === 'plugins') {
        return {
          icon: Sparkles,
          title: 'Plugins live in Cards view.',
          description:
            'Switch to Cards above to browse, enable, and disable plugins.',
        };
      }
      return {
        icon: Sparkles,
        title: 'Nothing in this view yet.',
        description:
          'Try another View, switch Show to Everything, or clear your search.',
      };
    case 'search-no-results':
      return {
        icon: Search,
        title: query?.trim().length
          ? `No results for "${query.trim()}".`
          : 'No results in this view.',
        description:
          'Try fewer words, Show Everything, or try Quick Open if you know the filename.',
      };
    case 'atlas-sparse':
      return {
        icon: Map,
        title: 'Not enough to map yet.',
        description:
          'Atlas needs related, indexed files before it can draw useful connections. Try Folders or show Everything.',
      };
    case 'loading':
      return {
        icon: null,
        title: (
          filter === 'spaces'
            ? 'Checking Spaces…'
            : filter === 'skills'
              ? 'Reading skills…'
              : filter === 'memory'
                ? 'Loading memories…'
                : filter === 'plugins'
                  ? 'Scanning plugins…'
                  : 'Gathering everything…'
        ),
        description: '',
      };
    case 'error':
      return {
        icon: AlertCircle,
        title: "Couldn't load your Library files.",
        description: errorMessage?.trim() || 'Try again, or restart Rebel.',
      };
    default:
      return assertNever(mode);
  }
}

export function LibraryLensEmptyState({
  mode,
  filter,
  view,
  query,
  errorMessage,
  className,
  onRetry,
}: LibraryLensEmptyStateProps) {
  const definition = buildStateDefinition({ mode, filter, query, errorMessage });
  const Icon = definition.icon;

  return (
    <div
      className={cn('empty-state', className)}
      data-library-filter={filter}
      data-library-view={view}
      data-testid="library-lens-empty-state"
      role="status"
      aria-live="polite"
    >
      <div className="empty-state__icon" aria-hidden="true">
        {Icon ? <Icon size={24} /> : <Spinner size="md" />}
      </div>
      <strong>{definition.title}</strong>
      {definition.description ? <p className="empty-state__sub">{definition.description}</p> : null}
      {mode === 'error' && onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
