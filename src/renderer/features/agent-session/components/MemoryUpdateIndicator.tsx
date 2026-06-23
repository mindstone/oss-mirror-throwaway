import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { join, basename, relative, isAbsolute } from 'pathe';
import { RefreshCw, AlertTriangle, Save, Globe, X, ExternalLink, Clock, Ban, Eye, FileText } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui';
import { useSettingsSafe } from '@renderer/features/settings';
import { getSpaceDisplayName, getSpaceVisibility } from '@renderer/features/library/utils/pathUtils';
import type { MemoryUpdateStatus, MemoryEntityUpdate, AutoApproveReason } from '@shared/types';
import type { FileOperation } from '@renderer/utils/fileOperations';
import { categorizeFileActivity, type CategorizedActivity } from '@renderer/utils/activityClassification';
import './MemoryUpdateIndicator.css';

type MemoryUpdateIndicatorProps = {
  /** 
   * Memory update status, or undefined if the turn completed without triggering 
   * a memory update at all (we still show a subtle "No memory changes" indicator)
   */
  status: MemoryUpdateStatus | undefined;
  /** File operations from the turn, used to detect memory/skill reads */
  fileOperations?: FileOperation[];
  onOpenFile?: (path: string) => void;
};

type GroupedUpdates = {
  entity: string;
  updates: MemoryEntityUpdate[];
};

const groupUpdatesByEntity = (entityUpdates: MemoryEntityUpdate[]): GroupedUpdates[] => {
  const groups = new Map<string, MemoryEntityUpdate[]>();
  for (const update of entityUpdates) {
    const key = update.entity ?? 'unknown';
    const existing = groups.get(key) ?? [];
    existing.push(update);
    groups.set(key, existing);
  }
  return Array.from(groups.entries()).map(([entity, updates]) => ({ entity, updates }));
};

/**
 * Transform entity names to user-friendly display names.
 * "Chief of Staff" becomes "Private Memory" for clarity - emphasizes the system saving information for you.
 */
