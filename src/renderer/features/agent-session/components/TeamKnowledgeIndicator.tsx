import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Users, FileText, X } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui';
import { useSettingsSafe } from '@renderer/features/settings';
import { groupItemsByOrganisation } from '@core/services/spaceOrganisationHeuristics';
import type { AgentEvent } from '@shared/types';
import type { SpaceConfig } from '@shared/ipc/schemas/library';
import { safeParseDetail } from '../utils/safeParseDetail';
import './TeamKnowledgeIndicator.css';

/** A single source file from the file_search event detail. */
type SearchSource = {
  relativePath: string;
  score: number;
  spaceName: string;
  spaceDisplayName?: string;
  sharing?: string;
  organisationName?: string;
};

/** Sources grouped by space for card rendering. */
type SpaceGroup = {
  spaceName: string;
  spaceDisplayName: string;
  sharing: string;
  organisationName?: string;
  sources: SearchSource[];
};

type OrganisationAwareSpaceConfig = SpaceConfig & {
  companyName?: string;
  organisationName?: string;
};

type TeamKnowledgeIndicatorProps = {
  turnEvents: AgentEvent[];
  onOpenFile?: (path: string) => void;
};

/** Max files shown per space before "N more" expansion. */
const MAX_FILES_PER_SPACE = 5;

/**
 * Deterministic color from a string hash.
 * Returns an HSL color with consistent saturation/lightness for space initials.
 */
function spaceColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

/** Space config files that aren't knowledge content */
const SPACE_CONFIG_FILES = new Set(['readme.md', 'agents.md']);

/**
 * Match a workspace-relative file path to a shared space config.
 * Returns space info if the file belongs to a non-private space, null otherwise.
 */
function matchFileToSharedSpace(
  filePath: string,
  spaces: OrganisationAwareSpaceConfig[],
): { spaceName: string; spaceDisplayName: string; sharing: string; organisationName?: string } | null {
  const normalized = filePath
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .toLowerCase();

  let bestMatch: OrganisationAwareSpaceConfig | null = null;
  let bestLen = 0;

  for (const space of spaces) {
    const sp = space.path.replace(/\\/g, '/').toLowerCase();
    if ((normalized.startsWith(sp + '/') || normalized === sp) && sp.length > bestLen) {
      bestMatch = space;
      bestLen = sp.length;
    }
  }

  if (!bestMatch || !bestMatch.sharing || bestMatch.sharing === 'private') {
    return null;
  }

  return {
    spaceName: bestMatch.name,
    spaceDisplayName: bestMatch.name,
    sharing: bestMatch.sharing,
    organisationName: bestMatch.organisationName ?? bestMatch.companyName,
  };
}

/**
 * Extract shared sources from turn events.
 *
 * Combines two data sources:
 * 1. Pre-turn `file_search` events (semantic search results with structured source metadata)
 * 2. `Read` tool start events (files the agent read during the turn, matched against space configs)
 *
 * This ensures the "Team memory" pill reflects all shared knowledge that informed the response,
 * not just what the pre-turn semantic search found. The agent often discovers additional files
 * via MCP search tools (rebel_search_files, rebel_search_sources) and then reads them.
 */
function extractSharedSources(
  turnEvents: AgentEvent[],
  spaces?: OrganisationAwareSpaceConfig[],
): SearchSource[] | null {
  const seen = new Map<string, SearchSource>();
  const organisationBySpaceName = new Map<string, string>();

  for (const space of spaces ?? []) {
    const organisationName = space.organisationName ?? space.companyName;
    if (organisationName) {
      organisationBySpaceName.set(space.name, organisationName);
    }
  }

  // 1. Extract from file_search events (pre-turn semantic search — has structured source metadata)
  for (const event of turnEvents) {
    if (event.type !== 'tool' || event.toolName !== 'file_search' || event.stage !== 'end') {
      continue;
    }
    const parseResult = safeParseDetail(event.detail);
    if (!parseResult.ok) continue; // too-large / malformed — skip
    try {
      const parsed = parseResult.value as { sources?: unknown };
      if (!Array.isArray(parsed?.sources)) continue;
      for (const src of parsed.sources) {
        if (
          typeof src?.relativePath === 'string' &&
          typeof src?.score === 'number' &&
          typeof src?.spaceName === 'string' &&
          typeof src?.sharing === 'string' &&
          src.sharing !== 'private' &&
          !seen.has(src.relativePath)
        ) {
          seen.set(src.relativePath, {
            ...(src as SearchSource),
            organisationName:
              typeof src.organisationName === 'string'
                ? src.organisationName
                : organisationBySpaceName.get(src.spaceName),
          });
        }
      }
    } catch {
      // Malformed detail JSON — skip silently
    }
  }

  // 2. Extract from Read tool events (files the agent actually read from shared spaces)
  if (spaces && spaces.length > 0) {
    for (const event of turnEvents) {
      if (event.type !== 'tool' || event.toolName !== 'Read' || event.stage !== 'start') {
        continue;
      }
      const parseResult = safeParseDetail(event.detail);
      if (!parseResult.ok) continue; // too-large / malformed — skip
      try {
        const parsed = parseResult.value as { file_path?: unknown; path?: unknown };
        const filePath: unknown = parsed?.file_path ?? parsed?.path;
        if (typeof filePath !== 'string') continue;
        if (seen.has(filePath)) continue;

        const leafName = filePath.split('/').pop()?.toLowerCase() ?? '';
        if (SPACE_CONFIG_FILES.has(leafName)) continue;

        const spaceInfo = matchFileToSharedSpace(filePath, spaces);
        if (spaceInfo) {
          seen.set(filePath, {
            relativePath: filePath,
            score: 0,
            spaceName: spaceInfo.spaceName,
            spaceDisplayName: spaceInfo.spaceDisplayName,
            sharing: spaceInfo.sharing,
            organisationName: spaceInfo.organisationName,
          });
        }
      } catch {
        // skip
      }
    }
  }

  return seen.size > 0 ? Array.from(seen.values()) : null;
}

