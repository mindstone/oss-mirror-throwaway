import { cn } from '@renderer/lib/utils';
import drawerStyles from './LibraryDrawer.module.css';

/**
 * Canonical partial-Library copy. Used by the truncation notice (kind:'tree')
 * AND every empty/zero state so a partial Library is never presented as
 * complete (Bug-2 safety invariant — PLAN.md Stage 3). Deliberately avoids
 * "first 100,000" because the producer cap makes no promise about ordering.
 */
export const INCOMPLETE_LIBRARY_COPY =
  'Showing part of this very large Library. Some files may not appear here.';

type IncompleteLibraryHintProps = {
  /** When false, renders nothing — lets callers guard inline without a wrapping conditional. */
  show: boolean;
  className?: string;
};

/**
 * Small inline hint shown alongside an empty/zero state when the file tree is a
 * partial view of the workspace. Distinguishes "no matches" from "the Library
 * is incomplete" so an absent file is never read as "deleted / none".
 */
export function IncompleteLibraryHint({ show, className }: IncompleteLibraryHintProps) {
  if (!show) {
    return null;
  }
  return (
    <p
      className={cn(drawerStyles.searchEmptyHint, className)}
      data-testid="library-incomplete-hint"
    >
      {INCOMPLETE_LIBRARY_COPY}
    </p>
  );
}
