import { Button } from '@renderer/components/ui';
import type { LibraryFilter } from '../../../types/lens';
import { IncompleteLibraryHint } from '../../IncompleteLibraryHint';

export interface FilterCardsEmptyStateProps {
  filter: LibraryFilter;
  /**
   * Whether the file tree is a partial (truncated) snapshot. Only qualifies the
   * tree-derived 'everything' empty state ("No files in your library yet") —
   * skills/memory/spaces/plugins come from separate indexes and are unqualified.
   */
  isPartialTree?: boolean;
  onCreateSkill?: () => void;
  onInstallCommunitySkills?: () => void;
  onCreateMemory?: () => void;
  onAddSpace?: () => void;
  onCreateFile?: () => void;
}

export function FilterCardsEmptyState({
  filter,
  isPartialTree = false,
  onCreateSkill,
  onInstallCommunitySkills,
  onCreateMemory,
  onAddSpace,
  onCreateFile,
}: FilterCardsEmptyStateProps) {
  if (filter === 'skills') {
    return (
      <div className="empty-state" data-testid="cards-empty-state-skills">
        <strong>No skills yet.</strong>
        <p className="empty-state__sub">Create a skill to teach Rebel a repeatable move.</p>
        <div className="empty-state__actions">
          {onCreateSkill ? (
            <Button type="button" variant="outline" size="sm" onClick={onCreateSkill}>
              Create a skill
            </Button>
          ) : null}
          {onInstallCommunitySkills ? (
            <Button type="button" variant="ghost" size="sm" onClick={onInstallCommunitySkills}>
              Install from community
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (filter === 'memory') {
    return (
      <div className="empty-state" data-testid="cards-empty-state-memory">
        <strong>No memories yet.</strong>
        <p className="empty-state__sub">
          They&apos;ll show here when you ask Rebel to remember something.
        </p>
        {onCreateMemory ? (
          <div className="empty-state__actions">
            <Button type="button" variant="outline" size="sm" onClick={onCreateMemory}>
              Add a memory
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  if (filter === 'spaces') {
    return (
      <div className="empty-state" data-testid="cards-empty-state-spaces">
        <strong>No spaces yet.</strong>
        <p className="empty-state__sub">
          Spaces help organize work by context.
        </p>
        {onAddSpace ? (
          <div className="empty-state__actions">
            <Button type="button" variant="outline" size="sm" onClick={onAddSpace}>
              Add a space
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  if (filter === 'plugins') {
    return (
      <div className="empty-state" data-testid="cards-empty-state-plugins">
        <strong>No plugins available.</strong>
        <p className="empty-state__sub">
          Plugins shipped in your Spaces will show up here. Open Settings → Plugins to author one.
        </p>
      </div>
    );
  }

  return (
    <div className="empty-state" data-testid="cards-empty-state-everything">
      <strong>No files in your library yet.</strong>
      <p className="empty-state__sub">
        Drop files here, or use the <strong>[+]</strong> menu.
      </p>
      {onCreateFile ? (
        <div className="empty-state__actions">
          <Button type="button" variant="outline" size="sm" onClick={onCreateFile}>
            Create a file
          </Button>
        </div>
      ) : null}
      <IncompleteLibraryHint show={isPartialTree} />
    </div>
  );
}