/**
 * Group sources by spaceName, preserving insertion order.
 */
function groupBySpace(sources: SearchSource[]): SpaceGroup[] {
  const map = new Map<string, SpaceGroup>();
  for (const src of sources) {
    let group = map.get(src.spaceName);
    if (!group) {
      group = {
        spaceName: src.spaceName,
        spaceDisplayName: src.spaceDisplayName ?? src.spaceName,
        sharing: src.sharing ?? 'company-wide',
        organisationName: src.organisationName,
        sources: [],
      };
      map.set(src.spaceName, group);
    }
    group.sources.push(src);
  }
  return Array.from(map.values());
}

/**
 * Get a human-friendly sharing label for a space.
 */
function sharingLabel(sharing: string): string {
  switch (sharing) {
    case 'company-wide': return 'Company-wide';
    case 'team': return 'Team';
    case 'restricted': return 'Restricted';
    case 'public': return 'Public';
    default: return 'Shared';
  }
}

/**
 * Extract the filename from a relative path.
 */
function fileName(relativePath: string): string {
  const parts = relativePath.split('/');
  return parts[parts.length - 1] || relativePath;
}

export const TeamKnowledgeIndicator = ({ turnEvents, onOpenFile }: TeamKnowledgeIndicatorProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLSpanElement>(null);

  const settingsContext = useSettingsSafe();
  const spaces = settingsContext?.settings?.spaces;

  const sharedSources = useMemo(
    () => extractSharedSources(turnEvents, spaces),
    [turnEvents, spaces],
  );
  const spaceGroups = useMemo(
    () => (sharedSources ? groupBySpace(sharedSources) : []),
    [sharedSources],
  );

  // Outside click + Escape key dismissal
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        cardRef.current && !cardRef.current.contains(target) &&
        containerRef.current && !containerRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const handleToggle = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setIsOpen(prev => !prev);
  }, []);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setIsOpen(prev => !prev);
    }
  }, []);

  // Don't render when there are no shared sources
  if (!sharedSources) return null;

  const sourceCount = sharedSources.length;
  const pillLabel = `Team memory · ${sourceCount} file${sourceCount === 1 ? '' : 's'}`;

  const pillElement = (
    <span
      ref={containerRef}
      className={`team-knowledge-indicator ${isOpen ? 'team-knowledge-indicator--active' : ''}`}
      role="button"
      tabIndex={0}
      aria-expanded={isOpen}
      aria-label={pillLabel}
      onClick={handleToggle}
      onKeyDown={handleKeyDown}
    >
      <Users className="team-knowledge-indicator__icon" size={12} aria-hidden />
      <span className="team-knowledge-indicator__label">{pillLabel}</span>
    </span>
  );

  return (
    <span className="team-knowledge-indicator__container">
      {isOpen ? (
        pillElement
      ) : (
        <Tooltip content="Shared team knowledge informed this response" placement="top" delayShow={300}>
          {pillElement}
        </Tooltip>
      )}
      {isOpen && (
        <TeamKnowledgeCard
          spaceGroups={spaceGroups}
          onClose={() => setIsOpen(false)}
          onOpenFile={onOpenFile}
          cardRef={cardRef}
        />
      )}
    </span>
  );
};