const getEntityDisplayName = (entity: string, _visibility: 'private' | 'shared' | undefined): string => {
  if (!entity) return 'Memory';
  const normalized = entity.toLowerCase().replace(/-/g, ' ').trim();
  
  if (normalized === 'chief of staff' || normalized === 'chiefofstaff' || normalized === 'private space') {
    return 'Private Memory';
  }
  
  // For shared work spaces, just use the entity name as-is but title case
  return entity
    .split(/[-_\s]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
};

/**
 * Convert ALL CAPS text to sentence case for readability.
 * Aggressive detection - if any word with 3+ letters is ALL CAPS, convert the whole thing.
 */
const toSentenceCase = (text: string): string => {
  if (!text) return text;
  
  // Check if any word with 3+ letters is ALL CAPS (strong indicator of LLM output)
  const hasAllCapsWord = /\b[A-Z]{3,}\b/.test(text);
  
  if (hasAllCapsWord) {
    // Convert to sentence case: first letter uppercase, rest lowercase
    return text
      .toLowerCase()
      .replace(/^\w/, c => c.toUpperCase())
      // Re-capitalize after periods
      .replace(/\. \w/g, match => match.toUpperCase());
  }
  
  return text;
};

/**
 * Get a Rebel-voice explanation for why a memory write was auto-approved.
 * Displayed in the card to help users understand the memory safety system.
 * 
 * Updated to align with the new simplified safety level names:
 * - permissive = "Save without asking"
 * - balanced = "Ask, if content is sensitive"  
 * - cautious = "Always ask before saving"
 */
const getAutoApproveExplanation = (
  reason: AutoApproveReason,
  visibility: 'private' | 'shared'
): string => {
  const isShared = visibility === 'shared';
  
  switch (reason) {
    case 'private_space':
      return 'Private space — saved without asking.';
    case 'permissive_setting':
      return isShared
        ? 'Shared with others, but set to "Save without asking".'
        : 'Set to "Save without asking".';
    case 'space_override_permissive':
      return isShared
        ? 'Shared space, but set to "Save without asking".'
        : 'Set to "Save without asking".';
    case 'low_sensitivity':
      return isShared
        ? 'Shared — nothing sensitive detected.'
        : 'Nothing sensitive detected — saved.';
    case 'safety_prompt_allowed':
      return isShared
        ? 'Shared — safety rules allow this.'
        : 'Safety rules allow this — saved.';
    case 'pre_approved':
      return 'You approved this earlier.';
    default:
      return 'Saved automatically.';
  }
};

type MemoryUpdateCardProps = {
  entityUpdates: MemoryEntityUpdate[];
  coreDirectory: string | undefined;
  activity?: CategorizedActivity;
  onClose: () => void;
  onOpenFile?: (path: string) => void;
};

const MemoryUpdateCard = ({ entityUpdates, coreDirectory, activity, onClose, onOpenFile }: MemoryUpdateCardProps) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const groupedUpdates = groupUpdatesByEntity(entityUpdates);
  
  // State for normalized paths (maps real paths to workspace-relative paths)
  const [normalizedPaths, setNormalizedPaths] = useState<Record<string, string>>({});
  
  // Collect all paths that need normalization
  const allPaths = useMemo(() => {
    const paths = new Set<string>();
    // Entity update file paths
    for (const update of entityUpdates) {
      if (update.filePath) paths.add(update.filePath);
    }
    // Activity file paths
    if (activity) {
      for (const p of activity.memoryReads) paths.add(p);
      for (const p of activity.memoryWrites) paths.add(p);
      for (const p of activity.skillReads) paths.add(p);
      for (const p of activity.skillWrites) paths.add(p);
      for (const p of activity.instructionsReads) paths.add(p);
      for (const p of activity.instructionsWrites) paths.add(p);
      for (const p of activity.workspaceWrites) paths.add(p);
    }
    return Array.from(paths);
  }, [entityUpdates, activity]);
  
  // Create a stable key for the paths to avoid unnecessary effect re-runs
  // Array.from creates a new reference each time, but the content is the same
  const pathsKey = useMemo(() => allPaths.sort().join('|'), [allPaths]);
  
  // Normalize paths via IPC (handles symlink resolution)
  useEffect(() => {
    if (allPaths.length === 0) return;
    
    let cancelled = false;
    
    const normalizePaths = async () => {
      try {
        const result = await window.libraryApi.normalizePaths({ paths: allPaths });
        if (!cancelled) {
          setNormalizedPaths(result.normalized);
        }
      } catch (error) {
        // If normalization fails, we'll fall back to the heuristic approach
        console.warn('Failed to normalize paths:', error);
      }
    };
    
    normalizePaths();
    
    return () => {
      cancelled = true;
    };
  }, [pathsKey, allPaths]);

  /** 
   * Convert absolute path to a user-friendly display path.
   * Uses normalized paths from IPC (which handles symlinks), with fallback heuristics.
   */
  const toRelativePath = useCallback((filePath: string): string => {
    // First, check if we have a normalized path from IPC
    if (normalizedPaths[filePath]) {
      return normalizedPaths[filePath];
    }
    
    // Fallback: simple relative path calculation
    if (!coreDirectory || !isAbsolute(filePath)) return filePath;
    
    const relativePath = relative(coreDirectory, filePath);
    
    // If the relative path starts with "..", the file is outside coreDirectory
    // Show a condensed version instead of the confusing "../../../" prefix
    if (relativePath.startsWith('..')) {
      // Try to find a recognizable root folder to display from
      const parts = filePath.split(/[\\/]/);
      
      // Look for GoogleDrive folder - show path from there
      const googleDriveIdx = parts.findIndex(p => p.startsWith('GoogleDrive-'));
      if (googleDriveIdx !== -1) {
        // Extract email portion from "[external-email]" for brevity
        const drivePart = parts[googleDriveIdx];
        const email = drivePart.replace('GoogleDrive-', '');
        const pathFromDrive = parts.slice(googleDriveIdx + 1).join('/');
        return `${email}/${pathFromDrive}`;
      }
      
      // Look for CloudStorage folder (iCloud, OneDrive, etc.)
      const cloudStorageIdx = parts.findIndex(p => p === 'CloudStorage');
      if (cloudStorageIdx !== -1 && cloudStorageIdx + 1 < parts.length) {
        return parts.slice(cloudStorageIdx + 1).join('/');
      }
      
      // Fallback: show last 3-4 meaningful path segments
      // Skip common prefixes like Users, Library, etc.
      const meaningfulParts = parts.filter(p => 
        p && !['', 'Users', 'Library', 'Documents', 'home'].includes(p)
      );
      if (meaningfulParts.length > 4) {
        return '.../' + meaningfulParts.slice(-3).join('/');
      }
      return meaningfulParts.join('/');
    }
    
    return relativePath || filePath;
  }, [coreDirectory, normalizedPaths]);
  
  // Determine if any updates are shared vs all private
  const hasWrites = entityUpdates.length > 0;
  const hasReads = activity && (activity.memoryReads.length > 0 || activity.skillReads.length > 0 || activity.instructionsReads.length > 0);
  const hasInstructionsActivity = activity && (activity.instructionsWrites.length > 0 || activity.instructionsReads.length > 0);
  const hasWorkspaceWrites = activity && activity.workspaceWrites.length > 0;
  const hasSharedUpdates = entityUpdates.some(u => u.visibility === 'shared');
  const hasPrivateUpdates = entityUpdates.some(u => u.visibility === 'private');
  
  // Check if reads are only from instructions (not memory/skills)
  const hasOnlyInstructionsReads = activity && 
    activity.instructionsReads.length > 0 && 
    activity.memoryReads.length === 0 && 
    activity.skillReads.length === 0;
  
  // Dynamic title based on whether there are writes, reads, instructions, workspace files, or combinations
  const cardTitle = (() => {
    // Workspace files only (documents created for user)
    if (hasWorkspaceWrites && !hasWrites && !hasInstructionsActivity) {
      return 'Files Created';
    }
    // Instructions-only activity (no memory service writes, only instructions)
    if (hasInstructionsActivity && !hasWrites && !hasWorkspaceWrites) {
      if (hasOnlyInstructionsReads) return 'Instructions Referenced';
      return 'Instructions Activity';
    }
    // Mixed activity
    if ((hasWrites || hasWorkspaceWrites) && hasReads) return 'File Activity';
    if (hasWrites) return 'Memory Updated';
    if (hasWorkspaceWrites) return 'Files Created';
    if (hasReads) return 'Memory Referenced';
    return 'File Activity';
  })();
  
  const privacySubtitle = (() => {
    if (!hasWrites && hasReads) {
      return 'Files that informed this response';
    }
    if (hasSharedUpdates && hasPrivateUpdates) {
      return 'Some updates are shared with others';
    }
    if (hasSharedUpdates) {
      return 'Visible to others with folder access';
    }
    return 'Only you can see this';
  })();

  const handleFileClick = useCallback(async (filePath: string) => {
    if (!filePath) return;
    // If onOpenFile is provided and file is editable (md, txt), open in internal editor
    if (onOpenFile) {
      const lower = filePath.toLowerCase();
      const editableExtensions = ['.md', '.markdown', '.mdx', '.mdown', '.mkd', '.txt', '.text'];
      if (editableExtensions.some(ext => lower.endsWith(ext))) {
        onOpenFile(filePath);
        onClose();
        return;
      }
    }
    // Otherwise reveal in Finder
    if (!coreDirectory) return;
    const absolutePath = join(coreDirectory, filePath);
    try {
      await window.api.revealPath(absolutePath);
    } catch (error) {
      console.error('Failed to reveal file:', error);
    }
  }, [coreDirectory, onOpenFile, onClose]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  return (
    <div ref={cardRef} className="memory-update-card" role="dialog" aria-label="Memory activity">
      <header className="memory-update-card__header">
        <div className="memory-update-card__header-text">
          <h4 className="memory-update-card__title">{cardTitle}</h4>
          <span className="memory-update-card__subtitle">{privacySubtitle}</span>
        </div>
        <button
          type="button"
          className="memory-update-card__close"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={16} aria-hidden />
        </button>
      </header>
      <div className="memory-update-card__content">
        {groupedUpdates.map((group) => {
          const visibility = group.updates[0]?.visibility;
          const displayName = getEntityDisplayName(group.entity, visibility);
          const isPrivate = visibility === 'private';
          
          return (
            <div key={group.entity} className="memory-update-card__group">
              <div className="memory-update-card__entity-header">
                <span 
                  className="memory-update-card__entity-visibility" 
                  title={isPrivate 
                    ? 'Private — only you can see this' 
                    : 'Shared — visible to others with folder access'}
                >
                  {isPrivate ? (
                    <Save className="memory-update-card__visibility-icon" />
                  ) : (
                    <Globe className="memory-update-card__visibility-icon" />
                  )}
                </span>
                <span className="memory-update-card__entity-name">{toSentenceCase(displayName)}</span>
              </div>
              <ul className="memory-update-card__updates">
                {group.updates.map((update, idx) => (
                  <li key={idx} className="memory-update-card__update">
                    {(() => {
                      const filePath = update.filePath;
                      return (
                        <>
                    <span className="memory-update-card__summary">{toSentenceCase(update.summary)}</span>
                    {update.autoApproveReason && (
                      <span className="memory-update-card__auto-approve-reason">
                        {getAutoApproveExplanation(update.autoApproveReason, update.visibility)}
                      </span>
                    )}
                    {filePath && (
                      <Tooltip content={`Click to open ${toRelativePath(filePath)}`} placement="top" delayShow={200}>
                        <button
                          type="button"
                          className="memory-update-card__file-link"
                          onClick={() => handleFileClick(filePath)}
                          aria-label={`Open ${toRelativePath(filePath)}`}
                        >
                          <ExternalLink size={12} aria-hidden />
                          <span className="memory-update-card__file-path">{toRelativePath(filePath)}</span>
                        </button>
                      </Tooltip>
                    )}
                        </>
                      );
                    })()}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {/* Memory References Section - files read but not written */}
        {activity && activity.memoryReads.length > 0 && (
          <div className="memory-update-card__group memory-update-card__group--referenced">
            <div className="memory-update-card__entity-header">
              <span className="memory-update-card__entity-visibility">
                <Eye className="memory-update-card__visibility-icon memory-update-card__visibility-icon--muted" />
              </span>
              <span className="memory-update-card__entity-name memory-update-card__entity-name--muted">
                Memory referenced
              </span>
            </div>
            <ul className="memory-update-card__updates memory-update-card__updates--referenced">
              {activity.memoryReads.map((filePath) => (
                <li key={filePath} className="memory-update-card__update memory-update-card__update--referenced">
                  <Tooltip content={`Click to open ${toRelativePath(filePath)}`} placement="top" delayShow={200}>
                    <button
                      type="button"
                      className="memory-update-card__file-link memory-update-card__file-link--referenced"
                      onClick={() => handleFileClick(filePath)}
                      aria-label={`Open ${toRelativePath(filePath)}`}
                    >
                      <ExternalLink size={12} aria-hidden />
                      <span className="memory-update-card__file-path">{toRelativePath(filePath)}</span>
                    </button>
                  </Tooltip>
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* Skill References Section - files read but not written */}
        {activity && activity.skillReads.length > 0 && (
          <div className="memory-update-card__group memory-update-card__group--referenced">
            <div className="memory-update-card__entity-header">
              <span className="memory-update-card__entity-visibility">
                <Eye className="memory-update-card__visibility-icon memory-update-card__visibility-icon--muted" />
              </span>
              <span className="memory-update-card__entity-name memory-update-card__entity-name--muted">
                Skills referenced
              </span>
            </div>
            <ul className="memory-update-card__updates memory-update-card__updates--referenced">
              {activity.skillReads.map((filePath) => (
                <li key={filePath} className="memory-update-card__update memory-update-card__update--referenced">
                  <Tooltip content={`Click to open ${toRelativePath(filePath)}`} placement="top" delayShow={200}>
                    <button
                      type="button"
                      className="memory-update-card__file-link memory-update-card__file-link--referenced"
                      onClick={() => handleFileClick(filePath)}
                      aria-label={`Open ${toRelativePath(filePath)}`}
                    >
                      <ExternalLink size={12} aria-hidden />
                      <span className="memory-update-card__file-path">{toRelativePath(filePath)}</span>
                    </button>
                  </Tooltip>
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* Memory Writes Section - direct file edits (not through memory service) */}
        {/* Group by visibility to show private vs shared with appropriate icons */}
        {activity && activity.memoryWrites.length > 0 && entityUpdates.length === 0 && (() => {
          const privateWrites = activity.memoryWrites.filter(p => getSpaceVisibility(p) === 'private');
          const sharedWrites = activity.memoryWrites.filter(p => getSpaceVisibility(p) === 'shared');
          return (
            <>
              {privateWrites.length > 0 && (
                <div className="memory-update-card__group">
                  <div className="memory-update-card__entity-header">
                    <span className="memory-update-card__entity-visibility">
                      <Save className="memory-update-card__visibility-icon" />
                    </span>
                    <span className="memory-update-card__entity-name">
                      Private memory modified
                    </span>
                  </div>
                  <ul className="memory-update-card__updates">
                    {privateWrites.map((filePath) => (
                      <li key={filePath} className="memory-update-card__update">
                        <Tooltip content={`Click to open ${toRelativePath(filePath)}`} placement="top" delayShow={200}>
                          <button
                            type="button"
                            className="memory-update-card__file-link"
                            onClick={() => handleFileClick(filePath)}
                            aria-label={`Open ${toRelativePath(filePath)}`}
                          >
                            <ExternalLink size={12} aria-hidden />
                            <span className="memory-update-card__file-path">{toRelativePath(filePath)}</span>
                          </button>
                        </Tooltip>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {sharedWrites.length > 0 && (
                <div className="memory-update-card__group">
                  <div className="memory-update-card__entity-header">
                    <span className="memory-update-card__entity-visibility">
                      <Globe className="memory-update-card__visibility-icon" />
                    </span>
                    <span className="memory-update-card__entity-name">
                      Shared memory modified
                    </span>
                  </div>
                  <ul className="memory-update-card__updates">
                    {sharedWrites.map((filePath) => (
                      <li key={filePath} className="memory-update-card__update">
                        <Tooltip content={`Click to open ${toRelativePath(filePath)}`} placement="top" delayShow={200}>
                          <button
                            type="button"
                            className="memory-update-card__file-link"
                            onClick={() => handleFileClick(filePath)}
                            aria-label={`Open ${toRelativePath(filePath)}`}
                          >
                            <ExternalLink size={12} aria-hidden />
                            <span className="memory-update-card__file-path">{toRelativePath(filePath)}</span>
                          </button>
                        </Tooltip>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          );
        })()}
        {/* Skill Writes Section - direct file edits */}
        {activity && activity.skillWrites.length > 0 && (
          <div className="memory-update-card__group">
            <div className="memory-update-card__entity-header">
              <span className="memory-update-card__entity-visibility">
                <Save className="memory-update-card__visibility-icon" />
              </span>
              <span className="memory-update-card__entity-name">
                Skills updated
              </span>
            </div>
            <ul className="memory-update-card__updates">
              {activity.skillWrites.map((filePath) => (
                <li key={filePath} className="memory-update-card__update">
                  <Tooltip content={`Click to open ${toRelativePath(filePath)}`} placement="top" delayShow={200}>
                    <button
                      type="button"
                      className="memory-update-card__file-link"
                      onClick={() => handleFileClick(filePath)}
                      aria-label={`Open ${toRelativePath(filePath)}`}
                    >
                      <ExternalLink size={12} aria-hidden />
                      <span className="memory-update-card__file-path">{toRelativePath(filePath)}</span>
                    </button>
                  </Tooltip>
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* Instructions Writes Section - space README.md files */}
        {activity && activity.instructionsWrites.length > 0 && (
          <div className="memory-update-card__group">
            <div className="memory-update-card__entity-header">
              <span className="memory-update-card__entity-visibility">
                <FileText className="memory-update-card__visibility-icon" />
              </span>
              <span className="memory-update-card__entity-name">
                Instructions updated
              </span>
            </div>
            <ul className="memory-update-card__updates">
              {activity.instructionsWrites.map((filePath) => (
                <li key={filePath} className="memory-update-card__update">
                  <Tooltip content={`Click to open ${toRelativePath(filePath)}`} placement="top" delayShow={200}>
                    <button
                      type="button"
                      className="memory-update-card__file-link"
                      onClick={() => handleFileClick(filePath)}
                      aria-label={`Open ${toRelativePath(filePath)}`}
                    >
                      <ExternalLink size={12} aria-hidden />
                      <span className="memory-update-card__file-path">{toRelativePath(filePath)}</span>
                    </button>
                  </Tooltip>
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* Workspace Files Section - documents created for user (not in memory/skills) */}
        {activity && activity.workspaceWrites.length > 0 && (() => {
          const privateFiles = activity.workspaceWrites.filter(p => getSpaceVisibility(p) === 'private');
          const sharedFiles = activity.workspaceWrites.filter(p => getSpaceVisibility(p) === 'shared');
          return (
            <>
              {privateFiles.length > 0 && (
                <div className="memory-update-card__group">
                  <div className="memory-update-card__entity-header">
                    <span className="memory-update-card__entity-visibility">
                      <FileText className="memory-update-card__visibility-icon" />
                    </span>
                    <span className="memory-update-card__entity-name">
                      Files created for you
                    </span>
                  </div>
                  <ul className="memory-update-card__updates">
                    {privateFiles.map((filePath) => (
                      <li key={filePath} className="memory-update-card__update">
                        <Tooltip content={`Click to open ${toRelativePath(filePath)}`} placement="top" delayShow={200}>
                          <button
                            type="button"
                            className="memory-update-card__file-link"
                            onClick={() => handleFileClick(filePath)}
                            aria-label={`Open ${toRelativePath(filePath)}`}
                          >
                            <ExternalLink size={12} aria-hidden />
                            <span className="memory-update-card__file-path">{toRelativePath(filePath)}</span>
                          </button>
                        </Tooltip>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {sharedFiles.length > 0 && (
                <div className="memory-update-card__group">
                  <div className="memory-update-card__entity-header">
                    <span className="memory-update-card__entity-visibility">
                      <Globe className="memory-update-card__visibility-icon" />
                    </span>
                    <span className="memory-update-card__entity-name">
                      Shared files created
                    </span>
                  </div>
                  <ul className="memory-update-card__updates">
                    {sharedFiles.map((filePath) => (
                      <li key={filePath} className="memory-update-card__update">
                        <Tooltip content={`Click to open ${toRelativePath(filePath)}`} placement="top" delayShow={200}>
                          <button
                            type="button"
                            className="memory-update-card__file-link"
                            onClick={() => handleFileClick(filePath)}
                            aria-label={`Open ${toRelativePath(filePath)}`}
                          >
                            <ExternalLink size={12} aria-hidden />
                            <span className="memory-update-card__file-path">{toRelativePath(filePath)}</span>
                          </button>
                        </Tooltip>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          );
        })()}
        {/* Instructions Reads Section */}
        {activity && activity.instructionsReads.length > 0 && (
          <div className="memory-update-card__group memory-update-card__group--referenced">
            <div className="memory-update-card__entity-header">
              <span className="memory-update-card__entity-visibility">
                <Eye className="memory-update-card__visibility-icon memory-update-card__visibility-icon--muted" />
              </span>
              <span className="memory-update-card__entity-name memory-update-card__entity-name--muted">
                Instructions referenced
              </span>
            </div>
            <ul className="memory-update-card__updates memory-update-card__updates--referenced">
              {activity.instructionsReads.map((filePath) => (
                <li key={filePath} className="memory-update-card__update memory-update-card__update--referenced">
                  <Tooltip content={`Click to open ${toRelativePath(filePath)}`} placement="top" delayShow={200}>
                    <button
                      type="button"
                      className="memory-update-card__file-link memory-update-card__file-link--referenced"
                      onClick={() => handleFileClick(filePath)}
                      aria-label={`Open ${toRelativePath(filePath)}`}
                    >
                      <ExternalLink size={12} aria-hidden />
                      <span className="memory-update-card__file-path">{toRelativePath(filePath)}</span>
                    </button>
                  </Tooltip>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
};

export const MemoryUpdateIndicator = ({ status, fileOperations, onOpenFile }: MemoryUpdateIndicatorProps) => {
  const [isCardOpen, setIsCardOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const settingsContext = useSettingsSafe();
  const coreDirectory = settingsContext?.settings?.coreDirectory;

  // Handle "no status" case - turn completed but memory update didn't run
  const isNoStatus = !status;
  
  // Categorize file activity (reads vs writes for memory/skill files)
  const activity = useMemo(() => {
    if (!fileOperations || fileOperations.length === 0) return undefined;
    return categorizeFileActivity(fileOperations, status);
  }, [fileOperations, status]);
  
  const hasUpdates = status?.status === 'success' && status.entityUpdates && status.entityUpdates.length > 0;
  const hasReads = activity && (activity.memoryReads.length > 0 || activity.skillReads.length > 0 || activity.instructionsReads.length > 0);
  // Direct file writes (not through memory service) - e.g., "move memory to another space"
  const hasDirectWrites = activity && (activity.memoryWrites.length > 0 || activity.skillWrites.length > 0);
  // Instructions (README.md) changes - high-salience files that define space behavior
  const hasInstructionsWrites = activity && activity.instructionsWrites.length > 0;
  const hasInstructionsReads = activity && activity.instructionsReads.length > 0;
  // Workspace files (documents created for user, not in memory/skills directories)
  const hasWorkspaceWrites = activity && activity.workspaceWrites.length > 0;
  
  // Indicator is clickable if there are writes (service, direct, or workspace), instructions, or reads to show
  // Also clickable during 'running' if there are direct writes to show immediately
  const isRunningWithDirectWrites = status?.status === 'running' && (hasDirectWrites || hasInstructionsWrites || hasWorkspaceWrites);
  const isClickable = hasUpdates || hasReads || hasDirectWrites || hasInstructionsWrites || hasWorkspaceWrites || isRunningWithDirectWrites;
  
  // Check if any update is shared (for visual styling) - includes both service updates and direct writes
  const hasSharedUpdate = useMemo(() => {
    // Check service updates
    if (status?.entityUpdates?.some(u => u.visibility === 'shared')) return true;
    // Check direct memory writes
    if (activity?.memoryWrites.some(p => getSpaceVisibility(p) === 'shared')) return true;
    return false;
  }, [status?.entityUpdates, activity?.memoryWrites]);
  
  // Card only opens on explicit user click — no auto-expand
  
  // Apply shared styling when there are shared updates (service or direct writes)
  const shouldShowSharedStyling = hasSharedUpdate && (hasUpdates || hasDirectWrites);
  const statusClass = [
    'memory-update-indicator',
    isNoStatus ? 'memory-update-indicator--none' : `memory-update-indicator--${status.status}`,
    shouldShowSharedStyling ? 'memory-update-indicator--shared' : ''
  ].filter(Boolean).join(' ');

  const handleClose = useCallback(() => {
    setIsCardOpen(false);
  }, []);

  const handleClick = useCallback((event: React.MouseEvent) => {
    if (!isClickable) return;
    event.stopPropagation();
    setIsCardOpen((prev) => !prev);
  }, [isClickable]);

  // Determine icon for success state with updates
  // Save icon for private memory (emphasizes system saving for you), Globe for shared
  const memoryIcon = useMemo(() => {
    if (status?.status === 'success' && hasUpdates && status.entityUpdates && status.entityUpdates.length > 0) {
      const isShared = status.entityUpdates[0].visibility === 'shared';
      return isShared ? (
        <Globe className="memory-update-indicator__icon" aria-hidden />
      ) : (
        <Save className="memory-update-indicator__icon" aria-hidden />
      );
    }
    return null;
  }, [status?.status, hasUpdates, status?.entityUpdates]);

  const icon = (() => {
    // No status = no memory update ran for this turn
    if (isNoStatus) {
      // Show FileText icon for instructions or workspace file updates
      if (hasInstructionsWrites || hasWorkspaceWrites) {
        return <FileText className="memory-update-indicator__icon" aria-hidden />;
      }
      return null; // No icon for subtle "no changes" state
    }
    switch (status.status) {
      case 'running':
        // Show appropriate icon + spinner based on what was modified
        if (hasInstructionsWrites || hasDirectWrites || hasWorkspaceWrites) {
          const DirectWriteIcon = hasInstructionsWrites ? FileText : hasWorkspaceWrites ? FileText : (hasSharedUpdate ? Globe : Save);
          return (
            <>
              <DirectWriteIcon className="memory-update-indicator__icon" aria-hidden />
              <RefreshCw
                className="memory-update-indicator__icon memory-update-indicator__spinner memory-update-indicator__spinner--secondary"
                aria-hidden
              />
            </>
          );
        }
        return (
          <RefreshCw
            className="memory-update-indicator__icon memory-update-indicator__spinner"
            aria-hidden
          />
        );
      case 'success':
        // Use memory icon (Save/Globe) instead of generic checkmark
        return memoryIcon;
      case 'error':
        return <AlertTriangle className="memory-update-indicator__icon" aria-hidden />;
      case 'pending_approval':
        return <Clock className="memory-update-indicator__icon" aria-hidden />;
      case 'skipped':
        return <Ban className="memory-update-indicator__icon" aria-hidden />;
    }
  })();

  // Determine what type of activity we have (for accurate labeling)
  const hasMemoryReads = activity && activity.memoryReads.length > 0;
  const hasSkillReads = activity && activity.skillReads.length > 0;
  const hasMemoryWrites = activity && activity.memoryWrites.length > 0;
  const hasSkillWrites = activity && activity.skillWrites.length > 0;
  
  // Generate label that accurately reflects what activity occurred
  const getReadsLabel = () => {
    if (hasInstructionsReads) return 'Instructions referenced';
    if (hasMemoryReads && hasSkillReads) return 'Files referenced';
    if (hasMemoryReads) return 'Memory referenced';
    if (hasSkillReads) return 'Skills referenced';
    return 'Files referenced';
  };
  
  // Generate label for direct writes (not through memory service)
  const getDirectWritesLabel = () => {
    // Instructions take priority in labeling
    if (hasInstructionsWrites) return 'Instructions updated';
    if (hasMemoryWrites && hasSkillWrites) return 'Memory modified';
    if (hasMemoryWrites) return 'Memory modified';
    if (hasSkillWrites) return 'Skills updated';
    return 'Memory modified';
  };
  
  // Generate label for workspace file writes
  const getWorkspaceWritesLabel = () => {
    if (!activity) return 'Files created';
    const count = activity.workspaceWrites.length;
    if (count === 1) {
      const fileName = basename(activity.workspaceWrites[0]);
      return `Created ${fileName}`;
    }
    return `${count} files created`;
  };

  const label = useMemo(() => {
    // No status = turn completed without triggering memory update
    // But there may still be direct file writes, instructions, workspace files, or reads
    if (isNoStatus) {
      // Instructions updates are high-priority - show them first
      if (hasInstructionsWrites) {
        return 'Instructions updated';
      }
      if (hasDirectWrites) {
        return getDirectWritesLabel();
      }
      // Workspace files (documents created for user)
      if (hasWorkspaceWrites) {
        return getWorkspaceWritesLabel();
      }
      if (hasReads) {
        return getReadsLabel();
      }
      return 'No changes';
    }
    switch (status.status) {
      case 'running':
        // Show direct writes/instructions/workspace files immediately, with note that background is still running
        if (hasInstructionsWrites) {
          return 'Instructions updated · Taking notes...';
        }
        if (hasDirectWrites) {
          return `${getDirectWritesLabel()} · Taking notes...`;
        }
        if (hasWorkspaceWrites) {
          return `${getWorkspaceWritesLabel()} · Taking notes...`;
        }
        return 'Taking notes...';
      case 'success':
        if (hasUpdates && status.entityUpdates && status.entityUpdates.length > 0) {
          // Determine unique spaces updated
          const uniqueSpaces = new Set<string>();
          const spaceInfos: { name: string; visibility: 'private' | 'shared' }[] = [];
          
          for (const update of status.entityUpdates) {
            const spaceName = getSpaceDisplayName(update.filePath);
            if (!uniqueSpaces.has(spaceName)) {
              uniqueSpaces.add(spaceName);
              spaceInfos.push({ name: spaceName, visibility: update.visibility });
            }
          }
          
          // Multi-space: show count
          if (uniqueSpaces.size > 1) {
            return `${uniqueSpaces.size} spaces updated`;
          }
          
          // Single space: show "Private: SpaceName" or "Shared: SpaceName"
          const { name, visibility } = spaceInfos[0];
          const prefix = visibility === 'shared' ? 'Shared' : 'Private';
          return `${prefix}: ${name}`;
        }
        // Instructions updates should still be surfaced even when memory status exists
        if (hasInstructionsWrites) {
          return 'Instructions updated';
        }
        // Workspace files created
        if (hasWorkspaceWrites) {
          return getWorkspaceWritesLabel();
        }
        // No writes but reads exist
        if (hasReads) {
          return getReadsLabel();
        }
        return 'Memory checked';
      case 'error':
        return 'Memory update failed';
      case 'pending_approval':
        return 'Save to memory?';
      case 'skipped':
        return 'Memory skipped';
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- getDirectWritesLabel, getReadsLabel, getWorkspaceWritesLabel are plain functions that depend on the same state variables already listed in deps; wrapping in useCallback would add complexity without benefit
  }, [isNoStatus, status?.status, status?.entityUpdates, hasUpdates, hasReads, hasDirectWrites, hasInstructionsWrites, hasInstructionsReads, hasMemoryReads, hasSkillReads, hasMemoryWrites, hasSkillWrites, hasWorkspaceWrites, activity?.workspaceWrites]);

  const tooltipContent = useMemo(() => {
    // No status = turn completed without triggering memory update
    if (isNoStatus) {
      if (hasInstructionsWrites) {
        return 'Space instructions (README.md) were updated. Click to view.';
      }
      if (hasDirectWrites) {
        return 'Memory files were modified. Click to view.';
      }
      if (hasWorkspaceWrites) {
        return 'Files were created for you. Click to view.';
      }
      if (hasReads) {
        return 'Referenced memory/skill files. Click to view.';
      }
      return 'No files were modified this turn';
    }
    if (status.status === 'running') {
      if (hasInstructionsWrites || hasDirectWrites || hasWorkspaceWrites) {
        return 'Files were modified. Click to view. Background notes still being taken...';
      }
      return 'Analyzing what\'s worth saving, where it belongs, and whether it\'s new or an update.';
    }
    if (status.status === 'error' && status.error) {
      return `Error: ${status.error}`;
    }
    if (status.status === 'pending_approval') {
      return 'Rebel wants to save this to memory. Click to approve or skip.';
    }
    if (status.status === 'skipped') {
      return 'Memory update was skipped';
    }
    if (status.status === 'success') {
      if (hasUpdates && status.entityUpdates && status.entityUpdates.length > 0) {
        const firstUpdate = status.entityUpdates[0];
        const isShared = firstUpdate.visibility === 'shared';
        const spaceName = getSpaceDisplayName(firstUpdate.filePath);
        if (isShared) {
          return `Saved to ${spaceName} (shared with your team). Click to view.`;
        }
        return `Saved to Private Memory (only you can see this). Click to view.`;
      }
      // No writes but reads exist
      if (hasReads) {
        return 'Referenced memory/skill files. Click to view.';
      }
      if (status.summary) {
        return status.summary;
      }
      return 'Nothing new to note';
    }
    return label;
  }, [isNoStatus, status?.status, status?.error, status?.summary, status?.entityUpdates, hasUpdates, hasReads, hasInstructionsWrites, hasDirectWrites, hasWorkspaceWrites, label]);

  const pillElement = (
    <span
      ref={containerRef}
      className={`${statusClass} ${isClickable ? 'memory-update-indicator--clickable' : ''} ${isCardOpen ? 'memory-update-indicator--active' : ''}`}
      aria-label={label}
      onClick={handleClick}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onKeyDown={isClickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(e as unknown as React.MouseEvent); } } : undefined}
    >
      {icon}
      <span className="memory-update-indicator__label">{label}</span>
    </span>
  );

  return (
    <span className="memory-update-indicator__container">
      {isCardOpen ? (
        pillElement
      ) : (
        <Tooltip content={tooltipContent} placement="top" delayShow={300}>
          {pillElement}
        </Tooltip>
      )}
      {isCardOpen && (hasUpdates || hasReads || hasDirectWrites || hasInstructionsWrites || hasWorkspaceWrites || isRunningWithDirectWrites) && (
        <MemoryUpdateCard
          entityUpdates={status?.entityUpdates ?? []}
          coreDirectory={coreDirectory ?? undefined}
          activity={activity}
          onClose={handleClose}
          onOpenFile={onOpenFile}
        />
      )}
    </span>
  );
};
