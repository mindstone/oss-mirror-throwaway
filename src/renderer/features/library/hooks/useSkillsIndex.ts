import { useCallback } from 'react';
import { useAsyncData } from '@renderer/hooks/useAsyncData';

export type { ExampleMeta } from '../../../../core/skillQualityScore';

/**
 * Skill frontmatter parsed from skill files.
 */
export interface SkillFrontmatter {
  description: string;
  use_cases?: string[];
  last_updated?: string;
  tools_required?: string[];
  agent_type?: 'main_agent' | 'subagent';
  dependencies?: string[];
  extends?: string;
  extension_type?: 'overlay' | 'replace';
  /** Original creator of the skill */
  author?: string;
  /** Stable auth ID for the original creator */
  author_id?: string;
  /** Email captured for notification routing */
  author_email?: string;
  /** How the author attribution was established */
  author_source?: 'created' | 'migrated' | 'confirmed';
  /** People who have improved this skill */
  contributed?: string[];
  /** Stable auth IDs for everyone who has contributed */
  contributors?: string[];
  /** Most recent person to edit this skill */
  last_modified_by?: string;
  /** Stable auth ID for the most recent modifier */
  last_modified_by_id?: string;
  /** Email captured for notification routing */
  last_modified_by_email?: string;
  /** ISO date of last modification (YYYY-MM-DD) */
  last_modified_at?: string;
  /** Extra context for the last modification, e.g. agent-triggered input */
  last_modified_context?: string;
  /** Type of coach skill for filtering in coach picker (e.g., 'meeting') */
  coach_type?: string;
  /** Proactive analysis interval in minutes for coach skills (default: 2) */
  proactive_interval_minutes?: number;
  /** Optional output-routing contract for artifact-shaped skills. */
  output_shape?: {
    default_surface?: 'chat_summary' | 'chat_answer' | 'file_artifact' | 'interactive_view' | 'expandable_report';
    chat_contract?: 'concise_summary' | 'direct_answer' | 'decision_brief' | 'blocker_only';
    artifact_expected?: boolean;
    max_chat_words?: number;
    source_policy?: 'inline_key_sources' | 'artifact_sources' | 'none';
  };
}

/**
 * Information about a single skill file.
 */
export interface SkillInfo {
  name: string;
  relativePath: string;
  absolutePath: string;
  category: string;
  frontmatter?: SkillFrontmatter;
  hasFrontmatter: boolean;
  /** Example file paths relative to workspace root (if examples/ folder exists) */
  examples?: string[];
  /** Number of times this skill has been used */
  usageCount?: number;
  /** Timestamp of last usage (ms since epoch) */
  lastUsedAt?: number;
  /** Quality score from skill scoring engine (0-100) */
  qualityScore?: number;
  /** Quality band label derived from score */
  qualityBand?: 'seedling' | 'growing' | 'solid' | 'exemplary';
  /** Highest-impact improvement suggestion for this skill */
  qualityTopImprovement?: {
    dimension: string;
    suggestion: string;
  };
}

/**
 * Grouped skills by source location.
 */
export interface SkillsGroup {
  source: string;
  label: string;
  type: 'platform' | 'space' | 'workspace';
  categories: Record<string, SkillInfo[]>;
  count: number;
  /** Whether this is a built-in/read-only source (platform skills) */
  isBuiltIn?: boolean;
  /** Relative path within workspace for display */
  relativePath?: string;
  /** Absolute path on disk */
  absolutePath?: string;
  /** Whether this source is a symlink */
  isSymlink?: boolean;
  /** Storage provider for symlinked sources (google_drive, onedrive, dropbox, etc.) */
  storageProvider?: 'google_drive' | 'onedrive' | 'dropbox' | 'box' | 'icloud' | 'local' | 'other';
  /** Sharing level (private, restricted/team, company-wide, public) */
  sharing?: 'private' | 'restricted' | 'team' | 'company-wide' | 'public';
}

/**
 * Result of scanning for skills.
 */
export interface SkillsScanResult {
  groups: SkillsGroup[];
  totalCount: number;
}

interface UseSkillsIndexOptions {
  enabled?: boolean;
}

interface UseSkillsIndexResult {
  skillsData: SkillsScanResult | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Hook to fetch and manage the skills index.
 */
export const useSkillsIndex = ({ enabled = true }: UseSkillsIndexOptions = {}): UseSkillsIndexResult => {
  const fetcher = useCallback(async (): Promise<SkillsScanResult> => {
    const result = await window.libraryApi.scanSkills();
    if (result.success) {
      return {
        groups: result.groups,
        totalCount: result.totalCount,
      };
    }
    throw new Error(result.error ?? 'Failed to scan skills');
  }, []);

  const { data: skillsData, loading, error, refresh } = useAsyncData({
    fetcher,
    enabled,
    autoLoad: true,
    initialLoading: false,
  });

  return {
    skillsData,
    loading,
    error,
    refresh,
  };
};