type TeamKnowledgeCardProps = {
  spaceGroups: SpaceGroup[];
  onClose: () => void;
  onOpenFile?: (path: string) => void;
  cardRef: React.RefObject<HTMLDivElement | null>;
};

function TeamKnowledgeCard({ spaceGroups, onClose, onOpenFile, cardRef }: TeamKnowledgeCardProps) {
  // Per-space expansion state: tracks which spaces have been expanded beyond MAX_FILES_PER_SPACE
  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(new Set());
  const organisationGroups = useMemo(
    () => groupItemsByOrganisation(spaceGroups, group => group.organisationName ?? ''),
    [spaceGroups],
  );
  const orderedSpaceGroups = useMemo(
    () => [
      ...organisationGroups.groups.flatMap(group => group.items),
      ...organisationGroups.unorganisedItems,
    ],
    [organisationGroups],
  );

  const toggleExpand = useCallback((spaceName: string) => {
    setExpandedSpaces(prev => {
      const next = new Set(prev);
      if (next.has(spaceName)) {
        next.delete(spaceName);
      } else {
        next.add(spaceName);
      }
      return next;
    });
  }, []);

  const renderSpaceGroup = (group: SpaceGroup) => {
    const isExpanded = expandedSpaces.has(group.spaceName);
    const visibleSources = isExpanded
      ? group.sources
      : group.sources.slice(0, MAX_FILES_PER_SPACE);
    const hiddenCount = group.sources.length - MAX_FILES_PER_SPACE;

    return (
      <div key={group.spaceName} className="team-knowledge-card__group">
        <div className="team-knowledge-card__space-header">
          <span
            className="team-knowledge-card__space-initial"
            style={{ backgroundColor: spaceColor(group.spaceName) }}
            aria-hidden
          >
            {group.spaceDisplayName.charAt(0).toUpperCase()}
          </span>
          <span className="team-knowledge-card__space-name">
            {group.spaceDisplayName}
          </span>
          <span className="team-knowledge-card__sharing-badge">
            {sharingLabel(group.sharing)}
          </span>
        </div>
        <ul className="team-knowledge-card__files">
          {visibleSources.map(src => (
            <li key={src.relativePath} className="team-knowledge-card__file">
              <Tooltip content={src.relativePath} placement="top" delayShow={200}>
                {onOpenFile ? (
                  <button
                    type="button"
                    className="team-knowledge-card__file-link"
                    onClick={() => onOpenFile(src.relativePath)}
                    aria-label={`Open ${fileName(src.relativePath)}`}
                  >
                    <FileText size={12} aria-hidden />
                    <span className="team-knowledge-card__file-name">
                      {fileName(src.relativePath)}
                    </span>
                  </button>
                ) : (
                  <span className="team-knowledge-card__file-link team-knowledge-card__file-link--static">
                    <FileText size={12} aria-hidden />
                    <span className="team-knowledge-card__file-name">
                      {fileName(src.relativePath)}
                    </span>
                  </span>
                )}
              </Tooltip>
            </li>
          ))}
        </ul>
        {hiddenCount > 0 && (
          <button
            type="button"
            className="team-knowledge-card__expand"
            onClick={() => toggleExpand(group.spaceName)}
          >
            {isExpanded ? 'Show less' : `${hiddenCount} more`}
          </button>
        )}
      </div>
    );
  };

  return (
    <div ref={cardRef} className="team-knowledge-card" role="dialog" aria-label="Shared knowledge used">
      <header className="team-knowledge-card__header">
        <div className="team-knowledge-card__header-text">
          <h4 className="team-knowledge-card__title">Shared knowledge used</h4>
          <span className="team-knowledge-card__subtitle">
            Team spaces that informed this response
          </span>
        </div>
        <button
          type="button"
          className="team-knowledge-card__close"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={16} aria-hidden />
        </button>
      </header>
      <div className="team-knowledge-card__content">
        {organisationGroups.shouldShowHeadings ? (
          <>
            {organisationGroups.groups.map(group => (
              <div key={group.key} className="team-knowledge-card__organisation-group">
                <span className="team-knowledge-card__organisation-chip">{group.displayName}</span>
                {group.items.map(renderSpaceGroup)}
              </div>
            ))}
            {organisationGroups.unorganisedItems.length > 0 && (
              <div className="team-knowledge-card__organisation-group">
                <span className="team-knowledge-card__organisation-chip">No organisation set</span>
                {organisationGroups.unorganisedItems.map(renderSpaceGroup)}
              </div>
            )}
          </>
        ) : (
          orderedSpaceGroups.map(renderSpaceGroup)
        )}
      </div>
    </div>
  );
}
